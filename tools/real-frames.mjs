// Real screen captures, kept so the reader can be tested against the thing it
// actually has to read.
//
// Drawn fixtures establish that the reader survives a change of skin. They
// cannot establish that it reads minesweeper.online, because they are drawn to
// somebody's idea of what that looks like — and every serious bug so far has
// lived in the gap between the two. These frames came off the real site during
// a run, through the same capture path the agent uses, cursor and all.
//
// Stored as raw RGB, deflated. A PNG would need a decoder; this needs zlib,
// which node already has. ~60KB each.

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { createCanvas } from "./fake-canvas.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "frames");

export function listFrames() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""));
}

/** Load a stored capture as something the readers can take an image from. */
export function loadFrame(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), "utf8"));
  const rgb = zlib.inflateSync(fs.readFileSync(path.join(DIR, `${name}.rgb.z`)));
  const canvas = createCanvas(meta.width, meta.height);
  for (let i = 0, n = meta.width * meta.height; i < n; i++) {
    canvas.data[i * 4] = rgb[i * 3];
    canvas.data[i * 4 + 1] = rgb[i * 3 + 1];
    canvas.data[i * 4 + 2] = rgb[i * 3 + 2];
    canvas.data[i * 4 + 3] = 255;
  }
  return { canvas, meta };
}
