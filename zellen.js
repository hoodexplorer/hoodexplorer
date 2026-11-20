/* Runde 144: telephone booths - later the place for jobs, teleporting and travelling between worlds.
   - placement: one chance per ~220 m cell of a global lat/lon grid (the same booths on every visit, whatever the start point), only in
     built-up areas, on the pavement beside an ordinary street, the door towards the street
   - look: a yellow booth with glass panes, a lit sign and a phone inside; one instanced draw per material
   - entering (walking into it, on foot) opens the booth's own menu (#zlSheet): for now a greeting and "Verlassen"
   - map layer "Telefonzellen" (minimap and big map), switchable in Einstellungen → Karte */
(function () {
'use strict';
const A = window.HXZ_API; if (!A || !window.THREE) return;
const CELL_LAT = .002, CELL_LON = .0033, CHANCE = .5, MAXN = 160;
const H = (i, j, s) => { let h = (i * 374761393 + j * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

// ------------------------------------------------------------------ model (Runde 145: a tall blue box with a lamp on the roof; 1.32 m wide, 3.2 m high, door towards +z)
const BLUE = [.09, .20, .42], BLUE2 = [.06, .14, .31], BLUE3 = [.13, .27, .52], PLATE = [.86, .86, .82];
function boxes(list) { // [x0,y0,z0,x1,y1,z1,colour] -> geometry with colours
  const pos = [], nor = [], col = [];
  for (const [x0, y0, z0, x1, y1, z1, c] of list) {
    const F = [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0]],
      [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]],
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]]];
    for (const [a, b, cc, d, n] of F) for (const v of [a, b, cc, a, cc, d]) { pos.push(...v); nor.push(...n); col.push(...c); } }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); return g;
}
const turn = (bx, k) => { let [x0, y0, z0, x1, y1, z1, c] = bx; for (let i = 0; i < k; i++) { const nx0 = z0, nx1 = z1, nz0 = -x1, nz1 = -x0; x0 = nx0; x1 = nx1; z0 = nz0; z1 = nz1; } return [x0, y0, z0, x1, y1, z1, c]; }; // quarter turns about y
const all4 = list => { const o = []; for (let k = 0; k < 4; k++) for (const bx of list) o.push(turn(bx, k)); return o; };
const S = .66, T = .12, Y0 = .1, YT = 2.45; // half width, corner post, plinth top, top of the walls
const side = [ // one face (+z), repeated on all four sides
  [-S + T, Y0, S - .1, S - T, YT, S - .05, BLUE2],                              // recessed wall
  [-S + T, Y0, S - .06, S - T, Y0 + .08, S, BLUE], [-S + T, .92, S - .06, S - T, 1.0, S, BLUE], [-S + T, 1.6, S - .06, S - T, 1.68, S, BLUE], [-S + T, 2.22, S - .06, S - T, YT, S, BLUE], // rails
  [-.04, Y0, S - .06, .04, YT, S, BLUE],                                         // middle stile (the two door halves)
  [-S + T + .2, 1.68, S - .045, -S + T + .23, 2.22, S - .01, BLUE], [S - T - .23, 1.68, S - .045, S - T - .2, 2.22, S - .01, BLUE], // window bars
  [-S + T, 1.94, S - .045, -.04, 1.97, S - .01, BLUE], [.04, 1.94, S - .045, S - T, 1.97, S - .01, BLUE]
];
const body = [
  [-S - .07, 0, -S - .07, S + .07, Y0, S + .07, BLUE2],                         // plinth
  ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, c]) => [a > 0 ? S - T : -S, Y0, c > 0 ? S - T : -S, a > 0 ? S : -S + T, 2.62, c > 0 ? S : -S + T, BLUE3]), // corner posts
  ...all4(side),
  [-S - .07, 2.62, -S - .07, S + .07, 2.72, S + .07, BLUE], [-S + .05, 2.72, -S + .05, S - .05, 2.8, S - .05, BLUE3], [-S + .2, 2.8, -S + .2, S - .2, 2.86, S - .2, BLUE], // stepped roof
  [-.11, 2.86, -.11, .11, 2.9, .11, BLUE3], [-.12, 3.12, -.12, .12, 3.16, .12, BLUE3], [-.035, 3.16, -.035, .035, 3.21, .035, BLUE3], // lamp base, cap, knob
  [-.07, 2.9, -.07, -.05, 3.12, -.05, BLUE3], [.05, 2.9, -.07, .07, 3.12, -.05, BLUE3], [-.07, 2.9, .05, -.05, 3.12, .07, BLUE3], [.05, 2.9, .05, .07, 3.12, .07, BLUE3], // lamp cage
  [-S + T + .06, 1.25, S - .03, -.1, 1.48, S + .005, PLATE],                      // white notice plate on the left door
  [.08, 1.15, S - .02, .11, 1.3, S + .03, BLUE3]                                  // door handle
];
const gBody = boxes(body);
const gWin = boxes(all4([[-S + T, 1.68, S - .05, -.04, 2.22, S - .043, [1, 1, 1]], [.04, 1.68, S - .05, S - T, 2.22, S - .043, [1, 1, 1]]])); // windows (lit from inside)
const gLamp = boxes([[-.055, 2.9, -.055, .055, 3.12, .055, [1, 1, 1]]]);
const gSign = boxes(all4([[-S + .02, 2.46, S + .005, S - .02, 2.6, S + .035, [1, 1, 1]]])); // sign band on all sides, lit
// sign: TELEFON in pixel letters (generic word, no brand), white on dark blue
const signTex = (() => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 12; const g = cv.getContext('2d'); g.fillStyle = '#0b1830'; g.fillRect(0, 0, 64, 12);
  g.fillStyle = '#f4f6fb'; g.font = 'bold 10px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('TELEFON', 32, 6.5);
  const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return t; })();
{ const p = gSign.attributes.position.array, uv = new Float32Array(p.length / 3 * 2); // uvs along each sign; which way 'along' runs follows the side the box is on (36 vertices per box)
  for (let i = 0; i < p.length / 3; i++) { const bi = Math.floor(i / 36) * 36; let cx = 0, cz = 0; for (let j = bi; j < bi + 36; j++) { cx += p[j * 3]; cz += p[j * 3 + 2]; }
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2], along = Math.abs(cz) > Math.abs(cx) ? (cz > 0 ? x : -x) : (cx > 0 ? -z : z);
    uv[i * 2] = (along + S) / (2 * S); uv[i * 2 + 1] = (y - 2.46) / .14; }
  gSign.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); }
