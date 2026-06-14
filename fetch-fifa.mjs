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
    return { stats: out, events };
  } catch { return { stats: {}, events: [] }; }
}

async function highlightlyStats(ourA, ourB, date) {
  if (!HL_KEY) return { stats: {}, events: [] };
  try {
    const H = { "x-api-key": HL_KEY };
    const mr = await (await fetch(`https://soccer.highlightly.net/matches?date=${date}`, { headers: H })).json();
    const list = Array.isArray(mr) ? mr : (mr.data || mr.matches || []);
    const m = list.find(x => {
      const h = x.homeTeam?.name || x.home?.name || "", a = x.awayTeam?.name || x.away?.name || "";
      return (teamsMatch(h, ourA) && teamsMatch(a, ourB)) || (teamsMatch(h, ourB) && teamsMatch(a, ourA));
    });
    if (!m) return { stats: {}, events: [] };
    const homeIsA = teamsMatch(m.homeTeam?.name || m.home?.name || "", ourA);
    const id = m.id || m.matchId;
    const out = {};
    try {
      const sr = await (await fetch(`https://soccer.highlightly.net/statistics/${id}`, { headers: H })).json();
      const rows = sr.statistics || sr.data || [];
      // Highlightly returns per-team blocks; normalise defensively
      const blocks = Array.isArray(rows) ? rows : [];
      if (blocks.length === 2) {
        for (const stat of blocks[0].statistics || []) {
          const k = mapStatName(stat.type || stat.name);
          if (!k) continue;
          const hv = parseFloat(String(stat.value).replace("%", "")) || 0;
          const match = (blocks[1].statistics || []).find(s => (s.type || s.name) === (stat.type || stat.name));
          const av = parseFloat(String(match?.value).replace("%", "")) || 0;
          out[k] = homeIsA ? [hv, av] : [av, hv];
        }
      }
    } catch { /* */ }
    return { stats: out, events: [] };
  } catch { return { stats: {}, events: [] }; }
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

/* competition label: "World Cup · Group A · Match 2 · 6:00 PM ET" */
function buildComp(m, kickoffIso) {
  const parts = ["World Cup"];
  const g = desc(m.GroupName);
  if (g) parts.push(g);                                  // already "Group A"
  if (m.MatchNumber != null) parts.push(`Match ${m.MatchNumber}`);
  else if (desc(m.StageName)) parts.push(desc(m.StageName));
  const et = etKickoff(kickoffIso);
  if (et) parts.push(et);                                // ET kickoff, not local TZ
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

  // visible diagnostics in the Actions log so you can see if keys/data are working
  console.log(`  stats sources for ${ourA} v ${ourB}: ` +
    `keys[AF:${AF_KEY ? "set" : "—"} HL:${HL_KEY ? "set" : "—"}] ` +
    `tsdb{${Object.keys(tsdb).join(",") || "∅"}} ` +
    `apifootball{${Object.keys(af.stats).join(",") || "∅"}|ev:${af.events.length}} ` +
    `highlightly{${Object.keys(hl.stats).join(",") || "∅"}}`);

  // If FIFA's bookings were sparse, supplement the timeline with API-Football
  // events (reliable for yellow/red cards). Dedupe by minute+team+type.
  if (af.events && af.events.length) {
    const seen = new Set(moments.map(m => `${parseInt(m.min)||0}-${m.team}-${m.type}`));
    for (const ev of af.events) {
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
  const raw = { ...tsdb, ...af.stats, ...hl.stats };   // later spreads win = richer sources override
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

  // MOTM: top scorer from raw goals (carry IdPlayer); when tied, prefer the winner
  let motm = null;
  const tally = {};
  for (const [side, t] of [["A", home], ["B", away]])
    for (const g of t.Goals || []) {
      const id = g.IdPlayer || `${side}-${g.Minute}`;
      (tally[id] = tally[id] || { id: g.IdPlayer, team: side, n: 0 }).n++;
    }
  const winner = (parseInt(scoreA) || 0) > (parseInt(scoreB) || 0) ? "A" : (parseInt(scoreB) || 0) > (parseInt(scoreA) || 0) ? "B" : null;
  const scorers = Object.values(tally);
  const maxN = scorers.reduce((mx, s) => Math.max(mx, s.n), 0);
  const top = scorers.filter(s => s.n === maxN).sort((a, b) => (b.team === winner) - (a.team === winner))[0];
  if (top) {
    const name = await playerName(top.id);
    // photo: FIFA lineup cutout by player id (reliable cutout, transparent PNG)
    const lp = [...(home.Players || []), ...(away.Players || [])].find(p => String(p.IdPlayer) === String(top.id));
    let img = null;
    const purl = lp?.PlayerPicture?.PictureUrl;
    if (purl) img = await toDataUri(`${purl}?io=transform:fill,width:600`);
    // club / league / position from TheSportsDB by name (best-effort); photo fallback too
    const extra = await tsdbPlayer(name);
    if (!img && extra?.img) img = extra.img;
    const assists = moments.filter(m => m.what === `Assist: ${name}`).length;
    const chips = [["GOALS", String(top.n)]];
    if (assists) chips.push(["ASSISTS", String(assists)]);
    motm = {
      name, team: top.team, rate: "",
      pos: extra?.pos || "", club: extra?.club || "", league: extra?.league || "",
      number: lp?.ShirtNumber || extra?.number || "",
      chips, ...(img ? { img } : {}),
    };
  }

  const comp = buildComp(d, cal.Date);
  const venue = [desc(d.Stadium?.Name), desc(d.Stadium?.CityName)].filter(Boolean).join(", ");

  const slides = ["cover", "moments"];
  if (Object.keys(stats).length) slides.push("stats");
  if (motm) slides.push("motm");

  // review flags (should rarely trigger now that goals are complete)
  const review = [];
  const total = (parseInt(scoreA) || 0) + (parseInt(scoreB) || 0);
  const tlGoals = moments.filter(m => m.type === "goal").length;
  if (tlGoals < total) review.push(`Timeline shows ${tlGoals} of ${total} goals — add the missing scorer(s) in the editor.`);
  if (statReview.length) review.push(`Stats not in the source — fill by hand: ${statReview.join(", ")}.`);

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
