'use strict';

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

const state = {
  token: null,
  teams: [],
  config: { overs: 6, venue: null, teamA: null, teamB: null }, // teamX = {id,name,players:[XI]}
  xiSide: 'A',        // which team we're picking
  squad: null,        // full squad during XI pick
  selected: new Set(),
  matchId: null,
  match: null,        // latest full match state from the server
  extra: null,        // currently toggled extra
  wicketType: 'bowled',
};

async function api(pathname, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (state.token) opts.headers.Authorization = 'Bearer ' + state.token;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(pathname, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('screen-' + id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setErr(id, msg) { $(id).textContent = msg || ''; }

// ---------------------------------------------------------------------------
// 1. LOGIN
// ---------------------------------------------------------------------------
$('loginBtn').onclick = async () => {
  setErr('loginErr', '');
  try {
    const { token } = await api('/api/login', 'POST', {
      username: $('loginUser').value.trim() || 'admin',
      password: $('loginPass').value || 'cricket123',
    });
    state.token = token;
    await loadTeams();
    showScreen('setup');
  } catch (e) { setErr('loginErr', e.message); }
};
$('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

async function loadTeams() {
  state.teams = await api('/api/teams');
  const opts = state.teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  $('teamA').innerHTML = opts;
  $('teamB').innerHTML = opts;
  if (state.teams[1]) $('teamB').value = state.teams[1].id;
}

// ---------------------------------------------------------------------------
// 2. SETUP -> pick XI
// ---------------------------------------------------------------------------
$('toXiBtn').onclick = async () => {
  setErr('setupErr', '');
  const aId = $('teamA').value, bId = $('teamB').value;
  const overs = parseInt($('overs').value, 10);
  if (aId === bId) return setErr('setupErr', 'Pick two different teams.');
  if (!overs || overs < 1) return setErr('setupErr', 'Enter a valid number of overs.');
  state.config.overs = overs;
  state.config.venue = ($('venue').value || '').trim() || null;
  state.config.teamA = { id: aId, name: state.teams.find((t) => t.id === aId).name, players: [] };
  state.config.teamB = { id: bId, name: state.teams.find((t) => t.id === bId).name, players: [] };
  state.xiSide = 'A';
  await openXi('A');
  showScreen('xi');
};

async function openXi(side) {
  state.xiSide = side;
  state.selected = new Set();
  const teamId = state.config['team' + side].id;
  state.squad = await api('/api/teams/' + teamId);
  $('xiTeamName').textContent = state.squad.name + '  (' + (side === 'A' ? 'Team A' : 'Team B') + ')';
  const box = $('xiPlayers'); box.innerHTML = '';
  state.squad.players.forEach((p) => {
    const row = el('div', 'player');
    row.dataset.id = p.id;
    row.innerHTML = `<span class="pname">${p.name}</span><span class="toggle"></span>`;
    row.onclick = () => toggleXi(row, p.id);
    box.appendChild(row);
  });
  updateXiCount();
  setErr('xiErr', '');
}

function toggleXi(row, id) {
  if (state.selected.has(id)) { state.selected.delete(id); row.classList.remove('on'); }
  else {
    if (state.selected.size >= 11) { setErr('xiErr', 'You already have 11. Remove one first.'); return; }
    state.selected.add(id); row.classList.add('on'); setErr('xiErr', '');
  }
  updateXiCount();
}
function updateXiCount() {
  const n = state.selected.size;
  const pill = $('xiCount');
  pill.innerHTML = `<b>${n}</b> / 11`;
  pill.classList.toggle('full', n === 11);
  $('xiNextBtn').disabled = n !== 11;
}

$('xiNextBtn').onclick = async () => {
  if (state.selected.size !== 11) return;
  const xi = state.squad.players.filter((p) => state.selected.has(p.id));
  state.config['team' + state.xiSide].players = xi;
  if (state.xiSide === 'A') { await openXi('B'); }   // now pick team B
  else { buildOverview(); showScreen('overview'); }   // both done
};

// ---------------------------------------------------------------------------
// 4. OVERVIEW
// ---------------------------------------------------------------------------
function buildOverview() {
  const { teamA, teamB, overs } = state.config;
  $('ovA').textContent = teamA.name; $('ovB').textContent = teamB.name;
  $('ovMeta').textContent = `${overs} overs per side · ${teamA.name} XI vs ${teamB.name} XI`;
  $('ovAh').textContent = teamA.name + ' XI'; $('ovBh').textContent = teamB.name + ' XI';
  const list = (players) => players.map((p, i) => `<li data-n="${i + 1}">${p.name}</li>`).join('');
  $('ovAlist').innerHTML = list(teamA.players);
  $('ovBlist').innerHTML = list(teamB.players);
}
$('backToXiBtn').onclick = () => { openXi('A').then(() => showScreen('xi')); };

$('startGameBtn').onclick = async () => {
  setErr('ovErr', '');
  try {
    const m = await api('/api/matches', 'POST', state.config);
    state.matchId = m.id; state.match = m;
    $('apiLink').href = 'live.html?id=' + m.id;
    // toss winner options
    $('tossWinner').innerHTML =
      `<option value="A">${state.config.teamA.name}</option><option value="B">${state.config.teamB.name}</option>`;
    showScreen('toss');
  } catch (e) { setErr('ovErr', e.message); }
};

// ---------------------------------------------------------------------------
// 5. TOSS
// ---------------------------------------------------------------------------
$('tossBtn').onclick = async () => {
  setErr('tossErr', '');
  try {
    state.match = await api('/api/matches/' + state.matchId + '/toss', 'POST', {
      winner: $('tossWinner').value, decision: $('tossDecision').value,
    });
    openOpeners();
  } catch (e) { setErr('tossErr', e.message); }
};

// ---------------------------------------------------------------------------
// 6. OPENERS + BOWLER
// ---------------------------------------------------------------------------
function battingSideNow() {
  const m = state.match;
  return m.innings.length === 0 ? m.battingFirst : (m.battingFirst === 'A' ? 'B' : 'A');
}
function openOpeners() {
  const m = state.match;
  const bat = battingSideNow();
  const bowl = bat === 'A' ? 'B' : 'A';
  const batTeam = m.teams[bat], bowlTeam = m.teams[bowl];
  const inNo = m.innings.length + 1;
  $('openEyebrow').textContent = (inNo === 1 ? '1st' : '2nd') + ' innings';
  $('openTitle').textContent = batTeam.name + ' batting';
  const opts = (players) => players.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  $('selStriker').innerHTML = opts(batTeam.players);
  $('selNonStriker').innerHTML = opts(batTeam.players);
  $('selNonStriker').selectedIndex = 1;
  $('selBowler').innerHTML = opts(bowlTeam.players);
  setErr('openErr', '');
  showScreen('openers');
}
$('startInningsBtn').onclick = async () => {
  setErr('openErr', '');
  const s = $('selStriker').value, ns = $('selNonStriker').value, b = $('selBowler').value;
  if (s === ns) return setErr('openErr', 'Striker and non-striker must be different.');
  try {
    state.match = await api('/api/matches/' + state.matchId + '/start-innings', 'POST',
      { strikerId: s, nonStrikerId: ns, bowlerId: b });
    showScreen('scorer');
    renderScorer();
  } catch (e) { setErr('openErr', e.message); }
};

// ---------------------------------------------------------------------------
// 7. SCORER
// ---------------------------------------------------------------------------
// extras toggles
document.querySelectorAll('#extrasRow .chip').forEach((chip) => {
  chip.onclick = () => {
    const x = chip.dataset.x;
    if (state.extra === x) { state.extra = null; chip.classList.remove('on'); }
    else {
      state.extra = x;
      document.querySelectorAll('#extrasRow .chip').forEach((c) => c.classList.toggle('on', c === chip));
    }
  };
});
// run buttons
document.querySelectorAll('.runbtn').forEach((b) => {
  b.onclick = () => sendBall({ runs: parseInt(b.dataset.r, 10), extra: state.extra });
});
$('undoBtn').onclick = async () => {
  setErr('scoreErr', '');
  try { state.match = await api('/api/matches/' + state.matchId + '/undo', 'POST', {}); afterBall(); }
  catch (e) { setErr('scoreErr', e.message); }
};

async function sendBall(ball) {
  setErr('scoreErr', '');
  try {
    state.match = await api('/api/matches/' + state.matchId + '/ball', 'POST', ball);
    clearExtra();
    afterBall();
  } catch (e) { setErr('scoreErr', e.message); }
}
function clearExtra() {
  state.extra = null;
  document.querySelectorAll('#extrasRow .chip').forEach((c) => c.classList.remove('on'));
}

// Wicket flow
$('wktBtn').onclick = () => { state.wicketType = 'bowled'; syncWicketTypes(); openModal('modalWicket'); };
document.querySelectorAll('#wicketTypes .chip').forEach((c) => {
  c.onclick = () => { state.wicketType = c.dataset.w; syncWicketTypes(); };
});
function syncWicketTypes() {
  document.querySelectorAll('#wicketTypes .chip').forEach((c) => c.classList.toggle('on', c.dataset.w === state.wicketType));
}
$('cancelWkt').onclick = () => closeModal('modalWicket');
$('confirmWkt').onclick = async () => {
  closeModal('modalWicket');
  await sendBall({ runs: 0, extra: null, wicket: { type: state.wicketType } });
};

async function undoAndReeval(closeId) {
  try {
    state.match = await api('/api/matches/' + state.matchId + '/undo', 'POST', {});
    if (closeId) closeModal(closeId);
    afterBall();
  } catch (e) { alert(e.message); }
}

function afterBall() {
  renderScorer();
  const m = state.match;
  if (m.status === 'complete') return showResult();
  if (m.status === 'innings_break') return showInningsBreak();
  if (m.needNewBatter) return showBatterModal();
  if (m.needNewBowler) return showBowlerModal();
}

function curInn() { return state.match.innings[state.match.currentInnings]; }

function renderScorer() {
  const m = state.match, inn = curInn();
  const striker = inn.batters[inn.strikerId], nonStriker = inn.batters[inn.nonStrikerId];
  const bowler = inn.bowlers[inn.bowlerId];

  $('sbTeam').textContent = inn.battingTeamName;
  $('sbInn').textContent = (inn.number === 1 ? '1st' : '2nd') + ' innings';
  $('sbRuns').textContent = inn.runs;
  $('sbWkts').textContent = inn.wickets;
  $('sbOvers').textContent = oversText(inn.legalBalls);
  $('sbTotalOv').textContent = m.overs;
  const crr = inn.legalBalls ? (inn.runs / (inn.legalBalls / 6)) : 0;
  $('sbCRR').textContent = crr.toFixed(2);
  $('sbBowler').textContent = bowler ? bowler.name : '—';
  $('sbCode').textContent = m.id;

  // target line (2nd innings)
  const tEl = $('sbTarget');
  if (inn.target != null) {
    const need = Math.max(0, inn.target - inn.runs);
    const balls = m.overs * 6 - inn.legalBalls;
    tEl.style.display = 'block';
    tEl.innerHTML = `Target <b>${inn.target}</b> — need <b>${need}</b> off <b>${balls}</b> ball${balls === 1 ? '' : 's'}`;
  } else tEl.style.display = 'none';

  // batters
  $('stkName').textContent = striker.name;
  $('stkFig').textContent = `${striker.runs} (${striker.balls})`;
  $('nonName').textContent = nonStriker.name;
  $('nonFig').textContent = `${nonStriker.runs} (${nonStriker.balls})`;

  // over tape
  const tape = $('overTape');
  tape.querySelectorAll('.pip').forEach((p) => p.remove());
  currentOverBalls(inn).forEach((b) => tape.appendChild(pip(b)));
}

function pip(b) {
  const p = el('div', 'pip');
  const legal = !(b.extra === 'wide' || b.extra === 'noball');
  let label;
  if (b.extra === 'wide') { label = b.runs ? (b.runs + 1) + 'wd' : 'wd'; p.classList.add('extra'); }
  else if (b.extra === 'noball') { label = b.runs ? b.runs + 'nb' : 'nb'; p.classList.add('extra'); }
  else if (b.wicket) { label = 'W'; p.classList.add('wkt'); }
  else if (b.extra === 'bye') { label = b.runs + 'b'; p.classList.add('extra'); }
  else if (b.extra === 'legbye') { label = b.runs + 'lb'; p.classList.add('extra'); }
  else { label = String(b.runs); if (b.runs === 0) p.classList.add('dot'); if (b.runs === 4) p.classList.add('four'); if (b.runs === 6) p.classList.add('six'); }
  void legal;
  p.textContent = label;
  return p;
}

function currentOverBalls(inn) {
  const t = inn.timeline; let legal = 0, boundary = 0;
  for (let i = 0; i < t.length; i++) {
    const counts = !(t[i].extra === 'wide' || t[i].extra === 'noball');
    if (counts) { legal++; if (legal % 6 === 0) boundary = i + 1; }
  }
  return t.slice(boundary);
}
function oversText(b) { return Math.floor(b / 6) + '.' + (b % 6); }

// ---- Modals ----
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

// ---------------------------------------------------------------------------
// APIs reference popup
// ---------------------------------------------------------------------------
const API_ENDPOINTS = [
  ['Auth', [
    ['POST', '/api/login', 'Get a bearer token. Body: <b>{ username, password }</b>', false],
  ]],
  ['Teams (public)', [
    ['GET', '/api/teams', 'List all teams.', true],
    ['GET', '/api/teams/:id', 'Squad for one team.', true],
  ]],
  ['Scoring (needs Bearer token)', [
    ['POST', '/api/matches', 'Create a match. Body: <b>{ overs, venue?, teamA, teamB }</b>', false],
    ['POST', '/api/matches/:id/toss', 'Body: <b>{ winner, decision }</b>', false],
    ['POST', '/api/matches/:id/start-innings', 'Body: <b>{ strikerId, nonStrikerId, bowlerId }</b>', false],
    ['POST', '/api/matches/:id/ball', 'Record a ball. Body: <b>{ runs, extra, wicket }</b>', false],
    ['POST', '/api/matches/:id/next-batter', 'Body: <b>{ batterId }</b>', false],
    ['POST', '/api/matches/:id/bowler', 'Body: <b>{ bowlerId }</b>', false],
    ['POST', '/api/matches/:id/second-innings', 'Open second-innings setup.', false],
    ['POST', '/api/matches/:id/undo', 'Undo the last ball.', false],
  ]],
  ['Live data (public — consume these)', [
    ['GET', '/api/matches', 'List match summaries.', true],
    ['GET', '/api/matches/:id', 'Full match state (timeline, cards, fall of wickets).', true],
    ['GET', '/api/matches/:id/score', 'Compact live score + flat <b>features</b> block.', true],
    ['SSE', '/api/matches/:id/stream', 'Realtime score pushed on every ball (Server-Sent Events).', true],
  ]],
];

function copyText(text, btn) {
  const done = () => { if (btn) { const t = btn.textContent; btn.textContent = 'Copied'; btn.classList.add('ok'); setTimeout(() => { btn.textContent = t; btn.classList.remove('ok'); }, 1200); } };
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done)); }
  else fallbackCopy(text, done);
}
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta); cb && cb();
}

