// ── Where a pixel of a frame is on the screen ─────────────────────────────────
//
// Every frame the agent looks at is the screen, a window or a crop of either,
// drawn at some size. A point in a frame's pixels maps to the screen by one
// rule: multiply by the frame's scale, then add its offset. The page keeps that
// scale next to each canvas it draws on ({imgW, imgH, realW, realH, scale,
// offsetX, offsetY}) and updates it as the frame is captured, cropped and
// shrunk. This module is the arithmetic of both, so that every click the agent
// works out itself goes from a frame to the screen the same way.
//
// It did not always. The decision dialog's option was clicked at its point
// divided by the scale, with the offsets dropped, while the model's clicks, the
// solver's and the restart's multiplied and added them. That went unnoticed
// only because the solver's capture is at full size on most displays (scale 1,
// no offsets): on a crop, or native capture of a window, the option would have
// been clicked somewhere else on the screen.
//
// Pure: no canvas, no DOM. GameAgent.jsx's captureFrame, applyCrop,
// downscaleCanvas and drawFrame keep a frame's scale with the functions below,
// and every click the page decides on (a model's click, the solver's move, a
// restart button, a decision's option) goes through toScreen.

/** The part of a frame's scale a point needs: a scale above 0 (else 1), and offsets (else 0). */
export function scaleOf(s) {
  const scale = Number(s?.scale);
  return {
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    offsetX: Number.isFinite(Number(s?.offsetX)) ? Number(s.offsetX) : 0,
    offsetY: Number.isFinite(Number(s?.offsetY)) ? Number(s.offsetY) : 0,
  };
}

/** A point in the frame's pixels as a point on the screen, in whole pixels. */
export function toScreen(point, s) {
  const { scale, offsetX, offsetY } = scaleOf(s);
  return {
    x: Math.round(offsetX + Number(point?.x) * scale),
    y: Math.round(offsetY + Number(point?.y) * scale),
  };
}

/**
 * A point on the screen as a point in the frame's pixels: toScreen undone. Not
 * rounded, since change detection judges fractions of a cell by where they are.
 */
export function toFrame(point, s) {
  const { scale, offsetX, offsetY } = scaleOf(s);
  return {
    x: (Number(point?.x) - offsetX) / scale,
    y: (Number(point?.y) - offsetY) / scale,
  };
}

/**
 * The scale of a frame just captured: a picture `realW`×`realH` on the screen,
 * drawn `imgW`×`imgH`, whose top left corner is at (offsetX, offsetY) on the
 * screen: (0, 0) for a browser's share of the whole screen, the window's corner
 * for native capture of a window.
 */
export function capturedScale({ realW, realH, imgW, imgH, offsetX = 0, offsetY = 0 }) {
  return { imgW, imgH, realW, realH, scale: imgW ? realW / imgW : 1, offsetX: offsetX ?? 0, offsetY: offsetY ?? 0 };
}

/**
 * The part of a `width`×`height` frame a crop keeps, from its margins in percent
 * ({top, right, bottom, left}): {left, top, width, height} in the frame's pixels.
 * Null when there is nothing to cut, or when the crop would leave less than
 * 16 px either way (too aggressive: skipped rather than break the frame).
 */
export function cropBox(width, height, margins = {}) {
  const m = margins ?? {};
  const left = Math.round((Math.max(0, m.left ?? 0) / 100) * width);
  const top = Math.round((Math.max(0, m.top ?? 0) / 100) * height);
  const right = Math.round((Math.max(0, m.right ?? 0) / 100) * width);
  const bottom = Math.round((Math.max(0, m.bottom ?? 0) / 100) * height);
  const w = width - left - right, h = height - top - bottom;
  if (w < 16 || h < 16) return null;
  if (left === 0 && top === 0 && right === 0 && bottom === 0) return null;
  return { left, top, width: w, height: h };
}

/**
 * The scale of a frame after a crop (cropBox) cut it: a pure cut, no rescale,
 * so the scale stays and the crop's corner moves the offsets.
 */
export function croppedScale(s, box) {
  const { scale, offsetX, offsetY } = scaleOf(s);
  return {
    imgW: box.width, imgH: box.height,
    realW: Math.round(box.width * scale), realH: Math.round(box.height * scale),
    scale,
    offsetX: offsetX + box.left * scale,
    offsetY: offsetY + box.top * scale,
  };
}

/** The scale of a frame after it was shrunk to `newW`×`newH`: the offsets stay. */
export function shrunkScale(s, newW, newH) {
  return { ...s, imgW: newW, imgH: newH, scale: newW ? s.realW / newW : 1 };
}

/**
 * A box {x, y, w, h} in one frame's pixels (scale `from`) as the same place in
 * another frame of the same screen (scale `to`): through the screen, unrounded.
 * A control measured on a full-size capture is found again on the page's
 * smaller frame this way.
 */
export function mapBox(box, from, to) {
  const a = scaleOf(from), b = scaleOf(to);
  const x = (a.offsetX + Number(box.x) * a.scale - b.offsetX) / b.scale;
  const y = (a.offsetY + Number(box.y) * a.scale - b.offsetY) / b.scale;
  return { x, y, w: Number(box.w) * a.scale / b.scale, h: Number(box.h) * a.scale / b.scale };
}
