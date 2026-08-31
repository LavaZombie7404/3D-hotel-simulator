// ---------------------------------------------------------------------------
// Entry point: renderer, top-down camera, input, game loop.
//
// The loop uses a fixed simulation step (1/60 s) with an accumulator, decoupled
// from the render rate, so the game behaves identically at 60 or 144 Hz.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/addons/OrbitControls.js';
import * as C from './config.js';
import {
  state, rooms, initWorld, rollIncomeBucket, doRebirth, doPrestige, payout, floorAvailable,
  tryUnlockRoom, tryUpgradeRoom, tryUnlockFloor,
} from './world.js';
import {
  buildScene, setActiveFloor, refreshRooms, refreshDoorColors, pickRoom, updateSelection,
  updateMarkers, setDeskRing,
} from './build.js';
import {
  buildGuestMeshes, resetGuests, simulate, renderGuests, guestCount, queueLength,
  roomHasRequest, activeRequests, stateCounts,
} from './guests.js';
import {
  player, buildPlayer, updatePlayer, renderPlayer, resetPlayer, rideTo, canRide, callLiftHere,
} from './player.js';
import { lift, buildLift, updateLift, renderLift } from './elevator.js';
import {
  initUI, refreshHUD, refreshPerf, refreshRoomPanel, setFloorButtons, updatePopups,
  tickRebirthPrompt,
} from './ui.js';

// --- renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;          // shadows are not worth the cost here
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1014);
scene.fog = new THREE.Fog(0x0d1014, 95, 200);

// --- top-down camera --------------------------------------------------------
const CENTER = new THREE.Vector3((C.LOBBY_X0 + C.CORRIDOR_X1) / 2 + 2, 0, 0);
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 400);
camera.position.set(CENTER.x, 42, 13);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CENTER);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.screenSpacePanning = false;
controls.minDistance = 14;
controls.maxDistance = 120;
controls.minPolarAngle = 0;                   // straight overhead
controls.maxPolarAngle = 1.15;                // ~66°, never down to eye level
controls.update();

// --- lights -----------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xc6dcff, 0x2a2f26, 1.15));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.45);
sun.position.set(34, 60, 26);
scene.add(sun);

// --- world -------------------------------------------------------------------
initWorld();
resetGuests();
buildScene(scene);
buildGuestMeshes(scene);
buildLift(scene);
buildPlayer(scene);

// --- game state --------------------------------------------------------------
// The simulation always runs in real time. This stays a variable only for the
// debug hook (__hotel.setSpeed), which the automated tests use.
let speed = 1;
let acc = 0;
let secAcc = 0;
let hudAcc = 0;
let fpsAcc = 0, fpsFrames = 0, fps = 0;
let last = performance.now();

// The camera follows the waiter. It starts off, so you can see the whole
// hotel, and switches itself on the first time you press a movement key.
let follow = false;
const keys = new Set();
const _tgt = new THREE.Vector3();
const _delta = new THREE.Vector3();

// --- UI ---------------------------------------------------------------------
initUI({
  onFloor(f) {
    if (!floorAvailable(f)) return;
    if (!state.floorUnlocked[f]) {
      if (!tryUnlockFloor(f)) return;
    }
    focusFloor(f);
  },
  onRoomAction(r) {
    if (r < 0) return;
    if (rooms.level[r] === 0) {
      if (!state.floorUnlocked[rooms.floor[r]]) tryUnlockFloor(rooms.floor[r]);
      else tryUnlockRoom(r);
    } else {
      tryUpgradeRoom(r);
    }
    refreshRoomPanel();
  },
  onRebirth: () => resetAfter(doRebirth()),
  onPrestige: () => resetAfter(doPrestige()),
});
setFloorButtons();
refreshRoomPanel();

/**
 * After a rebirth or a prestige the hotel starts over, but keeps whatever you
 * earned permanently. The things world.js does not own must be cleared too:
 * the guests, the lift and the waiter.
 */
function resetAfter(happened) {
  if (!happened) return;
  resetGuests();
  resetPlayer();
  follow = false;
  setActiveFloor(0);
  camera.position.set(CENTER.x, 42, 13);
  controls.target.copy(CENTER);
  controls.update();
  setFloorButtons();
  refreshRoomPanel();
}

/** Switches the visible floor and moves the camera up or down with it. */
function focusFloor(f) {
  follow = false;
  const dy = (f - state.activeFloor) * C.FLOOR_H;
  setActiveFloor(f);
  camera.position.y += dy;
  controls.target.y += dy;
  controls.update();
  setFloorButtons();
  refreshRoomPanel();
}

// --- input ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downX = 0, downY = 0;

renderer.domElement.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });

renderer.domElement.addEventListener('pointerup', (e) => {
  // Only a clean click selects; dragging the camera does not.
  if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return;
  ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  state.selected = pickRoom(raycaster);
  updateSelection();
  refreshRoomPanel();
});

