// ---------------------------------------------------------------------------
// Building the 3D scene.
//
// Performance strategy:
//   * All the static architecture of a floor is merged into 3 geometries
//     (slab / walls / wood) => 3 draw calls per floor, with frozen matrices.
//   * Only the active floor is rendered; the rest have .visible = false.
//   * Room floors, doors and furniture are InstancedMeshes rebuilt ONLY when
//     the room state changes, not every frame.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.min.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import * as C from './config.js';
import { rooms, state, seatCount, seatX, seatZ } from './world.js';

// The dining room gets its own warm ramp; reusing the room palette made a
// level 4 restaurant the exact green of the lawn outside.
const REST_COLORS = [
  0x30363d,
  0x6b4a3a, 0x7a4f3f, 0x8a5344, 0x99584a,
  0xa85d50, 0xb76256, 0xc6675c, 0xd56c62, 0xe0806a,
];

export const LEVEL_COLORS = [
  0x30363d, // 0 = locked
  0x5a6472, 0x4a6d84, 0x44806c, 0x76854e,
  0xb8912f, 0xc4712f, 0xb04448, 0xdcc055,
];

// Furniture that shows up as you raise the room level.
// Offsets are in room-local coordinates: dx = along the corridor,
// dz = depth from the door towards the back wall.
const FURNITURE = [
  { name: 'pat',      minLevel: 1, color: 0xb8c4d4, w: 2.0, h: 0.50, d: 2.6, dx: -1.4, dy: 0.25, dz: 4.3 },
  { name: 'noptiera', minLevel: 2, color: 0x8b6f47, w: 0.6, h: 0.55, d: 0.6, dx: 0.0,  dy: 0.28, dz: 5.4 },
  { name: 'birou',    minLevel: 3, color: 0x8b6f47, w: 1.7, h: 0.75, d: 0.7, dx: 1.7,  dy: 0.38, dz: 2.4 },
  { name: 'canapea',  minLevel: 4, color: 0x4f6f8f, w: 1.8, h: 0.70, d: 0.8, dx: 1.6,  dy: 0.35, dz: 5.3 },
  { name: 'tv',       minLevel: 5, color: 0x14161a, w: 1.5, h: 0.85, d: 0.1, dx: -1.2, dy: 1.15, dz: 1.2 },
  { name: 'planta',   minLevel: 6, color: 0x2f7d4f, w: 0.5, h: 1.10, d: 0.5, dx: 2.1,  dy: 0.55, dz: 6.2 },
  { name: 'covor',    minLevel: 7, color: 0x9a4a4a, w: 2.6, h: 0.03, d: 1.9, dx: 0.5,  dy: 0.02, dz: 3.0 },
];

export const gfx = {
  scene: null,
  floorGroups: [],          // one Group per floor (static architecture)
  always: null,             // always visible (ground, road)
  tiles: null,              // InstancedMesh of room floors
  doors: null,              // InstancedMesh of doors
  furniture: [],            // one InstancedMesh per furniture type
  instRoom: new Int32Array(C.ROOMS_PER_FLOOR),   // instance -> room id
  roomInst: new Int32Array(C.TOTAL_ROOMS),       // room id -> instance (-1)
  selection: null,
  restFloor: null,
  tables: null,
  wallRects: [],            // XZ AABBs per floor (x0,x1,z0,z1,...) for collisions
  markers: null,            // room service markers above the rooms
  deskRing: null,           // the circle in front of the reception desk
};

// Reused scratch objects: no allocations in the update loops.
const _obj = new THREE.Object3D();
const _col = new THREE.Color();
const _dirtCol = new THREE.Color(0x6b5a3a);

// --- geometry helpers ------------------------------------------------------

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function mergeInto(group, list, material) {
  if (list.length === 0) return null;
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  const mesh = new THREE.Mesh(merged, material);
  mesh.matrixAutoUpdate = false;   // static geometry: do not recompute the matrix
  mesh.updateMatrix();
  group.add(mesh);
  return mesh;
}

