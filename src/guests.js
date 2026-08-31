// ---------------------------------------------------------------------------
// Simularea oaspetilor.
//
// Ciclul unui client:
//   soseste pe drum -> intra in lobby -> sta la coada la receptie
//   -> plateste 1$ la check-in -> primeste cea mai buna camera libera
//   -> urca cu liftul -> intra in camera -> sta cazat
//   -> la check-out plateste 4$ x nivelul camerei -> pleaca
// Daca nu e nicio camera libera, asteapta in lobby si pleaca nervos
// dupa LOBBY_PATIENCE secunde (banii de check-in raman incasati).
//
// Toata starea e in typed arrays (structure-of-arrays) si toti oaspetii sunt
// desenati din 2 InstancedMesh-uri => 2 draw call-uri pentru toata multimea.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.js';
import * as C from './config.js';
import {
  rooms, state, earn, findBestFreeRoom, arrivalInterval, payout, pushPopup,
} from './world.js';
import {
  lift, callFromFloor, callFromCabin, liftReady, takeSlot, freeSlot,
  slotX, slotZ, waitX, waitZ, resetLift,
} from './elevator.js';

// --- stari ------------------------------------------------------------------
const S_TO_QUEUE = 0;   // merge spre locul lui la coada
const S_QUEUE    = 1;   // asteapta la coada
const S_TO_WAIT  = 2;   // merge spre zona de asteptare din lobby
const S_WAIT     = 3;   // asteapta o camera libera
const S_TO_ROOM  = 4;   // urca spre camera
const S_STAY     = 5;   // e cazat
const S_TO_EXIT  = 6;   // pleaca din hotel
const S_LIFT_WAIT = 7;  // asteapta liftul pe palier
const S_LIFT_RIDE = 8;  // e in cabina

const N = C.MAX_GUESTS;

const gState  = new Uint8Array(N);
const gRoom   = new Int16Array(N);
const gTimer  = new Float32Array(N);
const gRetry  = new Float32Array(N);
const gX      = new Float32Array(N);
const gY      = new Float32Array(N);
const gZ      = new Float32Array(N);
const gYaw    = new Float32Array(N);
const gTint   = new Uint8Array(N);
const gWait   = new Int16Array(N);   // slotul din zona de asteptare, -1 = niciunul
const gPath   = new Float32Array(N * C.MAX_WP * 3);
const gPathN  = new Uint8Array(N);   // cate waypoint-uri are traseul
const gPathI  = new Uint8Array(N);   // waypoint-ul curent

// Liftul.
const gFloor = new Uint8Array(N);      // pe ce etaj se afla acum
const gDest  = new Uint8Array(N);      // la ce etaj vrea
const gAfter = new Uint8Array(N);      // 0 = spre camera, 1 = spre iesire
const gSlot  = new Int8Array(N);       // locul din cabina, -1 = nu e in lift
const gWaitK = new Uint8Array(N);      // ca sa nu stea toti in acelasi punct

// Room service: fiecare client cazat cere o data chelnerul.
const gReqWait = new Float32Array(N);  // cat mai are pana cere
const gReqOn   = new Uint8Array(N);    // are cerere activa?
const gReqLife = new Float32Array(N);  // cat mai asteapta dupa chelner

// Pool de id-uri libere + lista compacta de oaspeti activi.
const freeIds = new Int32Array(N);
let freeCount = 0;
const active = new Int32Array(N);
const activeAt = new Int32Array(N);
let activeCount = 0;

const queue = [];                     // id-uri, in ordinea sosirii la receptie
const waitSlots = new Uint8Array(C.MAX_WAIT);
let serviceTimer = 0;
let spawnTimer = 1.5;
let serviceMul = 1;                   // 1 = normal, <1 = chelnerul e la receptie

const TINTS = [
  0xe05c5c, 0xe0a35c, 0xd9d95c, 0x7bd15c, 0x5cd1a8, 0x5cb4e0,
  0x6f7ce0, 0xa85ce0, 0xe05cb4, 0xe0e0e0, 0x8a99a8, 0xc2a06b,
];

// --- randare ----------------------------------------------------------------
export const guestGfx = { body: null, head: null };
const _obj = new THREE.Object3D();
const _col = new THREE.Color();

const BODY_Y = 0.60;
const HEAD_Y = 1.36;

