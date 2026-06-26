import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const RES = '/home/user/Claude-Code-v1/android/app/src/main/res';

// The dots-and-boxes motif (cyan/pink neon lines + glowing dots), viewBox 300x300.
const MOTIF = `
  <g>
    <line x1="60" y1="60"  x2="150" y2="60"  stroke="#00f5ff"/>
    <line x1="150" y1="60" x2="240" y2="60"  stroke="#00f5ff"/>
    <line x1="240" y1="60" x2="240" y2="150" stroke="#ff0055"/>
    <line x1="60" y1="60"  x2="60" y2="150"  stroke="#00f5ff"/>
    <line x1="60" y1="150" x2="150" y2="150" stroke="#ff0055"/>
    <line x1="150" y1="150" x2="150" y2="240" stroke="#00f5ff"/>
    <line x1="150" y1="240" x2="240" y2="240" stroke="#ff0055"/>
    <line x1="240" y1="150" x2="240" y2="240" stroke="#00f5ff"/>
    <circle cx="60"  cy="60"  r="13" fill="#c0c0ff"/>
    <circle cx="150" cy="60"  r="13" fill="#c0c0ff"/>
    <circle cx="240" cy="60"  r="13" fill="#c0c0ff"/>
    <circle cx="60"  cy="150" r="13" fill="#c0c0ff"/>
    <circle cx="150" cy="150" r="13" fill="#c0c0ff"/>
    <circle cx="240" cy="150" r="13" fill="#c0c0ff"/>
    <circle cx="60"  cy="240" r="13" fill="#c0c0ff"/>
    <circle cx="150" cy="240" r="13" fill="#c0c0ff"/>
    <circle cx="240" cy="240" r="13" fill="#c0c0ff"/>
  </g>`;

// mode: 'full' (dark square), 'round' (dark circle), 'fg' (transparent, smaller for adaptive safe-zone)
function html(size, mode) {
  const bg = mode === 'fg' ? 'transparent' : '#030712';
  const motifScale = mode === 'fg' ? 0.52 : 0.66; // fraction of canvas the 300-unit motif spans
  const m = size * motifScale;
  const off = (size - m) / 2;
  const grid = mode === 'full' || mode === 'round'
    ? `background-image:linear-gradient(rgba(0,245,255,0.06) 2px,transparent 2px),linear-gradient(90deg,rgba(0,245,255,0.06) 2px,transparent 2px);background-size:${size/8}px ${size/8}px;`
    : '';
  const clip = mode === 'round' ? `border-radius:50%;` : '';
  return `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0}
    #c{width:${size}px;height:${size}px;background:${bg};${grid}${clip}position:relative;overflow:hidden}
    svg{position:absolute;left:${off}px;top:${off}px}
    line{stroke-width:${14*(m/300)}px;stroke-linecap:round}
  </style></head><body><div id="c">
    <svg width="${m}" height="${m}" viewBox="0 0 300 300">${MOTIF}</svg>
  </div></body></html>`;
}

const browser = await chromium.launch({ executablePath: EXE });

async function render(size, mode, outPath) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(html(size, mode));
  await page.waitForTimeout(60);
  const buf = await page.locator('#c').screenshot({ type: 'png', omitBackground: mode === 'fg' });
  fs.writeFileSync(outPath, buf);
  await page.close();
}

const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const fg     = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

for (const [d, s] of Object.entries(legacy)) {
  await render(s, 'full',  `${RES}/mipmap-${d}/ic_launcher.png`);
  await render(s, 'round', `${RES}/mipmap-${d}/ic_launcher_round.png`);
}
for (const [d, s] of Object.entries(fg)) {
  await render(s, 'fg', `${RES}/mipmap-${d}/ic_launcher_foreground.png`);
}

console.log('Android launcher icons generated.');
await browser.close();