// glow around the lamp at night: three crossed quads with a soft round texture, added to the colour behind
const haloTex = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 32; const g = cv.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.35, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return t; })();
const gHalo = (() => { const pos = [], uv = [], R = .9, yc = 3.01;
  for (const a of [0, Math.PI / 3, Math.PI * 2 / 3]) { const c = Math.cos(a) * R, s2 = Math.sin(a) * R; const q = [[-c, yc - R, -s2, 0, 0], [c, yc - R, s2, 1, 0], [c, yc + R, s2, 1, 1], [-c, yc + R, -s2, 0, 1]];
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(q[k][0], q[k][1], q[k][2]); uv.push(q[k][3], q[k][4]); } }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); return g; })();

const mBody = new THREE.MeshLambertMaterial({ vertexColors: true });
const mWin = new THREE.MeshBasicMaterial({ color: 0x8ea3b8 });
const mLamp = new THREE.MeshBasicMaterial({ color: 0xd8e2ea });
const mSign = new THREE.MeshBasicMaterial({ map: signTex });
const mHalo = new THREE.MeshBasicMaterial({ map: haloTex, color: 0xfff1c8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const iBody = new THREE.InstancedMesh(gBody, mBody, MAXN), iWin = new THREE.InstancedMesh(gWin, mWin, MAXN), iLamp = new THREE.InstancedMesh(gLamp, mLamp, MAXN),
  iSign = new THREE.InstancedMesh(gSign, mSign, MAXN), iHalo = new THREE.InstancedMesh(gHalo, mHalo, MAXN);
const PARTS = [iBody, iWin, iLamp, iSign, iHalo];
for (const m of PARTS) { m.count = 0; m.frustumCulled = false; A.scene.add(m); }
iHalo.renderOrder = 3;

// ------------------------------------------------------------------ placement
const BOOTHS = new Map(); // cell key -> booth {x, z, y, yaw, tile, name} or null (cell has none)
const CELLTILE = new Map(); // cell key -> tile key it was decided with
let dirty = true;
function segNear(roads, x, z, R) { // nearest point on an ordinary street within R
  let best = null, bd = R * R;
  for (const r of roads) { if (r.k !== 'm' || r.a || r.t || r.b || r.r) continue; const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) { const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz; if (l2 < 1) continue;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), qx = ax + dx * u, qz = az + dz * u, d = (qx - x) ** 2 + (qz - z) ** 2;
      if (d < bd) { bd = d; const l = Math.sqrt(l2); best = { qx, qz, tx: dx / l, tz: dz / l, w: r.w, u, l }; } } }
  return best;
}
function onRoad(roads, x, z) { for (const r of roads) { if (r.k === 'p' || r.k === 't') continue; const p = r.p, w2 = (r.w / 2 + .7) ** 2;
  for (let i = 0; i + 3 < p.length; i += 2) { const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, l2 = dx * dx + dz * dz || 1, u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    if ((ax + dx * u - x) ** 2 + (az + dz * u - z) ** 2 < w2) return true; } } return false; }
