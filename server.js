'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./scoring');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const TEAMS_DIR = path.join(DATA_DIR, 'teams');
const MATCH_DIR = path.join(DATA_DIR, 'matches');
fs.mkdirSync(MATCH_DIR, { recursive: true });

// Simple credentials (override with env vars in production)
const AUTH_USER = process.env.SCORER_USER || 'admin';
const AUTH_PASS = process.env.SCORER_PASS || 'cricket123';

// How long a login stays valid, and how long finished matches are kept.
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 168); // 7 days
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);

// Session secret: prefer an env var (stable across restarts on Render), else a
// persisted file, else a random one. A stable secret means tokens survive a
// restart, so a scorer isn't logged out when a free instance spins down mid-match.
const SESSION_SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.session-secret');
  try { return fs.readFileSync(f, 'utf8'); }
  catch (_) {
    const s = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(f, s); } catch (_) {}
    return s;
  }
})();

function signToken(username) {
  const payload = { u: username, exp: Date.now() + SESSION_TTL_HOURS * 3600 * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) { return null; }
}

// -------------------------------------------------------------------------
// In-memory match store, persisted to disk on every change
// -------------------------------------------------------------------------
const matches = new Map();
const streams = new Map(); // matchId -> Set(res) for Server-Sent Events

loadMatchesFromDisk();
purgeExpiredMatches();
setInterval(purgeExpiredMatches, 6 * 3600 * 1000); // sweep every 6 hours

// Delete finished matches older than RETENTION_DAYS. Live matches are kept.
function purgeExpiredMatches() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  for (const [id, m] of matches) {
    if (m.status !== 'complete') continue;
    const when = Date.parse(m.completedAt || m.updatedAt || m.createdAt || 0);
    if (when && when < cutoff) {
      matches.delete(id);
      try { fs.unlinkSync(path.join(MATCH_DIR, id + '.json')); } catch (_) {}
    }
  }
}

function saveMatch(m) {
  matches.set(m.id, m);
  const copy = { ...m, history: undefined }; // don't persist the undo stack
  fs.writeFileSync(path.join(MATCH_DIR, m.id + '.json'), JSON.stringify(copy, null, 2));
  broadcast(m);
}
function loadMatchesFromDisk() {
  if (!fs.existsSync(MATCH_DIR)) return;
  for (const f of fs.readdirSync(MATCH_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, f), 'utf8'));
      m.history = [];
      matches.set(m.id, m);
    } catch (_) { /* ignore corrupt file */ }
  }
}

