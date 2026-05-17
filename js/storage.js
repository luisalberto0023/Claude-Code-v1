// === Persistent player state (localStorage) ===
// Future: swap with cloud save (Firebase / Game Center / Play Games)
const Storage = (() => {
  const KEY = 'hopster_save_v1';
  const defaults = {
    bestScore: 0,
    coins: 0,
    gems: 50,
    level: 1,
    xp: 0,
    unlockedSkins: ['frog'],
    activeSkin: 'frog',
    dailyStreak: 0,
    lastDaily: null,
    totalRuns: 0,
    totalHops: 0,
    settings: { sfx: true, music: true, haptics: true, musicVol: 0.5, sfxVol: 0.8 },
    quests: { today: null, progress: {} },
  };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { ...defaults };
      return { ...defaults, ...JSON.parse(raw) };
    } catch (e) { return { ...defaults }; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { /* private mode etc. */ }
  }
  function get() { return state; }
  function patch(p) { Object.assign(state, p); save(); }
  function reset() { state = { ...defaults }; save(); }

  // XP curve: each level needs 100 * level XP
  function addXP(amount) {
    state.xp += amount;
    let leveled = false;
    while (state.xp >= 100 * state.level) {
      state.xp -= 100 * state.level;
      state.level++;
      leveled = true;
    }
    save();
    return leveled;
  }

  return { get, patch, save, reset, addXP };
})();
