#!/usr/bin/env node
/* ============================================================================
   Matchday pipeline — step 1: FETCH (TheSportsDB, free source)
   Data source: TheSportsDB v1 (https://www.thesportsdb.com/api/v1/json/<key>)
   Run:   node fetch-thesportsdb.mjs           (uses the free test key "3")
          THESPORTSDB_KEY=xxxx node fetch-thesportsdb.mjs   (your own key)
   Reads  watchlist.json
   Writes matches/<date>-<teamA>-vs-<teamB>.json (+ matches/latest.json)

   What this free source CAN do:  scores, goal/red-card timeline, shot counts.
   What it CANNOT do (vs the paid API-Football source): xG, possession, corners,
   player ratings. So the stats slide shows shots only, and MOTM is the top
   scorer with no rating. Each match file declares its own "slides" so empty
   cards are never rendered (a 0-0 match drops the MOTM slide, etc.).

   Pick-up logic mirrors the API-Football fetcher:
     1. autoLeagues: ["World Cup"]  -> every finished WC fixture is fetched.
     2. matches: [{date,teamA,teamB}] -> hand-picked fixtures.
   Idempotent: already-written matches are skipped. Node 18+ (built-in fetch).
   ============================================================================ */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const KEY = process.env.THESPORTSDB_KEY || "3"; // "3" is TheSportsDB's free public test key
const API = `https://www.thesportsdb.com/api/v1/json/${KEY}`;

const CFG = JSON.parse(readFileSync(new URL("./watchlist.json", import.meta.url), "utf8"));
const TZ = CFG.timezone || "UTC";

/* TheSportsDB league ids for the competitions we support by name in autoLeagues */
const LEAGUE_IDS = { "world cup": "4429", "fifa world cup": "4429" };
/* current season string TheSportsDB uses for a one-off tournament like the WC */
const SEASON = "2026";

/* Map TheSportsDB nation names -> the studio dropdown names (flags + theme).
   Mirrors CarouselStudio.html's NAME_MAP so match files are clean. Unlisted
   names pass through unchanged (the studio also resolves them on import). */
const NAME_MAP = {
  "turkey": "Türkiye",
  "korea republic": "South Korea", "south korea": "South Korea",
  "united states": "USA", "united states of america": "USA", "usa": "USA",
  "czech republic": "Czechia", "czechia": "Czechia",
  "ivory coast": "Ivory Coast", "cote d'ivoire": "Ivory Coast", "côte d'ivoire": "Ivory Coast",
  "cape verde islands": "Cape Verde", "cabo verde": "Cape Verde", "cape verde": "Cape Verde",
  "curacao": "Curaçao",
  "republic of ireland": "Ireland",
  "bosnia and herzegovina": "Bosnia & Herzegovina", "bosnia-herzegovina": "Bosnia & Herzegovina",
  "congo dr": "DR Congo", "democratic republic of the congo": "DR Congo", "congo-kinshasa": "DR Congo",
};
const norm = s => String(s || "").toLowerCase().trim();
const ourName = n => NAME_MAP[norm(n)] || n;
const slug = s => norm(s).replace(/[^a-z0-9]+/g, "-");
const FINISHED = new Set(["ft", "aet", "pen", "match finished", "after extra time", "penalties"]);

