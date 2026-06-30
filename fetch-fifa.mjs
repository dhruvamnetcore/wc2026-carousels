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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";

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

/* download an image and inline it as a data: URI (self-contained for studio + render) */
async function toDataUri(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "image/png";
    return `data:${ct};base64,` + Buffer.from(await r.arrayBuffer()).toString("base64");
  } catch { return null; }
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

/* ---- TheSportsDB: match stats (FIFA has none here) — shot breakdown ---- */
const TSDB = "https://www.thesportsdb.com/api/v1/json/3";
const canon = s => { const x = norm(s); if (x.includes("czech")) return "czechia"; if (x.includes("korea republic") || x === "south korea") return "south korea"; return x; };
let tsdbSeason = null;
async function tsdbWcEvents() {
  if (!tsdbSeason) { try { tsdbSeason = (await (await fetch(`${TSDB}/eventsseason.php?id=4429&s=2026`)).json()).events || []; } catch { tsdbSeason = []; } }
  return tsdbSeason;
}
/* Map TheSportsDB stat names → our decided, consistent labels.
   The studio's stats slide prefers this fixed set; anything else is dropped
   so every match shows the same rows in the same order. */
const STAT_MAP = {
  "ball possession": "Possession", "possession": "Possession", "possession %": "Possession",
  "shots on goal": "Shots on target", "shots on target": "Shots on target",
  "total shots": "Shots", "shots off goal": "Off target", "blocked shots": "Blocked", "shots insidebox": "Shots in box",
  "passes": "Passes completed", "passes accurate": "Passes completed", "successful passes": "Passes completed", "accurate passes": "Passes completed", "total passes": "Passes completed",
  "offsides": "Offsides", "offside": "Offsides",
  "corner kicks": "Corners", "corners": "Corners", "fouls": "Fouls",
  "goalkeeper saves": "Saves", "saves": "Saves",
};
/* The exact stats the studio's slide expects, in display order. */
const STAT_ORDER = ["Goals", "Shots on target", "Possession", "Passes completed", "Offsides"];
async function tsdbStats(ourA, ourB, date) {
  try {
    const want = new Set([canon(ourA), canon(ourB)]);
    const ev = (await tsdbWcEvents()).find(e =>
      e.dateEvent === date && [canon(e.strHomeTeam), canon(e.strAwayTeam)].every(t => want.has(t)));
    if (!ev) return {};
    const homeIsA = canon(ev.strHomeTeam) === canon(ourA);
    const rows = (await (await fetch(`${TSDB}/lookupeventstats.php?id=${ev.idEvent}`)).json()).eventstats || [];
    const out = {};
    for (const st of rows) {
      const k = STAT_MAP[norm(st.strStat)];
      if (!k) continue;
      const h = parseFloat(st.intHome) || 0, a = parseFloat(st.intAway) || 0;
      out[k] = homeIsA ? [h, a] : [a, h];   // orient to studio A(home)/B(away)
    }
    return out;
  } catch { return {}; }
}

/* ---- Optional richer sources (server-side in Actions, so CORS is irrelevant).
   Both activate ONLY if their free key is set as a GitHub Actions secret / env
   var; with no keys, the fetcher behaves exactly as before (TheSportsDB + manual).
     APIFOOTBALL_KEY  → api-sports.io  (reliable events/cards; partial WC stats)
     HIGHLIGHTLY_KEY  → highlightly.net (possession/passes/cards/shots)        ---- */
const AF_KEY = process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY || "";
const HL_KEY = process.env.HIGHLIGHTLY_KEY || process.env.HIGHLIGHTLY_API_KEY || "";
const BDL_KEY = process.env.BALLDONTLIE_KEY || "";   // BALLDONTLIE FIFA WC API (GOAT tier) — official MOTM + per-player + team stats

/* ---- BALLDONTLIE FIFA World Cup API ---------------------------------------
   The only source we found with consistent per-match player AND team stats for
   every fixture, plus an official Man-of-the-Match endpoint. Key-gated: with no
   key the whole module is a no-op and we fall back to the free chain. ---------*/
const BDL = "https://api.balldontlie.io/fifa/worldcup/v1";
async function bdlGet(path) {
  if (!BDL_KEY) return null;
  try {
    const r = await fetch(`${BDL}${path}`, { headers: { Authorization: BDL_KEY } });
    if (!r.ok) { console.log(`  ⚠ BALLDONTLIE ${path} -> HTTP ${r.status}`); return null; }
    return await r.json();
  } catch (e) { console.log(`  ⚠ BALLDONTLIE ${path} -> ERR ${e.message}`); return null; }
}
let _bdlTeams = null;            // cached name→id map (the /teams endpoint is free tier)
async function bdlTeamId(name) {
  if (!_bdlTeams) {
    _bdlTeams = {};
    const j = await bdlGet(`/teams?seasons[]=2026`);
    for (const t of j?.data || []) _bdlTeams[canon(t.name)] = t.id;
  }
  const c = canon(name);
  if (_bdlTeams[c] != null) return _bdlTeams[c];
  for (const [k, id] of Object.entries(_bdlTeams)) if (teamsMatch(k, name)) return id;  // alias-aware
  return null;
}
// top-3 chips from a BALLDONTLIE player_match_stats row (position-aware)
function bdlChips(st, isGK, cleanSheet) {
  const chips = [];
  if (isGK) {
    if (st.saves) chips.push(["SAVES", String(st.saves)]);
    if (cleanSheet) chips.push(["CLEAN SHEET", "✓"]);
    if (st.passes_total && st.passes_accurate) chips.push(["PASS %", Math.round(st.passes_accurate / st.passes_total * 100) + "%"]);
  } else {
    if (st.goals) chips.push(["GOALS", String(st.goals)]);
    if (st.assists) chips.push(["ASSISTS", String(st.assists)]);
    const pool = [
      st.shots_on_target && ["SHOTS ON", String(st.shots_on_target)],
      st.key_passes && ["KEY PASSES", String(st.key_passes)],
      st.dribbles_completed && ["DRIBBLES", String(st.dribbles_completed)],
      st.tackles && ["TACKLES", String(st.tackles)],
      st.duels_won && ["DUELS WON", String(st.duels_won)],
      st.passes_total && ["PASSES", String(st.passes_total)],
    ].filter(Boolean);
    for (const c of pool) { if (chips.length >= 3) break; chips.push(c); }
  }
  return chips.slice(0, 3);
}
/* One call per match: resolve the BDL match, then pull team stats, per-player
   stats, official best players, and a player-id→name map. Everything defensive. */
