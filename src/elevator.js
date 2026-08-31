// ---------------------------------------------------------------------------
// Liftul: o cabina care chiar circula intre etaje.
//
// Are apeluri de la palier (cineva asteapta la etajul f) si apeluri din
// cabina (un pasager vrea la etajul f). Cand e liber alege statia cea mai
// apropiata dintre cele cerute. Cabina are locuri limitate, deci la ore de
// varf chiar se face coada la lift.
//
// Randare: partile fixe ale cabinei sunt fuzionate intr-un singur mesh, iar
// cele 4 panouri de usa sunt un InstancedMesh — 2 draw call-uri pentru tot
// liftul, indiferent cat de des se misca.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import * as C from './config.js';
import { state } from './world.js';

export const IDLE = 0, CLOSING = 1, MOVING = 2, OPENING = 3;

export const lift = {
  y: 0,
  floor: 0,
  target: 0,
  mode: IDLE,
  doorT: 1,        // 0 = usi inchise, 1 = complet deschise
  timer: C.LIFT_OPEN_WAIT,
  riders: 0,
};

const hallCalls = new Uint8Array(C.FLOORS);
const carCalls = new Uint8Array(C.FLOORS);
const slots = new Uint8Array(C.LIFT_CAPACITY);

// --- apeluri ----------------------------------------------------------------

/** Cineva asteapta liftul la etajul f. */
export function callFromFloor(f) {
  if (f >= 0 && f < C.FLOORS) hallCalls[f] = 1;
}

/** Un pasager din cabina vrea la etajul f. */
export function callFromCabin(f) {
  if (f >= 0 && f < C.FLOORS) carCalls[f] = 1;
}

/** Cabina e oprita la etajul f cu usile complet deschise? */
export function liftReady(f) {
  return lift.mode === IDLE && lift.floor === f && lift.doorT > 0.98;
}

export function doorsOpen() { return lift.doorT > 0.98 && lift.mode === IDLE; }

// --- locuri in cabina -------------------------------------------------------

export function takeSlot() {
  if (lift.riders >= C.LIFT_CAPACITY) return -1;
  for (let i = 0; i < C.LIFT_CAPACITY; i++) {
    if (slots[i] === 0) { slots[i] = 1; lift.riders++; return i; }
  }
  return -1;
}

export function freeSlot(i) {
  if (i >= 0 && i < C.LIFT_CAPACITY && slots[i] === 1) { slots[i] = 0; lift.riders--; }
}

/** Pozitia pe X a locului `i` din cabina (grila 3x3). */
export function slotX(i) { return C.ELEV_X + ((i % 3) - 1) * 0.85; }
/** Pozitia pe Z a locului `i` din cabina. */
export function slotZ(i) { return (Math.floor(i / 3) - 1) * 0.85; }

/**
 * Locul de asteptare de langa lift.
 * side -1 = spre lobby / palier, +1 = spre hol.
 */
export function waitX(side, k) {
  const base = C.ELEV_X + side * (C.ELEV_HW + C.LIFT_WAIT_GAP);
  return base + side * Math.floor(k / 3) * 0.85;
}
export function waitZ(k) { return -1.1 + (k % 3) * 1.1; }

// --- logica -----------------------------------------------------------------

/** Statia urmatoare: cea mai apropiata dintre cele cerute, sau -1. */
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
      // Sta cu usile deschise. Cat timp e in statie, apelul pentru etajul
      // curent nu are sens — oricine vrea sa urce poate urca acum.
      hallCalls[lift.floor] = 0;
      carCalls[lift.floor] = 0;
      lift.timer -= dt;
      if (lift.timer <= 0) {
        const t = pickTarget();
        if (t >= 0) { lift.target = t; lift.mode = CLOSING; }
        else lift.timer = 0.25;        // nimeni nu-l cheama: mai asteapta
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

// --- randare ----------------------------------------------------------------

let cabin = null;
let doors = null;
const _obj = new THREE.Object3D();

export function buildLift(scene) {
  cabin = new THREE.Group();
  scene.add(cabin);

  const H = 2.4;
  const matCabin = new THREE.MeshLambertMaterial({ color: 0xb9c2cc });
  const matDoor = new THREE.MeshLambertMaterial({ color: 0x8d97a3 });

  // Podeaua cabinei + peretii laterali, intr-o singura geometrie.
  // Fara plafon: la vedere de sus trebuie sa se vada cine e inauntru.
  const parts = [];
  const floorGeo = new THREE.BoxGeometry(C.CABIN_HW * 2, 0.1, C.CABIN_HW * 2);
  floorGeo.translate(0, 0.05, 0);
  parts.push(floorGeo);
  for (const sz of [1, -1]) {
    const w = new THREE.BoxGeometry(C.CABIN_HW * 2, H, 0.12);
    w.translate(0, H / 2, sz * C.CABIN_HW);
    parts.push(w);
  }
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  cabin.add(new THREE.Mesh(merged, matCabin));

  // Patru panouri de usa (doua pe fiecare fata, spre lobby si spre hol).
  // Se "strang" spre margini pe masura ce usa se deschide.
  const panel = new THREE.BoxGeometry(0.14, H - 0.2, 1);
  doors = new THREE.InstancedMesh(panel, matDoor, 4);
  doors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  doors.frustumCulled = false;
  cabin.add(doors);
}

export function renderLift() {
  cabin.position.set(C.ELEV_X, lift.y, 0);

  const half = C.CABIN_HW * 0.95;
  const len = Math.max(0.001, half * (1 - lift.doorT));   // lungimea unui panou
  let k = 0;
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      _obj.position.set(sx * C.CABIN_HW, 1.2, sz * (half - len / 2));
      _obj.rotation.set(0, 0, 0);
      _obj.scale.set(1, 1, len);
      _obj.updateMatrix();
      doors.setMatrixAt(k++, _obj.matrix);
    }
  }
  doors.instanceMatrix.needsUpdate = true;
}
