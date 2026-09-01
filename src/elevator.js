// ---------------------------------------------------------------------------
// The lift: a cabin that genuinely travels between floors.
//
// It takes hall calls (somebody is waiting on floor f) and car calls (a
// passenger inside wants floor f). When idle it picks the nearest requested
// stop. The cabin has limited seats, so at peak hours a queue really does
// build up for it.
//
// Rendering: the fixed parts of the cabin are merged into a single mesh and
// the 4 door panels are one InstancedMesh - 2 draw calls for the whole lift,
// no matter how much it moves.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.min.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import * as C from './config.js';
import { state } from './world.js';
import { sfxLift, sfxDoor } from './audio.js';

export const IDLE = 0, CLOSING = 1, MOVING = 2, OPENING = 3;

export const lift = {
  y: 0,
  floor: 0,
  target: 0,
  mode: IDLE,
  doorT: 1,        // 0 = doors shut, 1 = fully open
  timer: C.LIFT_OPEN_WAIT,
  riders: 0,
};

const hallCalls = new Uint8Array(C.FLOORS);
const carCalls = new Uint8Array(C.FLOORS);
const slots = new Uint8Array(C.LIFT_CAPACITY_MAX);

// --- calls ----------------------------------------------------------------

/** Somebody is waiting for the lift on floor f. */
export function callFromFloor(f) {
  if (f >= 0 && f < C.FLOORS) hallCalls[f] = 1;
}

/** A passenger inside the cabin wants floor f. */
export function callFromCabin(f) {
  if (f >= 0 && f < C.FLOORS) carCalls[f] = 1;
}

/** Is the cabin stopped at floor f with the doors fully open? */
export function liftReady(f) {
  return lift.mode === IDLE && lift.floor === f && lift.doorT > 0.98;
}

export function doorsOpen() { return lift.doorT > 0.98 && lift.mode === IDLE; }

// --- seats in the cabin -------------------------------------------------------

/** How many seats the cabin has now - grows with boosters, to keep up. */
export function seats() {
  return Math.min(C.LIFT_CAPACITY_MAX, C.LIFT_CAPACITY + Math.floor(state.boosters / 8));
}

export function takeSlot() {
  const cap = seats();
  if (lift.riders >= cap) return -1;
  for (let i = 0; i < cap; i++) {
    if (slots[i] === 0) { slots[i] = 1; lift.riders++; return i; }
  }
  return -1;
}

export function freeSlot(i) {
  if (i >= 0 && i < C.LIFT_CAPACITY_MAX && slots[i] === 1) { slots[i] = 0; lift.riders--; }
}

// Seats sit on a 6-column grid, which still fits inside the cabin at maximum
// capacity (30 seats = 5 rows).
export function slotX(i) { return C.ELEV_X + ((i % 6) - 2.5) * 0.5; }
export function slotZ(i) { return C.ELEV_Z + (Math.floor(i / 6) - 2) * 0.55; }

// Everyone waits on the same side of the shaft, the one facing the corridor,
// because that is where both the lobby and the corridor lead. Spots spread
// sideways first, then back, and are not capped by the cabin's capacity.
export const LANDING_Z = C.ELEV_Z + C.ELEV_HW + C.LIFT_WAIT_GAP;

export function waitX(side, k) { return C.ELEV_X + ((k % 5) - 2) * 0.95; }
export function waitZ(k) { return LANDING_Z + Math.floor(k / 5) * 0.9; }

// --- logic -----------------------------------------------------------------

/** The next stop: the nearest requested floor, or -1. */
function pickTarget() {
  let best = -1, bestD = Infinity;
  for (let f = 0; f < C.FLOORS; f++) {
    if (f === lift.floor || !state.floorUnlocked[f]) continue;
    if (!hallCalls[f] && !carCalls[f]) continue;
    const d = Math.abs(f - lift.floor);
    if (d < bestD || (d === bestD && f > best)) { bestD = d; best = f; }
  }
  return best;
}

