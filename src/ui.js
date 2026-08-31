// ---------------------------------------------------------------------------
// HUD-ul (DOM). Textul din interfata se actualizeaza la 5 Hz, nu la fiecare
// cadru — scrierea in DOM e mult mai scumpa decat un draw call.
// Textele flotante "+$" folosesc un pool fix de elemente, reciclate.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.js';
import * as C from './config.js';
import {
  rooms, state, popupQueue,
  unlockCost, upgradeCost, payout, unlockedCount, occupiedCount, incomePerMinute,
  incomeMult, canRebirth, canPrestige, rebirthGoal, nextFloorUnlock, floorAvailable,
} from './world.js';

const $ = (id) => document.getElementById(id);

const el = {};
let handlers = null;

// --- pool de texte flotante -------------------------------------------------
const POP_MAX = 24;
const popPool = [];
const popX = new Float32Array(POP_MAX);
const popY = new Float32Array(POP_MAX);
const popZ = new Float32Array(POP_MAX);
const popLife = new Float32Array(POP_MAX);
const POP_TTL = 1.5;
const _v = new THREE.Vector3();

// --- butoane care cer confirmare --------------------------------------------
// Renasterea si prestigiul sterg tot progresul rularii, deci nu se declanseaza
// din prima. Confirmarea expira singura daca te razgandesti.
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
  el.popups = $('popups');

  // Cate un buton pentru fiecare nivel posibil al cladirii. Etajele care inca
  // n-au aparut raman ascunse (vezi setFloorButtons).
  el.floorBtns = [];
  for (let f = 0; f < C.FLOORS; f++) {
    const b = document.createElement('button');
    b.textContent = floorName(f);
    b.addEventListener('click', () => handlers.onFloor(f));
    el.floors.appendChild(b);
    el.floorBtns.push(b);
  }

  el.roomAction.addEventListener('click', () => handlers.onRoomAction(state.selected));
  armButton(el.rebirth, 'Sigur? Pierzi tot — click din nou', () => handlers.onRebirth());
  armButton(el.prestige, 'Sigur? Click din nou', () => handlers.onPrestige());

  for (let i = 0; i < POP_MAX; i++) {
    const d = document.createElement('div');
    d.className = 'pop';
    d.style.display = 'none';
    el.popups.appendChild(d);
    popPool.push(d);
    popLife[i] = 0;
  }
}

function floorName(f) { return f === 0 ? 'Parter' : 'Etaj ' + f; }

export function setFloorButtons() {
  for (let f = 0; f < C.FLOORS; f++) {
    const b = el.floorBtns[f];
    // Etajele care inca n-au aparut nu se arata deloc.
    b.style.display = floorAvailable(f) ? '' : 'none';
    b.classList.toggle('on', f === state.activeFloor);
    if (!state.floorUnlocked[f]) {
      b.textContent = floorName(f) + ' \u{1F512}';
      b.title = 'Deblocheaza pentru $' + C.FLOOR_COST[f].toLocaleString('ro-RO');
    } else {
      b.textContent = floorName(f);
      b.title = '';
    }
  }
}

// --- panoul camerei ---------------------------------------------------------

function roomName(r) {
  const n = rooms.side[r] * C.ROOMS_PER_SIDE + rooms.index[r] + 1;
  return (rooms.floor[r] === 0 ? 'P' : 'E' + rooms.floor[r]) + '-' + String(n).padStart(2, '0');
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
  el.roomTitle.textContent = 'Camera ' + roomName(r);

  if (lvl === 0) {
    el.roomSub.textContent = floorOpen
      ? 'Blocata · deblocheaz-o ca sa primesti clienti'
      : 'Etajul ' + rooms.floor[r] + ' nu e deschis inca';
    el.roomBar.style.width = '0%';
    const cost = floorOpen ? unlockCost() : C.FLOOR_COST[rooms.floor[r]];
    el.roomAction.textContent = (floorOpen ? 'Deblocheaza — $' : 'Deschide etajul — $') +
      cost.toLocaleString('ro-RO');
    el.roomAction.disabled = state.money < cost;
    el.roomAction.className = 'buy';
    return;
  }

  const occ = rooms.occupant[r] >= 0;
  el.roomSub.textContent =
    'Nivel ' + lvl + '/' + C.MAX_LEVEL + ' · $' + payout(lvl).toLocaleString('ro-RO') +
    ' per client · ' + (occ ? 'ocupata' : 'libera');
  el.roomBar.style.width = (lvl / C.MAX_LEVEL * 100) + '%';

  if (lvl >= C.MAX_LEVEL) {
    el.roomAction.textContent = 'Nivel maxim';
    el.roomAction.disabled = true;
    el.roomAction.className = '';
  } else {
    const cost = upgradeCost(lvl);
    el.roomAction.textContent = 'Nivel ' + (lvl + 1) + ' — $' + cost.toLocaleString('ro-RO') +
      '  (→ $' + payout(lvl + 1).toLocaleString('ro-RO') + ')';
    el.roomAction.disabled = state.money < cost;
    el.roomAction.className = 'buy';
  }
}

