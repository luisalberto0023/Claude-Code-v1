// Phase 2 integration test: accounts, ranked ELO, leaderboard, abandon=loss.
// Server must be running (in-memory store is fine).  node server/test-ranked.mjs
import { Client } from 'colyseus.js';

const WS = 'ws://localhost:2567';
const HTTP = 'http://localhost:2567';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; };

async function account(name) {
  const res = await fetch(`${HTTP}/api/account`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  return res.json();
}
function track(room) {
  const st = { welcome: null, sync: null, result: null };
  room.onMessage('welcome', m => { st.welcome = m; });
  room.onMessage('sync', p => { st.sync = p; });
  room.onMessage('ranked_result', r => { st.result = r; });
  return st;
}
function emptyLine(s) {
  for (let r = 0; r < s.hLines.length; r++) for (let c = 0; c < s.hLines[r].length; c++) if (s.hLines[r][c] === 0) return { lineType: 'h', row: r, col: c };
  for (let r = 0; r < s.vLines.length; r++) for (let c = 0; c < s.vLines[r].length; c++) if (s.vLines[r][c] === 0) return { lineType: 'v', row: r, col: c };
  return null;
}

// ── Accounts ──
const a = await account('Alice');
const b = await account('Bob');
check('account A created with token + 1000 rating', !!a.token && a.rating === 1000);
check('account B created', !!b.token && b.rating === 1000);

// ── Ranked match: pair two players ──
const CA = new Client(WS), CB = new Client(WS);
const rA = await CA.joinOrCreate('ranked', { token: a.token, name: 'Alice' });
const sA = track(rA);
const rB = await CB.joinOrCreate('ranked', { token: b.token, name: 'Bob' });
const sB = track(rB);
await sleep(500);
check('ranked match paired into one room', rA.roomId === rB.roomId);
check('both flagged ranked + playing', sA.sync?.ranked === true && sA.sync?.status === 'playing');
check('ratings present in sync', sA.sync?.ratings?.[1] === 1000 && sA.sync?.ratings?.[2] === 1000);

// ── Play a full game to completion ──
const clientByPlayer = { [sA.welcome.you]: rA, [sB.welcome.you]: rB };
let guard = 0;
while (guard++ < 200) {
  const s = sA.sync;
  if (!s || s.status !== 'playing' || s.state.status === 'finished') break;
  const cur = s.state.currentPlayer;
  const mv = emptyLine(s.state);
  if (!mv) break;
  clientByPlayer[cur].send('move', mv);
  await sleep(25);
}
await sleep(400);
check('game reached finished', sA.sync?.state.status === 'finished');
check('ranked_result broadcast', !!sA.result && !!sB.result);

const winner = sA.sync?.state.winner;
check('winner determined', winner === 1 || winner === 2 || winner === 'draw');
if (sA.result) {
  const totalDelta = sA.result.deltas[1] + sA.result.deltas[2];
  check('ELO deltas are zero-sum', Math.abs(totalDelta) <= 1);
  if (winner === 'draw') {
    check('draw → ~zero ELO change at equal ratings', Math.abs(sA.result.deltas[1]) <= 1 && Math.abs(sA.result.deltas[2]) <= 1);
  } else {
    check('decisive result → ratings moved from 1000', sA.result.ratings[1] !== 1000 || sA.result.ratings[2] !== 1000);
  }
}

// ── Leaderboard reflects results ──
const lb = await (await fetch(`${HTTP}/api/leaderboard?token=${a.token}`)).json();
check('leaderboard lists played accounts', lb.top.length >= 2);
check('leaderboard sorted by rating desc', lb.top.every((p, i, arr) => i === 0 || arr[i - 1].rating >= p.rating));
check('caller rank present', !!lb.me && lb.me.rank >= 1);

// ── Abandon = loss ──
const c2 = await account('Cara');
const d2 = await account('Dan');
const CC = new Client(WS), CD = new Client(WS);
const rC = await CC.joinOrCreate('ranked', { token: c2.token, name: 'Cara' });
const sC = track(rC);
const rD = await CD.joinOrCreate('ranked', { token: d2.token, name: 'Dan' });
const sD = track(rD);
await sleep(400);
check('second ranked match playing', sC.sync?.status === 'playing');
// Dan rage-quits.
await rD.leave(true);
await sleep(500);
check('abandon produced a ranked result (loss for leaver)', !!sC.result);
const cara = await (await fetch(`${HTTP}/api/account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: c2.token }) })).json();
const dan = await (await fetch(`${HTTP}/api/account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d2.token }) })).json();
check('staying player gained rating', cara.rating > 1000 && cara.wins === 1);
check('leaver lost rating', dan.rating < 1000 && dan.losses === 1);

await rA.leave(); await rB.leave(); await rC.leave();
await sleep(200);
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