async function bdlMatchData(ourA, ourB, scoreA, scoreB) {
  const out = { found: false, stats: {}, players: [], best: [], names: {} };
  if (!BDL_KEY) return out;
  const idA = await bdlTeamId(ourA);
  if (idA == null) return out;
  const mj = await bdlGet(`/matches?team_ids[]=${idA}&seasons[]=2026&per_page=100`);
  const match = (mj?.data || []).find(m =>
    (m.home_team && teamsMatch(m.home_team.name, ourB)) || (m.away_team && teamsMatch(m.away_team.name, ourB)));
  if (!match) return out;
  out.found = true;
  const mid = match.id;
  const [ts, ps, bp, lu] = await Promise.all([
    bdlGet(`/team_match_stats?match_ids[]=${mid}`),
    bdlGet(`/player_match_stats?match_ids[]=${mid}&per_page=100`),
    bdlGet(`/match_best_players?match_ids[]=${mid}`),
    bdlGet(`/match_lineups?match_ids[]=${mid}&per_page=100`),
  ]);
  // team stats → our decided labels (home row = our A, away row = our B)
  const rows = ts?.data || [];
  const H = rows.find(r => r.is_home), A = rows.find(r => !r.is_home);
  if (H && A) {
    const pair = (h, a) => [Number(h) || 0, Number(a) || 0];
    out.stats["Possession"] = pair(H.possession_pct, A.possession_pct);
    out.stats["Shots on target"] = pair(H.shots_on_target, A.shots_on_target);
    out.stats["Passes completed"] = pair(H.passes_accurate, A.passes_accurate);
    out.stats["Offsides"] = pair(H.offsides, A.offsides);
  }
  out.players = ps?.data || [];
  out.best = bp?.data || [];
  for (const l of lu?.data || []) if (l.player?.id) out.names[l.player.id] = l.player.name;
  for (const p of out.players) if (p.player_id && !out.names[p.player_id]) out.names[p.player_id] = "";
  return out;
}

// map provider stat names → our decided labels
function mapStatName(name) {
  const n = norm(name);
  if (n.includes("ball possession") || n === "possession") return "Possession";
  if (n.includes("shots on goal") || n.includes("shots on target")) return "Shots on target";
  if (n.includes("passes") && (n.includes("accurate") || n.includes("completed") || n.includes("successful"))) return "Passes completed";
  if (n === "total passes" || n === "passes") return "Passes completed";
  if (n.includes("offside")) return "Offsides";
  return null;
}

// provider name aliases → so "South Korea" matches "Korea Republic", etc.
const NAME_ALIASES = {
  "south korea": ["korea republic", "korea", "south korea"],
  "north korea": ["korea dpr", "korea democratic"],
  "czechia": ["czech republic", "czechia"],
  "turkiye": ["turkey", "turkiye", "türkiye"],
  "ivory coast": ["cote d ivoire", "côte d ivoire", "ivory coast"],
  "usa": ["united states", "usa", "united states of america"],
  "iran": ["iran", "ir iran", "iran islamic republic"],
  "bosnia herzegovina": ["bosnia and herzegovina", "bosnia herzegovina"],
  "cape verde": ["cabo verde", "cape verde"],
  "dr congo": ["congo dr", "dr congo", "congo democratic republic"],
};
const stripAccents = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function nameVariants(n) {
  const c = canon(n);
  const out = new Set([c, stripAccents(c)]);
  for (const [k, list] of Object.entries(NAME_ALIASES)) {
    if (c === k || stripAccents(c) === stripAccents(k) || list.some(x => stripAccents(canon(x)) === stripAccents(c))) {
      out.add(k); list.forEach(x => { out.add(canon(x)); out.add(stripAccents(canon(x))); });
    }
  }
  return [...out].filter(Boolean);
}
function teamsMatch(providerName, ourName) {
  const p = stripAccents(canon(providerName)), vs = nameVariants(ourName);
  return vs.some(v => { const sv = stripAccents(v); return p === sv || p.includes(sv) || sv.includes(p); });
}

