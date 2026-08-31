// ---------------------------------------------------------------------------
// Constructia scenei 3D.
//
// Strategie de performanta:
//   * Toata arhitectura statica a unui etaj e fuzionata in 3 geometrii
//     (placa / pereti / lemn) => 3 draw call-uri per etaj, matrici inghetate.
//   * Se randeaza doar etajul activ; celelalte au .visible = false.
//   * Podelele, usile si mobilierul camerelor sunt InstancedMesh-uri
//     reconstruite DOAR cand se schimba starea camerelor, nu in fiecare cadru.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import * as C from './config.js';
import { rooms, state } from './world.js';

export const LEVEL_COLORS = [
  0x30363d, // 0 = blocata
  0x5a6472, 0x4a6d84, 0x44806c, 0x76854e,
  0xb8912f, 0xc4712f, 0xb04448, 0xdcc055,
];

// Mobilier care apare pe masura ce urci nivelul camerei.
// Offset-urile sunt in coordonate locale camerei: dx = de-a lungul holului,
// dz = adancime dinspre usa spre peretele din spate.
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
  floorGroups: [],          // un Group per etaj (arhitectura statica)
  always: null,             // ce se vede mereu (teren, drum, lift)
  tiles: null,              // InstancedMesh podele camere
  doors: null,              // InstancedMesh usi
  furniture: [],            // InstancedMesh per tip de mobilier
  instRoom: new Int32Array(C.ROOMS_PER_FLOOR),   // instanta -> id camera
  roomInst: new Int32Array(C.TOTAL_ROOMS),       // id camera -> instanta (-1)
  selection: null,
  wallRects: [],            // AABB-uri XZ per etaj (x0,x1,z0,z1,...) pentru coliziuni
  markers: null,            // semnele de room service deasupra camerelor
  deskRing: null,           // cercul din fata receptiei
};

// Obiecte de lucru reutilizate: nicio alocare in buclele de update.
const _obj = new THREE.Object3D();
const _col = new THREE.Color();

// --- helpers geometrie ------------------------------------------------------

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
  mesh.matrixAutoUpdate = false;   // geometrie statica: nu recalcula matricea
  mesh.updateMatrix();
  group.add(mesh);
  return mesh;
}

// --- materiale partajate ----------------------------------------------------
// MeshLambertMaterial e mult mai ieftin decat Standard si arata bine cu
// iluminare hemisferica + directionala.
const matSlab   = new THREE.MeshLambertMaterial({ color: 0x4a5058 });
const matWall   = new THREE.MeshLambertMaterial({ color: 0xd9d4c9 });
const matWood   = new THREE.MeshLambertMaterial({ color: 0x8b6f47 });
const matGround = new THREE.MeshLambertMaterial({ color: 0x27331f });
const matRoad   = new THREE.MeshLambertMaterial({ color: 0x2a2c30 });
const matSteel  = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
// Culoarea per-instanta vine din InstancedMesh.instanceColor si se inmulteste
// cu .color al materialului; NU se pune vertexColors (ar cere un atribut
// 'color' in geometrie, care lipseste => totul ar iesi negru).
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
  setActiveFloor(0);
}

// --- teren, drum, lift ------------------------------------------------------

function buildEnvironment(scene) {
  const g = new THREE.Group();
  scene.add(g);
  gfx.always = g;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 150), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -C.SLAB_T - 0.02;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  g.add(ground);

  // Drumul de acces spre intrare.
  const road = new THREE.Mesh(new THREE.PlaneGeometry(28, 7), matRoad);
  road.rotation.x = -Math.PI / 2;
  road.position.set(C.LOBBY_X0 - 14, -C.SLAB_T - 0.01, 0);
  road.matrixAutoUpdate = false;
  road.updateMatrix();
  g.add(road);

  // Liftul se construieste per etaj (vezi buildFloor): altfel s-ar vedea
  // stalpii si placile celorlalte etaje peste etajul activ.
}

// --- arhitectura unui etaj --------------------------------------------------

