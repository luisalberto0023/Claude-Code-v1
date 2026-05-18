// === Game entities: Frog, Vehicles, Logs, Coins, Power-ups ===

const TILE = 60;             // world is grid-based; render in pixels
const COLS = 9;              // playfield is 9 tiles wide (540 / 60)
const SCREEN_W = 540;
const SCREEN_H = 960;
// World convention: gridY increases as the player moves forward (up the screen).
// To render, we flip: lane at gridY=cameraY/TILE draws at the bottom row.
function screenY(worldY, cameraY) { return SCREEN_H - TILE/2 - (worldY - cameraY); }
function laneTopY(gridY, cameraY) { return SCREEN_H - TILE - (gridY * TILE - cameraY); }

// === Skin definitions: each gives a small perk (cosmetic-leaning) ===
const SKINS = {
  frog:     { name: 'Frog',       emoji: '🐸', color: '#6dffb1', perk: 'Balanced',         price: 0 },
  toad:     { name: 'Toad',       emoji: '🐸', color: '#ffd23b', perk: '+1 starting life', price: 500 },
  neon:     { name: 'Neon',       emoji: '🟢', color: '#00ffd5', perk: '+10% coin value',  price: 1500, gem: false },
  ninja:    { name: 'Ninja',      emoji: '🥷', color: '#a884ff', perk: 'Slow-mo lasts 50% longer', price: 3000 },
  astro:    { name: 'Astro',      emoji: '🧑‍🚀', color: '#88c5ff', perk: 'Bonus combo time',  price: 5000 },
  golden:   { name: 'Golden',     emoji: '🦁', color: '#ffb84d', perk: '+25% coin value',   price: 50, gem: true },
  cyber:    { name: 'Cyber',      emoji: '🤖', color: '#ff3bd9', perk: 'Magnet base radius +1', price: 80, gem: true },
  dragon:   { name: 'Dragon',     emoji: '🐲', color: '#ff5577', perk: 'Shield blocks 2 hits', price: 200, gem: true },
};

function skinDef(id) { return SKINS[id] || SKINS.frog; }

// === Frog (player) ===
class Frog {
  constructor(game) {
    this.game = game;
    this.gridX = Math.floor(COLS / 2);
    this.gridY = 0;            // 0 = starting lane (world coordinates)
    this.x = this.gridX * TILE + TILE/2;
    this.y = 0;                 // pixel-space; world.y is derived
    this.targetX = this.x;
    this.targetY = this.y;
    this.hopProgress = 1;       // 0..1
    this.hopFromX = this.x;
    this.hopFromY = this.y;
    this.facing = 0;            // 0=up, 1=right, 2=down, 3=left
    this.alive = true;
    this.ridingLog = null;
    this.ridingOffset = 0;
    this.skin = skinDef(Storage.get().activeSkin);
  }

  worldY() { return this.gridY * TILE; }

  hop(dx, dy) {
    if (!this.alive || this.hopProgress < 1) return false;
    const newGX = this.gridX + dx;
    if (newGX < 0 || newGX >= COLS) return false;
    const newGY = this.gridY + dy;
    if (newGY < this.game.world.minReachableY) return false; // can't go off bottom

    this.gridX = newGX;
    this.gridY = newGY;
    this.hopFromX = this.x;
    this.hopFromY = this.y;
    this.targetX = newGX * TILE + TILE/2;
    this.targetY = newGY * TILE;
    this.hopProgress = 0;
    if (dy < 0) this.facing = 0;
    else if (dy > 0) this.facing = 2;
    else if (dx > 0) this.facing = 1;
    else this.facing = 3;
    Audio.hop();
    if (navigator.vibrate && Storage.get().settings.haptics) navigator.vibrate(10);
    Storage.patch({ totalHops: Storage.get().totalHops + 1 });
    return true;
  }

