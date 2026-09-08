// Draw Minesweeper boards to test the reader against.
//
// WHAT THESE FIXTURES CAN AND CANNOT PROVE
//
// An earlier set of fixtures was drawn with the very constants the reader was
// looking for — the classic greys, 192/255/128 — so the reader agreed with them
// perfectly and failed on the real site every single time. A test that shares
// its assumptions with the code under test cannot fail.
//
// So the skins below are deliberately unlike each other and unlike anything
// hard-coded: different greys, different bevel widths, different frame colours,
// different cell sizes, one drawn in warm tones and one nearly flat. If the
// reader only works on one palette, these catch it. What they establish is that
// finding the grid, telling covered from opened, spotting mines and flags, and
// measuring the board's extent all survive a change of skin.
//
// What they do NOT establish is digit identification. The reader names a number
// by hue — 1 blue, 2 green, 3 red — and these draw them in the same hues, so
// that part is agreement by construction. It is a real convention shared across
// Minesweeper implementations rather than an invented one, but it is not tested
// here, and a site that recolours its numbers would break the reader with every
// one of these still passing. Only a real screenshot settles that.

import { createCanvas } from "./fake-canvas.mjs";

export const DIGIT_COLOURS = {
  1: [0, 0, 255], 2: [0, 128, 0], 3: [255, 0, 0], 4: [0, 0, 128],
  5: [128, 0, 0], 6: [0, 128, 128], 7: [0, 0, 0], 8: [128, 128, 128],
};

// Three skins that agree about nothing except being mostly grey.
export const SKINS = {
  classic: {
    page: [255, 255, 255], frame: [198, 198, 198],
    covered: [192, 192, 192], light: [255, 255, 255], shadow: [128, 128, 128],
    opened: [192, 192, 192], line: [128, 128, 128], bevelWidth: 3,
  },
  dark: {
    page: [32, 34, 38], frame: [122, 126, 130],
    covered: [150, 154, 158], light: [206, 210, 214], shadow: [96, 99, 103],
    opened: [176, 180, 184], line: [120, 124, 128], bevelWidth: 2,
  },
  warm: {
    page: [250, 246, 238], frame: [206, 200, 190],
    covered: [214, 208, 198], light: [246, 242, 234], shadow: [156, 150, 142],
    opened: [228, 224, 216], line: [170, 165, 158], bevelWidth: 4,
  },
};

// 3x5 digit shapes. Which digit the reader thinks it is comes from the colour,
// not the shape — these are here so a number covers a believable FRACTION of
// its square. That fraction matters: the reader calls a square a mine when
// enough of it is dark and colourless, and a glyph drawn too fat makes a black
// 7 look like one. Real digits are strokes, so these are too.
const GLYPHS = {
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"],
};

/**
 * Draw a board.
 *
 * `cells` is a grid of: null for covered, "F" for a flag, "*" for a mine, or
 * 0-8 for an opened square. The board is placed on a page with other things
 * around it, so finding it is part of what is being tested.
 */
export function drawBoard(cells, { skin = "classic", pitch = 24, pad = 60, chrome = true } = {}) {
  const s = SKINS[skin];
  if (!s) throw new Error(`unknown skin ${skin}`);
  const rows = cells.length, cols = cells[0].length;
  const frame = Math.round(pitch * 0.6);
  const headerH = chrome ? pitch * 3 : 0;
  const w = pad * 2 + cols * pitch + frame * 2;
  const h = pad * 2 + rows * pitch + frame * 2 + headerH;
  const canvas = createCanvas(w, h, s.page);

  if (chrome) {
    // Page furniture the board must not be confused with: a coloured banner and
    // a white content card. Both are large flat regions, which is exactly what
    // the board-finder is looking for.
    canvas.rect(0, 0, w, Math.round(pad * 0.6), [64, 110, 190]);
    canvas.rect(pad - 20, pad - 20, cols * pitch + frame * 2 + 40, 16, [244, 244, 246]);
  }

  const boardX = pad, boardY = pad + headerH;
  const gridX = boardX + frame, gridY = boardY + frame;
  canvas.rect(boardX, boardY, cols * pitch + frame * 2, rows * pitch + frame * 2, s.frame);

  if (chrome) {
    // The counter panels and the face, above the grid.
    canvas.rect(gridX, boardY - Math.round(headerH * 0.8),
      pitch * 2, Math.round(headerH * 0.5), [20, 20, 20]);
    canvas.rect(gridX + cols * pitch - pitch * 2, boardY - Math.round(headerH * 0.8),
      pitch * 2, Math.round(headerH * 0.5), [20, 20, 20]);
    const faceR = Math.round(pitch * 0.6);
    canvas.disc(gridX + (cols * pitch) / 2, boardY - Math.round(headerH * 0.55), faceR, [255, 212, 64]);
  }

  const bw = s.bevelWidth;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = gridX + c * pitch, y = gridY + r * pitch;
      const v = cells[r][c];
      const covered = v === null || v === "F";

      if (covered) {
        canvas.rect(x, y, pitch, pitch, s.covered);
        // Raised: lit along the top and left, shadowed along the bottom and right.
        canvas.rect(x, y, pitch, bw, s.light);
        canvas.rect(x, y, bw, pitch, s.light);
        canvas.rect(x, y + pitch - bw, pitch, bw, s.shadow);
        canvas.rect(x + pitch - bw, y, bw, pitch, s.shadow);
        if (v === "F") {
          const m = Math.round(pitch * 0.3);
          canvas.rect(x + m, y + m, Math.round(pitch * 0.35), Math.round(pitch * 0.3), [220, 20, 20]);
          canvas.rect(x + m, y + m, 2, Math.round(pitch * 0.45), [20, 20, 20]);
        }
        continue;
      }

      // Opened: flat, with a thin line along the top and left only.
      canvas.rect(x, y, pitch, pitch, s.opened);
      canvas.rect(x, y, pitch, 1, s.line);
      canvas.rect(x, y, 1, pitch, s.line);

      if (v === "*") {
        canvas.disc(x + pitch / 2, y + pitch / 2, pitch * 0.3, [16, 16, 16]);
      } else if (v > 0) {
        const colour = DIGIT_COLOURS[v];
        const glyph = GLYPHS[v];
        // Sized so the digit sits well inside the square, as a printed one does:
        // three strokes wide and five tall over roughly half the cell.
        const cw = Math.max(1, Math.floor(pitch / 8));
        const ox = x + Math.round((pitch - 3 * cw) / 2);
        const oy = y + Math.round((pitch - 5 * cw) / 2);
        for (let gy = 0; gy < 5; gy++) {
          for (let gx = 0; gx < 3; gx++) {
            if (glyph[gy][gx] === "1") canvas.rect(ox + gx * cw, oy + gy * cw, cw, cw, colour);
          }
        }
      }
    }
  }

  return { canvas, grid: { x: gridX, y: gridY, pitch, rows, cols } };
}

/** A board with a plausible mix: a cleared region, numbers, flags, covered rest. */
export function sampleBoard(rows, cols) {
  const cells = Array.from({ length: rows }, () => new Array(cols).fill(null));
  for (let r = 0; r < Math.min(rows, 6); r++) {
    for (let c = 0; c < Math.min(cols, 8); c++) {
      cells[r][c] = (r + c) % 4 === 0 ? 0 : ((r * 3 + c) % 8) + 1;
    }
  }
  cells[Math.min(2, rows - 1)][Math.min(9, cols - 1)] = "F";
  cells[Math.min(4, rows - 1)][Math.min(10, cols - 1)] = "F";
  return cells;
}
