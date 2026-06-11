#!/usr/bin/env node
/* ============================================================================
   Matchday pipeline — step 1: FETCH
   Data source: API-Football (api-sports.io / dashboard.api-football.com)
   Run:   API_FOOTBALL_KEY=xxxx node fetch-match.mjs
   Reads  watchlist.json
   Writes matches/<date>-<teamA>-vs-<teamB>.json (+ matches/latest.json)
   Two ways a match gets picked up:
     1. Explicitly listed in watchlist.json "matches"
     2. Via "autoLeagues" (e.g. ["World Cup"]) — EVERY finished fixture of that
        competition from today/yesterday is fetched automatically. True
        zero-touch for the tournament.
   Idempotent: already-written matches are skipped on later runs.
   Requires Node 18+ (built-in fetch). No npm dependencies.
   ============================================================================ */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) { console.error("✗ Set the API_FOOTBALL_KEY environment variable."); process.exit(1); }

const CFG = JSON.parse(readFileSync(new URL("./watchlist.json", import.meta.url), "utf8"));
const TZ  = CFG.timezone || "UTC";
const API = "https://v3.football.api-sports.io";
const FT  = new Set(["FT", "AET", "PEN"]); // finished statuses

/* Studio dropdown name -> extra names API-Football may use for the same team */
const ALIASES = {
  "Türkiye":     ["Turkey"],
  "South Korea": ["Korea Republic"],
  "USA":         ["United States", "United States of America"],
  "Czechia":     ["Czech Republic"],
  "Ivory Coast": ["Cote D'Ivoire", "Côte d'Ivoire"],
  "Cape Verde":  ["Cape Verde Islands", "Cabo Verde"],
  "Curaçao":     ["Curacao"],
  "Ireland":     ["Republic of Ireland"],
  "Bosnia & Herzegovina": ["Bosnia and Herzegovina", "Bosnia-Herzegovina"],
  "DR Congo":    ["Congo DR", "Democratic Republic of the Congo", "Congo-Kinshasa"],
};
const norm     = s => String(s || "").toLowerCase().trim();
const namesFor = n => [n, ...(ALIASES[n] || [])].map(norm);
const isTeam   = (apiName, ourName) => namesFor(ourName).includes(norm(apiName));
const slug     = s => norm(s).replace(/[^a-z0-9]+/g, "-");
const posName  = p => ({ G: "GK", D: "DEF", M: "MID", F: "FWD" }[p] || p || "");
/* API team name -> our studio dropdown name (identity if no alias applies) */
function ourName(apiName) {
  const a = norm(apiName);
  for (const [ours, alts] of Object.entries(ALIASES))
    if ([ours, ...alts].some(x => norm(x) === a)) return ours;
  return apiName;
}

async function api(path, params) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { "x-apisports-key": KEY } });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) throw new Error(`${path} → ${JSON.stringify(j.errors)}`);
  return j.response;
}

/* One fixtures-by-date call per unique date, shared across everything */
const fixturesCache = {};
async function fixturesOn(date) {
  if (!fixturesCache[date]) fixturesCache[date] = await api("/fixtures", { date, timezone: TZ });
  return fixturesCache[date];
}

/* events → studio "moments" (goals ⚽, penalties, red cards; capped at 10) */
function buildMoments(events, homeName, aIsHome) {
  const side = teamName => ((norm(teamName) === norm(homeName)) === aIsHome) ? "A" : "B";
  const minOf = t => String(t.elapsed) + (t.extra ? `+${t.extra}` : "");
  let evs = [];
  for (const e of events) {
    const det = e.detail || "";
    if (e.type === "Goal" && det !== "Missed Penalty") {
      evs.push({
        min: minOf(e.time),
        team: side(e.team?.name),
        type: det === "Penalty" ? "pen" : "goal",
        who: e.player?.name || "",
        what: det === "Own Goal" ? "Own goal" : (e.assist?.name ? `Assist: ${e.assist.name}` : ""),
      });
    } else if (e.type === "Card" && det === "Red Card") {
      evs.push({ min: minOf(e.time), team: side(e.team?.name), type: "red", who: e.player?.name || "", what: e.comments || "" });
    }
  }
  if (evs.length > 10) {
    const goals = evs.filter(e => e.type !== "red").slice(0, 10);
    const reds  = evs.filter(e => e.type === "red");
    evs = goals;
    for (const r of reds) if (evs.length < 10) evs.push(r);
    evs.sort((a, b) => parseInt(a.min) - parseInt(b.min));
    console.log("  ! more than 10 timeline events — kept goals first, trimmed to 10 (edit in the studio if needed)");
  }
  return evs;
}

/* statistics → studio "stats" (keys must match the studio's editor) */
const STAT_MAP = {
  "Ball Possession": "Possession",
  "Total Shots":     "Shots",
  "Shots on Goal":   "On target",
  "Corner Kicks":    "Corners",
  "expected_goals":  "xG",
};
function buildStats(statsResp, homeName, aIsHome) {
  const out = { Possession: [0, 0], Shots: [0, 0], "On target": [0, 0], xG: [0, 0], Corners: [0, 0] };
  for (const entry of statsResp) {
    const idx = ((norm(entry.team?.name) === norm(homeName)) === aIsHome) ? 0 : 1;
    for (const st of entry.statistics || []) {
      const k = STAT_MAP[st.type];
      if (!k) continue;
      out[k][idx] = parseFloat(String(st.value ?? "0").replace("%", "")) || 0;
    }
  }
  return out;
}

