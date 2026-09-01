// ---------------------------------------------------------------------------
// Sound, synthesised in code with the Web Audio API.
//
// There are no audio files anywhere in this project. Every sound below is a
// couple of oscillators and an envelope, which means zero bytes to download and
// nothing external to fetch - exactly what Poki wants, and it keeps the whole
// build under a megabyte.
//
// Browsers refuse to start audio before a user gesture, so the context is
// created lazily on the first real input.
// ---------------------------------------------------------------------------

let ctx = null;
let master = null;
let muted = false;

// A cheap guard against a hundred coins landing on the same frame and clipping.
let lastAt = 0;
let burst = 0;

export function isMuted() { return muted; }

export function setMuted(on) {
  muted = on;
  if (master) master.gain.value = on ? 0 : 0.9;
}

export function toggleMute() {
  setMuted(!muted);
  return muted;
}

/** Called on the player's first gesture; safe to call repeatedly. */
export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);
  } catch {
    ctx = null;      // audio is a nicety, never a reason to break the game
  }
}

export function suspendAudio() { if (ctx && ctx.state === 'running') ctx.suspend(); }
export function resumeAudio() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

/**
 * One shaped note.
 * @param {number} freq    hertz
 * @param {number} dur     seconds
 * @param {object} opt     type, gain, attack, glide (target hz), delay
 */
function note(freq, dur, opt = {}) {
  if (!ctx || muted) return;

  // Too many at once turns into mush, so thin them out.
  const now = ctx.currentTime;
  if (now - lastAt < 0.03) { if (++burst > 4) return; } else { burst = 0; }
  lastAt = now;

  const t = now + (opt.delay || 0);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opt.type || 'sine';
  osc.frequency.setValueAtTime(freq, t);
  if (opt.glide) osc.frequency.exponentialRampToValueAtTime(opt.glide, t + dur);

  const peak = (opt.gain || 0.2);
  const attack = opt.attack || 0.005;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** Short filtered noise, for footsteps and cleaning. */
function noise(dur, opt = {}) {
  if (!ctx || muted) return;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = opt.type || 'bandpass';
  filter.frequency.value = opt.freq || 900;
  filter.Q.value = opt.q || 1;
  const gain = ctx.createGain();
  gain.gain.value = opt.gain || 0.12;
  src.connect(filter).connect(gain).connect(master);
  src.start();
}

// --- the sounds -------------------------------------------------------------

/** Desk bell when a guest checks in. */
export const sfxCheckIn = () => {
  note(1180, 0.5, { type: 'sine', gain: 0.16 });
  note(1760, 0.35, { type: 'sine', gain: 0.07, delay: 0.005 });
};

/** Cash at check-out; louder for the bigger rooms. */
export const sfxCash = (level = 1) => {
  const base = 520 + Math.min(level, 8) * 34;
  note(base, 0.09, { type: 'triangle', gain: 0.14 });
  note(base * 1.5, 0.16, { type: 'triangle', gain: 0.12, delay: 0.06 });
};

/** A coin for a room service tip. */
export const sfxTip = () => {
  note(1560, 0.07, { type: 'square', gain: 0.05 });
  note(2340, 0.14, { type: 'square', gain: 0.04, delay: 0.05 });
};

/** A guest rings for room service. */
export const sfxRequest = () => {
  note(880, 0.16, { type: 'sine', gain: 0.09 });
  note(1174, 0.22, { type: 'sine', gain: 0.09, delay: 0.13 });
};

/** The lift arriving at a floor. */
export const sfxLift = () => {
  note(660, 0.22, { type: 'sine', gain: 0.1 });
  note(990, 0.3, { type: 'sine', gain: 0.08, delay: 0.11 });
};

export const sfxDoor = () => noise(0.16, { freq: 420, gain: 0.05, q: 0.7 });

export const sfxStep = () => noise(0.06, { freq: 280 + Math.random() * 120, gain: 0.035, q: 1.5 });

export const sfxClean = () => noise(0.3, { freq: 2200, gain: 0.07, q: 0.6, type: 'highpass' });

export const sfxClick = () => note(520, 0.05, { type: 'square', gain: 0.06 });

export const sfxBuy = () => {
  note(600, 0.08, { type: 'triangle', gain: 0.12 });
  note(900, 0.14, { type: 'triangle', gain: 0.1, delay: 0.07 });
};

/** A guest gives up and walks out. */
export const sfxLost = () => note(320, 0.3, { type: 'sawtooth', gain: 0.05, glide: 180 });

/** Rebirth: a rising three-note swell. */
export const sfxRebirth = () => {
  [523, 659, 784, 1047].forEach((f, i) =>
    note(f, 0.5, { type: 'triangle', gain: 0.13, delay: i * 0.11 }));
};

/** Prestige: the same idea, bigger. */
export const sfxPrestige = () => {
  [523, 659, 784, 1047, 1319, 1568].forEach((f, i) =>
    note(f, 0.7, { type: 'triangle', gain: 0.14, delay: i * 0.09 }));
};
