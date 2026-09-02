// ---------------------------------------------------------------------------
// One adapter for every host the game can run on: Poki, CrazyGames, or nothing
// at all (local dev, GitHub Pages, the automated tests).
//
// Only one portal SDK is ever present in a given build - `tools/build.mjs`
// injects the right script tag - so this file never loads anything itself. If
// no SDK is there, every call is a no-op and the game runs exactly the same.
//
// Two rules this file exists to enforce:
//
//   1. A portal SDK must never be able to stop the game. Every call is wrapped,
//      and init() races a timeout, because a promise that never settles would
//      otherwise leave the player staring at an empty screen.
//   2. The SDK is looked up lazily on each call, never captured once at module
//      load. A portal is free to attach its object after our module has been
//      evaluated, and capturing early would silently disable it forever.
//
// The behaviour both portals share, and which shapes the rest:
//   * gameplayStart fires on the player's first input, not on load.
//   * gameplayStop fires on any interruption, and the two must never fire
//     twice in a row - hence the `playing` latch.
//   * Nothing may fire while an ad is on screen, so `adPlaying` gates it all.
// ---------------------------------------------------------------------------

const INIT_TIMEOUT = 4000;

function poki() {
  return (typeof window !== 'undefined' && window.PokiSDK) || null;
}

function crazy() {
  const cg = typeof window !== 'undefined' ? window.CrazyGames : null;
  return (cg && cg.SDK) || null;
}

/** 'poki' | 'crazygames' | 'none', decided fresh each time it is asked. */
export function host() {
  if (poki()) return 'poki';
  if (crazy()) return 'crazygames';
  return 'none';
}

let ready = false;        // has a portal SDK confirmed it is usable?
let playing = false;      // are we inside a gameplayStart block?
let adPlaying = false;    // an ad is up: swallow input and events

export function adInProgress() { return adPlaying; }

/** Never rejects, and never hangs: the game start must not depend on a portal. */
export function initPlatform() {
  const p = poki();
  const cg = crazy();
  if (!p && !cg) return Promise.resolve('none');

  const attempt = new Promise((resolve) => {
    try {
      if (p) {
        Promise.resolve(p.init())
          .then(() => { ready = true; resolve('poki'); })
          .catch(() => resolve('none'));
        return;
      }
      // The CrazyGames v3 SDK does need init(), despite what the v2 docs say:
      // every other call throws "CrazySDK is not initialized yet" until then.
      Promise.resolve(cg.init())
        .then(() => { ready = true; resolve('crazygames'); })
        .catch(() => resolve('none'));
    } catch {
      resolve('none');
    }
  });

  // If a portal never answers, carry on without it rather than never starting.
  const bail = new Promise((resolve) => setTimeout(() => resolve('timeout'), INIT_TIMEOUT));
  return Promise.race([attempt, bail]);
}

/** Wraps every SDK call: a portal hiccup must never surface as a game crash. */
function safe(fn) {
  if (!ready) return;
  try { fn(); } catch { /* ignore */ }
}

export function loadingFinished() {
  safe(() => {
    const p = poki();
    if (p) { p.gameLoadingFinished(); return; }
    const cg = crazy();
    if (cg && cg.game && cg.game.loadingStop) cg.game.loadingStop();
  });
}

export function gameplayStart() {
  if (playing || adPlaying) return;
  playing = true;
  safe(() => {
    const p = poki();
    if (p) { p.gameplayStart(); return; }
    const cg = crazy();
    if (cg && cg.game) cg.game.gameplayStart();
  });
}

export function gameplayStop() {
  if (!playing) return;
  playing = false;
  safe(() => {
    const p = poki();
    if (p) { p.gameplayStop(); return; }
    const cg = crazy();
    if (cg && cg.game) cg.game.gameplayStop();
  });
}

/**
 * A video ad at a natural break. Both portals want these when the player
 * resumes from a pause, never mid-action.
 *
 * @param {() => void} onStart  mute audio and drop input here
 * @param {() => void} onEnd    resume
 */
export function commercialBreak(onStart, onEnd) {
  const p = poki();
  const cg = crazy();
  if (!ready || (!p && !cg)) { onStart(); onEnd(); return Promise.resolve(); }

  gameplayStop();
  adPlaying = true;
  onStart();

  const done = () => { adPlaying = false; onEnd(); };

  if (p) {
    try {
      return p.commercialBreak(() => {}).then(done, done);
    } catch {
      done();
      return Promise.resolve();
    }
  }

  // CrazyGames hands control back through callbacks rather than a promise.
  // During a basic launch its ads are disabled and it calls adError straight
  // away, which is the same path as a failed ad.
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
      resolve();
    };
    try {
      cg.ad.requestAd('midgame', {
        adStarted: () => {},
        adFinished: finish,
        adError: finish,
      });
    } catch {
      finish();
    }
    // Belt and braces: never leave the game frozen if no callback ever comes.
    setTimeout(finish, 45000);
  });
}
