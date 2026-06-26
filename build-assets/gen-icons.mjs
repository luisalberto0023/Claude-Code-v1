import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ICON = pathToFileURL('/home/user/Claude-Code-v1/build-assets/icon.html').href;
const OUT = '/home/user/Claude-Code-v1/public/icons';

const browser = await chromium.launch({ executablePath: EXE });

async function shot(size, file, pad = 0) {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.goto(ICON, { waitUntil: 'networkidle' });
  const el = page.locator('#icon');
  // For maskable: shrink the inner svg so content sits in the safe zone.
  if (pad) {
    await page.evaluate((p) => {
      const svg = document.querySelector('svg');
      svg.style.transform = `scale(${1 - p})`;
    }, pad);
  }
  const buf = await el.screenshot({ type: 'png' });
  await page.close();
  // resize via a second page draw to target size
  const page2 = await browser.newPage({ viewport: { width: size, height: size } });
  const b64 = buf.toString('base64');
  await page2.setContent(`<html><body style="margin:0"><img src="data:image/png;base64,${b64}" style="width:${size}px;height:${size}px;display:block"></body></html>`);
  await page2.waitForTimeout(100);
  const out = await page2.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size, height: size } });
  fs.writeFileSync(`${OUT}/${file}`, out);
  await page2.close();
  console.log(`wrote ${file} (${size}x${size})`);
}

await shot(192, 'icon-192.png');
await shot(512, 'icon-512.png');
await shot(512, 'icon-maskable-512.png', 0.18);
await shot(180, 'apple-touch-icon.png');

await browser.close();