function buildFloor(scene, f) {
  const group = new THREE.Group();
  scene.add(group);

  const y = f * C.FLOOR_H;              // nivelul podelei
  const wallY = y + C.WALL_H / 2;
  const slabs = [], walls = [], wood = [], lift = [];
  const rects = [];                     // AABB-uri XZ pentru coliziunea chelnerului

  // Adauga un obstacol: geometria pentru randare + dreptunghiul de coliziune.
  const solid = (list, w, h, d, x, yy, z) => {
    list.push(box(w, h, d, x, yy, z));
    rects.push(x - w / 2, x + w / 2, z - d / 2, z + d / 2);
  };

  // Placa de etaj (nu e obstacol).
  const x0 = f === 0 ? C.LOBBY_X0 - 0.5 : C.UPPER_X0;
  const x1 = C.CORRIDOR_X1 + 0.5;
  slabs.push(box(x1 - x0, C.SLAB_T, C.BUILD_Z * 2 + 1, (x0 + x1) / 2, y - C.SLAB_T / 2, 0));

  for (let s = 0; s < 2; s++) {
    const sign = s === 0 ? 1 : -1;
    const zMid = sign * (C.HALF_C + C.ROOM_D / 2);

    // Pereti despartitori intre camere.
    for (let i = 0; i <= C.ROOMS_PER_SIDE; i++) {
      solid(walls, C.WALL_T, C.WALL_H, C.ROOM_D, i * C.ROOM_W, wallY, zMid);
    }
    // Peretele exterior din spatele camerelor.
    solid(walls, C.CORRIDOR_X1 + C.WALL_T, C.WALL_H, C.WALL_T,
          C.CORRIDOR_X1 / 2, wallY, sign * C.BUILD_Z);

    // Peretele dinspre hol, cu gol de usa in mijlocul fiecarei camere.
    const segW = (C.ROOM_W - C.DOOR_W) / 2;
    for (let i = 0; i < C.ROOMS_PER_SIDE; i++) {
      const cx = i * C.ROOM_W + C.ROOM_W / 2;
      solid(walls, segW, C.WALL_H, C.WALL_T, cx - (C.DOOR_W + segW) / 2, wallY, sign * C.HALF_C);
      solid(walls, segW, C.WALL_H, C.WALL_T, cx + (C.DOOR_W + segW) / 2, wallY, sign * C.HALF_C);
    }
  }

  // Capatul holului.
  solid(walls, C.WALL_T, C.WALL_H, C.CORRIDOR_W, C.CORRIDOR_X1, wallY, 0);

  // Cabina liftului de pe acest etaj: 4 stalpi (obstacole) + placa si grinzi.
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sz = -1; sz <= 1; sz += 2) {
      solid(lift, 0.28, C.WALL_H, 0.28, C.ELEV_X + sx * C.ELEV_HW, wallY, sz * C.ELEV_HW);
    }
  }
  lift.push(box(C.ELEV_HW * 2, 0.2, 0.28, C.ELEV_X, y + C.WALL_H, C.ELEV_HW));
  lift.push(box(C.ELEV_HW * 2, 0.2, 0.28, C.ELEV_X, y + C.WALL_H, -C.ELEV_HW));
  mergeInto(group, lift, matSteel);

  if (f === 0) {
    // Lobby: perete frontal cu gol de intrare + pereti laterali.
    const gap = 1.8;
    const segZ = C.BUILD_Z - gap / 2;
    for (const sign of [1, -1]) {
      solid(walls, C.WALL_T, C.WALL_H, segZ, C.LOBBY_X0, wallY, sign * (gap / 2 + segZ / 2));
      solid(walls, -C.LOBBY_X0, C.WALL_H, C.WALL_T, C.LOBBY_X0 / 2, wallY, sign * C.BUILD_Z);
    }
    // Biroul de receptie + panoul din spate.
    solid(wood, C.DESK_W, 1.05, 1.0, C.DESK_X, y + 0.525, C.DESK_Z);
    solid(wood, C.DESK_W + 1.4, 2.2, 0.25, C.DESK_X, y + 1.1, C.DESK_Z + 1.3);
    // Cateva banci in zona de asteptare.
    for (let i = 0; i < 3; i++) {
      solid(wood, 3.2, 0.45, 0.8, C.LOBBY_X0 + 5.5 + i * 4.2, y + 0.22, -C.BUILD_Z + 1.4);
    }
  } else {
    // Palier / lounge la etajele superioare.
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

// --- instante pentru camere -------------------------------------------------

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
    geo.translate(def.dx, def.dy, def.dz);   // offset local camerei, baked in
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
 * Reconstruieste instantele pentru etajul activ. Apelat doar la schimbarea
 * etajului sau a starii unei camere (deblocare / upgrade), nu in fiecare cadru.
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

      // Podeaua camerei, colorata dupa nivel.
      _obj.position.set(rooms.cx[r], rooms.cy[r] + 0.015, rooms.cz[r]);
      _obj.rotation.set(0, 0, 0);
      _obj.scale.set(C.ROOM_W - C.WALL_T, 1, C.ROOM_D - C.WALL_T);
      _obj.updateMatrix();
      gfx.tiles.setMatrixAt(n, _obj.matrix);
      _col.setHex(LEVEL_COLORS[rooms.level[r]]);
      gfx.tiles.setColorAt(n, _col);

      // Usa.
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
        // Ancora = usa; rotatia cu PI oglindeste camerele de pe latura sudica.
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

/** Verde = libera, rosu = ocupata, gri = blocata. Doar culori, fara rebuild. */
export function refreshDoorColors() {
  const n = gfx.doors.count;
  for (let k = 0; k < n; k++) {
    const r = gfx.instRoom[k];
    if (rooms.level[r] === 0) _col.setHex(0x3a3f47);
    else if (rooms.occupant[r] >= 0) _col.setHex(0xd4453f);
    else _col.setHex(0x46c86a);
    gfx.doors.setColorAt(k, _col);
  }
  if (gfx.doors.instanceColor) gfx.doors.instanceColor.needsUpdate = true;
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

/** Id-ul camerei de sub cursor sau -1. Rulat doar la click, nu per cadru. */
export function pickRoom(raycaster) {
  const hits = raycaster.intersectObjects([gfx.tiles, gfx.doors], false);
  if (hits.length === 0) return -1;
  const id = hits[0].instanceId;
  return id === undefined ? -1 : gfx.instRoom[id];
}

// --- semnele de room service + cercul de la receptie -------------------------

function buildExtras(scene) {
  // Un romb auriu care pluteste deasupra camerei care a cerut room service.
  const geo = new THREE.OctahedronGeometry(0.42);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffd24b, emissive: 0x6b4c00 });
  gfx.markers = new THREE.InstancedMesh(geo, mat, C.ROOMS_PER_FLOOR);
  gfx.markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gfx.markers.frustumCulled = false;
  gfx.markers.count = 0;
  scene.add(gfx.markers);

  // Cercul din fata receptiei: se aprinde cand chelnerul e in el.
  const ring = new THREE.RingGeometry(C.DESK_ZONE_R - 0.28, C.DESK_ZONE_R, 40);
  ring.rotateX(-Math.PI / 2);
  gfx.deskRing = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
    color: 0xffd24b, transparent: true, opacity: 0.22, depthWrite: false,
  }));
  gfx.deskRing.position.set(C.DESK_ZONE_X, 0.03, C.DESK_ZONE_Z);
  scene.add(gfx.deskRing);
}

/**
 * Pozitioneaza rombii deasupra camerelor cu cerere activa, de pe etajul vizibil.
 * `hasRequest(roomId)` e dat din afara ca sa nu legam build.js de guests.js.
 */
export function updateMarkers(t, hasRequest) {
  const f = state.activeFloor;
  let k = 0;
  for (let s = 0; s < 2; s++) {
    for (let i = 0; i < C.ROOMS_PER_SIDE; i++) {
      const r = f * C.ROOMS_PER_FLOOR + s * C.ROOMS_PER_SIDE + i;
      if (!hasRequest(r)) continue;
      _obj.position.set(rooms.cx[r], rooms.cy[r] + 2.5 + Math.sin(t * 3 + r) * 0.18, rooms.cz[r]);
      _obj.rotation.set(0, t * 1.6, 0);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      gfx.markers.setMatrixAt(k++, _obj.matrix);
    }
  }
  gfx.markers.count = k;
  gfx.markers.instanceMatrix.needsUpdate = true;
}

export function setDeskRing(active) {
  gfx.deskRing.visible = state.activeFloor === 0;
  gfx.deskRing.material.opacity = active ? 0.55 : 0.16;
}
