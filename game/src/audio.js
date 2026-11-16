// audio.js — EMBERLINE Foundry 7
//
// Module contract: all sound is synthesised with WebAudio — no audio
// assets, no network. `ensure()` creates the context on the first user
// gesture (browsers block audio before that); every other method is a
// no-op until then, so headless screenshots never crash on audio.
//
// Design rationale: a foundry should sound like one. Shots are a noise
// burst through a low-pass filter plus a low sine thump, tuned per
// weapon (the DMR cracks, the SMG chatters, the sidearm pops). Footsteps
// are short filtered ticks; the plant/defuse beep is a 880 Hz square
// blip; the explosion is brown noise with a 40 Hz drop; round stingers
// are two-note phrases (major for a win, minor for a loss). Distance
// attenuates bot shots so the soundscape carries information.
//
// Tuning notes: master gain 0.5, mute toggled with M. Shot volume
// scales as 1 / (1 + dist * 0.08). All oscillators are created per
// sound and stopped — no persistent nodes, no leaks. Nothing here is
// sim state: audio never feeds the deterministic replay.

export function createAudio() {
  return {
    ctx: null,
    master: null,
    muted: false,
    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        this.master.connect(this.ctx.destination);
      } catch {
        this.ctx = null;
      }
    },
    toggleMute() {
      this.muted = !this.muted;
      if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
      return this.muted;
    },
    _noiseBuffer(seconds = 0.3) {
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
      return buf;
    },
    _burst({ dur = 0.12, freq = 1800, gain = 0.5, type = 'lowpass', when = 0 }) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const t = ctx.currentTime + when;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(dur + 0.05);
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(filter).connect(g).connect(this.master);
      src.start(t);
      src.stop(t + dur + 0.05);
    },
    _tone({ freq = 440, dur = 0.15, gain = 0.3, type = 'sine', slideTo = 0, when = 0 }) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const t = ctx.currentTime + when;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    shot(weaponId, dist = 0) {
      if (!this.ctx) return;
      const vol = 0.55 / (1 + dist * 0.08);
      if (weaponId === 'lr50') {
        this._burst({ dur: 0.22, freq: 900, gain: vol });
        this._tone({ freq: 120, dur: 0.18, gain: vol * 0.9, slideTo: 55 });
      } else if (weaponId === 'vk9') {
        this._burst({ dur: 0.08, freq: 2400, gain: vol * 0.8 });
        this._tone({ freq: 160, dur: 0.08, gain: vol * 0.5, slideTo: 90 });
      } else if (weaponId === 'p9') {
        this._burst({ dur: 0.09, freq: 2000, gain: vol * 0.7 });
        this._tone({ freq: 180, dur: 0.07, gain: vol * 0.5, slideTo: 100 });
      } else {
        this._burst({ dur: 0.14, freq: 1400, gain: vol });
        this._tone({ freq: 140, dur: 0.12, gain: vol * 0.8, slideTo: 60 });
      }
    },
    dryFire() {
      this._tone({ freq: 1200, dur: 0.03, gain: 0.12, type: 'square' });
    },
    reload() {
      this._tone({ freq: 700, dur: 0.04, gain: 0.15, type: 'square' });
      this._tone({ freq: 500, dur: 0.04, gain: 0.15, type: 'square', when: 0.18 });
      this._tone({ freq: 900, dur: 0.04, gain: 0.15, type: 'square', when: 0.36 });
    },
    throwPin() {
      this._tone({ freq: 1000, dur: 0.05, gain: 0.15, type: 'square' });
    },
    step() {
      this._burst({ dur: 0.05, freq: 500, gain: 0.06 });
    },
    plantBeep() {
      this._tone({ freq: 880, dur: 0.08, gain: 0.2, type: 'square' });
    },
    defuseBeep() {
      this._tone({ freq: 660, dur: 0.08, gain: 0.2, type: 'square' });
    },
    bombPlanted() {
      this._tone({ freq: 440, dur: 0.3, gain: 0.3, type: 'square' });
      this._tone({ freq: 440, dur: 0.3, gain: 0.3, type: 'square', when: 0.4 });
    },
    flashPop() {
      this._burst({ dur: 0.1, freq: 4000, gain: 0.4, type: 'highpass' });
    },
    smokeHiss() {
      this._burst({ dur: 0.6, freq: 3000, gain: 0.15, type: 'highpass' });
    },
    explosion() {
      this._burst({ dur: 0.9, freq: 300, gain: 0.9 });
      this._tone({ freq: 90, dur: 0.8, gain: 0.7, slideTo: 35 });
    },
    hitmarker() {
      this._tone({ freq: 1600, dur: 0.04, gain: 0.18, type: 'square' });
    },
    kill() {
      this._tone({ freq: 1200, dur: 0.06, gain: 0.2, type: 'square' });
      this._tone({ freq: 1800, dur: 0.08, gain: 0.2, type: 'square', when: 0.06 });
    },
    roundStart() {
      this._tone({ freq: 523, dur: 0.12, gain: 0.2, type: 'triangle' });
    },
    roundEnd(win) {
      if (win) {
        this._tone({ freq: 523, dur: 0.18, gain: 0.25, type: 'triangle' });
        this._tone({ freq: 659, dur: 0.18, gain: 0.25, type: 'triangle', when: 0.16 });
        this._tone({ freq: 784, dur: 0.3, gain: 0.25, type: 'triangle', when: 0.32 });
      } else {
        this._tone({ freq: 392, dur: 0.2, gain: 0.25, type: 'triangle' });
        this._tone({ freq: 311, dur: 0.35, gain: 0.25, type: 'triangle', when: 0.18 });
      }
    },
  };
}
