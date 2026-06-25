export function createInitialState(config = {}) {
  const {
    gridSize = 5,
    mode = 'classic',
    vsAI = true,
    aiDifficulty = 'medium',
    playerNames = ['PLAYER 1', vsAI ? 'NEXUS AI' : 'PLAYER 2'],
  } = config;

  const dots = gridSize;

  return {
    gridSize: dots,
    mode,
    vsAI,
    aiDifficulty,
    playerNames,
    hLines: Array(dots).fill(null).map(() => Array(dots - 1).fill(0)),
    vLines: Array(dots - 1).fill(null).map(() => Array(dots).fill(0)),
    boxes: Array(dots - 1).fill(null).map(() => Array(dots - 1).fill(0)),
    currentPlayer: 1,
    scores: [0, 0, 0],
    status: 'playing',
    winner: null,
    lastMove: null,
    lastMoveByPlayer: { 1: null, 2: null },
    animatingLines: [],
    animatingBoxes: [],
    comboCount: 0,
    maxCombo: 0,
    moveCount: 0,
    powerUps: mode === 'power' ? {
      1: { surge: 2, void: 1, cascade: 1 },
      2: { surge: 2, void: 1, cascade: 1 },
    } : null,
    turnStartTime: mode === 'blitz' ? Date.now() : null,
    totalBoxes: (dots - 1) * (dots - 1),
  };
}

export function makeMove(state, lineType, row, col) {
  if (state.status !== 'playing') return state;

  const { hLines, vLines, boxes, currentPlayer, gridSize } = state;

  if (lineType === 'h') {
    if (row < 0 || row >= gridSize || col < 0 || col >= gridSize - 1 || hLines[row][col] !== 0) return state;
  } else {
    if (row < 0 || row >= gridSize - 1 || col < 0 || col >= gridSize || vLines[row][col] !== 0) return state;
  }

  const newHLines = hLines.map(r => [...r]);
  const newVLines = vLines.map(r => [...r]);
  const newBoxes = boxes.map(r => [...r]);

  if (lineType === 'h') newHLines[row][col] = currentPlayer;
  else newVLines[row][col] = currentPlayer;

  const closedBoxes = [];
  for (let r = 0; r < gridSize - 1; r++) {
    for (let c = 0; c < gridSize - 1; c++) {
      if (newBoxes[r][c] === 0 && isBoxCompleteFromLines(newHLines, newVLines, r, c)) {
        newBoxes[r][c] = currentPlayer;
        closedBoxes.push({ row: r, col: c });
      }
    }
  }

  const newScores = [...state.scores];
  newScores[currentPlayer] += closedBoxes.length;

  const takenBoxes = newScores[1] + newScores[2];
  const isFinished = takenBoxes === state.totalBoxes;

  let winner = null;
  if (isFinished) {
    if (newScores[1] > newScores[2]) winner = 1;
    else if (newScores[2] > newScores[1]) winner = 2;
    else winner = 'draw';
  }

  const staysTurn = closedBoxes.length > 0 && !isFinished;
  const nextPlayer = staysTurn ? currentPlayer : (currentPlayer === 1 ? 2 : 1);
  const newCombo = staysTurn ? state.comboCount + closedBoxes.length : 0;

  const newLastMoveByPlayer = {
    ...state.lastMoveByPlayer,
    [currentPlayer]: { lineType, row, col },
  };

  return {
    ...state,
    hLines: newHLines,
    vLines: newVLines,
    boxes: newBoxes,
    scores: newScores,
    currentPlayer: isFinished ? state.currentPlayer : nextPlayer,
    status: isFinished ? 'finished' : 'playing',
    winner,
    lastMove: { lineType, row, col },
    lastMoveByPlayer: newLastMoveByPlayer,
    animatingLines: [{ lineType, row, col }],
    animatingBoxes: closedBoxes,
    comboCount: newCombo,
    maxCombo: Math.max(state.maxCombo, newCombo),
    moveCount: state.moveCount + 1,
    turnStartTime: state.mode === 'blitz' ? Date.now() : null,
  };
}

