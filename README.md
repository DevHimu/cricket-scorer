# Cricket Scorer + Realtime API

A very simple cricket scoring web app where the **API is the source of truth**. The web UI only sends ball events; every rule (strike rotation, over change, wide / no-ball, innings end, result) is applied on the server, so anything you build on top of the API always reads correct live data.

## What's inside

```
cricket-scorer/
├── server.js            Express server: static hosting + REST API + realtime stream
├── scoring.js           The cricket engine (all automation lives here)
├── test-engine.js       39 unit tests for the scoring rules  (npm test)
├── package.json
├── data/
│   ├── teams.json       List of teams
│   ├── teams/<id>.json  One squad file per team (15 players each)
│   └── matches/         Saved matches (auto-created, one JSON per match)
└── public/
    ├── index.html       Scorer app (login → setup → XI → toss → scoring)
    ├── app.js           Front-end logic
    ├── style.css        Scoreboard theme
    └── live.html        Public live scoreboard — a reference API consumer (SSE)
```

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

Default scorer login: **admin / cricket123**. Change it with environment variables:

```bash
SCORER_USER=myuser SCORER_PASS=mypass PORT=8080 npm start
```

Environment variables:

| Variable            | Default      | Description                                                        |
|---------------------|--------------|--------------------------------------------------------------------|
| `PORT`              | `3000`       | HTTP port                                                          |
| `SCORER_USER`       | `admin`      | Scoring login username                                             |
| `SCORER_PASS`       | `cricket123` | Scoring login password                                            |
| `SESSION_SECRET`    | auto         | Secret used to sign login tokens. **Set this on Render** so tokens survive restarts. |
| `SESSION_TTL_HOURS` | `168`        | How long a login stays valid (7 days)                             |
| `RETENTION_DAYS`    | `30`         | Finished matches are auto-deleted after this many days            |

Run the rule tests any time with `npm test`.

## The scoring flow (web UI)

1. **Login**
2. **Teams & overs** — pick Team A, Team B, and overs per innings
3. **Playing XI** — toggle exactly 11 players for each side (validated)
4. **Overview** — confirm both XIs, then **Start game**
5. **Toss** — winner + bat/bowl
6. **Openers & bowler**, then **Scorer**: tap runs (0–6), tap an extra chip (Wide / No ball / Bye / Leg bye) before a run, or **Wicket**. Strike rotates on 1/3/5, the over changes automatically, and pop-ups ask for the next batter or bowler. At the innings break you continue to the 2nd innings; after it the result is shown.

## Automation handled for you

- Strike rotates on odd runs (1, 3, 5); stays on 0, 2, 4, 6
- Batters cross at the end of every over; the new bowler is requested
- **Wide / No ball** add a run and do **not** count as a legal ball
- Byes / leg byes count as a ball but aren't credited to the batter
- Wicket → prompts the next batter (placed at the correct end, even on the last ball of an over)
- Innings ends automatically at overs completed, all out, or target reached
- Result computed as "won by N runs" or "won by N wickets" (or tie)

---

# API reference

Base URL: `http://localhost:3000` (or your host). All bodies and responses are JSON.

### Auth
Write actions (creating a match, scoring, etc.) need a token. Reads are open so your other project can consume scores freely.

**`POST /api/login`** → `{ "token": "...", "user": "admin", "expiresAt": "<ISO>" }`
```json
{ "username": "admin", "password": "cricket123" }
```
Send the token on write calls: `Authorization: Bearer <token>`

Tokens are **HMAC-signed and stateless**, so they keep working after the server restarts (e.g. when a Render free instance spins down mid-match). They stay valid for `SESSION_TTL_HOURS` (default 7 days). The web app stores the token in the browser and restores it on reload, so a refresh never forces a re-login — and if a match was open, it resumes it.

**`GET /api/session`** → `{ "valid": true, "user": "...", "expiresAt": "<ISO>" }` — check whether a stored token is still valid (send it as `Authorization: Bearer <token>`).

### Teams & leagues
Teams belong to a **league** (International, IPL, Club Cricket, Gully Cricket by default — fully manageable from the website or the API). Teams and squads can be added from the website; they're written straight into the `data/` config.