export function buildGuestMeshes(scene) {
  const bodyGeo = new THREE.CapsuleGeometry(C.GUEST_R, 0.62, 2, 8);
  bodyGeo.translate(0, BODY_Y, 0);
  const headGeo = new THREE.SphereGeometry(0.22, 8, 6);
  headGeo.translate(0, HEAD_Y, 0);

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); // tinta pentru instanceColor
  const headMat = new THREE.MeshLambertMaterial({ color: 0xe8c39a });

  guestGfx.body = new THREE.InstancedMesh(bodyGeo, bodyMat, N);
  guestGfx.head = new THREE.InstancedMesh(headGeo, headMat, N);
  for (const m of [guestGfx.body, guestGfx.head]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    scene.add(m);
  }
}

export function resetGuests() {
  freeCount = 0;
  for (let i = N - 1; i >= 0; i--) freeIds[freeCount++] = i;
  activeCount = 0;
  queue.length = 0;
  waitSlots.fill(0);
  serviceTimer = 0;
  spawnTimer = 1.5;
  serviceMul = 1;
  gReqOn.fill(0);
  gSlot.fill(-1);
  resetLift();
}

export function guestCount() { return activeCount; }
export function queueLength() { return queue.length; }

/** Chelnerul in fata receptiei => check-in mai rapid. */
export function setServiceBoost(on) { serviceMul = on ? C.SERVICE_BOOST : 1; }

/** Camera asteapta room service? (folosit pentru semnele de deasupra ei) */
export function roomHasRequest(r) {
  const g = rooms.occupant[r];
  return g >= 0 && gReqOn[g] === 1;
}

/** Cati oaspeti sunt in fiecare stare — pentru diagnostic si teste. */
export function stateCounts() {
  const names = ['spre_coada', 'la_coada', 'spre_asteptare', 'asteapta_camera',
                 'spre_camera', 'cazat', 'spre_iesire', 'asteapta_liftul', 'in_lift'];
  const out = {};
  for (const n of names) out[n] = 0;
  for (let a = 0; a < activeCount; a++) out[names[gState[active[a]]]]++;
  return out;
}

export function activeRequests() {
  let n = 0;
  for (let a = 0; a < activeCount; a++) if (gReqOn[active[a]]) n++;
  return n;
}

/**
 * Chelnerul a intrat in camera. Daca era o cerere activa, o rezolva si
 * incaseaza bacsisul. Returneaza suma (0 daca nu era nimic de facut).
 */
export function serveRoom(r) {
  const g = rooms.occupant[r];
  if (g < 0 || gReqOn[g] !== 1) return 0;
  gReqOn[g] = 0;
  const tip = C.TIP_PER_LEVEL * rooms.level[r];
  earn(tip);
  state.tips += tip;
  state.servedRequests++;
  pushPopup(rooms.cx[r], rooms.cy[r] + 2.4, rooms.cz[r], tip);
  return tip;
}

// --- traseu -----------------------------------------------------------------

function wp(g, i, x, y, z) {
  const b = (g * C.MAX_WP + i) * 3;
  gPath[b] = x; gPath[b + 1] = y; gPath[b + 2] = z;
}

function setPathLen(g, n) { gPathN[g] = n; gPathI[g] = 0; }

function queueSlotX(slot) { return C.QUEUE_X + (slot % 8) * C.QUEUE_STEP; }
function queueSlotZ(slot) { return C.QUEUE_Z - Math.floor(slot / 8) * C.QUEUE_STEP; }
function waitSlotX(slot)  { return C.WAIT_X + (slot % C.WAIT_COLS) * C.WAIT_STEP; }
function waitSlotZ(slot)  { return C.WAIT_Z - Math.floor(slot / C.WAIT_COLS) * C.WAIT_STEP; }

function pathToQueue(g, slot) {
  wp(g, 0, C.LOBBY_X0 + 1.5, 0, 0);
  wp(g, 1, queueSlotX(slot), 0, queueSlotZ(slot));
  setPathLen(g, 2);
}

function pathToRoom(g, r) {
  const f = rooms.floor[r];
  if (f === 0) {
    // Parterul n-are nevoie de lift.
    wp(g, 0, C.CORRIDOR_X0 + 1.2, 0, 0);
    wp(g, 1, rooms.cx[r], 0, 0);
    wp(g, 2, rooms.cx[r], 0, rooms.doorZ[r]);
    wp(g, 3, rooms.cx[r], 0, rooms.cz[r]);
    setPathLen(g, 4);
    gState[g] = S_TO_ROOM;
    return;
  }
  // Altfel: la lift, pe partea dinspre lobby.
  const k = gWaitK[g];
  wp(g, 0, waitX(-1, k), 0, waitZ(k));
  setPathLen(g, 1);
  gFloor[g] = 0;
  gDest[g] = f;
  gAfter[g] = 0;
  gState[g] = S_LIFT_WAIT;
}

