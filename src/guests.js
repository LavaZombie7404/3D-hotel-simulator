// ---------------------------------------------------------------------------
// The guest simulation.
//
// A guest's cycle:
//   arrives on the road -> enters the lobby -> queues at reception
//   -> pays $1 at check-in -> gets the best free room
//   -> rides the lift up -> enters the room -> stays
//   -> at check-out pays $4 x the room level -> leaves
// If no room is free they wait in the lobby and leave annoyed after
// LOBBY_PATIENCE seconds (the check-in fee stays collected).
//
// All state lives in typed arrays (structure-of-arrays) and every guest is
// drawn from 2 InstancedMeshes => 2 draw calls for the whole crowd.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.min.js';
import * as C from './config.js';
import {
  rooms, state, earn, findBestFreeRoom, arrivalInterval, payout, pushPopup,
  checkInFee, tipFor, serviceTime, cleanTime, cleanPay, dirtyCount,
  takeSeat, freeSeat, seatX, seatZ, dinePay,
} from './world.js';
import {
  lift, callFromFloor, callFromCabin, liftReady, takeSlot, freeSlot,
  slotX, slotZ, waitX, waitZ, resetLift, LANDING_Z,
} from './elevator.js';
import { sfxCheckIn, sfxCash, sfxTip, sfxRequest, sfxLost, sfxClean } from './audio.js';

// Only make noise for things happening on the floor you are looking at,
// otherwise six floors of hotel all ring at once.
const onScreen = (floor) => floor === state.activeFloor;

// --- states ------------------------------------------------------------------
const S_TO_QUEUE = 0;   // walking to their spot in the queue
const S_QUEUE    = 1;   // waiting in the queue
const S_TO_WAIT  = 2;   // walking to the lobby waiting area
const S_WAIT     = 3;   // waiting for a room to free up
const S_TO_ROOM  = 4;   // heading up to the room
const S_STAY     = 5;   // checked in and staying
const S_TO_EXIT  = 6;   // leaving the hotel
const S_LIFT_WAIT = 7;  // waiting for the lift on the landing
const S_LIFT_RIDE = 8;  // inside the cabin
const S_TO_TABLE  = 9;  // heading for a table in the restaurant
const S_EATING    = 10; // at the table

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
const gWait   = new Int16Array(N);   // slot in the waiting area, -1 = none
const gPath   = new Float32Array(N * C.MAX_WP * 3);
const gPathN  = new Uint8Array(N);   // how many waypoints the path has
const gPathI  = new Uint8Array(N);   // the current waypoint

// The lift.
const gFloor = new Uint8Array(N);      // which floor they are on right now
const gDest  = new Uint8Array(N);      // which floor they want
const gAfter = new Uint8Array(N);      // 0 = to the room, 1 = to the exit
const gSlot  = new Int8Array(N);       // seat in the cabin, -1 = not in the lift
const gWaitK = new Uint8Array(N);      // so they do not all stand on the same spot
const gSeat  = new Int8Array(N);       // restaurant table, -1 = not dining

// Room service: every checked-in guest rings for the waiter once.
const gReqWait = new Float32Array(N);  // time left until they ring
const gReqOn   = new Uint8Array(N);    // is a request active?
const gReqLife = new Float32Array(N);  // how much longer they wait for the waiter

// Pool of free ids + a compact list of active guests.
const freeIds = new Int32Array(N);
let freeCount = 0;
const active = new Int32Array(N);
const activeAt = new Int32Array(N);
let activeCount = 0;

const queue = [];                     // ids, in order of arrival at reception
const waitSlots = new Uint8Array(C.MAX_WAIT);
let serviceTimer = 0;
let spawnTimer = 1.5;
let serviceMul = 1;                   // 1 = normal, <1 = the waiter is at the desk