/* players → studio "motm": highest match rating; falls back to top scorer
   when ratings are missing (common for some friendlies). */
function buildMotm(playersResp, homeName, aIsHome) {
  let best = null;
  for (const entry of playersResp) {
    const team = ((norm(entry.team?.name) === norm(homeName)) === aIsHome) ? "A" : "B";
    for (const p of entry.players || []) {
      const st = p.statistics?.[0] || {};
      const rating = parseFloat(st.games?.rating) || 0;
      const score = rating || (st.goals?.total || 0); // scorer fallback
      if (!best || score > best.score) best = { score, team, p, st, rating };
    }
  }
  if (!best) return null;
  const st = best.st;
  if (!best.rating) console.log("  ! no player ratings for this fixture — picked top scorer; set the rating yourself");
  return {
    name: best.p.player?.name || "",
    pos: posName(st.games?.position),
    rate: best.rating ? best.rating.toFixed(1) : "",
    team: best.team,
    chips: [
      ["GOALS",      String(st.goals?.total   || 0)],
      ["ASSISTS",    String(st.goals?.assists || 0)],
      ["KEY PASSES", String(st.passes?.key    || 0)],
    ],
  };
}

/* Fetch details for one finished fixture and write the studio JSON */
async function processFixture(fx, ourA, ourB, date) {
  const label = `${ourA} vs ${ourB} (${date})`;
  const file = `matches/${date}-${slug(ourA)}-vs-${slug(ourB)}.json`;
  if (existsSync(file)) { console.log(`• ${label}: already fetched`); return false; }
  const aIsHome  = isTeam(fx.teams.home.name, ourA) || norm(fx.teams.home.name) === norm(ourA);
  const homeName = fx.teams.home.name;
  const id       = fx.fixture.id;

  const [events, stats, players] = await Promise.all([
    api("/fixtures/events",     { fixture: id }),
    api("/fixtures/statistics", { fixture: id }),
    api("/fixtures/players",    { fixture: id }),
  ]);

  const motm = buildMotm(players, homeName, aIsHome);
  // auto-label: "World Cup · Group Stage - 1" etc.
  let comp = [fx.league?.name, fx.league?.round].filter(Boolean).join(" · ") || "International Friendly";
  // knockout rounds: surface the shootout result, since goals alone would show a draw
  const pen = fx.score?.penalty;
  if (pen && pen.home != null && pen.away != null) {
    comp += ` · ${aIsHome ? pen.home : pen.away}–${aIsHome ? pen.away : pen.home} PENS`;
  }

  const out = {
    teamA: ourA,
    teamB: ourB,
    scoreA: aIsHome ? fx.goals.home : fx.goals.away,
    scoreB: aIsHome ? fx.goals.away : fx.goals.home,
    venue: [fx.fixture.venue?.name, fx.fixture.venue?.city].filter(Boolean).join(", "),
    date,
    comp,
    moments: buildMoments(events, homeName, aIsHome),
    stats: buildStats(stats, homeName, aIsHome),
    ...(motm ? { motm } : {}),
  };

  writeFileSync(file, JSON.stringify(out, null, 2));
  writeFileSync("matches/latest.json", JSON.stringify(out, null, 2)); // for the studio's one-tap "Load latest match"
  console.log(`✓ ${label}: saved ${file} (+ latest.json)`);
  return true;
}

/* ---------------- main ---------------- */
const dayInTZ = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
const today = dayInTZ(Date.now());
const yesterday = dayInTZ(Date.now() - 864e5);
mkdirSync("matches", { recursive: true });
let wrote = 0;

/* 1) explicitly watched fixtures */
for (const m of CFG.matches || []) {
  const label = `${m.teamA} vs ${m.teamB} (${m.date})`;
  if (m.date > today) { console.log(`• ${label}: not played yet`); continue; }
  try {
    const fixtures = await fixturesOn(m.date);
    const fx = fixtures.find(f =>
      (isTeam(f.teams.home.name, m.teamA) && isTeam(f.teams.away.name, m.teamB)) ||
      (isTeam(f.teams.home.name, m.teamB) && isTeam(f.teams.away.name, m.teamA)));
    if (!fx) { console.log(`• ${label}: fixture not found on that date — check team names and the date in your timezone`); continue; }
    if (!FT.has(fx.fixture.status.short)) { console.log(`• ${label}: not finished yet (${fx.fixture.status.long})`); continue; }
    if (await processFixture(fx, m.teamA, m.teamB, m.date)) wrote++;
  } catch (e) { console.error(`✗ ${label}: ${e.message}`); }
}

/* 2) auto leagues — every finished fixture of these competitions, today + yesterday */
for (const lg of CFG.autoLeagues || []) {
  for (const d of [yesterday, today]) {
    try {
      const fixtures = await fixturesOn(d);
      for (const fx of fixtures) {
        if (norm(fx.league?.name) !== norm(lg)) continue;
        if (!FT.has(fx.fixture.status.short)) continue;
        const ourA = ourName(fx.teams.home.name);
        const ourB = ourName(fx.teams.away.name);
        try { if (await processFixture(fx, ourA, ourB, d)) wrote++; }
        catch (e) { console.error(`✗ ${ourA} vs ${ourB} (${d}): ${e.message}`); }
      }
    } catch (e) { console.error(`✗ autoLeagues "${lg}" (${d}): ${e.message}`); }
  }
}

console.log(wrote ? `Done — ${wrote} new match file(s).` : "Done — nothing new this run.");
