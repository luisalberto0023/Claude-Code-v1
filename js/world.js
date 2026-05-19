// === World: lane generation, scrolling, theming ===
//
// Lanes are generated procedurally as the player progresses upward.
// Each lane belongs to one of: GRASS, ROAD, WATER, RAIL.
// Themes shift every BIOME_LEN lanes to keep visuals fresh.

const LANE = { GRASS: 'grass', ROAD: 'road', WATER: 'water', RAIL: 'rail' };

class World {
  constructor(game) {
    this.game = game;
    this.stage = game.currentStage || 1;
    this.stageDef = stageDef(this.stage);
    this.difficulty = stageDifficulty(this.stage);
    this.theme = BIOMES[this.stageDef.biome] || BIOMES.meadow;

    this.lanes = [];           // lanes[i] holds the lane with gridY = i
    this.minReachableY = 0;
    this.maxGeneratedY = -1;
    this.cameraY = 0;          // world Y at the back of the visible area
    this.scrollSpeed = this.difficulty.cameraBase;
    this.scrollAccel = 0.4;
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
    const finishGy = this.difficulty.lanes;
    while (this.maxGeneratedY < untilGy) {
      const gy = this.maxGeneratedY + 1;
      if (gy === finishGy) {
        // The finish line — special grass lane, no obstacles
        this.lanes.push({ type: LANE.GRASS, gridY: gy, entities: [],
                          coins: [], obstacles: [], isFinish: true });
      } else if (gy > finishGy) {
        // Beyond the finish — safe grass (not reachable in normal play)
        this.lanes.push({ type: LANE.GRASS, gridY: gy, entities: [],
                          coins: [], obstacles: [], beyondFinish: true });
      } else {
        this.lanes.push(this.makeLane(gy, false));
      }
      this.maxGeneratedY = gy;
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
      // Trains start rare; tighten cycle with depth.
      const railTier = Math.min(5, gy / 15);
      lane.trainTimer = 6 + Math.random() * 6 + Math.max(0, 3 - railTier);
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
    // Within-stage gentle ramp (0..3 over the stage), capped.
    const within = Math.min(3, gy / 15);
    // Base speeds and gaps are tuned for the gentle within-stage curve.
    // Per-stage scaling comes from this.difficulty.carSpeedMult.
    const baseSpeed = (50 + within * 18 + Math.random() * (40 + within * 14))
                      * this.difficulty.carSpeedMult;
    const speed = baseSpeed * dir;
    // Gaps stay generous; we don't compress them per stage so there's
    // always at least 1 tile of side-step room — only speed ramps.
    const gap = 260 + Math.random() * 160;
    const startOffset = Math.random() * gap;
    for (let x = -200 + startOffset; x < COLS * TILE + 200; x += gap) {
      const truck = Math.random() < 0.25;
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
    const within = Math.min(3, gy / 15);
    const baseSpeed = (28 + within * 10 + Math.random() * (28 + within * 10))
                      * this.difficulty.floaterSpeedMult;
    const speed = baseSpeed * dir;
    const useLogs = Math.random() < 0.7;
    const gap = useLogs
      ? 180 + Math.random() * 80
      : 120 + Math.random() * 60;
    const startOffset = Math.random() * gap;
    for (let x = -200 + startOffset; x < COLS * TILE + 200; x += gap) {
      if (useLogs) {
        items.push(new Floater({
          x, y: gy * TILE, w: 140, h: 38, vx: speed, type: 'log',
        }));
      } else {
        items.push(new Floater({
          x, y: gy * TILE, w: 56, h: 56, vx: speed, type: 'lily',
        }));
      }
    }
    return items;
  }

  update(dt) {
    // Camera target = per-stage base + a +2 px/s step every 10 lanes the
    // player has cleared inside this stage.
    const depthBoost = Math.floor(this.game.frog.gridY / 10) * 2;
    const target = this.difficulty.cameraBase + depthBoost;
    this.scrollSpeed += (target - this.scrollSpeed) * Math.min(1, dt * 0.4);
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
    if (lane.isFinish) {
      // Grass base
      ctx.fillStyle = t.grass;
      ctx.fillRect(0, sy, COLS * TILE, TILE);
      // Checkered finish pattern
      const sq = 12;
      const rows = Math.ceil(TILE / sq);
      const cols = Math.ceil(COLS * TILE / sq);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ctx.fillStyle = (r + c) % 2 ? '#0b1020' : '#f6f9ff';
          ctx.fillRect(c * sq, sy + r * sq, sq, sq);
        }
      }
      // FINISH banner
      ctx.fillStyle = 'rgba(255,210,59,0.95)';
      const bannerH = 26;
      ctx.fillRect(0, sy + (TILE - bannerH) / 2, COLS * TILE, bannerH);
      ctx.fillStyle = '#2b1a00';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★  FINISH  ★', COLS * TILE / 2, sy + TILE / 2 + 1);
      ctx.textBaseline = 'alphabetic';
      // pickups (rare, but render them anyway)
      for (const c of lane.coins) c.draw(ctx, this.cameraY);
      return;
    }
    if (lane.beyondFinish) {
      ctx.fillStyle = t.grass;
      ctx.fillRect(0, sy, COLS * TILE, TILE);
      return;
    }
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

    const wasOnLog = !!frog.ridingLog;

    if (lane.type === LANE.ROAD) {
      for (const v of lane.entities) {
        if (Math.abs(v.x - frog.x) < (v.w/2 + 18) && Math.abs(v.y - frog.y) < (v.h/2 + 12)) {
          frog.die('car'); return;
        }
      }
      frog.ridingLog = null;
    } else if (lane.type === LANE.WATER) {
      let onFloater = null;
      for (const f of lane.entities) {
        if (Math.abs(f.x - frog.x) < (f.w/2) && Math.abs(f.y - frog.y) < (f.h/2 + 4)) {
          onFloater = f; break;
        }
      }
      if (onFloater) {
        if (frog.ridingLog !== onFloater) frog.ridingLog = onFloater;
      } else {
        frog.ridingLog = null;
        if (frog.hopProgress >= 1) { frog.die('drown'); return; }
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
      for (const o of lane.obstacles) {
        if (Math.abs(o.x - frog.x) < 26 && Math.abs(o.y - frog.y) < 26) {
          frog.gridX = Math.max(0, Math.min(COLS - 1, frog.gridX));
          frog.die('obstacle'); return;
        }
      }
    }

    // Just dismounted a log? Snap gridX to wherever the frog visually is so
    // the grid-aligned slide in Frog.update() resolves to the right column.
    if (wasOnLog && !frog.ridingLog) {
      const nearestCol = Math.max(0, Math.min(COLS - 1,
        Math.round((frog.x - TILE/2) / TILE)));
      frog.gridX = nearestCol;
      frog.logOffset = 0;
    }
  }
}

function pickLaneType(prev, gy) {
  const r = Math.random();
  // Lane 0–5: pure grass/road learner field.
  if (gy < 6) return r < 0.45 ? LANE.ROAD : LANE.GRASS;
  // Lane 6–14: introduce occasional water, no trains yet.
  if (gy < 15) {
    if (prev === LANE.WATER) return r < 0.45 ? LANE.WATER : LANE.GRASS;
    if (r < 0.30) return LANE.ROAD;
    if (r < 0.80) return LANE.GRASS;
    return LANE.WATER;
  }
  // Lane 15–29: trains start appearing.
  if (gy < 30) {
    if (prev === LANE.WATER) {
      if (r < 0.50) return LANE.WATER;
      if (r < 0.85) return LANE.GRASS;
      return LANE.ROAD;
    }
    if (prev === LANE.RAIL) return r < 0.7 ? LANE.GRASS : LANE.ROAD;
    if (r < 0.36) return LANE.ROAD;
    if (r < 0.64) return LANE.GRASS;
    if (r < 0.90) return LANE.WATER;
    return LANE.RAIL;
  }
  // 30+: full mix.
  if (prev === LANE.WATER) {
    if (r < 0.55) return LANE.WATER;
    if (r < 0.85) return LANE.GRASS;
    return LANE.ROAD;
  }
  if (prev === LANE.RAIL) return r < 0.7 ? LANE.GRASS : LANE.ROAD;
  if (r < 0.38) return LANE.ROAD;
  if (r < 0.62) return LANE.GRASS;
  if (r < 0.86) return LANE.WATER;
  return LANE.RAIL;
}

function pickColor() {
  const palette = ['#6dffb1', '#88c5ff', '#ffd23b', '#a884ff', '#ff8855', '#00ffd5'];
  return palette[Math.floor(Math.random() * palette.length)];
}
