#!/usr/bin/env node
/* ============================================================================
   Matchday pipeline — step 3: POST (optional)
   Publishes each rendered-but-unposted carousel in posts/ to Instagram via
   the official Instagram Graph API (Content Publishing).
   Requirements (see README): Instagram Business/Creator account linked to a
   Facebook Page, a Meta app, and a long-lived access token. The repo must be
   PUBLIC, because Instagram fetches the images from raw.githubusercontent.com.
   Skips entirely when "autoPost" is false in watchlist.json — that's the
   "I just add the image and post" mode.
   A .posted marker is written per match so nothing is ever posted twice.
   ============================================================================ */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const CFG = JSON.parse(readFileSync("watchlist.json", "utf8"));
if (!CFG.autoPost) { console.log("autoPost is off — slides are waiting in posts/, post them yourself."); process.exit(0); }

const TOKEN = process.env.IG_ACCESS_TOKEN;
const IGID  = process.env.IG_USER_ID;
if (!TOKEN || !IGID) { console.error("✗ autoPost is on but IG_ACCESS_TOKEN / IG_USER_ID secrets are missing."); process.exit(1); }

const REPO   = process.env.GITHUB_REPOSITORY;            // owner/repo (set by Actions)
const BRANCH = process.env.GITHUB_REF_NAME || "main";
if (!REPO) { console.error("✗ GITHUB_REPOSITORY not set — run this inside GitHub Actions (or set it manually)."); process.exit(1); }
const rawBase = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const G = "https://graph.facebook.com/v21.0";
async function gp(pathname, params) {
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const r = await fetch(`${G}/${pathname}`, { method: "POST", body });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}
async function urlLive(u) {
  try { const r = await fetch(u, { method: "HEAD" }); return r.ok; } catch { return false; }
}

const dirs = existsSync("posts") ? readdirSync("posts") : [];
let posted = 0;

for (const slug of dirs) {
  const dir = path.join("posts", slug);
  if (existsSync(path.join(dir, ".posted"))) continue;
  const pngs = readdirSync(dir).filter(f => f.endsWith(".png")).sort();
  if (!pngs.length) continue;
  const caption = existsSync(path.join(dir, "caption.txt")) ? readFileSync(path.join(dir, "caption.txt"), "utf8") : "";
  const urls = pngs.map(f => `${rawBase}/posts/${slug}/${f}`);

  /* freshly pushed files can take a moment to be served by the raw CDN */
  let live = false;
  for (let t = 0; t < 10 && !live; t++) {
    live = (await Promise.all(urls.map(urlLive))).every(Boolean);
    if (!live) { console.log(`  …waiting for raw CDN (${slug})`); await new Promise(r => setTimeout(r, 20000)); }
  }
  if (!live) { console.error(`✗ ${slug}: images not reachable at ${rawBase} — is the repo public?`); continue; }

  try {
    let creationId;
    if (urls.length === 1) {
      creationId = (await gp(`${IGID}/media`, { image_url: urls[0], caption })).id;
    } else {
      const children = [];
      for (const u of urls) children.push((await gp(`${IGID}/media`, { image_url: u, is_carousel_item: "true" })).id);
      creationId = (await gp(`${IGID}/media`, { media_type: "CAROUSEL", children: children.join(","), caption })).id;
    }
    await new Promise(r => setTimeout(r, 10000)); // give the container time to be ready
    const pub = await gp(`${IGID}/media_publish`, { creation_id: creationId });
    writeFileSync(path.join(dir, ".posted"), JSON.stringify({ id: pub.id, at: new Date().toISOString() }, null, 2));
    console.log(`✓ posted ${slug} → IG media ${pub.id}`);
    posted++;
  } catch (e) {
    console.error(`✗ ${slug}: ${e.message}`);
  }
}

console.log(posted ? `Done — ${posted} post(s) published.` : "Done — nothing to publish this run.");
