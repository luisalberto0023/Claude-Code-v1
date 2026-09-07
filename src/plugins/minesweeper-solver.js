// ── Minesweeper deduction and guessing ────────────────────────────────────────
//
// The reasoning half of the Minesweeper plugin, kept apart from anything to do
// with pixels so it can be tested by playing thousands of games directly.
//
// Three layers, cheapest first:
//
//   1. Single-square rules. A number whose neighbouring mines are all flagged
//      means the rest of its neighbours are safe; a number with exactly as many
//      unknown neighbours as it still needs means all of them are mines.
//   2. Overlap between two numbers. Where one number's unknown neighbours are a
//      subset of another's, the difference is often decidable even though
//      neither square could be resolved alone. This is what people mean by
//      "1-2-1" patterns, generalised rather than pattern-matched.
//   3. Counting. When nothing is certain, enumerate the arrangements of mines
//      consistent with every visible number, and open the square that is a mine
//      in the fewest of them.
//
// The third layer is what separates a solver that stalls from one that finishes:
// a majority of Expert boards cannot be completed without at least one guess, so
// guessing well is not a fallback, it is part of playing properly.

export const UNKNOWN = -1;
export const FLAG = -2;

const neighbours = (r, c, rows, cols) => {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nc >= 0 && nr < rows && nc < cols) out.push([nr, nc]);
    }
  }
  return out;
};

/**
 * Every visible number, expressed as: these unknown squares contain exactly this
 * many mines. Numbers already satisfied by flags contribute nothing and are
 * dropped.
 */
function constraintsOf(board) {
  const rows = board.length, cols = board[0].length;
  const list = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = board[r][c];
      if (v < 0 || v > 8) continue;
      const unknown = [];
      let flags = 0;
      for (const [nr, nc] of neighbours(r, c, rows, cols)) {
        if (board[nr][nc] === UNKNOWN) unknown.push(nr * cols + nc);
        else if (board[nr][nc] === FLAG) flags++;
      }
      if (!unknown.length) continue;
      list.push({ cells: unknown, mines: v - flags, from: [r, c] });
    }
  }
  return list;
}

/** Layer 1 and 2: everything that can be settled without counting. */
function deduce(board) {
  const cols = board[0].length;
  const constraints = constraintsOf(board);
  const safe = new Set(), mines = new Set();

  for (const k of constraints) {
    if (k.mines === 0) for (const cell of k.cells) safe.add(cell);
    else if (k.mines === k.cells.length) for (const cell of k.cells) mines.add(cell);
  }
  if (safe.size || mines.size) {
    return { safe: [...safe], mines: [...mines], via: "adjacent counts", cols };
  }

  // Overlap: where one constraint's squares sit inside another's, the remainder
  // carries the difference of their mine counts. If that difference accounts for
  // all of the remainder, those are mines; if it is zero, they are all safe.
  for (const a of constraints) {
    for (const b of constraints) {
      if (a === b) continue;
      const setA = new Set(a.cells);
      if (!b.cells.every(x => setA.has(x))) continue;      // b ⊆ a
      const rest = a.cells.filter(x => !b.cells.includes(x));
      if (!rest.length) continue;
      const diff = a.mines - b.mines;
      if (diff === 0) for (const cell of rest) safe.add(cell);
      else if (diff === rest.length) for (const cell of rest) mines.add(cell);
    }
  }
  return { safe: [...safe], mines: [...mines], via: "overlapping numbers", cols };
}

// Split the constrained squares into groups that share no constraints, so each
// can be counted on its own instead of all at once.
function components(constraints) {
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const k of constraints) for (const cell of k.cells) if (!parent.has(cell)) parent.set(cell, cell);
  for (const k of constraints) for (let i = 1; i < k.cells.length; i++) union(k.cells[0], k.cells[i]);

  const groups = new Map();
  for (const k of constraints) {
    const root = find(k.cells[0]);
    if (!groups.has(root)) groups.set(root, { constraints: [], cells: new Set() });
    const g = groups.get(root);
    g.constraints.push(k);
    for (const cell of k.cells) g.cells.add(cell);
  }
  return [...groups.values()].map(g => ({ ...g, cells: [...g.cells] }));
}

