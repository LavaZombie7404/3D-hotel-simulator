// ---------------------------------------------------------------------------
// The waiter - the character the player controls.
//
// What he does:
//   * Room service: when a checked-in guest rings, a gold diamond appears above
//     the room. Walk in => you collect a tip = $3 x the room level.
//   * Reception: while you stand in the circle in front of the desk, check-ins
//     run about 2.5 times faster.
//
// Collisions reuse exactly the same rectangles as the walls built in build.js
// (gfx.wallRects), so the doorways are free - there is no second collision
// model that could drift out of sync with the geometry.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.min.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import * as C from './config.js';
import { state } from './world.js';
import { gfx } from './build.js';
import { serveRoom, setServiceBoost } from './guests.js';
import { lift, callFromFloor, callFromCabin, doorsOpen, MOVING } from './elevator.js';
import { sfxStep } from './audio.js';

let stepAcc = 0;   // distance walked since the last footstep

// Touch input: the virtual joystick writes a direction in here and it is
// merged with the keyboard in updatePlayer, so both schemes share one path.
export const stick = { x: 0, y: 0 };

export const player = {
  x: C.LOBBY_X0 + 6,
  z: -5,
  floor: 0,
  y: 0,
  yaw: Math.PI / 2,
  inCabin: false,
  atDesk: false,
  moving: false,
};

let group = null;
const _fwd = new THREE.Vector2();
const _rt = new THREE.Vector2();
const _mv = new THREE.Vector2();

export function buildPlayer(scene) {
  group = new THREE.Group();

  const vest = new THREE.MeshLambertMaterial({ color: 0x8e2233 });   // burgundy vest
  const skin = new THREE.MeshLambertMaterial({ color: 0xe8c39a });
  const tray = new THREE.MeshLambertMaterial({ color: 0xd8dde3 });

  // Body and cap share a material: merge them into one geometry so they do
  // not cost two draw calls.
  const bodyGeo = new THREE.CapsuleGeometry(0.28, 0.66, 3, 10).translate(0, 0.62, 0);
  const capGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.12, 10).translate(0, 1.6, 0);
  const merged = mergeGeometries([bodyGeo, capGeo], false);
  bodyGeo.dispose(); capGeo.dispose();
  group.add(new THREE.Mesh(merged, vest));

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 10, 8), skin);
  head.position.y = 1.4;
  group.add(head);

  // A tray held out front, so you can tell at a glance which way he faces.
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12), tray);
  plate.position.set(0, 1.0, 0.42);
  group.add(plate);

  // Gold ring underfoot: from above, the waiter would be lost among the guests.
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

/** Puts him back in the lobby (used on rebirth). */
export function resetPlayer() {
  player.x = C.LOBBY_X0 + 6;
  player.z = -5;
  player.floor = 0;
  player.y = 0;
  player.yaw = Math.PI / 2;
  player.inCabin = false;
  player.atDesk = false;
  setServiceBoost(false);
}

// --- circle vs AABB collision ----------------------------------------------