/** Coboara din cabina la etajul camerei si merge in camera. */
function pathFromLiftToRoom(g, r) {
  const fy = rooms.cy[r];
  gY[g] = fy;
  wp(g, 0, C.ELEV_X + C.ELEV_HW + C.LIFT_WAIT_GAP, fy, 0);   // iese spre hol
  wp(g, 1, C.CORRIDOR_X0 + 1.2, fy, 0);
  wp(g, 2, rooms.cx[r], fy, 0);
  wp(g, 3, rooms.cx[r], fy, rooms.doorZ[r]);
  wp(g, 4, rooms.cx[r], fy, rooms.cz[r]);
  setPathLen(g, 5);
  gState[g] = S_TO_ROOM;
}

/** Check-out: din camera spre iesire, cu lift daca e la etaj. */
function startExit(g, r) {
  const f = rooms.floor[r];
  const fy = rooms.cy[r];
  if (f === 0) {
    wp(g, 0, rooms.cx[r], fy, rooms.doorZ[r]);
    wp(g, 1, rooms.cx[r], fy, 0);
    wp(g, 2, C.CORRIDOR_X0 + 1.2, fy, 0);
    wp(g, 3, C.LOBBY_X0 + 1.5, 0, 0);
    wp(g, 4, C.SPAWN_X, 0, 0);
    setPathLen(g, 5);
    gState[g] = S_TO_EXIT;
    return;
  }
  const k = gWaitK[g];
  wp(g, 0, rooms.cx[r], fy, rooms.doorZ[r]);
  wp(g, 1, rooms.cx[r], fy, 0);
  wp(g, 2, waitX(1, k), fy, waitZ(k));     // asteapta liftul pe partea holului
  setPathLen(g, 3);
  gFloor[g] = f;
  gDest[g] = 0;
  gAfter[g] = 1;
  gState[g] = S_LIFT_WAIT;
}

/** Coboara din cabina la parter si iese din hotel. */
function pathFromLiftToExit(g) {
  gY[g] = 0;
  wp(g, 0, C.ELEV_X - C.ELEV_HW - C.LIFT_WAIT_GAP, 0, 0);
  wp(g, 1, C.LOBBY_X0 + 1.5, 0, 0);
  wp(g, 2, C.SPAWN_X, 0, 0);
  setPathLen(g, 3);
  gState[g] = S_TO_EXIT;
}

function pathLobbyToExit(g) {
  wp(g, 0, C.LOBBY_X0 + 1.5, 0, 0);
  wp(g, 1, C.SPAWN_X, 0, 0);
  setPathLen(g, 2);
}

// --- pool -------------------------------------------------------------------

function spawnGuest() {
  if (freeCount === 0) return -1;
  const g = freeIds[--freeCount];
  activeAt[g] = activeCount;
  active[activeCount++] = g;

  gX[g] = C.SPAWN_X;
  gY[g] = 0;
  gZ[g] = (Math.random() - 0.5) * 3;
  gYaw[g] = Math.PI / 2;
  gRoom[g] = -1;
  gWait[g] = -1;
  gTimer[g] = 0;
  gRetry[g] = 0;
  gTint[g] = (Math.random() * TINTS.length) | 0;
  gFloor[g] = 0;
  gDest[g] = 0;
  gAfter[g] = 0;
  gSlot[g] = -1;
  gWaitK[g] = g % C.LIFT_CAPACITY;

  // Daca la receptie e coada prea mare, clientul se razgandeste in usa si
  // pleaca. Asa coada ramane marginita si ghiseul serveste in continuare la
  // capacitate maxima, in loc sa expire toti fix inainte sa le vina randul.
  if (queue.length >= C.MAX_QUEUE) {
    state.lostGuests++;
    gState[g] = S_TO_EXIT;
    pathLobbyToExit(g);
    return g;
  }

  gState[g] = S_TO_QUEUE;
  gTimer[g] = C.QUEUE_PATIENCE;
  queue.push(g);
  pathToQueue(g, queue.length - 1);
  return g;
}

function despawnGuest(g) {
  if (gSlot[g] >= 0) { freeSlot(gSlot[g]); gSlot[g] = -1; }
  const at = activeAt[g];
  const last = active[--activeCount];
  active[at] = last;
  activeAt[last] = at;
  freeIds[freeCount++] = g;
}

function allocWaitSlot() {
  for (let i = 0; i < C.MAX_WAIT; i++) if (waitSlots[i] === 0) { waitSlots[i] = 1; return i; }
  return -1;
}

function freeWaitSlot(g) {
  if (gWait[g] >= 0) { waitSlots[gWait[g]] = 0; gWait[g] = -1; }
}

