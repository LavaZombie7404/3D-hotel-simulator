// ---------------------------------------------------------------------------
// The HUD (DOM). Text is refreshed at 5 Hz rather than every frame — writing to
// the DOM is far more expensive than a draw call.
// The floating "+$" labels reuse a fixed pool of recycled elements.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.min.js';
import * as C from './config.js';
import { sfxClick, sfxBuy, toggleMute, isMuted } from './audio.js';
import {
  rooms, state, popupQueue,
  unlockCost, upgradeCost, payout, unlockedCount, occupiedCount, incomePerMinute,
  incomeMult, canRebirth, canPrestige, rebirthGoal, nextFloorUnlock, floorAvailable,
  dirtyCount, staffCost, restaurantCost, seatCount, dinePay,
} from './world.js';

const $ = (id) => document.getElementById(id);

const el = {};
let handlers = null;

// --- floating label pool ----------------------------------------------------
const POP_MAX = 24;
const popPool = [];
const popX = new Float32Array(POP_MAX);
const popY = new Float32Array(POP_MAX);
const popZ = new Float32Array(POP_MAX);
const popLife = new Float32Array(POP_MAX);
const POP_TTL = 1.5;
const _v = new THREE.Vector3();

// --- buttons that ask for confirmation --------------------------------------
// Rebirth and prestige wipe the whole run, so they never fire on the first
// click. The confirmation expires by itself if you change your mind.
const armed = [];

function armButton(btn, confirmText, action) {
  const entry = { btn, confirmText, action, timer: 0 };
  armed.push(entry);
  btn.addEventListener('click', () => {
    if (entry.timer <= 0) {
      entry.timer = 4;
      btn.classList.add('confirm');
      btn.textContent = confirmText;
      return;
    }
    entry.timer = 0;
    btn.classList.remove('confirm');
    action();
  });
}

function isArmed(btn) {
  const e = armed.find((a) => a.btn === btn);
  return e ? e.timer > 0 : false;
}

export function tickRebirthPrompt(dt) {
  for (const e of armed) {
    if (e.timer <= 0) continue;
    e.timer -= dt;
    if (e.timer <= 0) e.btn.classList.remove('confirm');
  }
}

// ---------------------------------------------------------------------------

export function initUI(cbs) {
  handlers = cbs;

  el.money = $('money');
  el.income = $('income');
  el.floors = $('floors');
  el.guests = $('st-guests');
  el.occ = $('st-occ');
  el.queue = $('st-queue');
  el.served = $('st-served');
  el.lost = $('st-lost');
  el.tips = $('st-tips');
  el.req = $('st-req');
  el.dirty = $('st-dirty');
  el.hirePorter = $('hire-porter');
  el.hireCleaner = $('hire-cleaner');
  el.staffTitle = $('staff-title');
  el.restaurant = $('restaurant');
  el.stars = $('stars');
  el.starProgress = $('star-progress');
  el.rebirth = $('rebirth');
  el.prestige = $('prestige');
  el.nextFloor = $('next-floor');
  el.roomEmpty = $('room-empty');
  el.roomInfo = $('room-info');
  el.roomTitle = $('room-title');
  el.roomSub = $('room-sub');
  el.roomBar = $('room-bar').firstElementChild;
  el.roomAction = $('room-action');
  el.perf = $('perf');
  el.pause = $('pause');
  el.mute = $('mute');
  el.hotelName = $('hotel-name');
  // Poki prefers short, visual guidance over a wall of text, so the hint
  // fades out once the player has had a chance to read it.
  setTimeout(() => $('hint').classList.add('gone'), 14000);
  el.popups = $('popups');

  // One button per possible level of the building. Floors that have not shown
  // up yet stay hidden (see setFloorButtons).
  el.floorBtns = [];
  for (let f = 0; f < C.FLOORS; f++) {
    const b = document.createElement('button');
    b.textContent = floorName(f);
    b.addEventListener('click', () => { sfxClick(); handlers.onFloor(f); });
    el.floors.appendChild(b);
    el.floorBtns.push(b);
  }

  el.hirePorter.addEventListener('click', () => { sfxBuy(); handlers.onHire('porter'); });
  el.hireCleaner.addEventListener('click', () => { sfxBuy(); handlers.onHire('cleaner'); });
  el.restaurant.addEventListener('click', () => { sfxBuy(); handlers.onRestaurant(); });

  el.hotelName.value = state.hotelName;
  el.hotelName.addEventListener('input', () => {
    state.hotelName = el.hotelName.value.slice(0, 22);
    handlers.onRename();
  });
  // Empty is not a hotel name; put the old one back when they click away.
  el.hotelName.addEventListener('blur', () => {
    if (!state.hotelName.trim()) {
      state.hotelName = 'Grand Hotel';
      el.hotelName.value = state.hotelName;
      handlers.onRename();
    }
  });

  el.roomAction.addEventListener('click', () => {
    sfxBuy();
    handlers.onRoomAction(state.selected);
  });
  el.mute.addEventListener('click', () => {
    const m = toggleMute();
    el.mute.textContent = m ? '\u{1F507}' : '\u{1F50A}';
    el.mute.title = m ? 'Sound off' : 'Sound on';
  });
  $('resume').addEventListener('click', () => handlers.onResume());
  armButton(el.rebirth, 'Sure? You lose everything — click again', () => handlers.onRebirth());
  armButton(el.prestige, 'Sure? Click again', () => handlers.onPrestige());

  for (let i = 0; i < POP_MAX; i++) {
    const d = document.createElement('div');
    d.className = 'pop';
    d.style.display = 'none';
    el.popups.appendChild(d);
    popPool.push(d);
    popLife[i] = 0;
  }
}

