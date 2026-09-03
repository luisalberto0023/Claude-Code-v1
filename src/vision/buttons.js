// ── Generic clickable-element detection ───────────────────────────────────────
//
// Finding what can be clicked on an unfamiliar screen, without knowing the game.
//
// This exists because the two things needed at a decision point come from
// different places. WHERE to click has to be exact — a coordinate that is
// twenty pixels out clicks nothing, or worse, the wrong control — and pixels
// give that precisely. WHAT a control means is a question about language and
// intent, which pixels cannot answer and a model can. So geometry is measured
// here and meaning is asked for separately, rather than asking a model to
// estimate coordinates it has no reliable way to know.
//
// A button, across almost every game and UI, is a compact block of near-uniform
// colour that stands out from what surrounds it and has something drawn inside
// it. That is what this looks for.

function at(data, w, x, y) {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Find plausible clickable elements in a region of the screen.
 *
 * @param {HTMLCanvasElement} canvasEl  full-resolution frame
 * @param {object} [region]  {x,y,w,h} to search; defaults to the whole frame
 * @returns {Array} candidates, most button-like first, each with the centre to
 *   click, its bounds, its fill colour, and how much of its area is occupied by
 *   contrasting content (`inkFrac` — the label drawn on it).
 */
export function findClickableCandidates(canvasEl, region = null) {
  if (!canvasEl || !canvasEl.width || !canvasEl.height) return [];
  const w = canvasEl.width, h = canvasEl.height;
  let data;
  try {
    data = canvasEl.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  } catch { return []; }

  const rx = Math.max(0, region?.x ?? 0);
  const ry = Math.max(0, region?.y ?? 0);
  const rw = Math.min(w - rx, region?.w ?? w);
  const rh = Math.min(h - ry, region?.h ?? h);
  if (rw < 20 || rh < 20) return [];

  // Work on a coarse grid: buttons are large relative to a pixel, and this keeps
  // the component pass cheap on a full-resolution frame.
  const step = Math.max(1, Math.round(Math.min(w, h) / 360));
  const gw = Math.floor(rw / step), gh = Math.floor(rh / step);
  if (gw < 6 || gh < 6) return [];

  // Quantise so antialiasing and gradients inside one control do not split it.
  const QUANT = 24;
  const key = new Int32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const c = at(data, w, rx + gx * step, ry + gy * step);
      key[gy * gw + gx] =
        (Math.round(c[0] / QUANT) << 16) | (Math.round(c[1] / QUANT) << 8) | Math.round(c[2] / QUANT);
    }
  }

  const seen = new Uint8Array(gw * gh);
  const queue = new Int32Array(gw * gh);
  const out = [];

  for (let s = 0; s < key.length; s++) {
    if (seen[s]) continue;
    const k = key[s];
    let head = 0, tail = 0;
    queue[tail++] = s; seen[s] = 1;
    let minX = gw, minY = gh, maxX = -1, maxY = -1, n = 0;
    while (head < tail) {
      const p = queue[head++];
      const px = p % gw, py = (p / gw) | 0;
      n++;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (px > 0)      { const q = p - 1;  if (!seen[q] && key[q] === k) { seen[q] = 1; queue[tail++] = q; } }
      if (px < gw - 1) { const q = p + 1;  if (!seen[q] && key[q] === k) { seen[q] = 1; queue[tail++] = q; } }
      if (py > 0)      { const q = p - gw; if (!seen[q] && key[q] === k) { seen[q] = 1; queue[tail++] = q; } }
      if (py < gh - 1) { const q = p + gw; if (!seen[q] && key[q] === k) { seen[q] = 1; queue[tail++] = q; } }
    }

    const bw = (maxX - minX + 1) * step, bh = (maxY - minY + 1) * step;
    // Plausible size for something a person is meant to click.
    if (bw < 44 || bh < 18 || bw > rw * 0.6 || bh > rh * 0.35) continue;
    // Wider than tall, as labelled controls almost always are.
    const aspect = bw / bh;
    if (aspect < 1.2 || aspect > 12) continue;
    // Solid: a real control fills its own bounding box, unlike a stray shape.
    const fill = n / (((maxX - minX + 1) * (maxY - minY + 1)) || 1);
    if (fill < 0.7) continue;

    const x = rx + minX * step, y = ry + minY * step;
    const fillColour = at(data, w, x + Math.round(bw / 2), y + 2);

    // Something must be drawn on it. A blank panel of colour is not a button;
    // a label, glyph or icon is what makes it one.
    let ink = 0, total = 0;
    for (let yy = y + Math.round(bh * 0.25); yy < y + Math.round(bh * 0.75); yy += 2) {
      for (let xx = x + Math.round(bw * 0.1); xx < x + Math.round(bw * 0.9); xx += 2) {
        if (xx >= w || yy >= h) continue;
        total++;
        if (dist2(at(data, w, xx, yy), fillColour) > 2000) ink++;
      }
    }
    const inkFrac = total ? ink / total : 0;
    if (inkFrac < 0.04 || inkFrac > 0.7) continue;

    // It has to stand out from its surroundings, or it is part of the backdrop.
    let contrast = 0, samples = 0;
    for (const [ox, oy] of [[-6, bh / 2], [bw + 6, bh / 2], [bw / 2, -6], [bw / 2, bh + 6]]) {
      const sx = Math.round(x + ox), sy = Math.round(y + oy);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      samples++;
      if (dist2(at(data, w, sx, sy), fillColour) > 1200) contrast++;
    }
    if (!samples || contrast / samples < 0.5) continue;

    out.push({
      x, y, w: bw, h: bh,
      cx: Math.round(x + bw / 2),
      cy: Math.round(y + bh / 2),
      fill: fillColour,
      inkFrac: Number(inkFrac.toFixed(3)),
      area: bw * bh,
    });
  }

  // Reading order: top to bottom, then left to right, so labels a model returns
  // for "the buttons on screen" line up with what was found.
  out.sort((a, b) => (Math.abs(a.cy - b.cy) > 20 ? a.cy - b.cy : a.cx - b.cx));
  return out.slice(0, 12);
}

export default findClickableCandidates;
