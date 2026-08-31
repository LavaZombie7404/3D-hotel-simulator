// ---------------------------------------------------------------------------
// Saving progress to localStorage.
//
// Poki requires a game to either persist progress or say plainly that it will
// not, and it requires every localStorage call to be wrapped in try/catch,
// because incognito mode can make the whole API throw.
//
// Only the durable state is stored: money, room levels, which floors are open,
// and everything permanent (boosters, rebirths, prestige). Guests, the lift and
// the waiter are live simulation state and are simply rebuilt on load.
// ---------------------------------------------------------------------------
import * as C from './config.js';
import { rooms, state } from './world.js';

const KEY = 'hotel3d.save.v1';

/** localStorage is not always reachable (incognito, blocked cookies). */
function storage() {
  try {
    const s = window.localStorage;
    s.getItem(KEY);          // touching it is what actually throws
    return s;
  } catch {
    return null;
  }
}

export const canSave = !!storage();

export function saveGame() {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(KEY, JSON.stringify({
      v: 1,
      money: state.money,
      totalEarned: state.totalEarned,
      boosters: state.boosters,
      rebirths: state.rebirths,
      maxRebirths: state.maxRebirths,
      prestige: state.prestige,
      lifetimeEarned: state.lifetimeEarned,
      servedGuests: state.servedGuests,
      lostGuests: state.lostGuests,
      checkouts: state.checkouts,
      tips: state.tips,
      floors: state.floorUnlocked,
      levels: Array.from(rooms.level),
    }));
    return true;
  } catch {
    return false;    // quota full or storage disabled: not worth crashing over
  }
}

/** Returns true if a save was found and applied. */
export function loadGame() {
  const s = storage();
  if (!s) return false;
  let data;
  try {
    const raw = s.getItem(KEY);
    if (!raw) return false;
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!data || data.v !== 1) return false;

  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  state.money = num(data.money, C.START_MONEY);
  state.totalEarned = num(data.totalEarned, 0);
  state.boosters = num(data.boosters, 0);
  state.rebirths = num(data.rebirths, 0);
  state.maxRebirths = num(data.maxRebirths, 0);
  state.prestige = num(data.prestige, 0);
  state.lifetimeEarned = num(data.lifetimeEarned, 0);
  state.servedGuests = num(data.servedGuests, 0);
  state.lostGuests = num(data.lostGuests, 0);
  state.checkouts = num(data.checkouts, 0);
  state.tips = num(data.tips, 0);

  if (Array.isArray(data.floors)) {
    for (let f = 0; f < C.FLOORS; f++) state.floorUnlocked[f] = f === 0 || !!data.floors[f];
  }
  if (Array.isArray(data.levels)) {
    for (let r = 0; r < C.TOTAL_ROOMS; r++) {
      const lvl = data.levels[r];
      rooms.level[r] = typeof lvl === 'number' ? Math.max(0, Math.min(C.MAX_LEVEL, lvl | 0)) : 0;
      rooms.occupant[r] = -1;
    }
  }

  state.roomsDirty = true;
  state.doorsDirty = true;
  return true;
}

export function clearSave() {
  const s = storage();
  if (!s) return;
  try { s.removeItem(KEY); } catch { /* nothing we can do */ }
}