// --- shared materials -------------------------------------------------------
// MeshLambertMaterial is far cheaper than Standard and looks fine with
// hemisphere + directional lighting.
const matSlab   = new THREE.MeshLambertMaterial({ color: 0x4a5058 });
const matWall   = new THREE.MeshLambertMaterial({ color: 0xd9d4c9 });
const matWood   = new THREE.MeshLambertMaterial({ color: 0x8b6f47 });
const matGround = new THREE.MeshLambertMaterial({ color: 0x38502c });
const matBank   = new THREE.MeshLambertMaterial({ color: 0x6b6a4a });
const matWater  = new THREE.MeshLambertMaterial({ color: 0x2f6f8f });
const matTrunk  = new THREE.MeshLambertMaterial({ color: 0x5a4029 });
const matLeaf   = new THREE.MeshLambertMaterial({ color: 0xffffff });
const matRock   = new THREE.MeshLambertMaterial({ color: 0x7d7f82 });
const matRoad   = new THREE.MeshLambertMaterial({ color: 0x2a2c30 });
const matSteel  = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
// The per-instance colour comes from InstancedMesh.instanceColor and is
// multiplied by the material's .color; do NOT set vertexColors (it would want
// a 'color' attribute in the geometry, which is missing => everything black).
const matTile   = new THREE.MeshLambertMaterial({ color: 0xffffff });
const matDoor   = new THREE.MeshLambertMaterial({ color: 0xffffff });

// ---------------------------------------------------------------------------

export function buildScene(scene) {
  gfx.scene = scene;
  buildEnvironment(scene);
  for (let f = 0; f < C.FLOORS; f++) gfx.floorGroups.push(buildFloor(scene, f));
  buildRoomInstances(scene);
  buildSelection(scene);
  buildExtras(scene);
  buildRestaurantFittings(scene);
  setActiveFloor(0);
}

// --- ground, road, river, trees ---------------------------------------------

// A tiny deterministic generator, so the scenery is identical on every load
// and screenshots stay comparable between runs.
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const BUILD_X0 = C.LOBBY_X0 - 4;
const BUILD_X1 = C.CORRIDOR_X1 + 4;
const RIVER_Z = -34;
const RIVER_W = 13;

/** Is this spot free of the hotel, the restaurant, the road and the river? */
function freeGround(x, z) {
  if (x > BUILD_X0 && x < BUILD_X1 && Math.abs(z) < C.BUILD_Z + 4) return false;
  // The restaurant wing, or trees grow between the tables.
  if (x > C.REST_X0 - 3 && x < C.REST_X1 + 3 && z > C.REST_Z0 - 3 && z < -C.BUILD_Z) return false;
  if (x < C.LOBBY_X0 && Math.abs(z) < 6) return false;              // the road
  if (Math.abs(z - RIVER_Z) < RIVER_W / 2 + 3) return false;        // the river
  return true;
}

function buildEnvironment(scene) {
  const g = new THREE.Group();
  scene.add(g);
  gfx.always = g;

  buildSky(scene);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(420, 340), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -C.SLAB_T - 0.02;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  g.add(ground);

  // The access road up to the entrance.
  const road = new THREE.Mesh(new THREE.PlaneGeometry(40, 7), matRoad);
  road.rotation.x = -Math.PI / 2;
  road.position.set(C.LOBBY_X0 - 20, -C.SLAB_T - 0.01, 0);
  road.matrixAutoUpdate = false;
  road.updateMatrix();
  g.add(road);

  buildRiver(g);
  buildTrees(g);

  // The lift is built per floor (see buildFloor): otherwise the posts and
  // plates of the other floors would show through the active one.
}

/** A gradient dome instead of a flat background colour. */
function buildSky(scene) {
  const geo = new THREE.SphereGeometry(320, 24, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x1e3350);
  const horizon = new THREE.Color(0x6d8ba6);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // Bias the blend downwards so most of the visible dome is the lighter band.
    const t = Math.min(1, Math.max(0, pos.getY(i) / 320)) ** 0.55;
    c.copy(horizon).lerp(top, t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  }));
  sky.matrixAutoUpdate = false;
  sky.updateMatrix();
  scene.add(sky);
}

