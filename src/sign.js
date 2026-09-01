// ---------------------------------------------------------------------------
// The hotel's sign above the entrance.
//
// The text is drawn onto a canvas and used as a texture, so naming your hotel
// needs no font file and no external request - it stays inside Poki's rule that
// everything must be bundled.
// ---------------------------------------------------------------------------
import * as THREE from '../vendor/three.module.min.js';
import * as C from './config.js';
import { state } from './world.js';

const W = 640, H = 160;          // canvas pixels
const SIGN_W = 11, SIGN_H = 2.75; // world units

let canvas = null;
let tex = null;
let mesh = null;

function draw(name) {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, W, H);

  // Panel.
  g.fillStyle = '#161a20';
  g.strokeStyle = '#ffd24b';
  g.lineWidth = 7;
  const r = 22;
  g.beginPath();
  g.moveTo(r, 4);
  g.arcTo(W - 4, 4, W - 4, H - 4, r);
  g.arcTo(W - 4, H - 4, 4, H - 4, r);
  g.arcTo(4, H - 4, 4, 4, r);
  g.arcTo(4, 4, W - 4, 4, r);
  g.closePath();
  g.fill();
  g.stroke();

  // Name, shrunk to fit however long it is.
  const text = (name || '').toUpperCase() || 'HOTEL';
  let size = 74;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  do {
    g.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
    if (g.measureText(text).width <= W - 60) break;
    size -= 3;
  } while (size > 22);

  g.shadowColor = 'rgba(255, 210, 75, 0.65)';
  g.shadowBlur = 22;
  g.fillStyle = '#ffe38a';
  g.fillText(text, W / 2, H / 2 + 3);
  g.shadowBlur = 0;

  if (tex) tex.needsUpdate = true;
}

export function buildSign(scene) {
  canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;

  const group = new THREE.Group();

  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(SIGN_W, SIGN_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
  );
  group.add(panel);

  // Two little posts so it reads as mounted, not floating.
  const postMat = new THREE.MeshLambertMaterial({ color: 0x8d97a3 });
  const postGeo = new THREE.BoxGeometry(0.16, 1.9, 0.16);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(sx * (SIGN_W / 2 - 0.9), -SIGN_H / 2 - 0.95, 0);
    group.add(post);
  }

  // Just outside the entrance wall, facing the road.
  group.position.set(C.LOBBY_X0 - 0.6, C.WALL_H + 1.6, 0);
  group.rotation.y = -Math.PI / 2;
  scene.add(group);
  mesh = group;

  draw(state.hotelName);
}

export function refreshSign() {
  if (canvas) draw(state.hotelName);
}

export function signObject() { return mesh; }
