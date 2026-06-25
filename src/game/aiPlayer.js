import { getValidMoves, countSidesFromLines, isBoxCompleteFromLines } from './gameLogic.js';

export function getAIMove(state, difficulty) {
  const moves = getValidMoves(state);
  if (moves.length === 0) return null;

  switch (difficulty) {
    case 'easy': return easyMove(state, moves);
    case 'hard': return hardMove(state, moves);
    default: return mediumMove(state, moves);
  }
}

function easyMove(state, moves) {
  const completing = moves.filter(m => wouldComplete(state, m));
  if (completing.length > 0) return completing[0];
  return moves[Math.floor(Math.random() * moves.length)];
}

function mediumMove(state, moves) {
  const completing = moves.filter(m => wouldComplete(state, m));
  if (completing.length > 0) return completing[0];

  const safe = moves.filter(m => !wouldGive(state, m));
  if (safe.length > 0) return safe[Math.floor(Math.random() * safe.length)];

  let best = moves[0];
  let bestCount = Infinity;
  for (const m of moves) {
    const count = countGiven(state, m);
    if (count < bestCount) { bestCount = count; best = m; }
  }
  return best;
}

function hardMove(state, moves) {
  const completing = moves.filter(m => wouldComplete(state, m));
  if (completing.length > 0) {
    completing.sort((a, b) => chainLength(state, b) - chainLength(state, a));
    return completing[0];
  }

  const safe = moves.filter(m => !wouldGive(state, m));
  if (safe.length > 0) {
    const superSafe = safe.filter(m => !wouldCreate2Sided(state, m));
    const pool = superSafe.length > 0 ? superSafe : safe;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const ranked = moves.map(m => ({ m, g: countGiven(state, m) })).sort((a, b) => a.g - b.g);
  return ranked[0].m;
}

function wouldComplete(state, move) {
  const { hLines, vLines, gridSize, boxes } = state;
  const newH = move.lineType === 'h' ? setAt(hLines, move.row, move.col, 1) : hLines;
  const newV = move.lineType === 'v' ? setAt(vLines, move.row, move.col, 1) : vLines;
  for (let r = 0; r < gridSize - 1; r++)
    for (let c = 0; c < gridSize - 1; c++)
      if (boxes[r][c] === 0 && isBoxCompleteFromLines(newH, newV, r, c)) return true;
  return false;
}

function wouldGive(state, move) {
  if (wouldComplete(state, move)) return false;
  const { hLines, vLines, gridSize, boxes } = state;
  const newH = move.lineType === 'h' ? setAt(hLines, move.row, move.col, 1) : hLines;
  const newV = move.lineType === 'v' ? setAt(vLines, move.row, move.col, 1) : vLines;
  for (let r = 0; r < gridSize - 1; r++)
    for (let c = 0; c < gridSize - 1; c++)
      if (boxes[r][c] === 0 && countSidesFromLines(newH, newV, r, c) === 3) return true;
  return false;
}

function wouldCreate2Sided(state, move) {
  const { hLines, vLines, gridSize, boxes } = state;
  const newH = move.lineType === 'h' ? setAt(hLines, move.row, move.col, 1) : hLines;
  const newV = move.lineType === 'v' ? setAt(vLines, move.row, move.col, 1) : vLines;
  for (let r = 0; r < gridSize - 1; r++)
    for (let c = 0; c < gridSize - 1; c++)
      if (boxes[r][c] === 0 && countSidesFromLines(newH, newV, r, c) === 2) return true;
  return false;
}

function countGiven(state, move) {
  const { hLines, vLines, gridSize, boxes } = state;
  const newH = move.lineType === 'h' ? setAt(hLines, move.row, move.col, 1) : hLines;
  const newV = move.lineType === 'v' ? setAt(vLines, move.row, move.col, 1) : vLines;
  let count = 0;
  for (let r = 0; r < gridSize - 1; r++)
    for (let c = 0; c < gridSize - 1; c++)
      if (boxes[r][c] === 0 && countSidesFromLines(newH, newV, r, c) === 3) count++;
  return count;
}

function chainLength(state, move) {
  const { hLines, vLines, gridSize, boxes } = state;
  const h = move.lineType === 'h' ? setAt(hLines, move.row, move.col, 1) : hLines.map(r => [...r]);
  const v = move.lineType === 'v' ? setAt(vLines, move.row, move.col, 1) : vLines.map(r => [...r]);
  const b = boxes.map(r => [...r]);
  let count = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < gridSize - 1; r++) {
      for (let c = 0; c < gridSize - 1; c++) {
        if (b[r][c] === 0 && isBoxCompleteFromLines(h, v, r, c)) {
          b[r][c] = 1; count++; changed = true;
        }
      }
    }
  }
  return count;
}

function setAt(arr, row, col, val) {
  const copy = arr.map(r => [...r]);
  copy[row][col] = val;
  return copy;
}

export const AI_TAUNTS = {
  capturing: [
    'GRID SECURED', 'ZONE ACQUIRED', 'PROCESSING DOMINANCE', 'SECTOR CAPTURED',
    'OPTIMAL SEQUENCE EXECUTED', 'TARGET NEUTRALIZED',
  ],
  winning: [
    'RESISTANCE FUTILE', 'VICTORY PROBABILITY: 94.7%', 'RECALCULATING... OUTCOME: CERTAIN',
    'HUMAN DEFEAT IMMINENT', 'MY CALCULATIONS CANNOT BE WRONG',
  ],
  losing: [
    'ANOMALY DETECTED', 'RECALIBRATING...', 'UNEXPECTED INPUT', 'ADAPTING STRATEGY',
    'THIS IS... ILLOGICAL', 'INITIATING BACKUP PROTOCOLS',
  ],
  neutral: [
    'ANALYZING GRID STATE', 'COMPUTING OPTIMAL PATH', 'NEURAL NETS ACTIVATED',
    'PATTERN RECOGNITION ENGAGED',
  ],
};