// Every arrangement of mines a group allows, tallied by how many mines it uses.
// Returns null when the group is too large to enumerate honestly.
function arrangements(group, limit = 22) {
  const cells = group.cells;
  if (cells.length > limit) return null;
  const index = new Map(cells.map((cell, i) => [cell, i]));
  const cons = group.constraints.map(k => ({
    idx: k.cells.map(cell => index.get(cell)),
    mines: k.mines,
  }));

  const assign = new Int8Array(cells.length).fill(-1);
  const byCount = new Map();                       // mines used -> arrangements
  const perCell = new Map();                       // mines used -> per-cell tallies

  const feasible = () => {
    for (const k of cons) {
      let placed = 0, open = 0;
      for (const i of k.idx) {
        if (assign[i] === 1) placed++;
        else if (assign[i] === -1) open++;
      }
      if (placed > k.mines) return false;
      if (placed + open < k.mines) return false;
    }
    return true;
  };

  const walk = (i, used) => {
    if (!feasible()) return;
    if (i === cells.length) {
      byCount.set(used, (byCount.get(used) ?? 0) + 1);
      if (!perCell.has(used)) perCell.set(used, new Float64Array(cells.length));
      const tally = perCell.get(used);
      for (let j = 0; j < cells.length; j++) if (assign[j] === 1) tally[j]++;
      return;
    }
    assign[i] = 0; walk(i + 1, used);
    assign[i] = 1; walk(i + 1, used + 1);
    assign[i] = -1;
  };
  walk(0, 0);

  if (!byCount.size) return null;                  // no consistent arrangement
  return { cells, byCount, perCell };
}

const logC = (n, k) => {
  if (k < 0 || k > n) return -Infinity;
  let v = 0;
  for (let i = 1; i <= k; i++) v += Math.log(n - k + i) - Math.log(i);
  return v;
};

/**
 * Probability that each unknown square hides a mine.
 *
 * Arrangements are weighted by how many ways the mines they do not account for
 * could be spread over the squares no number touches. Without that weighting,
 * an arrangement using three mines would count equally with one using seven,
 * and the far edge of the board would be mispriced against the frontier.
 */
export function mineProbabilities(board, totalMines) {
  const rows = board.length, cols = board[0].length;
  const constraints = constraintsOf(board);

  const covered = [];
  let flagged = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c] === UNKNOWN) covered.push(r * cols + c);
      else if (board[r][c] === FLAG) flagged++;
    }
  }
  const minesLeft = totalMines - flagged;
  if (!covered.length) return { probs: new Map(), minesLeft, cols };

  const groups = components(constraints);
  const solved = groups.map(g => arrangements(g)).filter(Boolean);
  const onFrontier = new Set(solved.flatMap(s => s.cells));
  const offFrontier = covered.filter(cell => !onFrontier.has(cell));

  // Distribution over how many mines each group uses, in logs.
  const dists = solved.map(s => {
    const m = new Map();
    for (const [k, ways] of s.byCount) m.set(k, Math.log(ways));
    return m;
  });

  const convolve = (list) => {
    let acc = new Map([[0, 0]]);
    for (const d of list) {
      const next = new Map();
      for (const [t, lw] of acc) {
        for (const [k, lk] of d) {
          const total = t + k;
          if (total > minesLeft) continue;
          next.set(total, logAdd(next.get(total) ?? -Infinity, lw + lk));
        }
      }
      acc = next;
      if (!acc.size) break;
    }
    return acc;
  };

  // Total weight of every consistent arrangement, including how the mines not
  // accounted for could sit among the squares no number touches.
  const all = convolve(dists);
  let logZ = -Infinity;
  for (const [t, lw] of all) {
    const w = lw + logC(offFrontier.length, minesLeft - t);
    if (Number.isFinite(w)) logZ = logAdd(logZ, w);
  }
  if (!Number.isFinite(logZ)) return { probs: new Map(), minesLeft, cols };

  const probs = new Map();
  for (let gi = 0; gi < solved.length; gi++) {
    const s = solved[gi];
    // Everything except this group, so its own counts are not double-counted.
    const others = convolve(dists.filter((_, i) => i !== gi));
    // Weight attaching to this group using exactly k mines.
    const logW = new Map();
    for (const [k] of s.byCount) {
      let acc = -Infinity;
      for (const [t, lw] of others) {
        const w = lw + logC(offFrontier.length, minesLeft - k - t);
        if (Number.isFinite(w)) acc = logAdd(acc, w);
      }
      if (Number.isFinite(acc)) logW.set(k, acc);
    }
    for (let j = 0; j < s.cells.length; j++) {
      let logNum = -Infinity;
      for (const [k, ways] of s.byCount) {
        const w = logW.get(k);
        const tally = s.perCell.get(k);
        if (w === undefined || !tally || tally[j] <= 0) continue;
        logNum = logAdd(logNum, w + Math.log(tally[j]));
      }
      probs.set(s.cells[j], Number.isFinite(logNum) ? Math.exp(logNum - logZ) : 0);
    }
  }

  // Squares no number touches share whatever mines are left over.
  if (offFrontier.length) {
    let expected = 0;
    for (const [t, lw] of all) {
      const w = lw + logC(offFrontier.length, minesLeft - t);
      if (Number.isFinite(w)) expected += Math.exp(w - logZ) * (minesLeft - t);
    }
    const p = Math.min(1, Math.max(0, expected / offFrontier.length));
    for (const cell of offFrontier) probs.set(cell, p);
  }
  return { probs, minesLeft, cols, offFrontier };
}

