// ---------------------------------------------------------------------------
// The hotel's logical state: rooms (structure-of-arrays), money, economy.
// No per-room objects => zero garbage collection in the simulation loop.
// ---------------------------------------------------------------------------
import * as C from './config.js';

const N = C.TOTAL_ROOMS;

export const rooms = {
  floor:    new Uint8Array(N),
  side:     new Uint8Array(N),   // 0 = north (+Z), 1 = south (-Z)
  index:    new Uint8Array(N),   // position along the corridor, 0..ROOMS_PER_SIDE-1
  level:    new Uint8Array(N),   // 0 = locked, 1..MAX_LEVEL = unlocked
  occupant: new Int16Array(N),   // guest id, -1 = free
  dirty:    new Float32Array(N), // seconds left before housekeeping clears it
  cx:       new Float32Array(N), // room centre
  cy:       new Float32Array(N), // floor level
  cz:       new Float32Array(N),
  doorZ:    new Float32Array(N), // Z of the door (corridor edge)
};

export const state = {
  money: C.START_MONEY,
  totalEarned: 0,
  totalSpent: 0,
  servedGuests: 0,
  lostGuests: 0,
  checkouts: 0,
  tips: 0,              // tips collected by the waiter
  servedRequests: 0,
  roomsCleaned: 0,
  staffHired: 0,
  restaurantLevel: 0,
  meansServed: 0,
  missedRequests: 0,
  boosters: 0,          // +25% income each; one rebirth grants one
  rebirths: 0,          // rebirths since the last prestige
  maxRebirths: 0,       // highest ever reached — the new floors depend on it
  prestige: 0,
  hotelName: 'Grand Hotel',
  lifetimeEarned: 0,    // cumulative earnings across every rebirth
  floorUnlocked: [true, false, false, false, false, false],
  activeFloor: 0,
  selected: -1,
  roomsDirty: true,     // asks for a rebuild of the visual instances (level/unlock)
  doorsDirty: true,     // asks only for a refresh of the door colours (occupancy)
  simTime: 0,
};

// Queue of floating "+$" labels, produced by the simulation and drained by
// the UI. Fixed size => no allocations in the simulation loop.
const POPUP_CAP = 32;
export const popupQueue = {
  x: new Float32Array(POPUP_CAP),
  y: new Float32Array(POPUP_CAP),
  z: new Float32Array(POPUP_CAP),
  amount: new Float32Array(POPUP_CAP),
  n: 0,
  cap: POPUP_CAP,
};

export function pushPopup(x, y, z, amount) {
  if (popupQueue.n >= POPUP_CAP) return;
  const i = popupQueue.n++;
  popupQueue.x[i] = x;
  popupQueue.y[i] = y;
  popupQueue.z[i] = z;
  popupQueue.amount[i] = amount;
}

// Income over the last 60s, in one-second buckets (ring buffer, no allocations).
const incomeRing = new Float32Array(60);
let incomeSlot = 0;
let incomeAcc = 0;

export function roomId(floor, side, index) {
  return floor * C.ROOMS_PER_FLOOR + side * C.ROOMS_PER_SIDE + index;
}

export function initWorld() {
  for (let f = 0; f < C.FLOORS; f++) {
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < C.ROOMS_PER_SIDE; i++) {
        const r = roomId(f, s, i);
        const sign = s === 0 ? 1 : -1;
        rooms.floor[r] = f;
        rooms.side[r] = s;
        rooms.index[r] = i;
        rooms.level[r] = 0;
        rooms.occupant[r] = -1;
        rooms.dirty[r] = 0;
        rooms.cx[r] = i * C.ROOM_W + C.ROOM_W / 2;
        rooms.cy[r] = f * C.FLOOR_H;
        rooms.cz[r] = sign * (C.HALF_C + C.ROOM_D / 2);
        rooms.doorZ[r] = sign * C.HALF_C;
      }
    }
  }
  // Two free rooms at the start, so the business can get going.
  rooms.level[roomId(0, 0, 0)] = 1;
  rooms.level[roomId(0, 1, 0)] = 1;
}

// --- Economy ---------------------------------------------------------------

export function unlockedCount() {
  let n = 0;
  for (let r = 0; r < N; r++) if (rooms.level[r] > 0) n++;
  return n;
}

export function occupiedCount() {
  let n = 0;
  for (let r = 0; r < N; r++) if (rooms.occupant[r] >= 0) n++;
  return n;
}

export function unlockCost() {
  return Math.round(C.UNLOCK_BASE * Math.pow(C.UNLOCK_GROWTH, unlockedCount()));
}

