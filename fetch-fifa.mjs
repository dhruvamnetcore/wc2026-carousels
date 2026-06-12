#!/usr/bin/env node
/* ============================================================================
   Matchday pipeline — step 1: FETCH (FIFA official, primary source)
   Data source: FIFA's own public data API (https://api.fifa.com/api/v3)
   Run:   node fetch-fifa.mjs
   Reads  watchlist.json   Writes matches/<date>-<a>-vs-<b>.json (+ latest.json)

   Why FIFA: it's the authoritative source — COMPLETE goals (with minute +
   scorer), correct groups + match numbers, scores, cards. This fixes the
   missing-goals / wrong-group gaps the free TheSportsDB data has.
   FIFA doesn't expose shot/possession stats or player photos here, so for the
   MOTM headshot we still look the player up on TheSportsDB (best-effort).

   World Cup competition id = 17. Finished match = MatchStatus 0 with scores.
   Idempotent: already-written matches are skipped. Node 18+ (built-in fetch).
   ============================================================================ */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";

const CFG = JSON.parse(readFileSync(new URL("./watchlist.json", import.meta.url), "utf8"));
const TZ = CFG.timezone || "UTC";
const FIFA = "https://api.fifa.com/api/v3";
const COMP = "17";                     // FIFA World Cup
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36";

