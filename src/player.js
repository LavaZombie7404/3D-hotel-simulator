// ---------------------------------------------------------------------------
// Chelnerul — personajul controlat de jucator.
//
// Ce face:
//   * Room service: cand un client cazat cere ceva, deasupra camerei apare un
//     romb auriu. Intri in camera => incasezi bacsis = $3 x nivelul camerei.
//   * Receptie: cat timp stai in cercul din fata biroului, check-in-ul
//     clientilor merge de ~2.5 ori mai repede.
//
// Coliziunile folosesc exact aceleasi dreptunghiuri ca peretii construiti in
// build.js (gfx.wallRects), deci golurile de usa sunt gratis — nu exista un
// al doilea model de coliziune care sa se desincronizeze de geometrie.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import * as C from './config.js';
import { state } from './world.js';
import { gfx } from './build.js';
import { serveRoom, setServiceBoost } from './guests.js';

export const player = {
  x: C.LOBBY_X0 + 6,
  z: -5,
  floor: 0,
  y: 0,
  yaw: Math.PI / 2,
  riding: false,
  rideFrom: 0,
  rideTo: 0,
  rideT: 0,
  atDesk: false,
  moving: false,
};

let group = null;
const _fwd = new THREE.Vector2();
const _rt = new THREE.Vector2();
const _mv = new THREE.Vector2();

export function buildPlayer(scene) {
  group = new THREE.Group();

  const vest = new THREE.MeshLambertMaterial({ color: 0x8e2233 });   // vesta bordo
  const skin = new THREE.MeshLambertMaterial({ color: 0xe8c39a });
  const tray = new THREE.MeshLambertMaterial({ color: 0xd8dde3 });

  // Corpul si sapca au acelasi material: le unim intr-o singura geometrie,
  // ca sa nu coste doua draw call-uri.
  const bodyGeo = new THREE.CapsuleGeometry(0.28, 0.66, 3, 10).translate(0, 0.62, 0);
  const capGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.12, 10).translate(0, 1.6, 0);
  const merged = mergeGeometries([bodyGeo, capGeo], false);
  bodyGeo.dispose(); capGeo.dispose();
  group.add(new THREE.Mesh(merged, vest));

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 10, 8), skin);
  head.position.y = 1.4;
  group.add(head);

  // Tava tinuta in fata, ca sa se vada imediat incotro e orientat.
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12), tray);
  plate.position.set(0, 1.0, 0.42);
  group.add(plate);

  // Cerc auriu sub picioare: de sus, altfel chelnerul se pierde printre oaspeti.
  const ringGeo = new THREE.RingGeometry(0.46, 0.6, 24);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0xffd24b, transparent: true, opacity: 0.85, depthWrite: false,
  }));
  ring.position.y = 0.04;
  group.add(ring);

  scene.add(group);
  return group;
}

// --- coliziune circle vs AABB ----------------------------------------------

/** Impinge jucatorul afara din orice perete in care a intrat. */
function resolveCollisions() {
  const rects = gfx.wallRects[player.floor];
  if (!rects) return;
  const r = C.PLAYER_R;

  // Doua treceri: dupa ce e impins dintr-un perete poate intra usor in altul.
  for (let pass = 0; pass < 2; pass++) {
    let moved = false;
    for (let i = 0; i < rects.length; i += 4) {
      const x0 = rects[i], x1 = rects[i + 1], z0 = rects[i + 2], z1 = rects[i + 3];
      const cx = player.x < x0 ? x0 : (player.x > x1 ? x1 : player.x);
      const cz = player.z < z0 ? z0 : (player.z > z1 ? z1 : player.z);
      const dx = player.x - cx, dz = player.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;

      if (d2 > 1e-8) {
        const d = Math.sqrt(d2), push = (r - d) / d;
        player.x += dx * push;
        player.z += dz * push;
      } else {
        // Centrul e chiar in dreptunghi: iesim pe latura cea mai apropiata.
        const left = player.x - x0, right = x1 - player.x;
        const back = player.z - z0, front = z1 - player.z;
        const m = Math.min(left, right, back, front);
        if (m === left) player.x = x0 - r;
        else if (m === right) player.x = x1 + r;
        else if (m === back) player.z = z0 - r;
        else player.z = z1 + r;
      }
      moved = true;
    }
    if (!moved) break;
  }
}

// --- zone -------------------------------------------------------------------

function inElevator() {
  return Math.abs(player.x - C.ELEV_X) < C.ELEV_HW - 0.15 &&
         Math.abs(player.z) < C.ELEV_HW - 0.15;
}