- **`GET /api/teams`** → `[{ id, name, league }]` (public; entries without a league default to `International`)
- **`GET /api/teams/:id`** → `{ id, name, league, players:[{id,name}] }` (public)
- **`POST /api/teams/create`** (auth) — `{ "name", "league", "players": ["Player One", ...] }` (min 11 players). Generates ids, writes `data/teams/<id>.json`, and registers it in `data/teams.json`.
- **`GET /api/leagues`** → `{ leagues: [...] }` (public, from `data/leagues.json`)
- **`POST /api/leagues/create`** (auth) — `{ "name" }`
- **`POST /api/leagues/delete`** (auth) — `{ "name" }` (refused while the league still has teams)

### Match lifecycle (auth required)
- **`POST /api/matches/create`** — create a match
  ```json
  {
    "overs": 6,
    "venue": "Eden Gardens, Kolkata",
    "teamA": { "id":"india", "name":"India", "players":[ {"id":"india1","name":"..."}, "...11 total" ] },
    "teamB": { "id":"australia", "name":"Australia", "players":[ "...11 total" ] }
  }
  ```
  `venue` and `league` are optional (both surface as prediction features). → full match object (note the `id`).
  *(`POST /api/matches` still works as a deprecated alias, but `/create` is the canonical, unambiguous path — GET and POST no longer share `/api/matches`.)*
- **`POST /api/matches/:id/toss`** — `{ "winner":"A"|"B", "decision":"bat"|"bowl" }`
- **`POST /api/matches/:id/start-innings`** — `{ "strikerId", "nonStrikerId", "bowlerId" }`
- **`POST /api/matches/:id/ball`** — record one delivery:
  ```json
  { "runs": 0, "extra": null, "wicket": null }
  ```
  - `runs`: 0–6 (runs off the bat, or runs physically run for byes/wides)
  - `extra`: `null | "wide" | "noball" | "bye" | "legbye"`
  - `wicket`: `null | { "type":"bowled", "batterOutId":"<optional, defaults to striker>" }`
  - Examples: single → `{"runs":1}` · four → `{"runs":4}` · wide → `{"extra":"wide"}` · no-ball hit for 4 → `{"extra":"noball","runs":4}` · bowled → `{"runs":0,"wicket":{"type":"bowled"}}`