  update(dt) {
    if (!this.alive) return;
    if (this.hopProgress < 1) {
      // While riding a log, drift BOTH endpoints with the log so the hop
      // still completes at the same logical offset relative to the log.
      // This fixes side-hops feeling stunted on water lanes.
      if (this.ridingLog) {
        const drift = this.ridingLog.vx * dt;
        this.hopFromX += drift;
        this.targetX += drift;
      }
      this.hopProgress = Math.min(1, this.hopProgress + dt * 10);
      const t = easeOutCubic(this.hopProgress);
      this.x = this.hopFromX + (this.targetX - this.hopFromX) * t;
      this.y = this.hopFromY + (this.targetY - this.hopFromY) * t;
    } else {
      this.x = this.targetX;
      this.y = this.targetY;
      if (this.ridingLog) {
        this.x += this.ridingLog.vx * dt;
        this.targetX = this.x;
        this.hopFromX = this.x;
      }
    }
    if (this.ridingLog && (this.x < -10 || this.x > COLS * TILE + 10)) {
      this.die('off-screen');
    }
  }

  die(reason) {
    if (!this.alive) return;
    this.alive = false;
    Audio.death();
    this.game.onPlayerDeath(reason);
  }

  draw(ctx, cameraY) {
    const sy = screenY(this.y, cameraY);
    ctx.save();
    ctx.translate(this.x, sy);
    const rot = [0, Math.PI/2, Math.PI, -Math.PI/2][this.facing];
    ctx.rotate(rot);
    // Airborne factor: 0 on the ground, 1 mid-hop
    const air = this.hopProgress < 1 ? Math.sin(this.hopProgress * Math.PI) : 0;
    // Shadow shrinks and softens during the airborne phase
    ctx.fillStyle = `rgba(0,0,0,${0.38 - air * 0.22})`;
    ctx.beginPath();
    ctx.ellipse(0, 20, 18 - air * 6, 6 - air * 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Squash on the ground, stretch in the air — sells the bounce
    const liftover = 1 - this.hopProgress;
    const launchSquash = this.hopProgress < 0.18 ? (1 - liftover) : 1;
    const sx = 1 + air * 0.10 - launchSquash * 0.04;
    const sy2 = 1 - air * 0.08 + launchSquash * 0.06;
    ctx.translate(0, -air * 16);
    ctx.scale(sx, sy2);
    drawFrogSprite(ctx, this.skin.color);
    ctx.restore();
  }
}

function drawFrogSprite(ctx, color) {
  // Stylized frog from primitives — no asset needed
  ctx.fillStyle = color;
  // body
  roundRect(ctx, -20, -10, 40, 30, 12); ctx.fill();
  // back legs
  ctx.fillStyle = shade(color, -0.15);
  roundRect(ctx, -22, 6, 12, 14, 6); ctx.fill();
  roundRect(ctx, 10, 6, 12, 14, 6); ctx.fill();
  // eyes
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(-9, -12, 7, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(9, -12, 7, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(-7, -11, 3, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(11, -11, 3, 0, Math.PI*2); ctx.fill();
  // cheek shine
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  roundRect(ctx, -16, -6, 12, 6, 3); ctx.fill();
}

// === Vehicle: car / truck / train ===
class Vehicle {
  constructor(opts) {
    Object.assign(this, opts);
    // x, y (world), w, h, vx, color, type
  }
  update(dt) { this.x += this.vx * dt; }
  draw(ctx, cameraY) {
    const sy = screenY(this.y, cameraY);
    ctx.save();
    ctx.translate(this.x, sy);

    const facing = this.vx >= 0 ? 1 : -1;
    const isTrain = this.type === 'train';
    const isTruck = this.type === 'truck';

    // Ground shadow, offset under the body
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.ellipse(2, this.h/2 + 1, this.w/2 - 4, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Wheels poke out from under the chassis — count scales with length
    const numWheels = Math.max(2, Math.floor(this.w / 55));
    const wheelR = isTrain ? 6 : 5;
    const wheelY = this.h/2 - 1;
    ctx.fillStyle = '#0c121e';
    for (let i = 0; i < numWheels; i++) {
      const t = numWheels === 1 ? 0.5 : i / (numWheels - 1);
      const wx = -this.w/2 + 14 + t * (this.w - 28);
      ctx.beginPath();
      ctx.arc(wx, wheelY, wheelR, 0, Math.PI * 2);
      ctx.fill();
      // hubcap shine
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.arc(wx - 1, wheelY - 1, wheelR * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0c121e';
    }

    // Body with vertical gradient (light top, dark belly)
    const grad = ctx.createLinearGradient(0, -this.h/2, 0, this.h/2);
    grad.addColorStop(0,    shade(this.color,  0.20));
    grad.addColorStop(0.5,  this.color);
    grad.addColorStop(1,    shade(this.color, -0.28));
    ctx.fillStyle = grad;
    roundRect(ctx, -this.w/2, -this.h/2, this.w, this.h, isTrain ? 6 : 9);
    ctx.fill();

    // Top gloss strip
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(ctx, -this.w/2 + 5, -this.h/2 + 3, this.w - 10, 4, 2);
    ctx.fill();

    // Dark belly band for depth
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    ctx.fillRect(-this.w/2 + 2, this.h/2 - 7, this.w - 4, 3);

    // Window(s) — dark blue glass with a glare strip
    ctx.fillStyle = '#172843';
    if (isTrain) {
      // Multiple porthole windows along the body
      const ports = Math.max(3, Math.floor(this.w / 80));
      const pw = 26, ph = this.h * 0.5;
      for (let i = 0; i < ports; i++) {
        const t = (i + 0.5) / ports;
        const px = -this.w/2 + t * this.w - pw/2;
        roundRect(ctx, px, -ph/2 - 2, pw, ph, 4);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.30)';
        ctx.fillRect(px + 3, -ph/2 + 1, pw - 10, 2);
        ctx.fillStyle = '#172843';
      }
    } else {
      const ww = this.w * (isTruck ? 0.24 : 0.34);
      const wy = -this.h/2 + 7;
      const wh = this.h - 16;
      const wx = facing > 0 ? this.w/2 - ww - 7 : -this.w/2 + 7;
      roundRect(ctx, wx, wy, ww, wh, 4); ctx.fill();
      // window glare
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(wx + 3, wy + 2, ww - 10, 2);
    }

    // Truck cargo seam (separator between cab and box)
    if (isTruck) {
      ctx.strokeStyle = shade(this.color, -0.40);
      ctx.lineWidth = 2;
      ctx.beginPath();
      const seamX = facing > 0
        ? this.w/2 - this.w * 0.35
        : -this.w/2 + this.w * 0.35;
      ctx.moveTo(seamX, -this.h/2 + 3);
      ctx.lineTo(seamX, this.h/2 - 4);
      ctx.stroke();
      // small cargo rivets
      ctx.fillStyle = shade(this.color, -0.45);
      const cargoStart = facing > 0 ? -this.w/2 + 6 : seamX + 4;
      const cargoEnd   = facing > 0 ? seamX - 4    : this.w/2 - 6;
      for (let cx = cargoStart + 6; cx < cargoEnd; cx += 10) {
        ctx.beginPath(); ctx.arc(cx, -this.h/2 + 6, 1.4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx, this.h/2 - 9,  1.4, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Headlights (front-facing only)
    ctx.fillStyle = '#fff8b0';
    if (facing > 0) {
      ctx.fillRect(this.w/2 - 1, -this.h/2 + 8, 3, 4);
      ctx.fillRect(this.w/2 - 1, this.h/2 - 12, 3, 4);
    } else {
      ctx.fillRect(-this.w/2 - 2, -this.h/2 + 8, 3, 4);
      ctx.fillRect(-this.w/2 - 2, this.h/2 - 12, 3, 4);
    }
    // Red tail lights opposite end
    ctx.fillStyle = '#ff4060';
    if (facing > 0) {
      ctx.fillRect(-this.w/2 - 1, -this.h/2 + 9, 2, 3);
      ctx.fillRect(-this.w/2 - 1, this.h/2 - 12, 2, 3);
    } else {
      ctx.fillRect(this.w/2 - 1, -this.h/2 + 9, 2, 3);
      ctx.fillRect(this.w/2 - 1, this.h/2 - 12, 2, 3);
    }

    ctx.restore();
  }
}

// === Floater: logs and lily pads on water lanes ===
class Floater {
  constructor(opts) { Object.assign(this, opts); }
  update(dt) { this.x += this.vx * dt; }
  draw(ctx, cameraY) {
    const sy = screenY(this.y, cameraY);
    ctx.save();
    ctx.translate(this.x, sy);
    if (this.type === 'log') {
      // Underside shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      roundRect(ctx, -this.w/2 + 2, this.h/2 - 6, this.w - 4, 7, 6); ctx.fill();
      // Main body with vertical gradient (top lit, bottom dark)
      const g = ctx.createLinearGradient(0, -this.h/2, 0, this.h/2);
      g.addColorStop(0, '#8a4f1d');
      g.addColorStop(0.5, '#6b3a14');
      g.addColorStop(1, '#48270c');
      ctx.fillStyle = g;
      roundRect(ctx, -this.w/2, -this.h/2, this.w, this.h, 10); ctx.fill();
      // bark grooves
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5;
      for (let i = -this.w/2 + 16; i < this.w/2 - 16; i += 22) {
        ctx.beginPath();
        ctx.moveTo(i, -this.h/2 + 6);
        ctx.lineTo(i + 4, this.h/2 - 6);
        ctx.stroke();
      }
      // ring detail at the ends
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(-this.w/2 + 9, 0, this.h/2 - 8, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.arc( this.w/2 - 9, 0, this.h/2 - 8, 0, Math.PI*2); ctx.stroke();
      // top highlight
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      roundRect(ctx, -this.w/2 + 6, -this.h/2 + 3, this.w - 12, 4, 2); ctx.fill();
    } else { // lily pad — bigger and leaf-shaped with a notch
      const rw = this.w / 2, rh = this.h / 2;
      // soft water shadow
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.ellipse(2, 4, rw, rh * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      // Outer pad (dark green rim) — full ellipse minus a wedge notch on the right
      ctx.fillStyle = '#1f6a2d';
      ctx.beginPath();
      ctx.ellipse(0, 0, rw, rh, 0, 0.13 * Math.PI, 1.87 * Math.PI);
      ctx.lineTo(0, 0);
      ctx.closePath();
      ctx.fill();
      // Inner pad (brighter green) — offset slightly up-left for top-light feel
      ctx.fillStyle = '#3aa550';
      ctx.beginPath();
      ctx.ellipse(-1, -2, rw - 4, rh - 4, 0, 0.16 * Math.PI, 1.84 * Math.PI);
      ctx.lineTo(-1, -2);
      ctx.closePath();
      ctx.fill();
      // Veins radiating from the notch (center) across the leaf
      ctx.strokeStyle = 'rgba(20, 60, 30, 0.55)';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 5; i++) {
        const a = Math.PI + (i / 4) * Math.PI; // 180° fanned across the left half
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * (rw - 5), Math.sin(a) * (rh - 5));
        ctx.stroke();
      }
      // Top-left specular highlight
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.ellipse(-rw * 0.35, -rh * 0.4, rw * 0.28, rh * 0.16, -0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// === Pickups: coin, gem, power-up ===
class Pickup {
  constructor(opts) {
    Object.assign(this, opts);
    this.bob = Math.random() * Math.PI * 2;
    this.collected = false;
  }
  update(dt) { this.bob += dt * 4; }
  draw(ctx, cameraY) {
    if (this.collected) return;
    const sy = screenY(this.y, cameraY) + Math.sin(this.bob) * 3;
    ctx.save();
    ctx.translate(this.x, sy);
    if (this.kind === 'coin') {
      ctx.fillStyle = '#ffd23b'; ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#a37300'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('¢', 0, 5);
    } else if (this.kind === 'gem') {
      ctx.fillStyle = '#ff3bd9';
      ctx.beginPath();
      ctx.moveTo(0, -12); ctx.lineTo(10, 0); ctx.lineTo(0, 12); ctx.lineTo(-10, 0);
      ctx.closePath(); ctx.fill();
    } else if (this.kind === 'shield') {
      ctx.fillStyle = '#00ffd5'; roundRect(ctx, -14, -14, 28, 28, 6); ctx.fill();
      ctx.fillStyle = '#06202b'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('🛡', 0, 6);
    } else if (this.kind === 'magnet') {
      ctx.fillStyle = '#ff5577'; roundRect(ctx, -14, -14, 28, 28, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('🧲', 0, 6);
    } else if (this.kind === 'slowmo') {
      ctx.fillStyle = '#a884ff'; roundRect(ctx, -14, -14, 28, 28, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('⏱', 0, 6);
    }
    ctx.restore();
  }
}

// === Obstacle on grass (tree/rock) ===
class Obstacle {
  constructor(opts) { Object.assign(this, opts); }
  draw(ctx, cameraY) {
    const sy = screenY(this.y, cameraY);
    ctx.save();
    ctx.translate(this.x, sy);
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, 16, 22, 8, 0, 0, Math.PI*2); ctx.fill();
    if (this.kind === 'tree') {
      ctx.fillStyle = '#4a2c12';
      ctx.fillRect(-6, -4, 12, 18);
      ctx.fillStyle = '#2a7a3b';
      ctx.beginPath(); ctx.arc(0, -16, 22, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#3aa050';
      ctx.beginPath(); ctx.arc(-4, -20, 14, 0, Math.PI*2); ctx.fill();
    } else { // rock
      ctx.fillStyle = '#7b87b3';
      ctx.beginPath();
      ctx.moveTo(-22, 12); ctx.lineTo(-14, -14); ctx.lineTo(10, -16);
      ctx.lineTo(22, 6); ctx.lineTo(14, 16);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#9ba8d0';
      ctx.beginPath();
      ctx.moveTo(-14, -14); ctx.lineTo(10, -16); ctx.lineTo(-2, -2);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
}

// === Helpers ===
function roundRect(ctx, x, y, w, h, r) {
  if (typeof r === 'number') r = { tl: r, tr: r, br: r, bl: r };
  ctx.beginPath();
  ctx.moveTo(x + r.tl, y);
  ctx.lineTo(x + w - r.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r.tr);
  ctx.lineTo(x + w, y + h - r.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
  ctx.lineTo(x + r.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r.bl);
  ctx.lineTo(x, y + r.tl);
  ctx.quadraticCurveTo(x, y, x + r.tl, y);
}

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function shade(hex, amount) {
  // amount in [-1,1]; -1=black, 1=white. Lightweight color tint.
  const c = hex.replace('#','');
  const num = parseInt(c, 16);
  let r = (num >> 16) & 0xff, g = (num >> 8) & 0xff, b = num & 0xff;
  if (amount < 0) {
    r = Math.max(0, r + r * amount);
    g = Math.max(0, g + g * amount);
    b = Math.max(0, b + b * amount);
  } else {
    r = Math.min(255, r + (255 - r) * amount);
    g = Math.min(255, g + (255 - g) * amount);
    b = Math.min(255, b + (255 - b) * amount);
  }
  const h = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  return '#' + h.toString(16).padStart(6, '0');
}