function showApisModal() {
  const origin = location.origin;
  const id = state.matchId;
  $('apiBase').innerHTML = `<span class="lbl">Base URL</span><code>${origin}</code>`
    + (id ? `<span class="lbl">Match ID</span><code>${id}</code>` : `<span class="lbl">Match ID</span><code>&lt;none yet&gt;</code>`);

  const list = $('apiList'); list.innerHTML = '';
  API_ENDPOINTS.forEach(([group, rows]) => {
    const h = el('div', 'api-group', group); list.appendChild(h);
    rows.forEach(([method, path, desc, pub]) => {
      const shownPath = id ? path.replace(':id', id) : path;
      const fullUrl = origin + shownPath;
      const item = el('div', 'api-item');
      const badge = el('div', 'api-method ' + method.toLowerCase(), method);
      const main = el('div', 'api-main');
      main.innerHTML = `<div class="api-path">${shownPath}</div><div class="api-desc">${desc}</div>`;
      const copy = el('button', 'api-copy', 'Copy URL');
      copy.onclick = () => copyText(fullUrl, copy);
      item.appendChild(badge); item.appendChild(main); item.appendChild(copy);
      list.appendChild(item);
    });
  });
  openModal('modalApis');
}

$('apiBtn').onclick = showApisModal;
$('apiClose').onclick = () => closeModal('modalApis');
$('modalApis').addEventListener('click', (e) => { if (e.target === $('modalApis')) closeModal('modalApis'); });

