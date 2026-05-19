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

// === Stages and biomes ===
// 20 stages, each with a unique biome palette. Lane counts: stage N = 24 + N.
// Per-stage difficulty (camera base + traffic speed) is computed from id.
const BIOMES = {
  meadow:    { grass: '#3aa050', grassAlt: '#358a45', road: '#2a3050', roadStripe: '#ffe066', water: '#2a73b5', rail: '#3a3a3a' },
  forest:    { grass: '#1f5a2c', grassAlt: '#2a7a3b', road: '#3a2010', roadStripe: '#aaff66', water: '#1d4a6d', rail: '#3a3a3a' },
  beach:     { grass: '#f0d68a', grassAlt: '#d8c074', road: '#a08560', roadStripe: '#ffffff', water: '#56c8e0', rail: '#3a3a3a' },
  mountain:  { grass: '#7b8aa0', grassAlt: '#6a7a90', road: '#3a3850', roadStripe: '#dddddd', water: '#3a73b5', rail: '#5a5a5a' },
  desert:    { grass: '#d4a35a', grassAlt: '#b88845', road: '#5a4030', roadStripe: '#ffe066', water: '#56a0d0', rail: '#3a3a3a' },
  tundra:    { grass: '#d8e8f8', grassAlt: '#bccfe0', road: '#4a5a70', roadStripe: '#ffffff', water: '#7ab8d8', rail: '#3a3a3a' },
  volcanic:  { grass: '#3a1a14', grassAlt: '#4a201a', road: '#1a0808', roadStripe: '#ff6620', water: '#c93810', rail: '#3a3a3a' },
  jungle:    { grass: '#2a6a1a', grassAlt: '#3a8a25', road: '#3a2818', roadStripe: '#aaff44', water: '#2a8a4a', rail: '#3a3a3a' },
  swamp:     { grass: '#4a5a3a', grassAlt: '#3a4a2a', road: '#3a3020', roadStripe: '#88aa44', water: '#4a6a3a', rail: '#3a3a3a' },
  city:      { grass: '#5a5a5a', grassAlt: '#454545', road: '#1a1a1a', roadStripe: '#ffe066', water: '#3a73b5', rail: '#3a3a3a' },
  underwater:{ grass: '#1a4a6a', grassAlt: '#2a5a7a', road: '#0a2a3a', roadStripe: '#88e8ff', water: '#1a6a9a', rail: '#3a3a3a' },
  cloud:     { grass: '#e0e8ff', grassAlt: '#c8d4f8', road: '#7898ff', roadStripe: '#ffffff', water: '#a8c8ff', rail: '#5a5a5a' },
  space:     { grass: '#1a1030', grassAlt: '#251840', road: '#0a0820', roadStripe: '#ff3bd9', water: '#0a3050', rail: '#2a2050' },
  crystal:   { grass: '#a884ff', grassAlt: '#9070e0', road: '#3a2050', roadStripe: '#ffffff', water: '#88c8ff', rail: '#5a4080' },
  candy:     { grass: '#ff9bcc', grassAlt: '#ff7bb8', road: '#a04068', roadStripe: '#ffffff', water: '#ff5fb8', rail: '#5a3050' },
  toxic:     { grass: '#5aaa20', grassAlt: '#4a9a18', road: '#202820', roadStripe: '#aaff00', water: '#3a8a3a', rail: '#3a3a3a' },
  cyberpunk: { grass: '#222850', grassAlt: '#2c3470', road: '#0c0c1a', roadStripe: '#ff3bd9', water: '#003a55', rail: '#2a3050' },
  sunset:    { grass: '#ff8855', grassAlt: '#e07045', road: '#5a3020', roadStripe: '#ffd23b', water: '#ff5577', rail: '#5a3030' },
  aurora:    { grass: '#1a4a3a', grassAlt: '#2a6a4a', road: '#0a2820', roadStripe: '#88f5cc', water: '#1a5a7a', rail: '#3a3a3a' },
  mythic:    { grass: '#5a3070', grassAlt: '#4a2060', road: '#2a1040', roadStripe: '#ffd23b', water: '#7a4090', rail: '#5a3070' },
};

