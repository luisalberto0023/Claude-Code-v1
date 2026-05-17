// === Procedural SFX + chiptune music (WebAudio) ===
// No assets required — everything is synthesized on the fly.
const Audio = (() => {
  let ctx = null;
  let masterSfx = null;
  let masterMusic = null;

  // Music state
  let musicPlaying = false;
  let musicStep = 0;
  let musicNextTime = 0;
  let musicTimer = null;

  function ensure() {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        masterSfx = ctx.createGain();
        masterMusic = ctx.createGain();
        const s = Storage.get().settings;
        masterSfx.gain.value = s.sfxVol ?? 0.8;
        masterMusic.gain.value = s.musicVol ?? 0.5;
        masterSfx.connect(ctx.destination);
        masterMusic.connect(ctx.destination);
      } catch (e) { ctx = null; }
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ freq = 440, dur = 0.08, type = 'square', vol = 0.18, slide = 0 }) {
    if (!Storage.get().settings.sfx) return;
    const c = ensure(); if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), c.currentTime + dur);
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(masterSfx);
    o.start();
    o.stop(c.currentTime + dur);
  }

  // === Music: a 4-bar chiptune loop in C major, I-vi-IV-V (C-Am-F-G) ===
  const NOTES = {
    F2: 87.31, G2: 98.00, A2: 110.00, B2: 123.47,
    C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00, B3: 246.94,
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00,
  };
  // 32 8th-note steps = 4 bars at 4/4
  const LEAD = [
    'C5','E5','G5','E5', 'C5','D5','E5','G5',   // bar 1: C
    'A4','C5','E5','C5', 'A4','B4','C5','E5',   // bar 2: Am
    'F4','A4','C5','A4', 'F4','G4','A4','C5',   // bar 3: F
    'G4','B4','D5','B4', 'G4','A4','B4','D5',   // bar 4: G
  ];
  const BASS = [
    'C3', null,'C3', null, 'G3', null,'G3', null,
    'A2', null,'A2', null, 'E3', null,'E3', null,
    'F2', null,'F2', null, 'C3', null,'C3', null,
    'G2', null,'G2', null, 'D3', null,'D3', null,
  ];
  const TEMPO = 118; // BPM
  const STEP = 60 / TEMPO / 2; // 8th note in seconds

  function scheduleNote(noteName, time, dur, type, vol) {
    const f = NOTES[noteName]; if (!f) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(vol, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    o.connect(g).connect(masterMusic);
    o.start(time);
    o.stop(time + dur + 0.02);
  }

  function musicTick() {
    if (!ctx || !musicPlaying) return;
    const horizon = ctx.currentTime + 0.18;
    while (musicNextTime < horizon) {
      const lead = LEAD[musicStep % LEAD.length];
      const bass = BASS[musicStep % BASS.length];
      if (lead) scheduleNote(lead, musicNextTime, STEP * 0.9, 'triangle', 0.14);
      if (bass) scheduleNote(bass, musicNextTime, STEP * 1.95, 'square', 0.10);
      musicStep++;
      musicNextTime += STEP;
    }
  }

  function startMusic() {
    if (!Storage.get().settings.music) return;
    const c = ensure(); if (!c) return;
    if (musicPlaying) return;
    musicPlaying = true;
    musicStep = 0;
    musicNextTime = c.currentTime + 0.06;
    musicTimer = setInterval(musicTick, 30);
  }

  function stopMusic() {
    musicPlaying = false;
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  }

  function setMusicVolume(v) {
    const c = ensure(); if (!c || !masterMusic) return;
    masterMusic.gain.setTargetAtTime(v, c.currentTime, 0.02);
  }
  function setSfxVolume(v) {
    const c = ensure(); if (!c || !masterSfx) return;
    masterSfx.gain.setTargetAtTime(v, c.currentTime, 0.02);
  }

  // Pause/resume music with visibility so we don't waste CPU in a backgrounded tab.
  // Only resume if audio has already been unlocked by a user gesture.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopMusic();
    else if (ctx && Storage.get().settings.music) startMusic();
  });

  return {
    hop()      { tone({ freq: 520, dur: 0.07, type: 'square', slide: 160 }); },
    coin()     { tone({ freq: 880, dur: 0.06, type: 'triangle' });
                 setTimeout(() => tone({ freq: 1320, dur: 0.07, type: 'triangle' }), 60); },
    combo()    { tone({ freq: 1200, dur: 0.05, type: 'square' });
                 setTimeout(() => tone({ freq: 1800, dur: 0.08, type: 'square' }), 50); },
    powerup()  { tone({ freq: 300, dur: 0.18, type: 'sawtooth', slide: 800, vol: 0.22 }); },
    death()    { tone({ freq: 220, dur: 0.5, type: 'sawtooth', slide: -180, vol: 0.25 }); },
    button()   { tone({ freq: 660, dur: 0.04, type: 'square', vol: 0.12 }); },
    levelup()  { [0,80,160,240].forEach((d,i) => setTimeout(() =>
                   tone({ freq: 500 + i*200, dur: 0.1, type: 'triangle' }), d)); },
    unlock()   { ensure(); },
    startMusic, stopMusic, setMusicVolume, setSfxVolume,
    isMusicPlaying() { return musicPlaying; },
  };
})();