function showBatterModal() {
  const m = state.match, inn = curInn();
  const batTeam = m.teams[inn.battingSide];
  const box = $('batterPicks'); box.innerHTML = '';
  inn.yetToBat.forEach((id) => {
    const p = batTeam.players.find((x) => x.id === id);
    const row = el('div', 'pick'); row.innerHTML = `<span>${p.name}</span><span class="eyebrow">in</span>`;
    row.onclick = async () => {
      try {
        state.match = await api('/api/matches/' + m.id + '/next-batter', 'POST', { batterId: id });
        closeModal('modalBatter'); renderScorer();
        if (state.match.needNewBowler) showBowlerModal();
      } catch (e) { alert(e.message); }
    };
    box.appendChild(row);
  });
  const undo = el('div', 'pick', 'Mis-tapped? Undo last ball');
  undo.style.justifyContent = 'center'; undo.style.color = 'var(--ball)';
  undo.onclick = () => undoAndReeval('modalBatter');
  box.appendChild(undo);
  openModal('modalBatter');
}

function showBowlerModal() {
  const m = state.match, inn = curInn();
  const bowlTeam = m.teams[inn.bowlingSide];
  const box = $('bowlerPicks'); box.innerHTML = '';
  bowlTeam.players.forEach((p) => {
    const row = el('div', 'pick');
    const prev = inn.bowlers[p.id];
    const fig = prev ? `${oversText(prev.balls)}-${prev.runs}-${prev.wickets}` : 'new';
    row.innerHTML = `<span>${p.name}</span><span class="eyebrow mono">${fig}</span>`;
    if (p.id === inn.bowlerId) { row.classList.add('disabled'); }
    else row.onclick = async () => {
      try {
        state.match = await api('/api/matches/' + m.id + '/bowler', 'POST', { bowlerId: p.id });
        closeModal('modalBowler'); renderScorer();
      } catch (e) { alert(e.message); }
    };
    box.appendChild(row);
  });
  const undo = el('div', 'pick', 'Mis-tapped? Undo last ball');
  undo.style.justifyContent = 'center'; undo.style.color = 'var(--ball)';
  undo.onclick = () => undoAndReeval('modalBowler');
  box.appendChild(undo);
  openModal('modalBowler');
}

