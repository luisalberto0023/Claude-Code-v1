// === World: lane generation, scrolling, theming ===
//
// Lanes are generated procedurally as the player progresses upward.
// Each lane belongs to one of: GRASS, ROAD, WATER, RAIL.
// Themes shift every BIOME_LEN lanes to keep visuals fresh.

const LANE = { GRASS: 'grass', ROAD: 'road', WATER: 'water', RAIL: 'rail' };
const BIOME_LEN = 25;
const BIOMES = [
  { id: 'meadow',    grass: '#3aa050', grassAlt: '#358a45', road: '#2a3050',
    roadStripe: '#ffe066', water: '#2a73b5', rail: '#3a3a3a' },
  { id: 'desert',    grass: '#d4a35a', grassAlt: '#b88845', road: '#5a4030',
    roadStripe: '#ffe066', water: '#56a0d0', rail: '#3a3a3a' },
  { id: 'cyber',     grass: '#222850', grassAlt: '#2c3470', road: '#0c0c1a',
    roadStripe: '#ff3bd9', water: '#003a55', rail: '#2a3050' },
  { id: 'lava',      grass: '#3a1a14', grassAlt: '#4a201a', road: '#1a0808',
    roadStripe: '#ff6620', water: '#c93810', rail: '#3a3a3a' },
];

class World {
  constructor(game) {
    this.game = game;
    this.lanes = [];           // lanes[i] holds the lane with gridY = i
    this.minReachableY = 0;
    this.maxGeneratedY = -1;
    this.theme = BIOMES[0];
    this.themeIndex = 0;
    this.cameraY = 0;          // world Y at the back of the visible area
    this.scrollSpeed = 12;
    this.scrollAccel = 0.6;
    this.scrollPaused = 0;

    // First 3 lanes are safe grass so the player gets a beat to read the field
    for (let i = 0; i <= 2; i++) {
      this.lanes.push({ type: LANE.GRASS, gridY: i, entities: [],
                        coins: this._maybeCoin(i, 0.1), obstacles: [] });
      this.maxGeneratedY = i;
    }
    this.generateLanesUntil(20);
  }

  laneAt(gridY) {
    if (gridY < 0 || gridY >= this.lanes.length) return null;
    return this.lanes[gridY];
  }

  generateLanesUntil(untilGy) {
    while (this.maxGeneratedY < untilGy) {
      const gy = this.maxGeneratedY + 1;
      this.lanes.push(this.makeLane(gy, false));
      this.maxGeneratedY = gy;
      const biomeIdx = Math.floor(gy / BIOME_LEN) % BIOMES.length;
      if (biomeIdx !== this.themeIndex) {
        this.themeIndex = biomeIdx;
        this.theme = BIOMES[biomeIdx];
      }
    }
  }

  makeLane(gy, safe) {
    if (safe || gy === 0) {
      return { type: LANE.GRASS, gridY: gy, entities: [],
               coins: this._maybeCoin(gy, 0.15), obstacles: [] };
    }
    // Avoid back-to-back water/rail lanes too aggressively
    const last = this.lanes[this.lanes.length - 1];
    const lastType = last ? last.type : LANE.GRASS;
    let type = pickLaneType(lastType, gy);

    const lane = { type, gridY: gy, entities: [], coins: [], obstacles: [] };
    if (type === LANE.GRASS) {
      lane.obstacles = this._spawnObstacles(gy);
      lane.coins = this._maybeCoin(gy, 0.25);
    } else if (type === LANE.ROAD) {
      lane.entities = this._spawnTraffic(gy);
      lane.coins = this._maybeCoin(gy, 0.10);
    } else if (type === LANE.WATER) {
      lane.entities = this._spawnFloaters(gy);
      lane.coins = this._maybeCoin(gy, 0.18);
    } else if (type === LANE.RAIL) {
      lane.trainTimer = 4 + Math.random() * 5;
      lane.trainPending = false;
    }
    // Power-up sprinkle
    if (Math.random() < 0.03) {
      const kinds = ['shield', 'magnet', 'slowmo'];
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const px = (1 + Math.floor(Math.random() * (COLS - 2))) * TILE + TILE/2;
      lane.coins.push(new Pickup({ x: px, y: gy * TILE, kind }));
    }
    return lane;
  }