export function applyCascade(state) {
  const { gridSize, currentPlayer } = state;
  const hLines = state.hLines.map(r => [...r]);
  const vLines = state.vLines.map(r => [...r]);
  const boxes = state.boxes.map(r => [...r]);
  const newScores = [...state.scores];
  const newBoxes = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < gridSize - 1; r++) {
      for (let c = 0; c < gridSize - 1; c++) {
        if (boxes[r][c] === 0 && countSidesFromLines(hLines, vLines, r, c) === 3) {
          drawMissingSide(hLines, vLines, r, c, currentPlayer);
          boxes[r][c] = currentPlayer;
          newScores[currentPlayer]++;
          newBoxes.push({ row: r, col: c });
          changed = true;
        }
      }
    }
  }

  const takenBoxes = newScores[1] + newScores[2];
  const isFinished = takenBoxes === state.totalBoxes;
  let winner = null;
  if (isFinished) {
    if (newScores[1] > newScores[2]) winner = 1;
    else if (newScores[2] > newScores[1]) winner = 2;
    else winner = 'draw';
  }

  return {
    ...state,
    hLines,
    vLines,
    boxes,
    scores: newScores,
    animatingBoxes: newBoxes,
    status: isFinished ? 'finished' : 'playing',
    winner,
  };
}

export function applyVoid(state) {
  const { currentPlayer } = state;
  const opponent = currentPlayer === 1 ? 2 : 1;
  const lastOpponentMove = state.lastMoveByPlayer[opponent];
  if (!lastOpponentMove) return state;

  const { lineType, row, col } = lastOpponentMove;
  const hLines = state.hLines.map(r => [...r]);
  const vLines = state.vLines.map(r => [...r]);
  const boxes = state.boxes.map(r => [...r]);
  const newScores = [...state.scores];

  if (lineType === 'h') hLines[row][col] = 0;
  else vLines[row][col] = 0;

  for (let r = 0; r < state.gridSize - 1; r++) {
    for (let c = 0; c < state.gridSize - 1; c++) {
      if (boxes[r][c] === opponent && !isBoxCompleteFromLines(hLines, vLines, r, c)) {
        boxes[r][c] = 0;
        newScores[opponent] = Math.max(0, newScores[opponent] - 1);
      }
    }
  }

  const powerUps = {
    ...state.powerUps,
    [currentPlayer]: { ...state.powerUps[currentPlayer], void: state.powerUps[currentPlayer].void - 1 },
  };

  return {
    ...state,
    hLines,
    vLines,
    boxes,
    scores: newScores,
    powerUps,
    currentPlayer: opponent,
    lastMoveByPlayer: { ...state.lastMoveByPlayer, [opponent]: null },
    animatingLines: [{ lineType: lastOpponentMove.lineType, row: lastOpponentMove.row, col: lastOpponentMove.col, erased: true }],
    animatingBoxes: [],
    comboCount: 0,
    turnStartTime: state.mode === 'blitz' ? Date.now() : null,
  };
}

export function skipTurn(state) {
  const nextPlayer = state.currentPlayer === 1 ? 2 : 1;
  return {
    ...state,
    currentPlayer: nextPlayer,
    animatingLines: [],
    animatingBoxes: [],
    comboCount: 0,
    turnStartTime: state.mode === 'blitz' ? Date.now() : null,
  };
}

function drawMissingSide(hLines, vLines, row, col, player) {
  if (!hLines[row][col]) { hLines[row][col] = player; return; }
  if (!hLines[row + 1][col]) { hLines[row + 1][col] = player; return; }
  if (!vLines[row][col]) { vLines[row][col] = player; return; }
  if (!vLines[row][col + 1]) { vLines[row][col + 1] = player; }
}

export function isBoxCompleteFromLines(hLines, vLines, row, col) {
  return (
    hLines[row]?.[col] !== 0 &&
    hLines[row + 1]?.[col] !== 0 &&
    vLines[row]?.[col] !== 0 &&
    vLines[row]?.[col + 1] !== 0
  );
}

export function countSidesFromLines(hLines, vLines, row, col) {
  let n = 0;
  if (hLines[row]?.[col]) n++;
  if (hLines[row + 1]?.[col]) n++;
  if (vLines[row]?.[col]) n++;
  if (vLines[row]?.[col + 1]) n++;
  return n;
}

export function getValidMoves(state) {
  const { hLines, vLines, gridSize } = state;
  const moves = [];
  for (let r = 0; r < gridSize; r++)
    for (let c = 0; c < gridSize - 1; c++)
      if (hLines[r][c] === 0) moves.push({ lineType: 'h', row: r, col: c });
  for (let r = 0; r < gridSize - 1; r++)
    for (let c = 0; c < gridSize; c++)
      if (vLines[r][c] === 0) moves.push({ lineType: 'v', row: r, col: c });
  return moves;
}
