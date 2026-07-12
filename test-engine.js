'use strict';
const E = require('./scoring');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', msg); } }

function team(id, name) {
  return { id, name, players: Array.from({ length: 11 }, (_, i) => ({ id: `${id}${i + 1}`, name: `${name} P${i + 1}` })) };
}

// --- Build a 2-over match ------------------------------------------------
let m = E.createMatch({ overs: 2, teamA: team('a', 'Alpha'), teamB: team('b', 'Bravo') });
ok(m.status === 'toss', 'starts at toss');

E.applyToss(m, { winner: 'A', decision: 'bat' });
ok(m.battingFirst === 'A', 'A bats first after winning toss and choosing bat');
ok(m.status === 'innings_setup', 'moves to innings_setup');

E.startInnings(m, { strikerId: 'a1', nonStrikerId: 'a2', bowlerId: 'b1' });
ok(m.status === 'live', 'innings live');
let inn = m.innings[0];
ok(inn.strikerId === 'a1', 'a1 on strike');

// Ball 1: single -> strike should rotate to a2
E.applyBall(m, { runs: 1 });
ok(m.innings[0].strikerId === 'a2', 'odd run (1) rotates strike');
ok(m.innings[0].runs === 1, 'team score 1');

// Ball 2: 2 runs -> no rotation
E.applyBall(m, { runs: 2 });
ok(m.innings[0].strikerId === 'a2', 'even run (2) keeps strike');
ok(m.innings[0].runs === 3, 'team score 3');

// Ball 3: wide -> ball not counted, +1
let ballsBefore = m.innings[0].legalBalls;
E.applyBall(m, { extra: 'wide' });
ok(m.innings[0].legalBalls === ballsBefore, 'wide does not count as a ball');
ok(m.innings[0].runs === 4, 'wide adds 1 run');

// Ball 3 (retry): no-ball with 4 off the bat -> +1 penalty +4 batter, no ball counted
E.applyBall(m, { extra: 'noball', runs: 4 });
ok(m.innings[0].runs === 9, 'no-ball + 4 adds 5 runs');
ok(m.innings[0].legalBalls === ballsBefore, 'no-ball does not count as a ball');
ok(m.innings[0].batters['a2'].runs === 6, 'batter credited 4 off no-ball (had 2 already = 6)');

// Legal ball 3: 4 runs
E.applyBall(m, { runs: 4 });
ok(m.innings[0].legalBalls === 3, 'legal ball counted (3 legal balls)');

// Legal ball 4: wicket, striker out
E.applyBall(m, { runs: 0, wicket: { type: 'bowled' } });
ok(m.innings[0].wickets === 1, 'wicket recorded');
ok(m.needNewBatter === true, 'needs new batter after wicket');
E.setNextBatter(m, 'a3');
ok(m.innings[0].strikerId === 'a3', 'new batter takes strike');

// Legal balls 5 & 6: two dot balls to finish the over
E.applyBall(m, { runs: 0 });
E.applyBall(m, { runs: 0 });
ok(m.innings[0].legalBalls === 6, 'over complete at 6 legal balls');
ok(m.needNewBowler === true, 'needs new bowler after over');
// end-of-over swap: striker was a3 at ball5 start... after 6th ball, batters cross
E.setBowler(m, 'b2');
ok(m.needNewBowler === false, 'bowler set');
ok(m.innings[0].bowlerId === 'b2', 'new bowler is b2');

// Finish the 2nd over quickly with singles/dots to reach overs limit
E.applyBall(m, { runs: 6 });
E.applyBall(m, { runs: 0 });
E.applyBall(m, { runs: 0 });
E.applyBall(m, { runs: 0 });
E.applyBall(m, { runs: 0 });
E.applyBall(m, { runs: 0 });
ok(m.innings[0].closed === true, 'first innings closed after 2 overs');
ok(m.status === 'innings_break', 'match at innings break');
const target = m.innings[0].runs + 1;

// --- Second innings ------------------------------------------------------
E.startSecondInnings(m);
ok(m.status === 'innings_setup', 'ready to set up 2nd innings');
E.startInnings(m, { strikerId: 'b1', nonStrikerId: 'b2', bowlerId: 'a1' });
ok(m.innings[1].target === target, '2nd innings target set correctly');
ok(m.innings[1].battingTeamName === 'Bravo', 'Bravo bats second');

// Chase: smash enough to win
let guard = 0;
while (m.status === 'live' && guard < 50) {
  E.applyBall(m, { runs: 6 });
  if (m.needNewBowler) E.setBowler(m, m.innings[1].bowlerId === 'a1' ? 'a2' : 'a1');
  if (m.needNewBatter) {
    const next = m.innings[1].yetToBat[0];
    if (next) E.setNextBatter(m, next); else break;
  }
  guard++;
}
ok(m.status === 'complete', 'match completes');
ok(m.result && m.result.winnerName === 'Bravo', 'Bravo wins the chase');
ok(m.result.marginType === 'wickets', 'win margin expressed in wickets');
console.log('  result:', m.result.text);

// --- Undo test -----------------------------------------------------------
let m2 = E.createMatch({ overs: 5, teamA: team('a', 'Alpha'), teamB: team('b', 'Bravo') });
E.applyToss(m2, { winner: 'B', decision: 'bowl' });
ok(m2.battingFirst === 'A', 'if toss winner bowls, other team bats first');
E.startInnings(m2, { strikerId: 'a1', nonStrikerId: 'a2', bowlerId: 'b1' });
E.applyBall(m2, { runs: 4 });
ok(m2.innings[0].runs === 4, 'runs before undo');
E.undo(m2);
ok(m2.innings[0].runs === 0, 'undo reverts the ball');

// --- Wicket on last ball of over: new batter must go to the non-striker end ---
let m3 = E.createMatch({ overs: 3, teamA: team('a', 'Alpha'), teamB: team('b', 'Bravo') });
E.applyToss(m3, { winner: 'A', decision: 'bat' });
E.startInnings(m3, { strikerId: 'a1', nonStrikerId: 'a2', bowlerId: 'b1' });
// 5 dot balls, then striker out on 6th (last) ball
for (let i = 0; i < 5; i++) E.applyBall(m3, { runs: 0 });
ok(m3.innings[0].strikerId === 'a1', 'a1 still on strike before last ball');
E.applyBall(m3, { runs: 0, wicket: { type: 'bowled' } }); // a1 (striker) out on ball 6
ok(m3.innings[0].wickets === 1, 'wicket on last ball recorded');
ok(m3.needNewBowler === true, 'over complete needs bowler');
ok(m3.needNewBatter === true, 'needs new batter');
// after end-of-over cross, a2 is now the striker; the out slot is the non-striker end
E.setNextBatter(m3, 'a3');
ok(m3.innings[0].strikerId === 'a2', 'a2 is on strike for the new over');
ok(m3.innings[0].nonStrikerId === 'a3', 'new batter a3 waits at the non-striker end');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