// --- deplasare --------------------------------------------------------------

/** Avanseaza pe traseu. Returneaza true cand a ajuns la ultimul waypoint. */
function advance(g, dt) {
  let i = gPathI[g];
  const n = gPathN[g];
  if (i >= n) return true;

  const b = (g * C.MAX_WP + i) * 3;
  const dx = gPath[b] - gX[g];
  const dy = gPath[b + 1] - gY[g];
  const dz = gPath[b + 2] - gZ[g];
  const horiz = Math.sqrt(dx * dx + dz * dz);
  const dist = Math.sqrt(horiz * horiz + dy * dy);

  if (dist < 1e-4) {
    gPathI[g] = ++i;
    return i >= n;
  }

  // Pe verticala nu se mai misca nimeni singur: pentru asta e liftul.
  const step = C.WALK_SPEED * dt;

  if (step >= dist) {
    gX[g] = gPath[b]; gY[g] = gPath[b + 1]; gZ[g] = gPath[b + 2];
    gPathI[g] = ++i;
    if (horiz > 1e-3) gYaw[g] = Math.atan2(dx, dz);
    return i >= n;
  }

  const k = step / dist;
  gX[g] += dx * k;
  gY[g] += dy * k;
  gZ[g] += dz * k;
  if (horiz > 1e-3) gYaw[g] = Math.atan2(dx, dz);
  return false;
}

function arrived(g) { return gPathI[g] >= gPathN[g]; }

// --- receptie ---------------------------------------------------------------

/**
 * Dupa ce pleaca cineva de la coada, restul avanseaza cu un loc.
 *
 * Muta doar tinta, NU si starea: daca ar reseta starea celui din capul cozii
 * inapoi in S_TO_QUEUE, cronometrul de servire ar porni de la zero de fiecare
 * data cand pleaca cineva din coada, si check-in-ul s-ar bloca de tot.
 */
function reflowQueue() {
  for (let i = 0; i < queue.length; i++) {
    const g = queue[i];
    wp(g, 0, queueSlotX(i), 0, queueSlotZ(i));
    setPathLen(g, 1);
  }
}

function assignRoom(g) {
  const r = findBestFreeRoom();
  if (r < 0) return false;
  rooms.occupant[r] = g;
  gRoom[g] = r;
  pathToRoom(g, r);
  state.doorsDirty = true;
  freeWaitSlot(g);
  return true;
}

function checkIn(g) {
  earn(C.CHECK_IN_FEE);
  state.servedGuests++;
  pushPopup(gX[g], gY[g] + 2.0, gZ[g], C.CHECK_IN_FEE);

  if (assignRoom(g)) return;

  // Nicio camera libera: asteapta in lobby.
  const slot = allocWaitSlot();
  gWait[g] = slot;
  gState[g] = S_TO_WAIT;
  gTimer[g] = C.LOBBY_PATIENCE;
  gRetry[g] = 0;
  if (slot < 0) {
    wp(g, 0, C.WAIT_X, 0, C.WAIT_Z);
  } else {
    wp(g, 0, waitSlotX(slot), 0, waitSlotZ(slot));
  }
  setPathLen(g, 1);
}

function checkOut(g) {
  const r = gRoom[g];
  gReqOn[g] = 0;
  const amount = payout(rooms.level[r]);
  earn(amount);
  state.checkouts++;
  pushPopup(rooms.cx[r], rooms.cy[r] + 2.2, rooms.cz[r], amount);

  rooms.occupant[r] = -1;
  state.doorsDirty = true;
  startExit(g, r);
  gRoom[g] = -1;
}

// --- pas de simulare --------------------------------------------------------

