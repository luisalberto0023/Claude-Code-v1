// ── Minesweeper, drawn ────────────────────────────────────────────────────────
//
// Turns a game (game.js) into pixels, in the classic look: a grey panel, raised
// covered squares lit from the top left, flat grey opened squares with a thin
// line along their top and left, numbers in the classic colours (1 blue,
// 2 green, 3 red, 4 navy, 5 maroon, 6 teal, 7 black, 8 grey), black mines, red
// flags, red counters on black, and a yellow face to start a new game.
//
// Every pixel is set here, one by one, into an RGBA buffer: {width, height,
// data} as a canvas ImageData has it, and as tools/fake-canvas.mjs has it too.
// Nothing is left to the browser's own drawing, which would smooth edges and
// anti-alias text differently from one browser to the next. So the page (it
// puts the buffer on its canvas with putImageData) and the node check
// (tools/check-bench.mjs, which hands the same buffer to the Minesweeper
// reader) see exactly the same pixels, and a check that passes in node says
// something about what is on the screen.
//
// The reader in src/plugins/minesweeper.js was written against minesweeper.online
// and does not know this page. Nothing here was tuned to it either: the look is
// the classic game's, and the check says whether the reader copes.

import { cellView, minesLeft, secondsPlayed } from "./game.js";

// The side of a square, in screen pixels: ?size= on the page.
export const SIZE_DEFAULT = 24;
export const SIZE_MIN = 12;
export const SIZE_MAX = 48;

/** The square size `?size=` asks for, kept within SIZE_MIN to SIZE_MAX. */
export function sizeFrom(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return SIZE_DEFAULT;
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, n));
}

export const COLOURS = Object.freeze({
  face: [192, 192, 192],     // the panel, and every square, covered or opened
  light: [255, 255, 255],    // the lit edges of a raised square
  shadow: [128, 128, 128],   // its shadowed edges, and the line along an opened square
  ink: [0, 0, 0],            // mines, the flag's pole, the face's features
  red: [255, 0, 0],          // flags, the opened mine's square, lit counter segments
  unlit: [80, 0, 0],         // counter segments that are off
  yellow: [255, 255, 0],     // the face
});

export const NUMBER_COLOURS = Object.freeze({
  1: [0, 0, 255], 2: [0, 128, 0], 3: [255, 0, 0], 4: [0, 0, 128],
  5: [128, 0, 0], 6: [0, 128, 128], 7: [0, 0, 0], 8: [128, 128, 128],
});

// The numbers as 5×7 blocks, drawn a block per `#`, each block u×u pixels.
const GLYPHS = {
  1: ["..#..", ".##..", "#.#..", "..#..", "..#..", "..#..", "#####"],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
};

// Which of a counter digit's seven segments are lit: a top, b top right,
// c bottom right, d bottom, e bottom left, f top left, g middle.
const SEGMENTS = {
  0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg",
  6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg", "-": "g",
};

/**
 * Where everything goes for a board of `rows` × `cols` squares of `size`
 * pixels: the whole picture's width and height, the header with the two
 * counters and the face, and the grid of squares (grid.x, grid.y is the top
 * left of the first square).
 */
export function geometry(rows, cols, size = SIZE_DEFAULT) {
  const s = size;
  const b = Math.max(2, Math.round(s / 8));        // every bevel: squares, panels, the face
  const m = Math.round(s / 2);                      // space around and between the panels
  const headerH = Math.round(s * 2.25);
  const gridW = cols * s, gridH = rows * s;
  const width = b + m + b + gridW + b + m + b;
  const header = { x: b + m, y: b + m, w: gridW + 2 * b, h: headerH };
  const grid = { x: b + m + b, y: header.y + headerH + m + b, w: gridW, h: gridH, size: s, rows, cols };
  const height = grid.y + gridH + b + m + b;

  const gap = Math.max(1, Math.round(s / 12));
  const digitH = Math.round(headerH * 0.62);
  const digitW = Math.round(digitH * 0.55);
  const counterW = 3 * digitW + 4 * gap, counterH = digitH + 2 * gap;
  const inset = b + Math.round((headerH - 2 * b - counterH) / 2);
  const counterY = header.y + Math.round((headerH - counterH) / 2);
  const faceSide = Math.round(headerH * 0.78);

  return {
    width, height, size: s, bevel: b, header, grid,
    mines: { x: header.x + inset, y: counterY, w: counterW, h: counterH, digitW, digitH, gap },
    timer: { x: header.x + header.w - inset - counterW, y: counterY, w: counterW, h: counterH, digitW, digitH, gap },
    face: {
      x: Math.round((width - faceSide) / 2), y: header.y + Math.round((headerH - faceSide) / 2),
      w: faceSide, h: faceSide,
    },
  };
}