/** Camera in care se afla chelnerul, sau -1 daca e pe hol / in lobby. */
function roomUnderPlayer() {
  if (Math.abs(player.z) <= C.HALF_C) return -1;
  if (player.x < 0 || player.x >= C.CORRIDOR_X1) return -1;
  const i = Math.floor(player.x / C.ROOM_W);
  if (i < 0 || i >= C.ROOMS_PER_SIDE) return -1;
  const s = player.z > 0 ? 0 : 1;
  return player.floor * C.ROOMS_PER_FLOOR + s * C.ROOMS_PER_SIDE + i;
}

/** Porneste o cursa cu liftul. Returneaza false daca nu se poate. */
export function rideTo(floor) {
  if (player.riding || floor === player.floor) return false;
  if (floor < 0 || floor >= C.FLOORS || !state.floorUnlocked[floor]) return false;
  if (!inElevator()) return false;
  player.riding = true;
  player.rideFrom = player.floor * C.FLOOR_H;
  player.rideTo = floor * C.FLOOR_H;
  player.rideT = 0;
  player.floor = floor;      // etajul logic se schimba imediat; y se animeaza
  return true;
}

export function canRide() { return inElevator() && !player.riding; }

// --- update -----------------------------------------------------------------

/**
 * @param {number} dt      secunde
 * @param {THREE.Camera} camera  pentru miscare relativa la ecran
 * @param {Set<string>} keys     tastele apasate acum
 */
export function updatePlayer(dt, camera, keys) {
  if (player.riding) {
    player.rideT += dt / C.RIDE_TIME;
    if (player.rideT >= 1) {
      player.rideT = 1;
      player.riding = false;
    }
    const t = player.rideT;
    const e = t * t * (3 - 2 * t);                       // smoothstep
    player.y = player.rideFrom + (player.rideTo - player.rideFrom) * e;
    player.moving = false;
  } else {
    player.y = player.floor * C.FLOOR_H;

    // Directia de mers, relativa la cum e intoarsa camera.
    let ix = 0, iz = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) iz += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) iz -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;

    player.moving = ix !== 0 || iz !== 0;
    if (player.moving) {
      // Coloanele matricei camerei: [0..2] = dreapta, [4..6] = sus, [8..10] = -inainte.
      const m = camera.matrix.elements;
      _rt.set(m[0], m[2]);
      _fwd.set(-m[8], -m[10]);
      // Cand camera priveste aproape drept in jos, "inainte" pe ecran e de fapt
      // vectorul ei de sus proiectat pe sol.
      if (_fwd.length() < 0.15) _fwd.set(m[4], m[6]);
      if (_rt.lengthSq() < 1e-6) _rt.set(1, 0);
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, -1);
      _rt.normalize();
      _fwd.normalize();

      _mv.set(_rt.x * ix + _fwd.x * iz, _rt.y * ix + _fwd.y * iz);
      if (_mv.lengthSq() > 1e-6) {
        _mv.normalize();
        player.yaw = Math.atan2(_mv.x, _mv.y);

        // Deplasarea se face in pasi mai mici decat grosimea unui perete.
        // Altfel, la un cadru lung (sau la viteza 4x), pasul ar putea sari
        // complet peste perete si jucatorul ar iesi din cladire.
        const dist = C.PLAYER_SPEED * dt;
        const n = Math.min(16, Math.max(1, Math.ceil(dist / (C.PLAYER_R * 0.7))));
        const stepX = _mv.x * (dist / n), stepZ = _mv.y * (dist / n);
        for (let k = 0; k < n; k++) {
          player.x += stepX;
          player.z += stepZ;
          resolveCollisions();
        }
      }
    }
    resolveCollisions();   // si cand sta pe loc, ca sa nu ramana blocat in perete
  }

  // Nu lasa chelnerul sa se piarda in campie daca iese pe usa din fata.
  if (player.x < C.SPAWN_X) player.x = C.SPAWN_X;

  // Room service: intrarea in camera rezolva cererea.
  const r = roomUnderPlayer();
  if (r >= 0) serveRoom(r);

  // Zona din fata receptiei.
  const dx = player.x - C.DESK_ZONE_X, dz = player.z - C.DESK_ZONE_Z;
  const atDesk = player.floor === 0 && !player.riding &&
                 dx * dx + dz * dz < C.DESK_ZONE_R * C.DESK_ZONE_R;
  if (atDesk !== player.atDesk) {
    player.atDesk = atDesk;
    setServiceBoost(atDesk);
  }
}

/** Chelnerul se vede doar pe etajul afisat. */
export function renderPlayer() {
  const visible = Math.abs(player.y - state.activeFloor * C.FLOOR_H) < C.FLOOR_H * 0.9;
  group.visible = visible;
  if (!visible) return;
  group.position.set(player.x, player.y, player.z);
  group.rotation.y = player.yaw;
}
