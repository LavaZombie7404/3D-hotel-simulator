// ---------------------------------------------------------------------------
// Thin wrapper around the Poki SDK.
//
// The SDK is only present when the game runs on Poki. Everywhere else (local
// dev, the automated tests, a plain static host) every call here turns into a
// no-op, so the game never depends on it being there.
//
// Poki's rules that shape this file:
//   * gameplayStart() fires on the player's first input, not on load.
//   * gameplayStop() fires on any interruption, and the two can never fire
//     twice in a row - hence the `playing` latch below.
//   * No SDK event may fire during an ad, so `adPlaying` gates everything.
// ---------------------------------------------------------------------------

const sdk = typeof window !== 'undefined' ? window.PokiSDK : undefined;
export const hasPoki = !!sdk;

let playing = false;      // are we currently inside a gameplayStart block?
let adPlaying = false;    // an ad is on screen: swallow input and events

export function adInProgress() { return adPlaying; }

/** Resolves once the SDK is ready, or immediately if it is not there. */
export function initPoki() {
  if (!sdk) return Promise.resolve(false);
  return sdk.init()
    .then(() => true)
    .catch(() => false);   // never let a failed SDK block the game
}

export function loadingFinished() {
  if (sdk) sdk.gameLoadingFinished();
}

export function gameplayStart() {
  if (playing || adPlaying) return;
  playing = true;
  if (sdk) sdk.gameplayStart();
}

export function gameplayStop() {
  if (!playing) return;
  playing = false;
  if (sdk) sdk.gameplayStop();
}

/**
 * A video ad at a natural break. Poki wants these when the player resumes from
 * a pause, never mid-action.
 *
 * @param {() => void} onStart  mute audio and drop input here
 * @param {() => void} onEnd    resume
 */
export function commercialBreak(onStart, onEnd) {
  if (!sdk) { onStart(); onEnd(); return Promise.resolve(); }
  gameplayStop();
  adPlaying = true;
  onStart();
  return sdk.commercialBreak(() => {}).then(() => {
    adPlaying = false;
    onEnd();
  }).catch(() => {
    adPlaying = false;
    onEnd();
  });
}