export function simulate(dt) {
  // Sosiri noi.
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnGuest();
    spawnTimer = arrivalInterval() * (0.7 + Math.random() * 0.6);
  }

  // Servirea celui din capul cozii.
  if (queue.length > 0) {
    const g = queue[0];
    if (gState[g] === S_TO_QUEUE && arrived(g)) gState[g] = S_QUEUE;
    if (gState[g] === S_QUEUE) {
      serviceTimer += dt;
      if (serviceTimer >= C.SERVICE_TIME * serviceMul) {
        serviceTimer = 0;
        queue.shift();
        checkIn(g);
        reflowQueue();
      }
    }
  } else {
    serviceTimer = 0;
  }

  // Fiecare oaspete activ.
  for (let a = activeCount - 1; a >= 0; a--) {
    const g = active[a];
    const done = advance(g, dt);

    switch (gState[g]) {
      case S_TO_QUEUE:
      case S_QUEUE:
        if (done) gState[g] = S_QUEUE;
        // Nimeni nu sta la infinit la coada: daca nu esti la receptie ca sa
        // grabesti check-in-ul, incepi sa pierzi clienti inainte sa ajunga la birou.
        gTimer[g] -= dt;
        if (gTimer[g] <= 0) leaveQueue(g);
        break;

      case S_TO_WAIT:
        if (done) gState[g] = S_WAIT;
        gTimer[g] -= dt;   // rabdarea scade si cat timp merge spre loc
        if (gTimer[g] <= 0) giveUp(g);
        break;

      case S_WAIT:
        gTimer[g] -= dt;
        gRetry[g] -= dt;
        if (gRetry[g] <= 0) {          // reincearca de 2 ori pe secunda
          gRetry[g] = 0.5;
          if (assignRoom(g)) break;
        }
        if (gTimer[g] <= 0) giveUp(g);
        break;

      case S_TO_ROOM:
        if (done) {
          gState[g] = S_STAY;
          gTimer[g] = C.STAY_TIME;
          gReqOn[g] = 0;
          gReqWait[g] = C.REQ_DELAY_MIN + Math.random() * (C.REQ_DELAY_MAX - C.REQ_DELAY_MIN);
        }
        break;

      case S_STAY:
        gTimer[g] -= dt;
        if (gReqOn[g]) {
          gReqLife[g] -= dt;
          if (gReqLife[g] <= 0) { gReqOn[g] = 0; state.missedRequests++; }
        } else if (gReqWait[g] > 0) {
          gReqWait[g] -= dt;
          // O singura cerere per cazare, si numai daca mai are timp sa astepte.
          if (gReqWait[g] <= 0 && gTimer[g] > C.REQ_TTL * 0.5) {
            gReqOn[g] = 1;
            gReqLife[g] = C.REQ_TTL;
          }
        }
        if (gTimer[g] <= 0) checkOut(g);
        break;

      case S_LIFT_WAIT:
        // Cat asteapta, tine apelul apasat.
        callFromFloor(gFloor[g]);
        if (done && liftReady(gFloor[g])) {
          const slot = takeSlot();
          if (slot >= 0) {
            gSlot[g] = slot;
            gState[g] = S_LIFT_RIDE;
            setPathLen(g, 0);         // de aici incolo il pozitioneaza cabina
          }
        }
        break;

      case S_LIFT_RIDE: {
        const dest = gDest[g];
        callFromCabin(dest);
        gX[g] = slotX(gSlot[g]);
        gZ[g] = slotZ(gSlot[g]);
        gY[g] = lift.y;
        if (liftReady(dest)) {
          freeSlot(gSlot[g]);
          gSlot[g] = -1;
          gFloor[g] = dest;
          if (gAfter[g] === 0) pathFromLiftToRoom(g, gRoom[g]);
          else pathFromLiftToExit(g);
        }
        break;
      }

      case S_TO_EXIT:
        if (done) despawnGuest(g);
        break;
    }
  }
}

/** Pleaca nervos direct de la coada. */
function leaveQueue(g) {
  const i = queue.indexOf(g);
  if (i >= 0) {
    queue.splice(i, 1);
    reflowQueue();   // cronometrul de servire se pastreaza: urmatorul intra imediat
  }
  state.lostGuests++;
  gState[g] = S_TO_EXIT;
  pathLobbyToExit(g);
}

function giveUp(g) {
  freeWaitSlot(g);
  state.lostGuests++;
  gState[g] = S_TO_EXIT;
  pathLobbyToExit(g);
}

// --- randare ----------------------------------------------------------------

/** Deseneaza doar oaspetii de pe etajul vizibil. */
export function renderGuests() {
  const floorY = state.activeFloor * C.FLOOR_H;
  const body = guestGfx.body, head = guestGfx.head;
  let k = 0;

  for (let a = 0; a < activeCount; a++) {
    const g = active[a];
    if (Math.abs(gY[g] - floorY) > C.FLOOR_H * 0.9) continue;

    _obj.position.set(gX[g], gY[g], gZ[g]);
    _obj.rotation.set(0, gYaw[g], 0);
    _obj.updateMatrix();
    body.setMatrixAt(k, _obj.matrix);
    head.setMatrixAt(k, _obj.matrix);
    _col.setHex(TINTS[gTint[g]]);
    body.setColorAt(k, _col);
    k++;
  }

  body.count = k;
  head.count = k;
  body.instanceMatrix.needsUpdate = true;
  head.instanceMatrix.needsUpdate = true;
  if (body.instanceColor) body.instanceColor.needsUpdate = true;
}
