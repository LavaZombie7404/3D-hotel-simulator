// ---------------------------------------------------------------------------
// Starea logica a hotelului: camere (structure-of-arrays), bani, economie.
// Fara obiecte per-camera => zero garbage collection in bucla de simulare.
// ---------------------------------------------------------------------------
import * as C from './config.js';

const N = C.TOTAL_ROOMS;

export const rooms = {
  floor:    new Uint8Array(N),
  side:     new Uint8Array(N),   // 0 = nord (+Z), 1 = sud (-Z)
  index:    new Uint8Array(N),   // pozitia pe hol, 0..ROOMS_PER_SIDE-1
  level:    new Uint8Array(N),   // 0 = blocata, 1..MAX_LEVEL = deblocata
  occupant: new Int16Array(N),   // id-ul oaspetelui, -1 = libera
  cx:       new Float32Array(N), // centrul camerei
  cy:       new Float32Array(N), // nivelul podelei
  cz:       new Float32Array(N),
  doorZ:    new Float32Array(N), // Z-ul usii (marginea holului)
};

export const state = {
  money: C.START_MONEY,
  totalEarned: 0,
  totalSpent: 0,
  servedGuests: 0,
  lostGuests: 0,
  checkouts: 0,
  tips: 0,              // bacsis incasat de chelner
  servedRequests: 0,
  missedRequests: 0,
  floorUnlocked: [true, false, false],
  activeFloor: 0,
  selected: -1,
  roomsDirty: true,     // cere reconstructia instantelor vizuale (nivel/deblocare)
  doorsDirty: true,     // cere doar reimprospatarea culorilor usilor (ocupare)
  simTime: 0,
};

// Coada de texte flotante "+$" produsa de simulare si consumata de UI.
// Dimensiune fixa => fara alocari in bucla de simulare.
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

// Venit pe ultimele 60s, in bucketi de cate o secunda (ring buffer, fara alocari).
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
        rooms.cx[r] = i * C.ROOM_W + C.ROOM_W / 2;
        rooms.cy[r] = f * C.FLOOR_H;
        rooms.cz[r] = sign * (C.HALF_C + C.ROOM_D / 2);
        rooms.doorZ[r] = sign * C.HALF_C;
      }
    }
  }
  // Doua camere gratuite la start, ca sa poata porni afacerea.
  rooms.level[roomId(0, 0, 0)] = 1;
  rooms.level[roomId(0, 1, 0)] = 1;
}

// --- Economie ---------------------------------------------------------------

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

export function payout(level) {
  return C.PAY_PER_LEVEL * level;
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
  if (!spend(C.FLOOR_COST[f])) return false;
  state.floorUnlocked[f] = true;
  state.roomsDirty = true;
  return true;
}

// Oaspetii prefera camera cea mai buna libera (nivel maxim).
export function findBestFreeRoom() {
  let best = -1, bestLevel = 0;
  for (let r = 0; r < N; r++) {
    if (rooms.level[r] > bestLevel && rooms.occupant[r] < 0) {
      best = r;
      bestLevel = rooms.level[r];
    }
  }
  return best;
}

export function anyFreeRoom() {
  for (let r = 0; r < N; r++) if (rooms.level[r] > 0 && rooms.occupant[r] < 0) return true;
  return false;
}

// Intervalul dintre sosiri scade pe masura ce hotelul creste.
export function arrivalInterval() {
  const n = unlockedCount();
  const t = C.ARRIVE_MAX / (1 + n * C.ARRIVE_PER_ROOM);
  return Math.max(C.ARRIVE_MIN, Math.min(C.ARRIVE_MAX, t));
}

// Apelat o data pe secunda de simulare.
export function rollIncomeBucket() {
  incomeRing[incomeSlot] = incomeAcc;
  incomeAcc = 0;
  incomeSlot = (incomeSlot + 1) % incomeRing.length;
}

export function incomePerMinute() {
  let sum = 0;
  for (let i = 0; i < incomeRing.length; i++) sum += incomeRing[i];
  return sum; // ring-ul acopera exact 60s
}
