// ---------------------------------------------------------------------------
// One adapter for every host the game can run on: Poki, CrazyGames, or nothing
// at all (local dev, GitHub Pages, the automated tests).
//
// Only one portal SDK is ever present in a given build - `tools/build.mjs`
// injects the right script tag - so this file never loads anything itself. If
// no SDK is there, every call is a no-op and the game runs exactly the same.
//
// The rules both portals share, and which shape this file:
//   * gameplayStart fires on the player's first input, not on load.
//   * gameplayStop fires on any interruption, and the two must never fire
//     twice in a row - hence the `playing` latch.
//   * Nothing may fire while an ad is on screen, so `adPlaying` gates it all.
// ---------------------------------------------------------------------------

const poki = typeof window !== 'undefined' ? window.PokiSDK : undefined;
const crazy = typeof window !== 'undefined' && window.CrazyGames
  ? window.CrazyGames.SDK
  : undefined;

export const host = poki ? 'poki' : (crazy ? 'crazygames' : 'none');

let ready = !crazy;       // CrazyGames refuses every call until init() resolves
let playing = false;      // are we inside a gameplayStart block?
let adPlaying = false;    // an ad is up: swallow input and events

export function adInProgress() { return adPlaying; }

/** Resolves once the SDK is ready, or immediately when there is none. */
export function initPlatform() {
  if (poki) {
    return poki.init().then(() => true).catch(() => false);
  }
  if (crazy) {
    // The v3 SDK really does need init(), despite what the v2 docs say - every
    // other call throws "CrazySDK is not initialized yet" until it resolves.
    try {
      return Promise.resolve(crazy.init())
        .then(() => { ready = true; return true; })
        .catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  }
  return Promise.resolve(false);
}

export function loadingFinished() {
  try {
    if (poki) poki.gameLoadingFinished();
    else if (crazy && ready) crazy.game.loadingStop();
  } catch { /* a portal hiccup must never stop the game */ }
}

export function gameplayStart() {
  if (playing || adPlaying) return;
  playing = true;
  try {
    if (poki) poki.gameplayStart();
    else if (crazy && ready) crazy.game.gameplayStart();
  } catch { /* ignore */ }
}

export function gameplayStop() {
  if (!playing) return;
  playing = false;
  try {
    if (poki) poki.gameplayStop();
    else if (crazy && ready) crazy.game.gameplayStop();
  } catch { /* ignore */ }
}

/**
 * A video ad at a natural break. Both portals want these when the player
 * resumes from a pause, never mid-action.
 *
 * @param {() => void} onStart  mute audio and drop input here
 * @param {() => void} onEnd    resume
 */
export function commercialBreak(onStart, onEnd) {
  if (host === 'none' || !ready) { onStart(); onEnd(); return Promise.resolve(); }

  gameplayStop();
  adPlaying = true;
  onStart();

  const done = () => { adPlaying = false; onEnd(); };

  if (poki) {
    return poki.commercialBreak(() => {}).then(done).catch(done);
  }

  // CrazyGames hands back control through callbacks rather than a promise.
  // During a basic launch its ads are disabled and it calls adError straight
  // away, which is exactly the same path as a failed ad.
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
      resolve();
    };
    try {
      crazy.ad.requestAd('midgame', {
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
