// Integration test: drives the running server with two real colyseus.js
// clients. Verifies room join, authoritative sync, and anti-cheat rejection.
// Run from repo root (where colyseus.js is installed):  node server/test-playtest.mjs
import { Client } from 'colyseus.js';

const URL = 'ws://localhost:2567';
const HTTP = 'http://localhost:2567';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond) { console.log(`${cond ? '✅' : '❌'} ${label}`); if (!cond) failures++; }

function track(room) {
  const st = { welcome: null, sync: null, rejected: 0 };
  room.onMessage('welcome', m => { st.welcome = m; });
  room.onMessage('sync', p => { st.sync = p; });
  room.onMessage('rejected', () => { st.rejected++; });
  return st;
}

const A = new Client(URL);
const B = new Client(URL);

// ── Private room: create + join by code ──
const roomA = await A.create('game', { mode: 'private', gridSize: 5, name: 'Alice' });
const sA = track(roomA);
await sleep(300);
check('host got welcome as player 1', sA.welcome?.you === 1);
const code = sA.welcome?.code;
check('host received a 4-char room code', typeof code === 'string' && code.length === 4);

const res = await fetch(`${HTTP}/api/room/${code}`);
const { roomId } = await res.json();
check('code resolves to a roomId via REST', !!roomId);

const roomB = await B.joinById(roomId, { name: 'Bob' });
const sB = track(roomB);
await sleep(400);
check('guest got welcome as player 2', sB.welcome?.you === 2);
check('both see status playing once 2 joined', sA.sync?.status === 'playing' && sB.sync?.status === 'playing');
check('names synced', sA.sync?.names?.[1] === 'ALICE' && sA.sync?.names?.[2] === 'BOB');

// ── Authoritative move + sync ──
check('turn starts with player 1', sA.sync?.state.currentPlayer === 1);
roomA.send('move', { lineType: 'h', row: 0, col: 0 });
await sleep(350);
check('move applied to authoritative state', sA.sync?.state.hLines[0][0] === 1);
check('move broadcast to opponent', sB.sync?.state.hLines[0][0] === 1);
check('turn passed to player 2', sA.sync?.state.currentPlayer === 2);

// ── Anti-cheat: out-of-turn move rejected ──
const before = JSON.stringify(sA.sync?.state);
roomA.send('move', { lineType: 'h', row: 1, col: 0 }); // not Alice's turn
await sleep(350);
check('out-of-turn move rejected', sA.rejected >= 1);
check('state unchanged after rejected move', JSON.stringify(sA.sync?.state) === before);

// ── Anti-cheat: illegal (already-taken) line rejected ──
roomB.send('move', { lineType: 'h', row: 0, col: 0 }); // already drawn by Alice
await sleep(350);
check('illegal move rejected', sB.rejected >= 1);

// ── Legal move from player 2 ──
roomB.send('move', { lineType: 'v', row: 0, col: 0 });
await sleep(350);
check('player 2 legal move applied', sA.sync?.state.vLines[0][0] === 2);
check('turn back to player 1', sA.sync?.state.currentPlayer === 1);

// ── Quick match: two fresh clients auto-pair ──
const C = new Client(URL), D = new Client(URL);
const roomC = await C.joinOrCreate('game', { mode: 'quick', name: 'Cara' });
const sC = track(roomC);
const roomD = await D.joinOrCreate('game', { mode: 'quick', name: 'Dan' });
const sD = track(roomD);
await sleep(500);
check('quick match paired two players into one room', roomC.roomId === roomD.roomId);
check('quick match reaches playing', sC.sync?.status === 'playing' && sD.sync?.status === 'playing');

await roomA.leave(); await roomB.leave(); await roomC.leave(); await roomD.leave();
await sleep(200);

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
