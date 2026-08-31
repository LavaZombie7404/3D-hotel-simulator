// ---------------------------------------------------------------------------
// Punctul de intrare: randare, camera top-down, input, bucla de joc.
//
// Bucla foloseste pas fix de simulare (1/60 s) cu acumulator, decuplat de rata
// de randare. Asa viteza 1x / 2x / 4x nu schimba comportamentul simularii si
// jocul merge identic la 60 sau 144 Hz.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/addons/OrbitControls.js';
import * as C from './config.js';
import {
  state, rooms, initWorld, rollIncomeBucket,
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
import { player, buildPlayer, updatePlayer, renderPlayer, rideTo, canRide, callLiftHere } from './player.js';
import { lift, buildLift, updateLift, renderLift } from './elevator.js';
import { initUI, refreshHUD, refreshPerf, refreshRoomPanel, setFloorButtons, updatePopups } from './ui.js';

// --- renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;          // umbrele nu merita costul aici
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1014);
scene.fog = new THREE.Fog(0x0d1014, 95, 200);

// --- camera top-down --------------------------------------------------------
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
controls.minPolarAngle = 0;                   // exact deasupra
controls.maxPolarAngle = 1.15;                // ~66°, nu coborim la nivelul ochilor
controls.update();

// --- lumini -----------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xc6dcff, 0x2a2f26, 1.15));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.45);
sun.position.set(34, 60, 26);
scene.add(sun);

// --- lume -------------------------------------------------------------------
initWorld();
resetGuests();
buildScene(scene);
buildGuestMeshes(scene);
buildLift(scene);
buildPlayer(scene);

// --- stare joc --------------------------------------------------------------
// Simularea merge mereu in timp real. Ramane o variabila doar pentru hook-ul
// de debug (__hotel.setSpeed), folosit de testele automate.
let speed = 1;
let acc = 0;
let secAcc = 0;
let hudAcc = 0;
let fpsAcc = 0, fpsFrames = 0, fps = 0;
let last = performance.now();

// Camera urmareste chelnerul. Porneste oprita, ca sa vezi tot hotelul, si se
// aprinde singura in momentul in care apesi prima data o tasta de miscare.
let follow = false;
const keys = new Set();
const _tgt = new THREE.Vector3();
const _delta = new THREE.Vector3();

// --- UI ---------------------------------------------------------------------
initUI({
  onFloor(f) {
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
});
setFloorButtons();
refreshRoomPanel();

/** Schimba etajul vizibil si muta camera pe verticala odata cu el. */
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
  // Doar un click curat selecteaza; o rotire a camerei nu.
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

/** Urmatorul etaj deblocat, in sus, cu revenire la parter. */
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
    follow = true;               // prima miscare porneste camera care urmareste
    return;
  }
  if (e.repeat) return;

  if (e.code === 'KeyF') { follow = !follow; return; }
  if (e.code === 'KeyE') {
    // In cabina = buton de etaj; pe palier = chemi liftul.
    if (canRide()) rideTo(nextUnlockedFloor(player.floor));
    else callLiftHere();
    return;
  }

  const n = Number(e.key);
  if (n >= 1 && n <= C.FLOORS) {
    const f = n - 1;
    if (!state.floorUnlocked[f]) return;
    // In lift tastele de etaj te duc acolo; altfel doar muta privirea.
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

// Hook de debug: util pentru testele automate si pentru reglat balansul din
// consola browserului (ex. __hotel.give(5000)).
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
  setSpeed(s) { speed = s; },
};

// --- bucla ------------------------------------------------------------------
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  // Simulare cu pas fix.
  if (speed > 0) {
    acc += dt * speed;
    let steps = 0;
    while (acc >= C.FIXED_DT && steps < C.MAX_STEPS) {
      updateLift(C.FIXED_DT);     // inaintea oaspetilor: ei citesc starea cabinei
      simulate(C.FIXED_DT);
      state.simTime += C.FIXED_DT;
      secAcc += C.FIXED_DT;
      if (secAcc >= 1) { secAcc -= 1; rollIncomeBucket(); }
      acc -= C.FIXED_DT;
      steps++;
    }
    if (steps === C.MAX_STEPS) acc = 0;      // nu recupera la infinit
  }

  // Chelnerul se misca in acelasi timp cu simularea: la 4x merge si el 4x,
  // altfel n-ar mai apuca sa raspunda la cereri.
  updatePlayer(Math.min(dt, 0.1) * speed, camera, keys);

  // Camera urmareste chelnerul si sare pe etajul lui cand ia liftul.
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

  // Reconstructii vizuale doar cand chiar s-a schimbat ceva.
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

  // HUD la 5 Hz, contor FPS la 2 Hz.
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