/** What is under pixel x, y: {kind: "cell", r, c}, {kind: "face"}, or null. */
export function hit(geo, x, y) {
  const { grid, face } = geo;
  if (x >= grid.x && y >= grid.y && x < grid.x + grid.w && y < grid.y + grid.h) {
    return { kind: "cell", r: Math.floor((y - grid.y) / grid.size), c: Math.floor((x - grid.x) / grid.size) };
  }
  if (x >= face.x && y >= face.y && x < face.x + face.w && y < face.y + face.h) return { kind: "face" };
  return null;
}

function painter(target) {
  const { width: W, height: H, data } = target;
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  };
  // Most of a board is filled rectangles, so they are written straight into the
  // buffer, clipped once rather than pixel by pixel.
  const rect = (x, y, w, h, c) => {
    const x0 = Math.max(0, x), x1 = Math.min(W, x + w);
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
      for (let xx = x0, i = (yy * W + x0) * 4; xx < x1; xx++, i += 4) {
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
      }
    }
  };
  // A frame `b` pixels wide around a box, `lit` along the top and left and
  // `dark` along the bottom and right, split on the diagonal at the two corners
  // where they meet: raised with light first, sunken with shadow first.
  const bevel = (x, y, w, h, b, lit, dark) => {
    const edge = (dx, dy) => {
      const inTop = dy < b && dx + dy < w - 1;
      const inLeft = dx < b && dx + dy < h - 1;
      if (inTop || inLeft) set(x + dx, y + dy, lit);
      else if (dy >= h - b || dx >= w - b) set(x + dx, y + dy, dark);
    };
    for (let dy = 0; dy < h; dy++) {
      if (dy < b || dy >= h - b) {
        for (let dx = 0; dx < w; dx++) edge(dx, dy);
        continue;
      }
      // Between the top and bottom edges only the left and right ones have
      // anything to paint; the inside is left as it is. (Walking the inside too
      // made drawing the whole board several times slower, for no pixel.)
      for (let dx = 0; dx < Math.min(b, w); dx++) edge(dx, dy);
      for (let dx = Math.max(b, w - b); dx < w; dx++) edge(dx, dy);
    }
  };
  // Every pixel whose centre is within `r` of cx, cy (centres may be halves).
  const disc = (cx, cy, r, c) => {
    for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
      for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) set(xx, yy, c);
      }
    }
  };
  // Pixels between radius `r` and `r - t` from cx, cy for which keep(x, y) holds.
  const arc = (cx, cy, r, t, c, keep) => {
    for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
      for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        const d = Math.hypot(xx - cx, yy - cy);
        if (d <= r && d > r - t && keep(xx, yy)) set(xx, yy, c);
      }
    }
  };
  const line = (x0, y0, x1, y1, t, c) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(x0 + (x1 - x0) * k / steps), y = Math.round(y0 + (y1 - y0) * k / steps);
      rect(x - Math.floor(t / 2), y - Math.floor(t / 2), t, t, c);
    }
  };
  return { set, rect, bevel, disc, arc, line };
}

function drawMine(p, x, y, s) {
  const cx = x + (s - 1) / 2, cy = y + (s - 1) / 2;
  const r = s * 0.3;
  const t = Math.max(1, Math.round(s / 12));
  p.disc(cx, cy, r, COLOURS.ink);
  // Spikes, straight and diagonal, and a glint.
  const long = s * 0.4, short = s * 0.33;
  p.line(Math.round(cx - long), Math.round(cy), Math.round(cx + long), Math.round(cy), t, COLOURS.ink);
  p.line(Math.round(cx), Math.round(cy - long), Math.round(cx), Math.round(cy + long), t, COLOURS.ink);
  p.line(Math.round(cx - short), Math.round(cy - short), Math.round(cx + short), Math.round(cy + short), t, COLOURS.ink);
  p.line(Math.round(cx - short), Math.round(cy + short), Math.round(cx + short), Math.round(cy - short), t, COLOURS.ink);
  const g = Math.max(2, Math.round(s / 8));
  p.rect(Math.round(cx - r * 0.45), Math.round(cy - r * 0.45), g, g, COLOURS.light);
}