  _maybeCoin(gy, p) {
    const coins = [];
    for (let cx = 0; cx < COLS; cx++) {
      if (Math.random() < p) {
        coins.push(new Pickup({
          x: cx * TILE + TILE/2, y: gy * TILE,
          kind: Math.random() < 0.04 ? 'gem' : 'coin',
        }));
      }
    }
    return coins;
  }

  _spawnObstacles(gy) {
    const obs = [];
    const slots = new Set();
    const n = Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(Math.random() * COLS);
      if (slots.has(cx)) continue;
      slots.add(cx);
      obs.push(new Obstacle({
        x: cx * TILE + TILE/2, y: gy * TILE,
        kind: Math.random() < 0.5 ? 'tree' : 'rock',
      }));
    }
    return obs;
  }

  _spawnTraffic(gy) {
    const cars = [];
    const dir = Math.random() < 0.5 ? -1 : 1;
    const baseSpeed = 80 + Math.random() * 90 + Math.min(120, gy * 1.4);
    const speed = baseSpeed * dir;
    const gap = 160 + Math.random() * 120;
    const startOffset = Math.random() * gap;
    for (let x = -200 + startOffset; x < COLS * TILE + 200; x += gap) {
      const truck = Math.random() < 0.3;
      cars.push(new Vehicle({
        x, y: gy * TILE,
        w: truck ? 110 : 70,
        h: 36,
        vx: speed,
        color: truck ? '#ff5577' : pickColor(),
        type: truck ? 'truck' : 'car',
      }));
    }
    return cars;
  }

  _spawnFloaters(gy) {
    const items = [];
    const dir = Math.random() < 0.5 ? -1 : 1;
    const speed = (40 + Math.random() * 70) * dir;
    const useLogs = Math.random() < 0.7;
    const gap = useLogs ? 180 + Math.random() * 80 : 110 + Math.random() * 60;
    const startOffset = Math.random() * gap;
    for (let x = -200 + startOffset; x < COLS * TILE + 200; x += gap) {
      if (useLogs) {
        items.push(new Floater({
          x, y: gy * TILE, w: 140, h: 38, vx: speed, type: 'log',
        }));
      } else {
        items.push(new Floater({
          x, y: gy * TILE, w: 50, h: 50, vx: speed, type: 'lily',
        }));
      }
    }
    return items;
  }

  update(dt) {
    // Auto-scroll pressure: rises with progress
    const tier = Math.min(60, this.game.frog.gridY) * 0.4;
    const target = 14 + tier;
    this.scrollSpeed += (target - this.scrollSpeed) * Math.min(1, dt * 0.5);
    let scroll = this.scrollSpeed * dt;
    if (this.scrollPaused > 0) {
      scroll *= 0.25;
      this.scrollPaused = Math.max(0, this.scrollPaused - dt);
    }
    this.cameraY += scroll;

    // Bottom kill: if the frog falls behind the camera, the hawk gets it
    if (this.game.frog.y < this.cameraY - 2 * TILE) {
      this.game.frog.die('hawk');
    }
    // Update min reachable lane (frog can't backtrack past the camera)
    this.minReachableY = Math.floor(this.cameraY / TILE);

    // Update entities on visible lanes
    const lo = Math.max(0, Math.floor(this.cameraY / TILE) - 2);
    const hi = Math.ceil((this.cameraY + this.game.height) / TILE) + 4;
    this.generateLanesUntil(hi + 4);
    for (let gy = lo; gy <= hi; gy++) {
      const lane = this.laneAt(gy);
      if (!lane) continue;
      if (lane.type === LANE.ROAD || lane.type === LANE.WATER) {
        for (const e of lane.entities) {
          e.update(dt);
          // wrap horizontally
          if (e.vx > 0 && e.x > COLS * TILE + 200) e.x -= COLS * TILE + 400;
          if (e.vx < 0 && e.x < -200) e.x += COLS * TILE + 400;
        }
      } else if (lane.type === LANE.RAIL) {
        lane.trainTimer -= dt;
        if (lane.trainTimer <= 0 && !lane.trainPending) {
          lane.trainPending = true;
          lane.trainWarning = 1.0; // 1 sec warning
          lane.trainTimer = 6 + Math.random() * 5;
        }
        if (lane.trainPending) {
          lane.trainWarning -= dt;
          if (lane.trainWarning <= 0) {
            const dir = Math.random() < 0.5 ? -1 : 1;
            lane.activeTrain = new Vehicle({
              x: dir > 0 ? -200 : COLS * TILE + 200, y: gy * TILE,
              w: 480, h: 44, vx: 460 * dir, color: '#dd1133', type: 'train',
            });
            lane.trainPending = false;
          }
        }
        if (lane.activeTrain) {
          lane.activeTrain.update(dt);
          if (lane.activeTrain.x < -300 || lane.activeTrain.x > COLS * TILE + 300) {
            lane.activeTrain = null;
          }
        }
      }
      for (const c of lane.coins) c.update(dt);
    }
  }

  draw(ctx) {
    this._drawBg(ctx);
    const lo = Math.max(0, Math.floor(this.cameraY / TILE) - 1);
    const hi = Math.ceil((this.cameraY + this.game.height) / TILE) + 1;
    for (let gy = lo; gy <= hi; gy++) {
      const lane = this.laneAt(gy);
      if (!lane) continue;
      this._drawLane(ctx, lane);
    }
  }

  _drawBg(ctx) {
    const w = this.game.width, h = this.game.height;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0d1430');
    g.addColorStop(1, this.theme.road);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }

  _drawLane(ctx, lane) {
    const sy = laneTopY(lane.gridY, this.cameraY);
    const t = this.theme;
    const checker = (lane.gridY % 2 === 0);
    if (lane.type === LANE.GRASS) {
      ctx.fillStyle = checker ? t.grass : t.grassAlt;
      ctx.fillRect(0, sy, COLS * TILE, TILE);
      // grass tufts
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      for (let i = 0; i < 8; i++) {
        const x = ((lane.gridY * 73 + i * 91) % (COLS * TILE));
        ctx.fillRect(x, sy + 8 + ((i * 13) % (TILE - 16)), 4, 4);
      }
      for (const o of lane.obstacles) o.draw(ctx, this.cameraY);
    } else if (lane.type === LANE.ROAD) {
      ctx.fillStyle = t.road;
      ctx.fillRect(0, sy, COLS * TILE, TILE);
      // lane stripes
      ctx.strokeStyle = t.roadStripe;
      ctx.setLineDash([14, 14]); ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, sy + TILE - 1); ctx.lineTo(COLS * TILE, sy + TILE - 1);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const e of lane.entities) e.draw(ctx, this.cameraY);
    } else if (lane.type === LANE.WATER) {
      ctx.fillStyle = t.water;
      ctx.fillRect(0, sy, COLS * TILE, TILE);
      // ripple lines
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(((lane.gridY * 13 + i * 80) % (COLS * TILE)), sy + 14 + i*10);
        ctx.lineTo(((lane.gridY * 13 + i * 80) % (COLS * TILE)) + 30, sy + 14 + i*10);
        ctx.stroke();
      }
      for (const e of lane.entities) e.draw(ctx, this.cameraY);
    } else if (lane.type === LANE.RAIL) {
      ctx.fillStyle = t.rail;
      ctx.fillRect(0, sy, COLS * TILE, TILE);
      // rails
      ctx.fillStyle = '#888';
      ctx.fillRect(0, sy + 18, COLS * TILE, 4);
      ctx.fillRect(0, sy + 38, COLS * TILE, 4);
      // ties
      ctx.fillStyle = '#5a3a20';
      for (let x = 0; x < COLS * TILE; x += 30) ctx.fillRect(x, sy + 14, 16, 32);
      // train warning
      if (lane.trainPending) {
        ctx.fillStyle = 'rgba(220,50,50,' + (0.35 + 0.4 * Math.abs(Math.sin(performance.now()/100))) + ')';
        ctx.fillRect(0, sy, COLS * TILE, TILE);
      }
      if (lane.activeTrain) lane.activeTrain.draw(ctx, this.cameraY);
    }
    // pickups
    for (const c of lane.coins) c.draw(ctx, this.cameraY);
  }

  // === Collisions with frog ===
  checkCollisions(frog) {
    const lane = this.laneAt(frog.gridY);
    if (!lane) return;
    // Pickups
    for (const p of lane.coins) {
      if (p.collected) continue;
      if (Math.abs(p.x - frog.x) < 28 && Math.abs(p.y - frog.y) < 28) {
        p.collected = true;
        this.game.onPickup(p);
      }
    }
    if (frog.hopProgress < 0.5) return; // grace mid-hop

    if (lane.type === LANE.ROAD) {
      for (const v of lane.entities) {
        if (Math.abs(v.x - frog.x) < (v.w/2 + 18) && Math.abs(v.y - frog.y) < (v.h/2 + 12)) {
          frog.die('car'); return;
        }
      }
    } else if (lane.type === LANE.WATER) {
      // Must be on a floater
      let onFloater = null;
      for (const f of lane.entities) {
        if (Math.abs(f.x - frog.x) < (f.w/2) && Math.abs(f.y - frog.y) < (f.h/2 + 4)) {
          onFloater = f; break;
        }
      }
      if (onFloater) {
        if (frog.ridingLog !== onFloater) {
          frog.ridingLog = onFloater;
        }
      } else {
        frog.ridingLog = null;
        if (frog.hopProgress >= 1) frog.die('drown');
      }
    } else if (lane.type === LANE.RAIL) {
      if (lane.activeTrain) {
        const t = lane.activeTrain;
        if (Math.abs(t.x - frog.x) < (t.w/2 + 18) && Math.abs(t.y - frog.y) < (t.h/2 + 12)) {
          frog.die('train'); return;
        }
      }
      frog.ridingLog = null;
    } else {
      frog.ridingLog = null;
      // Tree/rock blocks aren't lethal — just impassable; we cancel the hop by snapping back
      for (const o of lane.obstacles) {
        if (Math.abs(o.x - frog.x) < 26 && Math.abs(o.y - frog.y) < 26) {
          // push back to previous tile by reversing the last hop
          frog.gridX = Math.max(0, Math.min(COLS - 1, frog.gridX));
          // simplest: kill if mid-traffic, otherwise nudge to nearest free tile
          // For now, treat obstacle as fatal squish if landed on
          frog.die('obstacle'); return;
        }
      }
    }
  }
}

function pickLaneType(prev, gy) {
  const r = Math.random();
  // early lanes weighted toward roads
  if (gy < 4) return r < 0.55 ? LANE.ROAD : LANE.GRASS;
  if (prev === LANE.WATER) {
    if (r < 0.55) return LANE.WATER;          // chain water lanes
    if (r < 0.85) return LANE.GRASS;
    return LANE.ROAD;
  }
  if (prev === LANE.RAIL) {
    return r < 0.7 ? LANE.GRASS : LANE.ROAD;
  }
  if (r < 0.38) return LANE.ROAD;
  if (r < 0.62) return LANE.GRASS;
  if (r < 0.86) return LANE.WATER;
  return LANE.RAIL;
}

function pickColor() {
  const palette = ['#6dffb1', '#88c5ff', '#ffd23b', '#a884ff', '#ff8855', '#00ffd5'];
  return palette[Math.floor(Math.random() * palette.length)];
}