export function updateLift(dt) {
  switch (lift.mode) {
    case IDLE:
      // Sitting with the doors open. While it is at a stop, a call for the
      // current floor is meaningless - anyone who wants in can board now.
      hallCalls[lift.floor] = 0;
      carCalls[lift.floor] = 0;
      lift.timer -= dt;
      if (lift.timer <= 0) {
        const t = pickTarget();
        if (t >= 0) {
          lift.target = t;
          lift.mode = CLOSING;
          if (lift.floor === state.activeFloor) sfxDoor();
        }
        else lift.timer = 0.25;        // nobody is calling: keep waiting
      }
      break;

    case CLOSING:
      lift.doorT -= dt / C.LIFT_DOOR_TIME;
      if (lift.doorT <= 0) { lift.doorT = 0; lift.mode = MOVING; }
      break;

    case MOVING: {
      const ty = lift.target * C.FLOOR_H;
      const dy = ty - lift.y;
      const step = C.LIFT_CAR_SPEED * dt;
      if (Math.abs(dy) <= step) {
        lift.y = ty;
        lift.floor = lift.target;
        lift.mode = OPENING;
        if (lift.floor === state.activeFloor) sfxLift();
      } else {
        lift.y += Math.sign(dy) * step;
      }
      break;
    }

    case OPENING:
      lift.doorT += dt / C.LIFT_DOOR_TIME;
      if (lift.doorT >= 1) { lift.doorT = 1; lift.mode = IDLE; lift.timer = C.LIFT_OPEN_WAIT; }
      break;
  }
}

export function resetLift() {
  lift.y = 0; lift.floor = 0; lift.target = 0;
  lift.mode = IDLE; lift.doorT = 1; lift.timer = C.LIFT_OPEN_WAIT; lift.riders = 0;
  hallCalls.fill(0); carCalls.fill(0); slots.fill(0);
}

// --- rendering ----------------------------------------------------------------

let cabin = null;
let doors = null;
const _obj = new THREE.Object3D();

export function buildLift(scene) {
  cabin = new THREE.Group();
  scene.add(cabin);

  const H = 2.4;
  const matCabin = new THREE.MeshLambertMaterial({ color: 0xb9c2cc });
  const matDoor = new THREE.MeshLambertMaterial({ color: 0x8d97a3 });

  // Cabin floor + side walls, in a single geometry.
  // No ceiling: from a top-down view you must be able to see who is inside.
  const parts = [];
  const floorGeo = new THREE.BoxGeometry(C.CABIN_HW * 2, 0.1, C.CABIN_HW * 2);
  floorGeo.translate(0, 0.05, 0);
  parts.push(floorGeo);
  // Solid walls on the X faces; the doors are on the Z faces, towards the
  // landing and the back of the shaft.
  for (const sx of [1, -1]) {
    const w = new THREE.BoxGeometry(0.12, H, C.CABIN_HW * 2);
    w.translate(sx * C.CABIN_HW, H / 2, 0);
    parts.push(w);
  }
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  cabin.add(new THREE.Mesh(merged, matCabin));

  // Four door panels (two on each face, towards the lobby and the corridor).
  // They shrink towards the edges as the door opens.
  const panel = new THREE.BoxGeometry(1, H - 0.2, 0.14);
  doors = new THREE.InstancedMesh(panel, matDoor, 4);
  doors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  doors.frustumCulled = false;
  cabin.add(doors);
}

export function renderLift() {
  // Hidden when it is not near the floor you are looking at - otherwise the
  // cabin appears to hang in mid-air above an empty plot.
  const visible = Math.abs(lift.y - state.activeFloor * C.FLOOR_H) < C.FLOOR_H * 0.9;
  cabin.visible = visible;
  if (!visible) return;

  cabin.position.set(C.ELEV_X, lift.y, C.ELEV_Z);

  const half = C.CABIN_HW * 0.95;
  const len = Math.max(0.001, half * (1 - lift.doorT));   // length of one panel
  let k = 0;
  for (const sz of [1, -1]) {
    for (const sx of [1, -1]) {
      _obj.position.set(sx * (half - len / 2), 1.2, sz * C.CABIN_HW);
      _obj.rotation.set(0, 0, 0);
      _obj.scale.set(len, 1, 1);
      _obj.updateMatrix();
      doors.setMatrixAt(k++, _obj.matrix);
    }
  }
  doors.instanceMatrix.needsUpdate = true;
}
