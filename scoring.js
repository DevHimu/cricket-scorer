'use strict';

/**
 * Cricket scoring engine.
 * This module is the single source of truth for match state. The web UI only
 * sends "ball events"; every rule (strike rotation, over change, wide / no-ball,
 * innings end, result) is applied here so the API always reflects correct data.
 */

const XI_SIZE = 11;                 // players per side
const MAX_WICKETS = XI_SIZE - 1;    // 10

function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function oversText(legalBalls) {
  return `${Math.floor(legalBalls / 6)}.${legalBalls % 6}`;
}

// ---------------------------------------------------------------------------
// Match creation
// ---------------------------------------------------------------------------

/**
 * config = {
 *   overs: Number,
 *   teamA: { id, name, players:[{id,name}] },   // full playing XI (11)
 *   teamB: { id, name, players:[{id,name}] },
 * }
 */
function createMatch(config) {
  if (!config.teamA || !config.teamB) throw new Error('Both teams are required');
  if (config.teamA.players.length !== XI_SIZE) throw new Error('Team A must have exactly 11 players');
  if (config.teamB.players.length !== XI_SIZE) throw new Error('Team B must have exactly 11 players');
  if (!config.overs || config.overs < 1) throw new Error('Overs must be at least 1');

  return {
    id: uid('m'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    status: 'toss',                 // toss -> live -> innings_break -> live -> complete
    overs: Number(config.overs),
    venue: config.venue ? String(config.venue).trim() : null,
    league: config.league ? String(config.league).trim() : null,
    teams: { A: config.teamA, B: config.teamB },
    toss: null,                     // { winner:'A'|'B', decision:'bat'|'bowl' }
    battingFirst: null,             // 'A' | 'B'
    currentInnings: 0,              // index into innings[]
    innings: [],
    needNewBatter: false,
    needNewBowler: false,
    result: null,
    history: [],                    // snapshots for undo (kept out of API payload)
  };
}

// ---------------------------------------------------------------------------
// Toss
// ---------------------------------------------------------------------------

function applyToss(match, { winner, decision }) {
  if (match.status !== 'toss') throw new Error('Toss already done');
  if (!['A', 'B'].includes(winner)) throw new Error('winner must be A or B');
  if (!['bat', 'bowl'].includes(decision)) throw new Error('decision must be bat or bowl');

  match.toss = { winner, decision };
  const other = winner === 'A' ? 'B' : 'A';
  match.battingFirst = decision === 'bat' ? winner : other;
  match.status = 'innings_setup';
  touch(match);
  return match;
}

// ---------------------------------------------------------------------------
// Start an innings (openers + first bowler)
// ---------------------------------------------------------------------------

function startInnings(match, { strikerId, nonStrikerId, bowlerId }) {
  if (!['innings_setup'].includes(match.status)) throw new Error('Not ready to start an innings');

  const isFirst = match.innings.length === 0;
  const battingSide = isFirst ? match.battingFirst : (match.battingFirst === 'A' ? 'B' : 'A');
  const bowlingSide = battingSide === 'A' ? 'B' : 'A';

  const batTeam = match.teams[battingSide];
  const bowlTeam = match.teams[bowlingSide];

  const striker = findPlayer(batTeam, strikerId);
  const nonStriker = findPlayer(batTeam, nonStrikerId);
  const bowler = findPlayer(bowlTeam, bowlerId);
  if (!striker || !nonStriker) throw new Error('Both opening batters must be from the batting team');
  if (striker.id === nonStriker.id) throw new Error('Striker and non-striker must be different');
  if (!bowler) throw new Error('Bowler must be from the bowling team');

  const inn = {
    number: match.innings.length + 1,
    battingSide,
    bowlingSide,
    battingTeamName: batTeam.name,
    bowlingTeamName: bowlTeam.name,
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    extras: { wides: 0, noballs: 0, byes: 0, legbyes: 0, total: 0 },
    target: match.innings.length === 1 ? match.innings[0].runs + 1 : null,
    strikerId: striker.id,
    nonStrikerId: nonStriker.id,
    bowlerId: bowler.id,
    batters: {},   // id -> { id,name,runs,balls,fours,sixes,out,howOut }
    bowlers: {},   // id -> { id,name,balls,runs,wickets,maidens }
    battingOrder: batTeam.players.map((p) => p.id), // for "next batter" list
    yetToBat: batTeam.players.map((p) => p.id).filter((id) => id !== striker.id && id !== nonStriker.id),
    timeline: [],
    fallOfWickets: [],
    closed: false,
  };
  ensureBatter(inn, batTeam, striker.id);
  ensureBatter(inn, batTeam, nonStriker.id);
  ensureBowler(inn, bowlTeam, bowler.id);

  match.innings.push(inn);
  match.currentInnings = match.innings.length - 1;
  match.status = 'live';
  match.needNewBatter = false;
  match.needNewBowler = false;
  touch(match);
  return match;
}

// ---------------------------------------------------------------------------
// Record one delivery
// ---------------------------------------------------------------------------

/**
 * ball = {
 *   runs: Number,                          // runs scored/run on the delivery (0-6)
 *   extra: null|'wide'|'noball'|'bye'|'legbye',
 *   wicket: null | { type?:String, batterOutId?:String }   // batterOut defaults to striker
 * }
 * After a wicket you must call setNextBatter() before the next ball.
 * After an over ends you must call setBowler() before the next ball.
 */
function applyBall(match, ball) {
  const inn = current(match);
  if (match.status !== 'live') throw new Error('No live innings');
  if (inn.closed) throw new Error('Innings is closed');
  if (match.needNewBatter) throw new Error('Select the next batter first');
  if (match.needNewBowler) throw new Error('Select the next bowler first');

  snapshot(match);

  const runs = Math.max(0, Number(ball.runs) || 0);
  const extra = ball.extra || null;
  const wicket = ball.wicket || null;

  const striker = inn.batters[inn.strikerId];
  const bowler = inn.bowlers[inn.bowlerId];

  let ballCounts = true;    // does it count towards the over?
  let batterFaced = true;   // does the striker get a ball on their card?
  let runsToBatter = 0;     // runs credited to the striker
  let bowlerConceded = 0;   // runs charged to the bowler
  let runsRunPhysically = 0;// used to decide strike crossing
  let teamRuns = 0;

  switch (extra) {
    case 'wide':
      ballCounts = false; batterFaced = false;
      teamRuns = 1 + runs;                 // 1 penalty + any extra wides run
      bowlerConceded = 1 + runs;
      runsRunPhysically = runs;            // the physically-run extras
      inn.extras.wides += 1 + runs;
      break;
    case 'noball':
      ballCounts = false; batterFaced = true;
      runsToBatter = runs;                 // runs off the bat on a no-ball
      teamRuns = 1 + runs;
      bowlerConceded = 1 + runs;
      runsRunPhysically = runs;
      inn.extras.noballs += 1;
      break;
    case 'bye':
      ballCounts = true; batterFaced = true;
      teamRuns = runs; bowlerConceded = 0; // byes are not charged to the bowler
      runsRunPhysically = runs;
      inn.extras.byes += runs;
      break;
    case 'legbye':
      ballCounts = true; batterFaced = true;
      teamRuns = runs; bowlerConceded = 0;
      runsRunPhysically = runs;
      inn.extras.legbyes += runs;
      break;
    default: // normal delivery
      ballCounts = true; batterFaced = true;
      runsToBatter = runs; teamRuns = runs; bowlerConceded = runs;
      runsRunPhysically = runs;
  }
  inn.extras.total = inn.extras.wides + inn.extras.noballs + inn.extras.byes + inn.extras.legbyes;

  // Apply team + player stats
  inn.runs += teamRuns;
  if (batterFaced) striker.balls += 1;
  striker.runs += runsToBatter;
  if (extra === null && runsToBatter === 4) striker.fours += 1;
  if (extra === null && runsToBatter === 6) striker.sixes += 1;
  bowler.runs += bowlerConceded;

  // Wicket
  let wicketFell = false;
  if (wicket) {
    const outId = wicket.batterOutId || inn.strikerId;
    const outBatter = inn.batters[outId];
    if (outBatter && !outBatter.out) {
      outBatter.out = true;
      outBatter.howOut = wicket.type || 'out';
      inn.wickets += 1;
      wicketFell = true;
      const bowlerCredited = !['run out', 'retired', 'runout'].includes((wicket.type || '').toLowerCase());
      if (bowlerCredited) bowler.wickets += 1;
      inn.fallOfWickets.push({
        wicket: inn.wickets, runs: inn.runs, over: oversText(inn.legalBalls + (ballCounts ? 1 : 0)),
        batterOutId: outId, batterOutName: outBatter.name,
      });
    }
  }

  // Strike rotation from running (odd runs cross)
  if (runsRunPhysically % 2 === 1) swapStrike(inn);

  // Legal-ball bookkeeping
  if (ballCounts) {
    inn.legalBalls += 1;
    bowler.balls += 1;
  }

  inn.timeline.push({
    seq: inn.timeline.length + 1,
    over: oversText(inn.legalBalls),
    extra, runs, teamRuns, wicket: wicketFell ? (wicket.type || 'out') : null,
    strikerId: inn.strikerId, bowlerId: inn.bowlerId,
    ts: new Date().toISOString(),
  });

  // Over complete?
  const overComplete = ballCounts && inn.legalBalls % 6 === 0;
  if (overComplete) {
    swapStrike(inn);          // ends of over: batters cross
    match.needNewBowler = true;
  }

  // If a wicket fell and innings isn't over, we need a new batter
  if (wicketFell) match.needNewBatter = true;

  // Innings-ending conditions
  maybeEndInnings(match);

  touch(match);
  return match;
}

function maybeEndInnings(match) {
  const inn = current(match);
  if (inn.closed) return;

  const allOut = inn.wickets >= MAX_WICKETS;
  const oversDone = inn.legalBalls >= match.overs * 6;
  const chaseComplete = inn.target != null && inn.runs >= inn.target;

  if (allOut || oversDone || chaseComplete) {
    inn.closed = true;
    match.needNewBatter = false;
    match.needNewBowler = false;

    if (match.innings.length === 1) {
      match.status = 'innings_break';   // wait to start 2nd innings
    } else {
      match.status = 'complete';
      match.result = computeResult(match);
      match.completedAt = new Date().toISOString();
    }
  }
}

// ---------------------------------------------------------------------------
// After a wicket: bring in the next batter
// ---------------------------------------------------------------------------

function setNextBatter(match, batterId) {
  if (!match.needNewBatter) throw new Error('No batter is required right now');
  const inn = current(match);
  const batTeam = match.teams[inn.battingSide];
  const player = findPlayer(batTeam, batterId);
  if (!player) throw new Error('Batter must be from the batting team');
  if (inn.batters[batterId] && inn.batters[batterId].out) throw new Error('That batter is already out');
  if (batterId === inn.nonStrikerId) throw new Error('That batter is already at the crease');

  ensureBatter(inn, batTeam, batterId);
  // Replace the dismissed batter at whichever end they were standing.
  // (After an end-of-over dismissal the batters have already crossed, so the
  //  out batter may be at the non-striker's end and the new batter waits there.)
  if (inn.batters[inn.strikerId] && inn.batters[inn.strikerId].out) inn.strikerId = batterId;
  else if (inn.batters[inn.nonStrikerId] && inn.batters[inn.nonStrikerId].out) inn.nonStrikerId = batterId;
  else inn.strikerId = batterId;
  inn.yetToBat = inn.yetToBat.filter((id) => id !== batterId);
  match.needNewBatter = false;
  touch(match);
  return match;
}

// ---------------------------------------------------------------------------
// After an over: set the next bowler
// ---------------------------------------------------------------------------

function setBowler(match, bowlerId) {
  if (!match.needNewBowler) throw new Error('No bowler change is required right now');
  const inn = current(match);
  const bowlTeam = match.teams[inn.bowlingSide];
  const bowler = findPlayer(bowlTeam, bowlerId);
  if (!bowler) throw new Error('Bowler must be from the bowling team');
  if (bowlerId === inn.bowlerId) throw new Error('A bowler cannot bowl two overs in a row');

  ensureBowler(inn, bowlTeam, bowlerId);
  inn.bowlerId = bowlerId;
  match.needNewBowler = false;
  touch(match);
  return match;
}

// ---------------------------------------------------------------------------
// Start the second innings
// ---------------------------------------------------------------------------

function startSecondInnings(match) {
  if (match.status !== 'innings_break') throw new Error('Not at the innings break');
  match.status = 'innings_setup';
  touch(match);
  return match;
}

// ---------------------------------------------------------------------------
// Undo the last ball
// ---------------------------------------------------------------------------

function undo(match) {
  if (!match.history || match.history.length === 0) throw new Error('Nothing to undo');
  const prev = match.history.pop();
  const keepHistory = match.history;
  Object.keys(match).forEach((k) => delete match[k]);
  Object.assign(match, prev);
  match.history = keepHistory;
  touch(match);
  return match;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function computeResult(match) {
  const first = match.innings[0];
  const second = match.innings[1];
  const firstScore = first.runs;
  const secondScore = second.runs;

  if (secondScore > firstScore) {
    const wicketsInHand = MAX_WICKETS - second.wickets;
    return {
      winnerSide: second.battingSide,
      winnerName: second.battingTeamName,
      margin: wicketsInHand,
      marginType: 'wickets',
      text: `${second.battingTeamName} won by ${wicketsInHand} wicket${wicketsInHand === 1 ? '' : 's'}`,
    };
  }
  if (secondScore < firstScore) {
    const diff = firstScore - secondScore;
    return {
      winnerSide: first.battingSide,
      winnerName: first.battingTeamName,
      margin: diff,
      marginType: 'runs',
      text: `${first.battingTeamName} won by ${diff} run${diff === 1 ? '' : 's'}`,
    };
  }
  return { winnerSide: null, winnerName: null, margin: 0, marginType: 'tie', text: 'Match tied' };
}

// ---------------------------------------------------------------------------
// Public "live score" projection — the compact shape API consumers read
// ---------------------------------------------------------------------------

function liveScore(match) {
  const inn = match.innings[match.currentInnings];
  const base = {
    id: match.id,
    status: match.status,
    category: match.status === 'complete' ? 'played' : 'live',
    overs: match.overs,
    venue: match.venue || null,
    league: match.league || null,
    teams: { A: match.teams.A.name, B: match.teams.B.name },
    battingFirst: match.battingFirst,
    result: match.result,
    updatedAt: match.updatedAt,
  };
  if (!inn) return base;

  const striker = inn.batters[inn.strikerId];
  const nonStriker = inn.batters[inn.nonStrikerId];
  const bowler = inn.bowlers[inn.bowlerId];
  const rr = inn.legalBalls > 0 ? (inn.runs / (inn.legalBalls / 6)) : 0;

  const thisOver = inn.timeline
    .filter((b) => Math.floor((prevLegalBalls(inn, b)) / 6) === Math.floor((inn.legalBalls - 1) / 6))
    .slice(-6);

  return {
    ...base,
    innings: inn.number,
    batting: inn.battingTeamName,
    bowling: inn.bowlingTeamName,
    score: `${inn.runs}/${inn.wickets}`,
    runs: inn.runs,
    wickets: inn.wickets,
    oversBowled: oversText(inn.legalBalls),
    target: inn.target,
    runRate: Number(rr.toFixed(2)),
    required: inn.target != null
      ? { runs: Math.max(0, inn.target - inn.runs), balls: match.overs * 6 - inn.legalBalls }
      : null,
    extras: inn.extras,
    striker: striker && { id: striker.id, name: striker.name, runs: striker.runs, balls: striker.balls, onStrike: true },
    nonStriker: nonStriker && { id: nonStriker.id, name: nonStriker.name, runs: nonStriker.runs, balls: nonStriker.balls, onStrike: false },
    bowler: bowler && { id: bowler.id, name: bowler.name, overs: oversText(bowler.balls), runs: bowler.runs, wickets: bowler.wickets },
    ballsBowled: inn.legalBalls,
    ballsRemaining: Math.max(0, match.overs * 6 - inn.legalBalls),
    oversCompleted: oversText(inn.legalBalls),
    wicketsRemaining: MAX_WICKETS - inn.wickets,
    // Flat, model-ready feature vector — maps 1:1 to the training parameters.
    features: {
      battingTeam: inn.battingTeamName,
      bowlingTeam: inn.bowlingTeamName,
      venue: match.venue || null,
      league: match.league || null,
      currentRuns: inn.runs,
      currentWickets: inn.wickets,
      oversCompleted: oversText(inn.legalBalls),
      ballsBowled: inn.legalBalls,
      striker: striker ? striker.name : null,
      strikerId: striker ? striker.id : null,
      strikerRuns: striker ? striker.runs : null,
      strikerBalls: striker ? striker.balls : null,
      nonStriker: nonStriker ? nonStriker.name : null,
      nonStrikerId: nonStriker ? nonStriker.id : null,
      nonStrikerRuns: nonStriker ? nonStriker.runs : null,
      nonStrikerBalls: nonStriker ? nonStriker.balls : null,
      bowler: bowler ? bowler.name : null,
      bowlerId: bowler ? bowler.id : null,
      currentRunRate: Number(rr.toFixed(2)),
      ballsRemaining: Math.max(0, match.overs * 6 - inn.legalBalls),
      innings: inn.number,
      wicketsRemaining: MAX_WICKETS - inn.wickets,
      target: inn.target,
    },
    lastBalls: inn.timeline.slice(-6).map(ballLabel),
    needNewBatter: match.needNewBatter,
    needNewBowler: match.needNewBowler,
  };
}

function ballLabel(b) {
  if (b.extra === 'wide') return b.runs ? `${b.runs + 1}wd` : 'wd';
  if (b.extra === 'noball') return b.runs ? `${b.runs}nb` : 'nb';
  if (b.wicket) return 'W';
  if (b.extra === 'bye') return `${b.runs}b`;
  if (b.extra === 'legbye') return `${b.runs}lb`;
  return String(b.runs);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function current(match) { return match.innings[match.currentInnings]; }
function touch(match) { match.updatedAt = new Date().toISOString(); }
function swapStrike(inn) { const t = inn.strikerId; inn.strikerId = inn.nonStrikerId; inn.nonStrikerId = t; }
function findPlayer(team, id) { return team.players.find((p) => p.id === id); }

function ensureBatter(inn, team, id) {
  if (!inn.batters[id]) {
    const p = findPlayer(team, id);
    inn.batters[id] = { id, name: p.name, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, howOut: null };
  }
}
function ensureBowler(inn, team, id) {
  if (!inn.bowlers[id]) {
    const p = findPlayer(team, id);
    inn.bowlers[id] = { id, name: p.name, balls: 0, runs: 0, wickets: 0, maidens: 0 };
  }
}
function prevLegalBalls(inn, ball) {
  // approx position of a ball in the innings; good enough for "this over" grouping
  return inn.timeline.indexOf(ball);
}

function snapshot(match) {
  const clone = JSON.parse(JSON.stringify({ ...match, history: undefined }));
  delete clone.history;
  match.history = match.history || [];
  match.history.push(clone);
  if (match.history.length > 200) match.history.shift();
}

// 'live'  = created/in-progress (not yet finished)
// 'played'= completed match (has a result)
function matchCategory(match) {
  return match.status === 'complete' ? 'played' : 'live';
}

// Compact summary used for match lists (public feed + /api/matches)
function matchSummary(match) {
  const inns = (match.innings || []).map((inn) => ({
    number: inn.number,
    battingTeam: inn.battingTeamName,
    bowlingTeam: inn.bowlingTeamName,
    runs: inn.runs,
    wickets: inn.wickets,
    overs: oversText(inn.legalBalls),
  }));
  return {
    id: match.id,
    category: matchCategory(match),
    status: match.status,
    overs: match.overs,
    venue: match.venue || null,
    league: match.league || null,
    teamA: match.teams.A.name,
    teamB: match.teams.B.name,
    innings: inns,
    result: match.result ? match.result.text : null,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    completedAt: match.completedAt || null,
  };
}

module.exports = {
  XI_SIZE, MAX_WICKETS,
  createMatch, applyToss, startInnings, applyBall,
  setNextBatter, setBowler, startSecondInnings, undo,
  computeResult, liveScore, oversText,
  matchCategory, matchSummary,
};
