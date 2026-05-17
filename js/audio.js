// === Lightweight procedural SFX (WebAudio) ===
// No assets required for v0.1. Real audio (music + SFX packs) lands in v0.3.
const Audio = (() => {
  let ctx = null;
  function ensure() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { ctx = null; }
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
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur);
  }

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
    unlock(ctx) { ensure(); }, // call from a user gesture to unlock audio
  };
})();