const TINTS = [
  0xe05c5c, 0xe0a35c, 0xd9d95c, 0x7bd15c, 0x5cd1a8, 0x5cb4e0,
  0x6f7ce0, 0xa85ce0, 0xe05cb4, 0xe0e0e0, 0x8a99a8, 0xc2a06b,
];

// --- rendering ----------------------------------------------------------------
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

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); // white base, so instanceColor comes through unchanged
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
  gSeat.fill(-1);
  resetLift();
}

export function guestCount() { return activeCount; }
export function queueLength() { return queue.length; }

/** The waiter in front of the desk => faster check-in. */
export function setServiceBoost(on) { serviceMul = on ? C.SERVICE_BOOST : 1; }

/**
 * The waiter cleans a room by walking into it. Instant, unlike housekeeping,
 * and it pays a little. Returns what it paid, or 0 if there was nothing to do.
 */
export function cleanRoom(r) {
  if (rooms.dirty[r] <= 0) return 0;
  rooms.dirty[r] = 0;
  state.doorsDirty = true;
  state.roomsCleaned++;
  const pay = cleanPay(rooms.level[r]);
  if (pay > 0) {
    earn(pay);
    pushPopup(rooms.cx[r], rooms.cy[r] + 2.4, rooms.cz[r], pay);
  }
  if (rooms.floor[r] === state.activeFloor) sfxClean();
  return pay;
}

export { dirtyCount };

/** Is the room waiting for room service? (drives the marker above it) */
export function roomHasRequest(r) {
  const g = rooms.occupant[r];
  return g >= 0 && gReqOn[g] === 1;
}

/** How many guests are in each state - for diagnostics and tests. */
export function stateCounts() {
  const names = ['to_queue', 'in_queue', 'to_waiting', 'waiting_for_room',
                 'to_room', 'staying', 'to_exit', 'waiting_for_lift', 'in_lift',
                 'to_table', 'eating'];
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
 * The waiter walked into the room. If a request was active it is resolved and
 * the tip collected. Returns the amount (0 if there was nothing to do).
 */
export function serveRoom(r) {
  const g = rooms.occupant[r];
  if (g < 0 || gReqOn[g] !== 1) return 0;
  gReqOn[g] = 0;
  const tip = tipFor(rooms.level[r]);
  earn(tip);
  state.tips += tip;
  state.servedRequests++;
  pushPopup(rooms.cx[r], rooms.cy[r] + 2.4, rooms.cz[r], tip);
  if (onScreen(rooms.floor[r])) sfxTip();
  return tip;
}

// --- pathing -----------------------------------------------------------------

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
    // The ground floor needs no lift.
    wp(g, 0, C.CORRIDOR_X0 + 1.2, 0, 0);
    wp(g, 1, rooms.cx[r], 0, 0);
    wp(g, 2, rooms.cx[r], 0, rooms.doorZ[r]);
    wp(g, 3, rooms.cx[r], 0, rooms.cz[r]);
    setPathLen(g, 4);
    gState[g] = S_TO_ROOM;
    return;
  }
  // Otherwise: to the lift, on the lobby side.
  const k = gWaitK[g];
  wp(g, 0, waitX(-1, k), 0, waitZ(k));
  setPathLen(g, 1);
  gFloor[g] = 0;
  gDest[g] = f;
  gAfter[g] = 0;
  gState[g] = S_LIFT_WAIT;
}

/** Steps out of the cabin on the room's floor and walks to the room. */
function pathFromLiftToRoom(g, r) {
  const fy = rooms.cy[r];
  gY[g] = fy;
  wp(g, 0, C.ELEV_X, fy, LANDING_Z);        // steps out onto the landing
  wp(g, 1, C.CORRIDOR_X0 + 1.2, fy, 0);
  wp(g, 2, rooms.cx[r], fy, 0);
  wp(g, 3, rooms.cx[r], fy, rooms.doorZ[r]);
  wp(g, 4, rooms.cx[r], fy, rooms.cz[r]);
  setPathLen(g, 5);
  gState[g] = S_TO_ROOM;
}