/** Pushes the player out of any wall he has ended up inside. */
function resolveCollisions() {
  const rects = gfx.wallRects[player.floor];
  if (!rects) return;
  const r = C.PLAYER_R;

  // Two passes: after being pushed out of one wall he may nudge into another.
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
        // The centre is inside the rectangle: leave via the nearest edge.
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

// --- zones -------------------------------------------------------------------

/**
 * Is the waiter in the cabin?
 *
 * Once aboard he stays in as long as he is inside the cabin footprint - the
 * heights are not compared every frame. Otherwise the very first frame of the
 * ride moves the cabin further than the threshold and would drop him.
 * To board, the cabin must be stopped at his level, not merely passing by.
 */
function inCabinNow() {
  const inside = Math.abs(player.x - C.ELEV_X) < C.CABIN_HW - 0.1 &&
                 Math.abs(player.z) < C.CABIN_HW - 0.1;
  if (player.inCabin) return inside;
  return inside && lift.mode !== MOVING && Math.abs(player.y - lift.y) < 0.6;
}

/** In the lift shaft, but with no cabin at his floor. */
export function inShaft() {
  return Math.abs(player.x - C.ELEV_X) < C.ELEV_HW - 0.1 &&
         Math.abs(player.z) < C.ELEV_HW - 0.1;
}

/** The room the waiter is standing in, or -1 if he is in a corridor / lobby. */
function roomUnderPlayer() {
  if (Math.abs(player.z) <= C.HALF_C) return -1;
  if (player.x < 0 || player.x >= C.CORRIDOR_X1) return -1;
  const i = Math.floor(player.x / C.ROOM_W);
  if (i < 0 || i >= C.ROOMS_PER_SIDE) return -1;
  const s = player.z > 0 ? 0 : 1;
  return player.floor * C.ROOMS_PER_FLOOR + s * C.ROOMS_PER_SIDE + i;
}

/** Press a floor button inside the cabin. */
export function rideTo(floor) {
  if (!player.inCabin) return false;
  if (floor < 0 || floor >= C.FLOORS || !state.floorUnlocked[floor]) return false;
  if (floor === player.floor) return false;
  callFromCabin(floor);
  return true;
}

/** Call the lift to the floor the waiter is standing on. */
export function callLiftHere() {
  if (player.inCabin || !inShaft()) return false;
  callFromFloor(player.floor);
  return true;
}

export function canRide() { return player.inCabin; }

// --- update -----------------------------------------------------------------

/**
 * @param {number} dt            seconds
 * @param {THREE.Camera} camera   for screen-relative movement
 * @param {Set<string>} keys      the keys currently held down
 */
export function updatePlayer(dt, camera, keys) {
  // If he is in the cabin, he rides up and down with it.
  player.inCabin = inCabinNow();
  if (player.inCabin) {
    player.y = lift.y;
    player.floor = Math.max(0, Math.min(C.FLOORS - 1, Math.round(lift.y / C.FLOOR_H)));
  } else {
    player.y = player.floor * C.FLOOR_H;
  }

  {
    // Movement direction, relative to how the camera is turned.
    let ix = stick.x, iz = stick.y;
    if (keys.has('KeyW') || keys.has('ArrowUp')) iz += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) iz -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;

    player.moving = Math.abs(ix) > 0.01 || Math.abs(iz) > 0.01;
    if (player.moving) {
      // Camera matrix columns: [0..2] = right, [4..6] = up, [8..10] = -forward.
      const m = camera.matrix.elements;
      _rt.set(m[0], m[2]);
      _fwd.set(-m[8], -m[10]);
      // When the camera looks almost straight down, screen "forward" is really
      // its up vector projected onto the ground.
      if (_fwd.length() < 0.15) _fwd.set(m[4], m[6]);
      if (_rt.lengthSq() < 1e-6) _rt.set(1, 0);
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, -1);
      _rt.normalize();
      _fwd.normalize();

      _mv.set(_rt.x * ix + _fwd.x * iz, _rt.y * ix + _fwd.y * iz);
      if (_mv.lengthSq() > 1e-6) {
        _mv.normalize();
        player.yaw = Math.atan2(_mv.x, _mv.y);

        // Movement is split into steps smaller than a wall is thick.
        // Otherwise a long frame could skip a step clean over a wall and put
        // the player outside the building.
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
    resolveCollisions();   // also when standing still, so he never stays stuck in a wall
  }

  // Footsteps, paced by distance rather than time so they match the stride.
  if (player.moving && !player.inCabin) {
    stepAcc += C.PLAYER_SPEED * dt;
    if (stepAcc > 1.6) { stepAcc = 0; sfxStep(); }
  }

  // With the doors shut you cannot walk out of the cabin.
  if (player.inCabin && !doorsOpen()) {
    const lim = C.CABIN_HW - 0.15;
    player.x = Math.max(C.ELEV_X - lim, Math.min(C.ELEV_X + lim, player.x));
    player.z = Math.max(-lim, Math.min(lim, player.z));
  }

  // Do not let the waiter wander off into the field if he walks out the front.
  if (player.x < C.SPAWN_X) player.x = C.SPAWN_X;

  // Room service: walking into the room resolves the request.
  const r = roomUnderPlayer();
  if (r >= 0) serveRoom(r);

  // The zone in front of the reception desk.
  const dx = player.x - C.DESK_ZONE_X, dz = player.z - C.DESK_ZONE_Z;
  const atDesk = player.floor === 0 && !player.inCabin &&
                 dx * dx + dz * dz < C.DESK_ZONE_R * C.DESK_ZONE_R;
  if (atDesk !== player.atDesk) {
    player.atDesk = atDesk;
    setServiceBoost(atDesk);
  }
}

/** The waiter is only drawn on the floor currently shown. */
export function renderPlayer() {
  const visible = Math.abs(player.y - state.activeFloor * C.FLOOR_H) < C.FLOOR_H * 0.9;
  group.visible = visible;
  if (!visible) return;
  group.position.set(player.x, player.y, player.z);
  group.rotation.y = player.yaw;
}
