#!/usr/bin/env node
/* ============================================================================
   Matchday pipeline — step 1: FETCH (dispatcher)
   Picks the data source from watchlist.json "source":
     "thesportsdb"  -> fetch-thesportsdb.mjs   (free, no key for the test tier;
                       set THESPORTSDB_KEY for your own key. No xG / ratings.)
     "apifootball"  -> fetch-apifootball.mjs    (API-Football, needs a paid plan
                       for the current World Cup season; full xG + ratings.)
   The rest of the pipeline (render, post) is identical for both — they write
   the same matches/<slug>.json shape.
   Default: thesportsdb.
   ============================================================================ */
import { readFileSync } from "node:fs";

const CFG = JSON.parse(readFileSync(new URL("./watchlist.json", import.meta.url), "utf8"));
const src = String(CFG.source || "thesportsdb").toLowerCase().replace(/[^a-z]/g, "");

const MODULES = {
  thesportsdb: "./fetch-thesportsdb.mjs",
  apifootball: "./fetch-apifootball.mjs",
  apifootballcom: "./fetch-apifootball.mjs",
};
const mod = MODULES[src] || MODULES.thesportsdb;
console.log(`Data source: "${CFG.source || "thesportsdb"}" -> ${mod}`);
await import(mod);
