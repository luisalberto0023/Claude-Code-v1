/* ──────────────────────────────────────────────────────────────────────────
   Nexus Grid audio engine

   Everything is synthesized live with the Web Audio API — no audio files, so
   it adds zero weight, works fully offline (in the APK and the single-file
   build), and has no licensing strings attached. Style: neon synthwave.

   - SFX: line draw, sector capture (pitch climbs with combos), power-ups,
     win / lose / draw, UI clicks, blitz timer ticks, invalid move.
   - Music: a procedural synthwave loop (bass + arpeggio + pad) scheduled on
     the Web Audio clock.

   Browsers block audio until a user gesture, so call `unlock()` from a click.
   Mute preferences persist in localStorage.
   ────────────────────────────────────────────────────────────────────────── */

const LS_SFX = 'nexus.sfxMuted';
const LS_MUSIC = 'nexus.musicMuted';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.sfxMuted = readBool(LS_SFX, false);
    this.musicMuted = readBool(LS_MUSIC, false);
    this._musicTimer = null;
    this._nextNoteTime = 0;
    this._step = 0;
    this._musicRunning = false;
  }

  /* Create the context lazily on the first user gesture. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = this.sfxMuted ? 0 : 0.9;
      this.sfxBus.connect(this.master);

      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicMuted ? 0 : 0.32;
      this.musicBus.connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /* ── Mute controls ── */
  toggleSfx() { this.setSfxMuted(!this.sfxMuted); return this.sfxMuted; }
  toggleMusic() { this.setMusicMuted(!this.musicMuted); return this.musicMuted; }

  setSfxMuted(v) {
    this.sfxMuted = v;
    writeBool(LS_SFX, v);
    if (this.sfxBus) ramp(this.sfxBus.gain, v ? 0 : 0.9, this.ctx, 0.05);
  }
  setMusicMuted(v) {
    this.musicMuted = v;
    writeBool(LS_MUSIC, v);
    if (this.musicBus) ramp(this.musicBus.gain, v ? 0 : 0.32, this.ctx, 0.4);
  }

  /* ── Low-level voice ── */
  _voice({ freq, type = 'sine', dur = 0.15, attack = 0.005, gain = 0.3, slideTo = null, bus = this.sfxBus, detune = 0, filter = null }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (detune) osc.detune.value = detune;
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let node = osc;
    if (filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.value = filter.freq || 1200;
      if (filter.q != null) f.Q.value = filter.q;
      osc.connect(f); f.connect(g);
      node = f;
    } else {
      osc.connect(g);
    }
    g.connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /* ── SFX ── */
  // player: 1 (cyan, brighter) or 2 (crimson, deeper)
  lineDraw(player = 1) {
    this.unlock();
    const base = player === 2 ? 320 : 480;
    this._voice({ freq: base, slideTo: base * 1.5, type: 'triangle', dur: 0.09, gain: 0.22, filter: { type: 'lowpass', freq: 2600 } });
  }

  capture(combo = 1) {
    this.unlock();
    const steps = Math.min(combo, 5);
    const root = 523.25; // C5
    const ratios = [1, 1.26, 1.5, 1.9, 2.4];
    for (let i = 0; i <= steps; i++) {
      const f = root * (ratios[Math.min(i, ratios.length - 1)]) * (1 + (combo - 1) * 0.05);
      setTimeout(() => this._voice({ freq: f, type: 'square', dur: 0.16, gain: 0.18, filter: { type: 'lowpass', freq: 3200 } }), i * 55);
    }
    // sparkle tail
    setTimeout(() => this._voice({ freq: root * 3, type: 'sine', dur: 0.25, gain: 0.12 }), steps * 55 + 40);
  }

  powerUp(kind = 'surge') {
    this.unlock();
    if (kind === 'void') {
      this._voice({ freq: 700, slideTo: 120, type: 'sawtooth', dur: 0.5, gain: 0.2, filter: { type: 'lowpass', freq: 1400, q: 6 } });
    } else if (kind === 'cascade') {
      [0, 1, 2, 3].forEach(i => setTimeout(() => this._voice({ freq: 300 + i * 180, type: 'square', dur: 0.12, gain: 0.16 }), i * 45));
    } else { // surge
      this._voice({ freq: 200, slideTo: 900, type: 'sawtooth', dur: 0.35, gain: 0.2, filter: { type: 'lowpass', freq: 2600, q: 4 } });
    }
  }

  click() {
    this.unlock();
    this._voice({ freq: 660, type: 'square', dur: 0.05, gain: 0.12, filter: { type: 'highpass', freq: 400 } });
  }

  invalid() {
    this.unlock();
    this._voice({ freq: 140, type: 'sawtooth', dur: 0.18, gain: 0.18, filter: { type: 'lowpass', freq: 800 } });
  }

  tick(urgent = false) {
    this.unlock();
    this._voice({ freq: urgent ? 880 : 440, type: 'square', dur: 0.05, gain: urgent ? 0.18 : 0.1 });
  }

  win() {
    this.unlock();
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C E G C
    notes.forEach((f, i) => setTimeout(() => this._voice({ freq: f, type: 'square', dur: 0.4, gain: 0.2, filter: { type: 'lowpass', freq: 3000 } }), i * 110));
  }

  lose() {
    this.unlock();
    const notes = [440, 392, 329.63, 261.63]; // descending
    notes.forEach((f, i) => setTimeout(() => this._voice({ freq: f, type: 'sawtooth', dur: 0.45, gain: 0.18, filter: { type: 'lowpass', freq: 1400 } }), i * 130));
  }

  draw() {
    this.unlock();
    [523.25, 523.25].forEach((f, i) => setTimeout(() => this._voice({ freq: f, type: 'triangle', dur: 0.5, gain: 0.16 }), i * 200));
  }

  /* ── Procedural synthwave music ──
     A 16-step loop, ~100 BPM. Am – F – C – G vibe. */
  startMusic() {
    this.unlock();
    if (!this.ctx || this._musicRunning) return;
    this._musicRunning = true;
    this._step = 0;
    this._nextNoteTime = this.ctx.currentTime + 0.1;
    const stepDur = 0.16; // ~16th notes

    // chord roots per 4-step bar (Am, F, C, G)
    const bass = [110.0, 87.31, 130.81, 98.0]; // A2 F2 C3 G2
    const arpScales = [
      [220.0, 261.63, 329.63],   // Am: A C E
      [174.61, 220.0, 261.63],   // F:  F A C
      [261.63, 329.63, 392.0],   // C:  C E G
      [196.0, 246.94, 293.66],   // G:  G B D
    ];

    const scheduler = () => {
      if (!this.ctx) return;
      while (this._nextNoteTime < this.ctx.currentTime + 0.12) {
        const step = this._step % 16;
        const bar = Math.floor(step / 4);
        const t = this._nextNoteTime;

        // Bass on each beat (every 4 steps) + offbeat pulse
        if (step % 4 === 0) this._musicNote(bass[bar], 'sawtooth', t, stepDur * 3.5, 0.14, 700);
        if (step % 4 === 2) this._musicNote(bass[bar] * 2, 'triangle', t, stepDur * 1.2, 0.06, 900);

        // Arpeggio every step
        const arp = arpScales[bar];
        const note = arp[step % arp.length] * 2;
        this._musicNote(note, 'square', t, stepDur * 0.9, 0.05, 2400);

        // Soft pad chord at start of each bar
        if (step % 4 === 0) {
          this._musicNote(arp[0], 'sawtooth', t, stepDur * 4, 0.04, 1100, 8);
          this._musicNote(arp[2], 'sawtooth', t, stepDur * 4, 0.04, 1100, -8);
        }

        this._nextNoteTime += stepDur;
        this._step++;
      }
    };
    this._musicTimer = setInterval(scheduler, 25);
  }

  stopMusic() {
    this._musicRunning = false;
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
  }

  _musicNote(freq, type, t, dur, gain, cutoff, detune = 0) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.value = freq;
    if (detune) osc.detune.value = detune;
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(f); f.connect(g); g.connect(this.musicBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

function ramp(param, value, ctx, time) {
  if (!ctx) { param.value = value; return; }
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
  param.linearRampToValueAtTime(value, t + time);
}

function readBool(key, def) {
  try { const v = localStorage.getItem(key); return v == null ? def : v === '1'; }
  catch { return def; }
}
function writeBool(key, v) {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
}

export const audio = new AudioEngine();