async function apiFootballStats(ourA, ourB, date) {
  if (!AF_KEY) return { stats: {}, events: [] };
  try {
    const H = { "x-apisports-key": AF_KEY };
    // Filter to the World Cup (league=1) for 2026 on the given date → tiny, exact set
    // (scanning all of /fixtures?date= returns hundreds of games and misses the match).
    let resp = [];
    for (const url of [
      `https://v3.football.api-sports.io/fixtures?league=1&season=2026&date=${date}`,
      `https://v3.football.api-sports.io/fixtures?date=${date}`, // fallback if league id differs
    ]) {
      const r = await (await fetch(url, { headers: H })).json();
      resp = r.response || [];
      if (resp.length) {
        const hit = resp.find(f => teamsMatch(f.teams?.home?.name, ourA) && teamsMatch(f.teams?.away?.name, ourB)
          || teamsMatch(f.teams?.home?.name, ourB) && teamsMatch(f.teams?.away?.name, ourA));
        if (hit) { resp = [hit]; break; }
        resp = [];
      }
    }
    const fx = resp[0];
    if (!fx) return { stats: {}, events: [] };
    const homeIsA = teamsMatch(fx.teams.home.name, ourA);
    const id = fx.fixture.id;
    const out = {};
    try {
      const sr = await (await fetch(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${id}`, { headers: H })).json();
      const arr = sr.response || [];
      if (arr.length === 2) {
        const homeStats = arr[0].statistics || [], awayStats = arr[1].statistics || [];
        for (let i = 0; i < homeStats.length; i++) {
          const k = mapStatName(homeStats[i].type);
          if (!k) continue;
          const hv = parseFloat(String(homeStats[i].value).replace("%", "")) || 0;
          const av = parseFloat(String((awayStats[i] || {}).value).replace("%", "")) || 0;
          out[k] = homeIsA ? [hv, av] : [av, hv];
        }
      }
    } catch { /* stats may be uncovered for WC on free tier */ }
    const events = [];
    try {
      const er = await (await fetch(`https://v3.football.api-sports.io/fixtures/events?fixture=${id}`, { headers: H })).json();
      for (const ev of er.response || []) {
        const isHome = canon(ev.team?.name) === canon(fx.teams.home.name);
        const side = (isHome === homeIsA) ? "A" : "B";
        const min = String(ev.time?.elapsed ?? "") + (ev.time?.extra ? "+" + ev.time.extra : "");
        if (ev.type === "Goal") events.push({ min, team: side, type: /own/i.test(ev.detail || "") ? "og" : (/pen/i.test(ev.detail || "") ? "pen" : "goal"), who: ev.player?.name || "", what: ev.assist?.name ? `Assist: ${ev.assist.name}` : "" });
        else if (ev.type === "Card") events.push({ min, team: side, type: /red/i.test(ev.detail || "") ? "red" : "yellow", who: ev.player?.name || "", what: "" });
      }
    } catch { /* */ }
    return { stats: out, events, fixtureId: id, homeIsA };
  } catch { return { stats: {}, events: [] }; }
}

/* ---- API-Football per-player stats for the MOTM (rating + top stats) ---- */
function playerNameMatch(a, b) {
  const na = stripAccents(norm(a)), nb = stripAccents(norm(b));
  if (!na || !nb) return false;
  if (na === nb) return true;
  const la = na.split(/\s+/).pop(), lb = nb.split(/\s+/).pop();   // surnames
  return !!(la && lb) && (la === lb || na.includes(lb) || nb.includes(la));
}
async function playerMatchStats(fixtureId, playerName) {
  if (!AF_KEY || !fixtureId) return null;
  try {
    const H = { "x-apisports-key": AF_KEY };
    const res = await fetch(`https://v3.football.api-sports.io/fixtures/players?fixture=${fixtureId}`, { headers: H });
    const remaining = res.headers.get("x-ratelimit-requests-remaining") ?? res.headers.get("X-RateLimit-Requests-Remaining");
    const r = await res.json();
    const errs = r.errors && (Array.isArray(r.errors) ? r.errors.length : Object.keys(r.errors).length) ? r.errors : null;
    if (res.status === 429 || errs) {
      console.log(`  ⚠ API-Football per-player blocked (status ${res.status}, remaining today: ${remaining ?? "?"}): ${JSON.stringify(errs || "rate limited")}`);
      return null;
    }
    for (const tm of r.response || [])
      for (const pl of tm.players || [])
        if (playerNameMatch(pl.player?.name, playerName)) return pl.statistics?.[0] || null;
    return null;
  } catch { return null; }
}
/* choose the three most telling stats for the card (position-aware) */
function chipsFromPlayerStats(st, isGK) {
  const g = st.goals || {}, sh = st.shots || {}, ps = st.passes || {}, tk = st.tackles || {}, dr = st.dribbles || {}, du = st.duels || {};
  const chips = [];
  if (isGK) {
    if (g.saves) chips.push(["SAVES", String(g.saves)]);
    if ((g.conceded || 0) === 0) chips.push(["CLEAN SHEET", "✓"]);
    if (ps.accuracy) chips.push(["PASS %", String(ps.accuracy).replace(/[^0-9]/g, "") + "%"]);
    if (ps.total && chips.length < 3) chips.push(["PASSES", String(ps.total)]);
  } else {
    if (g.total) chips.push(["GOALS", String(g.total)]);          // lead with direct contributions
    if (g.assists) chips.push(["ASSISTS", String(g.assists)]);
    const pool = [
      sh.on && ["SHOTS ON", String(sh.on)],
      ps.key && ["KEY PASSES", String(ps.key)],
      dr.success && ["DRIBBLES", String(dr.success)],
      tk.total && ["TACKLES", String(tk.total)],
      du.won && ["DUELS WON", String(du.won)],
      ps.total && ["PASSES", String(ps.total)],
      ps.accuracy && ["PASS %", String(ps.accuracy).replace(/[^0-9]/g, "") + "%"],
    ].filter(Boolean);
    for (const c of pool) { if (chips.length >= 3) break; chips.push(c); }
  }
  return chips.slice(0, 3);
}

// Highlightly possession comes as a decimal (0.47); convert ≤1 values to a percentage.
function hlVal(displayName, value) {
  const v = parseFloat(String(value).replace("%", ""));
  if (!isFinite(v)) return 0;
  if (/possession/i.test(displayName) && v <= 1) return Math.round(v * 100);
  return v;
}
function hlEventType(t) {
  const s = String(t || "").toLowerCase();
  if (s === "goal") return "goal";
  if (s.includes("own")) return "og";
  if (s.includes("missed pen")) return null;       // skip misses on the timeline
  if (s.includes("penalty")) return "pen";
  if (s.includes("yellow")) return "yellow";
  if (s.includes("red")) return "red";
  return null;                                       // substitutions etc. are ignored
}

async function highlightlyStats(ourA, ourB, date) {
  if (!HL_KEY) return { stats: {}, events: [], found: false };
  try {
    const H = { "X-RapidAPI-Key": HL_KEY, "x-api-key": HL_KEY };
    // World Cup 2026 is leagueId=1635; filter to it to get the right matches for the date.
    const mr = await (await fetch(`https://soccer.highlightly.net/matches?leagueId=1635&date=${date}`, { headers: H })).json();
    const list = Array.isArray(mr) ? mr : (mr.data || mr.matches || []);
    const m = list.find(x => {
      const h = x.homeTeam?.name || x.home?.name || "", a = x.awayTeam?.name || x.away?.name || "";
      return (teamsMatch(h, ourA) && teamsMatch(a, ourB)) || (teamsMatch(h, ourB) && teamsMatch(a, ourA));
    });
    if (!m) return { stats: {}, events: [], found: false };
    const homeName = m.homeTeam?.name || m.home?.name || "";
    const homeIsA = teamsMatch(homeName, ourA);
    const id = m.id || m.matchId;
    const out = {};
    const events = [];
    try {
      // The match-detail endpoint carries `statistics` AND `events` directly.
      const d = await (await fetch(`https://soccer.highlightly.net/matches/${id}`, { headers: H })).json();
      const detail = Array.isArray(d) ? d[0] : (d.data ? (Array.isArray(d.data) ? d.data[0] : d.data) : d);
      // statistics: [{team:{name}, statistics:[{value, displayName}]}, {...}]
      const blocks = detail.statistics || [];
      if (Array.isArray(blocks) && blocks.length === 2) {
        const b0Home = teamsMatch(blocks[0].team?.name || "", ourA) || canon(blocks[0].team?.name) === canon(homeName);
        const homeBlock = b0Home ? blocks[0] : blocks[1];
        const awayBlock = b0Home ? blocks[1] : blocks[0];
        const homeList = homeBlock.statistics || [], awayList = awayBlock.statistics || [];
        for (const stat of homeList) {
          const label = stat.displayName || stat.name || stat.type;
          const k = mapStatName(label);
          if (!k) continue;
          const hv = hlVal(label, stat.value);
          const am = awayList.find(s => (s.displayName || s.name || s.type) === label);
          const av = hlVal(label, am?.value);
          out[k] = homeIsA ? [hv, av] : [av, hv];
        }
      }
      // events: [{team:{name}, time:"40", type:"Goal"/"Yellow Card"/..., player, assist}]
      for (const ev of detail.events || []) {
        const type = hlEventType(ev.type);
        if (!type) continue;
        const evIsHome = canon(ev.team?.name) === canon(homeName) || teamsMatch(ev.team?.name || "", ourA) === homeIsA;
        const side = (evIsHome === homeIsA) ? "A" : "B";
        events.push({ min: String(ev.time || "").replace(/[^0-9+]/g, ""), team: side, type, who: ev.player || "", what: ev.assist ? `Assist: ${ev.assist}` : "" });
      }
    } catch { /* */ }
    return { stats: out, events, found: true };
  } catch { return { stats: {}, events: [], found: false }; }
}

/* Format a FIFA UTC timestamp as US Eastern kickoff time, e.g. "6:00 PM ET". */
function etKickoff(iso) {
  if (!iso) return "";
  try {
    const t = new Date(iso);
    if (isNaN(t)) return "";
    const s = t.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    return `${s} ET`;
  } catch { return ""; }
}

/* competition label, stage-led: "Group Stage · Group A" for group games,
   or the knockout round name ("Round of 32", "Round of 16", "Final", …).
   Knockouts decided on penalties (ResultType 2) get "· 1–3 PENS" appended. */
function buildComp(m) {
  const g = desc(m.GroupName);
  const stage = desc(m.StageName);
  let base = g ? `Group Stage · ${g}`     // group match
    : (stage || "World Cup");              // knockout round name, or fallback
  if (Number(m.ResultType) === 2 && m.HomeTeamPenaltyScore != null && m.AwayTeamPenaltyScore != null)
    base += ` · ${m.HomeTeamPenaltyScore}–${m.AwayTeamPenaltyScore} PENS`; // home–away shootout result
  return base;
}

/* An own goal is listed under the team that BENEFITS, but the scoring player is
   on the opposing roster. That roster mismatch is the most reliable signal (we
   also honour any explicit FIFA own-goal flag). */
function goalIsOwn(g, ownSet, oppSet) {
  const explicit = g.OwnGoal === true || g.IsOwnGoal === true ||
    /own/i.test(String(g.Type ?? g.IdGoalType ?? g.GoalType ?? ""));
  const rosterBased = ownSet && ownSet.size > 0 &&
    oppSet.has(String(g.IdPlayer)) && !ownSet.has(String(g.IdPlayer));
  return explicit || rosterBased;
}

/* build the studio moments list from FIFA goals + red cards */
async function buildMoments(home, away) {
  const evs = [];
  const rosterA = new Set((home.Players || []).map(p => String(p.IdPlayer)));
  const rosterB = new Set((away.Players || []).map(p => String(p.IdPlayer)));
  for (const [side, t] of [["A", home], ["B", away]]) {
    const own = side === "A" ? rosterA : rosterB, opp = side === "A" ? rosterB : rosterA;
    for (const g of t.Goals || []) {
      if (Number(g.Period) === 11) continue;   // Period 11 = penalty SHOOTOUT — not a match goal (shown as "x–y ON PENALTIES" instead)
      const who = await playerName(g.IdPlayer);
      const og = goalIsOwn(g, own, opp);
      const assist = (!og && g.IdAssistPlayer) ? await playerName(g.IdAssistPlayer) : "";
      evs.push({ min: minClean(g.Minute), team: side, type: og ? "og" : "goal", who, what: assist ? `Assist: ${assist}` : "" });
    }
    for (const bk of t.Bookings || []) {
      const card = Number(bk.Card);
      if (card > 1) { // 2 = second yellow / straight red
        evs.push({ min: minClean(bk.Minute), team: side, type: "red", who: await playerName(bk.IdPlayer), what: "" });
      } else if (card === 1) { // 1 = yellow — now shown on the timeline too
        evs.push({ min: minClean(bk.Minute), team: side, type: "yellow", who: await playerName(bk.IdPlayer), what: "" });
      }
    }
  }
  evs.sort((a, b) => (parseInt(a.min) || 0) - (parseInt(b.min) || 0));
  if (evs.length > 10) {
    // keep every goal & red; drop the latest yellows first so the timeline stays meaningful
    const keep = evs.filter(e => e.type !== "yellow");
    const yellows = evs.filter(e => e.type === "yellow");
    while (keep.length < 10 && yellows.length) keep.push(yellows.shift());
    keep.sort((a, b) => (parseInt(a.min) || 0) - (parseInt(b.min) || 0));
    return keep.slice(0, 10);
  }
  return evs;
}

async function processMatch(cal) {
  const { IdSeason, IdStage, IdMatch } = cal;
  const home0 = desc(cal.Home?.TeamName), away0 = desc(cal.Away?.TeamName);
  const ourA = ourName(home0), ourB = ourName(away0);
  // FIFA's "Date" is UTC; a 9pm US kickoff rolls into the next UTC day, which
  // wrongly bumped the match date forward. LocalDate is the venue-local day —
  // use it first so the date matches the real matchday.
  const date = String(cal.LocalDate || cal.Date || "").slice(0, 10);
  const label = `${ourA} vs ${ourB} (${date})`;
  const file = `matches/${date}-${slug(ourA)}-vs-${slug(ourB)}.json`;
  if (existsSync(file) && process.env.REFETCH !== "1") { console.log(`• ${label}: already fetched`); return false; }

  const d = await fifa(`live/football/${COMP}/${IdSeason}/${IdStage}/${IdMatch}?language=en`);
  const home = d.HomeTeam || {}, away = d.AwayTeam || {};
  const scoreA = home.Score ?? cal.HomeTeamScore, scoreB = away.Score ?? cal.AwayTeamScore;

  let moments = await buildMoments(home, away);

  // stats: layer sources best→fallback so the decided set fills as fully as possible.
  // Highlightly (richest) ▸ API-Football ▸ TheSportsDB ▸ manual. All key-gated.
  const tsdb = await tsdbStats(ourA, ourB, date);
  const af = await apiFootballStats(ourA, ourB, date);
  const hl = await highlightlyStats(ourA, ourB, date);
  const bdl = await bdlMatchData(ourA, ourB, scoreA, scoreB);   // key-gated; {} when no key/coverage

  // visible diagnostics in the Actions log so you can see if keys/data are working
  console.log(`  stats sources for ${ourA} v ${ourB}: ` +
    `keys[AF:${AF_KEY ? "set" : "—"} HL:${HL_KEY ? "set" : "—"} BDL:${BDL_KEY ? "set" : "—"}] ` +
    `tsdb{${Object.keys(tsdb).join(",") || "∅"}} ` +
    `apifootball{${Object.keys(af.stats).join(",") || "∅"}|ev:${af.events.length}} ` +
    `highlightly{${Object.keys(hl.stats).join(",") || "∅"}|found:${hl.found ? "y" : "n"}} ` +
    `bdl{${Object.keys(bdl.stats).join(",") || "∅"}|found:${bdl.found ? "y" : "n"}|players:${bdl.players.length}}`);

  // If FIFA's bookings were sparse, supplement the timeline with events from
  // API-Football and Highlightly (reliable for cards). Dedupe by minute+team+type.
  const extraEvents = [...(af.events || []), ...(hl.events || [])];
  if (extraEvents.length) {
    const seen = new Set(moments.map(m => `${parseInt(m.min)||0}-${m.team}-${m.type}`));
    for (const ev of extraEvents) {
      const key = `${parseInt(ev.min)||0}-${ev.team}-${ev.type}`;
      if (!seen.has(key)) { moments.push(ev); seen.add(key); }
    }
    moments.sort((a, b) => (parseInt(a.min) || 0) - (parseInt(b.min) || 0));
    if (moments.length > 10) {
      const keep = moments.filter(e => e.type !== "yellow");
      const yellows = moments.filter(e => e.type === "yellow");
      while (keep.length < 10 && yellows.length) keep.push(yellows.shift());
      keep.sort((a, b) => (parseInt(a.min) || 0) - (parseInt(b.min) || 0));
      moments = keep.slice(0, 10);
    }
  }
  // Drop penalty-SHOOTOUT kicks from ANY source: FIFA's have no minute; API-Football
  // lists them as goals/pens at 120+'. A match that went to a shootout (ResultType 2)
  // has no real goal at/after 120', so anything there is a shootout kick, not a match goal.
  {
    const wentToPens = Number(d.ResultType) === 2;
    moments = moments.filter(m => {
      if (!["goal", "pen", "og"].includes(m.type)) return true;        // keep cards
      if (!String(m.min).trim()) return false;                         // shootout kick (no minute)
      if (wentToPens && (parseInt(m.min) || 0) >= 120) return false;   // shootout kick timestamped 120+'
      return true;
    });
  }
  const raw = { ...tsdb, ...af.stats, ...hl.stats, ...bdl.stats };   // BDL wins (most consistent), then HL, AF, tsdb
  const yc = [0, 0];
  [home, away].forEach((t, i) => (t.Bookings || []).forEach(bk => { if (Number(bk.Card) === 1) yc[i]++; }));
  const stats = {};
  const statReview = [];
  for (const key of STAT_ORDER) {
    if (key === "Goals") { stats.Goals = [Number(scoreA) || 0, Number(scoreB) || 0]; continue; }
    if (raw[key]) stats[key] = raw[key];
    else { stats[key] = [0, 0]; statReview.push(key); } // placeholder keeps the row; flag for manual fill
  }
  // keep yellow cards too (useful + always available from FIFA)
  if (yc[0] || yc[1]) stats["Yellow cards"] = yc;

  const review = [];   // human-review flags surfaced in the dropdown + NEEDS_REVIEW.md

  // ---- MOTM selection: official FIFA pick ▸ top scorer ▸ clean-sheet keeper ----
  // Shared builder so every path produces the same card shape.
  const buildCard = async (id, side, chips, posOverride) => {
    if (!id) return null;
    const name = await playerName(id);
    const lp = [...(home.Players || []), ...(away.Players || [])].find(p => String(p.IdPlayer) === String(id));
    let img = null;
    const purl = lp?.PlayerPicture?.PictureUrl;
    if (purl) img = await toDataUri(`${purl}?io=transform:fill,width:600`);
    const extra = await tsdbPlayer(name);
    if (!img && extra?.img) img = extra.img;
    return {
      name, team: side, rate: "",
      pos: posOverride || extra?.pos || "", club: extra?.club || "", league: extra?.league || "",
      number: lp?.ShirtNumber || extra?.number || "",
      chips, ...(img ? { img } : {}),
    };
  };
  // does FIFA expose an official Player of the Match? (field name unconfirmed — checked defensively)
  const fifaMotmId = (() => {
    for (const c of [d.ManOfTheMatch, d.BestPlayer, d.PlayerOfTheMatch, d.MatchAward, d.Award, d.BudweiserManOfTheMatch, d.PlayerOfTheMatchId]) {
      if (!c) continue;
      const id = c.IdPlayer || c.PlayerId || c.Id || (typeof c === "string" || typeof c === "number" ? c : null);
      if (id) return String(id);
    }
    return null;
  })();
  if (process.env.DUMP_FIFA === "1") {
    console.log(`  FIFA MOTM probe: ${fifaMotmId || "—"} | player[0] keys: ${Object.keys((home.Players || [])[0] || {}).join(",")}`);
  }

  // goal tally for the top-scorer path (own goals never credit their scorer)
  const rosterA = new Set((home.Players || []).map(p => String(p.IdPlayer)));
  const rosterB = new Set((away.Players || []).map(p => String(p.IdPlayer)));
  const tally = {};
  for (const [side, t] of [["A", home], ["B", away]])
    for (const g of t.Goals || []) {
      if (Number(g.Period) === 11) continue;          // shootout kicks aren't match goals — don't credit MOTM
      const own = side === "A" ? rosterA : rosterB, opp = side === "A" ? rosterB : rosterA;
      if (goalIsOwn(g, own, opp)) continue;          // skip own goals — don't credit the scorer
      const id = g.IdPlayer || `${side}-${g.Minute}`;
      (tally[id] = tally[id] || { id: g.IdPlayer, team: side, n: 0 }).n++;
    }
  const winner = (parseInt(scoreA) || 0) > (parseInt(scoreB) || 0) ? "A" : (parseInt(scoreB) || 0) > (parseInt(scoreA) || 0) ? "B" : null;
  const scorers = Object.values(tally);
  const maxN = scorers.reduce((mx, s) => Math.max(mx, s.n), 0);
  const top = scorers.filter(s => s.n === maxN).sort((a, b) => (b.team === winner) - (a.team === winner))[0];

  // find a team's goalkeeper from the FIFA lineup (defensive about the position field)
  const findKeeper = (t) => (t.Players || []).find(p => {
    const pos = p.Position ?? p.PlayerPosition ?? p.PositionName ?? p.Role ?? p.PlayerType;
    if (typeof pos === "number") return pos === 0;                 // FIFA commonly uses 0 = GK
    const s = String(pos || "").toLowerCase();
    return s.includes("goal") || s.includes("keeper") || s === "gk";
  }) || null;

  let motm = null;
  // 0. BALLDONTLIE official Man of the Match (authoritative; keeps FIFA photo by
  //    matching the name back to FIFA's lineup). Covers every match BDL has.
  if (bdl.found && bdl.best.length) {
    const best = bdl.best.find(b => b.is_man_of_match) ||
      bdl.best.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0))[0];
    const name = best && bdl.names[best.player_id];
    if (best && name) {
      const side = best.is_home ? "A" : "B";
      const fp = [...(home.Players || []), ...(away.Players || [])]
        .find(p => playerNameMatch(p.PlayerName, name) || playerNameMatch(p.ShortName, name));
      const isGK = fp && findKeeper(side === "A" ? home : away)?.IdPlayer === fp.IdPlayer;
      const cs = side === "A" ? (Number(scoreB) || 0) === 0 : (Number(scoreA) || 0) === 0;
      const pst = bdl.players.find(p => p.player_id === best.player_id);
      const chips = pst ? bdlChips(pst, isGK, cs) : [];
      motm = fp
        ? await buildCard(fp.IdPlayer, side, chips, isGK ? "GK" : undefined)
        : { name, team: side, rate: "", pos: "", club: "", league: "", number: "", chips };
      const rating = pst?.rating ?? best.rating;
      if (rating) motm.rate = String(Math.round(rating * 10) / 10);
      console.log(`  MOTM (BALLDONTLIE official): ${motm.name} — rate ${motm.rate || "—"}, chips ${motm.chips.map(c => c.join(" ")).join(", ") || "—"}`);
    }
  }
  if (!motm && fifaMotmId) {
    const side = (home.Players || []).some(p => String(p.IdPlayer) === fifaMotmId) ? "A" : "B";
    motm = await buildCard(fifaMotmId, side, []);   // official pick; chips left for manual touch
  }
  if (!motm && top) {
    const name = await playerName(top.id);
    const assists = moments.filter(m => m.what === `Assist: ${name}`).length;
    const chips = [["GOALS", String(top.n)]];
    if (assists) chips.push(["ASSISTS", String(assists)]);
    motm = await buildCard(top.id, top.team, chips);
  }
  if (!motm) {
    // goalless / no scorer → the keeper who kept a clean sheet, preferring the busier one
    const csA = (Number(scoreB) || 0) === 0, csB = (Number(scoreA) || 0) === 0;
    if (csA || csB) {
      const sot = stats["Shots on target"] || raw["Shots on target"] || [0, 0];
      const busyA = Number(sot[1]) || 0;   // shots on target A's keeper faced
      const busyB = Number(sot[0]) || 0;   // shots on target B's keeper faced
      const side = (csA && csB) ? (busyB >= busyA ? "B" : "A") : (csA ? "A" : "B");
      const kp = findKeeper(side === "A" ? home : away);
      if (kp) {
        const savesArr = raw["Saves"] || raw["Goalkeeper Saves"] || null;
        const facedSot = side === "A" ? busyA : busyB;
        const chips = [];
        if (savesArr) chips.push(["SAVES", String(side === "A" ? savesArr[0] : savesArr[1])]);
        if (facedSot) chips.push(["SHOTS FACED", String(facedSot)]);
        chips.push(["CLEAN SHEET", "✓"]);
        motm = await buildCard(kp.IdPlayer, side, chips, "GK");
        review.push("MOTM auto-picked the clean-sheet goalkeeper (no goalscorer) — confirm against the official award.");
      }
    }
  }

  // Enrich the card with the player's real per-match stats: a rating for the big
  // number, and the three most telling stats as chips. Falls back to the basic
  // chips above when API-Football doesn't cover this fixture/player.
  if (motm && af.fixtureId) {
    const pst = await playerMatchStats(af.fixtureId, motm.name);
    if (pst) {
      const rating = pst.games?.rating ? Math.round(parseFloat(pst.games.rating) * 10) / 10 : null;
      if (rating) motm.rate = String(rating);
      const richChips = chipsFromPlayerStats(pst, motm.pos === "GK");
      if (richChips.length) motm.chips = richChips;
      console.log(`  MOTM stats: ${motm.name} — rate ${motm.rate || "—"}, chips ${motm.chips.map(c => c.join(" ")).join(", ")}`);
    } else {
      console.log(`  MOTM stats: ${motm.name} — no per-player data (using basic chips)`);
    }
  }

  const comp = buildComp(d);
  const venue = [desc(d.Stadium?.Name), desc(d.Stadium?.CityName)].filter(Boolean).join(", ");

  const slides = ["cover", "moments"];
  if (Object.keys(stats).length) slides.push("stats");
  if (motm) slides.push("motm");

  // review flags (should rarely trigger now that goals are complete)
  const total = (parseInt(scoreA) || 0) + (parseInt(scoreB) || 0);
  const tlGoals = moments.filter(m => m.type === "goal").length;
  if (tlGoals < total) review.push(`Timeline shows ${tlGoals} of ${total} goals — add the missing scorer(s) in the editor.`);
  if (statReview.length) review.push(`Stats not in the source — fill by hand: ${statReview.join(", ")}.`);

  // penalty shootout result (knockouts decided on pens) -> shown on the scorecard
  const pens = (Number(d.ResultType) === 2 && d.HomeTeamPenaltyScore != null && d.AwayTeamPenaltyScore != null)
    ? { penA: parseInt(d.HomeTeamPenaltyScore), penB: parseInt(d.AwayTeamPenaltyScore) } : null;
  const out = {
    teamA: ourA, teamB: ourB,
    scoreA: parseInt(scoreA), scoreB: parseInt(scoreB),
    ...(pens || {}),
    venue, date, comp,
    kickoff: String(cal.Date || cal.LocalDate || ""),   // full timestamp for precise "latest" ordering
    ...(CFG.handle ? { handle: CFG.handle } : {}),
    slides, moments, stats,
    ...(motm ? { motm } : {}),
    ...(review.length ? { review } : {}),
    _source: "fifa",
  };
  // Remove any stale copy of THIS match saved under a different date (the
  // kickoff-date fix could leave a duplicate filename). Keep only this run's.
  const slugTail = `-${slug(ourA)}-vs-${slug(ourB)}.json`;
  for (const f of readdirSync("matches")) {
    if (f.endsWith(slugTail) && `matches/${f}` !== file) {
      try { unlinkSync(`matches/${f}`); console.log(`  ↳ removed stale duplicate matches/${f}`); } catch { /* */ }
    }
  }
  writeFileSync(file, JSON.stringify(out, null, 2));   // latest.json is written once, at the end, as the newest match
  console.log(`✓ ${label}: ${out.scoreA}-${out.scoreB}, ${moments.length} moment(s) [${slides.join(", ")}]`);
  if (review.length) console.log(`  ⚠ NEEDS REVIEW: ${review.join(" | ")}`);
  return true;
}

