/* ──────────────────────────────────────────────────────────────────────────
   Online room service (Firebase Firestore).

   Turn-based, so the data model is tiny: one document per match in the `rooms`
   collection. Each move writes the full game state (as a JSON string — Firestore
   can't store nested arrays, and our board is arrays-of-arrays). Both clients
   subscribe and render from the synced state.

   Firebase is imported dynamically the first time it's needed, so single-player
   never pays for it and stays fully offline.
   ────────────────────────────────────────────────────────────────────────── */

import { firebaseConfig } from './firebaseConfig.js';
import { createInitialState } from '../game/gameLogic.js';

let _mod = null;
async function fb() {
  if (_mod) return _mod;
  const appMod = await import('firebase/app');
  const fs = await import('firebase/firestore');
  const app = appMod.getApps?.().length ? appMod.getApp() : appMod.initializeApp(firebaseConfig);
  const db = fs.getFirestore(app);
  _mod = { db, ...fs };
  return _mod;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
function genCode() {
  return Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
}

export function clientId() {
  let id = null;
  try { id = localStorage.getItem('nexus.clientId'); } catch { /* ignore */ }
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem('nexus.clientId', id); } catch { /* ignore */ }
  }
  return id;
}

// Returns 1 (host), 2 (guest), or 0 (spectator) for the current device.
export function roleOf(data) {
  const me = clientId();
  if (data?.host === me) return 1;
  if (data?.guest === me) return 2;
  return 0;
}

export async function createRoom(config, hostName) {
  const { db, doc, setDoc, getDoc, serverTimestamp } = await fb();
  let code = genCode();
  for (let i = 0; i < 6; i++) {
    const exists = (await getDoc(doc(db, 'rooms', code))).exists();
    if (!exists) break;
    code = genCode();
  }
  const state = createInitialState(config);
  await setDoc(doc(db, 'rooms', code), {
    code,
    status: 'waiting',
    host: clientId(),
    guest: null,
    config: { gridSize: config.gridSize, mode: 'classic' },
    names: { p1: hostName || 'PLAYER 1', p2: '' },
    stateJson: JSON.stringify(state),
    rematchSeq: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return code;
}

export async function joinRoom(rawCode, guestName) {
  const code = (rawCode || '').trim().toUpperCase();
  if (code.length !== 4) throw new Error('Enter the 4-character room code.');
  const { db, doc, getDoc, updateDoc, serverTimestamp } = await fb();
  const ref = doc(db, 'rooms', code);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Room not found. Check the code.');
  const data = snap.data();
  const me = clientId();
  if (data.guest && data.guest !== me && data.host !== me) throw new Error('That room is already full.');
  if (data.host !== me) {
    await updateDoc(ref, {
      guest: me,
      'names.p2': guestName || 'PLAYER 2',
      status: 'playing',
      updatedAt: serverTimestamp(),
    });
  }
  return code;
}

export async function subscribeRoom(code, cb) {
  const { db, doc, onSnapshot } = await fb();
  return onSnapshot(doc(db, 'rooms', code), s => cb(s.exists() ? s.data() : null));
}

export async function pushState(code, state) {
  const { db, doc, updateDoc, serverTimestamp } = await fb();
  await updateDoc(doc(db, 'rooms', code), {
    stateJson: JSON.stringify(state),
    status: state.status === 'finished' ? 'finished' : 'playing',
    updatedAt: serverTimestamp(),
  });
}

// Host restarts with a fresh board; both clients pick it up via the snapshot.
export async function requestRematch(code, config, currentSeq) {
  const { db, doc, updateDoc, serverTimestamp } = await fb();
  const state = createInitialState(config);
  await updateDoc(doc(db, 'rooms', code), {
    stateJson: JSON.stringify(state),
    status: 'playing',
    rematchSeq: (currentSeq || 0) + 1,
    updatedAt: serverTimestamp(),
  });
}

export async function leaveRoom(code) {
  try {
    const { db, doc, updateDoc, serverTimestamp } = await fb();
    await updateDoc(doc(db, 'rooms', code), {
      status: 'abandoned',
      abandonedBy: clientId(),
      updatedAt: serverTimestamp(),
    });
  } catch { /* best-effort */ }
}
