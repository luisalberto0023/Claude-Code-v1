// === UI: menus, modals, HUD updates ===
const UI = (() => {
  const screens = ['menu', 'pause', 'gameover', 'daily', 'characters', 'shop', 'leaderboard'];
  function show(id) { document.getElementById(id).classList.remove('hidden'); }
  function hide(id) { document.getElementById(id).classList.add('hidden'); }
  function only(id) { screens.forEach(s => s === id ? show(s) : hide(s)); }

  function setHUD({ score, combo, coins, lives, powerups }) {
    if (score !== undefined) document.getElementById('hud-score').textContent = score;
    if (combo !== undefined) document.getElementById('hud-combo').textContent = 'x' + combo.toFixed(combo < 2 ? 0 : 1);
    if (coins !== undefined) document.getElementById('hud-coins').textContent = coins;
    if (lives !== undefined) {
      const hs = document.querySelectorAll('#hud-lives .heart');
      hs.forEach((h, i) => h.classList.toggle('lost', i >= lives));
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
    grid.innerHTML = '';
    rewards.forEach((r, i) => {
      const cell = document.createElement('div');
      cell.className = 'daily-cell';
      const todayIdx = (s.dailyStreak % rewards.length);
      if (i < (s.dailyStreak % rewards.length)) cell.classList.add('claimed');
      if (i === todayIdx) cell.classList.add('today');
      cell.innerHTML = `Day ${r.day}<strong>${r.gem ? r.gem + '💎' : r.gold + '🪙'}</strong>`;
      grid.appendChild(cell);
    });
    return rewards[s.dailyStreak % rewards.length];
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

  // === Characters / skins ===
  function renderCharacters() {
    const grid = document.getElementById('char-grid');
    const s = Storage.get();
    grid.innerHTML = '';
    Object.entries(SKINS).forEach(([id, def]) => {
      const owned = s.unlockedSkins.includes(id);
      const cell = document.createElement('div');
      cell.className = 'char-cell' + (owned ? '' : ' locked') + (s.activeSkin === id ? ' selected' : '');
      cell.innerHTML = `
        <div class="emoji">${def.emoji}</div>
        <div class="name">${def.name}</div>
        <div class="perk">${def.perk}</div>
        <div class="price">${owned ? (s.activeSkin === id ? 'EQUIPPED' : 'OWNED') :
          (def.gem ? def.price + '💎' : def.price + '🪙')}</div>`;
      cell.addEventListener('click', () => {
        Audio.button();
        if (owned) {
          Storage.patch({ activeSkin: id });
        } else {
          const cost = def.price;
          if (def.gem ? s.gems >= cost : s.coins >= cost) {
            Storage.patch({
              unlockedSkins: [...s.unlockedSkins, id],
              activeSkin: id,
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
        renderCharacters();
        refreshMenu();
      });
      grid.appendChild(cell);
    });
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

  return {
    show, hide, only, setHUD, refreshMenu, floatText,
    renderDaily, canClaimDaily, claimDaily,
    renderCharacters, todaysQuests, renderQuests,
  };
})();
