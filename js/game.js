// === Game: state machine, loop, input ===
const GAME_STATE = { MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', GAMEOVER: 'gameover', STAGECLEAR: 'stageclear' };

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    this.state = GAME_STATE.MENU;
    this.score = 0;
    this.coinsRun = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.lives = 3;
    this.powerups = {}; // { shield: { timeLeft }, magnet: { timeLeft }, slowmo: { timeLeft } }
    this.questProgress = {};
    this.lastTime = 0;
    this.currentStage = Storage.get().currentStage || 1;

    this.frog = null;
    this.world = null;

    this._bindInput();
    this._bindUI();
    this._bindFirstGesture();
    UI.refreshMenu();
    UI.only('menu');
    if (!Storage.get().onboarded) {
      // Force the character picker before anything else
      setTimeout(() => {
        UI.renderCharacter('onboarding');
        UI.startCharPreviewAnim();
        UI.only('characters');
      }, 200);
    } else {
      this._showDailyIfDue();
    }
    requestAnimationFrame(this._loop.bind(this));
  }

  // Browsers require a user gesture before AudioContext can run.
  // Unlock audio + start music on the very first touch/click/key.
  _bindFirstGesture() {
    const kick = () => {
      Audio.unlock();
      if (Storage.get().settings.music) Audio.startMusic();
      window.removeEventListener('touchstart', kick);
      window.removeEventListener('click', kick);
      window.removeEventListener('keydown', kick);
    };
    window.addEventListener('touchstart', kick, { once: true, passive: true });
    window.addEventListener('click', kick, { once: true });
    window.addEventListener('keydown', kick, { once: true });
  }

  // === Input ===
  _bindInput() {
    const layer = document.getElementById('touch-layer');
    let touchStart = null;
    const SWIPE = 28;
    layer.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, t: performance.now() };
    }, { passive: true });
    layer.addEventListener('touchend', (e) => {
      if (!touchStart) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax < SWIPE && ay < SWIPE) {
        // tap: interpret by position (top half = up, bottom half = down,
        // left edge = left, right edge = right)
        const rect = this.canvas.getBoundingClientRect();
        const localX = touchStart.x - rect.left;
        const localY = touchStart.y - rect.top;
        const w = rect.width, h = rect.height;
        if (localY < h * 0.45) this._move(0, 1);
        else if (localY > h * 0.65) this._move(0, -1);
        else if (localX < w * 0.4) this._move(-1, 0);
        else this._move(1, 0);
      } else if (ax > ay) {
        this._move(dx > 0 ? 1 : -1, 0);
      } else {
        this._move(0, dy < 0 ? 1 : -1);
      }
      touchStart = null;
    });

    window.addEventListener('keydown', (e) => {
      if (this.state === GAME_STATE.MENU || this.state === GAME_STATE.GAMEOVER) {
        if (e.key === 'Enter' || e.key === ' ') this.startRun();
        return;
      }
      if (e.key === 'Escape' || e.key === 'p') this.togglePause();
      if (this.state !== GAME_STATE.PLAYING) return;
      if (e.key === 'ArrowUp' || e.key === 'w') this._move(0, 1);
      if (e.key === 'ArrowDown' || e.key === 's') this._move(0, -1);
      if (e.key === 'ArrowLeft' || e.key === 'a') this._move(-1, 0);
      if (e.key === 'ArrowRight' || e.key === 'd') this._move(1, 0);
    });

    // Handle canvas resize for high-DPI / mobile
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      // Keep internal resolution at 540x960 (aspect 9:16); just scale via CSS.
      this.canvas.style.width = rect.width + 'px';
      this.canvas.style.height = rect.height + 'px';
    };
    window.addEventListener('resize', resize);
    resize();
  }

  _bindUI() {
    document.getElementById('btn-play').onclick = () => {
      Audio.unlock(); Audio.button();
      UI.renderWorldMap();
      UI.only('worldmap');
    };
    document.getElementById('btn-retry').onclick = () => { Audio.button(); this.startRun(this.currentStage); };
    document.getElementById('btn-home').onclick = () => { Audio.button(); UI.only('menu'); UI.refreshMenu(); this.state = GAME_STATE.MENU; };
    document.getElementById('worldmap-close').onclick = () => { Audio.button(); UI.only('menu'); UI.refreshMenu(); };
    document.getElementById('sc-next').onclick = () => {
      Audio.button();
      const nextId = (this.world.stageDef.id + 1);
      if (Storage.get().unlockedStages.includes(nextId)) this.startRun(nextId);
      else { UI.renderWorldMap(); UI.only('worldmap'); }
    };
    document.getElementById('sc-map').onclick = () => { Audio.button(); UI.renderWorldMap(); UI.only('worldmap'); };
    document.getElementById('sc-home').onclick = () => { Audio.button(); UI.only('menu'); UI.refreshMenu(); this.state = GAME_STATE.MENU; };
    document.getElementById('btn-pause').onclick = () => { Audio.button(); this.togglePause(); };
    document.getElementById('btn-resume').onclick = () => { Audio.button(); this.togglePause(); };
    document.getElementById('btn-quit').onclick = () => { Audio.button(); this.gameOver('quit'); };
    document.getElementById('btn-revive').onclick = () => { Audio.button(); this.revive(); };

    document.getElementById('btn-characters').onclick = () => {
      Audio.button();
      UI.renderCharacter('normal');
      UI.startCharPreviewAnim();
      UI.only('characters');
    };
    document.getElementById('char-close').onclick = () => {
      Audio.button();
      UI.stopCharPreviewAnim();
      const onboarding = document.getElementById('char-close').dataset.mode === 'onboarding';
      if (onboarding) {
        Storage.patch({ onboarded: true });
        UI.only('menu'); UI.refreshMenu();
        // Now show the daily reward modal if it's due
        this._showDailyIfDue();
      } else {
        UI.only('menu'); UI.refreshMenu();
      }
    };
    // Corner X — only shown in normal mode (hidden during mandatory onboarding)
    document.getElementById('char-x').onclick = () => {
      Audio.button();
      UI.stopCharPreviewAnim();
      UI.only('menu'); UI.refreshMenu();
    };
    document.getElementById('char-random').onclick = () => { Audio.button(); UI.randomizeCharacter(); };
    document.getElementById('btn-daily').onclick    = () => { Audio.button(); UI.renderDaily(); UI.only('daily'); };
    document.getElementById('daily-close').onclick  = () => { Audio.button(); UI.only('menu'); UI.refreshMenu(); };
    document.getElementById('daily-claim').onclick  = () => {
      if (document.getElementById('daily-claim').disabled) return;
      Audio.button();
      const r = UI.claimDaily();
      if (r) { Audio.levelup(); UI.renderDaily(); UI.refreshMenu(); }
    };
    document.getElementById('btn-shop').onclick     = () => { Audio.button(); UI.only('shop'); };
    document.getElementById('shop-close').onclick   = () => { Audio.button(); UI.only('menu'); UI.refreshMenu(); };
    document.getElementById('btn-leaderboard').onclick = () => { Audio.button(); UI.only('leaderboard'); };
    document.getElementById('lb-close').onclick     = () => { Audio.button(); UI.only('menu'); UI.refreshMenu(); };

    // --- Settings ---
    const openSettings = (returnTo) => {
      Audio.button();
      UI.renderSettings();
      this._settingsReturnTo = returnTo;
      UI.only('settings');
    };
    document.getElementById('btn-settings').onclick       = () => openSettings('menu');
    document.getElementById('btn-pause-settings').onclick = () => openSettings('pause');
    document.getElementById('settings-close').onclick     = () => {
      Audio.button();
      const back = this._settingsReturnTo || 'menu';
      if (back === 'pause') {
        UI.only('pause');
      } else {
        UI.only('menu'); UI.refreshMenu();
      }
    };

    const setMusic = document.getElementById('set-music');
    const setSfx = document.getElementById('set-sfx');
    const setHaptics = document.getElementById('set-haptics');
    const setMusicVol = document.getElementById('set-music-vol');
    const setSfxVol = document.getElementById('set-sfx-vol');

    setMusic.onchange = () => {
      Storage.patch({ settings: { ...Storage.get().settings, music: setMusic.checked } });
      setMusicVol.disabled = !setMusic.checked;
      if (setMusic.checked) Audio.startMusic(); else Audio.stopMusic();
    };
    setSfx.onchange = () => {
      Storage.patch({ settings: { ...Storage.get().settings, sfx: setSfx.checked } });
      setSfxVol.disabled = !setSfx.checked;
      if (setSfx.checked) Audio.button();
    };
    setHaptics.onchange = () => {
      Storage.patch({ settings: { ...Storage.get().settings, haptics: setHaptics.checked } });
    };
    setMusicVol.oninput = () => {
      const v = setMusicVol.value / 100;
      Storage.patch({ settings: { ...Storage.get().settings, musicVol: v } });
      Audio.setMusicVolume(v);
    };
    setSfxVol.oninput = () => {
      const v = setSfxVol.value / 100;
      Storage.patch({ settings: { ...Storage.get().settings, sfxVol: v } });
      Audio.setSfxVolume(v);
    };
    setSfxVol.onchange = () => Audio.button(); // preview on release
  }

  _showDailyIfDue() {
    if (UI.canClaimDaily()) {
      // Auto-pop after 800ms so the menu can render first
      setTimeout(() => { UI.renderDaily(); UI.only('daily'); }, 800);
    }
  }

  _move(dx, dy) {
    if (this.state !== GAME_STATE.PLAYING) return;
    const hopped = this.frog.hop(dx, dy);
    if (!hopped) return;

    // Score: only count forward progress (dy > 0)
    if (dy > 0) {
      this.score += 1 * Math.floor(this.combo);
      // Combo
      this.comboTimer = 1.6;
      this.combo = Math.min(10, this.combo + 0.5);
      if (this.combo >= 10) this._questBump('combo10', 10);
      this._questBump('hop50', 1);
      const lane = this.world.laneAt(this.frog.gridY);
      if (lane && lane.type === 'road') this._questBump('cars30', 1);
    }
  }

  _questBump(id, amount) {
    const list = UI.todaysQuests();
    if (!list.find(q => q.id === id)) return;
    this.questProgress[id] = Math.max(this.questProgress[id] || 0, (this.questProgress[id] || 0) + amount);
    if (id === 'combo10') this.questProgress[id] = Math.max(this.questProgress[id], Math.floor(this.combo));
    if (id === 'score100') this.questProgress[id] = Math.max(this.questProgress[id], this.score);
    if (id === 'coins25') this.questProgress[id] = Math.max(this.questProgress[id], this.coinsRun);
  }

  // === Lifecycle ===
  startRun(stageId) {
    if (stageId) {
      this.currentStage = stageId;
      Storage.patch({ currentStage: stageId });
    }
    this.score = 0; this.coinsRun = 0; this.combo = 1; this.comboTimer = 0;
    const skin = skinDef(Storage.get().activeSkin);
    let baseLives = 3;
    if (skin.perk.includes('+1 starting life')) baseLives++;
    this.lives = baseLives;
    this.maxLives = baseLives;
    this.powerups = {};
    this.questProgress = {};
    this.world = new World(this);
    this.frog = new Frog(this);
    this.state = GAME_STATE.PLAYING;
    ['menu','gameover','pause','daily','characters','shop','leaderboard','settings','worldmap','stage-complete'].forEach(s => {
      const el = document.getElementById(s);
      if (el) el.classList.add('hidden');
    });
    document.getElementById('hud').classList.remove('hidden');
    UI.setHUD({
      score: 0, combo: 1, coins: 0, lives: this.lives, maxLives: this.maxLives,
      powerups: [],
      stage: this.currentStage, progress: 0, total: this.world.difficulty.lanes,
    });
    Storage.patch({ totalRuns: Storage.get().totalRuns + 1 });
  }

  togglePause() {
    if (this.state === GAME_STATE.PLAYING) {
      this.state = GAME_STATE.PAUSED;
      UI.show('pause');
    } else if (this.state === GAME_STATE.PAUSED) {
      this.state = GAME_STATE.PLAYING;
      UI.hide('pause');
    }
  }

  onPlayerDeath(reason) {
    if (this.powerups.shield && this.powerups.shield.timeLeft > 0) {
      // consume shield, respawn back one tile
      this.frog.alive = true;
      this.powerups.shield = null;
      this.frog.gridY = Math.max(this.world.minReachableY, this.frog.gridY - 1);
      this.frog.targetX = this.frog.gridX * TILE + TILE/2;
      this.frog.targetY = this.frog.gridY * TILE;
      this.frog.x = this.frog.targetX; this.frog.y = this.frog.targetY;
      this.frog.hopProgress = 1;
      UI.floatText('SHIELD!', this.frog.x, screenY(this.frog.y, this.world.cameraY) - 40, '#00ffd5');
      Audio.powerup();
      return;
    }
    this.lives--;
    if (this.lives > 0) {
      // brief flash, respawn
      this.frog.alive = true;
      this.frog.gridY = Math.max(this.world.minReachableY, this.frog.gridY - 1);
      this.frog.targetX = this.frog.gridX * TILE + TILE/2;
      this.frog.targetY = this.frog.gridY * TILE;
      this.frog.x = this.frog.targetX; this.frog.y = this.frog.targetY;
      this.frog.hopProgress = 1;
      this.frog.ridingLog = null;
      UI.floatText('-1 ♥', this.frog.x, screenY(this.frog.y, this.world.cameraY) - 40, '#ff5577');
      return;
    }
    this.gameOver(reason);
  }

  gameOver(reason) {
    this.state = GAME_STATE.GAMEOVER;
    const s = Storage.get();
    const skin = skinDef(s.activeSkin);
    let coinMult = 1;
    if (skin.perk.includes('+10% coin value')) coinMult = 1.1;
    if (skin.perk.includes('+25% coin value')) coinMult = 1.25;
    const earnedCoins = Math.floor(this.coinsRun * coinMult);
    const isBest = this.score > s.bestScore;
    const newBest = Math.max(s.bestScore, this.score);
    Storage.patch({ bestScore: newBest, coins: s.coins + earnedCoins });
    const leveled = Storage.addXP(Math.max(5, Math.floor(this.score / 2)));
    if (leveled) Audio.levelup();

    document.getElementById('go-score').textContent = this.score;
    document.getElementById('go-best').textContent = newBest;
    document.getElementById('go-coins').textContent = earnedCoins;
    UI.renderQuests(this.questProgress);
    UI.show('gameover');
    document.getElementById('hud').classList.add('hidden');
  }

  revive() {
    // Simulate rewarded ad: in production this would call AdMob / IronSource
    this.lives = 1;
    this.state = GAME_STATE.PLAYING;
    this.frog.alive = true;
    this.frog.gridY = Math.max(this.world.minReachableY + 1, this.frog.gridY);
    this.frog.targetX = this.frog.gridX * TILE + TILE/2;
    this.frog.targetY = this.frog.gridY * TILE;
    this.frog.x = this.frog.targetX; this.frog.y = this.frog.targetY;
    this.frog.hopProgress = 1;
    this.frog.ridingLog = null;
    this.powerups.shield = { timeLeft: 3 };
    UI.hide('gameover');
    document.getElementById('hud').classList.remove('hidden');
    UI.floatText('REVIVED', this.canvas.width/2, this.canvas.height/2, '#ffd23b');
    Audio.powerup();
  }

  onPickup(p) {
    if (p.kind === 'coin') {
      this.coinsRun++;
      this.score += 2;
      Audio.coin();
      UI.floatText('+1🪙', this.frog.x, screenY(this.frog.y, this.world.cameraY) - 30, '#ffd23b');
      this._questBump('coins25', 1);
    } else if (p.kind === 'gem') {
      Storage.patch({ gems: Storage.get().gems + 1 });
      Audio.coin();
      UI.floatText('+1💎', this.frog.x, screenY(this.frog.y, this.world.cameraY) - 30, '#ff3bd9');
    } else if (p.kind === 'shield') {
      this.powerups.shield = { timeLeft: 8 };
      Audio.powerup();
      UI.floatText('SHIELD', this.frog.x, screenY(this.frog.y, this.world.cameraY) - 30, '#00ffd5');
    } else if (p.kind === 'magnet') {
      this.powerups.magnet = { timeLeft: 7 };
      Audio.powerup();
      UI.floatText('MAGNET', this.frog.x, screenY(this.frog.y, this.world.cameraY) - 30, '#ff5577');
    } else if (p.kind === 'slowmo') {
      const skin = skinDef(Storage.get().activeSkin);
      let dur = 5;
      if (skin.perk.includes('Slow-mo lasts 50% longer')) dur *= 1.5;
      this.powerups.slowmo = { timeLeft: dur };
      this.world.scrollPaused = dur;
      Audio.powerup();
      UI.floatText('SLOW-MO', this.frog.x, screenY(this.frog.y, this.world.cameraY) - 30, '#a884ff');
    }
  }

  // === Main loop ===
  _loop(t) {
    if (!this.lastTime) this.lastTime = t;
    let dt = (t - this.lastTime) / 1000;
    if (dt > 0.05) dt = 0.05;
    this.lastTime = t;

    if (this.state === GAME_STATE.PLAYING) this._update(dt);
    this._render();
    requestAnimationFrame(this._loop.bind(this));
  }

  _update(dt) {
    this.world.update(dt);
    this.frog.update(dt);
    this.world.checkCollisions(this.frog);

    // Reached the finish line?
    if (this.state === GAME_STATE.PLAYING &&
        this.frog.gridY >= this.world.difficulty.lanes &&
        this.frog.alive) {
      this.completeStage();
      return;
    }

    // Combo decay
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }

    // Power-up ticks
    const list = [];
    for (const k of Object.keys(this.powerups)) {
      const pu = this.powerups[k];
      if (!pu) { delete this.powerups[k]; continue; }
      pu.timeLeft -= dt;
      if (pu.timeLeft <= 0) { delete this.powerups[k]; continue; }
      list.push({ kind: k, timeLeft: pu.timeLeft });
    }

    // Magnet: pull nearby coins (visual nicety)
    if (this.powerups.magnet) {
      const skin = skinDef(Storage.get().activeSkin);
      let r = 80 + (skin.perk.includes('Magnet base radius +1') ? 30 : 0);
      const lane = this.world.laneAt(this.frog.gridY);
      const adjacent = [lane, this.world.laneAt(this.frog.gridY+1), this.world.laneAt(this.frog.gridY-1)];
      for (const ln of adjacent) {
        if (!ln) continue;
        for (const c of ln.coins) {
          if (c.collected) continue;
          const dx = this.frog.x - c.x, dy = this.frog.y - c.y;
          const d = Math.sqrt(dx*dx + dy*dy);
          if (d < r) {
            c.x += (dx / d) * 240 * dt;
            c.y += (dy / d) * 240 * dt;
          }
        }
      }
    }

    // Score reflects max forward depth
    if (this.frog.gridY > this.score / 1.0001 && this.combo > 1) {
      // tiny smoothing; combo bonus already added per-hop
    }
    this._questBump('score100', 0);
    this.questProgress.score100 = Math.max(this.questProgress.score100 || 0, this.score);

    UI.setHUD({
      score: this.score, combo: this.combo,
      coins: this.coinsRun, lives: this.lives, maxLives: this.maxLives,
      powerups: list,
      stage: this.currentStage,
      progress: Math.max(0, this.frog.gridY),
      total: this.world.difficulty.lanes,
    });
  }

  completeStage() {
    this.state = GAME_STATE.STAGECLEAR;
    const stage = this.world.stageDef;
    const s = Storage.get();
    const prevBest = s.stageBest[stage.id] || 0;
    const isBest = this.score > prevBest;
    const newBest = Math.max(prevBest, this.score);
    const unlocked = new Set(s.unlockedStages || [1]);
    if (stage.id < STAGES.length) unlocked.add(stage.id + 1);
    Storage.patch({
      stageBest: { ...s.stageBest, [stage.id]: newBest },
      unlockedStages: [...unlocked].sort((a,b) => a-b),
      bestScore: Math.max(s.bestScore, this.score),
      coins: s.coins + this.coinsRun,
    });
    Storage.addXP(Math.max(20, Math.floor(this.score / 2)));
    Audio.levelup();
    UI.renderStageComplete(stage, this.score, this.coinsRun, isBest);
    document.getElementById('hud').classList.add('hidden');
    UI.only('stage-complete');
  }

  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.state === GAME_STATE.MENU) {
      this._drawMenuBackdrop();
      return;
    }
    this.world.draw(ctx);
    // Draw frog on top
    this.frog.draw(ctx, this.world.cameraY);
    // Shield ring
    if (this.powerups.shield) {
      const sy = screenY(this.frog.y, this.world.cameraY);
      ctx.strokeStyle = '#00ffd5'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(this.frog.x, sy - 6, 28, 0, Math.PI*2); ctx.stroke();
    }
    // Slow-mo veil
    if (this.powerups.slowmo) {
      ctx.fillStyle = 'rgba(168,132,255,0.10)';
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  _drawMenuBackdrop() {
    // Subtle animated lanes preview behind the menu
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    const grad = ctx.createLinearGradient(0, 0, 0, this.height);
    grad.addColorStop(0, '#0d1430');
    grad.addColorStop(1, '#1a2655');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.width, this.height);
    // moving stripes
    for (let i = 0; i < 8; i++) {
      const y = ((i * 120 + t * 60) % this.height);
      ctx.fillStyle = i % 2 ? 'rgba(0,255,213,0.04)' : 'rgba(255,59,217,0.04)';
      ctx.fillRect(0, y, this.width, 60);
    }
  }
}

// === Boot ===
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game');
  window._game = new Game(canvas);
});