function drawFlag(p, x, y, s) {
  const pole = Math.max(1, Math.round(s / 12));
  const px = x + Math.round(s * 0.55);
  const top = y + Math.round(s * 0.2), bottom = y + Math.round(s * 0.72);
  // The pennant: a triangle flying left from the top of the pole.
  const h = Math.round(s * 0.3), reach = Math.round(s * 0.3);
  for (let k = 0; k < h; k++) {
    const from = Math.abs(k - (h - 1) / 2) / ((h - 1) / 2 || 1);   // 1 at the tips, 0 in the middle
    const w = Math.max(1, Math.round(reach * (1 - from)));
    p.rect(px - w, top + k, w, 1, COLOURS.red);
  }
  p.rect(px, top, pole, bottom - top, COLOURS.ink);
  // A two-step base.
  const baseW = Math.round(s * 0.5), baseH = Math.max(1, Math.round(s / 12));
  p.rect(px + Math.floor(pole / 2) - Math.round(baseW * 0.3), bottom - baseH, Math.round(baseW * 0.6), baseH, COLOURS.ink);
  p.rect(px + Math.floor(pole / 2) - Math.round(baseW / 2), bottom, baseW, baseH + 1, COLOURS.ink);
}

function drawNumber(p, x, y, s, n) {
  const glyph = GLYPHS[n];
  const u = Math.max(1, Math.floor(s / 12));
  const ox = x + Math.round((s - 5 * u) / 2), oy = y + Math.round((s - 7 * u) / 2);
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 5; gx++) {
      if (glyph[gy][gx] === "#") p.rect(ox + gx * u, oy + gy * u, u, u, NUMBER_COLOURS[n]);
    }
  }
}

function drawCell(p, geo, game, r, c, pressed) {
  const s = geo.size, b = geo.bevel;
  const x = geo.grid.x + c * s, y = geo.grid.y + r * s;
  const view = cellView(game, r, c);
  const covered = view.kind === "covered" || view.kind === "flag";
  if (covered && !(pressed && view.kind === "covered")) {
    p.rect(x, y, s, s, COLOURS.face);
    p.bevel(x, y, s, s, b, COLOURS.light, COLOURS.shadow);
    if (view.kind === "flag") drawFlag(p, x, y, s);
    return;
  }
  // Opened (or held down, which looks opened until the button comes up): flat,
  // with a line along the top and left only.
  p.rect(x, y, s, s, view.kind === "mine" && view.exploded ? COLOURS.red : COLOURS.face);
  p.rect(x, y, s, 1, COLOURS.shadow);
  p.rect(x, y, 1, s, COLOURS.shadow);
  if (view.kind === "open" && view.n > 0) drawNumber(p, x, y, s, view.n);
  if (view.kind === "mine") drawMine(p, x, y, s);
  if (view.kind === "wrong-flag") {
    drawMine(p, x, y, s);
    const t = Math.max(1, Math.round(s / 16));
    const lo = Math.round(s * 0.2), hi = Math.round(s * 0.8);
    p.line(x + lo, y + lo, x + hi, y + hi, t, COLOURS.red);
    p.line(x + lo, y + hi, x + hi, y + lo, t, COLOURS.red);
  }
}

function drawCounter(p, box, value) {
  p.rect(box.x, box.y, box.w, box.h, COLOURS.ink);
  const v = Math.max(-99, Math.min(999, Math.trunc(value)));
  const text = v < 0 ? `-${String(-v).padStart(2, "0")}` : String(v).padStart(3, "0");
  const { digitW: w, digitH: h, gap } = box;
  const t = Math.max(2, Math.round(w / 6));
  const half = Math.floor(h / 2);
  [...text].forEach((ch, i) => {
    const x = box.x + gap + i * (w + gap), y = box.y + gap;
    const lit = SEGMENTS[ch] ?? "";
    const seg = {
      a: [x + t, y, w - 2 * t, t],
      b: [x + w - t, y + t, t, half - t],
      c: [x + w - t, y + half + 1, t, h - half - t - 1],
      d: [x + t, y + h - t, w - 2 * t, t],
      e: [x, y + half + 1, t, h - half - t - 1],
      f: [x, y + t, t, half - t],
      g: [x + t, y + half - Math.floor(t / 2), w - 2 * t, t],
    };
    for (const [name, [sx, sy, sw, sh]] of Object.entries(seg)) {
      p.rect(sx, sy, sw, sh, lit.includes(name) ? COLOURS.red : COLOURS.unlit);
    }
  });
}