const STAGES = [
  { id: 1,  name: 'Meadow Crossing', biome: 'meadow' },
  { id: 2,  name: 'Forest Trail',    biome: 'forest' },
  { id: 3,  name: 'Beach Hop',       biome: 'beach' },
  { id: 4,  name: 'Mountain Pass',   biome: 'mountain' },
  { id: 5,  name: 'Desert Run',      biome: 'desert' },
  { id: 6,  name: 'Tundra Trek',     biome: 'tundra' },
  { id: 7,  name: 'Volcano Vault',   biome: 'volcanic' },
  { id: 8,  name: 'Jungle Jaunt',    biome: 'jungle' },
  { id: 9,  name: 'Swamp Skip',      biome: 'swamp' },
  { id: 10, name: 'City Limits',     biome: 'city' },
  { id: 11, name: 'Deep Dive',       biome: 'underwater' },
  { id: 12, name: 'Cloud Nine',      biome: 'cloud' },
  { id: 13, name: 'Star Sprint',     biome: 'space' },
  { id: 14, name: 'Crystal Cavern',  biome: 'crystal' },
  { id: 15, name: 'Candy Caper',     biome: 'candy' },
  { id: 16, name: 'Toxic Tide',      biome: 'toxic' },
  { id: 17, name: 'Neon Drive',      biome: 'cyberpunk' },
  { id: 18, name: 'Sunset Saga',     biome: 'sunset' },
  { id: 19, name: 'Aurora Echo',     biome: 'aurora' },
  { id: 20, name: 'Mythic Finale',   biome: 'mythic' },
];

function stageDef(id) { return STAGES.find(s => s.id === id) || STAGES[0]; }

function stageDifficulty(id) {
  const tier = Math.max(0, id - 1);
  return {
    cameraBase: 6 + tier * 1.5,           // 6 → 34.5 by stage 20
    carSpeedMult: 1 + tier * 0.10,        // 1.0 → 2.9 by stage 20
    floaterSpeedMult: 1 + tier * 0.07,    // 1.0 → 2.33 by stage 20
    lanes: 24 + id,                        // stage 1=25 lanes, stage 20=44
  };
}

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
    this.facing = 0;            // 0=back, 1=right, 2=forward, 3=left
    this.alive = true;
    this.ridingLog = null;
    this.logOffset = 0;         // pixel offset from grid-aligned x due to log drift
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
    // Target is RELATIVE to the current displayed position. This makes a
    // forward hop from a drifted log position go straight forward instead
    // of snapping horizontally to the grid mid-air (the old "side hop" bug).
    this.targetX = this.x + dx * TILE;
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
      // tracks the moving platform underneath it.
      if (this.ridingLog) {
        const drift = this.ridingLog.vx * dt;
        this.hopFromX += drift;
        this.targetX += drift;
        this.logOffset += drift;
      }
      this.hopProgress = Math.min(1, this.hopProgress + dt * 10);
      const t = easeOutCubic(this.hopProgress);
      this.x = this.hopFromX + (this.targetX - this.hopFromX) * t;
      this.y = this.hopFromY + (this.targetY - this.hopFromY) * t;
    } else {
      this.y = this.targetY;
      if (this.ridingLog) {
        const drift = this.ridingLog.vx * dt;
        this.x = this.targetX + drift;
        this.logOffset += drift;
        this.targetX = this.x;
        this.hopFromX = this.x;
      } else {
        // Not on a log → smoothly slide to grid-aligned column. Most hops
        // already land grid-aligned, so this is a no-op unless we just
        // stepped off a log onto land with a non-zero logOffset.
        const gridAlignedX = this.gridX * TILE + TILE/2;
        const diff = gridAlignedX - this.x;
        if (Math.abs(diff) > 0.5) {
          this.x += diff * Math.min(1, dt * 14);
        } else {
          this.x = gridAlignedX;
        }
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
    // facing: 0=backward(down), 1=right, 2=forward(up), 3=left.
    // Sprites are authored with head at local -y; rotate so that local-up
    // maps to the screen direction the player just hopped.
    const rot = [Math.PI, Math.PI/2, 0, -Math.PI/2][this.facing];
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
    // Dispatch to the right species sprite + color
    const s = Storage.get();
    let species, color;
    if (s.useCustom) {
      species = s.customSpecies || 'frog';
      color = s.customColor || '#6dffb1';
    } else {
      species = 'frog';
      color = this.skin.color;
    }
    drawSpriteFor(ctx, species, color);
    ctx.restore();
  }
}

