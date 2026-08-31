// ---------------------------------------------------------------------------
// Touch controls, required because Poki games must work on phones and tablets.
//
// Two pieces:
//   * a virtual joystick in the bottom-left that drives the waiter, writing
//     into the same `stick` vector the keyboard path already merges;
//   * a contextual lift button, which calls the cabin when you are standing in
//     an empty shaft and rides when you are inside it.
//
// The joystick is a DOM element, so its touches never reach OrbitControls and
// dragging the camera with a second finger keeps working.
// ---------------------------------------------------------------------------
import { stick, player, inShaft, canRide } from './player.js';

const $ = (id) => document.getElementById(id);

/** Coarse pointer means phone or tablet; Poki wants tablets on touch controls. */
export const isTouch = (typeof window !== 'undefined') &&
  (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);

let knob = null;
let pad = null;
let liftBtn = null;
let padId = -1;             // pointerId currently driving the stick
let radius = 46;

export function initTouch(handlers) {
  pad = $('stick');
  knob = pad.firstElementChild;
  liftBtn = $('lift-btn');

  liftBtn.addEventListener('click', () => handlers.onLift());

  if (!isTouch) return;
  document.body.classList.add('touch');
  pad.classList.add('on');
  radius = pad.offsetWidth / 2 - 12;

  pad.addEventListener('pointerdown', (e) => {
    padId = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    move(e);
    handlers.onFirstInput();
  });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === padId) move(e); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    pad.addEventListener(type, (e) => { if (e.pointerId === padId) release(); });
  }
}

function move(e) {
  const r = pad.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2);
  let dy = e.clientY - (r.top + r.height / 2);
  const len = Math.hypot(dx, dy);
  if (len > radius) { dx *= radius / len; dy *= radius / len; }
  knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  // Screen-down is +Y but means "away from the camera", which is -forward.
  stick.x = dx / radius;
  stick.y = -dy / radius;
}

function release() {
  padId = -1;
  stick.x = 0;
  stick.y = 0;
  knob.style.transform = '';
}

/** Drops the stick when the game pauses, so the waiter does not keep walking. */
export function releaseStick() { if (pad) release(); }

/**
 * The lift button only appears where it can do something: inside the cabin, or
 * standing in the shaft with the cabin elsewhere.
 */
export function updateLiftButton() {
  if (!liftBtn) return;
  const riding = canRide();
  const waiting = !riding && inShaft();
  liftBtn.classList.toggle('on', riding || waiting);
  if (riding) liftBtn.textContent = 'Go up';
  else if (waiting) liftBtn.textContent = 'Call lift';
  void player;
}
