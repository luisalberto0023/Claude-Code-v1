// === UI: menus, modals, HUD updates ===
const UI = (() => {
  const screens = ['menu', 'pause', 'gameover', 'daily', 'characters', 'shop', 'leaderboard', 'settings', 'worldmap', 'stage-complete'];
  function show(id) { document.getElementById(id).classList.remove('hidden'); }
  function hide(id) { document.getElementById(id).classList.add('hidden'); }
  function only(id) { screens.forEach(s => s === id ? show(s) : hide(s)); }

  function setHUD({ score, combo, coins, lives, maxLives, powerups, stage, progress, total }) {
    if (score !== undefined) document.getElementById('hud-score').textContent = score;
    if (combo !== undefined) document.getElementById('hud-combo').textContent = 'x' + combo.toFixed(combo < 2 ? 0 : 1);
    if (coins !== undefined) document.getElementById('hud-coins').textContent = coins;
    if (lives !== undefined) {
      const container = document.getElementById('hud-lives');
      let hearts = container.querySelectorAll('.heart');
      // Rebuild the heart row if the max-life count changed (e.g. Toad skin).
      const max = maxLives || hearts.length || 3;
      if (hearts.length !== max) {
        container.innerHTML = '';
        for (let i = 0; i < max; i++) {
          const h = document.createElement('span');
          h.className = 'heart';
          h.textContent = '♥';
          container.appendChild(h);
        }
        hearts = container.querySelectorAll('.heart');
      }
      hearts.forEach((h, i) => h.classList.toggle('lost', i >= lives));
    }
    if (stage !== undefined) document.getElementById('hud-stage-label').textContent = 'Stage ' + stage;
    if (progress !== undefined && total !== undefined) {
      const clamped = Math.max(0, Math.min(total, progress));
      document.getElementById('hud-progress-text').textContent = `${clamped}/${total}`;
      document.getElementById('hud-progress-fill').style.width = (clamped / total * 100) + '%';
    }
    if (powerups) {
      const bar = document.getElementById('powerup-bar');
      bar.innerHTML = '';
      for (const p of powerups) {
        const c = document.createElement('div');
        c.className = 'powerup-chip';
        c.textContent = `${powerupIcon(p.kind)} ${p.timeLeft.toFixed(1)}s`;
        bar.appendChild(c);
      }
    }
  }
  function powerupIcon(k) {
    return { shield: '🛡', magnet: '🧲', slowmo: '⏱' }[k] || '⭐';
  }

  function refreshMenu() {
    const s = Storage.get();
    document.getElementById('menu-best').textContent = s.bestScore;
    document.getElementById('menu-coins').textContent = s.coins;
    document.getElementById('menu-level').textContent = s.level;
    document.getElementById('lb-you').textContent = s.bestScore;
  }

  // Floating "+10" / "+coin" text over the canvas (canvas-internal coords)
  function floatText(text, x, y, color) {
    const canvas = document.getElementById('game');
    const rect = canvas.getBoundingClientRect();
    const sx = rect.left + (x / canvas.width) * rect.width;
    const sy = rect.top  + (y / canvas.height) * rect.height;
    const div = document.createElement('div');
    div.className = 'float-text';
    div.textContent = text;
    div.style.color = color || '#fff';
    div.style.left = sx + 'px';
    div.style.top  = sy + 'px';
    div.style.transform = 'translate(-50%, -50%)';
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 1000);
  }

  // === Daily reward grid ===
  function renderDaily() {
    const grid = document.getElementById('daily-grid');
    const s = Storage.get();
    const rewards = [
      { day: 1, gold: 50 }, { day: 2, gold: 100 }, { day: 3, gold: 150 },
      { day: 4, gold: 200 }, { day: 5, gold: 300 }, { day: 6, gold: 400 },
      { day: 7, gem: 25 },
    ];
    const cycle = rewards.length;
    const claimable = canClaimDaily();
    // If today is already claimed, the most recent claim sits at (streak-1).
    // If today is still claimable, the next reward sits at streak.
    const todayIdx = claimable
      ? (s.dailyStreak % cycle)
      : (((s.dailyStreak - 1) % cycle) + cycle) % cycle;

    grid.innerHTML = '';
    rewards.forEach((r, i) => {
      const cell = document.createElement('div');
      cell.className = 'daily-cell';
      if (i < todayIdx) cell.classList.add('claimed');
      if (i === todayIdx) {
        cell.classList.add('today');
        if (!claimable) cell.classList.add('claimed');
      }
      if (i > todayIdx) cell.classList.add('future');
      cell.innerHTML = `Day ${r.day}<strong>${r.gem ? r.gem + '💎' : r.gold + '🪙'}</strong>`;
      grid.appendChild(cell);
    });

    // Sync the Claim button
    const btn = document.getElementById('daily-claim');
    if (btn) {
      btn.disabled = !claimable;
      btn.textContent = claimable ? 'Claim' : 'Come Back Tomorrow';
    }
    return rewards[todayIdx];
  }
  function canClaimDaily() {
    const last = Storage.get().lastDaily;
    if (!last) return true;
    const lastDay = new Date(last).toDateString();
    return lastDay !== new Date().toDateString();
  }
  function claimDaily() {
    if (!canClaimDaily()) return null;
    const today = renderDaily();
    const s = Storage.get();
    const patch = {
      dailyStreak: s.dailyStreak + 1,
      lastDaily: Date.now(),
    };
    if (today.gold) patch.coins = s.coins + today.gold;
    if (today.gem)  patch.gems  = s.gems  + today.gem;
    Storage.patch(patch);
    return today;
  }

  // === Character: species + color + special skins (unified) ===
  const SPECIES = [
    { id: 'frog',     emoji: '🐸', name: 'Frog' },
    { id: 'rabbit',   emoji: '🐰', name: 'Rabbit' },
    { id: 'kangaroo', emoji: '🦘', name: 'Kangaroo' },
  ];
  const COLOR_PALETTE = [
    '#6dffb1', // mint
    '#00ffd5', // teal
    '#5cb8ff', // sky
    '#a884ff', // violet
    '#ff5fb8', // pink
    '#ff6b6b', // red
    '#ff9b3d', // orange
    '#ffd23b', // gold
    '#b88845', // brown
    '#c8d2e8', // ash
    '#3aa050', // forest
    '#2a3050', // ink
  ];

  // Preview animation state
  let charAnimRAF = null;
  let charAnimStart = 0;

  function _previewSpecies() {
    const s = Storage.get();
    if (s.useCustom) {
      return {
        species: s.customSpecies || 'frog',
        color: s.customColor || '#6dffb1',
      };
    }
    return { species: 'frog', color: skinDef(s.activeSkin).color };
  }

  function _drawCharPreview() {
    const canvas = document.getElementById('char-preview-canvas');
    if (!canvas) return;
    const c = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    c.clearRect(0, 0, w, h);
    const { species, color } = _previewSpecies();
    // Hop in place: 850ms cycle
    const phase = ((performance.now() - charAnimStart) % 850) / 850;
    const air = Math.sin(phase * Math.PI);
    c.save();
    c.translate(w / 2, h / 2 + 14);
    // shadow
    c.fillStyle = `rgba(0,0,0,${0.32 - air * 0.18})`;
    c.beginPath();
    c.ellipse(0, 28, 22 - air * 8, 7 - air * 3, 0, 0, Math.PI * 2);
    c.fill();
    // sprite with squash/stretch
    c.translate(0, -air * 18);
    c.scale(1 + air * 0.10, 1 - air * 0.08);
    c.scale(1.6, 1.6); // upscale for the preview canvas
    drawSpriteFor(c, species, color);
    c.restore();
  }

  function startCharPreviewAnim() {
    if (charAnimRAF) return;
    charAnimStart = performance.now();
    const tick = () => {
      _drawCharPreview();
      charAnimRAF = requestAnimationFrame(tick);
    };
    charAnimRAF = requestAnimationFrame(tick);
  }
  function stopCharPreviewAnim() {
    if (charAnimRAF) cancelAnimationFrame(charAnimRAF);
    charAnimRAF = null;
  }

  function renderCharacter(mode = 'normal') {
    const s = Storage.get();

    // Current balance so the player can see what they can afford
    document.getElementById('char-coin-count').textContent = s.coins;
    document.getElementById('char-gem-count').textContent = s.gems;

    // Title + subtitle + Done label flip for onboarding.
    // The corner X is hidden during onboarding (mandatory pick).
    const titleEl = document.getElementById('char-title');
    const subEl = document.getElementById('char-subtitle');
    const doneEl = document.getElementById('char-close');
    const xEl = document.getElementById('char-x');
    if (mode === 'onboarding') {
      titleEl.textContent = 'Welcome to Hopster!';
      subEl.textContent = 'Pick your character to start hopping';
      doneEl.textContent = 'Start Hopping';
      doneEl.dataset.mode = 'onboarding';
      xEl.style.display = 'none';
    } else {
      titleEl.textContent = 'Character';
      subEl.textContent = 'Customize your hopster, or pick a special skin';
      doneEl.textContent = 'Done';
      doneEl.dataset.mode = 'normal';
      xEl.style.display = '';
    }

    // Species tiles
    const spContainer = document.getElementById('char-species');
    spContainer.innerHTML = '';
    SPECIES.forEach(sp => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'species-tile';
      if (s.useCustom && s.customSpecies === sp.id) tile.classList.add('selected');
      tile.innerHTML = `<div class="species-emoji">${sp.emoji}</div><div class="species-name">${sp.name}</div>`;
      tile.addEventListener('click', () => {
        Audio.button();
        Storage.patch({ customSpecies: sp.id, useCustom: true });
        renderCharacter(doneEl.dataset.mode);
      });
      spContainer.appendChild(tile);
    });

    // Color swatches
    const colContainer = document.getElementById('char-colors');
    colContainer.innerHTML = '';
    COLOR_PALETTE.forEach(color => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'color-swatch';
      sw.style.background = color;
      if (s.useCustom && s.customColor === color) sw.classList.add('selected');
      sw.addEventListener('click', () => {
        Audio.button();
        Storage.patch({ customColor: color, useCustom: true });
        renderCharacter(doneEl.dataset.mode);
      });
      colContainer.appendChild(sw);
    });

    // Special skins (existing 8) — tap to equip its perk + override custom
    const grid = document.getElementById('char-grid');
    grid.innerHTML = '';
    Object.entries(SKINS).forEach(([id, def]) => {
      const owned = s.unlockedSkins.includes(id);
      const isActive = !s.useCustom && s.activeSkin === id;
      const cell = document.createElement('div');
      cell.className = 'char-cell' + (owned ? '' : ' locked') + (isActive ? ' selected' : '');
      cell.innerHTML = `
        <div class="emoji">${def.emoji}</div>
        <div class="name">${def.name}</div>
        <div class="perk">${def.perk}</div>
        <div class="price">${owned ? (isActive ? 'EQUIPPED' : 'OWNED') :
          (def.gem ? def.price + '💎' : def.price + '🪙')}</div>`;
      cell.addEventListener('click', () => {
        Audio.button();
        if (owned) {
          Storage.patch({ activeSkin: id, useCustom: false });
        } else {
          const cost = def.price;
          if (def.gem ? s.gems >= cost : s.coins >= cost) {
            Storage.patch({
              unlockedSkins: [...s.unlockedSkins, id],
              activeSkin: id,
              useCustom: false,
              coins: def.gem ? s.coins : s.coins - cost,
              gems:  def.gem ? s.gems - cost : s.gems,
            });
            Audio.levelup();
          } else {
            cell.animate(
              [{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
              { duration: 240 });
          }
        }
        renderCharacter(doneEl.dataset.mode);
        refreshMenu();
      });
      grid.appendChild(cell);
    });
  }

  function randomizeCharacter() {
    const sp = SPECIES[Math.floor(Math.random() * SPECIES.length)].id;
    const co = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
    Storage.patch({ customSpecies: sp, customColor: co, useCustom: true });
    const mode = document.getElementById('char-close').dataset.mode || 'normal';
    renderCharacter(mode);
  }

  // === Quests ===
  const QUESTS = [
    { id: 'hop50',    text: 'Hop 50 times in one run',   target: 50,   reward: 100 },
    { id: 'coins25',  text: 'Collect 25 coins in one run', target: 25, reward: 80  },
    { id: 'score100', text: 'Reach score 100 in one run', target: 100, reward: 150 },
    { id: 'combo10',  text: 'Hit a x10 combo',          target: 10,   reward: 200 },
    { id: 'cars30',   text: 'Cross 30 road lanes',      target: 30,   reward: 120 },
  ];
  function todaysQuests() {
    const s = Storage.get();
    const dayStr = new Date().toDateString();
    if (s.quests.today === dayStr && Array.isArray(s.quests.list)) return s.quests.list;
    // Pick 3 quests pseudo-randomly seeded by date
    const seed = hash(dayStr) % QUESTS.length;
    const list = [QUESTS[seed], QUESTS[(seed+1) % QUESTS.length], QUESTS[(seed+2) % QUESTS.length]];
    Storage.patch({ quests: { today: dayStr, list, progress: {} } });
    return list;
  }
  function renderQuests(progress) {
    const c = document.getElementById('go-quests');
    const list = todaysQuests();
    c.innerHTML = '<strong style="font-size:12px;letter-spacing:1.5px;color:#7b87b3">DAILY QUESTS</strong>';
    for (const q of list) {
      const p = Math.min(q.target, (progress && progress[q.id]) || 0);
      const done = p >= q.target;
      const row = document.createElement('div');
      row.className = 'quest-row' + (done ? ' done' : '');
      row.innerHTML = `<span>${q.text}</span><span>${p}/${q.target} · 🪙${q.reward}</span>`;
      c.appendChild(row);
    }
  }
  function hash(s) { let h = 0; for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

  // === World map ===
  function renderWorldMap() {
    const list = document.getElementById('worldmap-list');
    const s = Storage.get();
    const unlocked = new Set(s.unlockedStages || [1]);
    list.innerHTML = '';
    STAGES.forEach(stage => {
      const isUnlocked = unlocked.has(stage.id);
      // A stage counts as cleared if the next stage is unlocked (or it's the
      // last stage and has a recorded score).
      const isCleared = stage.id < STAGES.length
        ? unlocked.has(stage.id + 1)
        : !!(s.stageBest && s.stageBest[stage.id] !== undefined);
      const best = (s.stageBest && s.stageBest[stage.id]) || 0;
      const diff = stageDifficulty(stage.id);
      const biome = BIOMES[stage.biome] || BIOMES.meadow;
      const tile = document.createElement('div');
      tile.className = 'stage-tile' + (isUnlocked ? '' : ' locked') + (isCleared ? ' cleared' : '');
      tile.innerHTML = `
        <div class="stage-badge" style="background:linear-gradient(135deg, ${biome.grass}, ${biome.water});">
          ${isUnlocked ? stage.id : '🔒'}
        </div>
        <div class="stage-info">
          <div class="stage-name">${stage.name}${isCleared ? '  ✓' : ''}</div>
          <div class="stage-meta">${diff.lanes} lanes${best ? ' · Best ' + best : ''}</div>
        </div>
        <div class="stage-action">${isUnlocked ? '▶' : ''}</div>
      `;
      if (isUnlocked) {
        tile.addEventListener('click', () => {
          Audio.button();
          window._game.startRun(stage.id);
        });
      }
      list.appendChild(tile);
    });
  }

  // === Stage complete ===
  function renderStageComplete(stage, score, coinsRun, isBest) {
    document.getElementById('sc-title').textContent = isBest ? 'NEW BEST!' : 'Stage Cleared!';
    document.getElementById('sc-name').textContent = `Stage ${stage.id} — ${stage.name}`;
    document.getElementById('sc-score').textContent = score;
    document.getElementById('sc-coins').textContent = coinsRun;
    const s = Storage.get();
    document.getElementById('sc-best').textContent = (s.stageBest && s.stageBest[stage.id]) || score;
    const nextBtn = document.getElementById('sc-next');
    if (stage.id < STAGES.length) {
      nextBtn.textContent = `Next: Stage ${stage.id + 1}`;
      nextBtn.style.display = '';
    } else {
      nextBtn.style.display = 'none';
    }
  }

  // === Settings ===
  function renderSettings() {
    const s = Storage.get().settings;
    document.getElementById('set-music').checked   = !!s.music;
    document.getElementById('set-sfx').checked     = !!s.sfx;
    document.getElementById('set-haptics').checked = !!s.haptics;
    document.getElementById('set-music-vol').value = Math.round((s.musicVol ?? 0.5) * 100);
    document.getElementById('set-sfx-vol').value   = Math.round((s.sfxVol   ?? 0.8) * 100);
    document.getElementById('set-music-vol').disabled = !s.music;
    document.getElementById('set-sfx-vol').disabled   = !s.sfx;
  }

  return {
    show, hide, only, setHUD, refreshMenu, floatText,
    renderDaily, canClaimDaily, claimDaily,
    renderCharacter, randomizeCharacter,
    startCharPreviewAnim, stopCharPreviewAnim,
    todaysQuests, renderQuests,
    renderSettings,
    renderWorldMap, renderStageComplete,
  };
})();
