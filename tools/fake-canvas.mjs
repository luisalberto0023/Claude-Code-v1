// A canvas just real enough for the board readers.
//
// The plugins only ever ask a canvas for its width, its height, and one
// getImageData over the whole thing, so that is all this provides. It exists so
// the readers can be exercised in node against pictures built on purpose,
// without a browser and without a screen.

export function createCanvas(w, h, fill = [255, 255, 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  const canvas = {
    width: w,
    height: h,
    data,
    getContext: () => ({ getImageData: () => ({ data, width: w, height: h }) }),
  };
  canvas.set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  };
  canvas.get = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  canvas.rect = (x, y, rw, rh, c) => {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) canvas.set(xx, yy, c);
  };
  canvas.disc = (cx, cy, r, c) => {
    for (let yy = Math.floor(cy - r); yy <= cy + r; yy++) {
      for (let xx = Math.floor(cx - r); xx <= cx + r; xx++) {
        if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) canvas.set(xx, yy, c);
      }
    }
  };
  return canvas;
}