/** Check-out: from the room to the exit, via the lift if upstairs. */
function startExit(g, r) {
  const f = rooms.floor[r];
  const fy = rooms.cy[r];
  if (f === 0) {
    if (tryDine(g)) {
      // Re-route: out of the room first, then across the lobby to the table.
      const seat = gSeat[g];
      wp(g, 0, rooms.cx[r], fy, rooms.doorZ[r]);
      wp(g, 1, rooms.cx[r], fy, 0);
      wp(g, 2, C.CORRIDOR_X0 + 1.2, fy, 0);
      wp(g, 3, C.REST_DOOR_X, 0, C.REST_Z1 + 0.8);
      wp(g, 4, seatX(seat), 0, seatZ(seat));
      setPathLen(g, 5);
      return;
    }
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
  wp(g, 2, waitX(1, k), fy, waitZ(k));     // waits for the lift on the corridor side
  setPathLen(g, 3);
  gFloor[g] = f;
  gDest[g] = 0;
  gAfter[g] = 1;
  gState[g] = S_LIFT_WAIT;
}

/**
 * On the way out, a guest may stop to eat. Returns true if they were routed to
 * a table instead of the door.
 */
function tryDine(g) {
  if (state.restaurantLevel <= 0) return false;
  if (Math.random() > C.DINE_CHANCE) return false;
  const seat = takeSeat();
  if (seat < 0) return false;                 // restaurant full
  gSeat[g] = seat;
  gY[g] = 0;
  wp(g, 0, C.REST_DOOR_X, 0, C.REST_Z1 + 0.8);
  wp(g, 1, seatX(seat), 0, seatZ(seat));
  setPathLen(g, 2);
  gState[g] = S_TO_TABLE;
  return true;
}

/** Steps out of the cabin on the ground floor and leaves the hotel. */
function pathFromLiftToExit(g) {
  gY[g] = 0;
  if (tryDine(g)) return;
  wp(g, 0, C.ELEV_X, 0, LANDING_Z);
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
  gSeat[g] = -1;

  // If reception has too long a line, the guest turns around in the doorway
  // and leaves. That keeps the queue bounded and lets the desk keep serving at
  // full rate, instead of everyone expiring right before their turn comes.
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
  if (gSeat[g] >= 0) { freeSeat(gSeat[g]); gSeat[g] = -1; }
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

// --- movement --------------------------------------------------------------

/** Advances along the path. Returns true once the last waypoint is reached. */
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

  // Nobody moves vertically on their own any more: that is what the lift is for.
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

// --- reception ---------------------------------------------------------------

/**
 * When somebody leaves the queue, everyone else moves up one spot.
 *
 * This moves only the target, NOT the state: resetting the head of the queue
 * back to S_TO_QUEUE would restart the service timer every time anybody left
 * the line, and check-in would stall completely.
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
  const fee = checkInFee();
  earn(fee);
  state.servedGuests++;
  pushPopup(gX[g], gY[g] + 2.0, gZ[g], fee);
  if (onScreen(0)) sfxCheckIn();

  if (assignRoom(g)) return;

  // No free room: wait in the lobby.
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
  if (onScreen(rooms.floor[r])) sfxCash(rooms.level[r]);

  rooms.occupant[r] = -1;
  rooms.dirty[r] = cleanTime();      // housekeeping will get to it eventually
  state.doorsDirty = true;
  startExit(g, r);
  gRoom[g] = -1;
}

// --- simulation step --------------------------------------------------------

export function simulate(dt) {
  // New arrivals.
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnGuest();
    spawnTimer = arrivalInterval() * (0.7 + Math.random() * 0.6);
  }

  // Serving whoever is at the head of the queue.
  if (queue.length > 0) {
    const g = queue[0];
    if (gState[g] === S_TO_QUEUE && arrived(g)) gState[g] = S_QUEUE;
    if (gState[g] === S_QUEUE) {
      serviceTimer += dt;
      if (serviceTimer >= serviceTime() * serviceMul) {
        serviceTimer = 0;
        queue.shift();
        checkIn(g);
        reflowQueue();
      }
    }
  } else {
    serviceTimer = 0;
  }

  // Housekeeping working through the dirty rooms on its own.
  for (let r = 0; r < C.TOTAL_ROOMS; r++) {
    if (rooms.dirty[r] <= 0) continue;
    rooms.dirty[r] -= dt;
    if (rooms.dirty[r] <= 0) { rooms.dirty[r] = 0; state.doorsDirty = true; }
  }

  // Every active guest.
  for (let a = activeCount - 1; a >= 0; a--) {
    const g = active[a];
    const done = advance(g, dt);

    switch (gState[g]) {
      case S_TO_QUEUE:
      case S_QUEUE:
        if (done) gState[g] = S_QUEUE;
        // Nobody queues forever: if you are not at the desk speeding check-in
        // up, you start losing customers before they even reach the counter.
        gTimer[g] -= dt;
        if (gTimer[g] <= 0) leaveQueue(g);
        break;

      case S_TO_WAIT:
        if (done) gState[g] = S_WAIT;
        gTimer[g] -= dt;   // patience ticks down while walking to the spot too
        if (gTimer[g] <= 0) giveUp(g);
        break;

      case S_WAIT:
        gTimer[g] -= dt;
        gRetry[g] -= dt;
        if (gRetry[g] <= 0) {          // retry twice a second
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
          // One request per stay, and only if there is still time to wait.
          if (gReqWait[g] <= 0 && gTimer[g] > C.REQ_TTL * 0.5) {
            gReqOn[g] = 1;
            gReqLife[g] = C.REQ_TTL;
            if (onScreen(rooms.floor[gRoom[g]])) sfxRequest();
          }
        }
        if (gTimer[g] <= 0) checkOut(g);
        break;

      case S_LIFT_WAIT:
        // While waiting, keep the call button pressed.
        callFromFloor(gFloor[g]);
        if (done && liftReady(gFloor[g])) {
          const slot = takeSlot();
          if (slot >= 0) {
            gSlot[g] = slot;
            gState[g] = S_LIFT_RIDE;
            setPathLen(g, 0);         // from here on the cabin positions them
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

      case S_TO_TABLE:
        if (done) { gState[g] = S_EATING; gTimer[g] = C.DINE_TIME; }
        break;

      case S_EATING:
        gTimer[g] -= dt;
        if (gTimer[g] <= 0) {
          const pay = dinePay();
          earn(pay);
          state.meansServed++;
          pushPopup(gX[g], gY[g] + 2.0, gZ[g], pay);
          if (state.activeFloor === 0) sfxCash(state.restaurantLevel);
          freeSeat(gSeat[g]);
          gSeat[g] = -1;
          wp(g, 0, C.REST_DOOR_X, 0, C.REST_Z1 + 0.8);
          wp(g, 1, C.LOBBY_X0 + 1.5, 0, 0);
          wp(g, 2, C.SPAWN_X, 0, 0);
          setPathLen(g, 3);
          gState[g] = S_TO_EXIT;
        }
        break;

      case S_TO_EXIT:
        if (done) despawnGuest(g);
        break;
    }
  }
}

/** Walks out annoyed straight from the queue. */
function leaveQueue(g) {
  const i = queue.indexOf(g);
  if (i >= 0) {
    queue.splice(i, 1);
    reflowQueue();   // the service timer is kept: the next guest steps up immediately
  }
  state.lostGuests++;
  gState[g] = S_TO_EXIT;
  pathLobbyToExit(g);
}

function giveUp(g) {
  freeWaitSlot(g);
  state.lostGuests++;
  if (onScreen(0)) sfxLost();
  gState[g] = S_TO_EXIT;
  pathLobbyToExit(g);
}

// --- rendering ----------------------------------------------------------------

/** Draws only the guests on the visible floor. */
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