/** A river running behind the hotel, with a shallow bank around it. */
function buildRiver(g) {
  const bank = new THREE.Mesh(new THREE.PlaneGeometry(420, RIVER_W + 5), matBank);
  bank.rotation.x = -Math.PI / 2;
  bank.position.set(0, -C.SLAB_T + 0.01, RIVER_Z);
  bank.matrixAutoUpdate = false;
  bank.updateMatrix();
  g.add(bank);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(420, RIVER_W), matWater);
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -C.SLAB_T + 0.02, RIVER_Z);
  water.matrixAutoUpdate = false;
  water.updateMatrix();
  g.add(water);
}

/**
 * Trees and rocks, scattered outside the hotel. Everything is instanced, so the
 * whole landscape costs three draw calls no matter how much of it there is.
 */
function buildTrees(g) {
  const rand = makeRandom(20260901);
  const spots = [];
  for (let i = 0; i < 900 && spots.length < 150; i++) {
    const x = (rand() - 0.5) * 300;
    const z = (rand() - 0.5) * 210;
    if (!freeGround(x, z)) continue;
    spots.push({ x, z, s: 0.75 + rand() * 0.9, tint: rand(), lean: (rand() - 0.5) * 0.18 });
  }

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 2.4, 5);
  trunkGeo.translate(0, 1.2, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, matTrunk, spots.length);

  const leafGeo = new THREE.IcosahedronGeometry(1.7, 0);
  leafGeo.translate(0, 3.3, 0);
  const leaves = new THREE.InstancedMesh(leafGeo, matLeaf, spots.length);

  const green = new THREE.Color();
  spots.forEach((p, i) => {
    _obj.position.set(p.x, -C.SLAB_T, p.z);
    _obj.rotation.set(p.lean, p.tint * 6.283, p.lean * 0.7);
    _obj.scale.setScalar(p.s);
    _obj.updateMatrix();
    trunks.setMatrixAt(i, _obj.matrix);
    leaves.setMatrixAt(i, _obj.matrix);
    // A spread of greens so the treeline is not one flat colour.
    green.setHSL(0.26 + p.tint * 0.06, 0.38 + p.tint * 0.18, 0.22 + p.tint * 0.12);
    leaves.setColorAt(i, green);
  });
  for (const m of [trunks, leaves]) { m.matrixAutoUpdate = false; m.updateMatrix(); g.add(m); }

  // A few boulders along the bank.
  const rocks = [];
  for (let i = 0; i < 400 && rocks.length < 40; i++) {
    const x = (rand() - 0.5) * 260;
    const z = RIVER_Z + (rand() - 0.5) * (RIVER_W + 12);
    if (Math.abs(z - RIVER_Z) < RIVER_W / 2 - 1) continue;   // not in the water
    if (!freeGround(x, z) && Math.abs(z - RIVER_Z) > RIVER_W) continue;
    rocks.push({ x, z, s: 0.5 + rand() * 1.1, r: rand() * 6.283 });
  }
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMesh = new THREE.InstancedMesh(rockGeo, matRock, rocks.length);
  rocks.forEach((p, i) => {
    _obj.position.set(p.x, -C.SLAB_T - 0.2, p.z);
    _obj.rotation.set(0.3, p.r, 0.2);
    _obj.scale.set(p.s * 1.3, p.s * 0.8, p.s);
    _obj.updateMatrix();
    rockMesh.setMatrixAt(i, _obj.matrix);
  });
  rockMesh.matrixAutoUpdate = false;
  rockMesh.updateMatrix();
  g.add(rockMesh);
}

// --- architecture of one floor --------------------------------------------------

