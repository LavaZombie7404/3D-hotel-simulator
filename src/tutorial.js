// ---------------------------------------------------------------------------
// First-run guidance.
//
// Poki asks for "visual, intuitive tutorials over text-heavy instructions", so
// this is a bouncing arrow in the world pointing at the thing to go to, with
// one short line of text. Two steps, then it never appears again.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.min.js';
import * as C from './config.js';
import { rooms, state } from './world.js';
import { player } from './player.js';

let arrow = null;
let label = null;
let step = 0;
let done = false;
const _target = new THREE.Vector3();

const STEPS = [
  {
    text: 'Stand in the gold circle to speed up check-in',
    target(out) { out.set(C.DESK_ZONE_X, 1.6, C.DESK_ZONE_Z); return true; },
    complete() { return player.atDesk; },
  },
  {
    text: 'Walk into a marked room to serve it and get paid',
    target(out) {
      // Whichever marked room is nearest, on the floor being looked at.
      const f = state.activeFloor;
      let best = -1, bestD = Infinity;
      for (let r = f * C.ROOMS_PER_FLOOR; r < (f + 1) * C.ROOMS_PER_FLOOR; r++) {
        if (rooms.dirty[r] <= 0 && rooms.occupant[r] < 0) continue;
        if (rooms.dirty[r] <= 0) continue;
        const d = Math.abs(rooms.cx[r] - player.x) + Math.abs(rooms.cz[r] - player.z);
        if (d < bestD) { bestD = d; best = r; }
      }
      if (best < 0) return false;
      out.set(rooms.cx[best], rooms.cy[best] + 1.6, rooms.cz[best]);
      return true;
    },
    complete() { return state.roomsCleaned > 0 || state.servedRequests > 0; },
  },
];

export function buildTutorial(scene) {
  const geo = new THREE.ConeGeometry(0.55, 1.3, 4);
  geo.rotateX(Math.PI);          // point downwards
  arrow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd24b }));
  arrow.visible = false;
  scene.add(arrow);
  label = document.getElementById('objective');
}

/** Skips the tutorial for a returning player. */
export function skipTutorial() {
  done = true;
  if (arrow) arrow.visible = false;
  if (label) label.classList.remove('on');
}

export function tutorialDone() { return done; }

export function updateTutorial(t) {
  if (done) return;

  while (step < STEPS.length && STEPS[step].complete()) step++;
  if (step >= STEPS.length) {
    done = true;
    arrow.visible = false;
    label.classList.remove('on');
    return;
  }

  const cur = STEPS[step];
  if (!cur.target(_target)) {
    // Nothing to point at yet - keep the prompt up but hide the arrow.
    arrow.visible = false;
    label.textContent = cur.text;
    label.classList.add('on');
    return;
  }

  arrow.visible = true;
  arrow.position.set(_target.x, _target.y + 1.9 + Math.sin(t * 4) * 0.22, _target.z);
  arrow.rotation.y = t * 2;
  label.textContent = cur.text;
  label.classList.add('on');
}