/** Puts a loaded or reset name back into the field. */
export function syncHotelName() {
  el.hotelName.value = state.hotelName;
}

export function syncMuteButton() {
  el.mute.textContent = isMuted() ? '\u{1F507}' : '\u{1F50A}';
}

export function setPaused(on) {
  el.pause.classList.toggle('on', on);
}

/** Shown once at startup when the browser will not let us save (incognito). */
export function warnNoSave() {
  el.starProgress.textContent = 'progress will not be saved in this browser';
}

function floorName(f) { return f === 0 ? 'Ground' : 'Floor ' + f; }

export function setFloorButtons() {
  for (let f = 0; f < C.FLOORS; f++) {
    const b = el.floorBtns[f];
    // Floors that have not appeared yet are not shown at all.
    b.style.display = floorAvailable(f) ? '' : 'none';
    b.classList.toggle('on', f === state.activeFloor);
    if (!state.floorUnlocked[f]) {
      b.textContent = floorName(f) + ' \u{1F512}';
      b.title = 'Unlock for $' + C.FLOOR_COST[f].toLocaleString('en-US');
    } else {
      b.textContent = floorName(f);
      b.title = '';
    }
  }
}

// --- room panel -------------------------------------------------------------

function roomName(r) {
  const n = rooms.side[r] * C.ROOMS_PER_SIDE + rooms.index[r] + 1;
  return (rooms.floor[r] === 0 ? 'G' : 'F' + rooms.floor[r]) + '-' + String(n).padStart(2, '0');
}

