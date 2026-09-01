// ---------------------------------------------------------------------------
// Hired staff: porters who answer room service, and cleaners who turn rooms
// around after check-out.
//
// Each hire works one floor and never leaves it. That is a deliberate design
// choice, not a shortcut: it keeps them out of the lift (which is already a
// contested resource), it makes hiring a per-floor decision the player can
// reason about, and it means their pathing is a straight corridor walk.
//
// They are slower than you are, so buying staff automates a floor without
// making you pointless - you are still the fastest pair of hands in the hotel,
// and reception is still yours alone.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.min.js';
import * as C from './config.js';
import { rooms, state, staffCost } from './world.js';
import { serveRoom, cleanRoom, roomHasRequest } from './guests.js';

export const PORTER = 0;
export const CLEANER = 1;

const N = C.MAX_STAFF;

const sKind  = new Uint8Array(N);
const sFloor = new Uint8Array(N);
const sX     = new Float32Array(N);
const sZ     = new Float32Array(N);
const sYaw   = new Float32Array(N);
const sRoom  = new Int16Array(N);     // room being walked to, -1 = idle
const sWork  = new Float32Array(N);   // seconds left of the little work pause
const sIdleX = new Float32Array(N);   // where they loiter when there is nothing to do
let count = 0;

// Rooms already claimed this tick, so two cleaners do not chase the same mess.
const claimed = new Int32Array(N);

export function staffCount() { return count; }

export function staffOnFloor(floor, kind) {
  let n = 0;
  for (let i = 0; i < count; i++) if (sFloor[i] === floor && sKind[i] === kind) n++;
  return n;
}

export function canHire(floor, kind) {
  return count < N &&
         staffOnFloor(floor, kind) < C.MAX_STAFF_PER_KIND &&
         state.money >= staffCost();
}

/** Returns true if the hire went through. */
export function hire(floor, kind) {
  if (!canHire(floor, kind)) return false;
  const cost = staffCost();
  state.money -= cost;
  state.totalSpent += cost;

  const i = count++;
  sKind[i] = kind;
  sFloor[i] = floor;
  sRoom[i] = -1;
  sWork[i] = 0;
  // Spread them along the corridor so they do not stack on one spot.
  sIdleX[i] = 3 + ((i * 7) % (C.CORRIDOR_X1 - 6));
  sX[i] = sIdleX[i];
  sZ[i] = kind === PORTER ? 1.1 : -1.1;
  sYaw[i] = 0;
  state.staffHired++;
  return true;
}

export function resetStaff() {
  count = 0;
  state.staffHired = 0;
}

/** For saving: a compact list of [floor, kind] pairs. */
export function serializeStaff() {
  const out = [];
  for (let i = 0; i < count; i++) out.push(sFloor[i], sKind[i]);
  return out;
}

export function restoreStaff(list) {
  resetStaff();
  if (!Array.isArray(list)) return;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const floor = list[i] | 0, kind = list[i + 1] | 0;
    if (floor < 0 || floor >= C.FLOORS || count >= N) continue;
    // Bypass the cost: this is restoring a hire that was already paid for.
    const j = count++;
    sKind[j] = kind === CLEANER ? CLEANER : PORTER;
    sFloor[j] = floor;
    sRoom[j] = -1;
    sWork[j] = 0;
    sIdleX[j] = 3 + ((j * 7) % (C.CORRIDOR_X1 - 6));
    sX[j] = sIdleX[j];
    sZ[j] = sKind[j] === PORTER ? 1.1 : -1.1;
    sYaw[j] = 0;
  }
  state.staffHired = count;
}

// --- behaviour --------------------------------------------------------------

/** Does this room need this kind of worker? */
function needsWork(r, kind) {
  if (rooms.level[r] === 0) return false;
  return kind === PORTER ? roomHasRequest(r) : rooms.dirty[r] > 0;
}