// -------------------------------------------------------------------------
// Realtime: Server-Sent Events
// -------------------------------------------------------------------------
function broadcast(m) {
  const set = streams.get(m.id);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(E.liveScore(m))}\n\n`;
  for (const res of set) res.write(payload);
}

// -------------------------------------------------------------------------
// Auth middleware for write endpoints
// -------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'Unauthorized. Log in and send Authorization: Bearer <token>.' });
}

const wrap = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (err) { res.status(400).json({ error: err.message }); }
};

function getMatch(id) {
  const m = matches.get(id);
  if (!m) { const e = new Error('Match not found'); e.status = 404; throw e; }
  return m;
}

// =========================================================================
// AUTH
// =========================================================================
app.post('/api/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = signToken(username);
    const payload = verifyToken(token);
    return res.json({ token, user: username, expiresAt: new Date(payload.exp).toISOString() });
  }
  res.status(401).json({ error: 'Invalid username or password' });
}));

// Check whether a stored token is still valid (used by the client on page load
// so a refresh doesn't force a re-login).
app.get('/api/session', wrap((req, res) => {
  const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ valid: false });
  res.json({ valid: true, user: payload.u, expiresAt: new Date(payload.exp).toISOString() });
}));

// =========================================================================
// TEAMS (public read)
// =========================================================================
app.get('/api/teams', wrap((req, res) => {
  const list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'teams.json'), 'utf8'));
  res.json(list);
}));

app.get('/api/teams/:id', wrap((req, res) => {
  const file = path.join(TEAMS_DIR, req.params.id + '.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Team not found' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
}));

// =========================================================================
// MATCH LIFECYCLE (write endpoints require auth)
// =========================================================================

// Create a match: POST /api/matches/create
// Body: { overs, venue?, teamA:{id,name,players[11]}, teamB:{...} }
// (Kept separate from GET /api/matches so create vs. list are unambiguous.)
const createMatchHandler = wrap((req, res) => {
  const m = E.createMatch(req.body);
  saveMatch(m);
  res.status(201).json(m);
});
app.post('/api/matches/create', requireAuth, createMatchHandler);
// Deprecated alias for older clients — use /api/matches/create instead.
app.post('/api/matches', requireAuth, createMatchHandler);

// Toss: { winner:'A'|'B', decision:'bat'|'bowl' }
app.post('/api/matches/:id/toss', requireAuth, wrap((req, res) => {
  const m = getMatch(req.params.id);
  E.applyToss(m, req.body);
  saveMatch(m);
  res.json(m);
}));

// Start an innings: { strikerId, nonStrikerId, bowlerId }
app.post('/api/matches/:id/start-innings', requireAuth, wrap((req, res) => {
  const m = getMatch(req.params.id);
  E.startInnings(m, req.body);
  saveMatch(m);
  res.json(m);
}));

// Record a ball: { runs, extra, wicket }
app.post('/api/matches/:id/ball', requireAuth, wrap((req, res) => {
  const m = getMatch(req.params.id);
  E.applyBall(m, req.body);
  saveMatch(m);
  res.json(m);
}));

// Next batter after a wicket: { batterId }
app.post('/api/matches/:id/next-batter', requireAuth, wrap((req, res) => {
  const m = getMatch(req.params.id);
  E.setNextBatter(m, req.body.batterId);
  saveMatch(m);
  res.json(m);
}));

// New bowler after an over: { bowlerId }
app.post('/api/matches/:id/bowler', requireAuth, wrap((req, res) => {
  const m = getMatch(req.params.id);
  E.setBowler(m, req.body.bowlerId);
  saveMatch(m);
  res.json(m);
}));

// Move to 2nd innings setup
app.post('/api/matches/:id/second-innings', requireAuth, wrap((req, res) => {
  const m = getMatch(req.params.id);
  E.startSecondInnings(m);
  saveMatch(m);
  res.json(m);
}));

// Undo last ball
app.post('/api/matches/:id/undo', requireAuth, wrap((req, res) => {
  const m = getMatch(req.params.id);
  E.undo(m);
  saveMatch(m);
  res.json(m);
}));

// =========================================================================
// PUBLIC READ ENDPOINTS — this is what your other project consumes
// =========================================================================

// Full raw match state
app.get('/api/matches/:id', wrap((req, res) => {
  const m = getMatch(req.params.id);
  res.json({ ...m, history: undefined });
}));

// Compact live score (recommended for consumers)
app.get('/api/matches/:id/score', wrap((req, res) => {
  const m = getMatch(req.params.id);
  res.json(E.liveScore(m));
}));

// List matches (summary). Optional ?state=live|played and ?limit=N.
// Returns { live:[...], played:[...], matches:[...] } for easy consumption.
app.get('/api/matches', wrap((req, res) => {
  const state = (req.query.state || '').toLowerCase();
  const limit = Math.max(0, Number(req.query.limit) || 0);
  let all = [...matches.values()]
    .map((m) => E.matchSummary(m))
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  if (state === 'live' || state === 'played') all = all.filter((m) => m.category === state);
  if (limit) all = all.slice(0, limit);
  res.json({
    count: all.length,
    live: all.filter((m) => m.category === 'live'),
    played: all.filter((m) => m.category === 'played'),
    matches: all,
  });
}));

// Realtime stream (Server-Sent Events). Pushes the live score on every update.
app.get('/api/matches/:id/stream', (req, res) => {
  const m = matches.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found' });
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(E.liveScore(m))}\n\n`);

  if (!streams.has(m.id)) streams.set(m.id, new Set());
  streams.get(m.id).add(res);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); streams.get(m.id)?.delete(res); });
});

// Allow cross-origin reads so external apps can consume the API
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Cricket Scorer running at http://localhost:${PORT}`);
  console.log(`Login: ${AUTH_USER} / ${AUTH_PASS}`);
});