function buildFloor(scene, f) {
  const group = new THREE.Group();
  scene.add(group);

  const y = f * C.FLOOR_H;              // floor level
  const wallY = y + C.WALL_H / 2;
  const slabs = [], walls = [], wood = [], lift = [];
  const rects = [];                     // XZ AABBs for the waiter's collisions

  // Add an obstacle: geometry for rendering + its collision rectangle.
  const solid = (list, w, h, d, x, yy, z) => {
    list.push(box(w, h, d, x, yy, z));
    rects.push(x - w / 2, x + w / 2, z - d / 2, z + d / 2);
  };

  // The floor slab (not an obstacle).
  const x0 = f === 0 ? C.LOBBY_X0 - 0.5 : C.UPPER_X0;
  const x1 = C.CORRIDOR_X1 + 0.5;
  slabs.push(box(x1 - x0, C.SLAB_T, C.BUILD_Z * 2 + 1, (x0 + x1) / 2, y - C.SLAB_T / 2, 0));

  for (let s = 0; s < 2; s++) {
    const sign = s === 0 ? 1 : -1;
    const zMid = sign * (C.HALF_C + C.ROOM_D / 2);

    // Partition walls between rooms.
    for (let i = 0; i <= C.ROOMS_PER_SIDE; i++) {
      solid(walls, C.WALL_T, C.WALL_H, C.ROOM_D, i * C.ROOM_W, wallY, zMid);
    }
    // The outer wall behind the rooms.
    solid(walls, C.CORRIDOR_X1 + C.WALL_T, C.WALL_H, C.WALL_T,
          C.CORRIDOR_X1 / 2, wallY, sign * C.BUILD_Z);

    // The corridor-facing wall, with a doorway gap in the middle of each room.
    const segW = (C.ROOM_W - C.DOOR_W) / 2;
    for (let i = 0; i < C.ROOMS_PER_SIDE; i++) {
      const cx = i * C.ROOM_W + C.ROOM_W / 2;
      solid(walls, segW, C.WALL_H, C.WALL_T, cx - (C.DOOR_W + segW) / 2, wallY, sign * C.HALF_C);
      solid(walls, segW, C.WALL_H, C.WALL_T, cx + (C.DOOR_W + segW) / 2, wallY, sign * C.HALF_C);
    }
  }

  // The end of the corridor.
  solid(walls, C.WALL_T, C.WALL_H, C.CORRIDOR_W, C.CORRIDOR_X1, wallY, 0);

  // The lift shaft at this floor: 4 posts (obstacles) + the top beams.
  // The floor itself comes with the cabin, which travels (see elevator.js).
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      solid(lift, 0.28, C.WALL_H, 0.28,
            C.ELEV_X + sx * C.ELEV_HW, wallY, C.ELEV_Z + sz * C.ELEV_HW);
    }
  }
  for (const sz of [1, -1]) {
    lift.push(box(C.ELEV_HW * 2, 0.2, 0.28,
                  C.ELEV_X, y + C.WALL_H, C.ELEV_Z + sz * C.ELEV_HW));
  }
  mergeInto(group, lift, matSteel);

  if (f === 0) {
    // Lobby: front wall with an entrance gap + side walls.
    const gap = 1.8;
    const segZ = C.BUILD_Z - gap / 2;
    for (const sign of [1, -1]) {
      solid(walls, C.WALL_T, C.WALL_H, segZ, C.LOBBY_X0, wallY, sign * (gap / 2 + segZ / 2));
    }
    solid(walls, -C.LOBBY_X0, C.WALL_H, C.WALL_T, C.LOBBY_X0 / 2, wallY, C.BUILD_Z);

    // The south wall is split to leave a doorway through to the restaurant.
    const doorL = C.REST_DOOR_X - C.REST_DOOR_W / 2;
    const doorR = C.REST_DOOR_X + C.REST_DOOR_W / 2;
    const leftW = doorL - C.LOBBY_X0;
    const rightW = 0 - doorR;
    solid(walls, leftW, C.WALL_H, C.WALL_T, C.LOBBY_X0 + leftW / 2, wallY, -C.BUILD_Z);
    solid(walls, rightW, C.WALL_H, C.WALL_T, doorR + rightW / 2, wallY, -C.BUILD_Z);

    buildRestaurantWing(slabs, walls, y, wallY, solid);
    // The reception desk + the panel behind it.
    solid(wood, C.DESK_W, 1.05, 1.0, C.DESK_X, y + 0.525, C.DESK_Z);
    solid(wood, C.DESK_W + 1.4, 2.2, 0.25, C.DESK_X, y + 1.1, C.DESK_Z + 1.3);
    // A few benches in the waiting area.
    for (let i = 0; i < 2; i++) {
      solid(wood, 3.2, 0.45, 0.8, C.LOBBY_X0 + 5.5 + i * 4.2, y + 0.22, -C.BUILD_Z + 1.4);
    }
  } else {
    // Landing / lounge on the upper floors.
    solid(walls, C.WALL_T, C.WALL_H, C.BUILD_Z * 2, C.UPPER_X0, wallY, 0);
    for (const sign of [1, -1]) {
      solid(walls, -C.UPPER_X0, C.WALL_H, C.WALL_T, C.UPPER_X0 / 2, wallY, sign * C.BUILD_Z);
    }
  }

  mergeInto(group, slabs, matSlab);
  mergeInto(group, walls, matWall);
  mergeInto(group, wood, matWood);
  gfx.wallRects[f] = new Float32Array(rects);
  return group;
}