function logAdd(a, b) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return hi + Math.log1p(Math.exp(lo - hi));
}

/**
 * What to do next.
 *
 * Returns { actions: [{type:'open'|'flag', r, c}], reason, certain }. Certain
 * moves come first and are returned together, since they can all be played
 * without looking again. When nothing is certain it returns a single square:
 * the one least likely to be a mine.
 */
export function solve(board, totalMines) {
  const rows = board.length, cols = board[0].length;
  const at = cell => [Math.floor(cell / cols), cell % cols];

  const d = deduce(board);
  if (d.safe.length || d.mines.length) {
    const actions = [
      ...d.mines.map(cell => { const [r, c] = at(cell); return { type: "flag", r, c }; }),
      ...d.safe.map(cell => { const [r, c] = at(cell); return { type: "open", r, c }; }),
    ];
    return {
      actions,
      certain: true,
      reason: `${d.safe.length} safe, ${d.mines.length} mines — ${d.via}`,
    };
  }

  const { probs } = mineProbabilities(board, totalMines);
  if (!probs.size) {
    // Nothing opened yet. A corner is the usual opening: it has the fewest
    // neighbours, so whatever it reveals constrains the most per square.
    const covered = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (board[r][c] === UNKNOWN) covered.push([r, c]);
    if (!covered.length) return { actions: [], certain: false, reason: "nothing left to do" };
    const opened = board.flat().some(v => v >= 0 && v <= 8);
    const pick = opened ? covered[0] : [0, 0];
    return {
      actions: [{ type: "open", r: pick[0], c: pick[1] }],
      certain: false,
      reason: opened ? "no deduction available" : "opening move",
    };
  }

  let bestCell = null, bestP = Infinity;
  for (const [cell, p] of probs) if (p < bestP) { bestP = p; bestCell = cell; }
  if (bestCell == null) return { actions: [], certain: false, reason: "nothing left to do" };

  // A square that is certainly a mine can be flagged even when the counting was
  // needed to see it.
  if (bestP >= 0.999) {
    const [r, c] = at(bestCell);
    return { actions: [{ type: "flag", r, c }], certain: true, reason: "counting: certainly a mine" };
  }
  const [r, c] = at(bestCell);
  return {
    actions: [{ type: "open", r, c }],
    certain: false,
    reason: `best guess — ${(bestP * 100).toFixed(1)}% chance of a mine`,
    risk: bestP,
  };
}