export function refreshRoomPanel() {
  const r = state.selected;
  if (r < 0) {
    el.roomEmpty.style.display = '';
    el.roomInfo.style.display = 'none';
    return;
  }
  el.roomEmpty.style.display = 'none';
  el.roomInfo.style.display = '';

  const lvl = rooms.level[r];
  const floorOpen = state.floorUnlocked[rooms.floor[r]];
  el.roomTitle.textContent = 'Room ' + roomName(r);

  if (lvl === 0) {
    el.roomSub.textContent = floorOpen
      ? 'Locked · unlock it to take guests'
      : 'Floor ' + rooms.floor[r] + ' is not open yet';
    el.roomBar.style.width = '0%';
    const cost = floorOpen ? unlockCost() : C.FLOOR_COST[rooms.floor[r]];
    el.roomAction.textContent = (floorOpen ? 'Unlock — $' : 'Open the floor — $') +
      cost.toLocaleString('en-US');
    el.roomAction.disabled = state.money < cost;
    el.roomAction.className = 'buy';
    return;
  }

  const occ = rooms.occupant[r] >= 0;
  el.roomSub.textContent =
    'Level ' + lvl + '/' + C.MAX_LEVEL + ' · $' + payout(lvl).toLocaleString('en-US') +
    ' per guest · ' + (occ ? 'occupied' : 'free');
  el.roomBar.style.width = (lvl / C.MAX_LEVEL * 100) + '%';

  if (lvl >= C.MAX_LEVEL) {
    el.roomAction.textContent = 'Max level';
    el.roomAction.disabled = true;
    el.roomAction.className = '';
  } else {
    const cost = upgradeCost(lvl);
    el.roomAction.textContent = 'Level ' + (lvl + 1) + ' — $' + cost.toLocaleString('en-US') +
      '  (→ $' + payout(lvl + 1).toLocaleString('en-US') + ')';
    el.roomAction.disabled = state.money < cost;
    el.roomAction.className = 'buy';
  }
}

// --- staff ------------------------------------------------------------------

/**
 * Only touch innerHTML when the text really changed. Rewriting a button's
 * contents five times a second churns the DOM for nothing and can swallow a
 * click that lands between the rewrite and the mouseup.
 */
function setHTML(node, html) {
  if (node.dataset.html !== html) {
    node.dataset.html = html;
    node.innerHTML = html;
  }
}

function refreshStaff() {
  const info = handlers.staffInfo();
  el.staffTitle.textContent = 'Staff on this floor - next hire $' +
    staffCost().toLocaleString('en-US');
  setHTML(el.hirePorter, '&#127974; Porter <b>' + info.porters + '</b>');
  setHTML(el.hireCleaner, '&#129529; Cleaner <b>' + info.cleaners + '</b>');
  el.hirePorter.disabled = !info.canPorter;
  el.hireCleaner.disabled = !info.canCleaner;

  const lvl = state.restaurantLevel;
  if (lvl >= C.REST_MAX_LEVEL) {
    setHTML(el.restaurant, '&#127860; Restaurant maxed');
    el.restaurant.disabled = true;
  } else {
    const cost = restaurantCost();
    setHTML(el.restaurant, '&#127860; ' +
      (lvl === 0 ? 'Build restaurant' : 'Restaurant Lv ' + lvl) +
      ' &mdash; $' + cost.toLocaleString('en-US'));
    el.restaurant.disabled = state.money < cost;
  }
  el.restaurant.title = lvl === 0
    ? 'Departing guests will stop to eat'
    : seatCount() + ' tables, $' + dinePay() + ' per meal';
}

// --- rebirth / prestige -----------------------------------------------------

function boosterLabel(n) {
  if (n === 0) return 'No boosters';
  return '★ ' + n.toLocaleString('en-US') + (n === 1 ? ' booster' : ' boosters');
}

function refreshRebirth() {
  el.stars.textContent = boosterLabel(state.boosters);
  if (state.boosters > 0) {
    el.stars.textContent += '   +' +
      Math.round((incomeMult() - 1) * 100).toLocaleString('en-US') + '% income';
  }

  if (!isArmed(el.rebirth)) {
    if (canRebirth()) {
      el.starProgress.textContent = state.rebirths + ' rebirths · earned $' +
        Math.floor(state.totalEarned).toLocaleString('en-US') + ' this run';
      el.rebirth.textContent = 'Rebirth — +1 booster';
      el.rebirth.disabled = false;
      el.rebirth.className = 'buy';
    } else {
      const need = rebirthGoal() - state.totalEarned;
      el.starProgress.textContent = state.rebirths + ' rebirths · $' +
        Math.ceil(need).toLocaleString('en-US') + ' more for the next one';
      el.rebirth.textContent = 'Rebirth';
      el.rebirth.disabled = true;
      el.rebirth.className = '';
    }
  }

  // Prestige only shows up once you have enough rebirths.
  const showPrestige = canPrestige() || state.prestige > 0;
  el.prestige.style.display = showPrestige ? '' : 'none';
  if (showPrestige && !isArmed(el.prestige)) {
    if (canPrestige()) {
      el.prestige.textContent = 'Prestige — boosters x' + C.PRESTIGE_MULT;
      el.prestige.disabled = false;
    } else {
      el.prestige.textContent = 'Prestige at ' + C.PRESTIGE_REBIRTHS + ' rebirths';
      el.prestige.disabled = true;
    }
  }

  const next = nextFloorUnlock();
  if (next) {
    el.nextFloor.textContent = 'Floor ' + next.floor + ' appears at ' + next.at + ' rebirths';
  } else if (state.prestige > 0) {
    el.nextFloor.textContent = 'Prestige ' + state.prestige + ' · every floor is open';
  } else {
    el.nextFloor.textContent = 'Every floor is open';
  }
}