function builtUp(x, z) { let n = 0; for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2, r = k % 2 ? 18 : 32; if (A.buildingAt(x + Math.cos(a) * r, z + Math.sin(a) * r)) n++; } return n >= (window.HX_WELT === 'mittel' ? 1 : 3); } // Runde 154: medieval towns stand looser
function decide(t, key, ci, cj) {
  if (H(ci, cj, 1) > CHANCE) return null;
  for (let tr = 0; tr < 3; tr++) { // up to three tries inside the cell
    const lat = (ci + .15 + .7 * H(ci, cj, 10 + tr)) * CELL_LAT, lon = (cj + .15 + .7 * H(ci, cj, 20 + tr)) * CELL_LON, q = A.toLocal(lat, lon);
    const s = segNear(t.roads, q.x, q.z, 70); if (!s) continue;
    if (s.u * s.l < 6 || (1 - s.u) * s.l < 6) continue; // not right at a crossing (the segment end): mid-block on the pavement
    let nx = -s.tz, nz = s.tx; if ((q.x - s.qx) * nx + (q.z - s.qz) * nz < 0) { nx = -nx; nz = -nz; } // the side of the street towards the target
    const off = s.w / 2 + 1.5, x = s.qx + nx * off, z = s.qz + nz * off;
    let free = !onRoad(t.roads, x, z) && !A.water(x, z) && !A.underground(x, z);
    for (const [a, b] of [[0, 0], [.8, 0], [-.8, 0], [0, .8], [0, -.8], [nx * 1.6, nz * 1.6]]) if (free && A.buildingAt(x + a, z + b)) free = false;
    if (!free || !builtUp(x, z)) continue;
    return { x, z, y: A.terrainH(x, z), yaw: Math.atan2(-nx, -nz), tile: key, id: ci + '_' + cj }; // door (+z of the model) towards the street
  }
  return null;
}
let scanI = 0;
function scan() { // a few cells per call, only for loaded tiles
  let budget = 12;
  for (const [key, t] of A.tiles) { if (!t.map || !t.roads || t.zlDone) continue;
    const x0 = t.map.x0, z0 = t.map.z0, x1 = x0 + t.map.cv.width / t.map.s, z1 = z0 + t.map.cv.height / t.map.s;
    if (!t.zlCells) { const a = A.toLatLon(x0, z1), b = A.toLatLon(x1, z0), c = []; // south-west, north-east
      for (let ci = Math.floor(a[0] / CELL_LAT); ci <= Math.floor(b[0] / CELL_LAT); ci++) for (let cj = Math.floor(a[1] / CELL_LON); cj <= Math.floor(b[1] / CELL_LON); cj++) c.push([ci, cj]);
      t.zlCells = c; t.zlI = 0; }
    while (t.zlI < t.zlCells.length) { if (budget-- <= 0) return; const [ci, cj] = t.zlCells[t.zlI++], ck = ci + '_' + cj; if (CELLTILE.has(ck)) continue;
      const c = A.toLocal((ci + .5) * CELL_LAT, (cj + .5) * CELL_LON); if (c.x < x0 || c.x >= x1 || c.z < z0 || c.z >= z1) continue; // the tile holding the cell centre decides
      CELLTILE.set(ck, key); const b = decide(t, key, ci, cj); BOOTHS.set(ck, b); if (b) dirty = true; }
    t.zlDone = true;
  }
}
function prune() { // tiles dropped: their booths go; buildings arriving later (3D houses) may cover a booth
  for (const [ck, k] of CELLTILE) if (!A.tiles.has(k)) { CELLTILE.delete(ck); if (BOOTHS.get(ck)) dirty = true; BOOTHS.delete(ck); }
  for (const [ck, b] of BOOTHS) if (b) { if (A.buildingAt(b.x, b.z)) { BOOTHS.set(ck, null); dirty = true; continue; } const y = A.terrainH(b.x, b.z); if (Math.abs(y - b.y) > .02) { b.y = y; dirty = true; } }
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _e = new THREE.Euler();
let LIST = []; const _lit = new THREE.Color();
function rebuild() {
  LIST = [...BOOTHS.values()].filter(Boolean); const P = A.P;
  LIST.sort((a, b) => Math.hypot(a.x - P.x, a.z - P.z) - Math.hypot(b.x - P.x, b.z - P.z)); if (LIST.length > MAXN) LIST.length = MAXN;
  LIST.forEach((b, i) => { _e.set(0, b.yaw, 0); _q.setFromEuler(_e); _p.set(b.x, b.y, b.z); _m.compose(_p, _q, _s); for (const m of PARTS) m.setMatrixAt(i, _m); });
  for (const m of PARTS) { m.count = LIST.length; m.instanceMatrix.needsUpdate = true; }
  dirty = false;
}

// ------------------------------------------------------------------ entering and the booth menu
const sheet = document.getElementById('zlSheet'); let inside = null, away = null;
function enter(b) {
  inside = b; const P = A.P; P.x = b.x; P.z = b.z; P.speed = 0; P.hold = true; P.yaw = b.yaw + Math.PI; // stand inside, facing the phone: the camera looks in through the door
  document.getElementById('zlName').textContent = (A.streetAt && A.streetAt(b.x, b.z)) ? 'Telefonzelle · ' + A.streetAt(b.x, b.z) : 'Telefonzelle';
  sheet.hidden = false;
}
function leave() {
  if (!inside) return; const b = inside, P = A.P; inside = null; sheet.hidden = true; P.hold = false;
  P.x = b.x + Math.sin(b.yaw) * 1.3; P.z = b.z + Math.cos(b.yaw) * 1.3; P.yaw = b.yaw; away = b; // step out of the door
}
document.getElementById('zlLeave').addEventListener('click', leave);
document.addEventListener('keydown', e => { if (inside && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); leave(); } });

