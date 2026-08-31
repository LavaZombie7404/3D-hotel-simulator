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

export function initUI(cbs) {
  handlers = cbs;

  el.money = $('money');
  el.income = $('income');
  el.floors = $('floors');
  el.speeds = $('speeds');
  el.guests = $('st-guests');
  el.occ = $('st-occ');
  el.queue = $('st-queue');
  el.served = $('st-served');
  el.lost = $('st-lost');
  el.roomEmpty = $('room-empty');
  el.roomInfo = $('room-info');
  el.roomTitle = $('room-title');
  el.roomSub = $('room-sub');
  el.roomBar = $('room-bar').firstElementChild;
  el.roomAction = $('room-action');
  el.perf = $('perf');
  el.popups = $('popups');

  // Butoanele de etaj.
  el.floorBtns = [];
  for (let f = 0; f < C.FLOORS; f++) {
    const b = document.createElement('button');
    b.textContent = f === 0 ? 'Parter' : 'Etaj ' + f;
    b.addEventListener('click', () => handlers.onFloor(f));
    el.floors.appendChild(b);
    el.floorBtns.push(b);
  }

  el.speeds.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) handlers.onSpeed(Number(b.dataset.speed));
  });

  el.roomAction.addEventListener('click', () => handlers.onRoomAction(state.selected));

  for (let i = 0; i < POP_MAX; i++) {
    const d = document.createElement('div');
    d.className = 'pop';
    d.style.display = 'none';
    el.popups.appendChild(d);
    popPool.push(d);
    popLife[i] = 0;
  }
}

export function setSpeedButtons(speed) {
  for (const b of el.speeds.children) b.classList.toggle('on', Number(b.dataset.speed) === speed);
}

export function setFloorButtons() {
  for (let f = 0; f < C.FLOORS; f++) {
    const b = el.floorBtns[f];
    b.classList.toggle('on', f === state.activeFloor);
    if (!state.floorUnlocked[f]) {
      b.textContent = (f === 0 ? 'Parter' : 'Etaj ' + f) + ' \u{1F512}';
      b.title = 'Deblocheaza pentru $' + C.FLOOR_COST[f];
    } else {
      b.textContent = f === 0 ? 'Parter' : 'Etaj ' + f;
      b.title = '';
    }
  }
}

// --- text ------------------------------------------------------------------

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
    const cost = unlockCost();
    el.roomAction.textContent = floorOpen
      ? 'Deblocheaza — $' + cost
      : 'Deschide etajul — $' + C.FLOOR_COST[rooms.floor[r]];
    const price = floorOpen ? cost : C.FLOOR_COST[rooms.floor[r]];
    el.roomAction.disabled = state.money < price;
    el.roomAction.className = 'buy';
    return;
  }

  const occ = rooms.occupant[r] >= 0;
  el.roomSub.textContent =
    'Nivel ' + lvl + '/' + C.MAX_LEVEL + ' · $' + payout(lvl) + ' per client · ' +
    (occ ? 'ocupata' : 'libera');
  el.roomBar.style.width = (lvl / C.MAX_LEVEL * 100) + '%';

  if (lvl >= C.MAX_LEVEL) {
    el.roomAction.textContent = 'Nivel maxim';
    el.roomAction.disabled = true;
    el.roomAction.className = '';
  } else {
    const cost = upgradeCost(lvl);
    el.roomAction.textContent = 'Nivel ' + (lvl + 1) + ' — $' + cost +
      '  (→ $' + payout(lvl + 1) + ')';
    el.roomAction.disabled = state.money < cost;
    el.roomAction.className = 'buy';
  }
}

/** Actualizarea "lenta" a HUD-ului, apelata de ~5 ori pe secunda. */
export function refreshHUD(guests, queueLen) {
  el.money.textContent = '$' + Math.floor(state.money).toLocaleString('ro-RO');
  el.income.textContent = '$' + Math.round(incomePerMinute()).toLocaleString('ro-RO') + ' / min';
  el.guests.textContent = guests;
  el.occ.textContent = occupiedCount() + ' / ' + unlockedCount();
  el.queue.textContent = queueLen;
  el.served.textContent = state.servedGuests;
  el.lost.textContent = state.lostGuests;
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