/**
 * The restaurant wing hanging off the south side of the lobby. It is always
 * built; whether it is open is a matter of its level, the same way a locked
 * room is still a room.
 */
function buildRestaurantWing(slabs, walls, y, wallY, solid) {
  const w = C.REST_X1 - C.REST_X0;
  const zFar = C.REST_Z0;
  const depth = -C.BUILD_Z - zFar;

  slabs.push(box(w + 1, C.SLAB_T, depth + 0.5,
                 (C.REST_X0 + C.REST_X1) / 2, y - C.SLAB_T / 2, (zFar - C.BUILD_Z) / 2 - 0.25));

  solid(walls, C.WALL_T, C.WALL_H, depth, C.REST_X0, wallY, (zFar - C.BUILD_Z) / 2);
  solid(walls, C.WALL_T, C.WALL_H, depth, C.REST_X1, wallY, (zFar - C.BUILD_Z) / 2);
  solid(walls, w + C.WALL_T, C.WALL_H, C.WALL_T, (C.REST_X0 + C.REST_X1) / 2, wallY, zFar);
}

function buildRestaurantFittings(scene) {
  const w = C.REST_X1 - C.REST_X0;
  const depth = -C.BUILD_Z - C.REST_Z0;
  const geo = new THREE.PlaneGeometry(w - C.WALL_T, depth - C.WALL_T);
  geo.rotateX(-Math.PI / 2);
  gfx.restFloor = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x30363d }));
  gfx.restFloor.position.set((C.REST_X0 + C.REST_X1) / 2, 0.015, (C.REST_Z0 - C.BUILD_Z) / 2);
  scene.add(gfx.restFloor);

  // One table per seat; only as many as the current level pays for are drawn.
  const tableGeo = new THREE.CylinderGeometry(0.62, 0.5, 0.78, 10);
  tableGeo.translate(0, 0.39, 0);
  gfx.tables = new THREE.InstancedMesh(tableGeo, matWood, C.MAX_SEATS);
  gfx.tables.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gfx.tables.frustumCulled = false;
  gfx.tables.count = 0;
  scene.add(gfx.tables);
}

/** Called whenever the restaurant is built or upgraded. */
export function refreshRestaurant() {
  const lvl = state.restaurantLevel;
  gfx.restFloor.material.color.setHex(REST_COLORS[Math.min(lvl, REST_COLORS.length - 1)]);

  const n = seatCount();
  for (let i = 0; i < n; i++) {
    // The table sits just beyond the spot the diner walks to.
    _obj.position.set(seatX(i), 0, seatZ(i) - 0.85);
    _obj.rotation.set(0, 0, 0);
    _obj.scale.set(1, 1, 1);
    _obj.updateMatrix();
    gfx.tables.setMatrixAt(i, _obj.matrix);
  }
  gfx.tables.count = n;
  gfx.tables.instanceMatrix.needsUpdate = true;

  // Only the ground floor has a restaurant.
  const onGround = state.activeFloor === 0;
  gfx.restFloor.visible = onGround;
  gfx.tables.visible = onGround;
}

// --- room instances -------------------------------------------------------------------------------------------------------

