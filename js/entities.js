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
      this.hopProgress = Math.min(1, this.hopProgress + dt * 9);
      const t = easeOutBack(this.hopProgress);
      this.x = this.hopFromX + (this.targetX - this.hopFromX) * t;
      this.y = this.hopFromY + (this.targetY - this.hopFromY) * t;
    } else {
      this.x = this.targetX;
      this.y = this.targetY;
    }

    // If on a log/lily, drift with it
    if (this.ridingLog) {
      this.x += this.ridingLog.vx * dt;
      this.targetX = this.x;
      this.hopFromX = this.x;
      // Off-screen guard
      if (this.x < -10 || this.x > COLS * TILE + 10) this.die('off-screen');
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
    // Rotation by facing
    const rot = [0, Math.PI/2, Math.PI, -Math.PI/2][this.facing];
    ctx.rotate(rot);
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(0, 18, 18, 6, 0, 0, Math.PI*2); ctx.fill();
    // Body
    const hopBoost = Math.sin(this.hopProgress * Math.PI) * 8;
    ctx.translate(0, -hopBoost);
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
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, -this.w/2 + 3, this.h/2 - 8, this.w - 6, 6, 4); ctx.fill();
    // body
    ctx.fillStyle = this.color;
    roundRect(ctx, -this.w/2, -this.h/2, this.w, this.h, 10); ctx.fill();
    // window
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    const ww = this.w * 0.35;
    if (this.vx > 0) {
      roundRect(ctx, this.w/2 - ww - 6, -this.h/2 + 6, ww, this.h - 12, 6); ctx.fill();
    } else {
      roundRect(ctx, -this.w/2 + 6, -this.h/2 + 6, ww, this.h - 12, 6); ctx.fill();
    }
    // headlights
    ctx.fillStyle = '#fff8b0';
    if (this.vx > 0) {
      ctx.fillRect(this.w/2 - 2, -this.h/2 + 6, 3, 4);
      ctx.fillRect(this.w/2 - 2, this.h/2 - 10, 3, 4);
    } else {
      ctx.fillRect(-this.w/2 - 1, -this.h/2 + 6, 3, 4);
      ctx.fillRect(-this.w/2 - 1, this.h/2 - 10, 3, 4);
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
      ctx.fillStyle = '#6b3a14';
      roundRect(ctx, -this.w/2, -this.h/2, this.w, this.h, 10); ctx.fill();
      ctx.strokeStyle = '#4a280d'; ctx.lineWidth = 2;
      for (let i = -this.w/2 + 10; i < this.w/2 - 10; i += 18) {
        ctx.beginPath(); ctx.arc(i, 0, 3, 0, Math.PI*2); ctx.stroke();
      }
    } else { // lily
      ctx.fillStyle = '#2a7a3b';
      ctx.beginPath(); ctx.arc(0, 0, this.h/2, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#3aa050';
      ctx.beginPath(); ctx.arc(0, 0, this.h/2 - 6, 0, Math.PI*2); ctx.fill();
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