async function tsdb(path) {
  const r = await fetch(`${API}/${path}`);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

/* A fixture is "finished" if it has both scores AND either a finished status or
   it kicked off long enough ago that it cannot still be in play (guards against
   stale "2H"-type statuses in the data). */
function isFinished(e) {
  const hs = e.intHomeScore, as = e.intAwayScore;
  if (hs == null || as == null || hs === "" || as === "") return false;
  if (FINISHED.has(norm(e.strStatus))) return true;
  const ts = Date.parse(e.strTimestamp || e.dateEvent);
  if (!isNaN(ts) && (Date.now() - ts) / 3.6e6 > 3.5) return true; // >3.5h after kickoff
  return false;
}

/* timeline -> studio "moments" (goals incl. pen/own goal, red cards; max 10) */
function buildMoments(timeline) {
  let evs = [];
  for (const t of timeline || []) {
    const side = norm(t.strHome) === "yes" ? "A" : "B";
    const min = String(t.intTime ?? "").trim();
    const detail = norm(t.strTimelineDetail);
    if (norm(t.strTimeline) === "goal") {
      evs.push({
        min, team: side,
        type: detail.includes("penalty") ? "pen" : "goal",
        who: t.strPlayer || "",
        what: detail.includes("own") ? "Own goal" : (t.strAssist ? `Assist: ${t.strAssist}` : ""),
      });
    } else if (norm(t.strTimeline) === "card" && detail.includes("red")) {
      evs.push({ min, team: side, type: "red", who: t.strPlayer || "", what: t.strComment || "" });
    }
  }
  evs.sort((a, b) => (parseInt(a.min) || 0) - (parseInt(b.min) || 0));
  if (evs.length > 10) {
    const goals = evs.filter(e => e.type !== "red").slice(0, 10);
    const reds = evs.filter(e => e.type === "red");
    evs = goals;
    for (const r of reds) if (evs.length < 10) evs.push(r);
    evs.sort((a, b) => (parseInt(a.min) || 0) - (parseInt(b.min) || 0));
  }
  return evs;
}

/* eventstats -> studio "stats". Only the keys TheSportsDB actually provides;
   the studio renders exactly these (no fake possession/xG/corners). */
const STAT_MAP = { "total shots": "Shots", "shots on goal": "On target" };
function buildStats(eventstats) {
  const out = {};
  for (const s of eventstats || []) {
    const k = STAT_MAP[norm(s.strStat)];
    if (!k) continue;
    out[k] = [parseFloat(s.intHome) || 0, parseFloat(s.intAway) || 0];
  }
  return out;
}

/* top scorer from the timeline -> studio "motm" (no rating on this source) */
function buildMotm(moments) {
  const goals = (moments || []).filter(m => m.type === "goal" || m.type === "pen");
  if (!goals.length) return null;
  const tally = {};
  for (const g of goals) {
    if (!g.who) continue;
    (tally[g.who] = tally[g.who] || { who: g.who, team: g.team, n: 0 }).n++;
  }
  const top = Object.values(tally).sort((a, b) => b.n - a.n)[0];
  if (!top) return null;
  return {
    name: top.who, pos: "", rate: "", team: top.team,
    chips: [["GOALS", String(top.n)]],
  };
}

async function processEvent(e) {
  const ourA = ourName(e.strHomeTeam), ourB = ourName(e.strAwayTeam);
  const date = e.dateEvent;
  const label = `${ourA} vs ${ourB} (${date})`;
  const file = `matches/${date}-${slug(ourA)}-vs-${slug(ourB)}.json`;
  if (existsSync(file)) { console.log(`• ${label}: already fetched`); return false; }

  const [tl, st] = await Promise.all([
    tsdb(`lookuptimeline.php?id=${e.idEvent}`).then(d => d.timeline).catch(() => []),
    tsdb(`lookupeventstats.php?id=${e.idEvent}`).then(d => d.eventstats).catch(() => []),
  ]);

  const moments = buildMoments(tl);
  const stats = buildStats(st);
  const motm = buildMotm(moments);

  // per-match slide list so empty cards are never rendered
  const slides = ["cover", "moments"];
  if (Object.keys(stats).length) slides.push("stats");
  if (motm) slides.push("motm");

  const comp = String(e.strLeague || "World Cup").replace(/^FIFA\s+/i, "");
  const venue = [e.strVenue, e.strCity].filter(Boolean).join(", ");

  const out = {
    teamA: ourA, teamB: ourB,
    scoreA: parseInt(e.intHomeScore), scoreB: parseInt(e.intAwayScore),
    venue, date, comp,
    slides,
    moments, stats,
    ...(motm ? { motm } : {}),
    _source: "thesportsdb",
  };

  writeFileSync(file, JSON.stringify(out, null, 2));
  writeFileSync("matches/latest.json", JSON.stringify(out, null, 2));
  console.log(`✓ ${label}: saved ${file} (+ latest.json) [slides: ${slides.join(", ")}]`);
  return true;
}

/* ---------------- main ---------------- */
const dayInTZ = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const today = dayInTZ(Date.now());
const yesterday = dayInTZ(Date.now() - 864e5);
mkdirSync("matches", { recursive: true });
let wrote = 0;

/* Pull the season fixture list for each autoLeague once, filter to finished. */
const seasonCache = {};
async function seasonEvents(leagueId) {
  if (!seasonCache[leagueId])
    seasonCache[leagueId] = (await tsdb(`eventsseason.php?id=${leagueId}&s=${SEASON}`)).events || [];
  return seasonCache[leagueId];
}

/* 1) explicitly watched fixtures (by team names + date) */
for (const m of CFG.matches || []) {
  const label = `${m.teamA} vs ${m.teamB} (${m.date})`;
  if (m.date > today) { console.log(`• ${label}: not played yet`); continue; }
  try {
    // search every supported league's season for a matching fixture on that date
    let found = null;
    for (const lid of new Set(Object.values(LEAGUE_IDS))) {
      const evs = await seasonEvents(lid);
      found = evs.find(e =>
        e.dateEvent === m.date &&
        ((norm(ourName(e.strHomeTeam)) === norm(m.teamA) && norm(ourName(e.strAwayTeam)) === norm(m.teamB)) ||
         (norm(ourName(e.strHomeTeam)) === norm(m.teamB) && norm(ourName(e.strAwayTeam)) === norm(m.teamA))));
      if (found) break;
    }
    if (!found) { console.log(`• ${label}: fixture not found — check team names and date`); continue; }
    if (!isFinished(found)) { console.log(`• ${label}: not finished yet (${found.strStatus})`); continue; }
    if (await processEvent(found)) wrote++;
  } catch (err) { console.error(`✗ ${label}: ${err.message}`); }
}

/* 2) auto leagues — every finished fixture of these competitions, today + yesterday */
for (const lg of CFG.autoLeagues || []) {
  const lid = LEAGUE_IDS[norm(lg)];
  if (!lid) { console.error(`✗ autoLeagues "${lg}": no TheSportsDB league id mapped — skipping`); continue; }
  try {
    const evs = await seasonEvents(lid);
    for (const e of evs) {
      if (![yesterday, today].includes(e.dateEvent)) continue;
      if (!isFinished(e)) continue;
      try { if (await processEvent(e)) wrote++; }
      catch (err) { console.error(`✗ ${e.strEvent} (${e.dateEvent}): ${err.message}`); }
    }
  } catch (err) { console.error(`✗ autoLeagues "${lg}": ${err.message}`); }
}

console.log(wrote ? `Done — ${wrote} new match file(s).` : "Done — nothing new this run.");