// --- renastere / prestigiu --------------------------------------------------

function boosterLabel(n) {
  if (n === 0) return 'Fara boostere';
  return '★ ' + n.toLocaleString('ro-RO') + (n === 1 ? ' booster' : ' boostere');
}

function refreshRebirth() {
  el.stars.textContent = boosterLabel(state.boosters);
  if (state.boosters > 0) {
    el.stars.textContent += '   +' +
      Math.round((incomeMult() - 1) * 100).toLocaleString('ro-RO') + '% venit';
  }

  if (!isArmed(el.rebirth)) {
    if (canRebirth()) {
      el.starProgress.textContent = state.rebirths + ' renasteri · ai strans $' +
        Math.floor(state.totalEarned).toLocaleString('ro-RO');
      el.rebirth.textContent = 'Renaste — +1 booster';
      el.rebirth.disabled = false;
      el.rebirth.className = 'buy';
    } else {
      const need = rebirthGoal() - state.totalEarned;
      el.starProgress.textContent = state.rebirths + ' renasteri · inca $' +
        Math.ceil(need).toLocaleString('ro-RO') + ' pentru urmatoarea';
      el.rebirth.textContent = 'Renaste';
      el.rebirth.disabled = true;
      el.rebirth.className = '';
    }
  }

  // Prestigiul apare abia dupa ce ai strans destule renasteri.
  const showPrestige = canPrestige() || state.prestige > 0;
  el.prestige.style.display = showPrestige ? '' : 'none';
  if (showPrestige && !isArmed(el.prestige)) {
    if (canPrestige()) {
      el.prestige.textContent = 'Prestigiu — boosterii x' + C.PRESTIGE_MULT;
      el.prestige.disabled = false;
    } else {
      el.prestige.textContent = 'Prestigiu la ' + C.PRESTIGE_REBIRTHS + ' renasteri';
      el.prestige.disabled = true;
    }
  }

  const next = nextFloorUnlock();
  if (next) {
    el.nextFloor.textContent = 'Etaj ' + next.floor + ' apare la ' + next.at + ' renasteri';
  } else if (state.prestige > 0) {
    el.nextFloor.textContent = 'Prestigiu ' + state.prestige + ' · toate etajele deschise';
  } else {
    el.nextFloor.textContent = 'Toate etajele sunt deschise';
  }
}

// --- HUD --------------------------------------------------------------------

/** Actualizarea "lenta" a HUD-ului, apelata de ~5 ori pe secunda. */
export function refreshHUD(guests, queueLen, requests) {
  el.money.textContent = '$' + Math.floor(state.money).toLocaleString('ro-RO');
  el.income.textContent = '$' + Math.round(incomePerMinute()).toLocaleString('ro-RO') + ' / min';
  el.guests.textContent = guests;
  el.occ.textContent = occupiedCount() + ' / ' + unlockedCount();
  el.queue.textContent = queueLen;
  el.served.textContent = state.servedGuests;
  el.lost.textContent = state.lostGuests;
  el.tips.textContent = '$' + Math.floor(state.tips).toLocaleString('ro-RO');
  el.req.textContent = requests;
  refreshRebirth();
  setFloorButtons();
  refreshRoomPanel();
}

export function refreshPerf(fps, calls, tris) {
  el.perf.textContent = fps + ' FPS · ' + calls + ' draw calls · ' +
    (tris / 1000).toFixed(0) + 'k tri';
}

// --- texte flotante ---------------------------------------------------------

export function updatePopups(camera, dt, w, h) {
  // Preia ce a produs simularea.
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

    // Nu arata incasarile de pe alte etaje decat cel vizibil.
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
