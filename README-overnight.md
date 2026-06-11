# Matchday pipeline — fetch → render → (auto-)post

While you sleep, GitHub Actions runs hourly and, for every watched or
auto-detected finished match: fetches the data, renders the carousel slides to
final 1080×1350 PNGs using your own Carousel Studio, writes a caption, and —
if you switch it on — posts the carousel to Instagram. Zero touches.

Two modes, one switch (`"autoPost"` in `watchlist.json`):
- `false` → everything is rendered and waiting in `posts/<match>/` with a
  ready `caption.txt`; you just post (and optionally add the MOTM photo first).
- `true`  → it posts to Instagram by itself, minutes after full time.

## One-time setup

1. **Free API key** at dashboard.api-football.com (about 100 requests/day on
   the free plan — confirm current limits). Each finished match costs 4
   requests, plus 1–2 per run for the daily fixture lists.

2. **Create a PUBLIC GitHub repo** with these files:
   - `CarouselStudio.html`, `fetch-match.mjs`, `render-slides.mjs`,
     `post-instagram.mjs`, `watchlist.json`, `package.json` (repo root)
   - `.github/workflows/fetch-matches.yml` ← exact folder path matters
   - (optional) a `photos/` folder — see "MOTM photos" below
   Public is required for auto-posting (Instagram downloads the images from
   your repo's raw URLs) and for the studio's one-tap Load latest button.
   The repo only ever contains match data and rendered graphics; all keys and
   tokens live in GitHub Secrets, which stay private.

3. **Secrets** (repo → Settings → Secrets and variables → Actions):
   - `API_FOOTBALL_KEY` — always required
   - `IG_ACCESS_TOKEN`, `IG_USER_ID` — only if `autoPost` is true (see below)

4. Test it: Actions tab → "Matchday pipeline" → Run workflow.

## watchlist.json

```json
{
  "timezone": "Asia/Kolkata",
  "autoLeagues": ["World Cup"],
  "autoPost": false,
  "slides": ["cover", "moments", "stats", "motm"],
  "hashtags": ["#WorldCup2026", "#Matchday"],
  "captionTemplate": "FT: {teamA} {scoreA}-{scoreB} {teamB}\n{comp}\n{venue}\n\n{hashtags}",
  "matches": [
    { "date": "2026-06-14", "teamA": "Argentina", "teamB": "Mexico" }
  ]
}
```

- **`autoLeagues`** is the zero-touch part: every finished fixture of that
  competition (today/yesterday in your timezone) is picked up automatically —
  no editing before each match night. During the group stage that's every
  World Cup game. Remove it (or empty the list) to only process `matches`.
- **`matches`** still works for hand-picked fixtures (friendlies, other
  competitions). Team names exactly as in the studio dropdown.
- **`slides`** controls which slides render and in what order.
- **Caption placeholders:** {teamA} {teamB} {scoreA} {scoreB} {comp} {venue}
  {motm} {hashtags}.

## MOTM photos (the one thing that can't be fully automatic)

Player photos are copyrighted, so the pipeline will never scrape them — that
part stays yours. But you can pre-load a library: put images you have rights
to use in `photos/`, named by player, e.g. `photos/lionel-messi.jpg`
(lowercase, hyphens). When that player is MOTM, the renderer bakes the photo
into the card automatically. No matching photo → clean silhouette placeholder.
Added a photo after a match was already rendered? Delete that match's
`posts/<match>/` folder (and its `.posted` file is gone with it — only do this
BEFORE it posts, or it will post again) and re-run the workflow.

## Auto-posting to Instagram (`autoPost: true`)

Done via the official Instagram Graph API — no password sharing, no scraping.
One-time Meta setup (Meta moves these screens around; their "Instagram
platform → Content publishing" docs are the source of truth):

1. Convert your Instagram account to a **Professional account** (Creator or
   Business — free) and **link it to a Facebook Page**.
2. Create an app at developers.facebook.com (Business type) and add the
   Instagram Graph API product. For posting to YOUR OWN account, the app can
   stay in development mode — no app review needed.
3. Generate a token (Graph API Explorer) with `instagram_basic`,
   `instagram_content_publish`, `pages_show_list`, then exchange it for a
   **long-lived token** (~60 days — set a reminder to regenerate it).
4. Find your IG user id: `GET me/accounts` → your Page id →
   `GET {page-id}?fields=instagram_business_account`.
5. Save both as the `IG_ACCESS_TOKEN` and `IG_USER_ID` secrets, set
   `"autoPost": true`, done.

The poster waits for the raw CDN to serve the freshly pushed PNGs, creates the
carousel, publishes, and writes a `.posted` marker so a match can never be
posted twice. Instagram allows ~25 API posts per day — far more than needed.

## Good to know

- **Group stage / knockouts:** fixtures are found by date + teams regardless
  of competition; labels auto-fill as "World Cup · Group Stage - 1" etc., and
  knockout shootout scores are appended automatically (e.g. "· 4–2 PENS").
- **The risk of full automation, stated plainly:** nobody reviews the post
  before it goes live. API data is occasionally wrong or late (especially xG
  and ratings). Suggestion: run with `autoPost: false` for the first few
  matchdays, eyeball what lands in `posts/`, and flip it on once you trust it.
- **Studio still works standalone:** manual entry, JSON import, and the
  one-tap Load latest button are all unchanged for whenever you want hands-on
  control or a photo on the MOTM card.
- **API budget with autoLeagues on:** hourly runs ≈ 50–70 calls on a busy
  3–4 match day — inside the free tier, but if you ever watch 6+ fixtures
  daily, change the cron to `"15 */2 * * *"` (every 2 hours).
- **Hosting note:** GitHub Actions schedules are best-effort; expect posts
  within roughly an hour of full time, not the same minute.
- **Verify when you can.** Even on full auto, glance at the account in the
  morning — it's your name on the posts, not the API's.