function buildRoomInstances(scene) {
  const n = C.ROOMS_PER_FLOOR;

  const tileGeo = new THREE.PlaneGeometry(1, 1);
  tileGeo.rotateX(-Math.PI / 2);
  gfx.tiles = new THREE.InstancedMesh(tileGeo, matTile, n);
  gfx.tiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gfx.tiles.frustumCulled = false;
  scene.add(gfx.tiles);

  const doorGeo = new THREE.BoxGeometry(C.DOOR_W, 2.1, C.WALL_T * 1.3);
  gfx.doors = new THREE.InstancedMesh(doorGeo, matDoor, n);
  gfx.doors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gfx.doors.frustumCulled = false;
  scene.add(gfx.doors);

  for (const def of FURNITURE) {
    const geo = new THREE.BoxGeometry(def.w, def.h, def.d);
    geo.translate(def.dx, def.dy, def.dz);   // room-local offset, baked in
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: def.color }), n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    scene.add(mesh);
    gfx.furniture.push({ def, mesh });
  }
}

function buildSelection(scene) {
  const geo = new THREE.BoxGeometry(C.ROOM_W - C.WALL_T, C.WALL_H, C.ROOM_D);
  const edges = new THREE.EdgesGeometry(geo);
  geo.dispose();
  gfx.selection = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffd24b }));
  gfx.selection.visible = false;
  scene.add(gfx.selection);
}

// --- API --------------------------------------------------------------------

export function setActiveFloor(f) {
  state.activeFloor = f;
  for (let i = 0; i < gfx.floorGroups.length; i++) gfx.floorGroups[i].visible = (i === f);
  refreshRooms();
}

/**
 * Rebuilds the instances for the active floor. Called only when the floor or a
 * room's state changes (unlock / upgrade), never every frame.
 */
export function refreshRooms() {
  const f = state.activeFloor;
  gfx.roomInst.fill(-1);

  let n = 0;
  for (let s = 0; s < 2; s++) {
    for (let i = 0; i < C.ROOMS_PER_SIDE; i++) {
      const r = f * C.ROOMS_PER_FLOOR + s * C.ROOMS_PER_SIDE + i;
      gfx.instRoom[n] = r;
      gfx.roomInst[r] = n;

      // The room floor, coloured by level.
      _obj.position.set(rooms.cx[r], rooms.cy[r] + 0.015, rooms.cz[r]);
      _obj.rotation.set(0, 0, 0);
      _obj.scale.set(C.ROOM_W - C.WALL_T, 1, C.ROOM_D - C.WALL_T);
      _obj.updateMatrix();
      gfx.tiles.setMatrixAt(n, _obj.matrix);
      _col.setHex(LEVEL_COLORS[rooms.level[r]]);
      gfx.tiles.setColorAt(n, _col);

      // The door.
      _obj.position.set(rooms.cx[r], rooms.cy[r] + 1.05, rooms.doorZ[r]);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      gfx.doors.setMatrixAt(n, _obj.matrix);

      n++;
    }
  }
  gfx.tiles.count = n;
  gfx.doors.count = n;
  gfx.tiles.instanceMatrix.needsUpdate = true;
  gfx.doors.instanceMatrix.needsUpdate = true;
  if (gfx.tiles.instanceColor) gfx.tiles.instanceColor.needsUpdate = true;

  refreshFurniture();
  refreshDoorColors();
  refreshRestaurant();
  updateSelection();
}

function refreshFurniture() {
  const f = state.activeFloor;
  for (const entry of gfx.furniture) {
    let k = 0;
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < C.ROOMS_PER_SIDE; i++) {
        const r = f * C.ROOMS_PER_FLOOR + s * C.ROOMS_PER_SIDE + i;
        if (rooms.level[r] < entry.def.minLevel) continue;
        // Anchor = the door; rotating by PI mirrors the rooms on the south side.
        _obj.position.set(rooms.cx[r], rooms.cy[r], rooms.doorZ[r]);
        _obj.rotation.set(0, rooms.side[r] === 0 ? 0 : Math.PI, 0);
        _obj.scale.set(1, 1, 1);
        _obj.updateMatrix();
        entry.mesh.setMatrixAt(k++, _obj.matrix);
      }
    }
    entry.mesh.count = k;
    entry.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Green = free, red = occupied, grey = locked. Colours only, no rebuild. */
