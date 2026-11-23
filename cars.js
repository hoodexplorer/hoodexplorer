/* HoodExplorer – parked cars as real low-poly 3D models, drawn with instancing.
   8 types (city car, hatchback, saloon, estate, SUV, van, taxi, delivery truck), each one merged geometry with vertex colours.
   One InstancedMesh per type for the whole map: a single draw call per type, position/heading/colour per car.
   Only cars around the player are shown (nearest first, capped), so old phones keep up. The pixel look comes from the
   low-resolution render and the outline pass, like everything else.
   Body vertices are pure white and get the car's own colour in the shader; glass, tyres, lights keep their colour. */
let WATER_DROP = 0; // water surface below the land (set by the app: 1.2 m with terrain)
const CAR_TYPES = 13, CAR_MAX = 700, CAR_TOTAL = 900, CAR_RADIUS = 230;
// typical German car colours, roughly by frequency (index 12 = taxi ivory)
const CAR_COLOURS = ['#202226', '#a9adb2', '#6e7278', '#e9e9e6', '#1f3357', '#2f5f9e', '#a3262a', '#2f4f3a', '#b9a27c', '#5a3a2a', '#e0b02a', '#d8682a', '#efe3bc'].map(c => new THREE.Color(c));

function buildCarModels() {
  const WHITE = [1, 1, 1], GLASS = [.17, .24, .33], TYRE = [.08, .08, .08], DARK = [.16, .16, .17], HEAD = [.98, .95, .8], TAIL = [.8, .1, .1], SHADOW = [.17, .18, .2], SIGN = [.96, .82, .24], BOXW = [.9, .9, .88];
  function model(parts) { // parts: [geometry, colour, matrix, kind?] -> one indexed geometry with vertex colours
    // aD per vertex: kind (1 body, 2 roof, 3 tyre, 4 glass, 5 rim, 0 other), body top and bottom -> pixel details in the shader
    let nv = 0, ni = 0; for (const [g] of parts) { nv += g.attributes.position.count; ni += g.index.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), dd = new Float32Array(nv * 3), idx = new Uint16Array(ni);
    let ov = 0, oi = 0; const v = new THREE.Vector3(), nm = new THREE.Matrix3();
    let top = 0, bot = 9; for (const [g, c, m, k] of parts) if (c === WHITE && k === undefined) { const b = new THREE.Box3().setFromBufferAttribute(g.attributes.position).applyMatrix4(m); top = Math.max(top, b.max.y); bot = Math.min(bot, b.min.y); }
    for (const [g, c, m, k0] of parts) {
      const kind = k0 !== undefined ? k0 : c === WHITE ? 1 : c === WHITE6 ? 6 : c === TYRE ? 3 : c === GLASS ? 4 : 0;
      for (let i = 0; i < g.attributes.position.count; i++) dd.set([kind, top, bot], (ov + i) * 3);
      nm.getNormalMatrix(m); const P = g.attributes.position, N = g.attributes.normal;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m); pos.set([v.x, v.y, v.z], (ov + i) * 3);
        v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nor.set([v.x, v.y, v.z], (ov + i) * 3); col.set(c, (ov + i) * 3);
      }
      for (let i = 0; i < g.index.count; i++) idx[oi + i] = g.index.getX(i) + ov;
      ov += P.count; oi += g.index.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setAttribute('aD', new THREE.BufferAttribute(dd, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.computeBoundingSphere();
    return geo;
  }
  const M = (x, y, z, ry, rz) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry || 0, rz || 0)), new THREE.Vector3(1, 1, 1));
  const box = (sx, sy, sz) => new THREE.BoxGeometry(sx, sy, sz);
  function cabinGeo(l, w, h, fIn, rIn) { // sloped wind- and rear screen
    const g = box(w, h, l), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setZ(i, p.getZ(i) > 0 ? p.getZ(i) - fIn : p.getZ(i) + rIn);
    g.computeVertexNormals(); return g;
  }
  const wheel = new THREE.CylinderGeometry(1, 1, 1, 8);
  const RIM = [.62, .66, .66];
  function wheels(parts, l, w, r) { for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    parts.push([wheel, TYRE, new THREE.Matrix4().compose(new THREE.Vector3(sx * (w / 2 - .1), r, sz * (l / 2 - r * 1.35)), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)), new THREE.Vector3(r, .24, r))]);
    parts.push([wheel, RIM, new THREE.Matrix4().compose(new THREE.Vector3(sx * (w / 2 - .1 + .03), r, sz * (l / 2 - r * 1.35)), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)), new THREE.Vector3(r * .58, .25, r * .58)), 5]); } } // rims (pixel-art cars always show light hubs)
  function car(o, extra) { // front = +z
    const { l, w, bh, ch, cl, cz, fIn, rIn, r } = o, by = r * .55, parts = [];
    parts.push([box(w + .3, .02, l + .3), SHADOW, M(0, .1, 0)]);                                   // contact shadow
    parts.push([box(w, bh, l), WHITE, M(0, by + bh / 2, 0)]);                                        // body
    parts.push([cabinGeo(cl, w * .9, ch, fIn, rIn), GLASS, M(0, by + bh + ch / 2, cz)]);            // windows
    parts.push([box(w * .86, .07, cl - fIn - rIn - .05), WHITE, M(0, by + bh + ch + .02, cz + (rIn - fIn) / 2), 2]); // roof (kind 2: may be two-tone)
    parts.push([box(w * 1.01, .18, .14), DARK, M(0, by + .1, l / 2)]); parts.push([box(w * 1.01, .18, .14), DARK, M(0, by + .1, -l / 2)]); // bumpers
    for (const sx of [-1, 1]) { parts.push([box(.32, .14, .06), HEAD, M(sx * (w / 2 - .22), by + bh - .14, l / 2 + .01)]); parts.push([box(.3, .14, .06), TAIL, M(sx * (w / 2 - .2), by + bh - .14, -l / 2 - .01)]); }
    wheels(parts, l, w, r);
    if (extra) extra(parts, o);
    return model(parts);
  }
  const WHITE6 = [1, 1, 1]; // boat hulls: take the boat's colour, but no car details
  const saloon = { l: 4.75, w: 1.82, bh: .64, ch: .6, cl: 2.4, cz: -.25, fIn: .75, rIn: .7, r: .32 };
  return [
    car({ l: 3.0, w: 1.62, bh: .62, ch: .68, cl: 2.0, cz: -.25, fIn: .55, rIn: .15, r: .28 }),     // city car
    car({ l: 4.1, w: 1.78, bh: .66, ch: .66, cl: 2.5, cz: -.5, fIn: .7, rIn: .3, r: .31 }),        // hatchback
    car(saloon),                                                                                    // saloon
    car({ l: 4.75, w: 1.82, bh: .66, ch: .64, cl: 3.1, cz: -.6, fIn: .75, rIn: .12, r: .32 }),     // estate (Kombi)
    car({ l: 4.55, w: 1.9, bh: .85, ch: .72, cl: 2.8, cz: -.45, fIn: .55, rIn: .2, r: .38 }),      // SUV
    car({ l: 5.0, w: 1.95, bh: 1.05, ch: .95, cl: 4.0, cz: -.45, fIn: .45, rIn: .05, r: .34 }),    // van (Transporter)
    car(saloon, p => p.push([box(.55, .16, .2), SIGN, M(0, .32 * .55 + .64 + .6 + .14, -.2)])),     // taxi
    (() => { const r = .36, by = r * .55, parts = [[box(2.35, .02, 6.0), SHADOW, M(0, .1, 0)]];   // delivery truck
      parts.push([box(1.95, 1.2, 1.7), WHITE, M(0, by + .6, 1.95)], [cabinGeo(1.5, 1.8, .7, .35, 0), GLASS, M(0, by + 1.35, 2.0)], [box(2.1, 2.3, 3.7), BOXW, M(0, by + 1.25, -.9)], [box(2.0, .18, .14), DARK, M(0, by + .1, 2.82)]);
      for (const sx of [-1, 1]) { parts.push([box(.3, .14, .06), HEAD, M(sx * .75, by + .9, 2.81)], [box(.25, .2, .06), TAIL, M(sx * .85, by + .5, -2.76)]); }
      wheels(parts, 5.6, 2.0, r); return model(parts); })(),
    // boats (types 8-10): hull bottom below the waterline, white parts take the boat's colour
    (() => { const parts = [], WOOD = [.55, .4, .27]; // motorboat
      parts.push([box(2.1, .9, 5.2), WHITE6, M(0, 0, 0)], [box(1.5, .9, 1.6), WHITE6, M(0, 0, 2.9, Math.PI / 4)], [box(2.12, .16, 5.22), DARK, M(0, .2, 0)]);
      parts.push([cabinGeo(1.8, 1.7, .7, .5, .1), GLASS, M(0, .8, .3)], [box(1.7, .06, 1.9), WOOD, M(0, .46, -1.6)]);
      return model(parts); })(),
    (() => { const parts = []; // sailboat with mast and boom
      parts.push([box(2.5, 1.0, 7.0), WHITE6, M(0, 0, 0)], [box(1.8, 1.0, 1.8), WHITE6, M(0, 0, 3.8, Math.PI / 4)], [box(2.52, .14, 7.02), DARK, M(0, .35, 0)]);
      parts.push([box(1.6, .5, 2.6), BOXW, M(0, .75, .2)], [box(.12, 10, .12), BOXW, M(0, 5.5, 1.2)], [box(.1, .1, 3.2), DARK, M(0, 1.6, -.4)], [box(.5, .3, 3.0), [.2, .3, .55], M(0, 1.75, -.4)]);
      return model(parts); })(),
    (() => { const parts = []; // harbour launch (Barkasse): long low hull, black hull, white body, cabin with windows
      parts.push([box(3.6, 1.0, 13), [.12, .12, .14], M(0, 0, 0)], [box(2.6, 1.0, 2.6), [.12, .12, .14], M(0, 0, 6.7, Math.PI / 4)], [box(3.62, .25, 13.02), [.6, .1, .1], M(0, .45, 0)]);
      parts.push([box(3.2, .9, 8.5), WHITE6, M(0, 1.0, -.8)], [box(3.25, .45, 8.0), GLASS, M(0, 1.2, -.8)], [box(3.3, .1, 9.0), BOXW, M(0, 1.5, -.8)], [box(1.6, 1.0, 1.6), WHITE6, M(0, 1.9, 2.8)]);
      return model(parts); })(),
    (() => { const parts = [], cyl = new THREE.CylinderGeometry(1, 1, 1, 10), BLUE = [.16, .3, .62]; // airliner (type 11, ~38 m): white body, blue tail and stripe
      const R = (x, y, z, sx, sy, sz, rx, rz) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, 0, rz || 0)), new THREE.Vector3(sx, sy, sz));
      parts.push([cyl, WHITE6, R(0, 4.2, 0, 2.0, 36, 2.0, Math.PI / 2)], [cyl, WHITE6, R(0, 4.2, 18.5, 1.3, 2.5, 1.3, Math.PI / 2)], [box(1.6, 1.0, 2.2), GLASS, M(0, 5.0, 17.4)]);
      parts.push([box(34, .45, 6), BOXW, M(0, 3.4, 1)], [box(12, .3, 3), BOXW, M(0, 5.0, -16.5)], [box(.4, 7, 4.5), BLUE, M(0, 8.0, -16.8)], [box(4.04, .35, 30), BLUE, M(0, 4.4, 0)]);
      for (const sx of [-1, 1]) parts.push([cyl, [.7, .72, .74], R(sx * 6.5, 2.4, 2.5, 1.2, 4, 1.2, Math.PI / 2)], [box(.4, 2.1, .4), DARK, M(sx * 2.6, 0, 1)]);
      parts.push([box(.3, 2.1, .3), DARK, M(0, 0, 14)]);
      return model(parts); })(),
    (() => { const parts = [], BLUE = [.16, .3, .62]; // Runde 278: small plane (type 12, ~8 m, high wing) for small airfields
      parts.push([box(1.2, 1.3, 4.6), WHITE6, M(0, .8, .4)], [box(1.0, .85, 1.0), WHITE6, M(0, .95, 3.2)], [box(.7, .7, 3.2), WHITE6, M(0, 1.25, -3.4)], [box(1.24, .5, 1.7), GLASS, M(0, 1.55, 1.0)]);
      parts.push([box(11, .16, 1.5), BOXW, M(0, 2.1, .9)], [box(3.4, .12, .9), BOXW, M(0, 1.6, -4.7)], [box(.14, 1.4, 1.0), BLUE, M(0, 1.85, -4.8)], [box(1.24, .16, 6.2), BLUE, M(0, 1.3, -.4)]);
      for (const sx of [-1, 1]) parts.push([box(.1, 1.2, .1), DARK, M(sx * 1.7, 1.0, .9)], [box(.15, .8, .15), DARK, M(sx * .9, 0, .6)]);
      parts.push([box(.15, .95, .15), DARK, M(0, 0, 3.3)], [box(1.9, .14, .08), DARK, M(0, 1.3, 3.75)]);
      return model(parts); })()
  ];
}