- **`POST /api/matches/:id/next-batter`** — `{ "batterId" }` (after a wicket)
- **`POST /api/matches/:id/bowler`** — `{ "bowlerId" }` (after an over)
- **`POST /api/matches/:id/second-innings`** — start 2nd-innings setup at the break
- **`POST /api/matches/:id/undo`** — undo the last ball
- **`POST /api/matches/:id/delete`** — delete a match, live or completed (completed matches can't be edited, only viewed or deleted)

### Reading scores — this is what you consume
- **`GET /api/matches/:id/score`** → **compact live score** (recommended). Includes a flat **`features`** block built specifically for a prediction model — see "For your prediction app" below.
- **`GET /api/matches/:id/stream`** — **realtime** via Server-Sent Events. Emits the compact live score (including `features`) on every ball. CORS is open.

## For your prediction app

Every `/score` response carries a flat `features` object that maps 1:1 to standard score-prediction inputs, so you can feed it to a model without reshaping:

```json
"features": {
  "battingTeam": "India",
  "bowlingTeam": "Australia",
  "venue": "Eden Gardens, Kolkata",
  "league": "IPL",
  "currentRuns": 14,
  "currentWickets": 0,
  "oversCompleted": "1.4",
  "ballsBowled": 10,
  "striker": "S. Gill",   "strikerId": "india2",  "strikerRuns": 12, "strikerBalls": 3,
  "nonStriker": "R. Sharma", "nonStrikerId": "india1", "nonStrikerRuns": 1, "nonStrikerBalls": 1,
  "bowler": "D. Warner",  "bowlerId": "australia1",
  "currentRunRate": 21.0,
  "ballsRemaining": 116,
  "innings": 1,
  "wicketsRemaining": 10,
  "target": null
}
```

Mapping to the usual training parameters:

| Training parameter   | Field in `features`                          | Type    |
|----------------------|----------------------------------------------|---------|
| Batting Team         | `battingTeam`                                | string (categorical) |
| Bowling Team         | `bowlingTeam`                                | string (categorical) |
| Venue                | `venue`                                      | string (categorical, nullable) |
| League               | `league`                                     | string (categorical, nullable) — e.g. International / IPL / Club Cricket / Gully Cricket; useful for transfer-learning across match types |
| Current Runs         | `currentRuns`                                | int     |
| Current Wickets      | `currentWickets`                             | int     |
| Overs Completed      | `oversCompleted` (display) / `ballsBowled` (numeric) | string `"O.B"` / int |
| Striker              | `striker` / `strikerId` (+ `strikerRuns`, `strikerBalls`) | string / int |
| Non-Striker          | `nonStriker` / `nonStrikerId` (+ runs, balls)| string / int |
| Bowler               | `bowler` / `bowlerId`                        | string  |
| Current Run Rate     | `currentRunRate`                             | float   |
| Balls Remaining      | `ballsRemaining`                             | int     |

Notes:
- **For the model, use the integer `ballsBowled`.** Both `oversCompleted` and `oversBowled` are cricket over notation (`"1.4"` = 1 over + 4 balls = 10 balls), which is *not* linear — the fractional part only runs 0–5 and jumps to the next whole number after the 6th ball, so it will confuse a model near over boundaries. `ballsBowled` (e.g. `10`) is the clean, unambiguous numeric feature; divide by 6 yourself if you want true decimal overs.
- Team / venue / player fields are categorical — one-hot or embed them; keep a fixed vocabulary so unseen values don't break inference.
- For 2nd-innings (chase) models, `target` is non-null and `ballsRemaining` gives balls left to reach it.
- `strikerId` / `bowlerId` are stable keys — use them (not display names) to join your historical player-ability tables.

Other numeric fields alongside `features` on the same response: `ballsBowled`, `ballsRemaining`, `oversCompleted`, `wicketsRemaining`, plus the display-friendly `score`, `oversBowled`, `runRate`, `striker`, `nonStriker`, `bowler`, `lastBalls`, `extras`.

### Reading it
- **`GET /api/matches`** → `{ count, live:[...], played:[...], matches:[...] }`. Each summary carries `category` (`"live"` or `"played"`), `status`, `teamA`, `teamB`, `venue`, `innings:[{battingTeam,runs,wickets,overs}]`, `result`, and timestamps. Filter with `?state=live` or `?state=played`, and cap with `?limit=N`. (This is what the public feed at `/live.html` uses to list live and past matches.)
- **`GET /api/matches/:id`** → full raw match state (innings, timeline, batter/bowler cards, fall of wickets)

### Consume it in ~5 lines

```js
// Realtime push (browser or Node with an EventSource polyfill)
const es = new EventSource("https://YOUR_HOST/api/matches/MATCH_ID/stream");
es.onmessage = (e) => {
  const s = JSON.parse(e.data);
  console.log(s.batting, s.score, s.oversBowled, "last:", s.lastBalls.join(" "));
};
```

```js
// Or simple polling
setInterval(async () => {
  const s = await (await fetch("/api/matches/MATCH_ID/score")).json();
  updateMyWidget(s);
}, 3000);
```

`public/live.html` is a full working example (SSE with a polling fallback).

---

## Adding or editing teams

Add an entry to `data/teams.json` and drop a matching `data/teams/<id>.json` squad file:

```json
{ "id": "mumbai", "name": "Mumbai XI",
  "players": [ { "id": "mumbai1", "name": "Player One" }, "... up to any number; you pick 11 in the app" ] }
```

## Public feed & match history

`/live.html` is a public page (no login):
- With no query string it shows two lists — **Live now** and **Recent results** — built from `GET /api/matches`, auto-refreshing every 10 seconds. Click any match to open it.
- With `?id=<matchId>` it shows the live scoreboard for an in-progress match (realtime via SSE), or, once a match is finished, a full **scorecard**: each innings' batting card, extras, complete **over-by-over** breakdown, and the result.

Finished matches remain available (in the feed and via the API) for `RETENTION_DAYS` (default 30), then are automatically removed. In-progress matches are never auto-removed.

## Deploying

The app is a single Node process that serves both the UI and the API.

- **VPS / Node host (recommended):** `npm install && npm start` behind Nginx; keep it alive with `pm2 start server.js`. On **Hostinger VPS** or Hostinger's Node.js hosting this runs as-is (set `PORT` and your credentials as env vars).
- **Render / Railway / Fly.io:** point at the repo, build `npm install`, start `node server.js`.
- Match data persists to `data/matches/*.json`; back up that folder (or mount a volume) to keep history across restarts.

> Hostinger **shared** hosting only runs PHP, not long-lived Node processes. If you're on a shared plan rather than a VPS, ask and I'll port this backend to PHP + MySQL with the same API surface.

## Known simplifications (kept intentionally simple)

- A wicket is recorded as 0 runs off the bat (no run-out-with-runs).
- No free-hit tracking after a no-ball; no bowler over-limit enforcement.
- A player can bat once (standard); the "next batter" list is the yet-to-bat XI.