function drawFace(p, geo, mood, pressed) {
  const f = geo.face, b = geo.bevel, s = geo.size;
  p.rect(f.x, f.y, f.w, f.h, COLOURS.face);
  if (pressed) p.bevel(f.x, f.y, f.w, f.h, Math.max(1, b - 1), COLOURS.shadow, COLOURS.face);
  else p.bevel(f.x, f.y, f.w, f.h, b, COLOURS.light, COLOURS.shadow);
  const shift = pressed ? 1 : 0;
  const cx = f.x + (f.w - 1) / 2 + shift, cy = f.y + (f.h - 1) / 2 + shift;
  const r = f.w * 0.36;
  const t = Math.max(1, Math.round(s / 16));
  p.disc(cx, cy, r, COLOURS.ink);
  p.disc(cx, cy, r - t, COLOURS.yellow);
  const eyeX = r * 0.36, eyeY = cy - r * 0.3, eye = Math.max(2, Math.round(r * 0.2));
  const smile = () => p.arc(cx, cy, r * 0.58, t + 1, COLOURS.ink, (x, y) => y > cy + r * 0.18);
  if (mood === "dead") {
    for (const ex of [cx - eyeX, cx + eyeX]) {
      const e = Math.round(eye * 0.8);
      p.line(Math.round(ex - e), Math.round(eyeY - e), Math.round(ex + e), Math.round(eyeY + e), t, COLOURS.ink);
      p.line(Math.round(ex - e), Math.round(eyeY + e), Math.round(ex + e), Math.round(eyeY - e), t, COLOURS.ink);
    }
    p.arc(cx, cy + r * 0.8, r * 0.45, t + 1, COLOURS.ink, (x, y) => y < cy + r * 0.62);
    return;
  }
  if (mood === "cool") {
    p.rect(Math.round(cx - r * 0.7), Math.round(eyeY - eye / 2), Math.round(r * 1.4), eye, COLOURS.ink);
    p.rect(Math.round(cx - eyeX - eye), Math.round(eyeY - eye / 2), eye * 2, Math.round(eye * 1.4), COLOURS.ink);
    p.rect(Math.round(cx + eyeX - eye), Math.round(eyeY - eye / 2), eye * 2, Math.round(eye * 1.4), COLOURS.ink);
    smile();
    return;
  }
  for (const ex of [cx - eyeX, cx + eyeX]) {
    p.rect(Math.round(ex - eye / 2), Math.round(eyeY - eye / 2), eye, eye, COLOURS.ink);
  }
  if (mood === "worried") p.arc(cx, cy + r * 0.42, r * 0.22, t + 1, COLOURS.ink, () => true);
  else smile();
}

/**
 * Draw `game` into `target` ({width, height, data}: an ImageData, or a
 * tools/fake-canvas.mjs canvas), which must be geometry()'s size.
 *
 * `press` is what the mouse is holding down, as hit() names it: a covered
 * square held down looks opened and the face looks worried until the button
 * comes up, and the face held down looks pressed in. `now` is for the timer.
 */
export function drawGame(target, game, { size = SIZE_DEFAULT, press = null, now = Date.now() } = {}) {
  const geo = geometry(game.rows, game.cols, size);
  if (target.width !== geo.width || target.height !== geo.height) {
    throw new Error(`drawGame needs a ${geo.width}×${geo.height} target, not ${target.width}×${target.height}`);
  }
  const p = painter(target);
  const b = geo.bevel;
  p.rect(0, 0, geo.width, geo.height, COLOURS.face);
  p.bevel(0, 0, geo.width, geo.height, b, COLOURS.light, COLOURS.shadow);
  p.bevel(geo.header.x, geo.header.y, geo.header.w, geo.header.h, b, COLOURS.shadow, COLOURS.light);
  p.bevel(geo.grid.x - b, geo.grid.y - b, geo.grid.w + 2 * b, geo.grid.h + 2 * b, b, COLOURS.shadow, COLOURS.light);

  drawCounter(p, geo.mines, minesLeft(game));
  drawCounter(p, geo.timer, secondsPlayed(game, now));

  const live = game.status === "ready" || game.status === "playing";
  const holding = live && press?.kind === "cell";
  const mood = game.status === "lost" ? "dead" : game.status === "won" ? "cool" : holding ? "worried" : "happy";
  drawFace(p, geo, mood, press?.kind === "face");

  for (let r = 0; r < game.rows; r++) {
    for (let c = 0; c < game.cols; c++) {
      drawCell(p, geo, game, r, c, holding && press.r === r && press.c === c);
    }
  }
  return geo;
}