const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** The next unlocked floor going up, wrapping back to the ground floor. */
function nextUnlockedFloor(from) {
  for (let i = 1; i <= C.FLOORS; i++) {
    const f = (from + i) % C.FLOORS;
    if (state.floorUnlocked[f]) return f;
  }
  return from;
}

window.addEventListener('keydown', (e) => {
  if (MOVE_KEYS.has(e.code)) {
    e.preventDefault();
    keys.add(e.code);
    follow = true;               // the first movement turns follow mode on
    return;
  }
  if (e.repeat) return;

  if (e.code === 'KeyF') { follow = !follow; return; }
  if (e.code === 'KeyE') {
    // Inside the cabin = a floor button; on the landing = call the lift.
    if (canRide()) rideTo(nextUnlockedFloor(player.floor));
    else callLiftHere();
    return;
  }

  const n = Number(e.key);
  if (n >= 1 && n <= C.FLOORS) {
    const f = n - 1;
    if (!floorAvailable(f) || !state.floorUnlocked[f]) return;
    // In the lift the floor keys take you there; otherwise they just look.
    if (canRide()) rideTo(f);
    else focusFloor(f);
  }
});

window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Debug hook: used by the automated tests and handy for tuning balance from
// the browser console (e.g. __hotel.give(5000)).
window.__hotel = {
  state, rooms,
  give(n) { state.money += n; },
  unlockFloor: (f) => tryUnlockFloor(f),
  unlockRoom: (r) => tryUnlockRoom(r),
  upgradeRoom: (r) => tryUpgradeRoom(r),
  focusFloor,
  player,
  lift,
  stateCounts,
  payout,
  config: C,
  floorAvailable,
  /** Test shortcut: buy everything that is currently available. */
  unlockAll(levels = 0) {
    for (let f = 0; f < C.FLOORS; f++) tryUnlockFloor(f);
    for (let r = 0; r < C.TOTAL_ROOMS; r++) tryUnlockRoom(r);
    for (let i = 0; i < levels; i++) {
      for (let r = 0; r < C.TOTAL_ROOMS; r++) tryUpgradeRoom(r);
    }
    setFloorButtons();
  },
  /** Test shortcut: as if you had rebirthed n times. */
  grantRebirths(n) {
    state.rebirths = n;
    state.maxRebirths = Math.max(state.maxRebirths, n);
    setFloorButtons();
  },
  rebirth: () => resetAfter(doRebirth()),
  prestige: () => resetAfter(doPrestige()),
  setSpeed(s) { speed = s; },
};

// --- loop ------------------------------------------------------------------
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  // Fixed-step simulation.
  if (speed > 0) {
    acc += dt * speed;
    let steps = 0;
    while (acc >= C.FIXED_DT && steps < C.MAX_STEPS) {
      updateLift(C.FIXED_DT);     // before the guests: they read the cabin state
      simulate(C.FIXED_DT);
      state.simTime += C.FIXED_DT;
      secAcc += C.FIXED_DT;
      if (secAcc >= 1) { secAcc -= 1; rollIncomeBucket(); }
      acc -= C.FIXED_DT;
      steps++;
    }
    if (steps === C.MAX_STEPS) acc = 0;      // do not try to catch up forever
  }

  // The waiter moves on the same clock as the simulation, so he can always
  // keep up with the requests.
  updatePlayer(Math.min(dt, 0.1) * speed, camera, keys);

  // The camera follows the waiter and jumps to his floor when he takes the lift.
  if (follow) {
    if (state.activeFloor !== player.floor) {
      setActiveFloor(player.floor);
      setFloorButtons();
      refreshRoomPanel();
    }
    _tgt.set(player.x, player.floor * C.FLOOR_H, player.z);
    _delta.subVectors(_tgt, controls.target).multiplyScalar(Math.min(1, dt * 4));
    controls.target.add(_delta);
    camera.position.add(_delta);
  }

  // Visual rebuilds only when something actually changed.
  if (state.roomsDirty) { refreshRooms(); state.roomsDirty = false; state.doorsDirty = false; }
  else if (state.doorsDirty) { refreshDoorColors(); state.doorsDirty = false; }

  renderGuests();
  renderLift();
  renderPlayer();
  updateMarkers(state.simTime, roomHasRequest);
  setDeskRing(player.atDesk);
  controls.update();
  renderer.render(scene, camera);

  updatePopups(camera, dt, window.innerWidth, window.innerHeight);
  tickRebirthPrompt(dt);

  // HUD at 5 Hz, FPS counter at 2 Hz.
  hudAcc += dt;
  if (hudAcc >= 0.2) { hudAcc = 0; refreshHUD(guestCount(), queueLength(), activeRequests()); }
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) {
    fps = Math.round(fpsFrames / fpsAcc);
    fpsAcc = 0; fpsFrames = 0;
    refreshPerf(fps, renderer.info.render.calls, renderer.info.render.triangles);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