export function upgradeCost(level) {
  return Math.round(C.UPGRADE_BASE * Math.pow(C.UPGRADE_GROWTH, level - 1));
}

// --- the booster bonus ---------------------------------------------------

/** The permanent multiplier the boosters give. */
export function incomeMult() {
  return 1 + state.boosters * C.BOOST_BONUS;
}

/**
 * How fast guests flow through the hotel (arrivals + reception).
 * It grows with the boosters: without that, floors unlocked late would sit
 * empty, because the real limit would not be the room count but the desk.
 */
export function flowMult() {
  return Math.min(C.FLOW_MAX, 1 + state.boosters * C.FLOW_PER_BOOST);
}

/** How long a check-in takes right now. */
export function serviceTime() {
  return C.SERVICE_TIME / flowMult();
}

/** Does floor f exist in the building yet? (upper floors appear after rebirths) */
export function floorAvailable(f) {
  return state.maxRebirths >= C.FLOOR_REBIRTH_REQ[f];
}

export function withBonus(v) {
  return Math.round(v * incomeMult());
}

/** What a guest pays at check-out. Already includes the booster bonus. */
export function payout(level) {
  return withBonus(C.PAY_PER_LEVEL * level);
}

/** How long housekeeping takes right now. */
export function cleanTime() {
  return C.CLEAN_TIME / flowMult();
}

/** What cleaning a room yourself pays. */
export function cleanPay(level) {
  return withBonus(C.CLEAN_PAY_PER_LEVEL * level);
}

// --- restaurant -------------------------------------------------------------

const seats = new Uint8Array(C.MAX_SEATS);

/** How many tables are actually in use at the current level. */
export function seatCount() {
  return Math.min(C.MAX_SEATS, state.restaurantLevel * C.SEATS_PER_LEVEL);
}

export function seatX(i) { return C.REST_X0 + 2 + (i % C.SEAT_COLS) * 2.3; }
export function seatZ(i) { return C.REST_Z0 + 2.4 + Math.floor(i / C.SEAT_COLS) * 3.4; }

export function takeSeat() {
  const n = seatCount();
  for (let i = 0; i < n; i++) if (seats[i] === 0) { seats[i] = 1; return i; }
  return -1;
}

export function freeSeat(i) { if (i >= 0 && i < C.MAX_SEATS) seats[i] = 0; }
export function clearSeats() { seats.fill(0); }

export function seatsTaken() {
  let n = 0;
  for (let i = 0; i < seatCount(); i++) if (seats[i]) n++;
  return n;
}

/** What a meal pays, bonus included. */
export function dinePay() {
  return withBonus(C.DINE_PAY_PER_LEVEL * state.restaurantLevel);
}

export function restaurantCost() {
  return Math.round(C.REST_COST_BASE * Math.pow(C.REST_COST_GROWTH, state.restaurantLevel));
}

export function tryUpgradeRestaurant() {
  if (state.restaurantLevel >= C.REST_MAX_LEVEL) return false;
  if (!spend(restaurantCost())) return false;
  state.restaurantLevel++;
  state.roomsDirty = true;      // more tables to draw
  return true;
}

/** What the next hire costs; it rises with every member of staff. */
export function staffCost() {
  return Math.round(C.STAFF_COST_BASE * Math.pow(C.STAFF_COST_GROWTH, state.staffHired));
}

/** Rooms sitting dirty right now, for the HUD. */
export function dirtyCount() {
  let n = 0;
  for (let r = 0; r < N; r++) if (rooms.dirty[r] > 0) n++;
  return n;
}

/** The room service tip, with the bonus applied. */
export function tipFor(level) {
  return withBonus(C.TIP_PER_LEVEL * level);
}

/** The check-in fee, with the bonus applied. */
export function checkInFee() {
  return withBonus(C.CHECK_IN_FEE);
}

export function earn(amount) {
  state.money += amount;
  state.totalEarned += amount;
  incomeAcc += amount;
}

function spend(amount) {
  if (state.money < amount) return false;
  state.money -= amount;
  state.totalSpent += amount;
  return true;
}

export function tryUnlockRoom(r) {
  if (r < 0 || rooms.level[r] > 0) return false;
  if (!state.floorUnlocked[rooms.floor[r]]) return false;
  if (!floorAvailable(rooms.floor[r])) return false;
  if (!spend(unlockCost())) return false;
  rooms.level[r] = 1;
  state.roomsDirty = true;
  return true;
}