function drawSpriteFor(ctx, species, color) {
  if (species === 'rabbit')      drawRabbitSprite(ctx, color);
  else if (species === 'kangaroo') drawKangarooSprite(ctx, color);
  else                              drawFrogSprite(ctx, color);
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

function drawRabbitSprite(ctx, color) {
  const dark = shade(color, -0.18);
  const light = shade(color, 0.20);
  const innerEar = '#ffb8d0';
  // cottontail behind
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(0, 18, 5, 0, Math.PI*2); ctx.fill();
  // back legs poking out
  ctx.fillStyle = dark;
  roundRect(ctx, -16, 8, 10, 12, 5); ctx.fill();
  roundRect(ctx, 6, 8, 10, 12, 5); ctx.fill();
  // body (round, fluffy)
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, 4, 16, 14, 0, 0, Math.PI*2); ctx.fill();
  // belly highlight
  ctx.fillStyle = light;
  ctx.beginPath(); ctx.ellipse(0, 10, 8, 5, 0, 0, Math.PI*2); ctx.fill();
  // head
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, -8, 13, 12, 0, 0, Math.PI*2); ctx.fill();
  // ears (tall, slight outward tilt)
  ctx.beginPath(); ctx.ellipse(-7, -22, 4, 12, -0.18, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(7, -22, 4, 12,  0.18, 0, Math.PI*2); ctx.fill();
  // inner ear (pink)
  ctx.fillStyle = innerEar;
  ctx.beginPath(); ctx.ellipse(-7, -22, 2, 8, -0.18, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(7, -22, 2, 8,  0.18, 0, Math.PI*2); ctx.fill();
  // eyes
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(-5, -9, 2.4, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( 5, -9, 2.4, 0, Math.PI*2); ctx.fill();
  // eye shine
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(-4, -10, 0.8, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( 6, -10, 0.8, 0, Math.PI*2); ctx.fill();
  // nose (tiny pink triangle)
  ctx.fillStyle = '#ff5fb8';
  ctx.beginPath();
  ctx.moveTo(0, -3); ctx.lineTo(-2.2, -1); ctx.lineTo(2.2, -1);
  ctx.closePath(); ctx.fill();
  // whisker hint
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-2, 0); ctx.lineTo(-8, -1);
  ctx.moveTo( 2, 0); ctx.lineTo( 8, -1);
  ctx.stroke();
}

function drawKangarooSprite(ctx, color) {
  const dark = shade(color, -0.16);
  const light = shade(color, 0.20);
  // tail curling behind
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-2, 14);
  ctx.quadraticCurveTo(14, 18, 19, 11);
  ctx.quadraticCurveTo(21, 7, 18, 5);
  ctx.quadraticCurveTo(13, 11, -2, 9);
  ctx.closePath();
  ctx.fill();
  // big back legs
  roundRect(ctx, -14, 4, 9, 16, 4); ctx.fill();
  roundRect(ctx, 5,  4, 9, 16, 4); ctx.fill();
  // body (pear-shaped, sitting upright)
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, 2, 12, 16, 0, 0, Math.PI*2); ctx.fill();
  // pouch / lighter belly
  ctx.fillStyle = light;
  ctx.beginPath(); ctx.ellipse(0, 8, 7, 6, 0, 0, Math.PI*2); ctx.fill();
  // small front paws
  ctx.fillStyle = dark;
  roundRect(ctx, -7, 0, 4, 5, 2); ctx.fill();
  roundRect(ctx, 3,  0, 4, 5, 2); ctx.fill();
  // head
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.ellipse(0, -13, 9, 10, 0, 0, Math.PI*2); ctx.fill();
  // pointed snout
  ctx.beginPath();
  ctx.moveTo(0, -22); ctx.lineTo(4.5, -16); ctx.lineTo(-4.5, -16);
  ctx.closePath(); ctx.fill();
  // snout tip
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(0, -21, 1.2, 0, Math.PI*2); ctx.fill();
  // pointy ears
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-6, -18); ctx.lineTo(-10, -27); ctx.lineTo(-3, -22);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(6, -18); ctx.lineTo(10, -27); ctx.lineTo(3, -22);
  ctx.closePath(); ctx.fill();
  // inner ear
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(-5, -20); ctx.lineTo(-8, -24); ctx.lineTo(-4, -22);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(5, -20); ctx.lineTo(8, -24); ctx.lineTo(4, -22);
  ctx.closePath(); ctx.fill();
  // eyes
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(-3, -13, 1.8, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( 3, -13, 1.8, 0, Math.PI*2); ctx.fill();
  // eye shine
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(-2.4, -13.6, 0.7, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( 3.4, -13.6, 0.7, 0, Math.PI*2); ctx.fill();
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