// ------------------------------------------------------------------ map layer
const ICON = (g, x, y, r) => { g.fillStyle = '#2f62c8'; g.strokeStyle = '#1a1206'; g.lineWidth = Math.max(1.5, r * .3); g.beginPath(); g.rect(x - r, y - r * 1.25, r * 2, r * 2.5); g.fill(); g.stroke();
  g.fillStyle = '#fff1c8'; g.fillRect(x - r * .35, y - r * 1.75, r * .7, r * .5); g.fillStyle = '#cfe0ff'; g.fillRect(x - r * .6, y - r * .8, r * 1.2, r * .55); };
window.HXZ = {
  get list() { return LIST; },
  drawMini(g, MS) { if (!A.LAYERS.zellen) return; for (const b of LIST) ICON(g, b.x * MS, b.z * MS, 6); },
  drawBig(g, toScr, d, s) { if (!A.LAYERS.zellen || s < .12) return; for (const b of LIST) { const [x, y] = toScr(b.x, b.z); ICON(g, x, y, 5 * d); } },
  enter: b => enter(b || LIST[0]), leave, get inside() { return inside; }
};

// ------------------------------------------------------------------ per frame (called from a timer and the game loop via rAF)
let tScan = 0, tPrune = 0;
function tick() {
  const now = performance.now();
  if (now - tScan > 250) { tScan = now; scan(); }
  if (now - tPrune > 3000) { tPrune = now; prune(); }
  if (dirty) rebuild();
  const P = A.P;
  if (!inside && !A.DRV.on && A.started && LIST.length) {
    let nb = null, nd = 1e9; for (const b of LIST) { const d = Math.hypot(b.x - P.x, b.z - P.z); if (d < nd) { nd = d; nb = b; } }
    if (away && Math.hypot(away.x - P.x, away.z - P.z) > 1.6) away = null;
    if (nb && nd < .62 && nb !== away && Math.abs(P.y - nb.y) < 1.2) enter(nb);
  }
  // night: windows glow warm, the sign is lit, the lamp on the roof pulses with a soft glow (no light source - that would cost every material a light)
  const night = A.night(), pulse = .62 + .38 * Math.sin(performance.now() / 1000 * 2.4);
  mWin.color.setRGB(.56 + .44 * night, .64 + .3 * night, .72);
  mLamp.color.setRGB(.85, .88, .9).lerp(_lit.setRGB(1, .97, .86), night).multiplyScalar(1 - night * (1 - pulse) * .55);
  mSign.color.setScalar(.72 + .28 * night); mHalo.opacity = night * pulse * .85;
  if (inside) { P.x = inside.x; P.z = inside.z; }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
})();