/* FIFA team name -> studio dropdown name (flags + theme) */
const NAME_MAP = {
  "korea republic": "South Korea", "korea dpr": "North Korea",
  "czechia": "Czechia", "united states": "USA", "usa": "USA",
  "ir iran": "Iran", "iran": "Iran",
  "côte d'ivoire": "Ivory Coast", "cote d'ivoire": "Ivory Coast",
  "türkiye": "Türkiye", "turkiye": "Türkiye", "turkey": "Türkiye",
  "cabo verde": "Cape Verde", "bosnia and herzegovina": "Bosnia & Herzegovina",
  "china pr": "China", "republic of ireland": "Ireland",
};
const norm = s => String(s || "").toLowerCase().trim();
const ourName = n => NAME_MAP[norm(n)] || n;
const slug = s => norm(s).replace(/[^a-z0-9]+/g, "-");
const desc = a => (Array.isArray(a) && a[0] && a[0].Description) || "";
const minClean = m => String(m || "").replace(/'/g, "").trim(); // "90'+6'" -> "90+6"

async function fifa(path) {
  const r = await fetch(`${FIFA}/${path}`, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

/* ---- player names (cached) ---- */
const nameCache = {};
async function playerName(id) {
  if (!id) return "";
  if (id in nameCache) return nameCache[id];
  try { nameCache[id] = desc((await fifa(`players/${id}?language=en`)).Name) || ""; }
  catch { nameCache[id] = ""; }
  return nameCache[id];
}

/* ---- TheSportsDB: just the MOTM headshot + club/league/position (best-effort) ---- */
async function tsdbPlayer(name) {
  try {
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(name)}`);
    if (!r.ok) return null;
    const p = ((await r.json()).player || [])[0];
    if (!p) return null;
    const out = { pos: shortPos(p.strPosition), club: p.strTeam || "", number: p.strNumber || "", league: "", img: null };
    const url = p.strCutout || p.strRender || p.strThumb;
    if (url) {
      try {
        const ir = await fetch(url);
        if (ir.ok) out.img = `data:${ir.headers.get("content-type") || "image/png"};base64,` + Buffer.from(await ir.arrayBuffer()).toString("base64");
      } catch { /* no photo */ }
    }
    if (p.idTeam) { try { out.league = (await (await fetch(`https://www.thesportsdb.com/api/v1/json/3/lookupteam.php?id=${p.idTeam}`)).json()).teams?.[0]?.strLeague || ""; } catch { /* */ } }
    return out;
  } catch { return null; }
}
const shortPos = s => {
  const x = norm(s);
  if (!x) return "";
  if (x.includes("keeper")) return "GK";
  if (x.includes("back") || x.includes("defen")) return "DEF";
  if (x.includes("midfield")) return "MID";
  if (x.includes("forward") || x.includes("strik") || x.includes("wing")) return "FWD";
  return s.toUpperCase();
};

/* competition label: "World Cup · Group A · Match 2" */
function buildComp(m) {
  const parts = ["World Cup"];
  const g = desc(m.GroupName);
  if (g) parts.push(g);                                  // already "Group A"
  if (m.MatchNumber != null) parts.push(`Match ${m.MatchNumber}`);
  else if (desc(m.StageName)) parts.push(desc(m.StageName));
  return parts.join(" · ");
}

/* build the studio moments list from FIFA goals + red cards */
async function buildMoments(home, away) {
  const evs = [];
  for (const [side, t] of [["A", home], ["B", away]]) {
    for (const g of t.Goals || []) {
      const who = await playerName(g.IdPlayer);
      const assist = g.IdAssistPlayer ? await playerName(g.IdAssistPlayer) : "";
      evs.push({ min: minClean(g.Minute), team: side, type: "goal", who, what: assist ? `Assist: ${assist}` : "" });
    }
    for (const bk of t.Bookings || []) {
      if (Number(bk.Card) > 1) { // 1 = yellow, >1 = red / second-yellow
        evs.push({ min: minClean(bk.Minute), team: side, type: "red", who: await playerName(bk.IdPlayer), what: "" });
      }
    }
  }
  evs.sort((a, b) => (parseInt(a.min) || 0) - (parseInt(b.min) || 0));
  return evs.slice(0, 10);
}

async function processMatch(cal) {
  const { IdSeason, IdStage, IdMatch } = cal;
  const home0 = desc(cal.Home?.TeamName), away0 = desc(cal.Away?.TeamName);
  const ourA = ourName(home0), ourB = ourName(away0);
  const date = String(cal.Date || cal.LocalDate || "").slice(0, 10);
  const label = `${ourA} vs ${ourB} (${date})`;
  const file = `matches/${date}-${slug(ourA)}-vs-${slug(ourB)}.json`;
  if (existsSync(file)) { console.log(`• ${label}: already fetched`); return false; }

  const d = await fifa(`live/football/${COMP}/${IdSeason}/${IdStage}/${IdMatch}?language=en`);
  const home = d.HomeTeam || {}, away = d.AwayTeam || {};
  const scoreA = home.Score ?? cal.HomeTeamScore, scoreB = away.Score ?? cal.AwayTeamScore;

  const moments = await buildMoments(home, away);

  // stats: yellow-card counts (FIFA has no shots/possession here) — add the rest by hand in the studio
  const yc = [0, 0];
  [home, away].forEach((t, i) => (t.Bookings || []).forEach(bk => { if (Number(bk.Card) === 1) yc[i]++; }));
  const stats = {};
  if (yc[0] || yc[1]) stats["Yellow cards"] = yc;

  // MOTM: top scorer (now from COMPLETE goal data); headshot via TheSportsDB
  let motm = null;
  const goalCount = {};
  for (const m of moments) if (m.type === "goal") (goalCount[m.who] = goalCount[m.who] || { who: m.who, team: m.team, n: 0 }).n++;
  // top scorer; when tied, prefer the winning team's scorer
  const winner = (parseInt(scoreA) || 0) > (parseInt(scoreB) || 0) ? "A" : (parseInt(scoreB) || 0) > (parseInt(scoreA) || 0) ? "B" : null;
  const scorers = Object.values(goalCount);
  const maxN = scorers.reduce((mx, s) => Math.max(mx, s.n), 0);
  const top = scorers.filter(s => s.n === maxN).sort((a, b) => (b.team === winner) - (a.team === winner))[0];
  if (top && top.who) {
    const extra = await tsdbPlayer(top.who);
    const assists = moments.filter(m => m.what === `Assist: ${top.who}`).length;
    const chips = [["GOALS", String(top.n)]];
    if (assists) chips.push(["ASSISTS", String(assists)]);
    motm = {
      name: top.who, team: top.team, rate: "",
      pos: extra?.pos || "", club: extra?.club || "", league: extra?.league || "", number: extra?.number || "",
      chips, ...(extra?.img ? { img: extra.img } : {}),
    };
  }

  const comp = buildComp(d);
  const venue = [desc(d.Stadium?.Name), desc(d.Stadium?.CityName)].filter(Boolean).join(", ");

  const slides = ["cover", "moments"];
  if (Object.keys(stats).length) slides.push("stats");
  if (motm) slides.push("motm");

  // review flags (should rarely trigger now that goals are complete)
  const review = [];
  const total = (parseInt(scoreA) || 0) + (parseInt(scoreB) || 0);
  const tlGoals = moments.filter(m => m.type === "goal").length;
  if (tlGoals < total) review.push(`Timeline shows ${tlGoals} of ${total} goals — add the missing scorer(s) in the editor.`);
  if (!Object.keys(stats).length) review.push(`No stats from the source — add shots/corners/etc. by hand if you want the stats slide.`);

  const out = {
    teamA: ourA, teamB: ourB,
    scoreA: parseInt(scoreA), scoreB: parseInt(scoreB),
    venue, date, comp,
    ...(CFG.handle ? { handle: CFG.handle } : {}),
    slides, moments, stats,
    ...(motm ? { motm } : {}),
    ...(review.length ? { review } : {}),
    _source: "fifa",
  };
  writeFileSync(file, JSON.stringify(out, null, 2));
  writeFileSync("matches/latest.json", JSON.stringify(out, null, 2));
  console.log(`✓ ${label}: ${out.scoreA}-${out.scoreB}, ${moments.length} moment(s) [${slides.join(", ")}]`);
  if (review.length) console.log(`  ⚠ NEEDS REVIEW: ${review.join(" | ")}`);
  return true;
}

/* ---------------- main ---------------- */
mkdirSync("matches", { recursive: true });
// FIFA's calendar wants day-aligned UTC boundaries (T00:00:00Z); cover yesterday→tomorrow
const dayStart = ms => new Date(ms).toISOString().slice(0, 10) + "T00:00:00Z";
const from = dayStart(Date.now() - 24 * 3.6e6);
const to = dayStart(Date.now() + 48 * 3.6e6);
let wrote = 0;

try {
  const res = (await fifa(`calendar/matches?idCompetition=${COMP}&from=${from}&to=${to}&language=en&count=100`)).Results || [];
  for (const cal of res) {
    const finished = Number(cal.MatchStatus) === 0 && cal.HomeTeamScore != null && cal.AwayTeamScore != null;
    if (!finished) continue;
    try { if (await processMatch(cal)) wrote++; }
    catch (e) { console.error(`✗ ${desc(cal.Home?.TeamName)} vs ${desc(cal.Away?.TeamName)}: ${e.message}`); }
  }
} catch (e) { console.error(`✗ FIFA calendar: ${e.message}`); }

/* rebuild NEEDS_REVIEW.md digest */
const flagged = [];
for (const f of readdirSync("matches")) {
  if (!f.endsWith(".json") || f === "latest.json") continue;
  try { const m = JSON.parse(readFileSync(`matches/${f}`, "utf8")); if (m.review?.length) flagged.push(m); } catch { /* */ }
}
flagged.sort((a, b) => String(b.date).localeCompare(String(a.date)));
let md = `# Matches needing review\n\n_Auto-generated each run. These matches have data gaps — open them in Carousel Studio, verify, and fill anything missing before posting. Everything not listed looked complete._\n\n`;
md += flagged.length ? flagged.map(m => `### ${m.teamA} ${m.scoreA}–${m.scoreB} ${m.teamB} — ${m.date}\n${m.review.map(r => `- ${r}`).join("\n")}\n`).join("\n")
  : `✓ Nothing flagged — all fetched matches look complete.\n`;
writeFileSync("NEEDS_REVIEW.md", md);

console.log(wrote ? `Done — ${wrote} new match file(s).` : "Done — nothing new this run.");