export function tryUpgradeRoom(r) {
  if (r < 0 || rooms.level[r] < 1 || rooms.level[r] >= C.MAX_LEVEL) return false;
  if (!spend(upgradeCost(rooms.level[r]))) return false;
  rooms.level[r]++;
  state.roomsDirty = true;
  return true;
}

export function tryUnlockFloor(f) {
  if (f < 0 || f >= C.FLOORS || state.floorUnlocked[f]) return false;
  if (!floorAvailable(f)) return false;
  if (!spend(C.FLOOR_COST[f])) return false;
  state.floorUnlocked[f] = true;
  state.roomsDirty = true;
  return true;
}

// Guests prefer the best free room (highest level).
export function findBestFreeRoom() {
  let best = -1, bestLevel = 0;
  for (let r = 0; r < N; r++) {
    if (rooms.level[r] > bestLevel && rooms.occupant[r] < 0 && rooms.dirty[r] <= 0) {
      best = r;
      bestLevel = rooms.level[r];
    }
  }
  return best;
}

export function anyFreeRoom() {
  for (let r = 0; r < N; r++) {
    if (rooms.level[r] > 0 && rooms.occupant[r] < 0 && rooms.dirty[r] <= 0) return true;
  }
  return false;
}

// The gap between arrivals shrinks as the hotel grows.
export function arrivalInterval() {
  const n = unlockedCount();
  const t = C.ARRIVE_MAX / (1 + n * C.ARRIVE_PER_ROOM);
  const floor = C.ARRIVE_MIN / flowMult();
  return Math.max(floor, Math.min(C.ARRIVE_MAX, t));
}

// --- rebirth --------------------------------------------------------------

/** How much you must earn in a run before you can rebirth. */
export function rebirthGoal() {
  return Math.round(C.REBIRTH_BASE * (1 + state.rebirths * C.REBIRTH_STEP));
}

export function canRebirth() {
  return state.totalEarned >= rebirthGoal();
}

export function canPrestige() {
  return state.rebirths >= C.PRESTIGE_REBIRTHS;
}

/** The next floor to appear and after how many rebirths. null if all are open. */
export function nextFloorUnlock() {
  for (let f = 0; f < C.FLOORS; f++) {
    if (!floorAvailable(f)) return { floor: f, at: C.FLOOR_REBIRTH_REQ[f] };
  }
  return null;
}

/** Reset the current run, keeping what is permanent (boosters, prestige). */
function resetRun() {
  state.money = C.START_MONEY + Math.round(C.BOOST_START_MONEY * Math.sqrt(state.boosters));
  state.totalEarned = 0;
  state.totalSpent = 0;
  state.servedGuests = 0;
  state.lostGuests = 0;
  state.checkouts = 0;
  state.tips = 0;
  state.servedRequests = 0;
  state.missedRequests = 0;

  state.floorUnlocked = state.floorUnlocked.map((_, i) => i === 0);
  state.activeFloor = 0;
  state.selected = -1;

  rooms.level.fill(0);
  rooms.occupant.fill(-1);
  rooms.dirty.fill(0);
  state.restaurantLevel = 0;
  clearSeats();
  rooms.level[roomId(0, 0, 0)] = 1;
  rooms.level[roomId(0, 1, 0)] = 1;

  incomeRing.fill(0);
  incomeAcc = 0;
  popupQueue.n = 0;

  state.roomsDirty = true;
  state.doorsDirty = true;
}

/**
 * Rebirth: you lose the run's progress and gain a permanent booster.
 * Returns true if it actually happened.
 */
export function doRebirth() {
  if (!canRebirth()) return false;
  state.lifetimeEarned += state.totalEarned;
  state.boosters++;
  state.rebirths++;
  state.maxRebirths = Math.max(state.maxRebirths, state.rebirths);
  resetRun();
  return true;
}

/**
 * Prestige: after PRESTIGE_REBIRTHS rebirths, multiply the boosters you already
 * have by 10 and restart the rebirth counter from zero. The floors you earned
 * stay, because they depend on maxRebirths.
 */
export function doPrestige() {
  if (!canPrestige()) return false;
  state.lifetimeEarned += state.totalEarned;
  state.boosters *= C.PRESTIGE_MULT;
  state.prestige++;
  state.rebirths = 0;
  resetRun();
  return true;
}

// Called once per simulated second.
export function rollIncomeBucket() {
  incomeRing[incomeSlot] = incomeAcc;
  incomeAcc = 0;
  incomeSlot = (incomeSlot + 1) % incomeRing.length;
}

export function incomePerMinute() {
  let sum = 0;
  for (let i = 0; i < incomeRing.length; i++) sum += incomeRing[i];
  return sum; // the ring covers exactly 60s
}