const carMat = new THREE.MeshLambertMaterial({ vertexColors: true });
/* Pixel-art car look without textures (reference: isometric pixel cars): light top faces, a bright shoulder line along the
   upper body edge, a dark sill, door seams and handles, black grille and white number plates on front and back, light rims.
   Everything from the local position and the part kind (aD) - no extra geometry, no image files. Per car: own size, tone,
   sometimes a two-tone roof (iVar). */
carMat.onBeforeCompile = sh => {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 iCol; attribute float iVar; attribute vec3 aD; varying vec3 vLoc, vLN, vD; varying float vVar;')
    .replace('#include <color_vertex>', `vColor = color; vLoc = position; vLN = normal; vD = aD; vVar = iVar;
      if ((aD.x > 0.5 && aD.x < 2.5) || aD.x > 5.5) { vColor = iCol * (0.93 + 0.14 * fract(iVar * 7.31)); // body: own colour per car, a little lighter or darker
        if (aD.x > 1.5 && aD.x < 2.5 && iVar > 0.82) vColor = iVar > 0.91 ? vec3(0.92, 0.92, 0.9) : vec3(0.12, 0.12, 0.13); } // two-tone roof`);
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vLoc, vLN, vD; varying float vVar;').replace('#include <color_fragment>', `#include <color_fragment>
    { float k = vD.x, top = vD.y, bot = vD.z; vec3 p = vLoc, n = normalize(vLN);
      if (k > 0.5 && k < 2.5) {
        if (n.y > 0.7) diffuseColor.rgb *= 1.12;                                         // lit top (bonnet, boot, roof)
        if (abs(n.x) > 0.7) {
          if (p.y > top - 0.09) diffuseColor.rgb = min(diffuseColor.rgb * 1.3 + 0.05, vec3(1.0)); // shoulder highlight
          if (p.y < bot + 0.07) diffuseColor.rgb *= 0.62;                                 // sill shadow
          if ((abs(p.z - 0.32) < 0.035 || abs(p.z + 0.78) < 0.035) && p.y > bot + 0.07) diffuseColor.rgb *= 0.68; // door seams
          if (abs(p.z - 0.05) < 0.11 && abs(p.y - (top - 0.2)) < 0.035) diffuseColor.rgb = min(diffuseColor.rgb * 1.4 + 0.1, vec3(1.0)); // handle
        }
        if (n.z > 0.7) {
          if (abs(p.x) < 0.42 && p.y > top - 0.42 && p.y < top - 0.13) diffuseColor.rgb = mod(floor(p.y / 0.055), 2.0) > 0.5 ? vec3(0.07) : vec3(0.15); // grille
          if (abs(p.x) < 0.24 && p.y > bot + 0.03 && p.y < bot + 0.16) diffuseColor.rgb = (abs(p.x) > 0.2 || p.y < bot + 0.05 || p.y > bot + 0.14) ? vec3(0.2) : vec3(0.93); // plate
        }
        if (n.z < -0.7 && abs(p.x) < 0.24 && p.y > bot + 0.12 && p.y < bot + 0.25) diffuseColor.rgb = (abs(p.x) > 0.2 || p.y < bot + 0.14 || p.y > bot + 0.23) ? vec3(0.2) : vec3(0.93);
        if (n.y > 0.7 && abs(abs(p.x) - 0.38) < 0.03 && p.z > 0.6) diffuseColor.rgb *= 0.9;   // bonnet creases
      }
      if (k > 3.5 && k < 4.5) { if (n.y < 0.3 && fract(p.y * 7.0 + p.z * 2.0) < 0.12) diffuseColor.rgb += 0.12; } // glass glint
    }`);
};
const carMeshes = [];
function initCars(scene) {
  buildCarModels().forEach(geo => {
    const m = new THREE.InstancedMesh(geo, carMat, CAR_MAX);
    m.geometry.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(CAR_MAX * 3), 3));
    m.geometry.setAttribute('iVar', new THREE.InstancedBufferAttribute(new Float32Array(CAR_MAX), 1));
    m.count = 0; m.frustumCulled = false; scene.add(m); carMeshes.push(m);
  });
}
// cars of all loaded tiles: key -> Float32Array stride 6 (x, z, heading, type, colour, seed)
let dedupeVer = -1;
const carTiles = new Map(); let carDirty = true, carAt = { x: 1e9, z: 1e9 }, carVer = 0; // carVer: parked cars changed (app.js: cars as solid objects to jump on)
function setCarTile(key, arr) { if (arr && arr.length) carTiles.set(key, arr); else carTiles.delete(key); carDirty = true; carVer++; }
function dropCarTiles(prefix) { for (const k of [...carTiles.keys()]) if (k.startsWith(prefix)) { carTiles.delete(k); carDirty = true; carVer++; } }
const fract7 = v => v - Math.floor(v);
const _e = new THREE.Euler(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _up = new THREE.Vector3(0, 1, 0);
// called every frame; only re-sorts when the player moved 40 m or tiles changed
function updateCarInstances(px, pz) {
  if (!carMeshes.length || (!carDirty && Math.hypot(px - carAt.x, pz - carAt.z) < 40)) return;
  carDirty = false; carAt = { x: px, z: pz };
  /* Runde 110 (phone test: two parked cars inside each other): no parked car may overlap another one, whatever placed it
     (kerbside rows of neighbouring tiles, parking lots, the car the player parked). The player's own parked cars win, then the
     order of the tiles; an overlapping one is removed (type -1, like a car the player got into). */
  if (carVer !== dedupeVer) { dedupeVer = carVer; const grid = new Map(), keys = [...carTiles.keys()].sort((p, q) => (q === 'drv') - (p === 'drv')); let gone = 0;
    for (const k of keys) { const a = carTiles.get(k);
      for (let i = 0; i < a.length; i += 6) { if (a[i + 3] < 0) continue; const x = a[i], z = a[i + 1], h = a[i + 2], gx = Math.floor(x / 8), gz = Math.floor(z / 8); let hit = false;
        for (let u = -1; u <= 1 && !hit; u++) for (let v = -1; v <= 1 && !hit; v++) for (const q of grid.get((gx + u) * 100003 + gz + v) || []) {
          const ex = x - q[0], ez = z - q[1], fx = Math.sin(q[2]), fz = Math.cos(q[2]), al = Math.abs(ex * fx + ez * fz), la = Math.abs(ex * fz - ez * fx);
          const fx2 = Math.sin(h), fz2 = Math.cos(h), al2 = Math.abs(ex * fx2 + ez * fz2), la2 = Math.abs(ex * fz2 - ez * fx2);
          if ((al < 4.3 && la < 1.75) || (al2 < 4.3 && la2 < 1.75)) { hit = true; break; } }
        if (hit) { a[i + 3] = -1; gone++; continue; }
        const kk = gx * 100003 + gz; let l = grid.get(kk); if (!l) grid.set(kk, l = []); l.push([x, z, h]); } }
    if (gone) { carVer++; dedupeVer = carVer; } }
  const near = [], R2 = CAR_RADIUS * CAR_RADIUS;
  for (const a of carTiles.values()) for (let i = 0; i < a.length; i += 6) { const d = (a[i] - px) ** 2 + (a[i + 1] - pz) ** 2; if (d < R2) near.push(d, a, i); }
  const order = []; for (let i = 0; i < near.length; i += 3) order.push(i); order.sort((p, q) => near[p] - near[q]);
  const cnt = new Array(CAR_TYPES).fill(0);
  let total = 0;
  for (const o of order) {
    if (++total > CAR_TOTAL) break; // nearest first: on old phones at most ~900 cars (~400 k vertices)
    const a = near[o + 1], i = near[o + 2], t = a[i + 3] | 0, m = carMeshes[t]; if (!m || cnt[t] >= CAR_MAX) continue;
    // on a slope the car follows the road: pitch from the terrain in front/behind, roll from left/right (phone test: cars stood level on steep streets)
    const x = a[i], z = a[i + 1], hd = a[i + 2], fx = Math.sin(hd), fz = Math.cos(hd), rx = Math.cos(hd), rz = -Math.sin(hd);
    const hF = terrainH(x + fx * 1.9, z + fz * 1.9), hB = terrainH(x - fx * 1.9, z - fz * 1.9), hR = terrainH(x + rx * .85, z + rz * .85), hL = terrainH(x - rx * .85, z - rz * .85);
    if (t >= 8) _e.set(0, hd, 0, 'YXZ'); /* boats and aircraft stay level */ else _e.set(-Math.atan2(hF - hB, 3.8), hd, Math.atan2(hR - hL, 1.7), 'YXZ'); _q.setFromEuler(_e);
    const sd = a[i + 5] % 1; _s.set(.94 + .12 * fract7(sd * 3.7), .95 + .1 * fract7(sd * 5.3), .93 + .14 * fract7(sd * 9.1)); // every car a little different in size
    _p.set(x, (hF + hB + hR + hL) / 4 - (t >= 8 && t <= 10 ? WATER_DROP : 0), z); _m.compose(_p, _q, _s); m.setMatrixAt(cnt[t], _m); _s.set(1, 1, 1); // boats float on the lowered water
    m.geometry.attributes.iVar.setX(cnt[t], sd);
    const c = CAR_COLOURS[a[i + 4] | 0] || CAR_COLOURS[0], col = m.geometry.attributes.iCol; col.setXYZ(cnt[t], c.r, c.g, c.b); cnt[t]++;
  }
  carMeshes.forEach((m, t) => { m.count = cnt[t]; m.instanceMatrix.needsUpdate = true; m.geometry.attributes.iCol.needsUpdate = true; m.geometry.attributes.iVar.needsUpdate = true; });
}