/** The nearest room on their floor that wants them and nobody else has taken. */
function pickRoom(i) {
  const f = sFloor[i];
  const kind = sKind[i];
  let best = -1, bestD = Infinity;
  for (let r = f * C.ROOMS_PER_FLOOR; r < (f + 1) * C.ROOMS_PER_FLOOR; r++) {
    if (!needsWork(r, kind)) continue;
    let taken = false;
    for (let j = 0; j < count; j++) {
      if (j !== i && claimed[j] === r) { taken = true; break; }
    }
    if (taken) continue;
    const d = Math.abs(rooms.cx[r] - sX[i]) + Math.abs(rooms.cz[r] - sZ[i]);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/** Step towards (tx, tz); returns true once there. */
function step(i, tx, tz, dt) {
  const dx = tx - sX[i], dz = tz - sZ[i];
  const d = Math.hypot(dx, dz);
  if (d < 0.08) return true;
  const move = Math.min(d, C.STAFF_SPEED * dt);
  sX[i] += (dx / d) * move;
  sZ[i] += (dz / d) * move;
  sYaw[i] = Math.atan2(dx, dz);
  return false;
}

export function updateStaff(dt) {
  for (let i = 0; i < count; i++) claimed[i] = sRoom[i];

  for (let i = 0; i < count; i++) {
    if (sWork[i] > 0) { sWork[i] -= dt; continue; }

    if (sRoom[i] < 0 || !needsWork(sRoom[i], sKind[i])) {
      sRoom[i] = pickRoom(i);
      claimed[i] = sRoom[i];
    }

    const r = sRoom[i];
    if (r < 0) {
      // Nothing to do: drift back to their spot in the corridor.
      step(i, sIdleX[i], sKind[i] === PORTER ? 1.1 : -1.1, dt);
      continue;
    }

    // Corridor first, then in through the door - the same route a guest takes.
    const inRoom = Math.abs(sZ[i]) > C.HALF_C;
    const aligned = Math.abs(sX[i] - rooms.cx[r]) < 0.12;
    if (!inRoom && !aligned) {
      step(i, rooms.cx[r], sZ[i] > 0 ? 1.1 : -1.1, dt);
    } else if (step(i, rooms.cx[r], rooms.cz[r], dt)) {
      if (sKind[i] === PORTER) serveRoom(r);
      else cleanRoom(r);
      sRoom[i] = -1;
      sWork[i] = C.STAFF_WORK_PAUSE;
    }
  }
}

// --- rendering --------------------------------------------------------------

let body = null;
let head = null;
const _obj = new THREE.Object3D();
const _col = new THREE.Color();
const TINT = [0x2f6f9a, 0x3f9a5f];    // porter blue, cleaner green

export function buildStaffMeshes(scene) {
  const bodyGeo = new THREE.CapsuleGeometry(0.27, 0.64, 3, 8);
  bodyGeo.translate(0, 0.61, 0);
  const headGeo = new THREE.SphereGeometry(0.22, 8, 6);
  headGeo.translate(0, 1.38, 0);

  body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  head = new THREE.InstancedMesh(headGeo, new THREE.MeshLambertMaterial({ color: 0xe8c39a }), N);
  for (const m of [body, head]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    scene.add(m);
  }
}

export function renderStaff() {
  let k = 0;
  for (let i = 0; i < count; i++) {
    if (sFloor[i] !== state.activeFloor) continue;
    _obj.position.set(sX[i], sFloor[i] * C.FLOOR_H, sZ[i]);
    _obj.rotation.set(0, sYaw[i], 0);
    _obj.updateMatrix();
    body.setMatrixAt(k, _obj.matrix);
    head.setMatrixAt(k, _obj.matrix);
    _col.setHex(TINT[sKind[i]]);
    body.setColorAt(k, _col);
    k++;
  }
  body.count = k;
  head.count = k;
  body.instanceMatrix.needsUpdate = true;
  head.instanceMatrix.needsUpdate = true;
  if (body.instanceColor) body.instanceColor.needsUpdate = true;
}