/* ---------------- main ---------------- */
mkdirSync("matches", { recursive: true });
// FIFA's calendar wants day-aligned UTC boundaries (T00:00:00Z).
// Normal runs cover yesterday→tomorrow; set BACKFILL_DAYS to widen the lookback
// (e.g. BACKFILL_DAYS=10 with REFETCH=1 to regenerate the last 10 days of matches).
const dayStart = ms => new Date(ms).toISOString().slice(0, 10) + "T00:00:00Z";
const lookbackDays = Math.max(1, parseInt(process.env.BACKFILL_DAYS || "1", 10) || 1);
const from = dayStart(Date.now() - lookbackDays * 24 * 3.6e6);
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

/* rebuild matches/index.json — the full archive list Carousel Studio's match
   dropdown reads. One entry per saved match, newest first. */
const indexEntries = [];
for (const f of readdirSync("matches")) {
  if (!f.endsWith(".json") || f === "latest.json" || f === "index.json") continue;
  try {
    const m = JSON.parse(readFileSync(`matches/${f}`, "utf8"));
    indexEntries.push({
      file: `matches/${f}`,
      teamA: m.teamA, teamB: m.teamB,
      scoreA: m.scoreA ?? null, scoreB: m.scoreB ?? null,
      date: m.date || "", kickoff: m.kickoff || m.date || "", comp: m.comp || "",
      status: m.status || "FT",
      needsReview: Array.isArray(m.review) && m.review.length > 0,
    });
  } catch { /* skip unreadable */ }
}
// newest first by actual kickoff time (falls back to date), so same-day games order correctly
const byRecency = (a, b) => String(b.kickoff).localeCompare(String(a.kickoff)) || String(b.file).localeCompare(String(a.file));
indexEntries.sort(byRecency);