// --- HUD --------------------------------------------------------------------

/** The "slow" HUD refresh, called about 5 times per second. */
let lastMoney = -1;

export function refreshHUD(guests, queueLen, requests) {
  const money = Math.floor(state.money);
  el.money.textContent = '$' + money.toLocaleString('en-US');
  // A small pop whenever the number goes up, so income is felt not just read.
  if (lastMoney >= 0 && money > lastMoney) {
    el.money.classList.add('bump');
    setTimeout(() => el.money.classList.remove('bump'), 120);
  }
  lastMoney = money;
  el.income.textContent = '$' + Math.round(incomePerMinute()).toLocaleString('en-US') + ' / min';
  el.guests.textContent = guests;
  el.occ.textContent = occupiedCount() + ' / ' + unlockedCount();
  el.queue.textContent = queueLen;
  el.served.textContent = state.servedGuests;
  el.lost.textContent = state.lostGuests;
  el.tips.textContent = '$' + Math.floor(state.tips).toLocaleString('en-US');
  el.req.textContent = requests;
  el.dirty.textContent = dirtyCount();
  refreshStaff();
  refreshRebirth();
  setFloorButtons();
  refreshRoomPanel();
}

export function refreshPerf(fps, calls, tris) {
  el.perf.textContent = fps + ' FPS · ' + calls + ' draw calls · ' +
    (tris / 1000).toFixed(0) + 'k tri';
}

// --- floating labels --------------------------------------------------------

export function updatePopups(camera, dt, w, h) {
  // Pick up whatever the simulation produced.
  for (let i = 0; i < popupQueue.n; i++) {
    if (Math.abs(popupQueue.y[i] - state.activeFloor * C.FLOOR_H) > C.FLOOR_H * 0.9) continue;
    let slot = -1;
    for (let s = 0; s < POP_MAX; s++) if (popLife[s] <= 0) { slot = s; break; }
    if (slot < 0) break;
    popX[slot] = popupQueue.x[i];
    popY[slot] = popupQueue.y[i];
    popZ[slot] = popupQueue.z[i];
    popLife[slot] = POP_TTL;
    const d = popPool[slot];
    d.textContent = '+$' + popupQueue.amount[i];
    d.style.display = '';
  }
  popupQueue.n = 0;

  for (let s = 0; s < POP_MAX; s++) {
    if (popLife[s] <= 0) continue;
    popLife[s] -= dt;
    const d = popPool[s];
    if (popLife[s] <= 0) { d.style.display = 'none'; continue; }

    // Do not show earnings from floors other than the visible one.
    if (Math.abs(popY[s] - state.activeFloor * C.FLOOR_H) > C.FLOOR_H * 0.9) {
      d.style.display = 'none'; popLife[s] = 0; continue;
    }

    const t = 1 - popLife[s] / POP_TTL;
    _v.set(popX[s], popY[s] + t * 1.4, popZ[s]).project(camera);
    if (_v.z > 1) { d.style.display = 'none'; popLife[s] = 0; continue; }
    d.style.transform = 'translate(-50%,-50%) translate(' +
      ((_v.x * 0.5 + 0.5) * w).toFixed(1) + 'px,' +
      ((-_v.y * 0.5 + 0.5) * h).toFixed(1) + 'px)';
    d.style.opacity = (1 - t * t).toFixed(2);
  }
}