function showInningsBreak() {
  const first = state.match.innings[0];
  $('brkTitle').textContent = first.battingTeamName + ' finished on ' + first.runs + '/' + first.wickets;
  $('brkLine').textContent = 'Target for ' + otherTeamName() + ': ' + (first.runs + 1) + ' runs from ' + state.match.overs + ' overs.';
  openModal('modalInnings');
}
function otherTeamName() {
  const first = state.match.innings[0];
  const otherSide = first.battingSide === 'A' ? 'B' : 'A';
  return state.match.teams[otherSide].name;
}
$('toSecondBtn').onclick = async () => {
  try {
    state.match = await api('/api/matches/' + state.matchId + '/second-innings', 'POST', {});
    closeModal('modalInnings');
    openOpeners();
  } catch (e) { alert(e.message); }
};

// ---- Result overlay (built on the fly) ----
function showResult() {
  const m = state.match, r = m.result;
  const i1 = m.innings[0], i2 = m.innings[1];
  let bg = $('modalResult');
  if (!bg) {
    bg = el('div', 'modal-bg'); bg.id = 'modalResult';
    bg.innerHTML = `<div class="modal"><div class="result-hero">
      <div class="trophy">🏆</div><div class="win" id="resWin"></div><div class="sumline" id="resSum"></div>
      <div class="scorecard-mini" id="resCards"></div></div>
      <a class="btn gold" id="resLive">Open live scoreboard</a>
      <button class="btn ghost" id="resNew" style="margin-top:8px">Score another match</button></div>`;
    document.body.appendChild(bg);
    bg.querySelector('#resNew').onclick = () => location.reload();
  }
  bg.querySelector('#resWin').textContent = r.marginType === 'tie' ? 'Match tied' : r.winnerName + ' win';
  bg.querySelector('#resSum').textContent = r.text;
  bg.querySelector('#resLive').href = 'live.html?id=' + m.id;
  bg.querySelector('#resCards').innerHTML =
    `<div><div class="t">${i1.battingTeamName}</div><div class="s">${i1.runs}/${i1.wickets}</div></div>
     <div><div class="t">${i2.battingTeamName}</div><div class="s">${i2.runs}/${i2.wickets}</div></div>`;
  bg.classList.add('show');
}
