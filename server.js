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

// -------------------------------------------------------------------------
// In-memory match store, persisted to disk on every change
// -------------------------------------------------------------------------
const matches = new Map();
const tokens = new Set();
const streams = new Map(); // matchId -> Set(res) for Server-Sent Events

loadMatchesFromDisk();

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
  if (token && tokens.has(token)) return next();
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
    const token = crypto.randomBytes(24).toString('hex');
    tokens.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid username or password' });
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

// Create match: { overs, teamA:{id,name,players[11]}, teamB:{...} }
app.post('/api/matches', requireAuth, wrap((req, res) => {
  const m = E.createMatch(req.body);
  saveMatch(m);
  res.status(201).json(m);
}));

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

// List all matches (summary)
app.get('/api/matches', wrap((req, res) => {
  const all = [...matches.values()].map((m) => ({
    id: m.id, status: m.status, overs: m.overs,
    teams: { A: m.teams.A.name, B: m.teams.B.name },
    result: m.result, updatedAt: m.updatedAt,
  }));
  res.json(all);
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