export function refreshDoorColors() {
  const n = gfx.doors.count;
  for (let k = 0; k < n; k++) {
    const r = gfx.instRoom[k];
    if (rooms.level[r] === 0) _col.setHex(0x3a3f47);
    else if (rooms.occupant[r] >= 0) _col.setHex(0xd4453f);
    else if (rooms.dirty[r] > 0) _col.setHex(0x8a7040);   // needs cleaning
    else _col.setHex(0x46c86a);
    gfx.doors.setColorAt(k, _col);

    // A dirty room's floor is dulled towards brown, so you can see the mess
    // from across the hotel without reading the door.
    _col.setHex(LEVEL_COLORS[rooms.level[r]]);
    if (rooms.dirty[r] > 0) _col.lerp(_dirtCol, 0.55);
    gfx.tiles.setColorAt(k, _col);
  }
  if (gfx.doors.instanceColor) gfx.doors.instanceColor.needsUpdate = true;
  if (gfx.tiles.instanceColor) gfx.tiles.instanceColor.needsUpdate = true;
}

export function updateSelection() {
  const r = state.selected;
  if (r < 0 || rooms.floor[r] !== state.activeFloor) {
    gfx.selection.visible = false;
    return;
  }
  gfx.selection.visible = true;
  gfx.selection.position.set(rooms.cx[r], rooms.cy[r] + C.WALL_H / 2, rooms.cz[r]);
}

/** The room id under the cursor, or -1. Run on click only, never per frame. */
export function pickRoom(raycaster) {
  const hits = raycaster.intersectObjects([gfx.tiles, gfx.doors], false);
  if (hits.length === 0) return -1;
  const id = hits[0].instanceId;
  return id === undefined ? -1 : gfx.instRoom[id];
}

// --- room service markers + the reception circle -------------------------

function buildExtras(scene) {
  // A gold diamond floating above the room that rang for room service.
  const geo = new THREE.OctahedronGeometry(0.42);
  // White base so the per-instance colour comes through unchanged.
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x3a2a00 });
  gfx.markers = new THREE.InstancedMesh(geo, mat, C.ROOMS_PER_FLOOR);
  gfx.markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gfx.markers.frustumCulled = false;
  gfx.markers.count = 0;
  scene.add(gfx.markers);

  // The circle in front of the desk: it lights up when the waiter is in it.
  const ring = new THREE.RingGeometry(C.DESK_ZONE_R - 0.28, C.DESK_ZONE_R, 40);
  ring.rotateX(-Math.PI / 2);
  gfx.deskRing = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
    color: 0xffd24b, transparent: true, opacity: 0.22, depthWrite: false,
  }));
  gfx.deskRing.position.set(C.DESK_ZONE_X, 0.03, C.DESK_ZONE_Z);
  scene.add(gfx.deskRing);
}

/**
 * Places the diamonds above rooms with an active request, on the visible floor.
 * `hasRequest(roomId)` is injected so build.js does not depend on guests.js.
 */
export function updateMarkers(t, hasRequest) {
  const f = state.activeFloor;
  let k = 0;
  for (let s = 0; s < 2; s++) {
    for (let i = 0; i < C.ROOMS_PER_SIDE; i++) {
      const r = f * C.ROOMS_PER_FLOOR + s * C.ROOMS_PER_SIDE + i;
      const wants = hasRequest(r);
      const messy = rooms.dirty[r] > 0;
      if (!wants && !messy) continue;
      _obj.position.set(rooms.cx[r], rooms.cy[r] + 2.5 + Math.sin(t * 3 + r) * 0.18, rooms.cz[r]);
      _obj.rotation.set(0, t * 1.6, 0);
      // A room service call is worth more than a clean-up, so it is bigger.
      _obj.scale.setScalar(wants ? 1 : 0.68);
      _obj.updateMatrix();
      gfx.markers.setMatrixAt(k, _obj.matrix);
      _col.setHex(wants ? 0xffd24b : 0x9a8050);
      gfx.markers.setColorAt(k, _col);
      k++;
    }
  }
  gfx.markers.count = k;
  gfx.markers.instanceMatrix.needsUpdate = true;
  if (gfx.markers.instanceColor) gfx.markers.instanceColor.needsUpdate = true;
}

export function setDeskRing(active) {
  gfx.deskRing.visible = state.activeFloor === 0;
  gfx.deskRing.material.opacity = active ? 0.55 : 0.16;
}