// Safety net: collapse any same-match duplicates (same team-pair) that slipped
// through, keeping the entry with the most complete data.
const richness = e => (e.scoreA != null && e.scoreB != null ? 2 : 0) + (e.needsReview ? 0 : 3);
const byPair = new Map();
for (const e of indexEntries) {
  const key = [e.teamA, e.teamB].map(s => norm(s)).sort().join("|");
  const cur = byPair.get(key);
  if (!cur || richness(e) > richness(cur)) byPair.set(key, e);
}
const deduped = [...byPair.values()].sort(byRecency);
if (deduped.length < indexEntries.length) console.log(`  ↳ index deduped: ${indexEntries.length} → ${deduped.length} unique match(es).`);
writeFileSync("matches/index.json", JSON.stringify({ updated: new Date().toISOString(), matches: deduped }, null, 2));
console.log(`✓ index.json rebuilt — ${deduped.length} match(es).`);

// latest.json = the genuinely most-recent match (by kickoff), so "Load latest match" is reliable
if (deduped[0]) {
  try {
    writeFileSync("matches/latest.json", readFileSync(deduped[0].file, "utf8"));
    console.log(`✓ latest.json → ${deduped[0].teamA} v ${deduped[0].teamB} (${deduped[0].date}).`);
  } catch { /* */ }
}

/* rebuild NEEDS_REVIEW.md digest */
const flagged = [];
for (const f of readdirSync("matches")) {
  if (!f.endsWith(".json") || f === "latest.json" || f === "index.json") continue;
  try { const m = JSON.parse(readFileSync(`matches/${f}`, "utf8")); if (m.review?.length) flagged.push(m); } catch { /* */ }
}
flagged.sort((a, b) => String(b.date).localeCompare(String(a.date)));
let md = `# Matches needing review\n\n_Auto-generated each run. These matches have data gaps — open them in Carousel Studio, verify, and fill anything missing before posting. Everything not listed looked complete._\n\n`;
md += flagged.length ? flagged.map(m => `### ${m.teamA} ${m.scoreA}–${m.scoreB} ${m.teamB} — ${m.date}\n${m.review.map(r => `- ${r}`).join("\n")}\n`).join("\n")
  : `✓ Nothing flagged — all fetched matches look complete.\n`;
writeFileSync("NEEDS_REVIEW.md", md);

console.log(wrote ? `Done — ${wrote} new match file(s).` : "Done — nothing new this run.");
