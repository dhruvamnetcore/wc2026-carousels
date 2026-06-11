#!/usr/bin/env node
/* ============================================================================
   Matchday pipeline — step 2: RENDER
   Opens CarouselStudio.html headlessly (Puppeteer), imports each new match
   JSON exactly like the in-browser button would, waits for fonts + flags,
   and screenshots every slide at exactly 1080×1350.
   Writes posts/<match-slug>/01.png … + caption.txt
   Optional MOTM photo: drop an image in photos/<player-name-slug>.png|jpg
   (e.g. photos/lionel-messi.jpg) and it is baked into the card automatically.
   Idempotent: matches that already have a posts/ folder are skipped — delete
   the folder to re-render (e.g. after adding a player photo).
   ============================================================================ */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const CFG = JSON.parse(readFileSync("watchlist.json", "utf8"));
const SLIDES = CFG.slides || ["cover", "moments", "stats", "motm"];
const pslug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-");

const matchFiles = existsSync("matches")
  ? readdirSync("matches").filter(f => f.endsWith(".json") && f !== "latest.json")
  : [];
const todo = matchFiles.filter(f => !existsSync(path.join("posts", f.replace(/\.json$/, ""))));
if (!todo.length) { console.log("Nothing new to render."); process.exit(0); }

const puppeteer = (await import("puppeteer")).default;
const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1500, deviceScaleFactor: 1 });
await page.goto("file://" + path.resolve("CarouselStudio.html"), { waitUntil: "networkidle0", timeout: 60000 });

for (const f of todo) {
  const slug = f.replace(/\.json$/, "");
  const data = JSON.parse(readFileSync(path.join("matches", f), "utf8"));
  // a match file may declare its own slide list (e.g. the free source drops the
  // MOTM slide on a 0-0); otherwise fall back to the global watchlist setting
  const slidesForMatch = Array.isArray(data.slides) && data.slides.length ? data.slides : SLIDES;
  const outDir = path.join("posts", slug);
  mkdirSync(outDir, { recursive: true });

  /* MOTM photo: a local photos/<name>.png you have rights to overrides the
     auto one (and stays untinted); otherwise the auto photo embedded in the
     match file (data.motm.img) is used and themed. */
  let localImg = null;
  if (data.motm?.name) {
    const ps = pslug(data.motm.name);
    for (const ext of ["png", "jpg", "jpeg"]) {
      const p = path.join("photos", `${ps}.${ext}`);
      if (existsSync(p)) {
        localImg = `data:image/${ext === "png" ? "png" : "jpeg"};base64,` + readFileSync(p).toString("base64");
        console.log(`  using player photo photos/${ps}.${ext}`);
        break;
      }
    }
  }
  const useTint = !!(data.motm && data.motm.img) && !localImg;

  /* import the match into the live studio page */
  await page.evaluate((d, slides, handle, tint, localImg) => {
    S.order = slides.slice();
    S.enabled = { cover: false, moments: false, stats: false, motm: false };
    slides.forEach(k => { S.enabled[k] = true; });
    applyMatchJSON(d);
    if (handle) S.handle = handle;
    S.motmTint = !!tint;
    if (localImg) S.motm.img = localImg;
    drawOutput();
  }, data, slidesForMatch, CFG.handle || "", useTint, localImg);

  /* wait for display fonts and embedded flags */
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const codes = [team(S.teamA).f, team(S.teamB).f].filter(Boolean);
    return codes.every(c => (typeof FLAG_CACHE[c] === "string" && FLAG_CACHE[c].indexOf("data:") === 0) || FLAG_CACHE[c] === null);
  }, { timeout: 20000 }).catch(() => console.log("  ! flags didn't embed in time — rendering anyway"));
  await new Promise(r => setTimeout(r, 500)); // settle

  /* clone slides onto a clean full-size stage and screenshot each */
  const n = await page.evaluate(() => {
    document.getElementById("stage")?.remove();
    const stage = document.createElement("div");
    stage.id = "stage";
    stage.style.cssText = "position:absolute;top:0;left:0;z-index:99999;";
    [...document.querySelectorAll(".track .art")].forEach(a => {
      const c = a.cloneNode(true);
      c.style.transform = "none";
      const w = document.createElement("div");
      w.style.cssText = "width:1080px;height:1350px;overflow:hidden;";
      w.appendChild(c);
      stage.appendChild(w);
    });
    document.querySelector(".wrap").style.visibility = "hidden";
    document.body.prepend(stage);
    return stage.children.length;
  });
  for (let i = 0; i < n; i++) {
    const el = await page.$(`#stage > div:nth-child(${i + 1})`);
    await el.screenshot({ path: path.join(outDir, String(i + 1).padStart(2, "0") + ".png") });
  }
  await page.evaluate(() => {
    document.getElementById("stage")?.remove();
    document.querySelector(".wrap").style.visibility = "visible";
  });

  /* caption from the template in watchlist.json */
  const cap = String(CFG.captionTemplate || "FT: {teamA} {scoreA}-{scoreB} {teamB}\n{comp}\n{venue}\n\n{hashtags}")
    .replaceAll("{teamA}", String(data.teamA ?? ""))
    .replaceAll("{teamB}", String(data.teamB ?? ""))
    .replaceAll("{scoreA}", String(data.scoreA ?? ""))
    .replaceAll("{scoreB}", String(data.scoreB ?? ""))
    .replaceAll("{comp}", String(data.comp ?? ""))
    .replaceAll("{venue}", String(data.venue ?? ""))
    .replaceAll("{motm}", String(data.motm?.name ?? ""))
    .replaceAll("{hashtags}", (CFG.hashtags || []).join(" "));
  writeFileSync(path.join(outDir, "caption.txt"), cap);

  console.log(`✓ rendered ${slug} (${n} slide${n === 1 ? "" : "s"})`);
}

await browser.close();
