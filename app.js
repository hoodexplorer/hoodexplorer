/* HoodExplorer demo client: profile, rendering, controls, game loop. Data comes from worker.js. */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const R = 6378137;
const merc = (lat, lon) => ({ X: lon * Math.PI / 180 * R, Y: Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R });
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };

/* ================================================================ worker */
let worker = null, workerOrigin = null;
// terrain switch (settings): on by default; switching rebuilds the world
const WELD = new URLSearchParams(location.search).get('ecken') === 'geteilt'; // test variant: shared ground corners
// view distance (settings): 1 normal, 2 far, 3 very far - thinner fog and larger load radii in the worker (more data, more work on the phone)
const VIEW = (() => { try { const v = +localStorage.getItem('hx.view'); return v >= 1 && v <= 3 ? v : 1; } catch (e) { return 1; } })(), VIEW_FOG = [1, .62, .42][VIEW - 1];
const WELT = (() => { const q = new URLSearchParams(location.search).get('welt'); if (/^(heute|west|cyber|mittel)$/.test(q)) return q; // Runde 93: world switch (welten.js)
  try { const v = JSON.parse(localStorage.getItem('hx.welt')); return /^(west|cyber|mittel)$/.test(v) ? v : 'heute'; } catch (e) { return 'heute'; } })(); window.HX_WELT = WELT;
const TERRAIN = (() => { try { const v = JSON.parse(localStorage.getItem('hx.terrain')); return v === null ? true : !!v; } catch (e) { return true; } })();
// terrain heights, sent by the worker per Terrarium tile (zoom 13); heights relative to the start point, 0 without terrain
const TER = { tiles: new Map(), far: new Map(), h0: null, z: 13 };
// underpass troughs from the worker (see worker.js DIPS): [x, z, ux, uz, hw, F, R, D] each; keyed by tile, deduplicated on use
const DIPS_APP = new Map();
// bridge railings [x0, z0, x1, z1, offset] per tile: solid for whoever is up on the deck (phone test: walked through them)
const RAILS = new Map();
function railAt(x, z, y) {
  for (const a of RAILS.values()) for (let i = 0; i < a.length; i += 5) {
    const ax = a[i], az = a[i + 1], ex = a[i + 2] - ax, ez = a[i + 3] - az, L = Math.hypot(ex, ez); if (L < .1) continue;
    const s = ((x - ax) * ex + (z - az) * ez) / L; if (s < -.2 || s > L + .2) continue;
    const t = Math.abs(((x - ax) * ez - (z - az) * ex) / L); if (Math.abs(t - a[i + 4]) > .35) continue;
    if (y === undefined) return true; const sd = SPAN_APP.size ? spanDeck(x, z) : null, g = sd !== null ? sd : terrainRaw(x, z) + (ELEV_APP.size ? bridgeElev(x, z) : 0); if (y > g - 1.5 && y < g + 1.0) return true; } // on deck level and not jumping over it (railing .95 m)
  return false;
}
function dipInfo(x, z) { // depth of the trough here and whether a bridge deck may lie above (flat part)
  let m = 0, flat = false; for (const a of DIPS_APP.values()) for (let i = 0; i < a.length; i += 8) {
    const dx = x - a[i], dz = z - a[i + 1], sd = dx * a[i + 2] + dz * a[i + 3], s = Math.abs(sd), t = Math.abs(-dx * a[i + 3] + dz * a[i + 2]), F = a[i + 5];
    if (F < 0 && sd > 0) continue; // tunnel approach: one-sided, the ground over the tunnel stays (Runde 79)
    if (t > a[i + 4] || s >= Math.max(0, F) + a[i + 6]) continue; const v = s <= F ? a[i + 7] : a[i + 7] * (1 - (s - Math.max(0, F)) / a[i + 6]); if (v > m) { m = v; flat = s <= F; } }
  return m > 0 ? { d: m, flat } : null;
}
// sloped streets are level across (worker: corrSegs): same rule for walking and driving - corridor height = street axis height,
// 3 m embankment back to the terrain. Per tile a 24 m grid of segment indices.
const CORR_APP = new Map();
function corrIndex(a) { const grid = new Map(); for (let i = 0; i < a.length; i += 6) { const e = a[i + 4] + 3;
    for (let gx = Math.floor((Math.min(a[i], a[i + 2]) - e) / 24); gx <= Math.floor((Math.max(a[i], a[i + 2]) + e) / 24); gx++) for (let gz = Math.floor((Math.min(a[i + 1], a[i + 3]) - e) / 24); gz <= Math.floor((Math.max(a[i + 1], a[i + 3]) + e) / 24); gz++) { const k = gx * 100003 + gz; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i); } }
  return { a, grid }; }
function corrH(x, z) { // inside a levelled street: height of its axis, linear between the segment ends (same rule as the worker)
  if (!CORR_APP.size) return terrainRaw(x, z); const k = Math.floor(x / 24) * 100003 + Math.floor(z / 24); let best = null, bd = Infinity;
  for (const c of CORR_APP.values()) { const l = c.grid.get(k); if (!l) continue; const S = c.a;
    for (const i of l) { const x0 = S[i], z0 = S[i + 1], ex = S[i + 2] - x0, ez = S[i + 3] - z0, q = Math.max(0, Math.min(1, ((x - x0) * ex + (z - z0) * ez) / (ex * ex + ez * ez))), d = Math.hypot(x - x0 - ex * q, z - z0 - ez * q);
      if (d < S[i + 4] && d < bd && q > -.02 && q < 1.02) { bd = d; best = [x0, z0, S[i + 2], S[i + 3], Math.max(0, Math.min(1, q)), S[i + 5]]; } } }
  if (!best) return terrainRaw(x, z); const h0 = terrainRaw(best[0], best[1]), ax = h0 + (terrainRaw(best[2], best[3]) - h0) * best[4], kk = best[5];
  return kk >= 1 ? ax : ax * kk + terrainRaw(x, z) * (1 - kk);
}
// ground height; yRef = height of whoever stands there: under a bridge deck it picks the deck when coming from above, the trough below otherwise
/* shared height raster (worker buildDZ): height = terrain * (1 - W) + W * T on 4 m cells - the same function the ground is built from */
const DZ_APP = new Map();
function dzA(F, A, x, z) { const fx = (x - F.x0) / F.c, fz = (z - F.z0) / F.c, i = Math.floor(fx), j = Math.floor(fz); if (i < 0 || j < 0 || i >= F.nx - 1 || j >= F.nz - 1) return 0;
  const u = fx - i, v = fz - j, o = j * F.nx + i;
  if (u + v <= 1) { const a = A[o]; return a + (A[o + 1] - a) * u + (A[o + F.nx] - a) * v; }
  const d = A[o + F.nx + 1]; return d + (A[o + F.nx] - d) * (1 - u) + (A[o + 1] - d) * (1 - v); }
function dzH(x, z) { const h = terrainRaw(x, z); if (!DZ_APP.size) return h; let bw = 0, bf = null;
  for (const F of DZ_APP.values()) { const w = dzA(F, F.W, x, z); if (w > bw) { bw = w; bf = F; } }
  return bf ? h * (1 - bw) + dzA(bf, bf.WT, x, z) : h; }
/* raised bridge decks (worker Runde 51): segments x0, z0, x1, z1, half width, height above the terrain */
const ELEV_APP = new Map(), SPAN_APP = new Map(); // SPAN_APP (Runde 83): bridge decks spanning straight between their ends [x0, z0, x1, z1, half width, h0, h1]
function spanDeck(x, z) { let best = null, bd = Infinity; for (const a of SPAN_APP.values()) for (let i = 0; i < a.length; i += 7) { const ex = a[i + 2] - a[i], ez = a[i + 3] - a[i + 1], L2 = ex * ex + ez * ez || 1, q = Math.max(0, Math.min(1, ((x - a[i]) * ex + (z - a[i + 1]) * ez) / L2));
  const d = Math.hypot(x - a[i] - ex * q, z - a[i + 1] - ez * q), dd = d + (a[i + 4] < 0 ? 1000 : 0); if (d < Math.abs(a[i + 4]) && dd < bd) { bd = dd; best = a[i + 5] + (a[i + 6] - a[i + 5]) * q; } } return best; } // the nearest deck: parallel bridges (carriageway and slip road) overlap; Runde 87: a tile's own deck first, a neighbour's (half width < 0) only where none
function bridgeElev(x, z) { for (const a of ELEV_APP.values()) for (let i = 0; i < a.length; i += 6) { const ex = a[i + 2] - a[i], ez = a[i + 3] - a[i + 1], L2 = ex * ex + ez * ez || 1, q = Math.max(0, Math.min(1, ((x - a[i]) * ex + (z - a[i + 1]) * ez) / L2));
  if (Math.hypot(x - a[i] - ex * q, z - a[i + 1] - ez * q) < a[i + 4]) return a[i + 5]; } return 0; }
// bridge lines of the loaded tiles in 8 m cells (rebuilt when tiles change): the deck carries across a trough everywhere, not only over its flat middle
const BRL = { n: -1, g: new Map() }; let TILEVER = 0;
function onBridgeLine(x, z) {
  if (BRL.n !== TILEVER) { BRL.n = TILEVER; BRL.g.clear(); for (const t of tiles.values()) for (const r of t.roads || []) { if (!r.b) continue; const p = r.p;
      for (let i = 0; i + 3 < p.length; i += 2) { const s = [p[i], p[i + 1], p[i + 2], p[i + 3], r.w / 2 + .6]; for (let ix = Math.floor((Math.min(p[i], p[i + 2]) - 4) / 8); ix <= Math.floor((Math.max(p[i], p[i + 2]) + 4) / 8); ix++) for (let iz = Math.floor((Math.min(p[i + 1], p[i + 3]) - 4) / 8); iz <= Math.floor((Math.max(p[i + 1], p[i + 3]) + 4) / 8); iz++) { const k = ix * 100003 + iz; let l = BRL.g.get(k); if (!l) BRL.g.set(k, l = []); l.push(s); } } } }
  const l = BRL.g.get(Math.floor(x / 8) * 100003 + Math.floor(z / 8)); if (!l) return false;
  for (const s of l) { const ex = s[2] - s[0], ez = s[3] - s[1], L2 = ex * ex + ez * ez || 1, u = Math.max(0, Math.min(1, ((x - s[0]) * ex + (z - s[1]) * ez) / L2)); if (Math.hypot(s[0] + ex * u - x, s[1] + ez * u - z) < s[4]) return true; }
  return false; }

/* ================================================================ tunnels (Runde 80: "tunnels drivable, worked out automatically")
   The tunnel lines of the map (road tunnels from 30/80 m, see the portals of Runde 79) become a tube underground: floor 6 m below the
   ground at both ends of every piece, linear in between (the same height the approach trough reaches at the portal). Walls, ceiling and
   a row of lights are drawn by the game per tile; driving, walking and the autopilot follow the floor. Underground, houses do not block.
   In the diorama the tube and the car show through the ground while one is inside. */
const TUN = { segs: [], g: new Map(), ver: -1, meshes: new Map(), xray: false };
const TUN_D = 6, TUN_H = 5.2;
function tunGround(x, z) { return DZ_APP.size ? dzH(x, z) : corrH(x, z); }
function tunRebuild() { if (TUN.ver === TILEVER) return; TUN.ver = TILEVER; TUN.segs = []; TUN.g.clear();
  for (const [key, t] of tiles) for (const r of t.roads || []) { if (r.k !== 't' || r.rail) continue; const p0 = r.p, n = p0.length / 2; if (n < 2) continue;
    // both ends 10 m longer: the tube reaches into the approach trough (also where the portal moved back behind a street, Runde 79 R5)
    const p = Float32Array.from(p0), hasP = [false, false]; { const e = (i, j, w) => { const dx = p[i] - p[j], dz = p[i + 1] - p[j + 1], l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l; let ext = 10;
        // the portal of this end (a one-sided trough lying on in line, possibly moved back behind a street): the tube starts right there
        for (const a of DIPS_APP.values()) for (let q = 0; q < a.length; q += 8) { if (a[q + 5] >= 0) continue; const ox = a[q] - p[i], oz = a[q + 1] - p[i + 1], along = ox * ux + oz * uz, lat = Math.abs(-ox * uz + oz * ux);
          if (along > -12 && along < 70 && lat < a[q + 4] + 3 && -(a[q + 2] * ux + a[q + 3] * uz) > .85) { ext = Math.max(ext, along + 2); hasP[w] = true; } }
        if (!hasP[w]) { ext = 0; // no trough: an open end only where a surface street goes on - else a tile seam or the next tunnel piece (stays deep)
          let open = false; for (const t2 of tiles.values()) { for (const r2 of t2.roads || []) { if (r2.k !== 'm') continue; const q = r2.p; if (Math.hypot(q[0] - p[i], q[1] - p[i + 1]) < 8 || Math.hypot(q[q.length - 2] - p[i], q[q.length - 1] - p[i + 1]) < 8) { open = true; break; } } if (open) break; }
          if (!open) hasP[w] = true; }
        p[i] += ux * ext; p[i + 1] += uz * ext; }; e(0, 2, 0); e(p.length - 2, p.length - 4, 1); }
    let L = 0; const cum = [0]; for (let i = 0; i + 3 < p.length; i += 2) cum.push(L += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1])); if (L < 20) continue;
    if (r.ya === undefined) { r.ya = tunGround(p0[0], p0[1]) - TUN_D; r.yb = tunGround(p0[p0.length - 2], p0[p0.length - 1]) - TUN_D; }
    const hw = Math.min(r.w, 8) / 2 + 1.2, gA = terrainH(p[0], p[1]), gB = terrainH(p[p.length - 2], p[p.length - 1]); // the road height where the tube begins (also in a cutting)
    const fl = c => Math.max(r.ya + (r.yb - r.ya) * c / L, hasP[0] ? -1e9 : gA - .06 * c, hasP[1] ? -1e9 : gB - .06 * (L - c)); // Runde 80: no trough at an end -> a ramp inside the tube from ground level
    const sub = []; for (let i = 0; i + 3 < p.length; i += 2) { const sl = cum[i / 2 + 1] - cum[i / 2], m = Math.max(1, Math.ceil(sl / 10)); for (let k = 0; k < m; k++) { const t0 = k / m, t1 = (k + 1) / m;
        sub.push([p[i] + (p[i + 2] - p[i]) * t0, p[i + 1] + (p[i + 3] - p[i + 1]) * t0, p[i] + (p[i + 2] - p[i]) * t1, p[i + 1] + (p[i + 3] - p[i + 1]) * t1, fl(cum[i / 2] + sl * t0), fl(cum[i / 2] + sl * t1)]); } }
    for (const q of sub) { const s = [q[0], q[1], q[2], q[3], q[4], q[5], hw, key], i = 0;
      TUN.segs.push(s); for (let ix = Math.floor((Math.min(s[0], s[2]) - hw) / 16); ix <= Math.floor((Math.max(s[0], s[2]) + hw) / 16); ix++) for (let iz = Math.floor((Math.min(s[1], s[3]) - hw) / 16); iz <= Math.floor((Math.max(s[1], s[3]) + hw) / 16); iz++) { const k = ix * 100003 + iz; let l = TUN.g.get(k); if (!l) TUN.g.set(k, l = []); l.push(s); } } }
  tunMeshes(); }
function tunnelFloor(x, z) { // floor height of a tunnel tube here, or null
  if (TUN.ver !== TILEVER) tunRebuild(); const l = TUN.g.get(Math.floor(x / 16) * 100003 + Math.floor(z / 16)); if (!l) return null; let best = null, bd = Infinity;
  for (const s of l) { const ex = s[2] - s[0], ez = s[3] - s[1], L2 = ex * ex + ez * ez || 1, u = Math.max(0, Math.min(1, ((x - s[0]) * ex + (z - s[1]) * ez) / L2)), d = Math.hypot(s[0] + ex * u - x, s[1] + ez * u - z);
    if (d < s[6] && d < bd) { bd = d; best = s[4] + (s[5] - s[4]) * u; } }
  return best; }
function underground(x, z, y) { const f = tunnelFloor(x, z); return f !== null && y < f + TUN_H - .5; }
const tunMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }), tunCeilMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
function tunMeshes() { // one mesh per tile: floor, walls, lights (+ ceiling apart: hidden in the x-ray view)
  const byKey = new Map(); for (const s of TUN.segs) { let l = byKey.get(s[7]); if (!l) byKey.set(s[7], l = []); l.push(s); }
  for (const [k, m] of TUN.meshes) if (!byKey.has(k)) { for (const o of m) { scene.remove(o); o.geometry.dispose(); } TUN.meshes.delete(k); }
  for (const [k, l] of byKey) { if (TUN.meshes.has(k)) continue; const P = [], C = [], Pc = [], Cc = [];
    const quad = (A, B, Cq, Dq, col, PP = P, CC = C) => { PP.push(...A, ...B, ...Cq, ...A, ...Cq, ...Dq); for (let i = 0; i < 6; i++) CC.push(...col); };
    for (const s of l) { const ex = s[2] - s[0], ez = s[3] - s[1], L = Math.hypot(ex, ez) || 1, nx = -ez / L * s[6], nz = ex / L * s[6];
      const a0 = [s[0] - nx, s[4], s[1] - nz], a1 = [s[0] + nx, s[4], s[1] + nz], b0 = [s[2] - nx, s[5], s[3] - nz], b1 = [s[2] + nx, s[5], s[3] + nz], up = v => [v[0], v[1] + TUN_H, v[2]];
      quad(a0, b0, b1, a1, [.19, .2, .22]);                                   // floor (asphalt)
      quad(a0, up(a0), up(b0), b0, [.55, .55, .52]); quad(a1, b1, up(b1), up(a1), [.5, .5, .47]); // walls, both faces drawn below
      quad(b0, up(b0), up(a0), a0, [.55, .55, .52]); quad(b1, a1, up(a1), up(b1), [.5, .5, .47]);
      quad(up(a0), up(a1), up(b1), up(b0), [.24, .25, .27], Pc, Cc); quad(up(a0), up(b0), up(b1), up(a1), [.24, .25, .27], Pc, Cc); // ceiling
      for (let q = 6; q < L; q += 12) { const t = q / L, cx = s[0] + ex * t, cz = s[1] + ez * t, cy = s[4] + (s[5] - s[4]) * t + TUN_H - .05, ux = ex / L * .7, uz = ez / L * .7, vx = -ez / L * .25, vz = ex / L * .25; // light strips
        quad([cx - ux - vx, cy, cz - uz - vz], [cx + ux - vx, cy, cz + uz - vz], [cx + ux + vx, cy, cz + uz + vz], [cx - ux + vx, cy, cz - uz + vz], [1, .9, .62]);
        quad([cx - ux - vx, cy, cz - uz - vz], [cx - ux + vx, cy, cz - uz + vz], [cx + ux + vx, cy, cz + uz + vz], [cx + ux - vx, cy, cz + uz - vz], [1, .9, .62]); }
      for (let q = 3; q < L; q += 9) { const t = q / L, t2 = Math.min(1, (q + 3) / L), y1 = s[4] + (s[5] - s[4]) * t + .02, y2 = s[4] + (s[5] - s[4]) * t2 + .02; // dashed middle line
        const x1 = s[0] + ex * t, z1 = s[1] + ez * t, x2 = s[0] + ex * t2, z2 = s[1] + ez * t2, wx = -ez / L * .08, wz = ex / L * .08;
        quad([x1 - wx, y1, z1 - wz], [x2 - wx, y2, z2 - wz], [x2 + wx, y2, z2 + wz], [x1 + wx, y1, z1 + wz], [.85, .85, .8]); } }
    const mk = (PP, CC, mat) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(PP, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(CC, 3)); g.computeBoundingSphere(); const m = new THREE.Mesh(g, mat); m.renderOrder = 4; scene.add(m); return m; };
    TUN.meshes.set(k, [mk(P, C, tunMat), mk(Pc, Cc, tunCeilMat)]); } }
// x-ray in the diorama: while the figure or the car is underground, the tube (without ceiling) and the car/figure show through the ground
let carXrayMat = null;
function tunXray() { const yy = DRV.on ? DV.y : P.y, xx = DRV.on ? DV.x : P.x, zz = DRV.on ? DV.z : P.z, on = camMode === 'dio' && TUN.segs.length > 0 && underground(xx, zz, yy);
  if (on === TUN.xray) return; TUN.xray = on; tunMat.depthTest = !on; tunMat.needsUpdate = true; tunCeilMat.visible = !on;
  if (DRV.mesh && DRV.car && DRV.car.fz === undefined) { if (!carXrayMat) { carXrayMat = carMat.clone(); carXrayMat.onBeforeCompile = carMat.onBeforeCompile; carXrayMat.depthTest = false; } DRV.mesh.material = on ? carXrayMat : carMat; DRV.mesh.renderOrder = on ? 6 : 0; }
  player.traverse(o => { if (o.isMesh) { if (!o.userData.mat0) o.userData.mat0 = o.material; if (on) { o.material = o.userData.mat0.clone(); o.material.depthTest = false; } else o.material = o.userData.mat0; o.renderOrder = on ? 6 : 0; } }); }
setInterval(() => { if (started) { tunRebuild(); tunXray(); } }, 250);
function terrainH(x, z, yRef) {
  if (yRef !== undefined && TUN.segs.length) { const tf = tunnelFloor(x, z); if (tf !== null && yRef < tf + TUN_H - .5) return tf; } // in a tunnel tube: its floor (Runde 80)
  const h0 = DZ_APP.size ? dzH(x, z) : corrH(x, z), el = ELEV_APP.size && yRef !== undefined ? bridgeElev(x, z) : 0;
  { let best = null; if (el > 0) { const deck = terrainRaw(x, z) + el; if (yRef > deck - 2) best = deck; } // Runde 87: end deck and spanning deck both here (a bridge end inside a longer structure): the one nearest to the car
    if (yRef !== undefined && SPAN_APP.size) { const sd = spanDeck(x, z); if (sd !== null && yRef > sd - 2 && (best === null || Math.abs(sd - yRef) < Math.abs(best - yRef))) best = sd; }
    if (best !== null) return best; } // on a spanning deck (Runde 83) // on the raised deck when coming from above (the ramp), the street below otherwise; deck = natural terrain + 5.5 m (Runde 79)
  const h = h0; if (!DIPS_APP.size) return h;
  const di = dipInfo(x, z); if (!di) return h;
  if (yRef !== undefined && yRef > h - di.d * .5 && onBridgeLine(x, z)) return h; // Runde 79: on any bridge over a trough (also beside its flat middle)
  return di.flat && yRef !== undefined && yRef > h - di.d * .5 ? h : h - di.d;
}
function terrainRaw(x, z) {
  if (!TERRAIN || TER.h0 === null || !O) return 0;
  const X = x / O.c + O.X0, Y = -z / O.c + O.Y0, n = (1 << TER.z) * 256, px = (X + Math.PI * R) / (2 * Math.PI * R) * n - .5, py = (Math.PI * R - Y) / (2 * Math.PI * R) * n - .5;
  const ix = Math.floor(px), iy = Math.floor(py), u = px - ix, v = py - iy;
  const g = (a, b) => { const t = TER.tiles.get(Math.floor(a / 256) + '_' + Math.floor(b / 256)); return t ? t[(b & 255) * 256 + (a & 255)] : null; };
  const A = g(ix, iy), B = g(ix + 1, iy), C = g(ix, iy + 1), D = g(ix + 1, iy + 1);
  if (A === null || B === null || C === null || D === null) return A !== null ? A - TER.h0 : 0;
  return (A * (1 - u) + B * u) * (1 - v) + (C * (1 - u) + D * u) * v - TER.h0;
}
window.terrainH = terrainH; // used by cars.js
function farH(x, z) { // coarse terrain (zoom 11) for the distant hills
  if (TER.h0 === null || !O) return null;
  const X = x / O.c + O.X0, Y = -z / O.c + O.Y0, n = (1 << 11) * 256, px = (X + Math.PI * R) / (2 * Math.PI * R) * n - .5, py = (Math.PI * R - Y) / (2 * Math.PI * R) * n - .5;
  const ix = Math.floor(px), iy = Math.floor(py), u = px - ix, v = py - iy;
  const g = (a, b) => { const t = TER.far.get(Math.floor(a / 256) + '_' + Math.floor(b / 256)); return t ? t[(b & 255) * 256 + (a & 255)] : null; };
  const A = g(ix, iy), B = g(ix + 1, iy), C = g(ix, iy + 1), D = g(ix + 1, iy + 1);
  if (A === null || B === null || C === null || D === null) return null;
  return (A * (1 - u) + B * u) * (1 - v) + (C * (1 - u) + D * u) * v - TER.h0;
}
// far view: one coarse terrain mesh (~110 m cells, up to ~4 km) with the same hillshade, cut out where detailed tiles are loaded
let farMesh = null, farDirty = false, farAt = null;
// own light haze instead of the dense fog: distant hills fade only partly into the fog colour (aerial perspective)
const farMat = new THREE.ShaderMaterial({
  uniforms: { uLight: spriteUniforms.uLight, uHaze: spriteUniforms.uFogColor, uPlayer: spriteUniforms.uPlayer },
  vertexColors: true,
  vertexShader: 'uniform vec3 uPlayer; varying vec3 vC; varying float vD; void main(){ vC = color; vD = distance(position.xz, uPlayer.xz); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', // haze by distance from the player (the iso camera is far away)
  fragmentShader: 'uniform vec3 uLight, uHaze; varying vec3 vC; varying float vD; void main(){ vec3 c = vC * uLight * 0.9; gl_FragColor = vec4(mix(c, uHaze, 0.25 + 0.45 * smoothstep(250.0, 4500.0, vD)), 1.0); }'
});
let FARPEND = false; setInterval(() => { if (FARPEND) { FARPEND = false; farDirty = true; } }, 700); // blocks arrive one by one: refit the far terrain now and then
function updateFar() {
  if (!TERRAIN || !TER.far.size || TER.h0 === null) return;
  if (!farDirty && farAt && Math.hypot(P.x - farAt.x, P.z - farAt.z) < 400) return;
  farDirty = false; const N = 72, S = 112, ox = Math.round(P.x / S) * S - N / 2 * S, oz = Math.round(P.z / S) * S - N / 2 * S; farAt = { x: P.x, z: P.z };
  // one box per tile (the union of its 128 m blocks): with the blocks (Runde 41) this compared every grid point with ~1100 boxes,
  // 60-110 ms on every new tile = the stutter on fast drives (Runde 56)
  /* Runde 76 (phone, fast on the motorway: sky through the ground): the boxes were the union of a tile's blocks built so far - with only
     its corner blocks there, the whole tile counted as covered and the far terrain left a hole where blocks were still missing.
     Now per 128 m block, looked up in a grid: a far cell goes only where built blocks cover all of it */
  const BG = new Map(), bk2 = (x, z) => Math.floor(x / 128) * 100003 + Math.floor(z / 128);
  for (const [k, m] of meshes) if (/^m:[^:#]+(#\d+)?$/.test(k)) { const b = m.geometry.boundingBox || (m.geometry.computeBoundingBox(), m.geometry.boundingBox);
    for (let ix = Math.floor(b.min.x / 128); ix <= Math.floor(b.max.x / 128); ix++) for (let iz = Math.floor(b.min.z / 128); iz <= Math.floor(b.max.z / 128); iz++) { const q = ix * 100003 + iz; let l = BG.get(q); if (!l) BG.set(q, l = []); l.push(b); } }
  const inB = (x, z) => { const l = BG.get(bk2(x, z)); return !!l && l.some(b => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z); };
  const boxes = { some: f => false };
  const inside = (x, z) => inB(x, z) && inB(x - S / 2 + 6, z - S / 2 + 6) && inB(x + S / 2 - 6, z - S / 2 + 6) && inB(x - S / 2 + 6, z + S / 2 - 6) && inB(x + S / 2 - 6, z + S / 2 - 6);
  const H = new Float32Array((N + 1) * (N + 1)); let ok = 0;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const h = farH(ox + i * S, oz + j * S); H[j * (N + 1) + i] = h === null ? NaN : h - 1.2 - (inB(ox + i * S, oz + j * S) ? 30 : 0); if (h !== null) ok++; } // corners under a loaded tile dive 30 m: the coarse far ground never shows through the fine ground or the lowered water (phone test Hamburg)
  if (!ok) return;
  const pos = [], col = [], L = new THREE.Vector3(-0.55, 0.7, -0.45).normalize(), G = new THREE.Color(WELT === 'west' ? '#d8ad74' : WELT === 'cyber' ? '#101018' : '#86a060'), tmp = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const tri = (a, b, c) => {
    if ([a, b, c].some(p => isNaN(p[1]))) return;
    e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]); e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]); tmp.crossVectors(e1, e2).normalize(); if (tmp.y < 0) tmp.negate();
    const sh = Math.max(0.55, Math.min(1.3, 1 + Math.round((tmp.dot(L) - L.y) * 2.6 / 0.06) * 0.06));
    for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); col.push(G.r * sh, G.g * sh, G.b * sh); }
  };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x0 = ox + i * S, z0 = oz + j * S; if (inside(x0 + S / 2, z0 + S / 2)) continue;
    const p = (a, b) => [ox + a * S, H[b * (N + 1) + a], oz + b * S];
    tri(p(i, j), p(i, j + 1), p(i + 1, j)); tri(p(i + 1, j), p(i, j + 1), p(i + 1, j + 1));
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
  if (farMesh) { scene.remove(farMesh); farMesh.geometry.dispose(); }
  farMesh = new THREE.Mesh(g, farMat); farMesh.position.y = -3; farMesh.updateMatrix(); farMesh.matrixAutoUpdate = false; farMesh.renderOrder = -2; scene.add(farMesh); // 3 m lower: never covers the lowered water of near tiles (phone test: meadow over a harbour basin)
}
function makeWorker(lat, lon) {
  if (worker && workerOrigin && workerOrigin.lat === lat && workerOrigin.lon === lon) return;
  if (worker) worker.terminate();
  worker = new Worker('worker.js?v=644' + (self.HX_AUSFALL ? '&ausfall=' + encodeURIComponent(new URLSearchParams(location.search).get('ausfall')) : '') + (new URLSearchParams(location.search).get('sonder') === '0' ? '&sonder=0' : '')); /* Runde 208: ?sonder=0 = landmark models off (comparison) */ // Runde 120: simulated outages reach the worker too
  worker.onmessage = onData;
  workerOrigin = { lat, lon };
  worker.postMessage({ type: 'prefetch', lat, lon, terrain: TERRAIN, weld: WELD });
}

/* ================================================================ profile */
let profile = store.get('hx.profile');
const qs = new URLSearchParams(location.search);
if (qs.get('lat') && qs.get('lon')) profile = Object.assign({}, profile || {}, { lat: +qs.get('lat'), lon: +qs.get('lon'), label: 'Link-Position' });
let chosen = profile && profile.lat ? { lat: profile.lat, lon: profile.lon, label: profile.label } : null;
// check mode: ?lat=..&lon=..&blick=<degrees, 0 = north>&neigung=<degrees up> shows a street-level view at exactly that point, without HUD,
// to put next to a street photo of the same place
const PRUEF = qs.has('blick') ? +qs.get('blick') : null;
// isometric check mode: ?lat=..&lon=..&iso=<heading in degrees, 0 = looking north>&zoom=<half view height in m>, for comparing with an oblique aerial view
const ISO = qs.has('iso') ? +qs.get('iso') : null;
let isoPitch = qs.has('kipp') ? Math.min(89.5, +qs.get('kipp')) * Math.PI / 180 : .62; // &kipp=90 looks straight down (compare with satellite images)

function showChosen() {
  const el = $('pChosen');
  if (chosen) { el.textContent = 'Start: ' + chosen.label; el.classList.add('ok'); $('pGo').disabled = false; makeWorker(chosen.lat, chosen.lon); }
  else { el.textContent = 'Noch kein Startpunkt gewählt'; el.classList.remove('ok'); $('pGo').disabled = true; }
}
function openProfile() {
  $('profile').hidden = false; $('loader').hidden = true; $('sheet').hidden = true; $('pClose').hidden = !started;
  $('pName').value = (profile && profile.name) || ''; showChosen();
}
$('pGeo').addEventListener('click', () => {
  if (!navigator.geolocation || !window.isSecureContext) { $('pChosen').textContent = 'Standort geht hier nicht (braucht HTTPS). Bitte suche deinen Ort.'; return; }
  $('pChosen').textContent = 'Suche deinen Standort …';
  navigator.geolocation.getCurrentPosition(p => {
    chosen = { lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6), label: 'Mein Standort (' + p.coords.latitude.toFixed(4) + ', ' + p.coords.longitude.toFixed(4) + ')' }; showChosen();
  }, err => { $('pChosen').textContent = err.code === 1 ? 'Standort wurde nicht freigegeben. Bitte suche deinen Ort.' : 'Standort nicht gefunden. Bitte suche deinen Ort.'; },
  { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
});
/* Runde 115 (phone test: the place search hung at "Suche …"): fetch with a time limit; if Nominatim does not answer in time,
   fails or finds nothing, Photon (komoot, also OpenStreetMap data) is asked. Results as [{ name, lat, lon }]. */
async function geocode(q, near) {
  const get = async (url, ms) => { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); } finally { clearTimeout(t); } };
  try { const vb = near ? '&viewbox=' + (near[1] - .3) + ',' + (near[0] + .2) + ',' + (near[1] + .3) + ',' + (near[0] - .2) : '';
    const j = await get('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=de' + vb + '&q=' + encodeURIComponent(q), 7000);
    if (j.length) return j.map(it => ({ name: it.display_name, lat: +it.lat, lon: +it.lon })); } catch (e) {}
  const j = await get('https://photon.komoot.io/api/?limit=6&lang=de' + (near ? '&lat=' + near[0] + '&lon=' + near[1] : '') + '&q=' + encodeURIComponent(q), 9000);
  return (j.features || []).map(f => { const p = f.properties || {}, c = f.geometry.coordinates;
    const name = [p.name, [p.street, p.housenumber].filter(Boolean).join(' '), [p.postcode, p.city || p.town || p.village].filter(Boolean).join(' '), p.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    return { name: name || q, lat: c[1], lon: c[0] }; });
}
$('pSearch').addEventListener('submit', async e => {
  e.preventDefault(); const q = $('pQuery').value.trim(); if (!q) return;
  const box = $('pResults'); box.textContent = 'Suche …';
  try {
    const j = await geocode(q); box.textContent = '';
    if (!j.length) { box.textContent = 'Nichts gefunden.'; return; }
    for (const it of j) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = it.name;
      b.addEventListener('click', () => { chosen = { lat: +it.lat.toFixed(6), lon: +it.lon.toFixed(6), label: it.name.split(',').slice(0, 3).join(',') }; box.textContent = ''; showChosen(); });
      box.appendChild(b);
    }
  } catch (err) { box.textContent = ''; boxMsg(box, 'Suche gerade nicht erreichbar.'); }
});
document.querySelectorAll('.places .pl[data-lat]').forEach(b => b.addEventListener('click', () => { chosen = { lat: +b.dataset.lat, lon: +b.dataset.lon, label: b.dataset.label }; showChosen(); }));
$('pClose').addEventListener('click', () => { $('profile').hidden = true; }); // Runde 115: close the profile without changing anything
$('pGo').addEventListener('click', () => {
  if (!chosen) return;
  const changed = !profile || profile.lat !== chosen.lat || profile.lon !== chosen.lon;
  profile = { name: $('pName').value.trim(), lat: chosen.lat, lon: chosen.lon, label: chosen.label };
  store.set('hx.profile', profile); store.set('hx.lastPos', null); // new start point: the last position no longer applies
  if (started && changed) { location.href = location.pathname; return; }
  $('profile').hidden = true;
  if (!started) start();
});

/* ================================================================ renderer */
const view = $('view');
/* Runde 129: 'high-performance' (was 'low-power': on laptops with two GPUs the browser took the weak built-in one) */
const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(1); // Runde 129: the canvas holds one pixel per block (see makeRT), CSS scales it up sharp
const hasDepth = renderer.capabilities.isWebGL2 || !!renderer.extensions.get('WEBGL_depth_texture');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#a8c8e0');
scene.fog = new THREE.FogExp2(0xc4d6e2, .006);
const camera = new THREE.PerspectiveCamera(46, 1, .5, 5000); // far: distant hills of the terrain view
const iso = new THREE.OrthographicCamera(-1, 1, 1, -1, 40, 4500); // camera 1200 m away (wide zooms never clip); orthographic depth is linear, the long range costs no precision // true isometric view, rotatable in 45° steps
let cam = camera, isoZoom = store.get('hx.zoom') || 30, dioYaw = Math.PI * 1.25, dioTarget = dioYaw;
function fitIso() { const a = camera.aspect || 1; iso.top = isoZoom; iso.bottom = -isoZoom; iso.left = -isoZoom * a; iso.right = isoZoom * a; iso.updateProjectionMatrix(); }
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, .6); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, .9); scene.add(sun); scene.add(sun.target);
const pLight = new THREE.PointLight(0xffd28a, 0, 26, 2); /* Runde 102: not added to the scene any more - Lambert lights per vertex, so on the big ground
   triangles the lantern drew sharp triangles of light (phone test, night). Its light is added per pixel instead (hxLamp below). */
const HXL = { uHxLP: { value: [new THREE.Vector3(0, -999, 0), new THREE.Vector3(0, -999, 0)] }, uHxLC: { value: [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)] }, uHxLR: { value: [26, 26] } };
function hxLamp(sh) { // two point lamps computed per pixel: 0 = the figure's lantern, 1 = blue light of the own emergency vehicle (traffic.js)
  sh.uniforms.uHxLP = HXL.uHxLP; sh.uniforms.uHxLC = HXL.uHxLC; sh.uniforms.uHxLR = HXL.uHxLR;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vHxLW;').replace('#include <project_vertex>', '#include <project_vertex>\n{ vec4 hxLw = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\nhxLw = instanceMatrix * hxLw;\n#endif\nvHxLW = (modelMatrix * hxLw).xyz; }');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vHxLW; uniform vec3 uHxLP[2]; uniform vec3 uHxLC[2]; uniform float uHxLR[2];')
    .replace('#include <envmap_fragment>', 'for (int hxi = 0; hxi < 2; hxi++) { float hxa = clamp(1.0 - length(vHxLW - uHxLP[hxi]) / uHxLR[hxi], 0.0, 1.0); outgoingLight += diffuseColor.rgb * uHxLC[hxi] * hxa * hxa; }\n#include <envmap_fragment>'); }
function withLamp(mat) { const f = mat.onBeforeCompile; mat.onBeforeCompile = sh => { if (f) f(sh); hxLamp(sh); }; }

const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true });
// squares and pedestrian zones: a paving pattern drawn in the shader (no extra geometry); recognised by their sand colour
groundMat.onBeforeCompile = sh => {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;').replace('#include <color_fragment>', `#include <color_fragment>
    { vec3 pc = normalize(vec3(0.761, 0.71, 0.612)), c = normalize(diffuseColor.rgb + 1e-4);
      if (dot(pc, c) > 0.9995) { // plaza: 1.2 m stone slabs in a running bond, joints and a slight tone per slab
        vec2 g = vGW.xz / vec2(1.2, 0.8); g.x += mod(floor(g.y), 2.0) * 0.5;
        vec2 f = fract(g), w = fwidth(g) * 1.2;
        float joint = (f.x < w.x || f.y < w.y) ? 0.86 : 1.0, tone = 0.95 + 0.08 * fract(sin(dot(floor(g), vec2(12.9, 78.2))) * 43758.5);
        diffuseColor.rgb *= joint * tone;
      } }`);
};
groundMat.extensions = { derivatives: true };
/* Water: one material per map tile with the tile's shore field (distance to the shore, hard or natural shore; 2 m raster).
   Pixel-art water from it: depth bands with dithered edges, waves rolling towards natural banks, foam at the waterline,
   the dark shadow strip of quay walls, short glints on open water, a slow swell. All in this one shader pass. */
const waterTime = { value: 0 }, waterRain = { value: 0 }; // Runde 181: rain rings on the water
const waterIce = { value: new THREE.Vector2() }; // Runde 143: x = frozen (0..1, from the shore outwards), y = snow lying on the ice (wetter.js)
// caustics (video "pixel art water"): a small tiling cell texture instead of a formula - bright lines where two cells meet
const causticTex = (() => { const S = 64, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d'), img = g.createImageData(S, S);
  let sd = 5; const rnd = () => { sd = (sd * 16807) % 2147483647; return (sd - 1) / 2147483646; }; const pts = []; for (let i = 0; i < 11; i++) pts.push([rnd() * S, rnd() * S]);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { let d1 = 1e9, d2 = 1e9;
    for (const [px, py] of pts) for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) { const d = Math.hypot(x - px - u * S, y - py - v * S); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
    const e = d2 - d1 < 1.6 ? 255 : d2 - d1 < 3 ? 120 : 0, o = (y * S + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = e; img.data[o + 3] = 255; }
  g.putImageData(img, 0, 0); const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return t; })();
function waterMat(f) {
  const tex = new THREE.DataTexture(f.data, f.w, f.h, THREE.LuminanceAlphaFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
  const ftex = new THREE.DataTexture(f.flow || new Uint8Array(f.w * f.h * 2).fill(128), f.w, f.h, THREE.LuminanceAlphaFormat, THREE.UnsignedByteType); // Runde 181: flow direction (x, z)
  ftex.magFilter = ftex.minFilter = THREE.NearestFilter; ftex.generateMipmaps = false; ftex.needsUpdate = true;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true }); mat.uniforms_tex = tex;
  mat.customProgramCacheKey = () => 'hxwater';
  mat.onBeforeCompile = sh => {
    sh.uniforms.uField = { value: tex }; sh.uniforms.uB = { value: new THREE.Vector4(f.x0, f.z0, f.w * f.c, f.h * f.c) }; sh.uniforms.uTime = waterTime; sh.uniforms.uCaus = { value: causticTex }; sh.uniforms.uIce = waterIce; sh.uniforms.uFlow = { value: ftex }; sh.uniforms.uRain = waterRain;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGW; uniform sampler2D uField, uCaus, uFlow; uniform vec4 uB; uniform float uTime, uRain; uniform vec2 uIce;' +
      '\nfloat wvn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); float a = fract(sin(dot(i, vec2(12.7, 71.3))) * 4375.5), b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(12.7, 71.3))) * 4375.5),' +
      ' c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(12.7, 71.3))) * 4375.5), e = fract(sin(dot(i + vec2(1.0, 1.0), vec2(12.7, 71.3))) * 4375.5); return mix(mix(a, b, f.x), mix(c, e, f.x), f.y); }' +
      '\nfloat flowCaus(vec2 q, vec2 fv, float t, float sc, float L) { float p1 = fract(t * .08), p2 = fract(t * .08 + .5), w1 = 1.0 - abs(2.0 * p1 - 1.0);' + // flow map: two phases crossfaded, so the drift never tears
      ' return texture2D(uCaus, (q - fv * p1 * L) / sc).r * w1 + texture2D(uCaus, (q - fv * p2 * L + 13.0) / sc).r * (1.0 - w1); }').replace('#include <color_fragment>', `#include <color_fragment>
    { vec2 uv0 = (vGW.xz - uB.xy) / uB.zw;
      // each tile draws its water only inside its own shore field: the strip beyond (map-data buffer) read the clamped edge as 'shore',
      // lay foamy over the neighbour's water at the same height and flickered (phone test, Trave bridge)
      if (uv0.x < 0.0 || uv0.y < 0.0 || uv0.x > 1.0 || uv0.y > 1.0) discard;
      vec2 uv = uv0; vec2 fl = texture2D(uField, uv).ra;
      float d = fl.x * 63.75, hard = fl.y, t = uTime;
      vec2 fv = texture2D(uFlow, uv).ra * 2.0 - 1.0; float fln = length(fv); if (fln < .25) { fv = vec2(0.0); fln = 0.0; } // Runde 181: flow of rivers and streams (0 on lakes)
      vec2 px = floor(vGW.xz * 2.0); float n = fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453);
      vec3 b = diffuseColor.rgb;                          // tone of this kind of water (river grey-green, lake blue, harbour dark)
      vec3 deep = b * .66, mid = b * .86, shal = b * 1.1 + vec3(.02, .07, .05), lite = b * 1.28 + vec3(.05, .11, .08), foam = vec3(.90, .96, .95);
      float dd = d + (n - .5) * 1.4 + hard * 7.0;          // dithered band edges; at quay walls the water is deep right away (Landungsbruecken)
      vec3 c = dd < 2.2 ? lite : dd < 6.5 ? shal : dd < 15.0 ? mid : deep;
      // 1 the bottom shows through in the shallows (natural banks): sand and pebbles, tinted by the water, fading with depth;
      //   shifted by a pixel or two with the waves (refraction)
      if (hard < .5 && d < 6.5) {
        vec2 bp = vGW.xz + vec2(sin(t * 1.6 + vGW.z * 1.7) * .2, cos(t * 1.3 + vGW.x * 1.5) * .12);
        vec2 bc = floor(bp * 3.0); float h1 = fract(sin(dot(bc, vec2(41.3, 289.1))) * 43758.5), h2 = fract(sin(dot(floor(bp * .9), vec2(17.1, 31.7))) * 43758.5);
        vec3 bed = h1 > .8 ? vec3(.30, .29, .26) : h1 > .66 ? vec3(.50, .46, .38) : (h1 > .56 && d > 1.2) ? vec3(.20, .34, .19) : mix(vec3(.76, .70, .52), vec3(.58, .60, .44), h2); // stones, pebbles, seaweed, sand
        bed *= mix(vec3(1.0), b * 1.9, .55);
        float vis = (1.0 - smoothstep(0.0, 6.5, d)) * .75;
        c = mix(c, bed, vis);
      }
      // 2 caustics: a thin, moving net of light on the shallow bottom (20-40 %)
      if (d < 8.0) {
        vec2 q = floor(vGW.xz * 3.0) / 3.0;                 // on the pixel grid (video: pixelate the distortion)
        float cv = fln > 0.0 ? min(flowCaus(q + vec2(t * .15, t * .09), fv, t, 7.0, 9.0), flowCaus(q - vec2(t * .15, -t * .1), fv, t, 9.0, 12.0)) // drifting downstream
                             : min(texture2D(uCaus, q / 7.0 + vec2(t * .021, t * .013)).r, texture2D(uCaus, q / 9.0 - vec2(t * .017, -t * .011)).r);
        if (cv > .3) c = mix(c, vec3(.88, 1.0, .96), cv * .62 * (1.0 - d / 8.0) * (1.0 - hard * .5));
      }
      // Runde 181: current - short light streaks drifting downstream in lanes (rivers and streams), and on open water a large, slow
      //   third Voronoi layer (soft light cell edges) so wide water is not one flat tone; it drifts with the current too
      if (fln > 0.0 && d > 1.5) { vec2 fd = fv / fln, pd = vec2(-fd.y, fd.x), pp = floor(vGW.xz * 2.0) / 2.0;
        float s = dot(pp, fd), a = dot(pp, pd), lane = floor(a * 1.2), hl = fract(sin(lane * 12.9898) * 43758.5);
        float seg = s * .18 - t * (.2 + hl * .12) + hl * 7.0, sid = floor(seg), sh2 = fract(sin((lane * 31.7 + sid) * 3.1) * 4375.5);
        if (sh2 > .62 && fract(seg) < .22) c = mix(c, lite * 1.06 + vec3(.04), .32); }
      float bigNet = 0.0; // Runde 185 (phone test: not visible): two large Voronoi layers drifting against each other - a clear net of light lines; drawn after the sky reflection
      if (d > 5.0) { vec2 qq = floor(vGW.xz * 1.5) / 1.5;
        bigNet = fln > 0.0 ? min(flowCaus(qq + vec2(t * .25, -t * .2), fv, t, 26.0, 14.0), flowCaus(qq - vec2(t * .2, -t * .3), fv, t, 33.0, 18.0))
                           : min(texture2D(uCaus, qq / 26.0 + vec2(t * .009, -t * .006)).r, texture2D(uCaus, qq / 33.0 - vec2(t * .007, t * .008)).r);
        bigNet *= smoothstep(5.0, 9.0, d); }
      // 3 reflection of the bank in broken pixel rows (vegetation at natural banks, the wall at quays)
      { float row = floor(vGW.z * 2.0), sh = sin(row * 1.7 + t * 1.3) * .35;
        if (hard < .5 && d + sh > 1.0 && d + sh < 3.2) c = mix(c, vec3(.17, .27, .16), .42);
        if (hard > .5 && d + sh > 1.3 && d + sh < 3.4) c = mix(c, vec3(.33, .32, .30), .3); }
      if (hard > .5) {
        if (d < 1.3) c = mid * .58;                         // shadow of the quay wall
        else if (d < 1.65 && fract(vGW.x * .7 + vGW.z * .7 + floor(t * 2.0) * .37) < .55) c = mix(c, foam, .55); // broken light line where water meets the wall
        else if (d < 2.0 && fract(t * .6 + n * .3) > .55) c = mix(c, foam, .45); // little slaps against the wall
      } else {
        /* Runde 181: waves run in irregularly (speed, phase and reach vary along the shore), break into foam at the waterline and the
           backwash slides out again; the waterline foam is broken into patches by the Voronoi cells */
        float ns = wvn(vGW.xz * .09), ns2 = wvn(vGW.xz * .21 + 3.7);
        float u = fract(t * (.13 + .05 * ns2) + ns * 2.0), reach = .6 + .9 * ns2;
        float wd = u < .7 ? 6.5 * (1.0 - u / .7) * (1.0 - u / .7) + .4 : .4 + (u - .7) / .3 * 2.2; // running in, slowing down - then the backwash going out
        if (d < 7.0 && abs(d - wd) < (u < .7 ? .35 + .15 * n : .22)) c = mix(c, foam, (u < .7 ? .8 : .4) * (1.0 - d / 7.0));
        float u2 = fract(t * .11 + ns2 * 3.0 + .5), wd2 = 6.5 * (1.0 - u2) * (1.0 - u2) + .4; // a second, weaker set, out of step
        if (d < 7.0 && u2 < .9 && abs(d - wd2) < .25 + .1 * n) c = mix(c, foam, .5 * (1.0 - d / 7.0));
        float br = u > .62 && u < .85 ? 1.0 - abs(u - .72) / .13 : 0.0;   // the moment a wave breaks: the foam reaches up the bank
        float cell = texture2D(uCaus, floor(vGW.xz * 2.0) / 10.0 + vec2(t * .01, 0.0)).r;
        if (d < .7 + reach * max(br, 0.0) * 1.3 + .25 * sin(t * 1.7 + vGW.x * .3 + vGW.z * .2) && (cell < .5 || d < .55)) c = foam; // waterline foam in patches
      }
      // sky in the water at low viewing angles (street view); nearly nothing from the isometric camera above
      { vec3 vv = normalize(cameraPosition - vGW); float fr = isOrthographic ? 0.0 : pow(1.0 - clamp(vv.y, 0.0, 1.0), 6.0);
        vec3 sky = vec3(.74, .85, .93);
        #ifdef USE_FOG
          sky = fogColor;
        #endif
        float dash = fract(sin(floor(vGW.z * 2.0) * 12.9 + floor(vGW.x * .8 + sin(t * .7 + vGW.z) * .6) * 7.7) * 437.5); // broken short dashes, drifting
        c = mix(c, mix(sky, b, .35), fr * (fr > .5 ? .38 : dash < .55 ? .32 : .08)); }
      if (bigNet > .3) c = mix(c, lite * 1.12 + vec3(.05), .28 + .14 * bigNet); // never washes the water out (phone test Jan-Fedder-Promenade) // every other pixel row at medium angles: broken reflection
      vec2 sp = floor(vGW.xz / vec2(1.0, .35));            // glints: rare, short sparkles that come and go (2.4 m bars kept showing up as 'beams' - phone test)
      float ph = floor(t * .9 + fract(sin(dot(sp, vec2(3.7, 9.1))) * 91.0) * 5.0);
      float g = fract(sin(dot(sp, vec2(7.13, 157.1)) + ph * 3.1) * 43758.5);
      if (d > 4.0 && g > .9985) c = mix(c, vec3(.82, .93, .98), .4);
      c *= .965 + .035 * sin(vGW.x * .08 + vGW.z * .05 + t * .6); // slow swell
      if (uRain > .02) { vec2 rq = floor(vGW.xz * 3.0) / 3.0 / 1.1, rid = floor(rq), rf = fract(rq) - .5; // Runde 181: rain rings on the water
        float h = fract(sin(dot(rid, vec2(7.7, 3.1))) * 4375.5), tt = fract(t * (.9 + h * .6) + h), rr = length(rf + (vec2(fract(h * 13.0), fract(h * 29.0)) - .5) * .5);
        if (h < uRain * .8 + .1 && abs(rr - tt * .45) < .05 * (1.0 - tt) + .025) c = mix(c, lite * 1.1 + vec3(.06), .5 * (1.0 - tt)); }
      // Runde 143: black ice - the water freezes from the shore outwards: pale blue ice tinted by the water, a still net of white
      // cracks, darker clear patches further out, rare glints, snow dusting from the weather
      if (uIce.x > 0.0 && uIce.x * 1.25 > n * .2 + .8 * min(d, 16.0) / 16.0) {
        float hn = fract(sin(dot(px, vec2(27.1, 61.7))) * 43758.5), m = fract(sin(dot(floor(vGW.xz * .25), vec2(9.1, 3.7))) * 917.3);
        vec3 ic = mix(vec3(.60, .74, .84), vec3(.78, .87, .93), hn * .4);
        ic = mix(ic, b * 1.2 + vec3(.22, .28, .32), .25);
        if (d > 5.0 && m > .8 && hn > .25) ic *= .88;      // clear, darker ice over deep water (few, ragged patches)
        float ck = texture2D(uCaus, floor(vGW.xz * 3.0) / 33.0).r;
        if (ck > .5) ic = mix(ic, vec3(.93, .97, 1.0), .6); // cracks
        ic = mix(ic, vec3(.92, .94, .97), uIce.y * (.55 + .45 * hn)); // snow on the ice
        if (hn > .992 && fract(t * .4 + hn * 9.0) > .85) ic = vec3(1.0);
        c = ic; }
      diffuseColor.rgb = c; } `); // outside the own tile (overlap with the neighbour) the edge value of the field continues (clamped)
  };
  return mat;
}
spriteUniforms.uAtlas.value = makeSpriteAtlas();
WATER_DROP = TERRAIN ? 1.2 : 0;
initCars(scene); // real low-poly cars, one instanced draw per type (cars.js)
const lampMat = new THREE.MeshBasicMaterial({ color: '#cfcac0', vertexColors: true }); // street lamp heads and traffic lights: dim by day, glowing at night
/* Pixel facade kit: one 128x128 atlas, 16x16 px per module, drawn once at start.
   Channels: R = glass, G = wall shade (128 = unchanged), B = light trim.
   Rows 0-4 = building age (<1919, 1919-48, 1949-78, 1979-2000, 2001+); cols: 0 upper floor, 1 ground floor, 2 shopfront, 3 party wall.
   Row 7 = roofs: 0 tiles, 1 slate, 2 gravel, 3 solar, 4 green roof, 5 metal. */
function makeAtlas() {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const set = (cx, cy, x, y, r, gg, b) => { if (x < 0 || y < 0 || x > 15 || y > 15) return; const o = ((cy * 16 + y) * S + cx * 16 + x) * 4; if (r !== null) d[o] = r; if (gg !== null) d[o + 1] = gg; if (b !== null) d[o + 2] = b; d[o + 3] = 255; };
  const fill = (cx, cy, g0) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(cx, cy, x, y, 0, g0, 0); };
  const rect = (cx, cy, x0, y0, x1, y1, r, gg, b) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(cx, cy, x, y, r, gg, b); };
  const frame = (cx, cy, x0, y0, x1, y1, r, gg, b) => { for (let x = x0; x <= x1; x++) { set(cx, cy, x, y0, r, gg, b); set(cx, cy, x, y1, r, gg, b); } for (let y = y0; y <= y1; y++) { set(cx, cy, x0, y, r, gg, b); set(cx, cy, x1, y, r, gg, b); } };
  const win = (cx, cy, x0, y0, x1, y1) => rect(cx, cy, x0, y0, x1, y1, 255, 60, 0);
  for (let row = 0; row < 5; row++) for (let col = 0; col < 4; col++) fill(col, row, 128);
  // 1: Gründerzeit – tall windows, light frames, lintel and cornice
  frame(0, 0, 4, 2, 11, 13, 0, 128, 255); win(0, 0, 5, 3, 10, 12); rect(0, 0, 3, 1, 12, 1, 0, 140, 255); rect(0, 0, 4, 14, 11, 14, 0, 128, 255); rect(0, 0, 0, 15, 15, 15, 0, 112, 0);
  for (let y = 0; y < 16; y += 3) rect(1, 0, 0, y, 15, y, 0, 108, 0); frame(1, 0, 4, 3, 11, 13, 0, 128, 255); win(1, 0, 5, 4, 10, 12);
  // 2: 1919-48 – brick bond, white frames
  // (brick bond is drawn in the shader, only for brick walls)
  for (let c of [0, 1]) { frame(c, 1, 4, 3, 11, 11, 0, 128, 255); win(c, 1, 5, 4, 10, 10); rect(c, 1, 3, 12, 12, 12, 0, 128, 255); }
  // 3: 1949-78 – plain plaster, square windows, sills
  win(0, 2, 4, 5, 11, 11); rect(0, 2, 3, 12, 12, 12, 0, 128, 255); rect(0, 2, 0, 15, 15, 15, 0, 118, 0);
  win(1, 2, 4, 5, 11, 11); rect(1, 2, 3, 12, 12, 12, 0, 128, 255); rect(1, 2, 0, 13, 15, 15, 0, 100, 0);
  // 4: 1979-2000 – wider windows with dark frames
  frame(0, 3, 2, 3, 13, 12, 0, 70, 0); win(0, 3, 3, 4, 12, 11);
  frame(1, 3, 2, 3, 13, 12, 0, 70, 0); win(1, 3, 3, 4, 12, 11); rect(1, 3, 0, 14, 15, 15, 0, 100, 0);
  // 5: 2001+ – large glazing, light floor slabs
  frame(0, 4, 1, 1, 14, 13, 0, 72, 0); win(0, 4, 2, 2, 13, 12); rect(0, 4, 0, 15, 15, 15, 0, 150, 255);
  frame(1, 4, 1, 1, 14, 14, 0, 72, 0); win(1, 4, 2, 2, 13, 13);
  // shopfront (all ages): sign band, big shop window
  for (let row = 0; row < 5; row++) { rect(2, row, 0, 1, 15, 3, 0, 80, 0); win(2, row, 1, 5, 14, 14); frame(2, row, 0, 4, 15, 15, 0, 128, 255); }
  // party walls: plain, a faint texture so they don't look empty
  for (let row = 0; row < 5; row++) if (row !== 1) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(3, row, x, y, 0, 122 + Math.floor(rnd() * 10), 0);
  // variants (col 4 upper floor, col 5 ground floor) and the front door (col 6)
  for (let row = 0; row < 5; row++) for (const col of [4, 5, 6]) {
    fill(col, row, 128);
  }
  // Gründerzeit: paired windows / arched ground floor window
  frame(4, 0, 2, 3, 7, 13, 0, 128, 255); win(4, 0, 3, 4, 6, 12); frame(4, 0, 8, 3, 13, 13, 0, 128, 255); win(4, 0, 9, 4, 12, 12); rect(4, 0, 1, 1, 14, 1, 0, 140, 255); rect(4, 0, 0, 15, 15, 15, 0, 112, 0);
  for (let y = 0; y < 16; y += 3) rect(5, 0, 0, y, 15, y, 0, 108, 0); win(5, 0, 5, 5, 10, 13); rect(5, 0, 6, 4, 9, 4, 255, 60, 0); frame(5, 0, 4, 4, 11, 14, 0, 128, 255); set(5, 0, 4, 4, 0, 128, 0); set(5, 0, 11, 4, 0, 128, 0);
  // 1919-48: window with a white cross
  for (const c of [4, 5]) { frame(c, 1, 4, 3, 11, 11, 0, 128, 255); win(c, 1, 5, 4, 10, 10); rect(c, 1, 5, 7, 10, 7, 0, 128, 255); rect(c, 1, 7, 4, 8, 10, 0, 128, 255); rect(c, 1, 3, 12, 12, 12, 0, 128, 255); }
  // 1949-78: balcony bay of a post-war block (door + window, solid parapet with a shadow below) / ground floor small high windows
  win(4, 2, 2, 3, 6, 12); frame(4, 2, 1, 2, 7, 12, 0, 128, 255); win(4, 2, 9, 4, 13, 9); rect(4, 2, 9, 10, 13, 10, 0, 128, 255);
  rect(4, 2, 0, 10, 15, 10, 0, 100, 0); rect(4, 2, 0, 11, 15, 14, 0, 138, 120); rect(4, 2, 0, 15, 15, 15, 0, 84, 0);
  win(5, 2, 3, 4, 12, 7); rect(5, 2, 3, 8, 12, 8, 0, 128, 255); rect(5, 2, 0, 13, 15, 15, 0, 100, 0);
  // 1979-2000: balcony with railing
  frame(4, 3, 2, 2, 13, 9, 0, 70, 0); win(4, 3, 3, 3, 12, 8); rect(4, 3, 0, 12, 15, 13, 0, 150, 255); for (let x = 0; x < 16; x += 2) set(4, 3, x, 11, 0, 84, 0); rect(4, 3, 0, 10, 15, 10, 0, 84, 0);
  frame(5, 3, 2, 3, 13, 12, 0, 70, 0); win(5, 3, 3, 4, 12, 11); rect(5, 3, 0, 14, 15, 15, 0, 100, 0);
  // 2001+: storey-high glazing with glass balustrade
  win(4, 4, 1, 1, 14, 14); rect(4, 4, 1, 10, 14, 10, 0, 150, 255); rect(4, 4, 0, 15, 15, 15, 0, 150, 255); rect(4, 4, 0, 0, 0, 15, 0, 72, 0); rect(4, 4, 15, 0, 15, 15, 0, 72, 0);
  frame(5, 4, 1, 1, 14, 14, 0, 72, 0); win(5, 4, 2, 2, 13, 13);
  // doors: dark wooden/metal door, light frame, glass transom
  for (let row = 0; row < 5; row++) { const modern = row >= 3;
    frame(6, row, 4, 2, 11, 15, 0, modern ? 72 : 128, modern ? 0 : 255); rect(6, row, 5, 6, 10, 15, 0, modern ? 60 : 70, 0); win(6, row, 5, 3, 10, 4);
    if (!modern) { rect(6, row, 7, 6, 8, 15, 0, 82, 0); set(6, row, 9, 11, 0, 150, 255); } else win(6, row, 6, 7, 9, 13); }
  // plinth on all ground-floor modules (not the shopfront)
  for (let row = 0; row < 5; row++) for (const c of [1, 5]) rect(c, row, 0, 15, 15, 15, 0, 96, 0);
  // roofs
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    set(0, 7, x, y, 0, y % 4 === 3 ? 96 : ((x + (y >> 2) % 2 * 4) % 8 === 0 ? 112 : 124 + Math.floor(rnd() * 12)), 0);   // tiles
    set(1, 7, x, y, 0, y % 3 === 2 ? 100 : ((x + y) % 7 === 0 ? 112 : 122 + Math.floor(rnd() * 8)), 0);                   // slate
    set(2, 7, x, y, 0, 122 + Math.floor(rnd() * 14), 0);                                                                  // gravel
    const grid = x % 8 === 0 || y % 5 === 0; set(3, 7, x, y, 0, grid ? 150 : 96, grid ? 255 : 0);                           // solar
    set(4, 7, x, y, 0, 116 + Math.floor(rnd() * 22), 0);                                                                  // green roof
    set(5, 7, x, y, 0, x % 4 === 0 ? 150 : 124, 0);                                                                       // metal
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}
const bldUniforms = { uGlass: { value: new THREE.Color('#46566a') }, uGlow: { value: new THREE.Color(0, 0, 0) }, uAtlas: { value: makeAtlas() },
  uPlayer: { value: new THREE.Vector3() }, uOrg: { value: new THREE.Vector3() }, uOrgCell: { value: new THREE.Vector2() }, uCamRel: { value: new THREE.Vector3() }, uFocusRel: { value: new THREE.Vector3() }, uToCam: { value: new THREE.Vector3(0, 1, 0) }, uCamDist: { value: 1 }, uFocus: { value: new THREE.Vector3() }, uSeeR: { value: 0 }, uSimple: { value: 0 }, uOccFull: { value: 0 },
  uOccA: { value: [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector4(0, 0, 1, 0)) }, uOccB: { value: [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector4(0, 0, 0, 0)) }, uOccG: { value: [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector2(0, 0)) } };
/* Cutaway like in The Sims: buildings between camera and player (plus the parts built onto them) are lowered
   to the ground floor; the inside of the walls shows as a dark section, the floor plan becomes visible. */
const OCC = 8, CUT_Y = 2.6, occSlots = [], OCC_HOLD = new Map(), OCC_HOLDH = new Map(), OCC_HOLDG = new Map();
function obb2(p) { // smallest rotated box around a footprint
  let best = null; const n = p.length / 2;
  for (let i = 0; i < n && i < 40; i++) {
    const j = (i + 1) % n, dx = p[j * 2] - p[i * 2], dz = p[j * 2 + 1] - p[i * 2 + 1], L = Math.hypot(dx, dz); if (L < 0.5) continue;
    const c = dx / L, s = dz / L; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < p.length; k += 2) { const u = p[k] * c + p[k + 1] * s, v = -p[k] * s + p[k + 1] * c; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const a = (u1 - u0) * (v1 - v0); if (!best || a < best.a) best = { a, c, s, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
  return { cx: cu * best.c - cv * best.s, cz: cu * best.s + cv * best.c, c: best.c, s: best.s, hu: (best.u1 - best.u0) / 2, hv: (best.v1 - best.v0) / 2 };
}
/* Runde 49: real roof heights of the 3D state data (LoD2) on a 2 m grid - the map footprints often say much lower (phone test Koblenz:
   in the isometric view the line of sight seemed to pass over a six-storey house, only the small hole opened, not the whole house) */
const L2H = new Map(); // LoD2 tile key -> Map(cell -> highest point)
/* Runde 103 (phone test: an invisible wall on a square at night): an OSM footprint inside a shown LoD2 tile whose building LoD2
   does not have (demolished, a low structure under 1.2 m left out) is not drawn - but its outline still blocked. Rule: such a
   footprint blocks only if LoD2 geometry stands on it (a LoD2 vertex cell at a corner or inside, higher than 1.2 m) */
let L2VER = 0; const L2B = new Map();
function itemGhost(it) {
  if (it.l2) return false; if (it.gv === L2VER) return it.ghost; it.gv = L2VER; it.ghost = false;
  const cx = (it.minx + it.maxx) / 2, cz = (it.minz + it.maxz) / 2; let inL2 = false;
  for (const b of L2B.values()) if (cx > b[0] && cx < b[1] && cz > b[2] && cz < b[3]) { inL2 = true; break; } if (!inL2) return false;
  const p = it.p; for (let i = 0; i < p.length; i += 2) for (const [u, v] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]]) if (lod2Top(p[i] + u, p[i + 1] + v) > it.base + 1.2) return false;
  const st = Math.max(2, Math.max(it.maxx - it.minx, it.maxz - it.minz) / 8);
  for (let x = it.minx; x <= it.maxx; x += st) for (let z = it.minz; z <= it.maxz; z += st) if (inPoly(x, z, p) && lod2Top(x, z) > it.base + 1.2) return false;
  return it.ghost = true;
}
function addL2H(key, pos, gid) { { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let i = 0; i < pos.length; i += 3) { if (pos[i] < a) a = pos[i]; if (pos[i] > b) b = pos[i]; if (pos[i + 2] < c) c = pos[i + 2]; if (pos[i + 2] > d) d = pos[i + 2]; } if (pos.length) L2B.set(key, [a + 20, b - 20, c + 20, d - 20]); L2VER++; } const m = new Map(), gm = gid ? new Map() : null; for (let i = 0; i < pos.length; i += 3) { const k = Math.floor(pos[i] / 2) * 100003 + Math.floor(pos[i + 2] / 2), y = pos[i + 1], o = m.get(k); if (o === undefined || y > o) { m.set(k, y); if (gm) gm.set(k, gid[i / 3]); } } L2H.set(key, m); if (gm) { L2G.set(key, gm); for (const [k, g] of gm) { let l = L2GC.get(g); if (!l) L2GC.set(g, l = []); l.push(k); } } }
const L2GC = new Map(); // building number -> its 2 m cells
const L2G = new Map(); // 2 m cell -> number of the LoD2 building with the highest point there (Runde 68)
function lod2At(k) { let t = -Infinity, g = 0; for (const [key, m] of L2H) { const v = m.get(k); if (v !== undefined && v > t) { t = v; const gm = L2G.get(key); g = gm ? gm.get(k) || 0 : 0; } } return [t, g]; }
const occG = []; let occGKey = '', occGSet = new Set();
function lod2Gid(k) { let t = -Infinity, g = 0; for (const [key, m] of L2H) { const v = m.get(k); if (v !== undefined && v > t) { const gm = L2G.get(key); if (gm) { t = v; g = gm.get(k) || 0; } } } return g; }
function lod2Top(x, z) { const k = Math.floor(x / 2) * 100003 + Math.floor(z / 2); let t = -Infinity; for (const m of L2H.values()) { const v = m.get(k); if (v !== undefined && v > t) t = v; } return t; }
function updateOccluders(dt) {
  const found = new Set(), hits = new Set(), foundG = new Set(), cache = new Map();
  if (PRUEF === null && ISO === null) {
    const tc = bldUniforms.uToCam.value, hl = Math.hypot(tc.x, tc.z) || 1e-6, dx = tc.x / hl, dz = tc.z / hl, rise = tc.y / hl;
    // rays from the feet up the line of sight: a house counts as soon as it starts to cut into the figure (roof overhang included)
    // only the figure's own width counts (Handy test: walking along the side of a house must not make it see-through)
    // Runde 67 (phone, delivery van in the diorama: hidden under roofs): the rays start from the whole vehicle - centre, bonnet and tail,
    // across its width - not only from the figure's 1.2 m
    const hl2 = DRV.on && DRV.car ? DRV.car.len / 2 : 0, hx = Math.sin(P.yaw), hz = Math.cos(P.yaw), W = DRV.on ? 1.1 : .6;
    for (const along of hl2 ? [0, hl2, -hl2] : [0]) { const ox0 = P.x + hx * along, oz0 = P.z + hz * along;
    const sMax = Math.min(220, bldUniforms.uCamDist.value - .4); // only up to the camera: what lies behind it hides nothing (Runde 108, phone test Beckhausstrasse: +2 m reached into the wall the camera leans against - that wall and its whole block, the house in front of the figure included, went see-through)
    for (let s = 0.5; s < sMax && found.size < 3; s += s < 20 ? 0.4 : 1.2) {
      const y = P.y + s * rise;
      if (s < 1.6) continue; // Runde 101 (phone test: standing right at a house front made THAT house see-through - the first ray points lie in its 2 m height cell / its footprint)
      for (const off of [-W, 0, W]) {
        const qx = ox0 + dx * s - dz * off, qz = oz0 + dz * s + dx * off, b = buildingAt(qx, qz);
        /* Runde 68 ("no hole - whole buildings away"): LoD2 buildings are found by their own number, footprint in OSM or not */
        { const ck = Math.floor(qx / 2) * 100003 + Math.floor(qz / 2); let r = cache.get(ck); if (!r) cache.set(ck, r = lod2At(ck));
          if (r[1] && r[0] + 0.6 > y && r[0] > P.y + 1.5) foundG.add(r[1]); }
        if (b && Math.max(b.base + (b.h - b.base) * 1.3, lod2Top(qx, qz)) + 0.6 > y && b.h - b.base > CUT_Y + 0.5 && !found.has(b)) { found.add(b); hits.add(b); } // ×1.3: the footprint height often leaves out the roof
      }
      if (y > P.y + 160 || foundG.size >= 4) break; // above every building (relative to the figure: the terrain may be 100 m above the start)
    } }
    // rows and blocks are several footprints in the data: take the parts built directly onto it as well
    const queue = [...found];
    while (queue.length && found.size < OCC) {
      const b = queue.shift();
      for (let ix = Math.floor((b.minx - 1) / CELL); ix <= Math.floor((b.maxx + 1) / CELL); ix++)
        for (let iz = Math.floor((b.minz - 1) / CELL); iz <= Math.floor((b.maxz + 1) / CELL); iz++)
          for (const it of bgrid.get(gk(ix, iz)) || []) {
            if (found.size >= OCC || found.has(it) || it.h - it.base < CUT_Y + 0.5) continue;
            if (it.maxx < b.minx - .6 || it.minx > b.maxx + .6 || it.maxz < b.minz - .6 || it.minz > b.maxz + .6) continue;
            if (!touches(it.p, b.p)) continue;
            { const tc = bldUniforms.uToCam.value, hl = Math.hypot(tc.x, tc.z) || 1e-6; if ((((it.minx + it.maxx) / 2 - P.x) * tc.x + ((it.minz + it.maxz) / 2 - P.z) * tc.z) / hl < -4) continue; } // Runde 108: an attached house on the far side of the figure (away from the camera) hides nothing
            found.add(it); queue.push(it);
          }
    }
  }
  /* Runde 117 (phone test: a house wall flickered between solid and dotted): a house at the edge of the line of sight was found
     in one frame and lost in the next, so it kept fading in and out. Hysteresis: a house found once stays hidden for 0.6 s. */
  { const now = performance.now(); for (const b of found) OCC_HOLD.set(b, now); for (const b of hits) OCC_HOLDH.set(b, now); for (const g of foundG) OCC_HOLDG.set(g, now);
    for (const [b, t] of OCC_HOLDH) { if (now - t > 600) OCC_HOLDH.delete(b); else hits.add(b); } /* a house on the line of sight keeps its priority too, else two houses swap one slot every frame */
    for (const [b, t] of OCC_HOLD) { if (now - t > 600) OCC_HOLD.delete(b); else found.add(b); }
    for (const [g, t] of OCC_HOLDG) { if (now - t > 600) OCC_HOLDG.delete(g); else foundG.add(g); } }
  // Handy test (row houses): all slots were taken by houses still fading out, so the house right in front never got one.
  // Houses on the line of sight come first and may take over the slot of a fading or a merely attached house.
  for (const b of found) {
    if (occSlots.some(o => o.b === b)) continue;
    if (!b.obb) b.obb = obb2(b.p); if (!b.obb) continue;
    if (occSlots.length < OCC) { occSlots.push({ b, a: 0 }); continue; }
    let k = occSlots.findIndex(o => !found.has(o.b));
    if (k < 0 && hits.has(b)) k = occSlots.findIndex(o => !hits.has(o.b));
    if (k >= 0) occSlots[k] = { b, a: hits.has(b) ? 0.5 : 0 };
  }
  for (let i = occSlots.length - 1; i >= 0; i--) { // lower / raise smoothly
    const o = occSlots[i]; o.a = Math.max(0, Math.min(1, o.a + (found.has(o.b) ? dt * 5 : -dt * 3))); // fade in / out
    if (!found.has(o.b) && o.a <= 0) occSlots.splice(i, 1);
  }
  // attached LoD2 buildings (annexes, the rest of the row) go with the hit ones: neighbouring 2 m cells with another number
  const gk2 = [...foundG].sort().join(',');
  if (gk2 !== occGKey) { occGKey = gk2; occGSet = new Set(foundG); const queue = [...foundG];
    while (queue.length && occGSet.size < OCC) { const g = queue.shift(), cells = L2GC.get(g); if (!cells) continue;
      for (const k of cells) { const ix = Math.round(k / 100003), iz = k - ix * 100003; // undo ix * 100003 + iz (|iz| < 50000)
        for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const r = lod2At((ix + u) * 100003 + iz + v), tcv = bldUniforms.uToCam.value; if (((ix + u) * 2 + 1 - P.x) * tcv.x + ((iz + v) * 2 + 1 - P.z) * tcv.z < -4 * (Math.hypot(tcv.x, tcv.z) || 1)) continue; if (r[1] && r[1] !== g && !occGSet.has(r[1]) && r[0] > P.y + CUT_Y && occGSet.size < OCC) { occGSet.add(r[1]); queue.push(r[1]); } } } } }
  for (const g of occGSet) if (!occG.some(o => o.g === g)) { if (occG.length < OCC) occG.push({ g, a: foundG.has(g) ? .5 : 0 }); else { const k = occG.findIndex(o => !occGSet.has(o.g)); if (k >= 0) occG[k] = { g, a: 0 }; } }
  for (let i = occG.length - 1; i >= 0; i--) { const o = occG[i]; o.a = Math.max(0, Math.min(1, o.a + (occGSet.has(o.g) ? dt * 5 : -dt * 3))); if (!occGSet.has(o.g) && o.a <= 0) occG.splice(i, 1); }
  { const U = bldUniforms.uOccG.value; for (let i = 0; i < OCC; i++) { const o = occG[i]; if (o) U[i].set(o.g, o.a); else U[i].set(0, 0); } }
  const A = bldUniforms.uOccA.value, B = bldUniforms.uOccB.value;
  for (let i = 0; i < OCC; i++) {
    const o = occSlots[i];
    if (o) { A[i].set(o.b.obb.cx - P.x, o.b.obb.cz - P.z, o.b.obb.c, o.b.obb.s); B[i].set(o.b.obb.hu + 1.5, o.b.obb.hv + 1.5, o.a, 1); /* 1.5 m around the footprint: LoD2 annexes reaching beyond the map outline go too (Runde 50) */ }
    else B[i].set(0, 0, 0, 0);
  }
}
function touches(p, q) { // does any corner of one footprint lie on or very close to the other one?
  for (let i = 0; i < p.length; i += 2) if (nearPoly(p[i], p[i + 1], q)) return true;
  for (let i = 0; i < q.length; i += 2) if (nearPoly(q[i], q[i + 1], p)) return true;
  return false;
}
function nearPoly(x, z, p) {
  if (inPoly(x, z, p)) return true;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const ax = p[j], az = p[j + 1], bx = p[i], bz = p[i + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < 0.36) return true;
  }
  return false;
}
const bldMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
bldMat.extensions = { derivatives: true }; // fwidth(): 1-px frames in the facade kit (WebGL 1 needs the extension)
bldMat.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, bldUniforms);
  // position relative to the player is computed in the vertex shader (always full precision); the fragment shader
  // then only works with small numbers, which also stays exact on phone GPUs with reduced precision
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aFac;\nattribute vec3 aWall;\nattribute float aBase;\nvarying float vBase;\nvarying vec2 vFac;\nvarying vec3 vWall;\nvarying vec3 vWNor;\nvarying vec3 vRel;\nvarying float vAlong;\nvarying vec2 vCell29;\nvarying vec2 vRoof;\nuniform vec3 uPlayer;\nuniform vec3 uOrg;\nattribute float aGid;\nuniform vec2 uOccG[8];\nvarying float vGo;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBase=aBase;\nvFac=aFac;\nvWall=aWall;\nvec3 vWPos=(modelMatrix*vec4(transformed,1.0)).xyz;\nvRel=vWPos-uPlayer;\nvWNor=normalize(mat3(modelMatrix)*objectNormal);\nvec2 hxT=normalize(vec2(-vWNor.z,vWNor.x)+1e-5);\nvAlong=dot(vWPos.xz,hxT)-aWall.x;\nvCell29=(vWPos.xz-uOrg.xz)/29.0;\nvec2 hxS=length(vWNor.xz)>0.05?normalize(vWNor.xz):vec2(0.0,1.0);\nvec3 hxL=vWPos-uOrg;\nvRoof=vec2(dot(hxL.xz,vec2(-hxS.y,hxS.x)),dot(hxL.xz,hxS))/1.6;\nvGo=0.0;\nif(aGid>0.5){for(int i=0;i<8;i++){if(abs(aGid-uOccG[i].x)<0.5)vGo=max(vGo,uOccG[i].y);}}');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uPlayer;\nvarying float vGo;\nvarying float vAlong;\nvarying vec2 vCell29;\nuniform vec2 uOrgCell;\nvarying vec2 vRoof;\nuniform vec3 uCamRel;\nuniform vec3 uFocusRel;\nvarying float vBase;\nvarying vec2 vFac;\nvarying vec3 vWall;\nvarying vec3 vWNor;\nvarying vec3 vRel;\nuniform vec3 uGlass;\nuniform vec3 uGlow;\nuniform sampler2D uAtlas;\nuniform vec3 uToCam;\nuniform float uCamDist;\nuniform vec3 uFocus;\nuniform float uSeeR;\nuniform float uSimple;\nuniform float uOccFull;\nuniform vec4 uOccA[8];\nuniform vec4 uOccB[8];\nfloat hxB2(vec2 a){a=floor(a);return fract(a.x*0.5+a.y*a.y*0.75);}\nfloat hxBayer(vec2 a){return hxB2(0.5*a)*0.25+hxB2(a);}')
    .replace('#include <color_fragment>', `#include <color_fragment>
      float wy = vRel.y + uPlayer.y - vBase; // (Runde 64: no world position varying any more) // height above the house's own ground (terrain)
      // buildings hiding the player (rotated box around each footprint, whole connected block)
      float occ = 0.0;
      for (int i = 0; i < 8; i++) {
        vec2 d = vRel.xz - uOccA[i].xy;
        vec2 l = vec2(dot(d, uOccA[i].zw), dot(d, vec2(-uOccA[i].w, uOccA[i].z)));
        if (uOccB[i].w > 0.5 && abs(l.x) < uOccB[i].x && abs(l.y) < uOccB[i].y) occ = max(occ, uOccB[i].z);
      }
      occ = max(occ, vGo); // whole LoD2 building by its number (Runde 68)
      // see-through: the whole block dissolves into a pixel pattern, about 75 % of its pixels are left out
      if (occ > 0.0 && (uOccFull > 0.5 ? occ > 0.3 : hxBayer(gl_FragCoord.xy) < min(occ, 0.72))) discard; // Runde 100 (phone test: houses vanished completely): at most 72 % of the pixels go - the house stays see-through // Runde 68: the whole building goes (dithered only while fading in/out) // Matrix: the house goes completely (the dither pattern lit up as edges)
      bool cutaway = occ > 0.0;
      bool inner = cutaway && dot(normalize(vWNor), normalize(uCamRel - vRel)) < -0.02; // inside of a wall: we look into the house
      // fallback for parts not covered by a footprint: a small dithered hole along the line of sight
      if (uSeeR > 0.0) {
        vec3 rel = vRel - vec3(0.0, 1.0, 0.0);
        float s = dot(rel, uToCam);                       // metres from the player towards the camera
        if (s > 0.3 && s < uCamDist && dot(rel.xz, uToCam.xz) > 0.4) { // only things really in front of the player
          float dl = length(rel - uToCam * s), rad = uSeeR * mix(1.0, 0.3, clamp(s / 40.0, 0.0, 1.0));
          // (smoothstep only with edge0 < edge1: the reversed form is undefined and fails on many phone GPUs)
          if (dl < rad && (uOccFull > 0.5 ? dl < rad * 0.8 : hxBayer(gl_FragCoord.xy) < 0.85 * (1.0 - smoothstep(rad * 0.55, rad, dl)))) discard;
        }
      }
      vec3 nn = normalize(vWNor);
      if (abs(nn.y) < 0.3) diffuseColor.rgb *= 1.15; // walls only get side light; lift them so light render reads as light, like on the photos
      float fd = clamp(1.0 - (length(vRel - uFocusRel) - 70.0) / 90.0, 0.0, 1.0);
      vec3 toCam = normalize(uCamRel - vRel);
      float face = abs(dot(toCam, nn));
      if (abs(nn.y) < 0.3 && vFac.x > 0.5) diffuseColor.rgb *= mix(0.92, 1.0, fd * smoothstep(0.03, 0.12, face)); // faded walls keep a hint of windows
      if (fd > 0.0 && abs(nn.y) < 0.3 && vFac.x > 0.5) {
        fd *= smoothstep(0.03, 0.12, face); // only walls seen really edge-on lose the window raster (avoids flicker)
        float era = mod(vFac.x, 8.0);
        float party = mod(floor(vFac.x / 8.0), 2.0);
        float shop = mod(floor(vFac.x / 16.0), 2.0);
        float variant = mod(floor(vFac.x / 32.0), 2.0);
        float gable = mod(floor(vFac.x / 64.0), 2.0);
        float brick = mod(floor(vFac.x / 128.0), 2.0);
        float street = mod(floor(vFac.x / 256.0), 2.0);
        float style = floor(vFac.x / 512.0); // 1 church, 2 tower, 3 castle, 4 station/hall, 5 glass, 6 civic
        // window axes as measured on Street View: German residential facades have a window every 2.0-2.6 m
        vec2 bay = era < 1.5 ? vec2(2.2, 3.5) : era < 2.5 ? vec2(2.2, 3.1) : era < 3.5 ? vec2(2.4, 2.85) : era < 4.5 ? vec2(2.6, 2.85) : vec2(3.0, 3.1);
        vec2 tg = normalize(vec2(-nn.z, nn.x) + 1e-5);
        // spread whole window bays over this wall face, and whole storeys up to the eave
        // Runde 137 (40 squares: black triangles on gables): faces without wall data (gable triangles, L = 0) divided by zero -> NaN -> black
        bool noWall = vWall.y < 0.05;
        float L = max(vWall.y, 0.05);
        float nb = max(1.0, floor(L / bay.x + 0.3));
        float u = noWall ? 0.0 : vAlong / (L / nb); // along the wall from its start (Runde 63: precomputed in the vertex shader, small numbers only)
        // storeys: eave minus plinth (raised ground floor/basement) minus knee wall under a pitched roof;
        // the number of storeys comes from OSM building:levels where mapped, otherwise from the height
        float lvOsm = floor(vFac.y / 1000.0), rest = mod(vFac.y, 1000.0);
        float pitchedRoof = step(500.0, rest);
        float eave = max(rest - pitchedRoof * 500.0, 2.5);
        float plinth = era < 2.5 ? 0.6 : 0.9, knee = pitchedRoof * 0.9;
        float usable = max(eave - plinth - knee, 2.2);
        float ns = lvOsm > 0.5 ? lvOsm : max(1.0, floor(usable / bay.y + 0.3));
        float sh = usable / ns;
        float v = (wy - plinth) / sh;
        vec2 cell = floor(vec2(u, v));
        bool plain = noWall || party > 0.5 || L < bay.x * 0.6 || u < 0.0 || u >= nb || v < 0.0;
        if (v >= ns) {
          // above the top storey: knee wall stays plain; inside a gable that faces the street (old-town houses)
          // windows continue, but only where the gable is wide enough
          float top = max(vWall.z, eave + 0.1);
          float rowBottom = plinth + cell.y * sh;
          float frac = clamp((rowBottom + sh - eave) / (top - eave), 0.0, 1.0);
          float off = abs((cell.x + 0.5) * (L / nb) - L * 0.5) + (L / nb) * 0.5;
          if (!(gable > 0.5 && street > 0.5 && rowBottom >= eave - 0.3 && off <= L * 0.5 * (1.0 - frac))) plain = true;
        }
        // side and back gables: only every second bay gets a window
        if (gable > 0.5 && street < 0.5 && mod(cell.x, 2.0) < 0.5) plain = true;
        // front door and shops only towards the street; balconies rather on the garden side of newer blocks
        float door = (street > 0.5 && cell.x == floor(nb * 0.5) && nb > 1.5) ? 1.0 : 0.0;
        float alt = era > 2.5 ? (street > 0.5 ? 0.0 : step(0.35, fract(vWall.x * 0.137))) : variant;
        float colI = plain ? 3.0 : (cell.y < 0.5 ? (shop > 0.5 && street > 0.5 ? 2.0 : (door > 0.5 ? 6.0 : 1.0 + alt * 4.0)) : alt * 4.0);
        vec4 tx; float refl = 0.0, stain = 0.0;
        if (uSimple > 0.5) {
          // isometric view: a storey is only ~13 screen pixels, the detailed kit would turn into noise.
          // Draw one clean window per bay instead (r = glass, g = shade, b = light trim).
          // pixel-art kit (like the tree sprites): every window gets a 1-px light frame, a reflection pixel top left
          // and a dark shadow pixel row under the lintel; storeys of old houses get a light cornice
          vec2 f = fract(vec2(u, v)), pw = max(fwidth(vec2(u, v)), vec2(1e-4));
          tx = vec4(0.0, 0.5, 0.0, 1.0);
          if (colI < 0.5 || (colI > 0.5 && colI < 1.5) || (colI > 3.5 && colI < 5.5)) {
            float hw = era < 1.5 ? 0.17 : era < 2.5 ? 0.2 : era < 3.5 ? 0.24 : era < 4.5 ? 0.28 : 0.36;
            float y0 = era > 4.5 ? 0.14 : 0.3, y1 = era < 1.5 ? 0.82 : era > 4.5 ? 0.9 : 0.76;
            float ax = abs(f.x - 0.5);
            if (ax < hw && f.y > y0 && f.y < y1) {
              tx.r = 1.0;
              if (ax > hw - pw.x * 1.1 || f.y < y0 + pw.y * 1.1) { tx.r = 0.0; tx.b = 0.85; }                 // frame
              else if (f.y > y1 - pw.y * 1.1) { tx.r = 0.0; tx.g = 0.3; }                                       // shadow under the lintel
              else if (f.x - 0.5 + hw < pw.x * 2.2 && y1 - f.y < pw.y * 2.6) refl = 1.0;                       // reflection
            }
            else if (ax < hw + pw.x && f.y > y0 - pw.y * 1.2 && f.y <= y0) tx.b = 1.0;                         // sill
            else if (ax < hw + pw.x && f.y >= y1 && f.y < y1 + pw.y * 1.2 && era < 2.5) tx.b = 0.7;            // lintel
            if (colI > 3.5 && era > 2.5 && f.y < 0.26) { tx.r = 0.0; tx.b = 0.55; tx.g = 0.55; } // balcony parapet
          } else if (colI > 5.5) {
            if (abs(f.x - 0.5) < 0.17 && f.y < 0.72) tx.g = 0.33; // front door
          } else if (colI > 1.5 && colI < 2.5) {
            if (f.x > 0.06 && f.x < 0.94 && f.y > 0.04 && f.y < 0.62) tx.r = 1.0;                  // shop window
          }
          if (cell.y < 0.5 && f.y < 0.07) tx.g = 0.42;                                              // plinth
          if (era < 2.5 && cell.y > 0.5 && f.y > 1.0 - pw.y * 1.2) tx = vec4(0.0, 0.5, 0.6, 1.0);   // storey cornice
        } else tx = texture2D(uAtlas, (vec2(colI, 8.0 - era) + fract(vec2(u, v))) / 8.0);
        // facades by building type (OSM building/amenity/historic): no residential window grid on churches, towers, castles …
        if (style > 0.5 && era < 5.5) {
          float t0 = vAlong, pwx = max(fwidth(t0), 0.02), pwy = max(fwidth(wy), 0.02);
          tx = vec4(0.0, 0.5, 0.0, 1.0); colI = 0.0;
          if (style < 1.5) { // church: tall arched windows every ~4.5 m, stained glass, no storeys
            float nbw = max(1.0, floor(L / 4.5 + 0.3)), bw = L / nbw, fu = fract(t0 / bw) - 0.5, ax2 = abs(fu) * bw;
            float y0 = 2.2, y1 = max(4.0, min(eave * 0.78, eave - 1.2)), r = 0.55;
            bool inArch = wy > y1 - r ? (ax2 * ax2 + (wy - (y1 - r)) * (wy - (y1 - r)) < r * r) : true;
            if (party < 0.5 && L > 3.0 && ax2 < r && wy > y0 && wy < y1 && inArch) { tx.r = 1.0; stain = 1.0; if (ax2 > r - pwx * 1.2) { tx.r = 0.0; tx.b = 0.9; } }
            if (wy < 0.6) tx.g = 0.42;
          } else if (style < 2.5) { // tower: narrow slits every ~6 m of height, louvre band below the top
            float row = floor(wy / 6.0), fy = wy - row * 6.0, ac = abs(t0 - L * 0.5);
            if (party < 0.5 && ac < 0.3 && fy > 2.2 && fy < 3.8 && wy > 4.0) tx.r = 1.0;
            if (vWall.z - wy < 3.2 && vWall.z - wy > 1.0 && ac < max(0.8, L * 0.25)) { tx.r = 0.0; tx.g = mod(floor(wy / 0.25), 2.0) > 0.5 ? 0.28 : 0.36; }
          } else if (style < 3.5) { // castle / palace: dressed stone blocks, small windows
            float by = floor(wy / 0.45), bx2 = floor((t0 + mod(by, 2.0) * 0.4) / 0.8);
            tx.g = 0.46 + 0.08 * fract(sin(by * 12.9 + bx2 * 7.3) * 4375.5);
            if (fract(wy / 0.45) < 0.12 || fract((t0 + mod(by, 2.0) * 0.4) / 0.8) < 0.06) tx.g = 0.4;
            float fu = fract(t0 / 3.4) - 0.5, fv = fract(wy / 3.6);
            if (party < 0.5 && abs(fu) < 0.12 && fv > 0.35 && fv < 0.75 && wy > 2.0 && wy < eave - 0.8) tx = vec4(1.0, 0.5, 0.0, 1.0);
          } else if (style < 4.5) { // station / hall: tall arched glass bays at ground level
            float fu = fract(t0 / 6.0) - 0.5, ax2 = abs(fu) * 6.0, top = min(eave - 1.0, 9.0);
            if (party < 0.5 && ax2 < 2.2 && wy > 0.8 && (wy < top - 2.2 || ax2 * ax2 + (wy - (top - 2.2)) * (wy - (top - 2.2)) < 4.84)) { tx.r = 1.0; if (mod(floor(t0 / 0.75), 2.0) < 0.5 && fract(t0 / 0.75) < 0.15) tx.r = 0.0; }
          } else if (style < 5.5) { // glass: glazed wall in a fine concrete grid (e.g. new Kaiser Wilhelm Memorial Church)
            tx.r = 1.0; stain = 2.0;
            if (fract(t0 / 1.2) < 0.12 || fract(wy / 1.2) < 0.12) { tx.r = 0.0; tx.b = 0.7; }
          } else { // civic (town hall, museum, theatre): high storeys, tall windows, cornices
            float sh2 = 4.6, row = floor(wy / sh2), fy = fract(wy / sh2), fu = fract(t0 / 3.2) - 0.5;
            if (party < 0.5 && abs(fu) < 0.17 && fy > 0.25 && fy < 0.8 && wy < eave - 0.8) { tx.r = 1.0; if (abs(fu) > 0.17 - pwx / 3.2 * 1.2) { tx.r = 0.0; tx.b = 0.9; } }
            if (fy > 0.95 && row > 0.5) tx.b = 0.7;
          }
        }
        // pixel-art edges of the whole wall: dark shadow band under the eaves, light parapet edge on flat roofs
        if (era < 5.5 && party < 0.5) {
          if (pitchedRoof > 0.5 && wy > eave - 0.3 && wy <= eave + 0.05) tx = vec4(0.0, 0.32, 0.0, 1.0);
          if (pitchedRoof < 0.5 && wy > vWall.z - 0.35) tx = vec4(0.0, 0.5, 0.9, 1.0);
        }
        if (era > 5.5) {
          // hall (industrial/commercial): trapezoidal sheet, one ribbon window, roller gates towards the street
          float t0 = vAlong;
          tx = vec4(0.0, uSimple > 0.5 ? 0.5 : (mod(floor(t0 / 0.45), 2.0) > 0.5 ? 0.5 : 0.47), 0.0, 1.0);
          if (wy > 3.4 && wy < 4.3 && L > 8.0 && party < 0.5) tx.r = 1.0;
          float gate = mod(t0, 16.0);
          if (street > 0.5 && L > 12.0 && gate > 6.0 && gate < 10.5 && wy < 4.0) { tx.r = 0.0; tx.g = uSimple > 0.5 ? 0.36 : (mod(floor(wy / 0.3), 2.0) > 0.5 ? 0.36 : 0.33); }
          if (wy < 0.45) tx.g = 0.4;
          if (wy > vWall.z - 0.6) tx.g = 0.58;   // light top edge (attic)
        }
        float rnd = fract(sin(dot(cell + mod(floor(vCell29) + uOrgCell, 256.0), vec2(12.9898, 78.233))) * 43758.5453); // Runde 69: rounded per pixel (rounded per corner it smeared across walls: noise in the windows)
        float shade = tx.g * 2.0;
        if (brick > 0.5 && uSimple < 0.5 && tx.r < 0.5 && tx.b < 0.5) { // brick bond: courses and staggered joints in world space
          float t0 = vAlong, by = floor(wy / 0.26), bf = fract(wy / 0.26);
          float bx = (t0 + mod(by, 2.0) * 0.27) / 0.54;
          float mortar = max(step(bf, 0.18), step(fract(bx), 0.09));
          shade *= mortar > 0.5 ? 1.14 : 0.93 + 0.1 * fract(sin(by * 12.9 + floor(bx) * 7.1) * 4375.5);
        }
        vec3 wall = diffuseColor.rgb * shade;
        wall = mix(wall, mix(diffuseColor.rgb, vec3(0.95, 0.93, 0.88), 0.75), tx.b);
        vec3 glass = uGlass * (0.8 + 0.45 * rnd);
        glass = mix(glass, vec3(0.82, 0.9, 0.98), refl * 0.65);
        if (stain > 1.5) glass = mix(vec3(0.10, 0.22, 0.55), vec3(0.2, 0.38, 0.75), fract(sin(dot(floor(vec2(vAlong, wy) / 1.2), vec2(3.7, 9.1))) * 437.5)); // blue glass blocks
        else if (stain > 0.5) { float k = fract(sin(dot(floor(vec2(vAlong, wy) / 0.45), vec2(12.9, 78.2))) * 43758.5);
          glass = k < 0.3 ? vec3(0.2, 0.3, 0.62) : k < 0.55 ? vec3(0.62, 0.18, 0.18) : k < 0.75 ? vec3(0.78, 0.62, 0.22) : vec3(0.25, 0.45, 0.32); } // stained glass
        glass = mix(glass, vec3(0.78, 0.74, 0.66), step(0.86, rnd) * 0.55); // some curtains
        // roller shutters (very common in Germany): pulled down by a random amount, more often on newer buildings
        float closure = fract(rnd * 7.31) * (era > 2.5 ? 0.9 : 0.5);
        float fy = fract(v);
        if ((colI > 1.5 && colI < 2.5) || era > 5.5) closure = 0.0; // no shutters on shop windows
        if (fy > 0.8 - closure * 0.55) { // shutter: one flat colour with a dark bottom edge (stripes turned into noise on the phone)
          glass = vec3(0.80, 0.79, 0.76);
          if (fy < 0.8 - closure * 0.55 + fwidth(v) * 1.1) glass *= 0.62;
        }
        wall = mix(wall, glass, tx.r);
        float signGlow = 0.0;
        if (colI > 1.5 && colI < 2.5) {
          // shops: a colourful sign band and a striped awning; neighbouring bays share one shop
          float shopId = fract(sin(floor(cell.x / 3.0) * 91.7 + floor(vWall.x) * 3.1) * 4375.85);
          vec3 sc = shopId < 0.14 ? vec3(0.85, 0.27, 0.23) : shopId < 0.28 ? vec3(0.91, 0.53, 0.23) : shopId < 0.42 ? vec3(0.95, 0.77, 0.24) : shopId < 0.56 ? vec3(0.25, 0.6, 0.35)
                  : shopId < 0.70 ? vec3(0.18, 0.6, 0.6) : shopId < 0.84 ? vec3(0.23, 0.44, 0.75) : vec3(0.85, 0.35, 0.54);
          if (fy > 0.8 && fy < 0.95) { wall = sc * 0.92; if (abs(fract(u) - 0.5) < 0.28 && fy > 0.84 && fy < 0.91) wall = vec3(0.96, 0.94, 0.88); signGlow = 1.0; }
          else if (fy > 0.62 && fy <= 0.8) { wall = mod(floor(fract(u) * 6.0), 2.0) > 0.5 ? sc : vec3(0.95, 0.93, 0.88); if (fy < 0.66) wall *= 0.8; }
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, wall, fd);
        totalEmissiveRadiance += (tx.r * step(0.45, rnd) + signGlow * 0.6) * uGlow * fd;
      } else if (fd > 0.0 && nn.y >= 0.3) {
        vec2 sd = length(nn.xz) > 0.05 ? normalize(nn.xz) : vec2(0.0, 1.0);
        vec2 uv = vRoof;
        vec4 tx = uSimple > 0.5 ? vec4(0.0, (vFac.y < 0.5 || vFac.y > 4.5) ? (mod(floor(uv.y * 3.0), 2.0) > 0.5 ? 0.5 : 0.46) : 0.5, 0.0, 1.0) // calm tile rows
                                : texture2D(uAtlas, (vec2(vFac.y, 0.0) + fract(uv)) / 8.0);
        vec3 rc = diffuseColor.rgb * (tx.g * 2.0);
        rc = mix(rc, mix(diffuseColor.rgb, vec3(0.85), 0.5), tx.b);
        diffuseColor.rgb = mix(diffuseColor.rgb, rc, fd);
      }
      if (cutaway) {
        if (inner) diffuseColor.rgb = vec3(0.34, 0.29, 0.25);                     // inside of the walls: section colour
        totalEmissiveRadiance *= 0.3;
      }`);
};
const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: '#8fa067' }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; scene.add(ground); if (TERRAIN) ground.visible = false;

// stars, sun/moon disc
const starGeo = new THREE.BufferGeometry(), sp = [];
for (let i = 0; i < 500; i++) { const u = Math.random() * Math.PI * 2, v = .08 + Math.random() * .9; sp.push(Math.cos(u) * Math.cos(v) * 600, Math.sin(v) * 600, Math.sin(u) * Math.cos(v) * 600); }
starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
const starMat = new THREE.PointsMaterial({ color: 0xfff6d8, size: 1, sizeAttenuation: false, fog: false, transparent: true, opacity: 0 });
const stars = new THREE.Points(starGeo, starMat); scene.add(stars);
const discMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
const disc = new THREE.Mesh(new THREE.CircleGeometry(26, 10), discMat); scene.add(disc);

/* player */
const BOX = new THREE.BoxGeometry(1, 1, 1);
function person(coat, hatCol) {
  const g = new THREE.Group(), L = c => new THREE.MeshLambertMaterial({ color: c }), add = (m, sx, sy, sz, x, y, z, p) => { const o = new THREE.Mesh(BOX, m); o.scale.set(sx, sy, sz); o.position.set(x, y, z); (p || g).add(o); return o; };
  const legs = [], arms = [];
  for (const s of [-1, 1]) { const piv = new THREE.Group(); piv.position.set(s * .2, .95, 0); g.add(piv); add(L('#33291f'), .3, .95, .32, 0, -.47, 0, piv); legs.push(piv); }
  const torso = add(L(coat), .85, 1.05, .5, 0, 1.45, 0);
  for (const s of [-1, 1]) { const piv = new THREE.Group(); piv.position.set(s * .55, 1.9, 0); g.add(piv); add(L(coat), .25, .9, .28, 0, -.42, 0, piv); arms.push(piv); }
  add(L('#d11f22'), .75, .2, .55, 0, 1.95, 0); add(L('#d11f22'), .18, .6, .08, .15, 1.65, -.3);
  const head = new THREE.Group(); head.position.set(0, 2.05, 0); g.add(head); // Runde 105: head on a neck pivot (look around, nod)
  add(L('#d8a27a'), .52, .52, .5, 0, .25, 0, head);
  add(L(hatCol), 1, .08, 1, 0, .53, 0, head); add(L(hatCol), .55, .28, .55, 0, .67, 0, head); add(L('#2f4f9a'), .57, .08, .57, 0, .57, 0, head);
  add(L('#5a3a26'), .6, .7, .25, 0, 1.5, -.36);
  g.scale.setScalar(.72); g.userData = { legs, arms, head, torso };
  return g;
}
const player = new THREE.Group(); player.rotation.order = 'YXZ'; scene.add(player); // Runde 106: jointed figure from figur.js (role catalog)
HXFIG.make(HXFIG.byId(store.get('hx.figur') || 'wanderer'), player);
function setFigur(id) { const d = HXFIG.byId(id); store.set('hx.figur', d.id); HXFIG.make(d, player); if (!store.get('hx.itemSet')) HAND.id = d.item || 'nichts'; setItem(HAND.id); for (const b of document.querySelectorAll('#figSeg .fzcard')) b.setAttribute('aria-pressed', b.dataset.id === d.id ? 'true' : 'false'); }

/* Runde 105: standing is never frozen, and the figure can hold things.
   Like most games: (1) a base idle that always runs - breathing, a slow weight shift, the head looking around now and then;
   (2) after a few seconds without input an occasional "fidget" (look at the watch, stretch, fix the hat, tap the foot, look at
   the item in the hand); every fidget blends in and out, any movement stops it at once.
   Held item: a small pixel sprite (16 x 16, drawn in code) in the right hand; the right arm holds it in front of the body. */
const ITEMS = { nichts: null, lupe: 'Lupe', brief: 'Brief', karte: 'Karte', lampe: 'Taschenlampe', gewehr: 'Gewehr' };
function itemTex(id) { // pixel art, 16 px (the rifle 32 px wide)
  const W = id === 'gewehr' ? 32 : 16, c = document.createElement('canvas'); c.width = W; c.height = 16; const g = c.getContext('2d'), px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
  if (id === 'lupe') { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 6, y - 6); if (d < 4.1) px(x, y, (x < 6 && y < 5 && d > 2) ? '#ffffff' : '#a9d8f5'); else if (d < 5.6) px(x, y, '#3a2a1a'); }
    for (let k = 0; k < 6; k++) { px(10 + k, 10 + k, '#6b4423'); px(11 + k, 10 + k, '#8a5a30'); px(10 + k, 11 + k, '#4a2e17'); } }
  if (id === 'brief') { g.fillStyle = '#7a6a50'; g.fillRect(1, 3, 14, 10); g.fillStyle = '#f2ead8'; g.fillRect(2, 4, 12, 8); for (let k = 0; k < 6; k++) { px(2 + k, 4 + k * .66 | 0, '#b9ab8c'); px(13 - k, 4 + k * .66 | 0, '#b9ab8c'); } g.fillStyle = '#c4262a'; g.fillRect(7, 7, 2, 2); }
  if (id === 'karte') { g.fillStyle = '#d9c896'; g.fillRect(1, 2, 14, 12); g.fillStyle = '#c4b27a'; g.fillRect(5, 2, 1, 12); g.fillRect(10, 2, 1, 12); g.fillStyle = '#5f8a4a'; g.fillRect(2, 4, 3, 3); g.fillRect(11, 9, 3, 3); g.fillStyle = '#4f80a2'; g.fillRect(6, 9, 4, 2); g.fillStyle = '#c4262a'; px(8, 5, '#c4262a'); px(9, 6, '#c4262a'); px(9, 4, '#c4262a'); px(10, 5, '#c4262a'); g.fillStyle = '#6b5a3a'; g.fillRect(1, 2, 14, 1); g.fillRect(1, 13, 14, 1); }
  if (id === 'lampe') { g.fillStyle = '#2b2d33'; g.fillRect(2, 6, 8, 4); g.fillStyle = '#4a4d55'; g.fillRect(2, 6, 8, 1); g.fillStyle = '#8c9096'; g.fillRect(10, 5, 2, 6); g.fillStyle = '#fff3a8'; g.fillRect(12, 5, 2, 6); g.fillStyle = '#c4262a'; g.fillRect(5, 5, 2, 1); }
  if (id === 'gewehr') { g.fillStyle = '#6b4423'; g.fillRect(1, 6, 9, 5); g.fillRect(2, 11, 5, 3); g.fillStyle = '#8a5a30'; g.fillRect(1, 6, 9, 1); g.fillStyle = '#2b2d33'; g.fillRect(9, 6, 8, 4); g.fillRect(17, 7, 14, 2); g.fillStyle = '#4a4d55'; g.fillRect(11, 4, 5, 2); g.fillRect(12, 10, 3, 4); g.fillStyle = '#7a7e86'; g.fillRect(17, 7, 14, 1); }
  { // Runde 107 (pixel art practice: silhouette first): 1 px dark outline around the item, so it reads at any size
    const o = document.createElement('canvas'); o.width = W + 2; o.height = 18; const og = o.getContext('2d'), src = g.getImageData(0, 0, W, 16).data, im = og.createImageData(W + 2, 18);
    const A = (x, y) => x >= 0 && y >= 0 && x < W && y < 16 && src[(y * W + x) * 4 + 3] > 100;
    for (let y = 0; y < 18; y++) for (let x = 0; x < W + 2; x++) { const q = (y * (W + 2) + x) * 4, sx = x - 1, sy = y - 1;
      if (A(sx, sy)) { const k = (sy * W + sx) * 4; im.data[q] = src[k]; im.data[q + 1] = src[k + 1]; im.data[q + 2] = src[k + 2]; im.data[q + 3] = 255; }
      else if (A(sx - 1, sy) || A(sx + 1, sy) || A(sx, sy - 1) || A(sx, sy + 1)) { im.data[q] = 22; im.data[q + 1] = 18; im.data[q + 2] = 16; im.data[q + 3] = 255; } }
    og.putImageData(im, 0, 0); const t = new THREE.CanvasTexture(o); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return { t, w: (W + 2) / 18 }; }
}
const HAND = { id: store.get('hx.item') || 'nichts', spr: null };
/* Runde 195 (phone: the rifle points sideways): held items are sprites - always facing the camera, drawn pointing right. The rifle now
   follows where the figure looks on screen: turned to the figure's facing direction projected into the picture, mirrored when that
   points left (grip stays in the hand), and shortened when the figure looks towards or away from the camera. */
const _ha = new THREE.Vector3(), _hb = new THREE.Vector3(), _hc = new THREE.Vector3(), _hr = new THREE.Vector3();
/* Runde 201 (phone: the fixed angles never quite fitted - a flat sprite has no perspective): the rifle is an axis billboard - its
   picture lies on an invisible flat quad whose long side runs in 3D along the rifle (where the figure looks, a little outwards and
   up) and which only turns about that axis to face the camera. The camera's own perspective then shortens and turns it: walking
   away it gets short and points slightly ahead, from the side it is long. Top of the picture always up; grip at 25 % / 38 %. */
const _hu = new THREE.Vector3(), _hs = new THREE.Vector3(), _hn = new THREE.Vector3(), _hm = new THREE.Matrix4();
/* Runde 202: every item with a direction uses it - grip point in the picture (gu, gv), size, tilt up (+) or down (-) */
const AXIS = { gewehr: { gu: .25, gv: .38, sz: 1.05, up: .12 }, lampe: { gu: .4, gv: .42, sz: .72, up: -.06 } };
function aimHand(cam) { const s = HAND.spr, A = AXIS[HAND.id]; if (!s || !A || !s.userData.anchor) return;
  s.visible = player.visible; if (!s.visible) return;
  s.userData.anchor.getWorldPosition(_ha); player.getWorldPosition(_hb); const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
  let ox = _ha.x - _hb.x, oz = _ha.z - _hb.z; const along = ox * fx + oz * fz; ox -= fx * along; oz -= fz * along; const ol = Math.hypot(ox, oz) || 1; // outwards: hand side
  _hu.set(fx + ox / ol * .16, A.up, fz + oz / ol * .16).normalize();
  if (cam.isOrthographicCamera) _hc.setFromMatrixColumn(cam.matrixWorld, 2); else _hc.copy(cam.position).sub(_ha); _hc.normalize(); // towards the camera
  _hs.crossVectors(_hc, _hu); if (_hs.lengthSq() < 1e-6) _hs.set(0, 1, 0); _hs.normalize(); if (_hs.y < 0) _hs.negate(); // across the rifle, in the picture, top up
  _hn.crossVectors(_hu, _hs); const L = s.userData.len, H = s.userData.h;
  _hm.makeBasis(_hr.copy(_hu).multiplyScalar(L), _hb.copy(_hs).multiplyScalar(H), _hn);
  const gu = .5 - A.gu, gv = .5 - A.gv; _hm.setPosition(_ha.x + _hu.x * L * gu + _hs.x * H * gv, _ha.y + _hu.y * L * gu + _hs.y * H * gv, _ha.z + _hu.z * L * gu + _hs.z * H * gv);
  s.matrix.copy(_hm); s.matrixWorldNeedsUpdate = true; }
function setItem(id) {
  if (!(id in ITEMS)) id = 'nichts'; HAND.id = id; store.set('hx.item', id);
  if (HAND.spr) { const an = HAND.spr.userData.anchor; if (an) an.parent.remove(an); HAND.spr.parent.remove(HAND.spr); HAND.spr.material.map.dispose(); HAND.spr.material.dispose(); if (HAND.spr.isMesh) HAND.spr.geometry.dispose(); HAND.spr = null; }
  if (AXIS[id]) { const { t, w } = itemTex(id), m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: t, alphaTest: .5, side: THREE.DoubleSide })); // Runde 201: axis billboard, see aimHand
    m.matrixAutoUpdate = false; m.frustumCulled = false; m.userData.len = AXIS[id].sz * w; m.userData.h = AXIS[id].sz; const an = new THREE.Object3D(); an.position.set(0, -.04, .08); player.userData.hand[0].add(an); m.userData.anchor = an; scene.add(m); HAND.spr = m; }
  else if (id !== 'nichts') { const { t, w } = itemTex(id), s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, alphaTest: .5 }));
    const sz = id === 'gewehr' ? 1.05 : .72; s.scale.set(sz * w, sz, 1); s.position.set(0, -.04, .08); s.center.set(id === 'gewehr' ? .25 : .5, .38); s.userData.w = w; /* Runde 107: held items oversized, like in pixel games */ player.userData.hand[0].add(s); HAND.spr = s; }
  for (const b of document.querySelectorAll('#itemSeg button')) b.setAttribute('aria-pressed', b.dataset.item === id ? 'true' : 'false'); }
for (const id in ITEMS) { const b = document.createElement('button'); b.type = 'button'; b.dataset.item = id; b.textContent = ITEMS[id] || 'Nichts'; b.addEventListener('click', () => { store.set('hx.itemSet', true); setItem(id); }); $('itemSeg').appendChild(b); }
setItem(HAND.id);
for (const r of HXFIG.KATALOG) { const b = document.createElement('button'); b.type = 'button'; b.className = 'fzcard'; b.dataset.id = r.id; b.innerHTML = '<span class="fzpic"><img src="figuren/' + r.id + '.png?v=441" alt="" onerror="this.remove()"></span><b>' + r.name + '</b><small>' + r.gruppe + '</small>'; b.addEventListener('click', () => setFigur(r.id)); $('figSeg').appendChild(b); }
function addEigenCard() { // Runde 113: the figure made in the editor comes first in the carousel
  const d = store.get('hx.figurEigen'); if (!d) return; let b = document.querySelector('#figSeg [data-id=eigen]');
  if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'fzcard'; b.dataset.id = 'eigen'; b.addEventListener('click', () => setFigur('eigen')); $('figSeg').prepend(b); }
  const img = store.get('hx.figurEigenBild'); b.innerHTML = '<span class="fzpic">' + (img ? '<img src="' + img + '" alt="">' : '') + '</span><b>Eigene Figur</b><small>Editor</small>'; }
addEigenCard();
setFigur(store.get('hx.figur') || 'wanderer');
const FIGS = { air: 0, wasAir: false, land: 0 };
const IDLE = { still: 0, next: 5 + Math.random() * 4, act: null, t: 0, dur: 0, look: 0, lookTo: 0, lookNext: 2 };
const IDLE_ACTS = ['uhr', 'strecken', 'hut', 'fuss', 'umschauen'];
function idleLife(dt, amt) {
  const ud = player.userData, still = !DRV.on && P.ground && amt < .05, w = Math.max(0, 1 - amt * 3) * (DRV.on ? 0 : 1);
  const tt = performance.now() / 1000, lerp = (a, b, k) => a + (b - a) * k;
  IDLE.still = still ? IDLE.still + dt : 0;
  if (!still) IDLE.act = null; // any movement ends a fidget at once
  // base idle: breathing, weight shift, look around
  ud.chest.scale.y = 1 + Math.sin(tt * 1.7) * .018 * w; ud.chest.scale.x = ud.chest.scale.z = 1 + Math.sin(tt * 1.7) * .012 * w;
  player.rotation.z = Math.sin(tt * .55) * .025 * w;
  if ((IDLE.lookNext -= dt) <= 0) { IDLE.lookNext = 2.5 + Math.random() * 4; IDLE.lookTo = Math.random() < .35 ? 0 : (Math.random() - .5) * 1.3; }
  IDLE.look = lerp(IDLE.look, IDLE.lookTo * w, Math.min(1, dt * 3));
  let hy = IDLE.look, hx = ud.neck.rotation.x + Math.sin(tt * .9) * .04 * w;
  let a0x = ud.upper[0].rotation.x, a0z = ud.upper[0].rotation.z, a1x = ud.upper[1].rotation.x + Math.sin(tt * 1.7 + 1) * .04 * w, a1z = ud.upper[1].rotation.z, l0x = ud.thigh[0].rotation.x;
  if (HAND.spr) { a0x = lerp(-.55, a0x, .3); ud.fore[0].rotation.x = -.9; } // holding something: right arm in front of the body, the walk swing only a little
  // fidgets: after standing still a while, now and then
  if (still && !IDLE.act && IDLE.still > IDLE.next) { IDLE.act = HAND.spr && HAND.id !== 'gewehr' && Math.random() < .5 ? 'ansehen' : IDLE_ACTS[(Math.random() * IDLE_ACTS.length) | 0]; IDLE.t = 0; IDLE.dur = { uhr: 2.4, strecken: 2.2, hut: 1.8, fuss: 2.4, umschauen: 3, ansehen: 2.8 }[IDLE.act]; }
  if (IDLE.act) { IDLE.t += dt; const k = IDLE.t / IDLE.dur, e = Math.sin(Math.PI * Math.min(1, k)) ** .6; // blend in and out
    if (IDLE.act === 'uhr') { a1x = lerp(a1x, -1.35, e); a1z = -.7 * e; hx = lerp(hx, .35, e); hy = lerp(hy, -.25, e); }
    else if (IDLE.act === 'strecken') { a0x = lerp(a0x, -2.9, e); a1x = lerp(a1x, -2.9, e); a0z = .35 * e; a1z = -.35 * e; hx = lerp(hx, -.25, e); ud.chest.scale.y *= 1 + .05 * e; }
    else if (IDLE.act === 'hut') { a0x = lerp(a0x, -2.7, e); a0z = -.55 * e; hx = lerp(hx, .12, e); hy = lerp(hy, .15, e); }
    else if (IDLE.act === 'fuss') { l0x = -Math.max(0, Math.sin(IDLE.t * 11)) * .28 * e; }
    else if (IDLE.act === 'umschauen') { hy = Math.sin(k * Math.PI * 2) * .9 * e; }
    else if (IDLE.act === 'ansehen') { a0x = lerp(a0x, -1.55, e); a0z = -.35 * e; hx = lerp(hx, .4, e); }
    if (k >= 1) { IDLE.act = null; IDLE.still = 0; IDLE.next = 6 + Math.random() * 8; } }
  ud.upper[0].rotation.x = a0x; ud.upper[0].rotation.z = a0z; ud.upper[1].rotation.x = a1x; ud.upper[1].rotation.z = a1z; ud.thigh[0].rotation.x = l0x;
  ud.neck.rotation.set(hx, hy, 0);
  if (HAND.spr) { const n = Math.max(0, Math.min(1, (cur.lamp || 0) / 1.5)); HAND.spr.material.color.setScalar(1 - n * .55); } // sprites are unlit: darker at night
}

/* orbs + goal beacon */
const orbMat = new THREE.MeshBasicMaterial({ color: 0xffd35c, fog: false });
const orbGeo = new THREE.IcosahedronGeometry(.6, 0);
const orbs = [];
const beacon = new THREE.Group(); scene.add(beacon);
const beamMat = new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: .32, depthWrite: false, fog: false });
{ const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 90, 8, 1, true), beamMat); beam.position.y = 45; beacon.add(beam);
  const star = new THREE.Mesh(new THREE.OctahedronGeometry(2.4, 0), orbMat); star.position.y = 8; beacon.add(star); beacon.userData.star = star; }

const MX_COL = { gruen: ['#7dff9a', '#00c853'], cyan: ['#b8fbff', '#00b8d4'], gold: ['#fff1b0', '#e0a000'], rot: ['#ffc0b8', '#e01b24'], violett: ['#f0c8ff', '#9c27e0'], weiss: ['#ffffff', '#9aa4b0'], regenbogen: null };
const MX_SET = { katakana: 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789', binaer: '01', hex: '0123456789ABCDEF',
  latein: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', runen: 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ', bloecke: '█▓▒░▀▄▌▐■□▪▫', pfeile: '←↑→↓↖↗↘↙⇐⇑⇒⇓' };

// glyph atlas for the Matrix style: 16 symbols of the chosen set, 8 x 8 px each, white on black (colour comes from the shader)
const mxTex = (() => { const cv = document.createElement('canvas'); cv.width = 128; cv.height = 8; const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return t; })(), mxCv = mxTex.image; let mxDone = false;
function mxAtlas() { const set = MX_SET[store.get('hx.mxSet') || 'katakana'] || MX_SET.katakana, g = mxCv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 8); g.fillStyle = '#fff'; g.font = 'bold 9px monospace'; g.textBaseline = 'top';
  for (let i = 0; i < 16; i++) g.fillText(set[(i * 7) % set.length], i * 8, 0);
  // hard pixels: threshold the antialiased glyphs
  const d = g.getImageData(0, 0, 128, 8); for (let i = 0; i < d.data.length; i += 4) { const v = d.data[i] > 45 ? 255 : 0; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; } g.putImageData(d, 0, 0); mxTex.needsUpdate = true;
  const c = MX_COL[store.get('hx.mxColor') || 'gruen'] || ['#c8ffd0', '#00c853']; if (post) { post.uniforms.uMxA.value.set(c[0]); post.uniforms.uMxB.value.set(c[1]); post.uniforms.uMxRb.value = MX_COL[store.get('hx.mxColor')] === null ? 1 : 0; } }
/* ================================================================ post (pixel + palette + edges + Sin City) */
const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); dummy.needsUpdate = true;
const post = new THREE.ShaderMaterial({
  uniforms: { tColor: { value: null }, tDepth: { value: dummy }, uRes: { value: new THREE.Vector2(1, 1) }, uPal: { value: new Float32Array(36) },
    uPS: { value: 0 }, uDith: { value: 0 }, uSin: { value: 0 }, uEdge: { value: .4 }, uHasDepth: { value: hasDepth ? 1 : 0 }, uNear: { value: .5 }, uFar: { value: 1000 }, uOrtho: { value: 0 },
    uSat: { value: 1 }, uCon: { value: 1 }, uTint: { value: new THREE.Vector3(1, 1, 1) },
    uMx: { value: 0 }, tGlyph: { value: mxTex }, uTime: waterTime, uMxA: { value: new THREE.Color('#c8ffd0') }, uMxB: { value: new THREE.Color('#00c853') }, uMxRb: { value: 0 }, uVeil: { value: 0 },
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uFlow: { value: new THREE.Vector2(0, 1) }, uPxW: { value: .002 }, uPxO: { value: .1 } },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
  fragmentShader: `
  uniform sampler2D tColor;uniform sampler2D tDepth;uniform vec2 uRes;uniform vec3 uPal[12];
  uniform float uPS,uDith,uSin,uEdge,uHasDepth,uNear,uFar,uSat,uCon,uOrtho,uMx,uTime,uMxRb;uniform vec3 uTint,uMxA,uMxB;uniform sampler2D tGlyph;varying vec2 vUv;
  float lin(float d){if(uOrtho>0.5)return uNear+d*(uFar-uNear);float z=d*2.0-1.0;return (2.0*uNear*uFar)/(uFar+uNear-z*(uFar-uNear));}
  uniform float uVeil;uniform mat4 uInvProj,uCamWorld;uniform vec3 uCamPos;uniform vec2 uFlow;uniform float uPxW,uPxO;
  vec3 wpos(vec2 p,float d){vec4 v=uInvProj*vec4(p*2.0-1.0,d*2.0-1.0,1.0);v/=v.w;return (uCamWorld*vec4(v.xyz,1.0)).xyz;}
  float b2(vec2 a){a=floor(a);return fract(a.x*0.5+a.y*a.y*0.75);}
  float bayer(vec2 a){return b2(0.5*a)*0.25+b2(a);}
  void main(){
    vec2 px=floor(vUv*uRes);vec2 uv=(px+0.5)/uRes;vec2 t=1.0/uRes;
    vec3 raw=texture2D(tColor,uv).rgb;
    vec3 c=raw*uTint;
    float l=dot(c,vec3(0.299,0.587,0.114));
    c=mix(vec3(l),c,uSat);
    c=(c-0.5)*uCon+0.5;
    float bd=bayer(px)-0.5;
    c=clamp(c+bd*uDith,0.0,1.0);
    vec3 col=c;
    if(uPS>0.001){
      vec3 best=uPal[0];float dist=1e9;
      for(int i=0;i<12;i++){vec3 d=c-uPal[i];float dd=dot(d*d,vec3(0.3,0.59,0.11));if(dd<dist){dist=dd;best=uPal[i];}}
      col=mix(c,best,uPS);
    }
    float e=0.0;
    if(uHasDepth>0.5){
      float d0=lin(texture2D(tDepth,uv).r);
      float m=max(max(lin(texture2D(tDepth,uv-vec2(t.x,0.)).r),lin(texture2D(tDepth,uv+vec2(t.x,0.)).r)),
                  max(lin(texture2D(tDepth,uv-vec2(0.,t.y)).r),lin(texture2D(tDepth,uv+vec2(0.,t.y)).r)));
      e=uOrtho>0.5?clamp((m-d0-1.2)*0.5,0.0,1.0):clamp(((m-d0)/d0-0.07)*6.0,0.0,1.0); // isometric: depth steps in metres
    }
    if(uHasDepth>0.5&&uOrtho<0.5){float dz=lin(texture2D(tDepth,uv).r);e*=1.0-smoothstep(350.0,900.0,dz);} // no outlines far away (stripes at the horizon)
    col*=1.0-uEdge*0.6*e;
    // pixel-art look for houses (like hand-drawn sprites): a dark 1-px line where a face meets a clearly brighter one,
    // and a light rim along upper edges (roof edges, eaves, parapets) where the pixel above lies much farther away
    {
      float l0=dot(raw,vec3(0.299,0.587,0.114));
      float lm=max(max(dot(texture2D(tColor,uv-vec2(t.x,0.)).rgb,vec3(0.299,0.587,0.114)),dot(texture2D(tColor,uv+vec2(t.x,0.)).rgb,vec3(0.299,0.587,0.114))),
                   max(dot(texture2D(tColor,uv-vec2(0.,t.y)).rgb,vec3(0.299,0.587,0.114)),dot(texture2D(tColor,uv+vec2(0.,t.y)).rgb,vec3(0.299,0.587,0.114))));
      float crease=clamp((lm-l0-0.16)*4.0,0.0,1.0);
      if(uHasDepth>0.5&&uOrtho<0.5){float dz=lin(texture2D(tDepth,uv).r);crease*=1.0-smoothstep(350.0,900.0,dz);}
      col*=1.0-uEdge*0.45*crease;
      if(uHasDepth>0.5){
        float d0=lin(texture2D(tDepth,uv).r),du=lin(texture2D(tDepth,uv+vec2(0.,t.y)).r);
        float rim=uOrtho>0.5?clamp((du-d0-2.0)*0.4,0.0,1.0):clamp(((du-d0)/d0-0.12)*5.0,0.0,1.0);
        if(d0>300.0) rim=0.0;
        col=mix(col,min(col*1.28+0.06,vec3(1.0)),uEdge*0.7*rim);
      }
    }
    if(uSin>0.001){
      float sl=dot(raw*uTint,vec3(0.299,0.587,0.114));
      sl=clamp((sl-0.45)*1.7+0.5+bd*0.12,0.0,1.0);
      float q=floor(sl*3.0+0.5)/3.0;
      bool red=raw.r>0.22&&raw.r>raw.g*2.0&&raw.r>raw.b*2.0;
      vec3 sc=red?vec3(0.86,0.05,0.07):vec3(q);
      sc*=1.0-e;
      col=mix(col,sc,uSin);
    }
    if(uMx>0.001){ // Matrix (Runde 58): glyphs live on the surfaces in world space - on walls they fall down, on floors, streets and
      // roofs they stream along towards the camera; edges glow. World position from the depth image, the face direction from the neighbours.
      float dC=texture2D(tDepth,uv).r; vec3 mxc;
      if(uHasDepth<0.5||dC>0.99999){ mxc=uMxB*0.03; } // sky: dark (the scene fills with code as the world loads)
      else {
        vec3 w=wpos(uv,dC), wl=wpos(uv-vec2(t.x,0.),texture2D(tDepth,uv-vec2(t.x,0.)).r), wr=wpos(uv+vec2(t.x,0.),texture2D(tDepth,uv+vec2(t.x,0.)).r);
        vec3 wd=wpos(uv-vec2(0.,t.y),texture2D(tDepth,uv-vec2(0.,t.y)).r), wu=wpos(uv+vec2(0.,t.y),texture2D(tDepth,uv+vec2(0.,t.y)).r);
        vec3 ex=length(wr-w)<length(w-wl)?wr-w:w-wl, ey=length(wu-w)<length(w-wd)?wu-w:w-wd; vec3 n=normalize(cross(ex,ey)+1e-6);
        float dist=length(w-uCamPos), ps=uOrtho>0.5?uPxO:dist*uPxW;
        // edges: a jump to ONE side (silhouette, step) or a fold between faces; a jump to both sides is a single pixel of a
        // see-through house or a sprite fringe - no edge there (else the dissolving house sparkled bright)
        // Runde 59: outer edges only - this pixel lies in front and a neighbour clearly behind it (silhouette against what is
        // behind or the sky); measured in view distance (robust against the coarse depth of phones), one-sided (a slope is not an edge)
        float z0=lin(dC), zL=lin(texture2D(tDepth,uv-vec2(t.x,0.)).r), zR=lin(texture2D(tDepth,uv+vec2(t.x,0.)).r), zD=lin(texture2D(tDepth,uv-vec2(0.,t.y)).r), zU=lin(texture2D(tDepth,uv+vec2(0.,t.y)).r);
        float jx=max(zL,zR)-z0, kx=z0-min(zL,zR), jy=max(zD,zU)-z0, ky=z0-min(zD,zU), th=uOrtho>0.5?1.5:z0*0.08;
        float crease=((jx>th&&jx>kx*4.0)||(jy>th&&jy>ky*4.0))?1.0:0.0;
        vec2 q; float pid;
        if(abs(n.y)>0.7){ q=vec2(dot(w.xz,uFlow.yx*vec2(-1.,1.)),dot(w.xz,uFlow)); pid=floor(w.y*2.0); } // floor/roof: streams run towards the camera
        else { vec2 tg=normalize(vec2(-n.z,n.x)+1e-6); q=vec2(dot(w.xz,tg),w.y); pid=floor(dot(w.xz,normalize(n.xz+1e-6)))+floor(atan(n.z,n.x)*2.0)*37.0; } // wall: columns fall down
        float cs=max(0.55,exp2(ceil(log2(ps*5.0))));                   // a glyph at least 5 render pixels tall; coarser far away (no shimmer)
        vec2 cell=floor(q/cs), lp=fract(q/cs);
        float h1=fract(sin(cell.x*12.9898+pid*78.233)*43758.5), rate=(1.4+h1*2.6)*0.55/cs;
        float dy=mod(cell.y+uTime*rate*cs/0.55+h1*61.0,26.0);           // 0 at the falling head, growing upwards behind it
        float trail=exp(-dy*0.22);
        float gi=floor(fract(sin(dot(cell,vec2(41.3,289.1))+pid*3.1+floor(uTime*(dy<1.0?9.0:0.6+h1)))*9573.1)*16.0);
        vec2 gq=floor(vec2(lp.x,1.0-lp.y)*8.0);
        float gp=texture2D(tGlyph,vec2((gi*8.0+gq.x+0.5)/128.0,1.0-(gq.y+0.5)/8.0)).r;
        float cl=dot(raw*uTint,vec3(0.299,0.587,0.114)), eg=crease*(1.0-smoothstep(250.0,700.0,dist));
        float lev=(0.12+0.4*clamp(cl,0.0,1.0))*(0.22+1.5*trail);
        vec3 cB=uMxB,cA=uMxA; if(uMxRb>0.5){ float hu=fract(cell.x*0.031+pid*0.07+uTime*0.05); cB=clamp(abs(fract(hu+vec3(0.,.333,.667))*6.0-3.0)-1.0,0.0,1.0); cA=mix(cB,vec3(1.0),0.6); }
        vec3 g=mix(cB,cA,clamp(trail*1.3-0.25,0.0,1.0))*lev*gp;
        mxc=g+cB*(0.06*cl)+mix(cB,cA,0.6)*eg*0.85;                      // glyphs + faint surface glow + bright edges
        mxc*=1.0-smoothstep(500.0,1400.0,dist)*0.7;                     // distance: darker
      }
      col=mix(col,mxc,uMx);
    }
    if(uVeil>0.001){ // loading veil (Runde 59): the classic screen rain over everything, strongest at the very start
      vec2 cell=floor(px/6.0), lp=floor(mod(px,6.0));
      float h1=fract(sin(cell.x*12.9898)*43758.5), rows=uRes.y/6.0, head=fract(uTime*(0.35+h1*0.6)*0.18+h1*7.0)*(rows+18.0)-9.0;
      float dy=head-(rows-cell.y), tr=dy>=0.0?exp(-dy*0.2):0.0;
      float gi=floor(fract(sin(dot(cell,vec2(41.3,289.1))+floor(uTime*(dy>=0.0&&dy<1.0?9.0:1.5)))*9573.1)*16.0);
      vec2 gq=floor((lp+0.5)/6.0*8.0); float gp=texture2D(tGlyph,vec2((gi*8.0+gq.x+0.5)/128.0,1.0-(gq.y+0.5)/8.0)).r;
      vec3 vB=uMxB,vA=uMxA; if(uMxRb>0.5){ float hu=fract(cell.x*0.031+uTime*0.05); vB=clamp(abs(fract(hu+vec3(0.,.333,.667))*6.0-3.0)-1.0,0.0,1.0); vA=mix(vB,vec3(1.0),0.6); }
      vec3 vg=mix(vB,vA,clamp(tr*1.3-0.25,0.0,1.0))*gp*(0.12+1.3*tr);
      col=col*(1.0-0.6*uVeil)+vg*uVeil;
    }
    gl_FragColor=vec4(col,1.0);
  }`,
  depthTest: false, depthWrite: false });
const postScene = new THREE.Scene(), postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));

let rt = null, userPx = store.get('hx.px') || 3, pxSize = userPx;
function makeRT() {
  const w = Math.max(1, view.clientWidth | 0), h = Math.max(1, view.clientHeight | 0);
  const rw = Math.ceil(w / pxSize), rh = Math.ceil(h / pxSize);
  /* Runde 129 (more fps): the post pass (palette, edges, Matrix) used to run for every screen pixel (x1.25 DPR) although it rounds
     to the block grid anyway - every pixel of a block got the same result. Now the canvas is exactly as large as the render target
     and the browser enlarges it without smoothing (#view image-rendering:pixelated): same picture, post work / (pxSize*1.25)^2 */
  renderer.setSize(rw, rh, false);
  camera.aspect = w / h; camera.updateProjectionMatrix(); fitIso();
  if (rt) { rt.dispose(); if (rt.depthTexture) rt.depthTexture.dispose(); }
  rt = new THREE.WebGLRenderTarget(rw, rh, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false });
  if (hasDepth) { rt.depthTexture = new THREE.DepthTexture(rw, rh); rt.depthTexture.type = THREE.UnsignedIntType; } // 24-bit depth: no striping between flat ground layers
  post.uniforms.tColor.value = rt.texture; post.uniforms.tDepth.value = hasDepth ? rt.depthTexture : dummy; post.uniforms.uRes.value.set(rw, rh);
}
addEventListener('resize', makeRT);

/* ================================================================ moods */
const GRAY = ['#000000', '#1a1a1a', '#333333', '#4d4d4d', '#666666', '#808080', '#999999', '#b3b3b3', '#cccccc', '#e6e6e6', '#ffffff', '#000000'];
const MOODS = [
 { id: 'spielzeug', name: 'Spielzeugstadt', hint: 'Bunt, sonnig, klare Kanten', sky: '#8fcff2', fog: '#bfe4f5', fogD: .0045, hs: '#f4fbff', hg: '#c4b49a', hi: .9, sun: '#fff6e0', si: .95, dir: [.45, .8, .35], glass: '#3f6a9a', glow: '#000000', stars: 0, lamp: 0, disc: '#fffbe8', orb: '#ffcf3c', tint: '#fbfbff', sat: 1.35, con: 1.1, ps: 0, dith: 0, sin: 0, edge: .8, pal: GRAY, sw: ['#e8873a', '#3a6fc0', '#f2c43c', '#3f9a5a', '#d8443a', '#8fcff2'] },
 { id: 'original', name: 'Original', hint: 'Echte Farben, keine Palette', sky: '#a8c8e0', fog: '#c4d6e2', fogD: .0055, hs: '#e6f0ff', hg: '#b8ae9c', hi: .8, sun: '#ffffff', si: .85, dir: [.4, .85, .3], glass: '#46566a', glow: '#000000', stars: 0, lamp: 0, disc: '#fffbe8', orb: '#ffcf3c', tint: '#ffffff', sat: 1, con: 1, ps: 0, dith: 0, sin: 0, edge: .35, pal: GRAY, sw: ['#e8e2d5', '#9e5846', '#4a4e54', '#6f8a4a', '#7fa6b8', '#d9c48f'] },
 { id: 'morgen', name: 'Morgendunst', hint: '6 bis 10 Uhr', sky: '#c9d6dc', fog: '#c9d6dc', fogD: .011, hs: '#dbe6ee', hg: '#7d7a68', hi: .8, sun: '#ffd9b8', si: .7, dir: [-.6, .35, .5], glass: '#56606c', glow: '#000000', stars: 0, lamp: 0, disc: '#fff1dc', orb: '#ffc35c', tint: '#f2f2f5', sat: .85, con: .95, ps: .5, dith: .06, sin: 0, edge: .45,
  pal: ['#1f2a3a', '#3b4a5e', '#5d6f84', '#8aa0b2', '#c3d1d8', '#eef0ea', '#f1c9a8', '#d99a7c', '#9c6b5c', '#6b7a52', '#9db07a', '#d8d3b5'] },
 { id: 'mittag', name: 'Sommermittag', hint: '10 bis 17 Uhr', sky: '#9ec3d6', fog: '#b9d3dc', fogD: .007, hs: '#d6e8ff', hg: '#b0a080', hi: .7, sun: '#fff0d0', si: .95, dir: [.4, .85, .3], glass: '#3c4a5c', glow: '#000000', stars: 0, lamp: 0, disc: '#fffbe8', orb: '#ffcf3c', tint: '#fff8ea', sat: .92, con: 1.05, ps: .45, dith: .05, sin: 0, edge: .5,
  pal: ['#2b2622', '#4a4e54', '#6f6a5f', '#9e5846', '#c27c5a', '#e8e2d5', '#d9c48f', '#a8b06a', '#6f8a4a', '#3f5b3a', '#7fa6b8', '#b9d3dc'] },
 { id: 'gold', name: 'Goldene Stunde', hint: '17 bis 21 Uhr', sky: '#f0b27a', fog: '#e9a27a', fogD: .009, hs: '#ffcf9a', hg: '#5a3f5a', hi: .55, sun: '#ffb066', si: 1.05, dir: [.9, .22, -.3], glass: '#5a4a50', glow: '#6a5030', stars: 0, lamp: .5, disc: '#ffe2a0', orb: '#fff0a0', tint: '#ffe8d0', sat: 1.05, con: 1.05, ps: .55, dith: .07, sin: 0, edge: .5,
  pal: ['#24182a', '#4a2c3f', '#7a3d48', '#b5574a', '#e08a4f', '#f5c56b', '#fbe7b5', '#8c6a8f', '#5a5f8a', '#3d6b5a', '#a3a35a', '#d9a07a'] },
 { id: 'nacht', name: 'Sternennacht', hint: '21 bis 6 Uhr', sky: '#0d1838', fog: '#13204a', fogD: .01, hs: '#4a6ab8', hg: '#0a0c18', hi: .6, sun: '#9fb6ff', si: .35, dir: [-.4, .6, -.6], glass: '#1a2440', glow: '#ffd27a', stars: 1, lamp: 1.8, disc: '#f6e7b0', orb: '#ffe07a', tint: '#c8d4ff', sat: 1.1, con: 1.1, ps: .6, dith: .08, sin: 0, edge: .55,
  pal: ['#070b1f', '#0e1838', '#1b2c5c', '#2d4a8a', '#4a6fb8', '#8fb0e0', '#f6d36b', '#e8a53c', '#3a3d2a', '#1f3a3a', '#5a4a7a', '#c9d6ff'] },
 { id: 'nebel', name: 'Herbstnebel', hint: 'Regentag', sky: '#a9a99a', fog: '#a9a99a', fogD: .02, hs: '#c8c6b6', hg: '#5a4a3a', hi: .85, sun: '#e8dcc0', si: .35, dir: [.2, .7, .4], glass: '#5a5a58', glow: '#3a3020', stars: 0, lamp: .6, disc: '#d8d4c4', orb: '#ffb35c', tint: '#f0ead8', sat: .7, con: .95, ps: .6, dith: .05, sin: 0, edge: .4,
  pal: ['#2a2a26', '#43443c', '#5f5f52', '#7d7a68', '#9c977f', '#bdb8a3', '#dcd8c6', '#8a5a3a', '#b07a45', '#6b5a3a', '#5f6f5a', '#8e9e8a'] },
 { id: 'sincity', name: 'Sin City', hint: 'Schwarz-Weiß, nur Rot bleibt', sky: '#0b0b0b', fog: '#101010', fogD: .012, hs: '#ffffff', hg: '#222222', hi: .5, sun: '#ffffff', si: 1.15, dir: [-.5, .5, .7], glass: '#202020', glow: '#cccccc', stars: .7, lamp: 1.4, disc: '#ffffff', orb: '#ff1a1a', tint: '#ffffff', sat: 1, con: 1.3, ps: 0, dith: 0, sin: 1, edge: 1, pal: GRAY, sw: ['#000000', '#4d4d4d', '#9a9a9a', '#ffffff', '#d10f14'] },
 { id: 'matrix', name: 'Matrix', hint: 'Alles aus Zeichen – Farbe und Zeichen im Profil', sky: '#000000', fog: '#000000', fogD: .006, hs: '#ffffff', hg: '#444444', hi: .9, sun: '#ffffff', si: .9, dir: [.4, .8, .3], glass: '#101010', glow: '#000000', stars: 0, lamp: 0, disc: '#000000', orb: '#ffffff', tint: '#ffffff', sat: 0, con: 1.2, ps: 0, dith: 0, sin: 0, edge: 1, mx: 1, pal: GRAY, sw: ['#000000', '#003b12', '#00c853', '#c8ffd0'] },
 { id: 'handheld', name: 'Handheld', hint: '4 Grüntöne, grobes Raster', sky: '#9bbc0f', fog: '#8bac0f', fogD: .009, hs: '#ffffff', hg: '#555555', hi: .65, sun: '#ffffff', si: .9, dir: [.4, .8, .3], glass: '#306230', glow: '#000000', stars: 0, lamp: 0, disc: '#9bbc0f', orb: '#ffffff', tint: '#ffffff', sat: 0, con: 1.15, ps: 1, dith: .2, sin: 0, edge: .6,
  pal: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#0f380f', '#306230', '#8bac0f', '#9bbc0f', '#0f380f', '#306230', '#8bac0f', '#9bbc0f'], sw: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] }
];
const C = new THREE.Color(), rgb = h => { C.set(h); return [C.r, C.g, C.b]; };
function flat(m) { const o = { mx: 0 }; for (const k in m) { const v = m[k];
  if (k === 'pal') { o.pal = []; v.forEach(h => o.pal.push(...rgb(h))); }
  else if (typeof v === 'string' && v[0] === '#') o[k] = rgb(v);
  else if (typeof v === 'number') o[k] = v;
  else if (k === 'dir') o.dir = v.slice(); } return o; }
const clone = s => { const o = {}; for (const k in s) o[k] = Array.isArray(s[k]) ? s[k].slice() : s[k]; return o; };
let moodId = store.get('hx.mood') || 'spielzeug';
if (!MOODS.find(m => m.id === moodId)) moodId = 'original';
let cur = flat(MOODS.find(m => m.id === moodId)), from = clone(cur), to = clone(cur), tMix = 1, camMode = 'chase';
function applyMood(s) {
  scene.background.setRGB(...s.sky); scene.fog.color.setRGB(...s.fog); scene.fog.density = s.fogD * VIEW_FOG * (camMode === 'dio' ? .02 : 1); // isometric camera sits ~200 m away
  // the mood values were tuned for the placeholder scene; real map colours are brighter, so light is scaled down to stay below white
  hemi.color.setRGB(...s.hs); hemi.groundColor.setRGB(...s.hg); hemi.intensity = s.hi * .95;
  sun.color.setRGB(...s.sun); sun.intensity = s.si * .62; pLight.intensity = s.lamp;
  bldUniforms.uGlass.value.setRGB(...s.glass); bldUniforms.uGlow.value.setRGB(...s.glow);
  const lit = Math.min(1, (s.glow[0] + s.glow[1] + s.glow[2]) * 1.2);
  lampMat.color.setRGB(.8 + (Math.max(s.glow[0], .8) - .8) * lit, .78 + (s.glow[1] - .78) * lit, .72 + (s.glow[2] - .72) * lit);
  starMat.opacity = s.stars; stars.visible = s.stars > .02; discMat.color.setRGB(...s.disc); orbMat.color.setRGB(...s.orb); beamMat.color.setRGB(...s.orb);
  const u = post.uniforms; u.uPal.value.set(s.pal); u.uPS.value = s.ps; u.uDith.value = s.dith; u.uSin.value = s.sin; u.uEdge.value = s.edge;
  u.uSat.value = s.sat; u.uCon.value = s.con; u.uTint.value.set(...s.tint); u.uMx.value = s.mx || 0; if (s.mx > 0 && !mxDone) { mxDone = true; mxAtlas(); }
  if (window.WX) WX.mood(scene, hemi, sun, post.uniforms); // Runde 141: weather (darker, greyer, more haze in rain and snow)
  lightSprites(hemi, sun, scene.fog);
}
applyMood(cur);

/* ================================================================ UI */
const toastEl = $('toast'); let toastT = 0;
function toast(t, ms) { toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), ms || 3200); }
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';
function setMood(id, quiet) {
  const m = MOODS.find(x => x.id === id); if (!m) return;
  moodId = id; store.set('hx.mood', id); from = clone(cur); to = flat(m); tMix = 0;
  document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.id === id));
  if (!quiet) toast(m.name, 1400);
}
MOODS.forEach(m => {
  const b = document.createElement('button'); b.className = 'chip'; b.dataset.id = m.id; b.type = 'button';
  const sw = m.sw || [0, 2, 4, 6, 8, 10].map(i => m.pal[i]);
  b.innerHTML = '<span class="sw">' + sw.map(c => '<i style="background:' + c + '"></i>').join('') + '</span><b>' + m.name + '</b><small>' + m.hint + '</small>';
  b.addEventListener('click', () => { setAuto(false); setMood(m.id); });
  $('chips').appendChild(b);
});
[2, 3, 4, 5].forEach(n => { const b = document.createElement('button'); b.type = 'button'; b.textContent = n; b.dataset.px = n;
  b.addEventListener('click', () => { userPx = pxSize = n; store.set('hx.px', n); makeRT(); markPx(); }); $('seg').appendChild(b); });
/* Runde 128: FPS display (options -> "FPS-Anzeige", hx.fps): frames per second over the last half second, the slowest frame
   in it and the pixel level - "auto" when the slow-device brake has made it coarser than the chosen one */
{ const el = $('fps'), n = $('fpsN'), pxl = $('fpsPx'), rk = $('fpsRk'), tg = $('tFps'); let on = !!store.get('hx.fps'), cnt = 0, worst = 0, t0 = performance.now(), tl = t0;
  const show = v => { on = v; tg.checked = v; el.hidden = !v; store.set('hx.fps', v); if (v) { cnt = 0; worst = 0; t0 = tl = performance.now(); requestAnimationFrame(tick); } };
  let fl = -1; function tick(t) { if (!on) return; if (frame !== fl) { fl = frame; cnt++; worst = Math.max(worst, t - tl); tl = t; } /* Runde 132: counts drawn frames (game loop), not screen refreshes - matters with the 30 fps cap */
    if (t - t0 >= 500) { const f = cnt * 1000 / (t - t0); n.textContent = Math.round(f); el.dataset.q = f >= (CAP30 ? 28 : 45) ? 'gut' : f >= 24 ? 'mittel' : 'schlecht';
      pxl.textContent = 'Px ' + pxSize + (pxSize > userPx ? ' auto' : '') + (pxNoGain > time ? ' · CPU' : ''); /* Runde 131: CPU = coarser pixels would not help right now */ rk.textContent = worst > 100 ? 'Ruckler ' + Math.round(worst) + ' ms' : ''; cnt = 0; worst = 0; t0 = t; }
    requestAnimationFrame(tick); }
  tg.addEventListener('change', e => show(e.target.checked)); show(on); }
function markPx() { document.querySelectorAll('[data-px]').forEach(x => x.setAttribute('aria-pressed', +x.dataset.px === pxSize)); }
markPx();
function moodForHour(h) { return h >= 6 && h < 10 ? 'morgen' : h >= 10 && h < 17 ? 'mittag' : h >= 17 && h < 21 ? 'gold' : 'nacht'; }
let autoTimer = 0;
function setAuto(on) { $('tTime').checked = on; store.set('hx.auto', on); clearInterval(autoTimer);
  if (on) { setMood(moodForHour(new Date().getHours()), true); autoTimer = setInterval(() => { const id = moodForHour(new Date().getHours()); if (id !== moodId) setMood(id); }, 60000); } }
$('tTime').addEventListener('change', e => setAuto(e.target.checked));
$('tTerrain').checked = TERRAIN;
$('tOutline').checked = store.get('hx.outline') !== false; $('tOutline').addEventListener('change', e => setOutline(e.target.checked)); // Runde 74
$('tLastPos').checked = !!store.get('hx.useLastPos'); $('tLastPos').addEventListener('change', e => store.set('hx.useLastPos', e.target.checked));
$('rView').value = VIEW; $('rViewL').textContent = ['Normal', 'Weit', 'Sehr weit'][VIEW - 1];
$('rView').addEventListener('input', e => { $('rViewL').textContent = ['Normal', 'Weit', 'Sehr weit'][e.target.value - 1]; });
$('rView').addEventListener('change', e => { store.set('hx.view', +e.target.value); location.reload(); });
$('tTerrain').addEventListener('change', e => { store.set('hx.terrain', e.target.checked); location.reload(); });
/* Runde 150: the settings button shows a gear (it opens all settings, not only the mood; sun/moon was mistaken for day/night) */
$('bMood').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
$('bMood').addEventListener('click', () => { $('sheet').hidden = !$('sheet').hidden; });
$('bClose').addEventListener('click', () => { $('sheet').hidden = true; });
/* Runde 144: map layers (Einstellungen → Karte): what the minimap and the big map show */
const LAYERS = Object.assign({ sights: true, zellen: true, burgen: true }, store.get('hx.layers') || {});
/* Runde 154: in the medieval world there are castles (layer "Burgen") and no sights; the switches show only where they apply */
const MITTEL = (window.HX_WELT || 'heute') === 'mittel';
document.querySelectorAll('.lyMittel').forEach(el => { el.hidden = !MITTEL; }); document.querySelectorAll('.lyHeute').forEach(el => { el.hidden = MITTEL; });
function burgList() { const out = []; if (!MITTEL || !window.HXW || !HXW.TILES) return out; for (const a of HXW.TILES.values()) for (const it of a) if (it.v === 'm_burg' || it.v === 'm_schloss' || (it.v === 'm_gutshof' && it.t)) out.push(it); return out; } // Runde 166: palaces and named manors too
function einsatzIcon(g, x, y, r) { // Runde 171: blue and red flashing disc with a white cross-bar - where police and ambulance are
  const on = ((performance.now() / 350) | 0) % 2; g.fillStyle = 'rgba(255,255,255,.95)'; g.beginPath(); g.arc(x, y, r * 1.3, 0, 7); g.fill();
  g.fillStyle = on ? '#2f6bff' : '#e8262f'; g.strokeStyle = '#1a1206'; g.lineWidth = Math.max(1.5, r * .18); g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.fillRect(x - r * .55, y - r * .16, r * 1.1, r * .32); g.fillRect(x - r * .16, y - r * .55, r * .32, r * 1.1); }
function burgIcon(g, x, y, r) { g.fillStyle = '#c9bca2'; g.strokeStyle = '#1a1206'; g.lineWidth = Math.max(1.5, r * .28);
  g.beginPath(); g.moveTo(x - r, y + r * .8); g.lineTo(x - r, y - r * .9); g.lineTo(x - r * .55, y - r * .9); g.lineTo(x - r * .55, y - r * .45); g.lineTo(x - r * .2, y - r * .45); g.lineTo(x - r * .2, y - r * .9);
  g.lineTo(x + r * .2, y - r * .9); g.lineTo(x + r * .2, y - r * .45); g.lineTo(x + r * .55, y - r * .45); g.lineTo(x + r * .55, y - r * .9); g.lineTo(x + r, y - r * .9); g.lineTo(x + r, y + r * .8); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#2a1d10'; g.fillRect(x - r * .28, y + r * .1, r * .56, r * .7); }
/* Runde 146 (phone test: the layers were not found - they are looked for on the map): the same switches in Einstellungen → Karte and
   behind the layers button of the big map, all kept in step */
{ const boxes = () => document.querySelectorAll('input[data-layer]'), sync = () => boxes().forEach(el => { el.checked = !!LAYERS[el.dataset.layer]; });
  boxes().forEach(el => el.addEventListener('change', () => { LAYERS[el.dataset.layer] = el.checked; store.set('hx.layers', LAYERS); sync(); if (!$('bigmap').hidden) drawBig(); }));
  sync();
  const bt = $('bmLay'), box = $('bmLayBox'), show = on => { box.hidden = !on; bt.setAttribute('aria-expanded', on ? 'true' : 'false'); bt.setAttribute('aria-pressed', on ? 'true' : 'false'); };
  bt.addEventListener('click', e => { e.stopPropagation(); show(box.hidden); });
  $('bmClose').addEventListener('click', () => show(false)); }
/* Runde 142: settings in groups that open and close; which ones are open is remembered (hx.grp) */
{ const st = store.get('hx.grp') || {}; document.querySelectorAll('#sheet details.grp').forEach(d => { const k = d.dataset.g; if (k in st) d.open = !!st[k];
    d.addEventListener('toggle', () => { st[k] = d.open; store.set('hx.grp', st); }); }); }
$('bProfile').addEventListener('click', openProfile);
/* Runde 151: the camera button shows the view the next tap goes to (as the fullscreen button) - a cube for the diorama from above,
   a figure (head and shoulders) for the camera behind the figure; the stack it showed looked like the map layers button */
const CAMICO = { dio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
  chase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>' };
function camIcon() { const to = camMode === 'chase' ? 'dio' : 'chase', b = $('bCam'); b.innerHTML = CAMICO[to]; b.removeAttribute('aria-pressed'); b.setAttribute('aria-label', to === 'dio' ? 'Zur Diorama-Ansicht von oben' : 'Hinter die Figur'); }
camIcon();
function setCam(m) { camMode = m; camIcon();
  cam = m === 'dio' ? iso : camera; fitIso();
  post.uniforms.uNear.value = cam.near; post.uniforms.uFar.value = cam.far; post.uniforms.uOrtho.value = m === 'dio' ? 1 : 0; applyMood(cur);
  $('rot').hidden = m !== 'dio';
  toast(m === 'dio' ? 'Isometrische Ansicht: wischen oder Pfeile zum Drehen' : 'Verfolger-Ansicht', 1800); }
function rotateIso(steps) { dioTarget = Math.round((dioTarget + steps * Math.PI / 4) / (Math.PI / 4)) * (Math.PI / 4); }
$('bRotL').addEventListener('click', () => rotateIso(-1));
$('bRotR').addEventListener('click', () => rotateIso(1));
{ // swipe on the map to turn the isometric view; it snaps to the next 45° step when released
  let did = null, x0 = 0, y0 = 0;
  // swipe up/down (both views): tilt the camera - look up at towers, down at the street; keys R/F, Bild auf/ab
  let tx0 = 0, ty0 = 0, tt0 = 0;
  view.addEventListener('pointerdown', e => { did = e.pointerId; x0 = tx0 = e.clientX; y0 = ty0 = e.clientY; tt0 = performance.now(); try { view.setPointerCapture(did); } catch (err) { } });
  view.addEventListener('pointermove', e => { if (e.pointerId !== did) return;
    if (camMode === 'dio') dioTarget -= (e.clientX - x0) * 0.008;
    tilt(-(e.clientY - y0) * 0.004); x0 = e.clientX; y0 = e.clientY; });
  const up = e => { if (e.pointerId !== did) return; did = null; if (camMode === 'dio') rotateIso(0);
    if (e.type === 'pointerup' && Math.hypot(e.clientX - tx0, e.clientY - ty0) < 12 && performance.now() - tt0 < 400 && worldReady) tapAt(e.clientX, e.clientY); }; // a tap, not a swipe
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  view.addEventListener('wheel', e => { if (camMode !== 'dio') return; isoZoom = Math.max(14, Math.min(70, isoZoom * (e.deltaY > 0 ? 1.1 : 0.9))); store.set('hx.zoom', isoZoom); fitIso(); e.preventDefault(); }, { passive: false });
}
$('bCam').addEventListener('click', () => setCam(camMode === 'chase' ? 'dio' : 'chase'));
/* Runde 149 (phone test: the button only switched fullscreen on, never off): it toggles now; the icon and label follow the state,
   also when fullscreen is left another way (back gesture, Esc) */
{ const bt = $('bFull'), D = document, ON = 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5', OFF = 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5';
  const isFull = () => !!(D.fullscreenElement || D.webkitFullscreenElement);
  const show = () => { const f = isFull(); bt.setAttribute('aria-pressed', f ? 'true' : 'false'); bt.setAttribute('aria-label', f ? 'Vollbild beenden' : 'Vollbild'); const pa = bt.querySelector('path'); if (pa) pa.setAttribute('d', f ? ON : OFF); };
  bt.addEventListener('click', () => {
    if (isFull()) { const q = D.exitFullscreen ? D.exitFullscreen() : D.webkitExitFullscreen ? D.webkitExitFullscreen() : null; if (q && q.catch) q.catch(() => { }); return; }
    const el = D.documentElement, q = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : undefined;
    if (q && q.catch) q.catch(() => toast('Vollbild geht hier nicht', 1600)); else if (q === undefined && !el.webkitRequestFullscreen) toast('Vollbild geht hier nicht', 1600); });
  D.addEventListener('fullscreenchange', show); D.addEventListener('webkitfullscreenchange', show); show(); }
$('bTalk').addEventListener('click', () => { const s = streetAt(P.x, P.z, 40); toast(s ? 'Du bist hier: ' + s : 'Hier hat die Straße keinen Namen.', 2200); });

/* input */
const stick = $('stick'), knob = $('knob'); let jx = 0, jy = 0, sid = null;
function smove(e) { const r = stick.getBoundingClientRect(); let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2); const Rr = r.width * .36, l = Math.hypot(dx, dy); if (l > Rr) { dx *= Rr / l; dy *= Rr / l; }
  knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; jx = dx / Rr; jy = dy / Rr; }
stick.addEventListener('pointerdown', e => { sid = e.pointerId; stick.setPointerCapture(sid); smove(e); e.preventDefault(); });
stick.addEventListener('pointermove', e => { if (e.pointerId === sid) smove(e); });
const send = e => { if (e.pointerId !== sid) return; sid = null; jx = jy = 0; knob.style.transform = ''; };
stick.addEventListener('pointerup', send); stick.addEventListener('pointercancel', send);
const keys = {};
/* Runde 125: while the world is still building in the Matrix style there is no steering - the controls are hidden (.hud.laden)
   and game keys are swallowed here (capture phase, before every other key handler); Tab/Escape and typing in fields still work */
addEventListener('keydown', e => { if (!started || worldReady || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.key === 'Tab' || e.key === 'Escape') return; e.stopImmediatePropagation(); if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault(); }, true);
addEventListener('keydown', e => { if (e.target.tagName === 'INPUT') return; const k = e.key.toLowerCase(); keys[k] = true; if (k === ' ') { jump(); e.preventDefault(); } if (k === 'k') setCam(camMode === 'chase' ? 'dio' : 'chase'); if (camMode === 'dio' && (k === 'q' || k === 'e')) rotateIso(k === 'q' ? -1 : 1); if (k.startsWith('arrow')) e.preventDefault(); });
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
const P = { x: 0, z: 0, y: 0, yaw: Math.PI, vy: 0, speed: 0, phase: 0, ground: true, placed: false };
/* Runde 46: solid things one can stand on - house roofs and parked cars (phone test: "jump onto any object in front of you,
   over it when it is narrow"; "I can't get out of the water"). objTop = highest solid top at x/z, -Infinity where there is none. */
const CARG = { ver: -1, g: new Map() };
function carTop(x, z) {
  if (CARG.ver !== carVer) { CARG.ver = carVer; CARG.g.clear(); for (const a of carTiles.values()) for (let i = 0; i < a.length; i += 6) { if (a[i + 3] >= 8 || a[i + 3] < 0) continue; /* boats, aircraft; cars someone got into */
      const k = Math.floor(a[i] / 8) * 100003 + Math.floor(a[i + 1] / 8); let l = CARG.g.get(k); if (!l) CARG.g.set(k, l = []); l.push(a[i], a[i + 1], a[i + 2]); } }
  let top = -Infinity; const ix = Math.floor(x / 8), iz = Math.floor(z / 8);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = CARG.g.get((ix + a) * 100003 + iz + b); if (!l) continue;
    for (let i = 0; i < l.length; i += 3) { const dx = x - l[i], dz = z - l[i + 1], s = Math.sin(l[i + 2]), c = Math.cos(l[i + 2]);
      if (Math.abs(dx * s + dz * c) < 2.0 && Math.abs(dx * c - dz * s) < .9) top = Math.max(top, terrainH(l[i], l[i + 1]) + 1.45); } }
  return top; }
function objTop(x, z) { const b = buildingAt(x, z); return Math.max(b ? b.h : -Infinity, carTop(x, z)); }
function groundAt(x, z, y) { const w = waterFloor(x, z); return w ? w.y : terrainH(x, z, y); }
// what the figure meets ahead: ground, a railing (as a thin wall ~1 m high) or a solid top - the highest
function surfAhead(x, z, y) { let s = groundAt(x, z, y); const o = objTop(x, z); if (o > s) s = o; if (railAt(x, z)) s = Math.max(s, terrainRaw(x, z) + 1.0); return s; }
// aimed jump: look up to 4.5 m ahead; an obstacle up to 3.2 m high is jumped onto, a narrow one (<= 1.6 m deep) jumped over;
// otherwise the plain 1.3 m jump. Also from the water (a steep bank). Height and distance are worked out so the figure clears the edge.
/* Runde 133: wall dodge (like Unreal Tournament, simplified, no new button): in the air, jump while touching a wall (or right in front
   of one) kicks the figure off it - away from the wall, keeping the sideways motion, up again. Up to 3 per flight, so a narrow alley
   can be climbed zig-zag; the double jump stays available. Costs nothing per frame: the wall contact is the collision test the
   movement does anyway; only the jump press probes one point ahead. */
function wallDodge() {
  if ((P.wd || 0) >= 3) return false;
  let nx = 0, nz = 0; const w = P.wall, fx = Math.sin(P.yaw), fz = Math.cos(P.yaw);
  if (w && time - w.t < .3) { nx = w.nx; nz = w.nz; }
  else for (const d of [.55, .9]) if (objTop(P.x + fx * d, P.z + fz * d) > P.y + .45) { nx = -fx; nz = -fz; break; } // facing a wall just ahead
  if (!nx && !nz) return false;
  { let sx = 0, sz = 0; for (let k = 0; k < 8; k++) { const h = k * Math.PI / 4, cx = Math.sin(h), cz = Math.cos(h); if (objTop(P.x + cx * .8, P.z + cz * .8) > P.y + .45) { sx -= cx; sz -= cz; } }
    if (sx * nx + sz * nz > 0) { nx = sx; nz = sz; } } // the wall's real direction (any angle, also corners): away from all blocked sides
  const l = Math.hypot(nx, nz); if (!l) return false; nx /= l; nz /= l;
  const dn = fx * nx + fz * nz, tx = fx - dn * nx, tz = fz - dn * nz; // sideways part of the motion along the wall
  let ox = nx + tx * .8, oz = nz + tz * .8; const ol = Math.hypot(ox, oz); ox /= ol; oz /= ol;
  P.kick = { vx: ox * 9, vz: oz * 9, t: 0 }; P.speed = 0; P.yaw = Math.atan2(ox, oz); P.hop = null;
  P.vy = 7.8; P.wd = (P.wd || 0) + 1; P.wall = null; P.flip = 0; FIGS.land = .12; // a short crouch: the push-off
  return true; }
function jump() { if (DRV.on || P.hold) return; // P.hold: inside a telephone booth (zellen.js)
  /* Runde 130: double jump - once more in the air (not from the water), with a front flip; reset on landing */
  if (!(P.ground || P.swim || P.wade)) { if (!worldReady || wallDodge()) return; if (P.dj) return; P.dj = true; P.vy = Math.max(P.vy, 0) * .25 + 7.2; P.flip = 0; return; }
  P.dj = false; P.flip = undefined; // a jump from the ground: the double jump is available again
  const G = 22, fx = Math.sin(P.yaw), fz = Math.cos(P.yaw), base = P.y, S = [];
  for (let d = .4; d <= 4.5; d += .2) S.push([d, surfAhead(P.x + fx * d, P.z + fz * d, base + 3.5)]);
  let i1 = S.findIndex(([, s]) => s - base > .35);
  if (i1 < 0 || S[i1][0] > 3.2) { P.vy = P.swim ? 6.5 : 7.5; P.ground = false; return; } // nothing in front: plain jump (from the water a smaller one)
  const d1 = S[i1][0]; let H = S[i1][1], i2 = -1;
  for (let k = i1; k < S.length; k++) { if (S[k][1] > H) H = S[k][1]; if (S[k][1] < H - .5) { i2 = k; break; } }
  const rise = H - base; if (rise > 5.0) { P.vy = 7.5; P.ground = false; return; } // too high: plain jump (Runde 75: up to 5 m - garages, sheds, bus shelters, measured from the lower side)
  const over = i2 >= 0 && S[i2][0] - d1 <= 1.6, dl = over ? Math.min(4.5, S[i2][0] + .6) : d1 + .8, L = over ? surfAhead(P.x + fx * dl, P.z + fz * dl, base) : H;
  let extra = .35, vy = 0, v = 0;
  for (let it = 0; it < 12; it++, extra += .2) { vy = Math.sqrt(2 * G * (rise + extra)); const tl = (vy + Math.sqrt(Math.max(0, vy * vy - 2 * G * (L - base)))) / G,
      tr = (vy - Math.sqrt(Math.max(0, vy * vy - 2 * G * (rise + .1)))) / G; v = dl / tl; if (v * tr <= d1 - .15) break; } // above the edge before reaching it
  P.vy = vy; P.ground = false; P.hop = { vx: fx * v, vz: fz * v, t: 0 }; P.speed = Math.max(P.speed, Math.min(v, 6)); }
$('bJump').addEventListener('pointerdown', e => { e.preventDefault(); jump(); });
let running = !!store.get('hx.run');
function setRun(v) { running = v; store.set('hx.run', v); $('bRun').classList.toggle('on', v); $('bRun').setAttribute('aria-pressed', v); }
$('bRun').addEventListener('click', () => { setRun(!running); toast(running ? 'Rennen' : 'Gehen', 900); });
setRun(running);
{ const w = $('rWind'), v = store.get('hx.wind'); w.value = v === null ? 1 : v; spriteUniforms.uWind.value = +w.value;
  w.addEventListener('input', () => { spriteUniforms.uWind.value = +w.value; store.set('hx.wind', +w.value); }); }
$('bJump').addEventListener('click', e => { if (e.detail === 0) jump(); });

/* ================================================================ data from worker */
const meshes = new Map(), tiles = new Map();
const CELL = 20, bgrid = new Map();
const gk = (ix, iz) => ix * 100003 + iz;
function onData(e) {
  const m = e.data;
  if (window.HXLI) HXLI.msg(m); // Runde 122: loading info panel
  if (m.type === 'ground') {
    farDirty = true;
    addMesh(m.key, m, groundMat);
    if (m.glow && m.glow.pos.length) addMesh(m.key + ':glow', m.glow, lampMat);
    addSprites(m.key, m.spr);
    if (m.refl && m.refl.length) { const k = m.key + ':sprr', old = meshes.get(k); if (old) { scene.remove(old); old.geometry.dispose(); } const rm = makeSpriteMesh(m.refl, false); rm.renderOrder = 1; scene.add(rm); meshes.set(k, rm); } // tree reflections on the water
    setCarTile(m.key, m.cars);
    if (window.HXW) window.HXW.tile(m.key, m.welt);
    const t = { key: m.key, names: m.names, samples: m.samples, sqNames: m.sqNames, pedNames: new Set(m.pedNames || []), spawn: m.spawn, start: m.start || m.spawn, blds: [] };
    const c = m.collide;
    for (let i = 0; i < c.length;) {
      const n = c[i], h = c[i + 1], base = c[i + 2], p = c.subarray(i + 3, i + 3 + n * 2); i += 3 + n * 2; // h: absolute roof height, base: ground level
      let a = Infinity, b = -Infinity, cc = Infinity, d = -Infinity; for (let k = 0; k < p.length; k += 2) { if (p[k] < a) a = p[k]; if (p[k] > b) b = p[k]; if (p[k + 1] < cc) cc = p[k + 1]; if (p[k + 1] > d) d = p[k + 1]; }
      const it = { p, h, base, minx: a, maxx: b, minz: cc, maxz: d, tile: m.key }; t.blds.push(it);
      for (let ix = Math.floor(a / CELL); ix <= Math.floor(b / CELL); ix++) for (let iz = Math.floor(cc / CELL); iz <= Math.floor(d / CELL); iz++) { const k = gk(ix, iz); let arr = bgrid.get(k); if (!arr) bgrid.set(k, arr = []); arr.push(it); }
    }
    t.map = drawTileMap(m.map); t.roads = m.map && m.map.roads; t.areas = m.map && m.map.areas; t.friedhoefe = (m.map && m.map.friedhoefe) || []; t.stuetzen = (m.map && m.map.stuetzen) || []; t.sonder = (m.map && m.map.sonder) || []; /* Runde 204: fantasy cemeteries, for riddles later */ tiles.set(m.key, t); TILEVER++;
    if (m.dips && m.dips.length) DIPS_APP.set(m.key, m.dips); else DIPS_APP.delete(m.key);
    if (m.rails && m.rails.length) RAILS.set(m.key, m.rails); else RAILS.delete(m.key);
    if (m.corr && m.corr.length) CORR_APP.set(m.key, corrIndex(m.corr)); else CORR_APP.delete(m.key);
    if (m.dz) DZ_APP.set(m.key, m.dz); else DZ_APP.delete(m.key);
    if (m.elev && m.elev.length) ELEV_APP.set(m.key, m.elev); else ELEV_APP.delete(m.key);
    if (m.span && m.span.length) SPAN_APP.set(m.key, m.span); else SPAN_APP.delete(m.key);
    if (!P.placed) placePlayer();
    loaded.ground = true; checkReady();
  } else if (m.type === 'bld') { addMesh(m.key, m, bldMat); loaded.bld = true; checkReady(); }
  else if (m.type === 'trees') addMesh(m.key, m, groundMat);
  else if (m.type === 'roofthings') { if (m.pos) addMesh(m.key, m, m.fac ? bldMat : groundMat); else { const o = meshes.get(m.key); if (o) { scene.remove(o); o.geometry.dispose(); meshes.delete(m.key); } } } // AC units, vents, chimneys, dishes on LoD2 roofs (solid)
  else if (m.type === 'wo') { if (m.id === WO.id && m.r) { WO.r = m.r; WO.last = ''; if (!$('bigmap').hidden) hereText(); } }
  else if (m.type === 'maptile') { BIG.pending.delete(m.key); const sc = m.z >= 14 ? .4 : m.z === 13 ? .2 : m.z === 12 ? .1 : .05; const mp = m.map && drawTileMap(m.map, sc); BIG.tiles.set(m.key, mp ? { z: m.z, map: mp } : null);
    if (BIG.tiles.size > 220) { const k0 = BIG.tiles.keys().next().value; BIG.tiles.delete(k0); } drawBig(); }
  else if (m.type === 'water') { if (m.field) WFIELDS.set(m.key, m.field); const mat = m.field ? waterMat(m.field) : groundMat; addMesh(m.key, m, mat); const o = meshes.get(m.key); if (o && m.field) o.userData.ownMat = true; }
  else if (m.type === 'lod2idx') { // LoD2 buildings replaced by OSM buildings (implausible blocks)
    const o = meshes.get(m.key); if (o) { o.geometry.setIndex(new THREE.BufferAttribute(m.idx, 1)); }
    for (const k of [m.key + ':spr', m.key + ':sprs']) { const s = meshes.get(k); if (s) { scene.remove(s); s.geometry.dispose(); meshes.delete(k); } }
    addSprites(m.key, m.spr);
  }
  else if (m.type === 'lod2') { addL2H(m.key, m.pos, m.gid); if (m.collide) addCollide(m.key, m.collide, true); addMesh(m.key, m, bldMat); addSprites(m.key, m.spr); loaded.bld = true; checkReady(); }
  else if (m.type === 'recolour') { const o = meshes.get(m.key); if (o) { const a = o.geometry.attributes; a.color.array.set(m.col); a.color.needsUpdate = true; if (m.fac && a.aFac) { a.aFac.array.set(m.fac); a.aFac.needsUpdate = true; } if (m.wal && a.aWall) { a.aWall.array.set(m.wal); a.aWall.needsUpdate = true; } } }
  else if (m.type === 'drop') {
    if (m.prefix.startsWith('l:') || [...bgrid.values()].some(a => a.some(i => i.l2 && i.tile.startsWith(m.prefix)))) for (const [gkey, arr] of bgrid) { const b = arr.filter(i => !(i.l2 && i.tile.startsWith(m.prefix))); if (b.length !== arr.length) { if (b.length) bgrid.set(gkey, b); else bgrid.delete(gkey); } }
    for (const k of [...L2B.keys()]) if (k.startsWith(m.prefix)) { L2B.delete(k); L2VER++; }
    for (const k of [...L2H.keys()]) if (k.startsWith(m.prefix)) { L2H.delete(k); const gm = L2G.get(k); if (gm) for (const g of new Set(gm.values())) L2GC.delete(g); L2G.delete(k); }
    for (const k of [...SIGHTS.keys()]) if (k.startsWith(m.prefix)) SIGHTS.delete(k);
    farDirty = true;
    dropCarTiles(m.prefix);
    if (window.HXW) window.HXW.drop(m.prefix);
    for (const k of [...WFIELDS.keys()]) if (k.startsWith(m.prefix)) WFIELDS.delete(k);
    for (const [k, o] of meshes) if (k.startsWith(m.prefix)) { scene.remove(o); o.geometry.dispose(); if (o.userData.ownMat) { o.material.uniforms_tex && o.material.uniforms_tex.dispose(); o.material.dispose(); } meshes.delete(k); }
    for (const k of [...DIPS_APP.keys()]) if (k.startsWith(m.prefix)) DIPS_APP.delete(k);
    for (const k of [...RAILS.keys()]) if (k.startsWith(m.prefix)) RAILS.delete(k);
    for (const k of [...CORR_APP.keys()]) if (k.startsWith(m.prefix)) CORR_APP.delete(k);
    for (const k of [...DZ_APP.keys()]) if (k.startsWith(m.prefix)) DZ_APP.delete(k);
    for (const k of [...ELEV_APP.keys()]) if (k.startsWith(m.prefix)) ELEV_APP.delete(k);
    for (const k of [...SPAN_APP.keys()]) if (k.startsWith(m.prefix)) SPAN_APP.delete(k);
    for (const k of [...CHUNKS.keys()]) if (k.startsWith(m.prefix)) { CHGEN.set(k, (CHGEN.get(k) || 0) + 1); CHUNKS.delete(k); }
    for (const [k, t] of tiles) if (k.startsWith(m.prefix)) { tiles.delete(k); TILEVER++; for (const [gkey, arr] of bgrid) { const b = arr.filter(i => i.tile !== k); if (b.length) bgrid.set(gkey, b); else bgrid.delete(gkey); } }
  } else if (m.type === 'status') { /* Runde 122: while loading, the info panel shows the open requests */ $('net').hidden = !m.loading || !started || !worldReady; $('netText').textContent = 'Lade Daten (' + m.loading + ')'; }
  else if (m.type === 'sights') { SIGHTS.set(m.key, MITTEL ? m.sights.filter(s => s.quiet) : m.sights); } // Runde 154: no sights in the medieval world
  else if (m.type === 'terrain') { if (m.z === TER.z) { TER.tiles.set(m.tx + '_' + m.ty, m.h); carDirty = true; } else TER.far.set(m.tx + '_' + m.ty, m.h); farDirty = true; }
  else if (m.type === 'terrainH0') { TER.h0 = m.h0; carDirty = true; }
  else if (m.type === 'info') { (window.HXinfo = window.HXinfo || []).push(m.msg); }
  else if (m.type === 'quelle') { // Runde 120: a data source is down - say so (at most every 30 s), the worker keeps retrying
    const now = performance.now(); if (!m.ok && now - (onData.qT || -1e9) > 30000) { onData.qT = now; if (!(window.HXLI && HXLI.note('Kartendienst antwortet nicht – neuer Versuch läuft …'))) toast(worldReady ? 'Kartendaten gerade nicht erreichbar – neuer Versuch läuft' : 'Kartendaten nicht erreichbar – neuer Versuch läuft …', 4000); } }
  else if (m.type === 'warn') { console.warn('[HoodExplorer]', m.msg); (window.HXlog = window.HXlog || []).push(m.msg); }
}
const BINS = new Map();
function addSprites(key, arr, now) { // trees, bushes and props of one tile: one instanced draw for the sprites, one for their shadows
  if (!arr || !arr.length) return;
  if (!now && BLOCKS && /^m:/.test(key)) { JOBQ[2].push(() => { if (tiles.has(key)) addSprites(key, arr, true); }); return; } // after ground and houses
  // all as sprites (bushes too: they now turn properly from 16 directions, see sprites.js); ground patches for all but ducks and birds
  { const b = []; for (let i = 0; i < arr.length; i += 6) if (arr[i + 4] === 16) b.push(arr[i], arr[i + 1]); if (b.length) BINS.set(key, b); else BINS.delete(key); } // wheelie bins: rats (Runde 82)
  const sp = [], sh = []; for (let i = 0; i < arr.length; i += 6) { const t = arr[i + 4]; sp.push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3], arr[i + 4], arr[i + 5]); if (t !== 28 && t !== 30 && t !== 38) sh.push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3], arr[i + 4], arr[i + 5]); } // ducks swim, birds fly: no ground patch under them
  dropChunks(key + ':sprites');
  if (BLOCKS && /^m:/.test(key)) { // in 128 m blocks like the ground (culled outside the picture and in the fog)
    for (const suf of [':spr', ':sprs', ':sprb']) { const old = meshes.get(key + suf); if (old) { scene.remove(old); old.geometry.dispose(); meshes.delete(key + suf); } }
    const keys = []; for (const [list, shadow, suf] of [[sp, false, ':spr#'], [sh, true, ':sprs#']]) { const g = new Map();
      for (let i = 0; i < list.length; i += 6) { const k = Math.floor(list[i] / CHUNK) * 100003 + Math.floor(list[i + 1] / CHUNK); let a = g.get(k); if (!a) g.set(k, a = []); for (let q = 0; q < 6; q++) a.push(list[i + q]); }
      for (const a of g.values()) { const sm = makeSpriteMesh(new Float32Array(a), shadow); sm.geometry.boundingSphere.radius += 25; /* birds circle up to 26 m */ const ck = key + suf + keys.length; scene.add(sm); meshes.set(ck, sm); keys.push(ck); } }
    CHUNKS.set(key + ':sprites', keys); return; }
  const parts = [[':spr', sp.length ? makeSpriteMesh(new Float32Array(sp), false) : null], [':sprs', sh.length ? makeSpriteMesh(new Float32Array(sh), true) : null], [':sprb', null]]; // ':sprb' (old cross bushes) only gets cleared
  for (const [suf, sm] of parts) { const k = key + suf, old = meshes.get(k); if (old) { scene.remove(old); old.geometry.dispose(); meshes.delete(k); } if (sm) { scene.add(sm); meshes.set(k, sm); } }
}
function addMesh(key, m, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3, m.nor instanceof Int8Array));
  g.setAttribute('color', new THREE.BufferAttribute(m.col, 3, m.col instanceof Uint8Array)); // 8-bit from the worker (Runde 56)
  if (m.fac) g.setAttribute('aFac', new THREE.BufferAttribute(m.fac, 2));
  if (m.wal) g.setAttribute('aWall', new THREE.BufferAttribute(m.wal, 3));
  if (m.gid) g.setAttribute('aGid', new THREE.BufferAttribute(m.gid, 1));
  if (m.fac) g.setAttribute('aBase', new THREE.BufferAttribute(m.base && m.base.length ? m.base : new Float32Array(m.pos.length / 3), 1));
  if (m.idx) g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  dropChunks(key);
  if (BLOCKS && /^m:/.test(key) && (mat === groundMat || mat === bldMat || mat === lampMat)) { addChunks(key, g, mat, m.det, m.cidx, m.cinfo); return; }
  g.computeBoundingSphere();
  const old = meshes.get(key); if (old) { scene.remove(old); old.geometry.dispose(); }
  const mesh = new THREE.Mesh(g, mat); mesh.matrixAutoUpdate = false; scene.add(mesh); meshes.set(key, mesh);
}
/* Blocks (idea of Nanite's clusters, without the GPU part): a tile (up to ~1.5 M triangles) was drawn whole as soon as a corner of it
   was in view. Now each tile mesh is split into 128 m blocks that share the vertex buffers, each with its own index and bounding
   sphere - three.js skips blocks behind the camera and outside the picture, chunkCull() those lying entirely in the fog. */
const BLOCKS = !/[?&]bloecke=0/.test(location.search), CHUNK = 128, CHUNKS = new Map(); // tile key -> block keys
function dropChunks(key) { CHGEN.set(key, (CHGEN.get(key) || 0) + 1); const l = CHUNKS.get(key); if (!l) return; for (const k of l) { const o = meshes.get(k); if (o) { scene.remove(o); o.geometry.dispose(); meshes.delete(k); } } CHUNKS.delete(key); }
/* blocks are made a few per frame (at most ~3 ms), not all in the frame the tile arrives (Runde 56) */
/* Runde 58: the world fills in layers - ground and streets first (all tiles that arrived), then houses, then trees and the
   small things: three queues, always the lowest one first, ~3 ms per frame */
const JOBQ = [[], [], []], CHGEN = new Map(), JOBS = { push: f => JOBQ[0].push(f) };
function runJobs() { const t0 = performance.now(); for (const q of JOBQ) while (q.length && performance.now() - t0 < 3) q.shift()(); }
function addChunks(key, g, mat, det, cidx, cinfo) {
  const old = meshes.get(key); if (old) { scene.remove(old); old.geometry.dispose(); meshes.delete(key); }
  if (cinfo) { const gen = (CHGEN.get(key) || 0) + 1; CHGEN.set(key, gen); const keys = []; CHUNKS.set(key, keys);
    const Q = JOBQ[mat === bldMat ? 1 : 0]; for (let c = 0; c < cinfo.length; c += 9) Q.push(() => { if (CHGEN.get(key) !== gen) return; const start = cinfo[c], nBase = cinfo[c + 1], nAll = cinfo[c + 2];
      const gg = new THREE.BufferGeometry(); for (const n in g.attributes) gg.setAttribute(n, g.attributes[n]); gg.setIndex(new THREE.BufferAttribute(cidx.subarray(start, start + nAll), 1));
      gg.boundingBox = new THREE.Box3(new THREE.Vector3(cinfo[c + 3], cinfo[c + 4], cinfo[c + 5]), new THREE.Vector3(cinfo[c + 6], cinfo[c + 7], cinfo[c + 8])); gg.boundingSphere = gg.boundingBox.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(gg, mat); mesh.matrixAutoUpdate = false; mesh.userData.nBase = nBase; mesh.userData.nAll = nAll; scene.add(mesh); const ck = key + '#' + keys.length; meshes.set(ck, mesh); keys.push(ck); if (mat === groundMat) FARPEND = true; });
    return; }
  const p = g.attributes.position.array, ix = g.index ? g.index.array : null, nt = (ix ? ix.length : p.length / 3) / 3, groups = new Map();
  for (let t = 0; t < nt; t++) { const a = ix ? ix[t * 3] : t * 3, b = ix ? ix[t * 3 + 1] : t * 3 + 1, c = ix ? ix[t * 3 + 2] : t * 3 + 2;
    const cx = Math.floor((p[a * 3] + p[b * 3] + p[c * 3]) / 3 / CHUNK), cz = Math.floor((p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3 / CHUNK), k = cx * 100003 + cz;
    let l = groups.get(k); if (!l) groups.set(k, l = [[], []]); l[det && det[t] ? 1 : 0].push(a, b, c); }
  const big = p.length / 3 > 65535, keys = [];
  for (const [k, l2] of groups) { const nBase = l2[0].length, l = l2[0].concat(l2[1]); const gg = new THREE.BufferGeometry(); /* base first, details last: far blocks draw only the base */ for (const n in g.attributes) gg.setAttribute(n, g.attributes[n]);
    gg.setIndex(new THREE.BufferAttribute(big ? new Uint32Array(l) : new Uint16Array(l), 1));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const v of l) { const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    gg.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)); gg.boundingSphere = gg.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(gg, mat); mesh.matrixAutoUpdate = false; mesh.userData.nBase = nBase; mesh.userData.nAll = l.length; scene.add(mesh); const ck = key + '#' + keys.length; meshes.set(ck, mesh); keys.push(ck); }
  CHUNKS.set(key, keys);
}
const LOD_NEAR = 120; // m from the camera to the nearest edge of a block: beyond, small pieces (< 0.5 m^2, sub-pixel there) are left out
function chunkCull(cam) { // blocks lying entirely in the fog (> 99 %) are not drawn
  const d = scene.fog ? scene.fog.density : 0, far = d > 0 ? 2.3 / d : Infinity, cp = cam.position;
  for (const l of CHUNKS.values()) for (const k of l) { const o = meshes.get(k); if (!o) continue; const s = o.geometry.boundingSphere;
    const dd = Math.hypot(s.center.x - cp.x, s.center.z - cp.z) - s.radius; o.visible = dd < far;
    if (!o.userData.nAll) continue; const n = cam === camera && dd > LOD_NEAR ? o.userData.nBase : o.userData.nAll; /* isometric view: same scale everywhere, all details */ if (o.geometry.drawRange.count !== n) o.geometry.setDrawRange(0, n); } }
function addCollide(key, c, l2) { // outlines for walls, standing and jumping: [n, roof height, ground, x,z ...]; l2: derived from LoD2 (Runde 75)
  for (let i = 0; i < c.length;) { const n = c[i], h = c[i + 1], base = c[i + 2], p = c.subarray(i + 3, i + 3 + n * 2); i += 3 + n * 2;
    let a = Infinity, b = -Infinity, cc = Infinity, d = -Infinity; for (let k = 0; k < p.length; k += 2) { if (p[k] < a) a = p[k]; if (p[k] > b) b = p[k]; if (p[k + 1] < cc) cc = p[k + 1]; if (p[k + 1] > d) d = p[k + 1]; }
    const it = { p, h, base, minx: a, maxx: b, minz: cc, maxz: d, tile: key, l2: !!l2 };
    for (let ix = Math.floor(a / CELL); ix <= Math.floor(b / CELL); ix++) for (let iz = Math.floor(cc / CELL); iz <= Math.floor(d / CELL); iz++) { const k = gk(ix, iz); let arr = bgrid.get(k); if (!arr) bgrid.set(k, arr = []); arr.push(it); } } }
function buildingAt(x, z) {
  const arr = bgrid.get(gk(Math.floor(x / CELL), Math.floor(z / CELL))); if (!arr) return null; let best = null;
  for (const it of arr) { if (x < it.minx || x > it.maxx || z < it.minz || z > it.maxz) continue; if (inPoly(x, z, it.p) && (!best || it.h > best.h) && !itemGhost(it)) best = it; }
  return best;
}
function inPoly(x, z, p) { let ins = false; for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) { const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins; } return ins; }
const WFIELDS = new Map(); // shore fields per tile (also on the CPU): where is open water
// water under the player: distance to the shore (m) or null; bridges and piers count as dry
function waterProbe(x, z) { // Runde 181 (water sounds): {d: distance to the shore, hard: quay, flow: 0..1} or null
  for (const f of WFIELDS.values()) { const cx = Math.floor((x - f.x0) / f.c), cz = Math.floor((z - f.z0) / f.c); if (cx < 0 || cz < 0 || cx >= f.w || cz >= f.h) continue;
    const i = cz * f.w + cx, v = f.data[i * 2]; if (!(v > 0)) return null; const fx = f.flow ? f.flow[i * 2] - 128 : 0, fz = f.flow ? f.flow[i * 2 + 1] - 128 : 0;
    return { d: v / 4, hard: f.data[i * 2 + 1] > 127, flow: Math.hypot(fx, fz) > 40 ? 1 : 0 }; }
  return null;
}
function waterInfo(x, z) {
  for (const f of WFIELDS.values()) { const cx = Math.floor((x - f.x0) / f.c), cz = Math.floor((z - f.z0) / f.c); if (cx < 0 || cz < 0 || cx >= f.w || cz >= f.h) continue;
    const i = cz * f.w + cx; if (f.dry && f.dry[i]) return null; const v = f.data[i * 2]; if (!(v > 0)) return null; waterInfo.hard = f.data[i * 2 + 1] > 127; return v / 4; }
  return null;
}
// wading and swimming: near the shore the bed slopes down to hip depth, further out the figure swims (only head and shoulders out)
// height of the drawn water surface: the worker lays the water on a coarse terrain grid (16/48 m, each cell split along its diagonal);
// the fine terrain differs from it by metres in a gorge (phone test, Poellat: the figure stood far below the surface, wake and rings under it)
function waterSurf(x, z) {
  let S = 16; for (const f of WFIELDS.values()) if (x >= f.x0 && z >= f.z0 && x < f.x0 + f.w * f.c && z < f.z0 + f.h * f.c) { S = f.S || 16; break; }
  const G = (i, j) => terrainRaw(i * S, j * S), i = Math.floor(x / S), j = Math.floor(z / S), u = x / S - i, v = z / S - j;
  let h; if (u + v <= 1) { const h00 = G(i, j); h = h00 + (G(i + 1, j) - h00) * u + (G(i, j + 1) - h00) * v; } else { const h11 = G(i + 1, j + 1); h = h11 + (G(i, j + 1) - h11) * (1 - u) + (G(i + 1, j) - h11) * (1 - v); }
  return h - (TERRAIN ? 1.18 : -.02);
}
function waterFloor(x, z) { const d = waterInfo(x, z); if (d === null) return null; const surf = waterSurf(x, z);
  if (waterIce.value.x * 1.25 > .1 + .8 * Math.min(d, 16) / 16) return { y: surf + .03, swim: false, ice: true }; // Runde 143: frozen - one walks on the ice wherever it is drawn (from the shore outwards, as in the shader)
  return d < 2.5 && !waterInfo.hard ? { y: surf - Math.min(.95, .2 + d * .32), swim: false } : { y: surf - 1.5, swim: true }; } // at a quay wall the water is deep at once
function waterAt(x, z) {
  for (const f of WFIELDS.values()) { const cx = Math.floor((x - f.x0) / f.c), cz = Math.floor((z - f.z0) / f.c); if (cx < 0 || cz < 0 || cx >= f.w || cz >= f.h) continue; if (f.dry && f.dry[cz * f.w + cx]) continue; if (f.data[(cz * f.w + cx) * 2] > 4) return true; /* more than 1 m from the shore: ditches and the waterline stay walkable */ }
  return false;
}
function walkBlocked(x, z) { return !!(buildingAt(x, z) || buildingAt(x + .35, z) || buildingAt(x - .35, z) || buildingAt(x, z + .35) || buildingAt(x, z - .35)); } // on foot water is no obstacle any more (wading, swimming)
function blocked(x, z) { return !!(waterAt(x, z) || buildingAt(x, z) || buildingAt(x + .35, z) || buildingAt(x - .35, z) || buildingAt(x, z + .35) || buildingAt(x, z - .35)); }
/* Runde 137 (40 squares: on a square the name of a street beside it was shown): a named square area wins; standing on a pedestrian
   area, the nearest pedestrian way (a square is mapped as one) wins over the nearest street, within a wider radius */
function inRing(x, z, r, o, n) { let ins = false; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = r[o + i * 2], zi = r[o + i * 2 + 1], xj = r[o + j * 2], zj = r[o + j * 2 + 1]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins; } return ins; }
function streetAt(x, z, rmax) {
  let plaza = false;
  for (const t of tiles.values()) { const q = t.sqNames; if (q) for (let o = 0; o < q.length;) { const id = q[o], n = q[o + 1]; if (inRing(x, z, q, o + 2, n)) return t.names[id]; o += 2 + n * 2; }
    if (!plaza) for (const a of t.areas || []) if (a.k === 'p' && inRing(x, z, a.rings[0], 0, a.rings[0].length / 2)) { plaza = true; break; } }
  let best = null, bd = rmax * rmax, pb = null, pd = (rmax * 2.5) ** 2;
  for (const t of tiles.values()) { const s = t.samples; for (let i = 0; i < s.length; i += 3) { const d = (s[i] - x) ** 2 + (s[i + 1] - z) ** 2; if (d < bd) { bd = d; best = t.names[s[i + 2]]; } if (plaza && d < pd && t.pedNames && t.pedNames.has(s[i + 2])) { pd = d; pb = t.names[s[i + 2]]; } } }
  return pb || best; }
// nearest free point in the middle of a real street (not a footpath, no house within 2 m)
function freeStreetPoint(x0, z0, maxD) {
  let best = null, bd = maxD * maxD;
  for (const t of tiles.values()) { const s = t.start; for (let i = 0; i < s.length; i += 2) {
    const d = (s[i] - x0) ** 2 + (s[i + 1] - z0) ** 2;
    if (d < bd && !blocked(s[i], s[i + 1]) && !buildingAt(s[i] + 2, s[i + 1]) && !buildingAt(s[i] - 2, s[i + 1]) && !buildingAt(s[i], s[i + 1] + 2) && !buildingAt(s[i], s[i + 1] - 2)) { bd = d; best = [s[i], s[i + 1]]; } } }
  return best;
}
let placeTries = 0;
function placePlayer() {
  const best = freeStreetPoint(0, 0, 400);
  if (!best && ++placeTries < 4 && PRUEF === null && ISO === null) return; // wait for more map tiles before giving up
  if (LASTPOS && PRUEF === null && ISO === null) { P.x = 0; P.z = 0; P.yaw = LASTPOS.yaw || 0; } // exactly where the last session ended
  else if (best && PRUEF === null && ISO === null) { P.x = best[0]; P.z = best[1]; } P.placed = true; P.y = terrainH(P.x, P.z); P.vy = 0; // stands on the ground right away
  camera.position.set(P.x, 12, P.z + 16);
}

/* minimap: one canvas per vector tile, drawn once */
const MS = 0.4, MS0 = MS;
function drawTileMap(md, sc) {
  const MS = sc || MS0; // pixels per metre of this little map canvas
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  const ext = p => { for (let i = 0; i < p.length; i += 2) { if (p[i] < a) a = p[i]; if (p[i] > b) b = p[i]; if (p[i + 1] < c) c = p[i + 1]; if (p[i + 1] > d) d = p[i + 1]; } };
  for (const r of md.roads) ext(r.p); for (const ar of md.areas) ext(ar.rings[0]); for (const bl of md.blds) ext(bl);
  if (!isFinite(a)) return null;
  const cv = document.createElement('canvas'); cv.width = Math.min(1024, Math.ceil((b - a) * MS) + 2); cv.height = Math.min(1024, Math.ceil((d - c) * MS) + 2);
  const g = cv.getContext('2d'); const X = x => (x - a) * MS, Y = z => (z - c) * MS;
  const path = p => { g.moveTo(X(p[0]), Y(p[1])); for (let i = 2; i < p.length; i += 2) g.lineTo(X(p[i]), Y(p[i + 1])); };
  for (const ar of md.areas) { g.fillStyle = ar.k === 'w' ? '#5f93b0' : ar.k === 'f' ? '#3f5e30' : ar.k === 'p' ? '#c9bc9e' : '#4d6b37'; g.beginPath(); for (const r of ar.rings) { path(r); g.closePath(); } g.fill('evenodd'); }
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const r of md.roads) { g.strokeStyle = r.k === 'r' ? '#6b6258' : r.k === 'p' ? '#b8a888' : '#e2d4ad'; g.lineWidth = Math.max(1, r.w * MS * 1.4); g.beginPath(); path(r.p); g.stroke(); }
  g.fillStyle = '#8a7462'; for (const bl of md.blds) { g.beginPath(); path(bl); g.closePath(); g.fill(); }
  return { cv, x0: a, z0: c, s: MS };
}
const mini = $('mini'), mctx = mini.getContext('2d');
/* sights (from the map's points of interest): info card when the player comes close, counted as discovered */
const SIGHTS = new Map(), seen = new Set(store.get('hx.seen') || []);
const SIGHT_TYPE = { attraction: 'Sehenswürdigkeit', place_of_worship: 'Kirche / Gotteshaus', church: 'Kirche', cathedral: 'Dom', monument: 'Denkmal', memorial: 'Gedenkstätte',
  christian: 'Kirche', catholic: 'Kirche', protestant: 'Kirche', muslim: 'Moschee', jewish: 'Synagoge', buddhist: 'Tempel', castle: 'Burg / Schloss', museum: 'Museum', town_hall: 'Rathaus', theatre: 'Theater', viewpoint: 'Aussichtspunkt', ruins: 'Ruine', fort: 'Festung', zoo: 'Zoo', artwork: 'Kunstwerk' };
let sightNow = null;
function checkSights() {
  let best = null, bd = 32;
  for (const list of SIGHTS.values()) for (const s of list) { if (s.quiet) continue; const d = Math.hypot(s.x - P.x, s.z - P.z); if (d < bd) { bd = d; best = s; } }
  if (!best) { if (sightNow) { $('sight').hidden = true; sightNow = null; } return; }
  if (sightNow === best) return; sightNow = best;
  const first = !seen.has(best.name);
  if (first) { seen.add(best.name); store.set('hx.seen', [...seen].slice(-500)); }
  $('sightType').textContent = (SIGHT_TYPE[best.cls] || SIGHT_TYPE[best.cls.split(' ')[0]] || 'Sehenswürdigkeit') + (first ? ' · neu entdeckt +3' : '');
  $('sightName').textContent = best.name;
  $('sightLink').href = 'https://de.wikipedia.org/w/index.php?search=' + encodeURIComponent(best.name);
  $('sightCount').textContent = seen.size + ' entdeckt';
  $('sight').hidden = false;
}
/* Runde 92: Oberflächen-Themes. CSS-Tokens über <html data-ui>, die Minimap und die große Karte lesen ihre Farben hier:
   bg Hintergrund, f Filter auf die Kartenkacheln, me Pfeil der Spielfigur, ms dessen Rand, ring Puls (r,g,b), nb/ni Nordmarke,
   s / ss Sehenswürdigkeit neu / gesehen, r Route */
const UIT = {
  klassik: { name: 'Klassik', bg: '#3b4a2c', f: 'none', me: '#f2c46b', ms: '#1a1206', ring: '242,196,107', nb: 'rgba(12,15,26,.85)', ni: '#f3ead6', s: '#7fd3ff', ss: '#9ea6b8', r: '#4fc3ff' },
  neutral: { name: 'Neutral', bg: '#4a4d50', f: 'saturate(.45) brightness(1.04)', me: '#ffffff', ms: '#1b1d20', ring: '169,188,207', nb: 'rgba(27,29,32,.88)', ni: '#eceef0', s: '#a9bccf', ss: '#7d838b', r: '#a9bccf' },
  noir: { name: 'Noir', bg: '#111111', f: 'grayscale(1) contrast(1.25) brightness(.92)', me: '#e0262b', ms: '#000000', ring: '224,38,43', nb: 'rgba(0,0,0,.9)', ni: '#ffffff', s: '#ffffff', ss: '#666666', r: '#e0262b' },
  papier: { name: 'Papier', bg: '#d9ccae', f: 'sepia(.75) saturate(.8) brightness(1.08)', me: '#a8442a', ms: '#3b2a1a', ring: '168,68,42', nb: 'rgba(239,230,210,.94)', ni: '#3b2a1a', s: '#2f6f8f', ss: '#9a8a70', r: '#a8442a' },
  neon: { name: 'Neon', bg: '#140a24', f: 'saturate(1.6) hue-rotate(250deg) brightness(.9) contrast(1.2)', me: '#ff3fd2', ms: '#0d0618', ring: '0,229,255', nb: 'rgba(13,6,24,.88)', ni: '#f6e9ff', s: '#00e5ff', ss: '#7a5a9a', r: '#00e5ff' },
  wald: { name: 'Wald', bg: '#2a3a24', f: 'saturate(.85) sepia(.25)', me: '#d6a84a', ms: '#0f1a12', ring: '214,168,74', nb: 'rgba(15,26,18,.88)', ni: '#efe8cf', s: '#9fd18a', ss: '#6f7a60', r: '#d6a84a' }
};
let UI = UIT[store.get('hx.ui')] ? store.get('hx.ui') : 'klassik';
function setUI(id) { if (!UIT[id]) return; UI = id; store.set('hx.ui', id); if (id === 'klassik') delete document.documentElement.dataset.ui; else document.documentElement.dataset.ui = id;
  for (const b of document.querySelectorAll('#uiSeg button')) b.setAttribute('aria-pressed', b.dataset.ui === id ? 'true' : 'false'); }
for (const id in UIT) { const b = document.createElement('button'); b.className = 'pl'; b.type = 'button'; b.dataset.ui = id; b.textContent = UIT[id].name; b.addEventListener('click', () => setUI(id)); $('uiSeg').appendChild(b); }
setUI(UI);
function drawMini(viewYaw) {
  const c = mini.width / 2, zoom = 84 / (140 * MS), rot = -Math.PI / 2 - Math.atan2(Math.cos(viewYaw), Math.sin(viewYaw));
  mctx.save(); mctx.clearRect(0, 0, mini.width, mini.height); mctx.beginPath(); mctx.arc(c, c, c, 0, 7); mctx.clip();
  const T = UIT[UI]; mctx.fillStyle = T.bg; mctx.fillRect(0, 0, mini.width, mini.height);
  mctx.translate(c, c); mctx.rotate(rot); mctx.scale(zoom, zoom); mctx.translate(-P.x * MS, -P.z * MS);
  mctx.imageSmoothingEnabled = false;
  mctx.filter = T.f; for (const t of tiles.values()) if (t.map) mctx.drawImage(t.map.cv, t.map.x0 * MS, t.map.z0 * MS); mctx.filter = 'none';
  drawRouteMini(mctx, MS);
  if (window.HXZ) HXZ.drawMini(mctx, MS); // Runde 144: telephone booths (layer)
  if (LAYERS.burgen) for (const b of burgList()) { mctx.fillStyle = 'rgba(255,248,224,.95)'; mctx.beginPath(); mctx.arc(b.x * MS, b.z * MS, 19, 0, 7); mctx.fill(); burgIcon(mctx, b.x * MS, b.z * MS, 14); } // Runde 154/163: larger, on a light disc
  if (LAYERS.sights) for (const list of SIGHTS.values()) for (const s of list) { if (s.quiet) continue; mctx.fillStyle = 'rgba(255,248,224,.95)'; mctx.beginPath(); mctx.arc(s.x * MS, s.z * MS, 12, 0, 7); mctx.fill(); mctx.fillStyle = seen.has(s.name) ? T.ss : T.s; mctx.strokeStyle = '#1a1206'; mctx.lineWidth = 2.5; mctx.beginPath(); mctx.arc(s.x * MS, s.z * MS, 9, 0, 7); mctx.fill(); mctx.stroke(); } // Runde 163: larger, light halo, dark rim
  mctx.restore();
  if (window.HXGORE && HXGORE.scene) { /* Runde 171/178: the current emergency scene - from the moment the cars set off; outside the little map it sits
      on its rim in the direction of the place, with the distance, so one can go there after missing them */
    const S = HXGORE.scene, dx = (S.x - P.x) * MS * zoom, dz = (S.z - P.z) * MS * zoom, cr = Math.cos(rot), sr = Math.sin(rot); let sx = dx * cr - dz * sr, sy = dx * sr + dz * cr;
    const L = Math.hypot(sx, sy), lim = c - 20, out = L > lim; if (out) { sx *= lim / L; sy *= lim / L; }
    einsatzIcon(mctx, c + sx, c + sy, out ? 12 : 14);
    if (out) { const m = Math.round(Math.hypot(S.x - P.x, S.z - P.z)), txt = m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : m + ' m';
      mctx.font = '600 12px sans-serif'; mctx.textAlign = 'center'; mctx.textBaseline = 'middle'; mctx.lineWidth = 3; mctx.strokeStyle = '#1a1206'; mctx.fillStyle = '#fff';
      const tx = c + sx * (lim - 26) / lim, ty = c + sy * (lim - 26) / lim; mctx.strokeText(txt, tx, ty); mctx.fillText(txt, tx, ty); } }
  const pa = Math.atan2(Math.cos(P.yaw), Math.sin(P.yaw)) + rot + Math.PI / 2;
  { const ph = (performance.now() / 1200) % 1; mctx.strokeStyle = 'rgba(' + T.ring + ',' + (1 - ph).toFixed(2) + ')'; mctx.lineWidth = 3; mctx.beginPath(); mctx.arc(c, c, 12 + ph * 18, 0, 7); mctx.stroke();
    mctx.fillStyle = 'rgba(' + T.ring + ',.4)'; mctx.beginPath(); mctx.arc(c, c, 13, 0, 7); mctx.fill(); } // own position: pulsing gold ring
  mctx.save(); mctx.translate(c, c); mctx.rotate(pa); mctx.fillStyle = T.me; mctx.strokeStyle = T.ms; mctx.lineWidth = 2.5;
  mctx.beginPath(); mctx.moveTo(0, -14); mctx.lineTo(10, 11); mctx.lineTo(0, 5); mctx.lineTo(-10, 11); mctx.closePath(); mctx.fill(); mctx.stroke(); mctx.restore();
  const na = -Math.PI / 2 + rot, nx = c + Math.cos(na) * (c - 15), ny = c + Math.sin(na) * (c - 15);
  mctx.fillStyle = T.nb; mctx.beginPath(); mctx.arc(nx, ny, 11, 0, 7); mctx.fill();
  mctx.fillStyle = T.ni; mctx.font = '600 14px "Pixelify Sans", monospace'; mctx.textAlign = 'center'; mctx.textBaseline = 'middle'; mctx.fillText('N', nx, ny + 1);
  return rot;
}

/* big map: tap the minimap (or the place name) – pan, zoom, search an address, pick a point and jump there */
const bm = { cx: 0, cz: 0, s: 0.5, sel: null, ptr: new Map(), moved: 0, pinch: 0 };
const bigCv = $('bigCv'), bctx = bigCv.getContext('2d');
setInterval(() => { if (!$('bigmap').hidden) drawBig(); }, 120); // pulse of the own position
/* Runde 135: the own position as text in the big map: street (own street data), nearest house number, neighbourhood/district and town
   (vector map tiles, via the worker). Updated while the map is open and the figure or car moves; looked up again only after 40 m */
const WO = { id: 0, at: null, r: null, last: '' };
function hereText() {
  const x = DRV.on ? DV.x : P.x, z = DRV.on ? DV.z : P.z, d2 = (a, b) => (a[0] - x) ** 2 + (a[1] - z) ** 2;
  if (!WO.at || Math.hypot(WO.at[0] - x, WO.at[1] - z) > 40) { WO.at = [x, z]; const id = ++WO.id; worker.postMessage({ type: 'wo', id, x, z }); }
  const st = streetAt(x, z, 40), parts = [];
  let num = null; if (WO.r) { let bd = 22 * 22; for (const h of WO.r.nums) { const d = d2(h); if (d < bd) { bd = d; num = h[2]; } } }
  parts.push(st ? st + (num ? ' ' + num : '') : num ? 'bei Hausnummer ' + num : 'abseits der Straßen');
  if (WO.r) { const near = (cls, maxD) => { let b = null, bd = maxD * maxD; for (const p of WO.r.places) if (cls.includes(p[2])) { const d = d2(p); if (d < bd) { bd = d; b = p[3]; } } return b; };
    const clean = v => v && v.replace(/^(Stadtbezirk|Stadtteil|Ortsteil|Bezirk|Ortschaft)\s+/, '');
    const town = near(['city', 'town', 'village'], 15000), quarter = clean(near(['neighbourhood', 'quarter', 'hamlet', 'isolated_dwelling'], 900) || near(['suburb'], 2500)); // the smaller name first
    if (quarter && quarter !== town && quarter !== st) parts.push(quarter); if (town) parts.push(town); }
  const t = parts.join(' · '); if (t !== WO.last) { WO.last = t; $('bmHereT').textContent = t; } $('bmHere').hidden = false;
}
setInterval(() => { if (!$('bigmap').hidden && P.placed) hereText(); }, 1000);
function openBig(search) {
  bm.drive = DRV.on; $('bmGo').textContent = DRV.on ? 'Hinfahren' : 'Hierhin'; // Runde 78: in the car the map picks the destination (no extra button) bm.cx = P.x; bm.cz = P.z; bm.s = 0.6; bm.sel = null; bm.moved = 0; bm.ptr.clear(); $('bmGo').disabled = true; $('bmInfo').textContent = DRV.on ? 'Ziel suchen oder auf die Karte tippen' : 'Tippe auf einen Punkt der Karte'; $('bmRes').textContent = '';
  $('bigmap').hidden = false; sizeBig(); drawBig(); if (P.placed) hereText();
  if (search) setTimeout(() => $('bmQuery').focus(), 50);
}
function sizeBig() { const r = bigCv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); bigCv.width = Math.max(1, r.width * d | 0); bigCv.height = Math.max(1, r.height * d | 0); }
const toScr = (x, z) => [(x - bm.cx) * bm.s * bigCv.width / bigCv.clientWidth + bigCv.width / 2, (z - bm.cz) * bm.s * bigCv.width / bigCv.clientWidth + bigCv.height / 2];
const toWorld = (sx, sy) => { const k = bm.s * bigCv.width / bigCv.clientWidth; return [bm.cx + (sx * bigCv.width / bigCv.clientWidth - bigCv.width / 2) / k, bm.cz + (sy * bigCv.width / bigCv.clientWidth - bigCv.height / 2) / k]; };
function drawBig() {
  if ($('bigmap').hidden) return;
  const g = bctx, W = bigCv.width, H = bigCv.height, k = bm.s * W / bigCv.clientWidth;
  const T = UIT[UI]; g.fillStyle = T.bg; g.fillRect(0, 0, W, H); g.filter = T.f;
  g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1; const step = 100 * k; // 100 m grid where no map is loaded yet
  for (let x = ((W / 2 - bm.cx * k) % step + step) % step; x < W; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = ((H / 2 - bm.cz * k) % step + step) % step; y < H; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.imageSmoothingEnabled = false;
  bigTilesFor(W, H); // light map tiles of the whole view, loaded on demand (also where the game has not been yet)
  for (const t of BIG.tiles.values()) if (t && t.z === BIG.z) { const [x, y] = toScr(t.map.x0, t.map.z0); g.drawImage(t.map.cv, x, y, t.map.cv.width * k / t.map.s, t.map.cv.height * k / t.map.s); }
  for (const t of tiles.values()) if (t.map && BIG.z >= 14) { const [x, y] = toScr(t.map.x0, t.map.z0); g.drawImage(t.map.cv, x, y, t.map.cv.width * k / MS, t.map.cv.height * k / MS); }
  g.filter = 'none';
  const mark = (x, z, col, r) => { const [sx, sy] = toScr(x, z); g.fillStyle = col; g.strokeStyle = '#1a1206'; g.lineWidth = 2; g.beginPath(); g.arc(sx, sy, r, 0, 7); g.fill(); g.stroke(); };
  if (window.HXZ) HXZ.drawBig(g, toScr, W / bigCv.clientWidth, bm.s); // Runde 144
  if (window.HXGORE && HXGORE.scene) { const d = W / bigCv.clientWidth, [sx, sy] = toScr(HXGORE.scene.x, HXGORE.scene.z); einsatzIcon(g, sx, sy, 11 * d); g.font = '600 ' + (12 * d) + 'px sans-serif'; g.textAlign = 'center'; g.lineWidth = 3 * d; g.strokeStyle = '#1a1206'; g.fillStyle = '#f3ead6'; g.strokeText('Einsatz', sx, sy + 24 * d); g.fillText('Einsatz', sx, sy + 24 * d); g.textAlign = 'start'; } // Runde 171
  if (LAYERS.burgen) { const d = W / bigCv.clientWidth; for (const b of burgList()) { const [sx, sy] = toScr(b.x, b.z); burgIcon(g, sx, sy, 9 * d); // Runde 154: castles with their names
      if (bm.s >= .08 && b.t) { g.font = '600 ' + (12 * d) + 'px sans-serif'; g.textAlign = 'center'; g.lineWidth = 3 * d; g.strokeStyle = '#1a1206'; g.fillStyle = '#f3ead6'; g.strokeText(b.t, sx, sy + 22 * d); g.fillText(b.t, sx, sy + 22 * d); g.textAlign = 'start'; } } }
  if (bm.s >= .05 && LAYERS.sights) { const r = 6 * Math.max(.5, Math.min(1, bm.s / .25)); for (const list of SIGHTS.values()) for (const s of list) if (!s.quiet) mark(s.x, s.z, seen.has(s.name) ? '#9ea6b8' : '#7fd3ff', r); } // Runde 162: visible far out too, smaller dots
  drawRouteBig(g, toScr); if (window.HXORT && HXORT.draw) HXORT.draw(g, toScr, W / bigCv.clientWidth);
  { const [sx, sy] = toScr(P.x, P.z), d = W / bigCv.clientWidth, ph = (performance.now() / 1200) % 1; // own position: pulsing ring, arrow, label
    g.strokeStyle = 'rgba(' + T.ring + ',' + (1 - ph).toFixed(2) + ')'; g.lineWidth = 3 * d; g.beginPath(); g.arc(sx, sy, (14 + ph * 26) * d, 0, 7); g.stroke();
    g.fillStyle = 'rgba(' + T.ring + ',.35)'; g.beginPath(); g.arc(sx, sy, 15 * d, 0, 7); g.fill();
    g.save(); g.translate(sx, sy); g.rotate(Math.PI - P.yaw); g.fillStyle = T.me; g.strokeStyle = T.ms; g.lineWidth = 2.5 * d;
    g.beginPath(); g.moveTo(0, -17 * d); g.lineTo(12 * d, 13 * d); g.lineTo(0, 6 * d); g.lineTo(-12 * d, 13 * d); g.closePath(); g.fill(); g.stroke(); g.restore();
    g.font = '600 ' + (13 * d) + 'px sans-serif'; g.textAlign = 'center'; g.lineWidth = 3 * d; g.strokeStyle = '#1a1206'; g.fillStyle = '#fff7e0'; g.strokeText('Du', sx, sy + 32 * d); g.fillText('Du', sx, sy + 32 * d); g.textAlign = 'start'; }
  if (bm.sel) { const [sx, sy] = toScr(bm.sel.x, bm.sel.z); g.fillStyle = '#f2c46b'; g.strokeStyle = '#2a1d08'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx - 9, sy - 16); g.arc(sx, sy - 20, 10, Math.PI * .8, Math.PI * .2); g.closePath(); g.fill(); g.stroke(); }
  // scale bar
  const m = [50, 100, 200, 500, 1000, 2000, 5000].find(v => v * bm.s > 70) || 5000, px = m * k, d = W / bigCv.clientWidth;
  g.fillStyle = 'rgba(12,15,26,.75)'; g.fillRect(12 * d, H - 150 * d, px + 16 * d, 26 * d);
  g.fillStyle = '#f3ead6'; g.fillRect(20 * d, H - 132 * d, px, 3 * d); g.font = (12 * d) + 'px sans-serif'; g.fillText(m >= 1000 ? m / 1000 + ' km' : m + ' m', 20 * d, H - 137 * d);
}
// which light map tiles the big map needs: zoom level from the map scale, at most 6 requests at a time
const BIG = { tiles: new Map(), pending: new Set(), z: 14 };
function bigTilesFor(W, H) {
  if (!worker || !O) return;
  const z = bm.s >= .3 ? 14 : bm.s >= .1 ? 13 : bm.s >= .04 ? 12 : 11; BIG.z = z;
  const n = 1 << z, til = (x, zz) => { const ll = toLatLon(x, zz); return [Math.floor((ll[1] + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(ll[0] * Math.PI / 180) + 1 / Math.cos(ll[0] * Math.PI / 180)) / Math.PI) / 2 * n)]; };
  const [ax, az] = toWorld(0, 0), [bx, bz] = toWorld(bigCv.clientWidth, bigCv.clientHeight), t0 = til(ax, az), t1 = til(bx, bz);
  const need = [];
  for (let x = Math.min(t0[0], t1[0]); x <= Math.max(t0[0], t1[0]); x++) for (let y = Math.min(t0[1], t1[1]); y <= Math.max(t0[1], t1[1]); y++) {
    const key = z + '/' + x + '/' + y; if (BIG.tiles.has(key) || BIG.pending.has(key)) continue; need.push([x, y, key]); }
  const cx = (t0[0] + t1[0]) / 2, cy = (t0[1] + t1[1]) / 2; need.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy)); // middle first
  for (const [x, y, key] of need) { if (BIG.pending.size >= 6) break; BIG.pending.add(key); worker.postMessage({ type: 'maptile', z, x, y }); }
}
function selectAt(x, z, label) {
  bm.sel = { x, z };
  const near = streetAt(x, z, 60), dist = Math.hypot(x - P.x, z - P.z);
  $('bmInfo').textContent = (label || near || 'Gewählter Punkt') + ' · ' + (dist < 1000 ? Math.round(dist) + ' m' : (dist / 1000).toFixed(1) + ' km') + ' entfernt';
  $('bmGo').disabled = false; if (!label && window.HXORT && HXORT.tap) HXORT.tap(x, z); /* Runde 140: route editor */ drawBig();
}
function jumpTo(x, z) {
  // up to 30 km from the start the world can simply continue there; farther away a new start point keeps the numbers small
  if (Math.hypot(x, z) > 30000) { const ll = toLatLon(x, z); profile = Object.assign({}, profile, { lat: +ll[0].toFixed(6), lon: +ll[1].toFixed(6), label: $('bmInfo').textContent.split(' · ')[0] }); store.set('hx.profile', profile); store.set('hx.lastPos', null); location.href = location.pathname; return; }
  const f = freeStreetPoint(x, z, 150); P.x = f ? f[0] : x; P.z = f ? f[1] : z; P.y = terrainH(P.x, P.z); P.vy = 0; P.speed = 0;
  if (worker) worker.postMessage({ type: 'pos', x: P.x, z: P.z });
  $('bigmap').hidden = true; toast('Unterwegs zu ' + ($('bmInfo').textContent.split(' · ')[0]), 2200);
}
function toLatLon(x, z) { const X = x / O.c + O.X0, Y = -z / O.c + O.Y0; return [Math.atan(Math.sinh(Y / R)) * 180 / Math.PI, X / R * 180 / Math.PI]; }
$('bMap').addEventListener('click', () => { if (started) openBig(false); });
$('street').addEventListener('click', () => { if (started) openBig(true); });
$('bmClose').addEventListener('click', () => { $('bigmap').hidden = true; });
$('bmGo').addEventListener('click', () => { if (!bm.sel) return; if (bm.drive && DRV.on) { $('bigmap').hidden = true; driveTo(bm.sel.x, bm.sel.z, $('bmInfo').textContent.split(' · ')[0]); } else jumpTo(bm.sel.x, bm.sel.z); });
$('bmIn').addEventListener('click', () => { bm.s = Math.min(8, bm.s * 1.6); drawBig(); });
$('bmOut').addEventListener('click', () => { bm.s = Math.max(0.03, bm.s / 1.6); drawBig(); });
$('bmMe').addEventListener('click', () => { bm.cx = P.x; bm.cz = P.z; drawBig(); });
addEventListener('resize', () => { if (!$('bigmap').hidden) { sizeBig(); drawBig(); } });
bigCv.addEventListener('wheel', e => { e.preventDefault(); const [wx, wz] = toWorld(e.offsetX, e.offsetY); bm.s = Math.max(0.03, Math.min(8, bm.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2))); const [nx, nz] = toWorld(e.offsetX, e.offsetY); bm.cx += wx - nx; bm.cz += wz - nz; drawBig(); }, { passive: false });
bigCv.addEventListener('pointerdown', e => { try { bigCv.setPointerCapture(e.pointerId); } catch (err) { } bm.ptr.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); bm.moved = 0; if (bm.ptr.size === 2) { const [a, b] = [...bm.ptr.values()]; bm.pinch = Math.hypot(a.x - b.x, a.y - b.y); } });
bigCv.addEventListener('pointermove', e => {
  const p = bm.ptr.get(e.pointerId); if (!p) return; const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
  if (bm.ptr.size === 1) { bm.cx -= dx / bm.s; bm.cz -= dy / bm.s; bm.moved += Math.abs(dx) + Math.abs(dy); }
  p.x = e.offsetX; p.y = e.offsetY;
  if (bm.ptr.size === 2) { const [a, b] = [...bm.ptr.values()], d = Math.hypot(a.x - b.x, a.y - b.y); if (bm.pinch) bm.s = Math.max(0.03, Math.min(8, bm.s * d / bm.pinch)); bm.pinch = d; bm.moved += 99; }
  drawBig();
});
const bmUp = e => { bm.ptr.delete(e.pointerId); if (bm.ptr.size < 2) bm.pinch = 0; };
bigCv.addEventListener('click', e => { if (bm.moved < 8) { const [x, z] = toWorld(e.offsetX, e.offsetY); selectAt(x, z); } bm.moved = 0; }); // a tap (not a drag) picks the point
bigCv.addEventListener('pointerup', bmUp); bigCv.addEventListener('pointercancel', e => bm.ptr.delete(e.pointerId));
$('bmSearch').addEventListener('submit', async e => {
  e.preventDefault(); const q = $('bmQuery').value.trim(); if (!q) return; $('bmQuery').blur();
  const box = $('bmRes'); box.textContent = 'Suche …';
  try {
    const ll = toLatLon(P.x, P.z); // prefer results near the player
    const j = await geocode(q, ll); box.textContent = '';
    if (!j.length) { box.textContent = 'Nichts gefunden.'; return; }
    for (const it of j) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = it.name;
      b.addEventListener('click', () => { box.textContent = ''; const t = toLocal(it.lat, it.lon); bm.cx = t.x; bm.cz = t.z; bm.s = Math.max(bm.s, 0.6); selectAt(t.x, t.z, it.name.split(',').slice(0, 2).join(',')); });
      box.appendChild(b);
    }
  } catch (err) { // Runde 120 (simulated outage of Nominatim and Photon): search what the game already knows - loaded streets and sights
    const loc = localSearch(q); box.textContent = ''; boxMsg(box, loc.length ? 'Suchdienst gerade nicht erreichbar – Treffer aus der geladenen Umgebung:' : 'Suchdienst gerade nicht erreichbar, in der geladenen Umgebung nichts gefunden.');
    for (const it of loc) { const b = document.createElement('button'); b.type = 'button'; b.textContent = it.name;
      b.addEventListener('click', () => { box.textContent = ''; bm.cx = it.x; bm.cz = it.z; bm.s = Math.max(bm.s, 0.6); selectAt(it.x, it.z, it.name); }); box.appendChild(b); } }
});
function boxMsg(box, t) { const d = document.createElement('div'); d.className = 'pmsg'; d.textContent = t; box.appendChild(d); }
function localSearch(q) { // loaded sights and street names that contain the words, nearest first
  const w = q.toLowerCase().replace(/str(\.|a(ss|ß)e)/g, 'str').split(/[\s,]+/).filter(Boolean), ok = n => { const s = n.toLowerCase().replace(/stra(ss|ß)e/g, 'str'); return w.every(x => s.includes(x)); }, out = new Map();
  for (const list of SIGHTS.values()) for (const s of list) if (s.name && ok(s.name)) { const d = Math.hypot(s.x - P.x, s.z - P.z); const o = out.get(s.name); if (!o || d < o.d) out.set(s.name, { name: s.name, x: s.x, z: s.z, d }); }
  for (const t of tiles.values()) { if (!t.names || !t.samples) continue; for (let i = 0; i < t.samples.length; i += 3) { const n = t.names[t.samples[i + 2]]; if (!n || !ok(n)) continue;
    const x = t.samples[i], z = t.samples[i + 1], d = Math.hypot(x - P.x, z - P.z), o = out.get(n); if (!o || d < o.d) out.set(n, { name: n, x, z, d }); } }
  return [...out.values()].sort((a, b) => a.d - b.d).slice(0, 6);
}


/* Loading screen: pixel-art digital rain (the world builds up hidden behind it, the figure stands on the ground from the start).
   Colour and symbol set chosen in the settings; drawn on a canvas at 1/3 resolution, scaled up without smoothing. */
const mx = { run: false, raf: 0 };
function matrixStart() {
  const cv = $('mxCanvas'); if (!cv || mx.run) return; mx.run = true;
  const col = MX_COL[store.get('hx.mxColor') || 'gruen'], set = MX_SET[store.get('hx.mxSet') || 'katakana'] || MX_SET.katakana;
  const sc = 3, fs = 8; let W = 0, H = 0, drops = [], g = cv.getContext('2d'), last = 0;
  const resize = () => { W = cv.width = Math.ceil(innerWidth / sc); H = cv.height = Math.ceil(innerHeight / sc); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); drops = Array.from({ length: Math.ceil(W / fs) }, () => -Math.random() * H / fs); };
  resize(); addEventListener('resize', resize);
  const frame = t => { if (!mx.run) return; mx.raf = requestAnimationFrame(frame); if (t - last < 55) return; last = t;
    g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(0, 0, W, H); g.font = fs + 'px monospace'; g.textBaseline = 'top';
    for (let i = 0; i < drops.length; i++) { const y = drops[i] * fs, ch = set[Math.floor(Math.random() * set.length)];
      const c = col || ['hsl(' + ((i * 11 + t * .05) % 360) + ',100%,85%)', 'hsl(' + ((i * 11 + t * .05) % 360) + ',100%,50%)'];
      g.fillStyle = c[1]; g.fillText(set[Math.floor(Math.random() * set.length)], i * fs, y - fs); // the trail character
      g.fillStyle = c[0]; g.fillText(ch, i * fs, y);                                            // bright head
      drops[i] += 1; if (y > H && Math.random() > .975) drops[i] = -Math.random() * 6; } };
  mx.raf = requestAnimationFrame(frame);
}
function matrixStop() { mx.run = false; cancelAnimationFrame(mx.raf); }
$('mxColor').value = store.get('hx.mxColor') || 'gruen'; $('mxSet').value = store.get('hx.mxSet') || 'katakana';
$('mxColor').addEventListener('change', e => { store.set('hx.mxColor', e.target.value); mxAtlas(); });
$('mxSet').addEventListener('change', e => { store.set('hx.mxSet', e.target.value); mxAtlas(); });
$('bMxPrev').addEventListener('click', () => { // preview in its own overlay, so the game's loader state stays untouched
  let ov = $('mxPrev'); if (!ov) { ov = document.createElement('div'); ov.id = 'mxPrev'; ov.className = 'loader'; ov.innerHTML = '<canvas id="mxPrevC" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated"></canvas>'; document.body.appendChild(ov); }
  ov.hidden = false; ov.classList.remove('done'); const real = $('mxCanvas'); matrixStop(); real.id = 'mxCanvasOff'; $('mxPrevC').id = 'mxCanvas'; matrixStart();
  setTimeout(() => { ov.classList.add('done'); setTimeout(() => { ov.hidden = true; matrixStop(); $('mxCanvas').id = 'mxPrevC'; real.id = 'mxCanvas'; }, 1300); }, 3500); });
/* ================================================================ game */
let started = false, O = null, GOAL = { x: 0, z: 0, name: 'Startpunkt' };
const loaded = { ground: false, bld: false }; let readyTimer = 0;
function toLocal(lat, lon) { const m = merc(lat, lon); return { x: (m.X - O.X0) * O.c, z: -(m.Y - O.Y0) * O.c }; }
// no loading screen: the figure is there at once, the world builds up piece by piece in the Matrix style (moving is allowed);
// once streets and buildings are in, the Matrix style fades into the chosen style (mxIntro 1 -> 0)
let worldReady = false, mxIntro = 1, veil = 1;
function groundAround(R) { // how many of 9 points (figure + 8 around it at R m) lie on built ground blocks
  const boxes = []; for (const o of meshes.values()) if (o.material === groundMat && o.geometry) { const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox(); boxes.push(g.boundingBox); }
  let n = 0; for (let k = -1; k < 8; k++) { const x = P.x + (k < 0 ? 0 : Math.cos(k * Math.PI / 4) * R), z = P.z + (k < 0 ? 0 : Math.sin(k * Math.PI / 4) * R);
    if (boxes.some(b => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z)) n++; }
  return n; }
setInterval(() => { if (started && !worldReady && P.placed) checkReady(); }, 300); // blocks appear frame by frame, not with a message
/* Runde 120 (simulated map outage in the middle of a game: the figure walked on into a sky-blue void without any ground): where no
   ground block lies under and around the figure, the plain meadow plane stands in at the figure's height until the tiles arrive */
setInterval(() => { if (!TERRAIN || !worldReady) return; const v = groundAround(25) === 0; ground.visible = v; ground.position.y = v ? P.y - .06 : -.06; }, 500);
function checkReady() {
  if (!started || worldReady) return;
  /* Runde 66 (phone: the Matrix veil left too early, an unfinished world showed, streets came clearly later): the first ground message
     is not enough - its blocks are built over many frames and the tile under the figure may still be missing. Ready only when ground
     blocks really cover the figure and ~100 m around it and no blocks are waiting to be built (or after 30 s at the latest) */
  const waited = Date.now() - readyTimer;
  if (!loaded.ground && waited > 15000 && !checkReady.slow) { checkReady.slow = true; if (!(window.HXLI && HXLI.note('Die Kartendaten kommen gerade langsam – einen Moment Geduld …'))) toast('Kartendaten kommen gerade langsam – einen Moment Geduld …', 5000); }
  if (!loaded.ground) return; // Runde 120 (simulated map outage): without a single ground tile the world is not shown - the veil stays, a toast says why
  if (waited < 30000 && !(loaded.ground && (loaded.bld || waited > 8000) && JOBQ[0].length + JOBQ[1].length < 4 && groundAround(100) >= 7)) return;
  {
    worldReady = true; $('stick').closest('.hud').classList.remove('laden'); // Runde 125: controls fade in
    const hi = profile.name ? 'Hallo ' + profile.name + '! ' : '';
    const lab = (profile.label || '').split(',')[0].trim(), wo = lab && !/^link/i.test(lab) && !LASTPOS ? 'in ' + lab : (() => { const st = streetAt(P.x, P.z, 40); return st ? 'rund um ' + st : ''; })(); // Runde 92: greeting instead of the lights game
    setTimeout(() => toast(hi + 'Willkommen' + (wo ? ' ' + wo : '') + '! ' + ({ west: 'Willkommen im Wilden Westen – schau dich zu Fuß um.', cyber: 'Neonstadt bei Nacht – zu Fuß oder mit dem Auto.', mittel: 'Eine Stadt im Mittelalter – schau dich zu Fuß um.' }[WELT] || 'Schau dich um – zu Fuß, mit dem Auto oder mit Bus und Bahn.'), 4200), 500);
  }
}
// option: continue at the last position (saved every 3 s) - the world is centred there and the figure stands exactly there
const LASTPOS = (() => { const lp = store.get('hx.lastPos'); return store.get('hx.useLastPos') && !qs.get('lat') && lp && isFinite(lp.lat) && isFinite(lp.lon) ? lp : null; })();
function start() {
  started = true; $('stick').closest('.hud').classList.add('laden'); // Runde 125: no steering while the world builds
  const org = LASTPOS || profile;
  makeWorker(org.lat, org.lon);
  worker.postMessage({ type: 'init', welt: WELT, lat: org.lat, lon: org.lon, terrain: TERRAIN, weld: WELD, view: VIEW, eben: new URLSearchParams(location.search).get('eben') !== '0', verbinden: new URLSearchParams(location.search).get('verbinden') !== '0', breiten: new URLSearchParams(location.search).get('breiten') !== '0', kerboff: new URLSearchParams(location.search).get('kerb') === '0', reprio: new URLSearchParams(location.search).get('reprio') !== '0' }); // ?eben=0: streets follow the slope (comparison)
  const o = merc(org.lat, org.lon); O = { X0: o.X, Y0: o.Y, c: Math.cos(org.lat * Math.PI / 180) };
  const spar = { lat: 52.01436, lon: 8.52763 };
  const s = toLocal(spar.lat, spar.lon), home = toLocal(profile.lat, profile.lon);
  GOAL = Math.hypot(s.x - home.x, s.z - home.z) < 3500 ? { x: s.x, z: s.z, name: 'Sparrenburg' } : { x: home.x, z: home.z, name: 'Dein Startpunkt' };
  beacon.visible = false;
  $('whoami').textContent = (profile.name || 'Ohne Name') + ' · ' + (profile.label || '');
  $('loader').hidden = true; mxAtlas(); readyTimer = Date.now(); checkReady();
  setInterval(checkReady, 1000);
  setInterval(() => { if (worker) worker.postMessage({ type: 'pos', x: P.x, z: P.z, vx: DRV.on ? DV.vx : Math.sin(P.yaw) * P.speed, vz: DRV.on ? DV.vz : Math.cos(P.yaw) * P.speed }); }, 1200);
  setInterval(() => { if (!P.placed || PRUEF !== null || ISO !== null) return; const x = DRV.on ? DV.x : P.x, z = DRV.on ? DV.z : P.z, ll = toLatLon(x, z); store.set('hx.lastPos', { lat: +ll[0].toFixed(7), lon: +ll[1].toFixed(7), yaw: DRV.on ? DV.h : P.yaw }); }, 3000);
}

function spawnOrbs() {
  if (!P.placed) return;
  let tries = 0;
  while (orbs.length < 8 && tries++ < 40) {
    const arr = [...tiles.values()].filter(t => t.spawn.length); if (!arr.length) return;
    const t = arr[Math.floor(Math.random() * arr.length)], i = Math.floor(Math.random() * t.spawn.length / 2) * 2, x = t.spawn[i], z = t.spawn[i + 1];
    const d = Math.hypot(x - P.x, z - P.z); if (d < 35 || d > 260) continue;
    if (orbs.some(o => Math.hypot(o.x - x, o.z - z) < 30)) continue;
    const m = new THREE.Mesh(orbGeo, orbMat); m.position.set(x, 1.3, z); scene.add(m); orbs.push({ m, x, z, i: Math.random() * 6, y0: terrainH(x, z) });
  }
}

/* camera with collision ("spring arm"): never let a building sit between camera and player */
function freeDistance(px, py, pz, dx, dy, dz, maxD) {
  for (let s = 1.2; s < maxD; s += .7) { const x = px + dx * s, y = py + dy * s, z = pz + dz * s; const b = buildingAt(x, z); if (b && b.h + 0.8 > y) return Math.max(1.5, s - 1.2); }
  return maxD;
}
let armD = 16, armPitch = .42, look = 0; // look: -1 (down onto the street) … 0 (normal) … 1 (up at the sky)
function tilt(d) { // positive = look up
  if (camMode === 'dio') isoPitch = Math.max(0.3, Math.min(1.45, isoPitch - d * 0.9));
  else look = Math.max(-1, Math.min(1, look + d));
}
const lerpA = (a, b, t) => { const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };
let camYaw = P.yaw, last = performance.now(), time = 0, frame = 0, score = 0, carry = 0, shown = {}, ftAcc = 0, ftN = 0, ftBad = 0, ftGood = 0, pxT = 0, pxUpT = -99, pxBan = new Map(), pxTry = null, pxNoGain = -1, streetT = 0, lastStreet = '';

/* Wake and ripples (video "Pixel Art Water Trails", Godot): a ribbon along the last positions of the swimming / wading figure,
   wider and fainter towards the tail, a V of ripples running along it (sine over the distance from the middle and along the trail,
   quantised to 3 steps, dithered); its tail collapses when the trail is short. Plus two rings spreading from the figure.
   The low-res render pixelates it for free (the video needed an extra low-res texture for that). ~50 triangles. */
const WAKE_N = 13, wakePts = [];
const wakeGeo = new THREE.BufferGeometry();
wakeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 3), 3));
wakeGeo.setAttribute('aUV', new THREE.BufferAttribute(new Float32Array(WAKE_N * 2 * 2), 2));
{ const I = []; for (let i = 0; i < WAKE_N - 1; i++) { const a = i * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } wakeGeo.setIndex(I); }
const WAKE_GLSL_DITHER = 'float hxB2(vec2 a){a=floor(a);return fract(a.x*0.5+a.y*a.y*0.75);} float hxBayer(vec2 a){return hxB2(0.5*a)*0.25+hxB2(a);}';
const wakeMat = new THREE.ShaderMaterial({ uniforms: { uTime: waterTime, uLight: spriteUniforms.uLight, uStr: { value: 1 } }, side: THREE.DoubleSide, depthWrite: false,
  vertexShader: 'attribute vec2 aUV; varying vec2 vUV; void main(){ vUV = aUV; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform float uTime, uStr; uniform vec3 uLight; varying vec2 vUV; ' + WAKE_GLSL_DITHER + ` void main(){
    float v = abs(vUV.y), u = vUV.x;                                     // u: 0 at the figure, 1 at the tail; v: 0 middle, 1 edge
    float r = 0.5 + 0.5 * sin((v * 2.2 + u * 5.0) * 6.2832 - uTime * 7.0); // ripples travel outwards along the V
    float k = r * (1.0 - u) * (1.0 - v * v);                             // fade towards tail and edges
    k = min(1.0, k * uStr); k = floor(k * 3.0 + 0.2) / 3.0; if (k < 0.3) discard;               // quantised: pixel-art steps
    if (hxBayer(gl_FragCoord.xy) > k * 0.75) discard;
    gl_FragColor = vec4(mix(vec3(0.62, 0.80, 0.84), vec3(0.93, 0.98, 1.0), k) * uLight, 1.0); }` });
const wakeMesh = new THREE.Mesh(wakeGeo, wakeMat); wakeMesh.frustumCulled = false; wakeMesh.renderOrder = 2; wakeMesh.visible = false; scene.add(wakeMesh);
const ringGeo = new THREE.RingGeometry(.86, 1, 28, 1); ringGeo.rotateX(-Math.PI / 2);
const rings = [0, .5].map(ph => { const m = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({ uniforms: { uA: { value: 1 }, uLight: spriteUniforms.uLight }, depthWrite: false,
    vertexShader: 'void main(){ gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uA; uniform vec3 uLight; ' + WAKE_GLSL_DITHER + ' void main(){ if (hxBayer(gl_FragCoord.xy) > uA) discard; gl_FragColor = vec4(vec3(0.85, 0.95, 0.98) * uLight, 1.0); }' }));
  m.userData.ph = ph; m.renderOrder = 2; m.visible = false; scene.add(m); return m; });
let wakeAcc = 0;
function updateWake(dt) {
  const wf = !DRV.on && waterFloor(P.x, P.z), inW = !!wf && !wf.ice;
  // trail points: the figure's path on the water surface, a new point every 0.35 m; leaving the water lets the trail run out
  wakeAcc += dt;
  const last = wakePts[0];
  while (wakePts.length && (time - wakePts[wakePts.length - 1][3] > .9 || wakePts.length > 12)) wakePts.pop(); // short trail: every point fades after 0.9 s, at most ~7 m
  if (inW && (!last || Math.hypot(P.x - last[0], P.z - last[1]) > .6)) { wakePts.unshift([P.x, P.z, waterSurf(P.x, P.z) + .06, time]); if (wakePts.length > WAKE_N) wakePts.pop(); wakeAcc = 0; }
  else if ((Math.abs(P.speed) < .4 || !inW) && wakeAcc > .12 && wakePts.length) { wakePts.pop(); wakeAcc = 0; } // only standing still (or out of the water): slow swimming adds a point only every ~0.25 s          // standing still: the trail shrinks away
  const n = wakePts.length; wakeMesh.visible = n >= 3; wakeMat.uniforms.uStr.value = P.swim ? 1.9 : .9; // swimming: clear lines behind, wading: faint
  if (n >= 3) {
    const pos = wakeGeo.attributes.position.array, uv = wakeGeo.attributes.aUV.array, len = Math.min(1, n / 10); // short trail: the tail collapses
    for (let i = 0; i < WAKE_N; i++) { const j = Math.min(i, n - 1), p = wakePts[j], q = wakePts[Math.min(j + 1, n - 1)], o = wakePts[Math.max(j - 1, 0)];
      let dx = q[0] - o[0], dz = q[1] - o[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const u = j / (WAKE_N - 1), w = (0.3 + 1.3 * u) * len * (waterInfo(p[0], p[1]) === null ? 0 : 1);
      for (const [k, sd] of [[0, -1], [1, 1]]) { const b = (i * 2 + k) * 3; pos[b] = p[0] - dz * w * sd; pos[b + 1] = p[2]; pos[b + 2] = p[1] + dx * w * sd; uv[(i * 2 + k) * 2] = u; uv[(i * 2 + k) * 2 + 1] = sd; } }
    wakeGeo.attributes.position.needsUpdate = true; wakeGeo.attributes.aUV.needsUpdate = true; }
  // rings spreading from the figure while it is in the water (larger and calmer when it stands still)
  for (const m of rings) { m.visible = inW; if (!inW) continue; const t = (time * (P.swim ? .55 : .7) + m.userData.ph) % 1, s = .5 + t * (Math.abs(P.speed) < .5 ? 2.6 : 1.6);
    m.position.set(P.x, waterSurf(P.x, P.z) + .07, P.z); m.scale.set(s, 1, s); m.material.uniforms.uA.value = (1 - t) * .7; }
}
/* Runde 132: option "Bildrate auf 30 begrenzen" (hx.cap30) - like consoles: 30 even frames instead of jumping between 60 and 35; the
   phone stays cooler (no thermal throttling) and the battery lasts longer. Frames in between are skipped (60, 90, 120 Hz screens) */
let CAP30 = !!store.get('hx.cap30');
{ const t = $('tCap'); t.checked = CAP30; t.addEventListener('change', e => { CAP30 = e.target.checked; store.set('hx.cap30', CAP30); ftAcc = 0; ftN = 0; ftBad = 0; ftGood = 0; }); }
function step(now) {
  requestAnimationFrame(step);
  if (CAP30 && now - last < 1000 / 30 - 4) return;
  let dt = Math.min(.05, (now - last) / 1000); last = now; if (HITSTOP > 0) { HITSTOP -= dt; dt *= .15; } /* impact: a short hit-stop */ time += dt; frame++; waterTime.value = time; waterRain.value = window.WX && WX.state ? WX.state.rain || 0 : 0;
  updateWrecks(dt);
  if (!rt) makeRT();
  if (started && P.placed && $('profile').hidden) {
    let ix = jx, iy = jy;
    if (sid === null) { ix = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0); iy = (keys.s || keys.arrowdown ? 1 : 0) - (keys.w || keys.arrowup ? 1 : 0); }
    if (DRV.on) driveStep(dt, ix, iy); else {
    let tgt;
    const wf0 = waterFloor(P.x, P.z); P.swim = !!(wf0 && wf0.swim); P.wade = !!(wf0 && !wf0.swim && !wf0.ice); P.ice = !!(wf0 && wf0.ice);
    const vmax = (P.swim ? 4.2 : P.wade ? 3.5 : running || keys.shift ? 16 : 5.5) * (window.WX ? WX.walkV : 1); // walk / run (toggle button or Shift); slow in the water; Runde 141: deep snow slows down
    const gh = goCarStep(dt, ix, iy);
    if (gh !== null) { P.yaw = lerpA(P.yaw, gh, Math.min(1, dt * 8)); tgt = vmax; }
    else if (camMode === 'chase') { P.yaw -= ix * 2.3 * dt; tgt = -iy * (iy < 0 ? vmax : 4); }
    else { const fx = Math.sin(dioYaw), fz = Math.cos(dioYaw), rx = -Math.cos(dioYaw), rz = Math.sin(dioYaw);
      const vx = rx * ix + fx * (-iy), vz = rz * ix + fz * (-iy), l = Math.hypot(vx, vz); tgt = Math.min(1, l) * vmax;
      if (l > .08) P.yaw = lerpA(P.yaw, Math.atan2(vx, vz), Math.min(1, dt * 10)); }
    if (P.hold) tgt = 0;
    P.speed += (tgt - P.speed) * Math.min(1, dt * 6 * (window.WX ? WX.walkA : 1) * (P.ice ? .6 : 1)); // Runde 141: on ice the figure slides on
    if (P.hop && (P.ground && P.hop.t > .05 || (P.hop.t += dt) > 3)) P.hop = null; // aimed jump: fixed flight until it lands
    let mx = P.hop ? P.hop.vx * dt : Math.sin(P.yaw) * P.speed * dt, mz = P.hop ? P.hop.vz * dt : Math.cos(P.yaw) * P.speed * dt;
    if (P.kick) { const k = Math.max(0, 1 - P.kick.t / .9); mx += P.kick.vx * k * dt; mz += P.kick.vz * k * dt; if ((P.kick.t += dt) > .9) P.kick = null; } // wall dodge push, fading out
    const gAt = (x, z) => { const w = waterFloor(x, z); return w ? w.y : terrainH(x, z, P.y); };
    const solid = (x, z) => { if (TUN.segs.length && underground(x, z, P.y)) return false; for (const [a, b] of [[0, 0], [.35, 0], [-.35, 0], [0, .35], [0, -.35]]) if (objTop(x + a, z + b) > P.y + .45) return true; return false; }; // house walls, car sides: blocked unless one is above the top
    const wallAt = (x, z) => gAt(x, z) > P.y + (P.swim || P.wade || P.ice ? 2.6 : P.ground ? 1.2 : .7) || railAt(x, z, P.y) || solid(x, z); // a jump (~1.3 m) carries over railings and onto steps; out of the water one climbs the bank
    if (P.hop) { P.x += mx; P.z += mz; } else { const bx = Math.abs(mx) > 1e-5 && wallAt(P.x + mx, P.z), bz = Math.abs(mz) > 1e-5 && wallAt(P.x, P.z + mz); if (!bx) P.x += mx; if (!bz) P.z += mz;
      if ((bx || bz) && !P.ground) P.wall = { nx: bx ? -Math.sign(mx) : 0, nz: bz ? -Math.sign(mz) : 0, t: time }; } // in the air against a wall: remembered for the wall dodge
    const wf = waterFloor(P.x, P.z); let gy = wf ? wf.y + (wf.swim ? Math.sin(time * 2.6) * .06 : 0) : terrainH(P.x, P.z, P.y);
    { const ot = objTop(P.x, P.z); if (ot > gy && ot <= P.y + .45) gy = ot; } // standing on a roof or a car roof
    if (!worldReady && P.ground) { P.y = gy; P.vy = 0; } // while loading: stand on the ground (no drop from above when the terrain arrives)
    P.vy -= 22 * dt; P.y += P.vy * dt; if (P.y <= gy) { P.y = gy; P.vy = 0; P.ground = true; P.dj = false; P.flip = undefined; P.wd = 0; P.kick = null; P.wall = null; }
    }
  }
  player.position.set(P.x, P.y, P.z); player.rotation.y = P.yaw;
  updateWake(dt); updateLoot(dt);
  const amt = Math.min(1, Math.abs(P.speed) / 5), run = Math.max(0, Math.min(1, (Math.abs(P.speed) - 6) / 4)); // 0 walking … 1 running
  P.phase += Math.min(Math.abs(P.speed), 7.5) * dt * (1.5 + run * .3); // stride rate capped: faster running means longer strides, not frantic legs
  { const inAir = !P.ground && !P.swim && !DRV.on ? 1 : 0; FIGS.air += (inAir - FIGS.air) * Math.min(1, dt * 10); if (FIGS.wasAir && P.ground) FIGS.land = .22; FIGS.wasAir = !P.ground; FIGS.land = Math.max(0, FIGS.land - dt);
    HXFIG.pose(player.userData, { walk: amt * (1 - FIGS.air), run, phase: P.phase, air: FIGS.air, tuck: P.flip !== undefined ? 1 : FIGS.air * Math.max(0, Math.min(1, 1 - Math.abs(P.vy || 0) / 7)), crouch: FIGS.land / .22 * .8 }); }
  player.rotation.x = 0;
  if (P.flip !== undefined) { // Runde 130: front flip of the double jump, turning about the body's middle (0.9 m), not the feet
    P.flip = Math.min(1, P.flip + dt / .5); const th = (1 - (1 - P.flip) ** 2) * Math.PI * 2, hc = .9;
    player.rotation.x = th; player.position.y += hc - hc * Math.cos(th); player.position.x -= Math.sin(P.yaw) * hc * Math.sin(th); player.position.z -= Math.cos(P.yaw) * hc * Math.sin(th);
    if (P.flip >= 1) P.flip = undefined; }
  idleLife(dt, amt);

  // houses can appear after the start (more tiles loaded): never leave the player stuck inside one
  if (frame % 20 === 0 && !DRV.on && P.placed && !P.hop && PRUEF === null && ISO === null && walkBlocked(P.x, P.z) && objTop(P.x, P.z) > P.y + .45 && !(TUN.segs.length && underground(P.x, P.z, P.y))) { const f = freeStreetPoint(P.x, P.z, 300); if (f) { P.x = f[0]; P.z = f[1]; P.speed = 0; } }
  for (let k = orbs.length - 1; k >= 0; k--) {
    const o = orbs[k]; if (frame % 60 === 0) o.y0 = terrainH(o.x, o.z); o.m.position.y = o.y0 + 1.3 + Math.sin(time * 2.2 + o.i) * .25; o.m.rotation.y += dt * 1.5; o.m.rotation.x += dt * .7;
    const d2 = (o.x - P.x) ** 2 + (o.z - P.z) ** 2;
    if (d2 < 5.5 && P.y < 3) { scene.remove(o.m); orbs.splice(k, 1); carry++; toast(carry === 1 ? 'Ein Licht! Bring es zum Ziel.' : carry + ' Lichter dabei', 1500); }
    else if (d2 > 450 * 450) { scene.remove(o.m); orbs.splice(k, 1); }
  }

  // camera
  let vyaw;
  if (camMode === 'chase' && DRV.on) { vyaw = driveCam(dt); camYaw = DV.camYaw; }
  else if (camMode === 'chase') {
    camYaw = lerpA(camYaw, P.yaw, Math.min(1, dt * 3.5)); vyaw = camYaw;
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw), want = 16;
    const py = P.y + 1.6;
    // try normal angle, then a steeper one if a building is in the way
    const tryArm = pitch => { const ch = Math.cos(pitch), dx = -fx * ch, dy = Math.sin(pitch), dz = -fz * ch; return freeDistance(P.x, py, P.z, dx, dy, dz, want); };
    if (keys.r || keys.pageup) tilt(dt * 1.2); if (keys.f || keys.pagedown) tilt(-dt * 1.2);
    // tilted by the player: looking up lowers the camera behind the figure, looking down lifts it over the figure
    const base = look > 0 ? .42 - look * .36 : .42 - look * .85;
    let pitch = base, free = tryArm(base);
    if (free < want * .9) { const f2 = tryArm(Math.max(base, .85)); if (f2 > free) { pitch = Math.max(base, 1.05); free = f2; } if (free < want * .9) { const f3 = tryArm(1.35); if (f3 > free) { pitch = 1.35; free = f3; } } }
    armPitch += (pitch - armPitch) * Math.min(1, dt * 4);
    const freeNow = tryArm(armPitch);
    armD = freeNow < armD ? freeNow : armD + (Math.min(want, freeNow) - armD) * Math.min(1, dt * 2);
    const ch = Math.cos(armPitch);
    camera.position.set(P.x - fx * ch * armD, py + Math.sin(armPitch) * armD, P.z - fz * ch * armD);
    { const gh = terrainH(camera.position.x, camera.position.z) + .6; if (camera.position.y < gh) camera.position.y = gh; } // never below the slope
    { const ahead = 8 * (1 - Math.max(0, -look) * 0.85); camera.lookAt(P.x + fx * ahead, P.y + 2.2 + Math.max(0, look) * 9, P.z + fz * ahead); } // looking down: aim at the figure
    /* Runde 164 (phone test: inside a telephone booth only its roof showed above the menu): snap in front of the door, 14 m out,
       aimed a little below the booth - the whole booth stands in the upper half, clear of the booth menu */
    if (window.HXZ && HXZ.inside) { const bz = HXZ.inside, dx = Math.sin(bz.yaw), dz = Math.cos(bz.yaw);
      camera.position.set(bz.x + dx * 14, bz.y + 2.5, bz.z + dz * 14); camera.lookAt(bz.x, bz.y + .2, bz.z); camYaw = bz.yaw + Math.PI; armD = 14; } // 46° view: the booth fills ~24-52 % of the height
  } else {
    dioYaw = lerpA(dioYaw, dioTarget, Math.min(1, dt * 8));
    if (keys.r || keys.pageup) tilt(dt * 1.2); if (keys.f || keys.pagedown) tilt(-dt * 1.2);
    vyaw = dioYaw; camYaw = P.yaw; const fx = Math.sin(dioYaw), fz = Math.cos(dioYaw), D = 1200, p = isoPitch; // ~35° like classic isometric games
    iso.position.set(P.x - fx * D * Math.cos(p), P.y + D * Math.sin(p), P.z - fz * D * Math.cos(p));
    iso.lookAt(P.x, P.y + 1, P.z);
    // pixel snapping: move the camera only in whole render pixels, so pixel art does not shimmer while walking
    if (rt) { iso.updateMatrixWorld(); const e = iso.matrixWorld.elements, px = (iso.top - iso.bottom) / rt.height;
      const r = new THREE.Vector3(e[0], e[1], e[2]), u = new THREE.Vector3(e[4], e[5], e[6]), cr = iso.position.dot(r), cu = iso.position.dot(u);
      iso.position.addScaledVector(r, Math.round(cr / px) * px - cr).addScaledVector(u, Math.round(cu / px) * px - cu); }
  }
  // buildings in front of the player dissolve (radius in metres; larger in the isometric view)
  bldUniforms.uPlayer.value.set(P.x, P.y, P.z);
  { const tc = bldUniforms.uToCam.value.set(cam.position.x - P.x, cam.position.y - P.y - 1, cam.position.z - P.z); bldUniforms.uCamDist.value = tc.length(); tc.normalize(); }
  bldUniforms.uSeeR.value = 0; /* Runde 68: no hole any more ("no hole, whole buildings away") - LoD2 buildings go by their number, OSM ones by their footprint */ // a car needs a bigger hole than the figure (Runde 67) // isometric view too (phone test Koblenz: figure hidden behind LoD2 roofs, which have no footprint occluder)
  updateOccluders(dt);
  bldUniforms.uOccFull.value = post.uniforms.uMx.value > .5 ? 1 : 0;
  bldUniforms.uSimple.value = camMode === 'dio' && rt && rt.height / (2 * isoZoom) < 1 ? 1 : 0; /* Runde 62: windows read from 1 render pixel per metre (phones with the automatic pixel size 4-6 stayed plain at 2) */ // simplified facade only when a metre is under 2 render pixels (phone test: the auto pixel size made every phone view simplified)
  bldUniforms.uFocus.value.copy(camMode === 'dio' ? player.position : camera.position);
  /* Runde 63 (phone, chase view: facades without windows, only stripes): the facade maths ran on world coordinates (kilometres from the start);
     with the reduced precision of phone GPUs the window raster fell apart. Now everything is relative to the player / a nearby origin */
  bldUniforms.uFocusRel.value.copy(bldUniforms.uFocus.value).sub(bldUniforms.uPlayer.value); bldUniforms.uCamRel.value.copy(cam.position).sub(bldUniforms.uPlayer.value);
  { const o = bldUniforms.uOrg.value, q = 1856; if (Math.abs(P.x - o.x) > q || Math.abs(P.z - o.z) > q) { o.set(Math.round(P.x / q) * q, 0, Math.round(P.z / q) * q); bldUniforms.uOrgCell.value.set(o.x / 29, o.z / 29); } } // 1856 = 64 x 29 = 1160 x 1.6: window colours and roof tiles do not jump when the origin moves
  if (PRUEF !== null) {
    const h = PRUEF * Math.PI / 180, pt = (qs.has('neigung') ? +qs.get('neigung') : 10) * Math.PI / 180;
    if (camera.fov !== 75) { camera.fov = 75; camera.updateProjectionMatrix(); }
    camera.position.set(0, 2, 0); camera.lookAt(Math.sin(h) * 10, 2 + Math.tan(pt) * 10, -Math.cos(h) * 10);
    player.visible = false; P.x = 0; P.z = 0;
  }
  ground.position.x = P.x; ground.position.z = P.z;
  const d = cur.dir; sun.position.set(P.x + d[0] * 80, d[1] * 80, P.z + d[2] * 80); sun.target.position.set(P.x, 0, P.z);
  pLight.position.set(P.x, P.y + 4, P.z); HXL.uHxLP.value[0].copy(pLight.position); HXL.uHxLC.value[0].copy(pLight.color).multiplyScalar(pLight.intensity * .5);
  disc.position.set(cam.position.x + d[0] * 500, cam.position.y + Math.max(.12, d[1]) * 500, cam.position.z + d[2] * 500); disc.lookAt(cam.position);
  disc.visible = cam === camera; stars.position.copy(cam.position);

  if (worldReady && mxIntro > 0) mxIntro = Math.max(0, mxIntro - dt / 2.5);
  veil = Math.max(0, veil - dt / (worldReady ? 1.5 : 9)); post.uniforms.uVeil.value = (PRUEF === null && ISO === null) ? veil * veil * (3 - 2 * veil) : 0; // loading veil: full at the start, thins as the world fills, gone soon after it is ready
  { const iv = mxIntro * mxIntro * (3 - 2 * mxIntro); post.uniforms.uMx.value = Math.max(cur.mx || 0, (PRUEF === null && ISO === null) ? iv : 0); }
  if (tMix < 1) { tMix = Math.min(1, tMix + dt / 1.4); const e = tMix * tMix * (3 - 2 * tMix);
    for (const k in to) { const a = from[k], b = to[k]; if (Array.isArray(b)) { for (let i = 0; i < b.length; i++) cur[k][i] = a[i] + (b[i] - a[i]) * e; } else cur[k] = a + (b - a) * e; }
    applyMood(cur); }

  aimHand(cam); /* Runde 195 */
  updateSprites(cam, time, cam === iso, player.position, PRUEF === null && ISO === null); updateCarInstances(P.x, P.z); if (window.updateTiere) try { window.updateTiere(dt, time); } catch (e) { if (!window.TIERERR) { window.TIERERR = 1; console.error('Tiere', e); } } // Runde 82
  if (window.updateTraffic) try { window.updateTraffic(dt); } catch (e) { if (!window.TRERR) { window.TRERR = 1; console.error('Verkehr', e); } } // a traffic bug never stops the game loop /* Runde 81 */ if (frame % 30 === 0) updateFar(); if (frame % 20 === 0 && P.placed && PRUEF === null && ISO === null) checkSights();
  if (window.WX) try { WX.update(dt, time); } catch (e) { if (!window.WXERR) { window.WXERR = 1; console.error('Wetter', e); } } // Runde 141
  runJobs(); chunkCull(cam);
  if (post.uniforms.uMx.value > 0.001) { const pu = post.uniforms; cam.updateMatrixWorld(); pu.uInvProj.value.copy(cam.projectionMatrixInverse); pu.uCamWorld.value.copy(cam.matrixWorld); pu.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    const fw = new THREE.Vector3(); cam.getWorldDirection(fw); const ax = Math.abs(fw.x) > Math.abs(fw.z); pu.uFlow.value.set(ax ? Math.sign(fw.x) : 0, ax ? 0 : Math.sign(fw.z)); // floor streams: along the main axis nearest to the view (stable while turning)
    if (cam.isPerspectiveCamera) pu.uPxW.value = 2 * Math.tan(cam.fov * Math.PI / 360) / rt.height; else pu.uPxO.value = (cam.top - cam.bottom) / cam.zoom / rt.height; }
  renderer.setRenderTarget(rt); renderer.render(scene, cam);
  renderer.setRenderTarget(null); renderer.render(postScene, postCam);

  // HUD
  if (frame % 2 === 0) drawMini(vyaw);
  if (time - streetT > .6 && P.placed) { streetT = time; const s = streetAt(P.x, P.z, 22); if (s && s !== lastStreet) { lastStreet = s; $('streetName').textContent = s; $('street').hidden = false; } }

  // keep it smooth on old phones: coarser pixels if frames get slow
  if (started && !document.hidden) { ftAcc += dt; ftN++;
    if (ftN >= 60) { const avg = ftAcc / ftN; ftAcc = 0; ftN = 0;
      /* Runde 126/127 (phone: the pixels got coarser while driving and did not come back after stopping and walking slowly).
         Coarser: two slow windows in a row (~2.5-4 s under 24 fps), at most every 4 s. Finer: quickly - one window over 40 fps
         (the old 50 fps were often never reached on a phone at a coarse level), every 1.5 s, not while driving fast. If a finer
         level turns slow again within 12 s, it is not tried again for 45 s (no flip-flop) */
      const fast = DRV.on && Math.hypot(DV.vx, DV.vz) > 2;
      ftBad = avg > 1 / 24 ? ftBad + 1 : 0; ftGood = avg < (CAP30 ? 1 / 28 : 1 / 40) ? ftGood + 1 : 0; if (ftGood) pxNoGain = -1; /* smooth again: try coarser again when needed; capped at 30: holding the 30 counts as smooth */ if (avg < 1 / 55 && !CAP30) pxBan.clear(); /* fully smooth (the load is gone): no level is barred any more */
      /* Runde 131 (phone: "Px 3 auto" at 27 fps, it never came back - 27 is neither under 24 nor over 40): a coarser level is kept only
         if it really helps. Two windows after the step the frame rate is compared with the one before; under +20 % the slowness does
         not come from the pixel count (CPU, tile loading) - back to the finer level at once, and no coarser step for 90 s */
      if (pxTry && pxSize === pxTry.lvl && ++pxTry.n >= 2) { const gain = (1 / avg) / pxTry.before; pxTry = null;
        if (gain < 1.2 && pxSize > userPx) { pxSize--; makeRT(); markPx(); pxT = time; pxNoGain = time + 90; ftBad = 0; } }
      if (ftBad >= 2 && pxSize < 6 && time - pxT > 4 && time > pxNoGain) { if (time - pxUpT < 12) pxBan.set(pxSize, time + 45); pxSize++; makeRT(); markPx(); pxT = time; ftBad = 0; pxTry = { lvl: pxSize, before: 1 / avg, n: 0 }; }
      else if (ftGood >= 1 && pxSize > userPx && !fast && time - pxT > 1.5 && !((pxBan.get(pxSize - 1) || 0) > time)) { pxSize--; makeRT(); markPx(); pxT = pxUpT = time; ftGood = 0; } } }
}

window.HX = { meshes, tiles, P, keys, buildingAt, get ter() { return { near: TER.tiles.size, far: TER.far.size, h0: TER.h0, farMesh: farMesh ? farMesh.geometry.attributes.position.count : 0 }; }, get occ() { return occSlots.map(o => [o.a.toFixed(2), o.b.h, o.b.p.length / 2]); }, get toCam() { return bldUniforms.uToCam.value.toArray(); }, get worker() { return worker; }, get arm() { return [armPitch, armD]; } }; // for debugging in the browser console

/* ================================================================ boot */
setMood(moodId, true); cur = clone(to); tMix = 1; applyMood(cur);
if (store.get('hx.auto')) setAuto(true);
if (ISO !== null) { pxSize = userPx = 2; document.querySelectorAll('.hud > :not(.loader)').forEach(el => { el.style.visibility = 'hidden'; }); if (moodId !== 'original') setMood('original', true);
  const h = ISO * Math.PI / 180; setCam('dio'); dioYaw = dioTarget = Math.atan2(Math.sin(h), -Math.cos(h)); if (qs.has('zoom')) isoZoom = +qs.get('zoom'); fitIso(); player.visible = false; }
if (PRUEF !== null) { pxSize = userPx = 2; document.querySelectorAll('.hud > :not(.loader)').forEach(el => { el.style.visibility = 'hidden'; }); if (moodId !== 'original') setMood('original', true); }
makeRT();
requestAnimationFrame(step);
/* ================================================================ driving
   
   Get into any parked car (button next to the car or key C), drive yourself or pick an address and let the car drive you there.
   Arcade rally handling: quick acceleration, weight transfer you can see (body leans and dips), the rear steps out under the handbrake
   or in fast corners (drift), jumps over crests, bounces off walls. Camera lags behind the drift angle, widens with speed.
   Route: graph from the streets of the loaded map tiles (shared corners merged), A* search, rebuilt every few seconds while new
   tiles arrive – a far address is approached tile by tile. Taking the stick while the autopilot drives hands control back.
   Engine and tyre sounds with WebAudio (no files). */
const DRV = { on: false, car: null, mesh: null, hb: false, auto: null, route: null, near: null, parked: [] };
const DV = { x: 0, z: 0, y: 0, h: 0, vx: 0, vz: 0, vy: 0, air: false, yawRate: 0, lean: 0, dip: 0, camYaw: 0, shake: 0, gPrev: 0, slip: 0, steer: 0 };

/* ------------------------------------------------------------ enter / leave */
function nearestParked(maxD) {
  let best = null, bd = maxD * maxD;
  for (const [key, a] of carTiles) for (let i = 0; i < a.length; i += 6) {
    if (a[i + 3] < 0 || a[i + 3] >= 8) continue; const d = (a[i] - P.x) ** 2 + (a[i + 1] - P.z) ** 2; // boats (types 8-10) are not for driving
    if (d < bd) { bd = d; best = { a, i, key }; }
  }
  return best;
}
/* Runde 65: tap a car - the figure walks there and gets in; while driving, a tap on another car swaps into it */
const GOCAR = { n: null, t: 0, best: 1e9, still: 0, mark: null };
function carUnder(cx, cy) { // the parked car under a tap: projected on the screen, picked within its own size
  const r = view.getBoundingClientRect(), v = new THREE.Vector3(), w = new THREE.Vector3(); let best = null, bs = 1;
  for (const [key, a] of carTiles) for (let i = 0; i < a.length; i += 6) {
    if (a[i + 3] < 0 || a[i + 3] >= 8) continue; const dd = Math.hypot(a[i] - P.x, a[i + 1] - P.z); if (dd > 260) continue;
    const y = terrainH(a[i], a[i + 1]); v.set(a[i], y + .8, a[i + 1]).project(cam); if (v.z > 1 || v.z < -1) continue;
    w.set(a[i], y + 3.2, a[i + 1]).project(cam); const px = (v.x + 1) / 2 * r.width + r.left, py = (1 - v.y) / 2 * r.height + r.top;
    const rad = Math.max(26, Math.abs(w.y - v.y) / 2 * r.height), sc = Math.hypot(px - cx, py - cy) / rad;
    if (sc < bs) { bs = sc; best = { a, i, key, x: a[i], z: a[i + 1] }; } }
  return best; }
function tapAt(cx, cy) {
  if (!started || !P.placed || !$('profile').hidden || !$('bigmap').hidden) return;
  { const bx = boxUnder(cx, cy); if (bx) { tapBox(bx); return; } } // a crate on a wall (Runde 72)
  const n = carUnder(cx, cy); if (!n) return;
  if (DRV.on) { if (Math.hypot(DV.vx, DV.vz) > 25) { toast('Zu schnell zum Umsteigen', 1200); return; } swapCar(n); return; }
  if (Math.hypot(n.x - P.x, n.z - P.z) < 3.5) { enterCar(n); return; }
  Object.assign(GOCAR, { n, t: 0, best: 1e9, still: 0 }); showCarMark(n); toast('Zum Auto …', 1000); }
function showCarMark(n) { if (!GOCAR.mark) { GOCAR.mark = new THREE.Mesh(new THREE.OctahedronGeometry(.45, 0), new THREE.MeshBasicMaterial({ color: '#f5c451' })); GOCAR.mark.scale.y = 1.5; scene.add(GOCAR.mark); }
  GOCAR.mark.visible = !!n; }
function stopGoCar(msg) { GOCAR.n = null; showCarMark(null); if (msg) toast(msg, 1400); }
// walking to the tapped car: straight on, around walls by trying side directions, a jump when stuck; any stick input hands control back
function goCarStep(dt, ix, iy) {
  const g = GOCAR.n; if (!g) return null;
  if (ix || iy) { stopGoCar(); return null; }
  if (!g.box && (g.a[g.i + 3] < 0 || carTiles.get(g.key) !== g.a)) { stopGoCar('Das Auto ist weg'); return null; }
  const dx = g.x - P.x, dz = g.z - P.z, d = Math.hypot(dx, dz);
  if (g.box) GOCAR.mark.position.set(g.box.x, g.box.y + 1 + Math.sin(time * 4) * .15, g.box.z); else GOCAR.mark.position.set(g.x, terrainH(g.x, g.z) + 2.6 + Math.sin(time * 4) * .2, g.z); GOCAR.mark.rotation.y += dt * 3;
  if (g.box && Math.hypot(g.box.x - P.x, g.box.z - P.z) < 2.6) { const b = g.box; stopGoCar(); P.yaw = Math.atan2(b.x - P.x, b.z - P.z); lootBox(b); return null; }
  if (!g.box && d < 3.2) { const n = g; stopGoCar(); enterCar(n); return null; }
  GOCAR.t += dt; if (d < GOCAR.best - .5) { GOCAR.best = d; GOCAR.still = 0; } else GOCAR.still += dt;
  if (GOCAR.still > 1.2 && GOCAR.still - dt <= 1.2) jump();
  if (GOCAR.still > 6 || GOCAR.t > 90) { stopGoCar(g.box ? 'Kein Weg zur Kiste gefunden' : 'Kein Weg zum Auto gefunden'); return null; }
  const h0 = Math.atan2(dx, dz); let h = h0;
  for (const o of [0, .5, -.5, 1, -1, 1.5, -1.5]) { const hx = h0 + o * (GOCAR.still > 3 ? -1 : 1); if (!walkBlocked(P.x + Math.sin(hx) * 1.5, P.z + Math.cos(hx) * 1.5) || d < 4) { h = hx; break; } }
  return h; }
function swapCar(n) { // leave the driven car where it is (parked) and sit in the tapped one
  stopAuto(); const old = { x: DV.x, z: DV.z, h: DV.h, type: DRV.car.type, colour: DRV.car.colour };
  scene.remove(DRV.mesh); DRV.mesh.geometry.dispose(); DRV.mesh = null; DRV.on = false; dropCarLights();
  enterCar(n);
  DRV.parked.push(old.x, old.z, old.h, old.type, old.colour, 0); setCarTile('drv', Float32Array.from(DRV.parked));
  toast('Auto gewechselt', 1200); }
/* Runde 130 ("steal a car like in GTA"): a traffic car that has stopped (usually because the figure stands in front of it) and is
   within 3.2 m of its body can be taken - Einsteigen button or C. The car leaves the traffic, the figure sits in it (same vehicle
   and colour), the driver jumps out on the left and runs away. Rail vehicles are not taken. */
function stoppedTraffic(maxD) {
  const T = window.TR; if (!T || !T.cars || !window.HXFZ || !worldReady) return null; const V = HXFZ.build(); let best = null, bd = maxD;
  for (const c of T.cars) { if (c.v > .8 || c.dead || !V[c.type] || V[c.type].rail) continue;
    const fx = Math.sin(c.h), fz = Math.cos(c.h), rx = P.x - c.x, rz = P.z - c.z, al = Math.abs(rx * fx + rz * fz), lat = Math.abs(rx * fz - rz * fx);
    const d = Math.hypot(Math.max(0, al - c.len / 2), Math.max(0, lat - 1.1)); if (d < bd) { bd = d; best = c; } }
  return best; }
function jackCar(c) {
  const T = window.TR, V = HXFZ.build()[c.type]; c.dead = 1; T.cars = T.cars.filter(o => o !== c);
  const ci = c.col ? CAR_COLOURS.findIndex(k => k.equals(c.col)) : -1;
  const i = DRV.parked.length; DRV.parked.push(c.x, c.z, c.h, 1, Math.max(0, ci), 0); setCarTile('drv', Float32Array.from(DRV.parked));
  enterCar({ a: carTiles.get('drv'), i, key: 'drv' });
  setDriveModel(c.type);
  if (c.col && DRV.mesh && V && (V.cls === 'car' || V.cls === 'sport')) { const a = DRV.mesh.geometry.attributes.iCol; a.setXYZ(0, c.col.r, c.col.g, c.col.b); a.needsUpdate = true; }
  fleeDriver(c.x + Math.cos(c.h) * 1.7, c.z - Math.sin(c.h) * 1.7);
  toast('Auto gekapert! Der Fahrer rennt davon.', 2200); }
function fleeDriver(x, z) { // the driver: a figure from the kit that runs away from the player for ~4 s, then is gone
  if (!window.HXFIG) return; const pool = ['taxifahrer', 'touristin', 'paketbote', 'journalistin', 'gaertner', 'diva', 'koechin', 'detektiv'];
  const g = new THREE.Group(), J = HXFIG.make(Object.assign({}, HXFIG.byId(pool[(Math.random() * pool.length) | 0]), { item: null }), g); scene.add(g);
  let dx = x - P.x, dz = z - P.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; let ph = 0, t = 0, y = terrainH(x, z), last = performance.now(), h = Math.atan2(dx, dz);
  const step = now => { const dt = Math.min(.05, (now - last) / 1000); last = now; t += dt;
    if (t > 4.5 || !started) { scene.remove(g); g.traverse(o => { if (o.geometry) o.geometry.dispose(); }); return; }
    const v = t < .35 ? 2 : 6.5, nx = x + dx * v * dt, nz = z + dz * v * dt;
    if (buildingAt(nx, nz)) { const tx = -dz; dz = dx; dx = tx; } else { x = nx; z = nz; } // a wall: turn aside
    let dh = Math.atan2(dx, dz) - h; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); h += dh * Math.min(1, dt * 10);
    y += (terrainH(x, z, y + 1) - y) * Math.min(1, dt * 12); ph += v * dt * 1.8;
    HXFIG.pose(J, { walk: 1, run: t < .35 ? 0 : 1, phase: ph, air: 0, tuck: 0, crouch: 0 });
    g.position.set(x, y, z); g.rotation.y = h; requestAnimationFrame(step); };
  requestAnimationFrame(step); }
function enterCar(pick) {
  if (!(pick && pick.a) && !DRV.near && DRV.jack && !DRV.on) { const c = DRV.jack; DRV.jack = null; jackCar(c); return; }
  const n = (pick && pick.a ? pick : null) || DRV.near || nearestParked(5); if (!n) return; stopGoCar();
  const a = n.a, i = n.i, type = a[i + 3] | 0, colour = a[i + 4] | 0;
  a[i + 3] = -1; carDirty = true; carVer++; if (n.key === 'drv') DRV.parked[i + 3] = -1; // (a car parked by the player stays gone when the next one is parked) // the parked car disappears, the driven one takes its place
  const geo = carMeshes[type].geometry.clone(); geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(3), 3)); geo.setAttribute('iVar', new THREE.InstancedBufferAttribute(new Float32Array([0.5]), 1));
  const c = CAR_COLOURS[colour] || CAR_COLOURS[0]; geo.attributes.iCol.setXYZ(0, c.r, c.g, c.b);
  const m = new THREE.InstancedMesh(geo, carMat, 1); m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m);
  DRV.mesh = m; DRV.car = { type, colour, len: type === 7 ? 6 : type === 0 ? 3 : 4.5 };
  Object.assign(DV, { safe: null, stuck: 0, arm: 0, x: a[i], z: a[i + 1], h: a[i + 2], vx: 0, vz: 0, vy: 0, air: false, yawRate: 0, lean: 0, dip: 0, camYaw: a[i + 2], shake: 0, slip: 0, steer: 0 });
  DV.y = DV.gPrev = terrainH(DV.x, DV.z);
  DRV.on = true; player.visible = false; P.speed = 0;
  $('bJump').textContent = 'Drift'; $('bCar').setAttribute('aria-label', 'Aussteigen'); $('bCar').classList.add('on');
  $('bRun').hidden = true; $('bCall').hidden = true; $('speedo').hidden = false;
  snd.start(); toast('Losfahren: Joystick hoch = Gas, runter = Bremse · Drift-Knopf = Handbremse', 3200);
  $('bModel').hidden = false; const fm = store.get('hx.fzModel'); if (fm && window.HXFZ) setDriveModel(HXFZ.index(fm));
}
/* Runde 96: any vehicle of the kit (fahrzeuge.js) as the own car, for testing - Fahrzeug button while driving, choice kept (hx.fzModel) */
function setDriveModel(vi) {
  if (!DRV.on || !DRV.mesh) return;
  let geo, mat;
  if (vi < 0 || !window.HXFZ) { geo = carMeshes[DRV.car.type].geometry.clone(); mat = carMat; delete DRV.car.fz; DRV.car.len = DRV.car.type === 7 ? 6 : DRV.car.type === 0 ? 3 : 4.5; }
  else { const v = HXFZ.build()[vi]; if (!v) return; geo = v.geo.clone(); mat = HXFZ.material; DRV.car.fz = vi; DRV.car.len = v.len; }
  const c = CAR_COLOURS[DRV.car.colour] || CAR_COLOURS[0], kit = DRV.car.fz !== undefined, v = kit ? HXFZ.build()[vi] : null, own = kit && v.cls !== 'car' && v.cls !== 'sport';
  geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(Float32Array.from(own ? [-1, 0, 0] : [c.r, c.g, c.b]), 3));
  geo.setAttribute('iVar', new THREE.InstancedBufferAttribute(new Float32Array([.5 + (kit && v.em ? 2 : 0)]), 1));
  scene.remove(DRV.mesh); DRV.mesh.geometry.dispose(); dropCarLights();
  const m = new THREE.InstancedMesh(geo, mat, 1); m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); DRV.mesh = m;
  if (v && v.parts) { m.userData.v = v; m.userData.st = {}; m.userData.pm = v.parts.map(pt => { const g = pt.geo.clone(); // Runde 140: trailer parts of the own vehicle (children: removed with it)
    g.setAttribute('iCol', geo.attributes.iCol.clone()); g.setAttribute('iVar', geo.attributes.iVar.clone()); const q = new THREE.InstancedMesh(g, mat, 1); q.frustumCulled = false; m.add(q); return q; }); }
  placeCarMesh();
}
/* Runde 97: carousel with pictures and type filter. Pictures: rendered once with a small own renderer (a few per frame), then dropped */
const FZ_CATS = [['alle', 'Alle'], ['pkw', 'Pkw'], ['sport', 'Sport'], ['gelaende', 'Gelände'], ['transporter', 'Transporter'], ['lkw', 'Lkw'], ['bus', 'Bus'], ['einsatz', 'Einsatz'], ['militaer', 'Militär'], ['bahn', 'Bahn']];
function fzCat(v) { return v.mil ? 'militaer' : v.rail ? 'bahn' : v.bus || v.id === 'reisebus' ? 'bus' : v.em ? 'einsatz' : /^gw/.test(v.id) ? 'gelaende' : v.cls === 'sport' ? 'sport'
  : (v.cls === 'car' && v.id !== 'transporter') || v.id === 'mafia' || v.id === 'taxi' ? 'pkw' : v.road ? 'lkw' : 'transporter'; }
const FZ = { cat: 'alle', pics: null };
function fzPictures(done) {
  if (FZ.pics) return done(); FZ.pics = [];
  const V = HXFZ.build(), W = 192, H = 128, r = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true }); r.setSize(W, H); r.setPixelRatio(1);
  const sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight(0xffffff, 0x666655, .9)); const dl = new THREE.DirectionalLight(0xffffff, .7); dl.position.set(-3, 5, 4); sc.add(dl);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 200); let i = 0;
  const step = () => { for (let k = 0; k < 6 && i < V.length; k++, i++) { const v = V[i], g = (v.full || v.geo).clone();
      g.setAttribute('iCol', new THREE.InstancedBufferAttribute(Float32Array.from(v.cls === 'car' || v.cls === 'sport' ? [.62, .66, .7] : [-1, 0, 0]), 3)); g.setAttribute('iVar', new THREE.InstancedBufferAttribute(new Float32Array([.5]), 1));
      const m = new THREE.InstancedMesh(g, HXFZ.material, 1); m.setMatrixAt(0, new THREE.Matrix4()); sc.add(m);
      const bb = (v.full || v.geo).boundingBox, s = Math.max(bb.max.z - bb.min.z, (bb.max.y - bb.min.y) * 1.6) * .48, cy = (bb.min.y + bb.max.y) / 2;
      cam.left = -s * W / H; cam.right = s * W / H; cam.top = s; cam.bottom = -s; cam.updateProjectionMatrix(); cam.position.set(s * 3.2, cy + s * 2.2, s * 3.2); cam.lookAt(0, cy, 0);
      r.render(sc, cam); FZ.pics[i] = r.domElement.toDataURL(); sc.remove(m); g.dispose(); }
    renderFz(); if (i < V.length) requestAnimationFrame(step); else { r.dispose(); r.forceContextLoss && r.forceContextLoss(); } };
  requestAnimationFrame(step); done(); }
function renderFz() {
  const V = HXFZ.build(), cur = DRV.car && DRV.car.fz !== undefined ? DRV.car.fz : -1, T = $('fzTrack'), list = [-1];
  V.forEach((v, i) => { if (FZ.cat === 'alle' || fzCat(v) === FZ.cat) list.push(i); });
  if (FZ.cat !== 'alle') list.shift(); // 'Standard' only under 'Alle'
  const key = FZ.cat + '|' + list.length; if (T.dataset.key !== key) { T.dataset.key = key; T.innerHTML = '';
    for (const vi of list) { const b = document.createElement('button'); b.type = 'button'; b.className = 'fzcard'; b.dataset.vi = vi;
      const v = vi >= 0 ? V[vi] : null; b.innerHTML = '<span class="fzpic"></span><b>' + (v ? (v.name || v.id) : 'Standard') + '</b><small>' + (v ? v.len.toFixed(1).replace('.', ',') + ' m' : 'Spielerauto') + '</small>';
      b.addEventListener('click', () => { store.set('hx.fzModel', v ? v.id : null); setDriveModel(vi); renderFz(); toast(v ? (v.name || v.id) : 'Standard', 900); });
      T.appendChild(b); } }
  for (const b of T.children) { const vi = +b.dataset.vi, pic = b.firstChild; b.setAttribute('aria-pressed', vi === cur ? 'true' : 'false');
    if (vi >= 0 && FZ.pics && FZ.pics[vi] && !pic.firstChild) { const im = new Image(); im.src = FZ.pics[vi]; im.alt = ''; pic.appendChild(im); } }
  for (const c of $('fzCats').children) c.setAttribute('aria-pressed', c.dataset.cat === FZ.cat ? 'true' : 'false'); }
function openModelSheet() {
  if (!window.HXFZ) return;
  if (!$('fzCats').childElementCount) for (const [id, name] of FZ_CATS) { const c = document.createElement('button'); c.type = 'button'; c.className = 'pl'; c.dataset.cat = id; c.textContent = name;
    c.addEventListener('click', () => { FZ.cat = id; renderFz(); $('fzTrack').scrollLeft = 0; }); $('fzCats').appendChild(c); }
  $('fzSheet').hidden = false; renderFz(); fzPictures(() => {});
  const cur = $('fzTrack').querySelector('[aria-pressed="true"]'); if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' }); }
$('fzPrev').addEventListener('click', () => $('fzTrack').scrollBy({ left: -$('fzTrack').clientWidth * .8, behavior: 'smooth' }));
$('fzNext').addEventListener('click', () => $('fzTrack').scrollBy({ left: $('fzTrack').clientWidth * .8, behavior: 'smooth' }));
$('bModel').addEventListener('click', openModelSheet); $('fzClose').addEventListener('click', () => { $('fzSheet').hidden = true; });
function leaveCar() {
  if (!DRV.on) return;
  /* Runde 126: getting out while moving is allowed up to 30 km/h (before: only below 14 km/h, "Erst anhalten"); the figure jumps out,
     the empty car rolls on, brakes and stops by itself - in front of a house or water at once */
  const sp = Math.hypot(DV.vx, DV.vz); if (sp > 30 / 3.6) { toast('Zu schnell zum Aussteigen – unter 30 km/h geht es', 1400); return; }
  stopAuto();
  // park the car where it stands; the figure gets out on the left
  const pi = DRV.parked.length; DRV.parked.push(DV.x, DV.z, DV.h, DRV.car.type, DRV.car.colour, 0); setCarTile('drv', Float32Array.from(DRV.parked));
  if (sp > 1) coastCar(pi, DV.vx / sp, DV.vz / sp, sp);
  scene.remove(DRV.mesh); DRV.mesh.geometry.dispose(); DRV.mesh = null; dropCarLights();
  const lx = Math.cos(DV.h), lz = -Math.sin(DV.h); let ox = DV.x + lx * 1.8, oz = DV.z + lz * 1.8;
  if (blocked(ox, oz)) { ox = DV.x - lx * 1.8; oz = DV.z - lz * 1.8; }
  P.x = ox; P.z = oz; P.y = terrainH(ox, oz); P.yaw = DV.h; P.speed = 0; P.vy = 0;
  DRV.on = false; player.visible = true;
  $('bJump').textContent = 'Sprung'; $('bCar').setAttribute('aria-label', 'Einsteigen'); $('bCar').classList.remove('on');
  $('bRun').hidden = false; $('speedo').hidden = true; $('bModel').hidden = true; $('fzSheet').hidden = true;
  if (camera.fov !== 46) { camera.fov = 46; camera.updateProjectionMatrix(); }
  snd.stop();
}
function coastCar(i, dx, dz, v) { // Runde 126: the car left while moving rolls out (about 7 m/s² braking) and stays where it stops
  let t0 = performance.now(); const step = now => { const dt = Math.min(.05, (now - t0) / 1000); t0 = now;
    if (DRV.parked[i + 3] < 0) return; // taken again or replaced meanwhile
    v = Math.max(0, v - 7 * dt); const nx = DRV.parked[i] + dx * v * dt, nz = DRV.parked[i + 1] + dz * v * dt;
    if (blocked(nx + dx * 2.2, nz + dz * 2.2)) v = 0; else { DRV.parked[i] = nx; DRV.parked[i + 1] = nz; setCarTile('drv', Float32Array.from(DRV.parked)); }
    if (v > 0) requestAnimationFrame(step); };
  requestAnimationFrame(step); }
$('bCar').addEventListener('click', () => DRV.on ? leaveCar() : enterCar());
$('bJump').addEventListener('pointerdown', () => { DRV.hb = true; });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('bJump').addEventListener(ev, () => { DRV.hb = false; });
/* Runde 78: call a car - one appears on the nearest street right beside the figure (or next to it), ready to get in */
let CALLED = null;
function carNear(x, z, r) { for (const a of carTiles.values()) for (let i = 0; i < a.length; i += 6) if (a[i + 3] >= 0 && (a[i] - x) ** 2 + (a[i + 1] - z) ** 2 < r * r) return true; return false; }
function callCar() {
  if (DRV.on || !P.placed) return;
  let best = null, bd = 14;
  for (const t of tiles.values()) for (const r of t.roads || []) { if (r.k !== 'm' || r.a || r.w < 3) continue; const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) { const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, L2 = dx * dx + dz * dz; if (L2 < .01) continue;
      const u = Math.max(0, Math.min(1, ((P.x - ax) * dx + (P.z - az) * dz) / L2)), L = Math.sqrt(L2), nx = -dz / L, nz = dx / L;
      for (const sd of [1, -1]) { const off = Math.max(0, r.w / 2 - 1.3) * sd, x = ax + dx * u + nx * off, z = az + dz * u + nz * off, d = Math.hypot(x - P.x, z - P.z);
        if (d < bd && d > 1.8 && !buildingAt(x, z) && !carNear(x, z, 3)) { bd = d; best = [x, z, Math.atan2(dx, dz) + (sd > 0 ? 0 : Math.PI)]; } } } }
  if (!best) { const h = P.yaw + Math.PI / 2; for (const k of [1, -1, 2, -2]) { const x = P.x + Math.sin(h) * 2.6 * k, z = P.z + Math.cos(h) * 2.6 * k; if (!buildingAt(x, z) && !carNear(x, z, 3)) { best = [x, z, P.yaw]; break; } } }
  if (!best) { toast('Hier ist kein Platz für ein Auto', 1400); return; }
  if (CALLED !== null && DRV.parked[CALLED + 3] >= 0) DRV.parked[CALLED + 3] = -1; // the car called before goes (only one at a time)
  CALLED = DRV.parked.length; DRV.parked.push(best[0], best[1], best[2], 1 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 12), 0); setCarTile('drv', Float32Array.from(DRV.parked));
  // arrival: a quick white puff and a sound
  const puff = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .8, depthWrite: false }));
  puff.position.set(best[0], terrainH(best[0], best[1]) + .8, best[1]); scene.add(puff); POPS2.push({ m: puff, t: 0 });
  snd.chest && snd.chest(); if (navigator.vibrate) try { navigator.vibrate(15); } catch (e) { }
  if (bd > 4) { Object.assign(GOCAR, { n: { a: carTiles.get('drv'), i: CALLED, key: 'drv', x: best[0], z: best[1] }, t: 0, best: 1e9, still: 0 }); showCarMark(GOCAR.n); } // a few steps away: walk there and get in
  else toast('Dein Auto ist da', 1000);
}
const POPS2 = [];
setInterval(() => { for (let i = POPS2.length - 1; i >= 0; i--) { const p = POPS2[i]; p.t += .03; const k = p.t / .35; p.m.scale.setScalar(1 + k * 2.2); p.m.material.opacity = Math.max(0, .8 * (1 - k)); if (k >= 1) { scene.remove(p.m); p.m.geometry.dispose(); p.m.material.dispose(); POPS2.splice(i, 1); } } }, 30);
$('bCall').addEventListener('click', callCar);
addEventListener('keydown', e => { if (e.target.tagName === 'INPUT') return; const k = e.key.toLowerCase();
  if (k === 'c') { DRV.on ? leaveCar() : (DRV.near || DRV.jack) && enterCar(); }
  if (k === 'g' && DRV.on) openBig(true); });
// button visibility: next to a parked car, or always while driving
setInterval(() => {
  if (!started || DRV.on) { $('bCar').hidden = !DRV.on; $('bCall').hidden = true; return; }
  DRV.near = nearestParked(4.5); DRV.jack = DRV.near ? null : stoppedTraffic(3.2); // Runde 130: a traffic car standing in front of the figure can be taken
  $('bCar').hidden = !(DRV.near || DRV.jack); $('bCall').hidden = !!(DRV.near || DRV.jack); $('bCar').setAttribute('aria-label', DRV.jack ? 'Auto kapern' : 'Einsteigen'); $('bCar').classList.toggle('jack', !!DRV.jack);
}, 250);

/* ------------------------------------------------------------ handling */
const CAR = { acc: 11, top: 42, brake: 22, rev: 7, revTop: 9, drag: .18, roll: .8, grip: 8, slideGrip: 1.6, steer: 2.5 };
// autopilot (Runde 54: "much faster and more aggressive"): twice the engine, half the drag, ~250 km/h, harder brakes, more grip
const AUTO = { acc: 2.2, top: 72, drag: .5, brake: 1.5, grip: 1.45 };
function carBlocked(x, z, h) { // four corners of the body against the house footprints
  if (DRV.on && TUN.segs.length && underground(x, z, DV.y)) return false; // in a tunnel: only its walls count (the trough-wall check)
  const L = DRV.car.len / 2 - .2, W = .85, fx = Math.sin(h), fz = Math.cos(h), rx = -fz, rz = fx;
  for (const [u, v] of [[L, W], [L, -W], [-L, W], [-L, -W], [L, 0]]) { const px = x + fx * u + rx * v, pz = z + fz * u + rz * v; if (buildingAt(px, pz) || waterAt(px, pz)) return true; }
  return false;
}
// on a motorway? (checked a few times a second): faster top speed there, by hand and on autopilot (Runde 76: "on the motorway even faster")
function motorwayAt(x, z) { for (const t of tiles.values()) for (const r of t.roads || []) { if (!r.a) continue; const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) { const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, L2 = dx * dx + dz * dz || 1, u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      if ((ax + dx * u - x) ** 2 + (az + dz * u - z) ** 2 < (r.w / 2 + 2.5) ** 2) return true; } } return false; }
setInterval(() => { DRV.mw = DRV.on && motorwayAt(DV.x, DV.z); }, 300);
function driveStep(dt, ix, iy) {
  let thr = -iy, st = -ix; // positive yaw turns left in this world (x east, z south), so right on the stick = negative
  if (sid === null) { thr = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0); st = (keys.a || keys.arrowleft ? 1 : 0) - (keys.d || keys.arrowright ? 1 : 0); }
  let hb = DRV.hb || keys[' '];
  if (DRV.auto) { if (Math.abs(thr) > .25 || Math.abs(st) > .25) { stopAuto(); toast('Du fährst selbst', 1200); } else { const a = autoPilot(dt); thr = a[0]; st = a[1]; hb = a[2]; } }
  const fx = Math.sin(DV.h), fz = Math.cos(DV.h), rx = -fz, rz = fx; // forward, right
  let vF = DV.vx * fx + DV.vz * fz, vR = DV.vx * rx + DV.vz * rz;
  const sp = Math.abs(vF);
  if (!DV.air) {
    // engine and brakes
    let aF = 0; const WG = window.WX ? WX.grip : 1; // Runde 141: wet road, snow, ice - less grip, longer braking, the wheels spin
    if (thr > 0) aF = vF < -0.5 ? CAR.brake * thr : CAR.acc * thr * (DRV.auto ? AUTO.acc : 1) * (DRV.mw ? 1.35 : 1) * (1 - Math.max(0, vF) / ((DRV.auto ? AUTO.top : CAR.top) * (DRV.mw ? 1.6 : 1))) * (vF < 8 ? 1.25 : 1);
    else if (thr < 0) aF = vF > 0.5 ? -CAR.brake * (DRV.auto ? AUTO.brake : 1) * -thr : -CAR.rev * -thr * (1 - Math.min(1, -vF / CAR.revTop));
    if (hb) aF -= Math.sign(vF) * Math.min(sp / dt, 6);
    if (WG < 1) aF *= (aF * vF < 0 ? .08 + .92 * WG * WG : .25 + .75 * WG); // braking / engine on a slippery road
    vF += aF * dt;
    vF -= vF * CAR.drag * (DRV.auto ? AUTO.drag : 1) * (DRV.mw ? .6 : 1) * dt + Math.sign(vF) * Math.min(Math.abs(vF), CAR.roll * dt * (thr === 0 ? 2.5 : 1));
    // steering: sharp at low speed, calmer at high speed, stronger with the handbrake (pivot)
    DV.steer += (st - DV.steer) * Math.min(1, dt * 10);
    const sAbs = Math.abs(vF), turn = DV.steer * CAR.steer * Math.min(1, sAbs / 5) * (1 - .45 * Math.min(1, sAbs / CAR.top)) * (hb ? 1.5 : 1) * Math.sign(vF || 1);
    DV.yawRate += (turn - DV.yawRate) * Math.min(1, dt * 8 * (.3 + .7 * WG)); // slippery: the car answers the wheel late
    // tyres: lateral grip; the rear lets go with the handbrake or when steering hard at speed -> drift
    const drift = hb || (!DRV.auto && Math.abs(DV.steer) > .75 && sAbs > 18 && thr > .3); // the autopilot drifts only on purpose (handbrake pulse)
    const grip = (drift ? CAR.slideGrip : CAR.grip * (DRV.auto ? AUTO.grip : 1)) * WG;
    vR *= Math.exp(-grip * dt);
    DV.slip = Math.min(1, Math.abs(vR) / 6);
    // a little forward push out of a drift (the counter-steer feeling)
    if (drift && thr > 0) vF += Math.abs(vR) * .15 * dt * 10;
  } else DV.slip = 0;
  // velocity stays in the world while the body turns: the next frame sees a sideways component -> the car slides (drift)
  DV.vx = fx * vF + rx * vR; DV.vz = fz * vF + rz * vR;
  { const nh = DV.h + DV.yawRate * dt; // turning must not swing the corners into a wall
    if (!carBlocked(DV.x, DV.z, DV.h) && carBlocked(DV.x, DV.z, nh)) DV.yawRate *= -.2; else DV.h = nh; }
  // move, bounce off houses
  const nx = DV.x + DV.vx * dt, nz = DV.z + DV.vz * dt;
  if ((terrainH(nx, nz, DV.y) > DV.y + 1.2 || railAt(nx + Math.sin(DV.h) * 2, nz + Math.cos(DV.h) * 2, DV.y) || railAt(nx, nz, DV.y)) && !DV.air) { const hit = Math.hypot(DV.vx, DV.vz); DV.vx *= -.3; DV.vz *= -.3; DV.shake = Math.min(1, DV.shake + hit / 20); if (hit > 6) snd.bump(hit); } // trough wall
  else if (!carBlocked(DV.x, DV.z, DV.h) && carBlocked(nx, nz, DV.h)) { // already touching a wall (turned into it): let it move out
    const hit = Math.hypot(DV.vx, DV.vz);
    if (!carBlocked(nx, DV.z, DV.h)) { DV.x = nx; DV.vz *= -.25; DV.vx *= .7; }
    else if (!carBlocked(DV.x, nz, DV.h)) { DV.z = nz; DV.vx *= -.25; DV.vz *= .7; }
    else { DV.vx *= -.3; DV.vz *= -.3; }
    DV.shake = Math.min(1, DV.shake + hit / 20); if (hit > 6) snd.bump(hit);
  } else { DV.x = nx; DV.z = nz; }
  // rally reset: pressing gas or reverse for 2.5 s without getting anywhere puts the car back on the nearest street
  if (Math.abs(thr) > .5 && Math.hypot(DV.vx, DV.vz) < 1.5 && !DRV.auto) DV.push = (DV.push || 0) + dt; else DV.push = 0;
  if (DV.push > 2.5) { const f = freeStreetPoint(DV.x, DV.z, 250); if (f) { DV.x = f[0]; DV.z = f[1]; DV.y = DV.gPrev = terrainH(f[0], f[1]); DV.vx = DV.vz = DV.vy = 0; DV.yawRate = 0; DV.safe = null; toast('Zurück auf die Straße', 1400); } DV.push = 0; }
  // safety net (phone test: driven into a wall, then stuck): remember the last free pose, go back to it when stuck inside a house
  if (!carBlocked(DV.x, DV.z, DV.h)) { DV.safe = [DV.x, DV.z, DV.h]; DV.stuck = 0; }
  else if ((DV.stuck = (DV.stuck || 0) + dt) > .25 && DV.safe) { [DV.x, DV.z, DV.h] = DV.safe; DV.vx *= -.2; DV.vz *= -.2; DV.yawRate = 0; DV.stuck = 0; }
  // ground and air: driving fast over a crest lifts the car off
  /* Runde 86 (phone, OWD at 196 km/h: the car flew high over the road): the ground's height change per frame was taken as the car's
     vertical speed - a 1.6 m step in one frame meant 100 m/s upwards, and the next crest launched it. Now the car takes at most the
     vertical speed of a 12 % grade (a step is a jolt, not a catapult) and only leaves the ground when it falls away by more than 0.4 m */
  const g = terrainH(DV.x, DV.z, DV.y), gStep = g - DV.gPrev, gVel = Math.max(-.12 * sp - 1, Math.min(.12 * sp + 1, gStep / Math.max(dt, 1e-3))); DV.gPrev = g;
  if (!DV.air && Math.abs(gStep) > .45) { DV.shake = Math.min(1, DV.shake + Math.abs(gStep) / 4); DV.dip = Math.min(.12, Math.abs(gStep) * .05); }
  if (!DV.air) { DV.y = g; DV.vy = gVel; const ahead = terrainH(DV.x + DV.vx * dt * 2, DV.z + DV.vz * dt * 2, DV.y); if (ahead < DV.y + DV.vy * dt * 2 - .4 && sp > 14) DV.air = true; }
  if (DV.air) { DV.vy -= 22 * dt; DV.y += DV.vy * dt; if (DV.y <= g) { const land = -DV.vy; DV.y = g; DV.air = false; DV.dip = Math.min(.12, land * .015); DV.shake = Math.min(1, DV.shake + land / 25); if (land > 5) snd.bump(land); } }
  // body: lean in corners, dip under braking, squat under throttle (smoothed)
  const latAcc = vF * DV.yawRate, lonAcc = thr * (vF >= 0 ? 1 : -1);
  DV.lean += (Math.max(-.12, Math.min(.12, -latAcc * .006)) - DV.lean) * Math.min(1, dt * 6);
  DV.dip += (Math.max(-.06, Math.min(.06, -lonAcc * .04)) - DV.dip) * Math.min(1, dt * 5);
  DV.shake *= Math.exp(-dt * 6);
  // the world follows the car (tiles, occlusion, map)
  P.x = DV.x; P.z = DV.z; P.y = DV.y; P.yaw = DV.h; P.speed = vF; P.ground = !DV.air;
  DV.brk = !!(hb || (thr < -.05 && vF > .5) || (thr > .05 && vF < -.5)); // braking (or the handbrake)
  ramCheck(vF); placeCarMesh(); updateCarLights(dt, vF);
  const kmh = Math.round(Math.abs(vF) * 3.6); $('kmh').textContent = kmh;
  snd.update(Math.abs(vF), thr, DV.slip, DV.air);
  if (DV.slip > .45 && !DV.air && sp > 4) skid();
}

/* ------------------------------------------------------------ ramming (Runde 57)
   The driven car is the stronger one: a parked car it hits is knocked away (impulse from the impact, spinning, bouncing),
   gets a super-low-poly damage model (body dented on the side that was hit, roof squashed, paint darker), flies for ~3 s and
   disappears (geometry freed). Impact: short hit-stop, camera shake, debris and sparks, a crunch; the driven car loses some speed. */
const RAMG = { ver: -1, g: new Map() }, WRECKS = [], WRECK_MAX = 9;
let HITSTOP = 0;
function ramGrid() { if (RAMG.ver === carVer) return; RAMG.ver = carVer; RAMG.g.clear();
  for (const a of carTiles.values()) for (let i = 0; i < a.length; i += 6) { if (a[i + 3] < 0 || a[i + 3] >= 8) continue; const k = Math.floor(a[i] / 8) * 100003 + Math.floor(a[i + 1] / 8); let l = RAMG.g.get(k); if (!l) RAMG.g.set(k, l = []); l.push(a, i); } }
const DEB_N = 90; let debMesh = null; const DEB = [];
function debris(x, y, z, vx, vz, col, n, spark) {
  if (!debMesh) { debMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), DEB_N); debMesh.frustumCulled = false; debMesh.count = 0;
    debMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DEB_N * 3), 3); scene.add(debMesh); }
  for (let k = 0; k < n; k++) { if (DEB.length >= DEB_N) DEB.shift(); const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 6;
    DEB.push({ x, y: y + .6 + Math.random() * .6, z, vx: vx * .6 + Math.cos(a) * s, vy: 2 + Math.random() * 6, vz: vz * .6 + Math.sin(a) * s, r: Math.random() * 6, life: spark ? .35 + Math.random() * .3 : .9 + Math.random() * .6,
      size: spark ? .09 : .14 + Math.random() * .22, c: spark ? [1, .85 - Math.random() * .3, .3] : (Math.random() < .3 ? [.15, .17, .2] : Math.random() < .2 ? [.75, .85, .9] : col) }); } }
function crunch(v) { snd.bump(v * 1.6); snd.crash && snd.crash(v); }
function ramCheck(vF) {
  if (!DRV.on || !DRV.car || Math.abs(vF) < 2) return; ramGrid();
  const fx = Math.sin(DV.h), fz = Math.cos(DV.h), rx = Math.cos(DV.h), rz = -Math.sin(DV.h), L = DRV.car.len / 2, ix = Math.floor(DV.x / 8), iz = Math.floor(DV.z / 8);
  const probe = [[L, .85], [L, -.85], [L, 0], [0, .9], [0, -.9], [-L, .85], [-L, -.85]];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = RAMG.g.get((ix + a) * 100003 + iz + b); if (!l) continue;
    for (let q = 0; q < l.length; q += 2) { const arr = l[q], i = l[q + 1]; if (arr[i + 3] < 0) continue; const cx = arr[i], cz = arr[i + 1], h = arr[i + 2], sx = Math.sin(h), sz = Math.cos(h);
      if (Math.hypot(cx - DV.x, cz - DV.z) > L + 3) continue;
      let hit = false; for (const [u, v] of probe) { const px = DV.x + fx * u + rx * v - cx, pz = DV.z + fz * u + rz * v - cz; if (Math.abs(px * sx + pz * sz) < 2.15 && Math.abs(px * sz - pz * sx) < .95) { hit = true; break; } }
      if (hit) knock(arr, i, vF); } } }
function knock(arr, i, vF, src) { /* Runde 193: src = what hit it (a flying wreck, a blast); none = our car */
  const S = src || DV, type = arr[i + 3] | 0, colour = arr[i + 4] | 0, cx = arr[i], cz = arr[i + 1], h = arr[i + 2]; arr[i + 3] = -1; carDirty = true; carVer++;
  const sp = Math.abs(vF), dvx = S.vx, dvz = S.vz, dl = Math.hypot(dvx, dvz) || 1;
  let nx = cx - S.x, nz = cz - S.z; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
  // the knocked car: mostly along our motion, partly away from our centre; faster the harder the hit (we are heavier)
  const kx = (dvx / dl) * .75 + nx * .45, kz = (dvz / dl) * .75 + nz * .45, kl = Math.hypot(kx, kz) || 1, ks = (sp * 1.15 + 2) * BOOMCFG.fling;
  const geo = carMeshes[type].geometry.clone(), pos = geo.attributes.position, sev = Math.min(1, sp / 25);
  // damage: the side facing the impact pushed in, roof squashed, a little crumple everywhere (super low poly: just move the corners)
  const ix = -(kx / kl), iz = -(kz / kl), lx = ix * Math.cos(h) - iz * Math.sin(h), lz = ix * Math.sin(h) + iz * Math.cos(h); // impact direction in the car's frame
  for (let v = 0; v < pos.count; v++) { const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v), side = (x * lx + z * lz) / (Math.hypot(x, z) || 1);
    const dent = side > .3 ? (side - .3) * .55 * sev : 0; pos.setXYZ(v, x - lx * dent + (Math.random() - .5) * .08 * sev, y * (y > 1 ? 1 - .25 * sev : 1) + (Math.random() - .5) * .05 * sev, z - lz * dent + (Math.random() - .5) * .08 * sev); }
  pos.needsUpdate = true; geo.computeVertexNormals();
  geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(3), 3)); geo.setAttribute('iVar', new THREE.InstancedBufferAttribute(new Float32Array([.5]), 1));
  const c = CAR_COLOURS[colour] || CAR_COLOURS[0]; geo.attributes.iCol.setXYZ(0, c.r * .72, c.g * .72, c.b * .72);
  const m = new THREE.InstancedMesh(geo, carMat, 1); m.frustumCulled = false; scene.add(m);
  if (WRECKS.length >= WRECK_MAX) killWreck(WRECKS.shift());
  WRECKS.push({ m, x: cx, y: terrainH(cx, cz), z: cz, h, vx: kx / kl * ks, vz: kz / kl * ks, vy: (2.5 + sp * .22) * Math.sqrt(BOOMCFG.fling), wy: (Math.random() - .5) * sp * .35, rx: 0, rz: 0, wx: (Math.random() - .5) * sp * .12, wz: (Math.random() - .5) * sp * .18, t: 0, boom: Math.random() < BOOMCFG.share, burn: 0 });
  // impact on us: stronger car, but it costs speed; hit-stop, shake, debris, sparks, sound
  /* Runde 193 (phone: ramming made the drive stutter): no hit-stop any more and hardly any speed lost - we just plough on; a jolt and the shake stay */
  if (!src) { const r = BOOMCFG.recoil, f = 1 - .03 * r * r; DV.vx *= f; DV.vz *= f; DV.yawRate += (Math.random() - .5) * .25 * r * r; DV.shake = Math.min(1, DV.shake + (.25 + sp / 50) * r); } /* Runde 194: recoil 0-2 (1 = 3 % slower, 2 = 12 % and a twist) */
  const px = (cx + S.x) / 2, pz = (cz + S.z) / 2, py = terrainH(px, pz);
  debris(px, py, pz, kx / kl * ks, kz / kl * ks, [c.r, c.g, c.b], 10 + Math.min(14, sp | 0), false); debris(px, py, pz, dvx * .3, dvz * .3, null, 12, true);
  crunch(sp);
}
function killWreck(w) { w.dead = 1; scene.remove(w.m); w.m.geometry.dispose(); }
/* Runde 193: wrecks that explode. Each knocked car rolls once (share in the settings, default 10 %) whether it explodes when it hits
   something else - a house, another car, another wreck or the ground after a high flight. The explosion is made of sprites: camera-facing
   quads in two instanced draws (fire additive, smoke normal), from a pixel atlas of 6 puff shapes drawn at random at start-up, plus a
   glow and a ring. Every blast is different: power, palette (yellow-white, orange, red), number of puffs, 0-3 delayed after-blasts
   at random offsets, smoke tone, sparks, dark chunks, a flat shock ring on the ground. The wreck chars, jumps, burns on for a few seconds
   and pushes nearby cars away (they roll their own chance - a chain is possible, rarely). */
/* Runde 194: the ramming can be tuned in Settings -> Fahren (saved as hx.ramm): share of exploding cars (0 = never), blast power,
   how far rammed cars fly, how much a hit shakes and slows our own car, and whether a blast throws the cars around it (chain). */
const RAMM_D = { share: .1, power: 1, fling: 1, recoil: 1, chain: true };
const BOOMCFG = Object.assign({}, RAMM_D); try { const o = JSON.parse(localStorage.getItem('hx.ramm') || 'null'); if (o) Object.assign(BOOMCFG, o); else { const v = localStorage.getItem('hx.boom'); if (v !== null && !isNaN(+v)) BOOMCFG.share = +v; } } catch (e) { }
window.HXBOOM = BOOMCFG;
{ const box = document.querySelector('details.grp[data-g="fahren"] .grpb'); if (box) { const save = () => { try { localStorage.setItem('hx.ramm', JSON.stringify({ share: BOOMCFG.share, power: BOOMCFG.power, fling: BOOMCFG.fling, recoil: BOOMCFG.recoil, chain: BOOMCFG.chain })); } catch (e) { } }, inputs = [];
  box.innerHTML = '<p class="small">Rammen von geparkten Autos.</p>';
  const ROWS = [['share', 'Autos, die beim Aufprall explodieren', 0, 1, .05, v => v === 0 ? 'aus' : Math.round(v * 100) + ' %'],
    ['power', 'Stärke der Explosionen', .4, 2, .1, v => Math.round(v * 100) + ' %'],
    ['fling', 'Wie weit gerammte Autos fliegen', .4, 2.5, .1, v => Math.round(v * 100) + ' %'],
    ['recoil', 'Rückstoß aufs eigene Auto (Bremsen, Wackeln)', 0, 2, .1, v => v === 0 ? 'keiner' : Math.round(v * 100) + ' %']];
  for (const [k, name, a, b, st, fmt] of ROWS) { const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = '<span></span><span class="rv"><input type="range"> <span class="tv"></span></span>'; row.firstChild.textContent = name;
    const r = row.querySelector('input'), l = row.querySelector('.tv'); r.min = a; r.max = b; r.step = st; r.value = BOOMCFG[k]; r.setAttribute('aria-label', name);
    const show = () => { l.textContent = fmt(+r.value); }; show(); r.addEventListener('input', () => { BOOMCFG[k] = +r.value; show(); save(); }); inputs.push([k, r, show]); box.appendChild(row); }
  const tg = document.createElement('label'); tg.className = 'tog'; tg.innerHTML = '<input type="checkbox"> Kettenreaktion (Explosion schleudert Autos daneben weg)'; const cb = tg.querySelector('input'); cb.checked = !!BOOMCFG.chain;
  cb.addEventListener('change', () => { BOOMCFG.chain = cb.checked; save(); }); box.appendChild(tg);
  const rs = document.createElement('div'); rs.className = 'row'; rs.innerHTML = '<button class="pl" type="button">Standard</button>';
  rs.querySelector('button').addEventListener('click', () => { Object.assign(BOOMCFG, RAMM_D); for (const [k, r, show] of inputs) { r.value = BOOMCFG[k]; show(); } cb.checked = BOOMCFG.chain; save(); }); box.appendChild(rs); } }
const FX = { fire: null, smoke: null, ring: null, P: [], Q: [], R: [], todo: [] }, FX_F = 220, FX_S = 140;
function fxAtlas() { if (fxAtlas.t) return fxAtlas.t; const c = document.createElement('canvas'); c.width = 256; c.height = 32; const g = c.getContext('2d'), im = g.createImageData(256, 32);
  for (let k = 0; k < 8; k++) { const blobs = []; const nb = 4 + Math.floor(Math.random() * 4);
    for (let b = 0; b < nb; b++) { const a = Math.random() * 6.283, r = Math.random() * 6; blobs.push([16 + Math.cos(a) * r, 16 + Math.sin(a) * r, 5 + Math.random() * 6]); }
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { let a = 0, sh = 0; const dx = x + .5 - 16, dy = y + .5 - 16, rr = Math.hypot(dx, dy);
      if (k < 6) { for (const [bx, by, br] of blobs) { const d = Math.hypot(x + .5 - bx, y + .5 - by) / br; if (d < 1) { a = Math.max(a, 1 - d * d); sh = Math.max(sh, (by - y) / br); } }
        a = a > .55 ? 1 : a > .3 ? .7 : a > .12 ? .38 : 0; sh = sh > .35 ? 1 : sh > -.2 ? .78 : .58; } // stepped alpha and two-tone shading: pixel puffs, lit from above
      else if (k === 6) { a = Math.max(0, 1 - rr / 15.5); a = a * a; sh = 1; } // soft glow (flash, embers)
      else { const d = Math.abs(rr - 13) / 2.5; a = d < 1 ? (d < .5 ? 1 : .5) : 0; sh = 1; } // ring
      const o = (y * 256 + k * 32 + x) * 4; im.data[o] = Math.round(sh * 255); im.data[o + 1] = im.data[o + 2] = 255; im.data[o + 3] = Math.round(a * 255); } }
  g.putImageData(im, 0, 0); const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return fxAtlas.t = t; }
function fxMesh(n, add) { const base = new THREE.PlaneGeometry(1, 1), geo = new THREE.InstancedBufferGeometry(); geo.index = base.index; geo.setAttribute('position', base.attributes.position); geo.setAttribute('uv', base.attributes.uv);
  geo.setAttribute('iP', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)); geo.setAttribute('iC', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)); geo.setAttribute('iR', new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2)); geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: fxAtlas() } }, transparent: true, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: 'attribute vec4 iP; attribute vec4 iC; attribute vec2 iR; varying vec2 vUv; varying vec4 vC; void main() { vec4 mv = modelViewMatrix * vec4(iP.xyz, 1.0); float c = cos(iR.x), s = sin(iR.x); vec2 q = position.xy * iP.w; mv.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y); gl_Position = projectionMatrix * mv; vUv = vec2((uv.x + iR.y) / 8.0, uv.y); vC = iC; }',
    fragmentShader: add ? 'uniform sampler2D map; varying vec2 vUv; varying vec4 vC; void main() { vec4 t = texture2D(map, vUv); float a = t.a * vC.a; if (a < .01) discard; gl_FragColor = vec4(vC.rgb * (.75 + .25 * t.r), a); }'
                        : 'uniform sampler2D map; varying vec2 vUv; varying vec4 vC; void main() { vec4 t = texture2D(map, vUv); float a = t.a * vC.a; if (a < .03) discard; gl_FragColor = vec4(vC.rgb * (.6 + .5 * t.r), a); }' });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = add ? 6 : 5; scene.add(m); return m; }
const FIREPAL = [[[1, 1, .85], [1, .78, .25], [.9, .3, .05]], [[1, .92, .6], [1, .5, .1], [.75, .15, .04]], [[1, .85, .7], [.95, .38, .12], [.55, .08, .05]], [[1, 1, .95], [1, .68, .3], [.8, .25, .1]]];
function fxPart(fire, o) { const L = fire ? FX.P : FX.Q, N = fire ? FX_F : FX_S; if (L.length >= N) L.shift(); L.push(o); }
// one blast: power .5-1.5 scales size and count
function blast(x, y, z, pw, pal, smokeC) {
  const nF = Math.round((14 + Math.random() * 14) * pw), nS = Math.round((7 + Math.random() * 8) * pw), up = .6 + Math.random() * .9;
  fxPart(true, { x, y: y + 1, z, vx: 0, vy: 0, vz: 0, s0: 3 * pw, s1: 7 * pw, L: .14 + Math.random() * .06, t: 0, rot: 0, wr: 0, tex: 6, pal: [[1, 1, 1], [1, .9, .6], [1, .7, .3]], g: 0, a0: .7 }); // flash
  for (let i = 0; i < nF; i++) { const a = Math.random() * 6.283, e = Math.random() * 1.2 - .1, s = (3 + Math.random() * 9) * pw;
    fxPart(true, { x: x + Math.cos(a) * .5, y: y + .6 + Math.random() * .8, z: z + Math.sin(a) * .5, vx: Math.cos(a) * Math.cos(e) * s, vy: Math.sin(e) * s * up + 2, vz: Math.sin(a) * Math.cos(e) * s,
      s0: (.8 + Math.random() * 1.2) * pw, s1: (2 + Math.random() * 2.5) * pw, L: .45 + Math.random() * .7, t: -Math.random() * .08, rot: Math.random() * 6.283, wr: (Math.random() - .5) * 4, tex: Math.floor(Math.random() * 6), pal, g: -3, drag: 3.2, a0: .42 + Math.random() * .2 }); }
  for (let i = 0; i < nS; i++) { const a = Math.random() * 6.283, s = (1 + Math.random() * 3) * pw, k = .7 + Math.random() * .5;
    fxPart(false, { x: x + Math.cos(a) * .8, y: y + 1 + Math.random(), z: z + Math.sin(a) * .8, vx: Math.cos(a) * s, vy: 2.5 + Math.random() * 3.5 * up, vz: Math.sin(a) * s,
      s0: (1.2 + Math.random()) * pw, s1: (4 + Math.random() * 4) * pw, L: 1.6 + Math.random() * 2.2, t: -.12 - Math.random() * .35, rot: Math.random() * 6.283, wr: (Math.random() - .5) * 1.2, tex: Math.floor(Math.random() * 6),
      c: [smokeC[0] * k, smokeC[1] * k, smokeC[2] * k], g: 1.2, drag: 1.6, a0: .55 + Math.random() * .3 }); }
  for (let i = 0; i < 8 * pw; i++) { const a = Math.random() * 6.283, s = 5 + Math.random() * 10; // embers: small glowing bits on arcs
    fxPart(true, { x, y: y + 1, z, vx: Math.cos(a) * s, vy: 4 + Math.random() * 9, vz: Math.sin(a) * s, s0: .25, s1: .12, L: .6 + Math.random() * .9, t: 0, rot: 0, wr: 0, tex: 6, pal: [[1, .95, .6], [1, .6, .2], [.8, .2, .05]], g: -18, drag: .4, a0: 1 }); }
  debris(x, y, z, 0, 0, null, Math.round(10 * pw), true); debris(x, y, z, 0, 0, [.08, .07, .07], Math.round(8 * pw), false);
}
function explode(x, y, z, pw) { pw *= BOOMCFG.power;
  if (!FX.fire) { FX.fire = fxMesh(FX_F, true); FX.smoke = fxMesh(FX_S, false); }
  const pal = FIREPAL[Math.floor(Math.random() * FIREPAL.length)], sm = Math.random() < .5 ? [.16, .15, .15] : Math.random() < .5 ? [.22, .19, .16] : [.11, .11, .12];
  blast(x, y, z, pw, pal, sm);
  const n = Math.random() < .25 ? 0 : 1 + Math.floor(Math.random() * 3); // after-blasts: tank, tyres, a second cloud
  for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, r = .8 + Math.random() * 2.2; FX.todo.push({ t: .08 + Math.random() * .5 + i * .12, x: x + Math.cos(a) * r, y: y + Math.random() * 1.2, z: z + Math.sin(a) * r, pw: pw * (.35 + Math.random() * .4), pal, sm }); }
  { const geo = new THREE.RingGeometry(.86, 1, 20, 1), m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: .55, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, terrainH(x, z) + .15, z); m.renderOrder = 6; scene.add(m); FX.R.push({ m, t: 0, L: .45 + Math.random() * .2, r: (7 + Math.random() * 5) * pw }); }
  const dP = Math.hypot(x - (DRV.on ? DV.x : P.x), z - (DRV.on ? DV.z : P.z));
  if (DRV.on && dP < 40) DV.shake = Math.min(1, DV.shake + (1 - dP / 40) * .8);
  snd.boom(pw, dP);
  // the blast pushes parked cars close by away (they roll their own chance to blow up too)
  if (!BOOMCFG.chain) return; const BR = 5.5 * Math.sqrt(BOOMCFG.power); ramGrid(); const ix = Math.floor(x / 8), iz = Math.floor(z / 8);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = RAMG.g.get((ix + a) * 100003 + iz + b); if (!l) continue;
    for (let q = 0; q < l.length; q += 2) { const arr = l[q], i = l[q + 1]; if (arr[i + 3] < 0) continue; const d = Math.hypot(arr[i] - x, arr[i + 1] - z); if (d > BR || d < .01) continue;
      knock(arr, i, 9 + (BR - d) * 2, { x, z, vx: (arr[i] - x) / d * 6, vz: (arr[i + 1] - z) / d * 6 }); } }
}
function wreckHit(w, s, why) { if (!w.boom || w.burn || s < 3.5) return; w.why = why; w.burn = 3.5 + Math.random() * 3; w.t = 0;
  const c = w.m.geometry.attributes.iCol; c.setXYZ(0, .1, .09, .085); c.needsUpdate = true; // charred
  w.vy = Math.max(w.vy, 0) + 5 + Math.random() * 5; w.wx += (Math.random() - .5) * 5; w.wz += (Math.random() - .5) * 6; w.wy += (Math.random() - .5) * 4;
  explode(w.x, w.y, w.z, .8 + Math.random() * .6); }
BOOMCFG.explode = (x, z, pw) => explode(x, terrainH(x, z), z, pw || 1); /* test hooks */
BOOMCFG.ram = (x, z, dx, dz, sp) => { ramGrid(); let best = null, bd = 1e9; for (const l of RAMG.g.values()) for (let q = 0; q < l.length; q += 2) { const arr = l[q], i = l[q + 1]; if (arr[i + 3] < 0) continue; const d = Math.hypot(arr[i] - x, arr[i + 1] - z); if (d < bd) { bd = d; best = [arr, i]; } }
  if (!best) return null; const [arr, i] = best, cx = arr[i], cz = arr[i + 1]; knock(arr, i, sp || 20, { x: cx - dx, z: cz - dz, vx: dx * (sp || 20), vz: dz * (sp || 20) }); const w = WRECKS[WRECKS.length - 1]; w.boom = true; BOOMCFG.last = w; return [cx, cz, WRECKS.length]; };
function updateFX(dt) {
  for (let i = FX.todo.length - 1; i >= 0; i--) { const b = FX.todo[i]; if ((b.t -= dt) > 0) continue; FX.todo.splice(i, 1); blast(b.x, b.y, b.z, b.pw, b.pal, b.sm); snd.boom(b.pw * .6, Math.hypot(b.x - (DRV.on ? DV.x : P.x), b.z - (DRV.on ? DV.z : P.z))); }
  for (let i = FX.R.length - 1; i >= 0; i--) { const r = FX.R[i]; r.t += dt; const u = r.t / r.L, k = 1 - Math.pow(1 - Math.min(1, u), 2); r.m.scale.set(.5 + k * r.r, .5 + k * r.r, 1); r.m.material.opacity = .55 * (1 - u);
    if (u >= 1) { scene.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); FX.R.splice(i, 1); } }
  if (!FX.fire) return;
  for (const [L, mesh, fire] of [[FX.P, FX.fire, true], [FX.Q, FX.smoke, false]]) { const g = mesh.geometry, aP = g.attributes.iP.array, aC = g.attributes.iC.array, aR = g.attributes.iR.array; let n = 0;
    for (let i = L.length - 1; i >= 0; i--) { const p = L[i]; p.t += dt; if (p.t < 0) continue; const u = p.t / p.L; if (u >= 1) { L.splice(i, 1); continue; }
      const f = Math.exp(-(p.drag || 0) * dt); p.vx *= f; p.vz *= f; p.vy = p.vy * f + (p.g || 0) * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rot += p.wr * dt;
      const gr = terrainH(p.x, p.z) + .1; if (p.y < gr) { p.y = gr; p.vy = Math.abs(p.vy) * .2; }
      let r, gg, bb, a; if (fire) { const P3 = p.pal, k = u < .35 ? u / .35 : (u - .35) / .65, A = u < .35 ? P3[0] : P3[1], B = u < .35 ? P3[1] : P3[2];
        r = A[0] + (B[0] - A[0]) * k; gg = A[1] + (B[1] - A[1]) * k; bb = A[2] + (B[2] - A[2]) * k; a = p.a0 * (u < .6 ? 1 : 1 - (u - .6) / .4); }
      else { r = p.c[0]; gg = p.c[1]; bb = p.c[2]; a = p.a0 * Math.min(1, u * 6) * (1 - u) * (1 - u); }
      const s = p.s0 + (p.s1 - p.s0) * (1 - Math.pow(1 - u, 2.2));
      aP[n * 4] = p.x; aP[n * 4 + 1] = p.y; aP[n * 4 + 2] = p.z; aP[n * 4 + 3] = s; aC[n * 4] = r; aC[n * 4 + 1] = gg; aC[n * 4 + 2] = bb; aC[n * 4 + 3] = a; aR[n * 2] = p.rot; aR[n * 2 + 1] = p.tex; n++; }
    g.instanceCount = n; g.attributes.iP.needsUpdate = g.attributes.iC.needsUpdate = g.attributes.iR.needsUpdate = true; mesh.visible = n > 0; }
}

function updateWrecks(dt) {
  updateFX(dt);
  if (!WRECKS.length && !DEB.length) { if (debMesh && debMesh.count) debMesh.count = 0; return; }
  const _w = new THREE.Euler(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
  for (const w of WRECKS.slice()) { if (w.dead) continue; w.t += dt; /* a copy: a blast may add (and drop) wrecks while we go */
    w.vy -= 22 * dt; w.x += w.vx * dt; w.y += w.vy * dt; w.z += w.vz * dt; w.h += w.wy * dt; w.rx += w.wx * dt; w.rz += w.wz * dt;
    const g = terrainH(w.x, w.z); if (w.y < g) { w.y = g; if (w.vy < -13) wreckHit(w, -w.vy, 'fall'); /* only a real fall counts, a normal landing does not */ if (w.vy < -2) { w.vy *= -.3; w.wx *= .6; w.wz *= .6; } else { w.vy = 0; w.rx *= .85; w.rz *= .85; } const f = Math.exp(-dt * 2.5); w.vx *= f; w.vz *= f; w.wy *= f; }
    if (buildingAt(w.x, w.z)) { wreckHit(w, Math.hypot(w.vx, w.vz), 'house'); w.vx *= -.3; w.vz *= -.3; w.x += w.vx * dt * 2; w.z += w.vz * dt * 2; }
    { const hs = Math.hypot(w.vx, w.vz); if (hs > 4 && w.t > .15) { ramGrid(); // Runde 193: a flying wreck hits a parked car (knocks it on) or another wreck
      const l = RAMG.g.get(Math.floor(w.x / 8) * 100003 + Math.floor(w.z / 8)); if (l) for (let q = 0; q < l.length; q += 2) { const arr = l[q], i = l[q + 1]; if (arr[i + 3] < 0) continue;
        if (Math.hypot(arr[i] - w.x, arr[i + 1] - w.z) < 2.3 && w.y < terrainH(arr[i], arr[i + 1]) + 1.6) { knock(arr, i, hs * .8, w); wreckHit(w, hs, 'car'); w.vx *= .45; w.vz *= .45; break; } }
      for (const o of WRECKS) if (o !== w && Math.hypot(o.x - w.x, o.z - w.z) < 2.2 && Math.abs(o.y - w.y) < 1.6 && Math.hypot(o.vx - w.vx, o.vz - w.vz) > 4) { wreckHit(w, hs, 'wreck'); wreckHit(o, hs, 'wreck'); } } }
    if (w.burn) { w.fl = (w.fl || 0) - dt; if (w.fl <= 0 && w.t < w.burn && FX.fire) { w.fl = .06 + Math.random() * .08; const k = 1 - w.t / w.burn; // it burns on: small flames and a smoke trail
      fxPart(true, { x: w.x + (Math.random() - .5) * 1.4, y: w.y + .5 + Math.random() * .6, z: w.z + (Math.random() - .5) * 1.4, vx: (Math.random() - .5), vy: 1.5 + Math.random() * 2, vz: (Math.random() - .5), s0: (.6 + Math.random() * .6) * (.4 + k * .6), s1: .2, L: .35 + Math.random() * .3, t: 0, rot: Math.random() * 6.283, wr: (Math.random() - .5) * 3, tex: Math.floor(Math.random() * 6), pal: FIREPAL[1], g: 1, drag: 1, a0: .9 });
      if (Math.random() < .6) fxPart(false, { x: w.x, y: w.y + 1.2, z: w.z, vx: (Math.random() - .5) * .8 + .6, vy: 2 + Math.random() * 1.5, vz: (Math.random() - .5) * .8 + .3, s0: .8, s1: 3 + Math.random() * 2, L: 1.8 + Math.random() * 1.2, t: 0, rot: Math.random() * 6.283, wr: (Math.random() - .5), tex: Math.floor(Math.random() * 6), c: [.13, .12, .12], g: .6, drag: .8, a0: .5 * (.4 + k * .6) }); } }
    const life = 3 + (w.burn || 0), sc = w.t > life ? Math.max(0, 1 - (w.t - life) / .4) : 1; // shrink away at the end (a burnt-out wreck later)
    _w.set(w.rx, w.h, w.rz, 'YXZ'); _q.setFromEuler(_w); _p.set(w.x, w.y, w.z); _s.set(sc, sc, sc); _m.compose(_p, _q, _s); w.m.setMatrixAt(0, _m); w.m.instanceMatrix.needsUpdate = true;
    if (sc <= 0) { killWreck(w); const k = WRECKS.indexOf(w); if (k >= 0) WRECKS.splice(k, 1); } }
  if (debMesh) { const _q2 = new THREE.Quaternion(); let n = 0;
    for (let k = DEB.length - 1; k >= 0; k--) { const d = DEB[k]; d.life -= dt; if (d.life <= 0) { DEB.splice(k, 1); continue; }
      d.vy -= 22 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt; const g = terrainH(d.x, d.z); if (d.y < g + d.size / 2) { d.y = g + d.size / 2; d.vy *= -.35; d.vx *= .7; d.vz *= .7; }
      _w.set(d.r * d.life * 3, d.r, d.r * .5); _q2.setFromEuler(_w); _p.set(d.x, d.y, d.z); const s = d.size * Math.min(1, d.life * 3); _s.set(s, s, s); _m.compose(_p, _q2, _s); debMesh.setMatrixAt(n, _m); debMesh.instanceColor.setXYZ(n, d.c[0], d.c[1], d.c[2]); n++; }
    debMesh.count = n; debMesh.instanceMatrix.needsUpdate = true; debMesh.instanceColor.needsUpdate = true; }
}
const _de = new THREE.Euler(), _dq = new THREE.Quaternion(), _dm = new THREE.Matrix4(), _dp = new THREE.Vector3(), _ds = new THREE.Vector3(1, 1, 1);
/* Runde 70: lights of the driven car - headlights and tail lights while driving, brake light, indicators.
   By day only a hint (you see it when you look for it), at night bright, with light cones on the road and a red glow behind.
   Placed on the light boxes of the car model itself (found by their colour), so they fit every car type. */
const CL = { g: null, parts: null, blink: 0, side: 0, hold: 0 };
function glowTex() { if (glowTex.t) return glowTex.t; const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.4, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return glowTex.t = new THREE.CanvasTexture(c); }
function beamTex() { if (beamTex.t) return beamTex.t; const c = document.createElement('canvas'); c.width = 32; c.height = 64; const g = c.getContext('2d'), im = g.createImageData(32, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) { const v = y / 63, u = Math.abs(x - 15.5) / 15.5, a = Math.max(0, 1 - u / (0.25 + 0.75 * v)) * Math.pow(1 - v, 1.3) * Math.min(1, v * 6);
    const o = (y * 32 + x) * 4; im.data[o] = 255; im.data[o + 1] = 245; im.data[o + 2] = 210; im.data[o + 3] = Math.round(a * 255); }
  g.putImageData(im, 0, 0); return beamTex.t = new THREE.CanvasTexture(c); }
function dropCarLights() { if (!CL.g) return; scene.remove(CL.g); CL.g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); CL.g = null; CL.parts = null; }
function makeCarLights() {
  dropCarLights(); if (!DRV.mesh) return;
  const ga = DRV.mesh.geometry.attributes, P = ga.position, C = ga.color, AK = ga.aK, box = {};
  for (let i = 0; i < P.count; i++) { const r = C.getX(i), g = C.getY(i), b = C.getZ(i); const k = AK ? (AK.getX(i) === 6 ? 'h' : AK.getX(i) === 7 ? 't' : null) : Math.abs(r - .98) < .01 && Math.abs(g - .95) < .01 ? 'h' : Math.abs(r - .8) < .01 && Math.abs(g - .1) < .01 && Math.abs(b - .1) < .01 ? 't' : null; if (!k) continue;
    const key = k + (P.getX(i) < 0 ? 'L' : 'R'); const bb = box[key] || (box[key] = new THREE.Box3()); bb.expandByPoint(new THREE.Vector3(P.getX(i), P.getY(i), P.getZ(i))); }
  const G = new THREE.Group(); G.matrixAutoUpdate = false; const parts = { head: [], tail: [], ind: { L: [], R: [] }, beams: [], halo: [] };
  const lamp = (bb, col, grow) => { const sz = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
    const m = new THREE.Mesh(new THREE.BoxGeometry(sz.x + grow, sz.y + grow, sz.z + .02), new THREE.MeshBasicMaterial({ color: col })); m.position.copy(c); G.add(m); return m; };
  for (const side of ['L', 'R']) {
    const h = box['h' + side], t = box['t' + side], sx = side === 'L' ? -1 : 1; // x < 0 is the car's right side (front = +z)
    if (h) { parts.head.push(lamp(h, 0xfff3c8, .02));
      const ib = h.clone(); ib.min.y = ib.max.y - .05; ib.max.y += .02; const w = ib.max.x - ib.min.x; ib.translate(new THREE.Vector3(0, 0, 0)); if (sx < 0) ib.max.x = ib.min.x + w * .4; else ib.min.x = ib.max.x - w * .4; // amber strip on the outer top of the headlight
      parts.ind[sx > 0 ? 'L' : 'R'].push(lamp(ib, 0xffa020, .02)); }
    if (t) { parts.tail.push(lamp(t, 0xff2a1e, .02));
      const ib = t.clone(); ib.max.y = ib.min.y + .05; ib.min.y -= .02; const w = ib.max.x - ib.min.x; if (sx < 0) ib.max.x = ib.min.x + w * .45; else ib.min.x = ib.max.x - w * .45;
      parts.ind[sx > 0 ? 'L' : 'R'].push(lamp(ib, 0xffa020, .02)); }
  }
  // night: light cones on the road in front, a red glow behind
  const front = Math.max(...['hL', 'hR'].filter(k => box[k]).map(k => box[k].max.z), 2), back = Math.min(...['tL', 'tR'].filter(k => box[k]).map(k => box[k].min.z), -2);
  for (const sx of [-.55, .55]) { const b = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 13), new THREE.MeshBasicMaterial({ map: beamTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    b.rotation.x = -Math.PI / 2; b.position.set(sx, .12, front + 6.3); G.add(b); parts.beams.push(b); }
  // a glow point on every head and tail lamp (sprites: seen from behind and from above alike)
  for (const [list, col, sz, dz] of [[parts.head, 0xfff0c8, 1.3, .12], [parts.tail, 0xff2414, 1.0, -.12]]) for (const m of list) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    sp.position.copy(m.position); sp.position.z += dz; sp.scale.set(sz, sz, 1); sp.userData.tail = dz < 0; sp.userData.sz = sz; G.add(sp); parts.halo.push(sp); }
  CL.g = G; CL.parts = parts; scene.add(G);
}
// which way the car is about to turn: from the stick, or from the autopilot's route ahead
function indicatorSide(dt, vF) {
  let want = 0;
  if (DRV.auto && DRV.route) { const Rt = DRV.route, n = Rt.length / 2; let d = 0, j = DRV.auto.idx || 0;
    for (; j < n - 1 && d < 35; j++) d += Math.hypot(Rt[j * 2 + 2] - Rt[j * 2], Rt[j * 2 + 3] - Rt[j * 2 + 1]);
    if (j < n - 1) { const a = Math.atan2(Rt[j * 2 + 2] - Rt[j * 2], Rt[j * 2 + 3] - Rt[j * 2 + 1]); let df = a - DV.h; df = ((df + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; if (Math.abs(df) > .6 && Math.abs(df) < 2.6) want = Math.sign(df); } }
  else if (Math.abs(DV.steer) > .35 && Math.abs(vF) < 15 && Math.abs(vF) > .5) want = Math.sign(DV.steer);
  if (want) { CL.side = want; CL.hold = .8; } else if ((CL.hold -= dt) <= 0) CL.side = 0;
  return CL.side; }
function updateCarLights(dt, vF) {
  if (!DRV.mesh) return; if (!CL.g) makeCarLights(); if (!CL.parts) return;
  CL.g.matrix.copy(_dm); CL.g.matrixWorldNeedsUpdate = true;
  const night = Math.max(0, Math.min(1, (cur.lamp || 0) / 1.5)), moving = Math.abs(vF) > .3 || DRV.auto, side = indicatorSide(dt, vF);
  CL.blink = (CL.blink + dt) % .8; const on = CL.blink < .45;
  const lv = (base, k) => base + (1 - base) * k;
  // headlights: model colour by day (a hint lighter), bright at night
  for (const m of CL.parts.head) m.material.color.setRGB(1, .96, .8).multiplyScalar(lv(.86, night));
  // tail lights: dark red when off, a little brighter while driving, bright when braking
  for (const m of CL.parts.tail) { const k = DV.brk ? 1 : moving ? lv(.62, night * .75) : .5; m.material.color.setRGB(k, .1 * k + (DV.brk ? .06 : 0), .08 * k); }
  for (const s of ['L', 'R']) for (const m of CL.parts.ind[s]) { const lit = on && ((s === 'L' && side > 0) || (s === 'R' && side < 0)); m.visible = lit; m.material.color.setRGB(1, .62, .12); }
  for (const b of CL.parts.beams) b.material.opacity = night * .9 * (moving ? 1 : .7);
  for (const h of CL.parts.halo) { if (h.userData.tail) { h.material.opacity = night * (DV.brk ? 1 : moving ? .55 : .3) + (DV.brk ? .25 : 0); const k = h.userData.sz * (DV.brk ? 1.35 : 1); h.scale.set(k, k, 1); }
    else h.material.opacity = night * .85; }
}
function placeCarMesh() {
  if (!DRV.mesh) return;
  const fx = Math.sin(DV.h), fz = Math.cos(DV.h), rx = Math.cos(DV.h), rz = -Math.sin(DV.h), L = DRV.car.len * .42;
  let pitch = 0, roll = 0;
  if (!DV.air) { const hF = terrainH(DV.x + fx * L, DV.z + fz * L, DV.y), hB = terrainH(DV.x - fx * L, DV.z - fz * L, DV.y), hR = terrainH(DV.x + rx * .85, DV.z + rz * .85, DV.y), hL = terrainH(DV.x - rx * .85, DV.z - rz * .85, DV.y);
    pitch = -Math.atan2(hF - hB, 2 * L); roll = Math.atan2(hR - hL, 1.7); }
  else pitch = Math.max(-.35, Math.min(.35, -DV.vy * .03));
  _de.set(pitch + DV.dip, DV.h, roll + DV.lean, 'YXZ'); _dq.setFromEuler(_de); _dp.set(DV.x, DV.y, DV.z); _dm.compose(_dp, _dq, _ds);
  DRV.mesh.setMatrixAt(0, _dm); DRV.mesh.instanceMatrix.needsUpdate = true;
  const ud = DRV.mesh.userData; if (ud.pm) HXFZ.artic(ud.v, ud.st, _dm, terrainH, (k, M) => { ud.pm[k].setMatrixAt(0, M); ud.pm[k].instanceMatrix.needsUpdate = true; });
}
// chase camera: behind the direction of travel (shows the drift angle), lower and wider with speed, shakes on impacts
function driveCam(dt) {
  const sp = Math.hypot(DV.vx, DV.vz), velYaw = sp > 3 ? Math.atan2(DV.vx, DV.vz) : DV.h;
  const back = Math.cos(velYaw - DV.h) < -.2 ? DV.h : velYaw; // reversing: keep looking forward
  const want = lerpA(DV.h, back, .55);
  DV.camYaw = lerpA(DV.camYaw, want, Math.min(1, dt * (3 + sp * .08)));
  const big = Math.max(0, ((DRV.car && DRV.car.len) || 4.5) - 4.5); // Runde 96: longer vehicles (lorries, buses, trains) - camera farther back and higher
  const fx = Math.sin(DV.camYaw), fz = Math.cos(DV.camYaw), hgt = 2.4 + sp * .015 + big * .22;
  // never behind a wall: shorten the arm like the walking camera
  const armW = 7.2 + sp * .06 + big * .75, free = freeDistance(DV.x, DV.y + 1.4, DV.z, -fx * .95, .3, -fz * .95, armW);
  DV.arm = free < (DV.arm || armW) ? free : (DV.arm || armW) + (free - (DV.arm || armW)) * Math.min(1, dt * 2); const dist = Math.max(3 + big * .5, DV.arm);
  const sh = DV.shake * .35, jx = (Math.random() - .5) * sh, jy = (Math.random() - .5) * sh;
  let cy = DV.y + hgt + jy; const gh = terrainH(DV.x - fx * dist, DV.z - fz * dist, DV.y + 1) + .8; if (cy < gh) cy = gh; if (TUN.segs.length && underground(DV.x, DV.z, DV.y)) cy = Math.min(cy, (tunnelFloor(DV.x, DV.z) || DV.y) + TUN_H - .6); // in the tube: under its ceiling
  camera.position.set(DV.x - fx * dist + jx, cy, DV.z - fz * dist);
  camera.lookAt(DV.x + fx * 6, DV.y + 1.1, DV.z + fz * 6);
  const fov = 55 + Math.min(22, sp * .55);
  if (Math.abs(camera.fov - fov) > .2) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
  return DV.camYaw;
}

/* ------------------------------------------------------------ skid marks */
const SKID_N = 400; let skidI = 0, skidMesh = null, skidT = 0;
function skid() {
  if (!skidMesh) {
    const g = new THREE.PlaneGeometry(.28, .5); g.rotateX(-Math.PI / 2);
    skidMesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0x222226, transparent: true, opacity: .55, depthWrite: false }), SKID_N);
    skidMesh.frustumCulled = false; skidMesh.count = 0; scene.add(skidMesh);
  }
  const now = performance.now(); if (now - skidT < 30) return; skidT = now;
  const fx = Math.sin(DV.h), fz = Math.cos(DV.h), rx = Math.cos(DV.h), rz = -Math.sin(DV.h), L = DRV.car.len * .32;
  for (const s of [-1, 1]) {
    const x = DV.x - fx * L + rx * .75 * s, z = DV.z - fz * L + rz * .75 * s;
    _de.set(0, DV.h, 0); _dq.setFromEuler(_de); _dp.set(x, terrainH(x, z) + .05, z); _dm.compose(_dp, _dq, _ds);
    skidMesh.setMatrixAt(skidI, _dm); skidI = (skidI + 1) % SKID_N; skidMesh.count = Math.max(skidMesh.count, skidI);
  }
  skidMesh.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------ sound (WebAudio, generated) */
const snd = (() => {
  let ac = null, eng = null, eng2 = null, eg = null, lp = null, nz = null, ng = null, bp = null;
  return {
    start() {
      try {
        ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume();
        eng = ac.createOscillator(); eng.type = 'sawtooth'; eng2 = ac.createOscillator(); eng2.type = 'sine'; /* deep sub tone instead of a buzzing square */
        lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300; lp.Q.value = .5; eg = ac.createGain(); eg.gain.value = 0;
        eng.connect(lp); eng2.connect(lp); lp.connect(eg); eg.connect((window.HXSND ? HXSND.node(ac, 'fahrzeug') : ac.destination)); eng.start(); eng2.start();
        const len = ac.sampleRate, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        nz = ac.createBufferSource(); nz.buffer = buf; nz.loop = true; bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 2;
        ng = ac.createGain(); ng.gain.value = 0; nz.connect(bp); bp.connect(ng); ng.connect((window.HXSND ? HXSND.node(ac, 'fahrzeug') : ac.destination)); nz.start();
      } catch (e) { ac = null; }
    },
    stop() { try { for (const n of [eng, eng2, nz]) if (n) n.stop(); } catch (e) { } eng = eng2 = nz = null; },
    update(sp, thr, slip, air) {
      if (!ac || !eng) return;
      // five gears: revs climb inside a gear and drop at each shift; a calm road car (800-3200 rpm), dark and quiet, not a rally screamer
      const gears = [0, 9, 17, 25, 33, 60]; let gI = 1; while (gI < 5 && sp > gears[gI]) gI++;
      const r = Math.min(1, (sp - gears[gI - 1]) / (gears[gI] - gears[gI - 1])), rpm = 800 + r * 2200 + (air ? 500 : 0) + Math.max(0, thr) * 200;
      const t = ac.currentTime;
      eng.frequency.setTargetAtTime(rpm / 30, t, .08); eng2.frequency.setTargetAtTime(rpm / 60, t, .08);
      lp.frequency.setTargetAtTime(180 + Math.max(0, thr) * 380 + r * 160, t, .1);
      eg.gain.setTargetAtTime(.03 + Math.max(0, thr) * .025, t, .15);
      ng.gain.setTargetAtTime(slip > .4 && !air ? Math.min(.05, (slip - .4) * .12) : 0, t, .08);
    },
    crash(v) { // crunch: a burst of filtered noise with a falling low thump
      if (!ac) return; const t = ac.currentTime, len = Math.floor(ac.sampleRate * .45), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = buf; f.type = 'lowpass'; f.frequency.setValueAtTime(2600, t); f.frequency.exponentialRampToValueAtTime(400, t + .4);
      g.gain.setValueAtTime(Math.min(.5, .15 + v * .012), t); s.connect(f); f.connect(g); g.connect((window.HXSND ? HXSND.node(ac, 'aufprall') : ac.destination)); s.start(t); },
    chest() { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); } catch (e) { return; }
      const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain(); o.type = 'square'; o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(520, t + .09);
      g.gain.setValueAtTime(.08, t); g.gain.exponentialRampToValueAtTime(.001, t + .14); o.connect(g); g.connect((window.HXSND ? HXSND.node(ac, 'effekte') : ac.destination)); o.start(t); o.stop(t + .15); },
    coin(i) { if (!ac) return; const t = ac.currentTime, f = 1320 * Math.pow(1.06, (i || 0) % 6);
      for (const [d, ff] of [[0, f], [.055, f * 1.335]]) { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'square'; o.frequency.setValueAtTime(ff, t + d);
        g.gain.setValueAtTime(.0001, t + d); g.gain.linearRampToValueAtTime(.05, t + d + .005); g.gain.exponentialRampToValueAtTime(.001, t + d + .09); o.connect(g); g.connect((window.HXSND ? HXSND.node(ac, 'effekte') : ac.destination)); o.start(t + d); o.stop(t + d + .1); } },
    boom(pw, d) { /* Runde 193: explosion - a deep thump, a dark roar that closes down, then crackle as bits come down; quieter and duller with distance */
      if (!ac || d > 160) return; const t = ac.currentTime, near = Math.max(0, 1 - d / 160), vol = Math.min(.9, (.25 + pw * .35) * near * near), sr = ac.sampleRate, len = Math.floor(sr * (1.4 + pw)), buf = ac.createBuffer(1, len, sr), dd = buf.getChannelData(0);
      let b = 0; for (let i = 0; i < len; i++) { const u = i / len; b = b * .7 + (Math.random() * 2 - 1) * .3; dd[i] = (b * 1.6 + (Math.random() < .002 * (1 - u) && u > .15 ? (Math.random() - .5) * 3 : 0)) * Math.pow(1 - u, 1.6) * Math.min(1, i / (sr * .004)); }
      const out = (window.HXSND ? HXSND.node(ac, 'explosion') : ac.destination), s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = buf; f.type = 'lowpass';
      f.frequency.setValueAtTime(900 + 1400 * near, t); f.frequency.exponentialRampToValueAtTime(140, t + 1.2); g.gain.setValueAtTime(vol, t); s.connect(f); f.connect(g); g.connect(out); s.start(t);
      const o = ac.createOscillator(), og = ac.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(75 + Math.random() * 20, t); o.frequency.exponentialRampToValueAtTime(26, t + .7);
      og.gain.setValueAtTime(vol * 1.1, t); og.gain.exponentialRampToValueAtTime(.001, t + .8); o.connect(og); og.connect(out); o.start(t); o.stop(t + .82); },
    bump(v) {
      if (!ac) return; const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(35, t + .25);
      g.gain.setValueAtTime(Math.min(.35, v * .02), t); g.gain.exponentialRampToValueAtTime(.001, t + .3); o.connect(g); g.connect((window.HXSND ? HXSND.node(ac, 'aufprall') : ac.destination)); o.start(t); o.stop(t + .32);
    }
  };
})();

/* ------------------------------------------------------------ route over the loaded streets */
const ONEW = new Set(); // edges of one-way roads (either direction key)
function buildGraph() {
  ONEW.clear(); const tunNodes = new Set(), tunEnds = [], xs = [], zs = [], adj = [], cell = new Map(), key = (x, z) => Math.floor(x / 4) * 100003 + Math.floor(z / 4);
  const nodeAt = (x, z) => { // corners of neighbouring tiles and crossing roads closer than 2.5 m become one node
    const cx = Math.floor(x / 4), cz = Math.floor(z / 4);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = cell.get((cx + a) * 100003 + cz + b); if (l) for (const n of l) if ((xs[n] - x) ** 2 + (zs[n] - z) ** 2 < 6.25) return n; }
    const n = xs.length; xs.push(x); zs.push(z); adj.push([]); const k = key(x, z); let l = cell.get(k); if (!l) cell.set(k, l = []); l.push(n); return n;
  };
  for (const t of tiles.values()) for (const r of t.roads || []) {
    if (r.k !== 'm' && !(r.k === 't' && !r.rail)) continue; const p = r.p; let prev = -1; const tunF = r.k === 't' ? 2000 : 0; if (tunF) tunEnds.push([p[0], p[1]], [p[p.length - 2], p[p.length - 1]]); // tunnels: driven through, no junctions with streets above (Runde 80)
    for (let i = 0; i < p.length; i += 2) {
      const n = nodeAt(p[i], p[i + 1]); if (tunF) tunNodes.add(n);
      if (prev >= 0 && prev !== n) { const d = Math.hypot(xs[n] - xs[prev], zs[n] - zs[prev]), w = r.w + (r.a ? 1000 : 0) + (r.b || tunF ? 2000 : 0); // w carries the flags (motorway, bridge/tunnel)
        if (r.o >= 0) adj[prev].push(n, d, w); if (r.o <= 0) adj[n].push(prev, d, w); // Runde 76: one-way (motorway carriageways) only along their direction
        if (r.o) { ONEW.add(prev * 1e7 + n); ONEW.add(n * 1e7 + prev); } }
      prev = n;
    }
  }
  // Runde 80: a tunnel end and the street before its portal often do not share a corner (4-8 m apart in the data): join them
  for (const [ex, ez] of tunEnds) { let a = -1, b = -1, ad = 1, bd = 100; const cx = Math.floor(ex / 4), cz = Math.floor(ez / 4);
    for (let u = -3; u <= 3; u++) for (let v = -3; v <= 3; v++) { const l = cell.get((cx + u) * 100003 + cz + v); if (l) for (const n of l) { const d = (xs[n] - ex) ** 2 + (zs[n] - ez) ** 2; if (d < ad) { ad = d; a = n; } } }
    if (a < 0) continue; for (let u = -3; u <= 3; u++) for (let v = -3; v <= 3; v++) { const l = cell.get((cx + u) * 100003 + cz + v); if (l) for (const n of l) { if (n === a || tunNodes.has(n)) continue; const d = (xs[n] - ex) ** 2 + (zs[n] - ez) ** 2; if (d < bd && !adj[a].some((m, k) => k % 3 === 0 && m === n)) { bd = d; b = n; } } }
    if (b >= 0) { const d = Math.sqrt(bd); adj[a].push(b, d, 2010); adj[b].push(a, d, 2010); } }
  // the map tiles often have no shared corner where streets meet (T-junctions end on the other line, crossings without a corner):
  // join every dead end to the nearest other street within 5 m, and every pair of segments that cross each other
  const segs = [], sg = new Map(), SC = 20;
  for (let a = 0; a < adj.length; a++) for (let k = 0; k < adj[a].length; k += 3) { const b = adj[a][k]; if (a < b || ONEW.has(a * 1e7 + b)) segs.push(a, b, adj[a][k + 2]); } // one-way: stored as a -> b
  for (let i = 0; i < segs.length; i += 3) { const a = segs[i], b = segs[i + 1];
    for (let cx = Math.floor((Math.min(xs[a], xs[b]) - 5) / SC); cx <= Math.floor((Math.max(xs[a], xs[b]) + 5) / SC); cx++)
      for (let cz = Math.floor((Math.min(zs[a], zs[b]) - 5) / SC); cz <= Math.floor((Math.max(zs[a], zs[b]) + 5) / SC); cz++) { const k = cx * 100003 + cz; let l = sg.get(k); if (!l) sg.set(k, l = []); l.push(i); } }
  const link = (a, b, w) => { if (a === b) return; const d = Math.hypot(xs[a] - xs[b], zs[a] - zs[b]); adj[a].push(b, d, w); adj[b].push(a, d, w); };
  const link1 = (a, b, w) => { if (a === b) return; const d = Math.hypot(xs[a] - xs[b], zs[a] - zs[b]); adj[a].push(b, d, w); };
  const split = (m, a, b, w) => { if (ONEW.has(a * 1e7 + b)) { link1(a, m, w); link1(m, b, w); ONEW.add(a * 1e7 + m); ONEW.add(m * 1e7 + a); ONEW.add(m * 1e7 + b); ONEW.add(b * 1e7 + m); } else { link(m, a, w); link(m, b, w); } }; // a one-way stays one-way where it is split
  const grade = w => w >= 1000; // motorway or bridge/tunnel: crosses others without a junction
  const addNode = (x, z) => { const n = xs.length; xs.push(x); zs.push(z); adj.push([]); return n; };
  const n0 = adj.length;
  for (let n = 0; n < n0; n++) {
    if (adj[n].length !== 3) continue; // dead end
    const l = sg.get(Math.floor(xs[n] / SC) * 100003 + Math.floor(zs[n] / SC)); if (!l) continue;
    let best = -1, bd = 25, bt = 0;
    for (const i of l) { const a = segs[i], b = segs[i + 1]; if (a === n || b === n || a === adj[n][0] || b === adj[n][0]) continue; if (segs[i + 2] >= 1000 && adj[n][2] < 1000) continue; // a dead end never joins a motorway sideways
      const dx = xs[b] - xs[a], dz = zs[b] - zs[a], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((xs[n] - xs[a]) * dx + (zs[n] - zs[a]) * dz) / L2));
      const d = (xs[a] + dx * t - xs[n]) ** 2 + (zs[a] + dz * t - zs[n]) ** 2; if (d < bd) { bd = d; best = i; bt = t; } }
    if (best >= 0) { const a = segs[best], b = segs[best + 1], m = addNode(xs[a] + (xs[b] - xs[a]) * bt, zs[a] + (zs[b] - zs[a]) * bt); split(m, a, b, segs[best + 2]); link(m, n, segs[best + 2]); }
  }
  const seenX = new Set();
  for (const l of sg.values()) for (let p = 0; p < l.length; p++) for (let q = p + 1; q < l.length; q++) {
    const i = l[p], j = l[q]; if (seenX.has(i * 1e7 + j)) continue; seenX.add(i * 1e7 + j); const a = segs[i], b = segs[i + 1], c = segs[j], d = segs[j + 1]; if (a === c || a === d || b === c || b === d) continue; if (grade(segs[i + 2]) || grade(segs[j + 2])) continue;
    const r1x = xs[b] - xs[a], r1z = zs[b] - zs[a], r2x = xs[d] - xs[c], r2z = zs[d] - zs[c], den = r1x * r2z - r1z * r2x; if (Math.abs(den) < 1e-6) continue;
    const t = ((xs[c] - xs[a]) * r2z - (zs[c] - zs[a]) * r2x) / den, u = ((xs[c] - xs[a]) * r1z - (zs[c] - zs[a]) * r1x) / den;
    if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) continue;
    const m = addNode(xs[a] + r1x * t, zs[a] + r1z * t); split(m, a, b, segs[i + 2]); split(m, c, d, segs[j + 2]);
  }
  return { xs, zs, adj };
}
// a point on the nearest street line becomes its own node (start: the endpoint behind the car costs a U-turn)
function attach(G, x, z, h, nth) { // hang a point onto the nearest street edge (nth: the nth-nearest edge instead)
  const cand = [];
  for (let a = 0; a < G.adj.length; a++) { const l = G.adj[a]; for (let k = 0; k < l.length; k += 3) { const b = l[k]; const one = ONEW.has(a * 1e7 + b); if (b < a && !one) continue; // two-way edges once, one-way edges in their direction (Runde 76)
    const dx = G.xs[b] - G.xs[a], dz = G.zs[b] - G.zs[a], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - G.xs[a]) * dx + (z - G.zs[a]) * dz) / L2));
    const d = (G.xs[a] + dx * t - x) ** 2 + (G.zs[a] + dz * t - z) ** 2; cand.push([d, a, b, t, l[k + 2], one]); } }
  cand.sort((p, q) => p[0] - q[0]); const c = cand[Math.min(nth || 0, cand.length - 1)];
  G.dist = c ? Math.sqrt(c[0]) : Infinity; if (!c) return 0;
  const [, a, b, t, w, one] = c, px = G.xs[a] + (G.xs[b] - G.xs[a]) * t, pz = G.zs[a] + (G.zs[b] - G.zs[a]) * t, n = G.xs.length;
  G.xs.push(px); G.zs.push(pz); G.adj.push([]);
  if (one) { // one-way (motorway carriageway): only on along it - no turning round on the spot
    G.adj[a].push(n, Math.hypot(G.xs[a] - px, G.zs[a] - pz), w); G.adj[n].push(b, Math.hypot(G.xs[b] - px, G.zs[b] - pz), w); ONEW.add(a * 1e7 + n); ONEW.add(n * 1e7 + b); return n; }
  for (const e of [a, b]) {
    let d = Math.hypot(G.xs[e] - px, G.zs[e] - pz);
    if (h !== null && d > .1 && ((G.xs[e] - px) * Math.sin(h) + (G.zs[e] - pz) * Math.cos(h)) < 0) d += 80; // turning round costs extra
    G.adj[n].push(e, d, w); G.adj[e].push(n, d, w);
  }
  return n;
}
function nearestNode(G, x, z) { let b = -1, bd = Infinity; for (let i = 0; i < G.xs.length; i++) { const d = (G.xs[i] - x) ** 2 + (G.zs[i] - z) ** 2; if (d < bd) { bd = d; b = i; } } return [b, Math.sqrt(bd)]; }
function aStar(G, s, t) {
  const N = G.xs.length, g = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N), heap = [];
  const push = (n, f) => { heap.push([f, n]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const hx = n => Math.hypot(G.xs[n] - G.xs[t], G.zs[n] - G.zs[t]);
  g[s] = 0; push(s, hx(s));
  while (heap.length) {
    const [, n] = pop(); if (done[n]) continue; done[n] = 1; if (n === t) break;
    const a = G.adj[n]; for (let k = 0; k < a.length; k += 3) { const m = a[k], ng = g[n] + a[k + 1] * ((a[k + 2] % 1000) < 4 ? 1.6 : a[k + 2] >= 1000 && a[k + 2] < 2000 ? .55 : 1); /* motorways are fast: preferred */ if (ng < g[m]) { g[m] = ng; from[m] = n; push(m, ng + hx(m)); } }
  }
  if (!done[t]) return null;
  const path = []; for (let n = t; n >= 0; n = from[n]) path.push(n); path.reverse(); return path;
}
/* Runde 140: saved routes carry the street line the worker planned (A.line, local x/z). Where the game's own street net cannot reach
   the next point (a gap at a bridge, the other carriageway) the car follows that line instead: from its nearest point to the goal,
   every 3 m, 1.8 m right of the centre */
function lineRoute(A) {
  const L = A.line; if (!L || L.length < 4) return false; let k0 = 0, bd = Infinity;
  for (let k = 0; k < L.length; k += 2) { const d = (L[k] - DV.x) ** 2 + (L[k + 1] - DV.z) ** 2; if (d < bd) { bd = d; k0 = k; } }
  if (bd > 80 * 80 || k0 >= L.length - 2) return false;
  const cx = [], cz = [];
  for (let k = k0; k + 2 < L.length; k += 2) { const ax = L[k], az = L[k + 1], bx = L[k + 2], bz = L[k + 3], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 3)); for (let q = 0; q < m; q++) { cx.push(ax + (bx - ax) * q / m); cz.push(az + (bz - az) * q / m); } }
  cx.push(L[L.length - 2]); cz.push(L[L.length - 1]);
  const pts = []; for (let k = 0; k < cx.length; k++) { const a = Math.max(0, k - 1), b = Math.min(cx.length - 1, k + 1); let dx = cx[b] - cx[a], dz = cz[b] - cz[a]; const l = Math.hypot(dx, dz) || 1; pts.push(cx[k] - dz / l * 1.8, cz[k] + dx / l * 1.8); }
  DRV.route = Float32Array.from(pts); DRV.routeFor = A; A.fb = false; A.idx = 0; A.partial = false; A.onLine = true; return true;
}
function makeRoute() {
  const A = DRV.auto; if (!A) return;
  const G = buildGraph(); if (!G.xs.length) { lineRoute(A); return; }
  const s = attach(G, DV.x, DV.z, DV.h); let t = attach(G, A.x, A.z, null), dt = G.dist;
  let nodes = aStar(G, s, t), fb = false;
  // the nearest street to the goal may be the carriageway of the other direction (not reachable within the loaded map): try the next ones
  for (let k = 1; !nodes && k < 6; k++) { t = attach(G, A.x, A.z, null, k); if (G.dist > dt + 60) break; nodes = aStar(G, s, t); }
  if (!nodes) { // still nothing (goal beyond the loaded map, its nearest street only reachable against a one-way): drive to the reachable
    // point closest to the goal - the route is rebuilt as new tiles arrive
    const seen = new Uint8Array(G.xs.length), st = [s]; seen[s] = 1; let bn = -1, bdd = Infinity;
    while (st.length) { const n = st.pop(), d = Math.hypot(G.xs[n] - A.x, G.zs[n] - A.z); if (d < bdd) { bdd = d; bn = n; } const a = G.adj[n]; for (let k = 0; k < a.length; k += 3) if (!seen[a[k]]) { seen[a[k]] = 1; st.push(a[k]); } }
    if (bn === s || bdd > Math.hypot(G.xs[s] - A.x, G.zs[s] - A.z) - 20) { // nothing reachable is closer (goal behind on a motorway): drive on to the next exit
      let far = -1, fd = 0; for (let n = 0; n < seen.length; n++) if (seen[n]) { const d = Math.hypot(G.xs[n] - G.xs[s], G.zs[n] - G.zs[s]); if (d > fd && d < 700) { fd = d; far = n; } } bn = far; }
    if (bn >= 0 && bn !== s) { nodes = aStar(G, s, bn); fb = true; } }
  if ((!nodes || fb) && lineRoute(A)) return; // saved route: follow its planned street line
  if (!nodes) { if (!DRV.route) toast('Keine Straße dorthin gefunden', 2000); return; }
  // dense centre line (every 3 m), then the lane: right of the middle (1.8 m) where it is free; where cars are parked along
  // the right kerb the car moves towards the middle, never into the parking strip; offsets smoothed so it glides, no zigzag
  const cx = [], cz = [];
  for (let k = 0; k + 1 < nodes.length; k++) { const ax = G.xs[nodes[k]], az = G.zs[nodes[k]], bx = G.xs[nodes[k + 1]], bz = G.zs[nodes[k + 1]], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / 3));
    for (let q = 0; q < m; q++) { cx.push(ax + (bx - ax) * q / m); cz.push(az + (bz - az) * q / m); } }
  if (nodes.length) { cx.push(G.xs[nodes[nodes.length - 1]]); cz.push(G.zs[nodes[nodes.length - 1]]); }
  const park = new Map(); // parked cars in 6 m cells
  for (const a of carTiles.values()) for (let i = 0; i < a.length; i += 6) { if (a[i + 3] < 0 || a[i + 3] >= 8) continue; const k = Math.floor(a[i] / 6) * 100003 + Math.floor(a[i + 1] / 6); let l = park.get(k); if (!l) park.set(k, l = []); l.push(a[i], a[i + 1]); }
  const parkedNear = (x, z) => { const ci = Math.floor(x / 6), cj = Math.floor(z / 6); for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) { const l = park.get((ci + u) * 100003 + cj + v); if (l) for (let i = 0; i < l.length; i += 2) if ((l[i] - x) ** 2 + (l[i + 1] - z) ** 2 < 6.3) return true; } return false; };
  const N = cx.length, off = new Float32Array(N), nx = new Float32Array(N), nz = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const a = Math.max(0, k - 1), b = Math.min(N - 1, k + 1); let dx = cx[b] - cx[a], dz = cz[b] - cz[a]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    nx[k] = -dz; nz[k] = dx; // right of the direction of travel
    off[k] = 0; for (const o of [1.8, 1.0, 0.3, -0.6]) { if (!parkedNear(cx[k] + nx[k] * o, cz[k] + nz[k] * o)) { off[k] = o; break; } }
  }
  const pts = [];
  for (let k = 0; k < N; k++) { let sum = 0, w = 0; for (let q = Math.max(0, k - 4); q <= Math.min(N - 1, k + 4); q++) { sum += Math.min(off[q], 1.8); w++; } // a parked car pulls the line in a few metres before and after
    let m = Infinity; for (let q = Math.max(0, k - 3); q <= Math.min(N - 1, k + 3); q++) m = Math.min(m, off[q]); const o = Math.min(sum / w, m + .4);
    pts.push(cx[k] + nx[k] * o, cz[k] + nz[k] * o); }
  if (dt < 60 && !fb) pts.push(A.x, A.z); // the address itself when its street is loaded (not after a detour-only route: no straight line to it)
  DRV.route = Float32Array.from(pts); DRV.routeFor = A; A.fb = fb; A.idx = 0; A.partial = dt > 150; // fb: only to the reachable point nearest the goal
}
function driveTo(x, z, label, next, line) { // next (Runde 139, saved routes): called at an intermediate goal instead of stopping there; line: the planned street line to it
  DRV.auto = { x, z, label: label || 'Ziel', idx: 0, t: 0, partial: false, next, line };
  makeRoute(); if (DRV.routeFor !== DRV.auto) DRV.route = null; // no way found yet: do not follow the old goal's route
  if (DRV.route && !next) toast('Fahre nach ' + DRV.auto.label + (DRV.auto.partial ? ' – Karte lädt unterwegs nach' : ''), 2600);
}
function stopAuto() { DRV.auto = null; DRV.route = null; if (window.HXORT && HXORT.stopped) HXORT.stopped(); }
function steer0(Rt, A, n) { const k = Math.min(n - 1, A.idx + 3), want = Math.atan2(Rt[k * 2] - DV.x, Rt[k * 2 + 1] - DV.z); const diff = ((want - DV.h + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return Math.max(-1, Math.min(1, diff * 3)); }
/* Runde 139: get into a car right here (saved routes start driving by themselves): call the own car and board it at once */
function boardHere() { if (DRV.on) return true; callCar(); if (CALLED === null) return false; stopGoCar(); enterCar({ a: carTiles.get('drv'), i: CALLED, key: 'drv' }); return DRV.on; }
function autoPilot(dt) {
  const A = DRV.auto, R = DRV.route; A.t += dt;
  if (A.t > 4 || (!R && A.t > 1)) { A.t = 0; makeRoute(); }
  if (DRV.routeFor !== A && A.next && (A.nr = (A.nr || 0) + dt) > 3) { const nx = A.next; A.next = null; nx(); return [0, 0]; } // Runde 140: a route point the game's street net cannot reach at all: on to the next one
  if (!DRV.route) return [0, 0];
  const Rt = DRV.route, n = Rt.length / 2;
  // stuck (wall, other car): after 1.5 s without moving, put the car back on the route a little further on, facing along it
  A.slow = Math.hypot(DV.vx, DV.vz) < 1.5 ? (A.slow || 0) + dt : 0;
  A.squeeze = Math.max(0, (A.squeeze || 0) - dt); if (A.slow > 1.2 && !A.squeeze) A.squeeze = 3; // standing in front of a parked car: squeeze past for 3 s instead of waiting forever
  // parked cars near the car (refreshed twice a second): obstacles on the line
  A.ct = (A.ct || 0) - dt; if (A.ct <= 0) { A.ct = .5; A.cars = []; for (const [, a] of carTiles) for (let i = 0; i < a.length; i += 6) if (a[i + 3] >= 0 && a[i + 3] < 8 && Math.abs(a[i] - DV.x) < 90 && Math.abs(a[i + 1] - DV.z) < 90) A.cars.push(a[i], a[i + 1]); }
  const carAt = (x, z, r) => { const C = A.cars || []; for (let i = 0; i < C.length; i += 2) if ((C[i] - x) ** 2 + (C[i + 1] - z) ** 2 < r * r) return true; return false; };
  if (A.slow > 1.5 && n > 3) { let k = Math.min(n - 2, A.idx + 2); while (k < n - 2 && carAt(Rt[k * 2], Rt[k * 2 + 1], 3.5)) k++;
    DV.x = Rt[k * 2]; DV.z = Rt[k * 2 + 1]; DV.h = DV.camYaw = Math.atan2(Rt[k * 2 + 2] - DV.x, Rt[k * 2 + 3] - DV.z); DV.vx = DV.vz = DV.vy = 0; DV.yawRate = 0; DV.safe = null; DV.y = DV.gPrev = terrainH(DV.x, DV.z); A.slow = 0; A.idx = k; }
  // progress along the line
  let best = A.idx, bd = Infinity; for (let k = A.idx; k < Math.min(n, A.idx + 40); k++) { const d = (Rt[k * 2] - DV.x) ** 2 + (Rt[k * 2 + 1] - DV.z) ** 2; if (d < bd) { bd = d; best = k; } } A.idx = best;
  const endD = Math.hypot(A.x - DV.x, A.z - DV.z), sp = Math.hypot(DV.vx, DV.vz);
  if (A.next && (endD < 35 || (!A.partial && DRV.routeFor === A && A.idx >= n - 3 && (!A.fb || endD < 150 || (A.fbT = (A.fbT || 0) + dt) > 2.5)))) { /* Runde 140: only the end of the route to THIS goal (not an old one kept while the new one could not be found yet) */ const nx = A.next; A.next = null; nx(); return [.6, steer0(Rt, A, n)]; } // a waypoint of a route: on to the next one without stopping
  if (endD < 12 || (!A.partial && A.idx >= n - 1 && endD < 40)) { if (sp < 1) { toast('Angekommen: ' + A.label, 2600); stopAuto(); } return [sp > .5 ? -1 : 0, 0]; }
  // look ahead further at speed (pure pursuit), sharp steering
  const look = 4 + sp * .32; let k = A.idx, acc = 0;
  while (k < n - 1 && acc < look) { acc += Math.hypot(Rt[k * 2 + 2] - Rt[k * 2], Rt[k * 2 + 3] - Rt[k * 2 + 1]); k++; }
  const tx = Rt[k * 2], tz = Rt[k * 2 + 1], HT = window.HXGORE ? HXGORE.huntTarget(Rt, A.idx, n) : null, want = HT ? Math.atan2(HT.x - DV.x, HT.z - DV.z) : Math.atan2(tx - DV.x, tz - DV.z); // Runde 152: Gore option - a pedestrian close to the route ahead becomes the target
  let diff = ((want - DV.h + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const steer = Math.max(-1, Math.min(1, diff * 3));
  // speed: every bend ahead allows v = sqrt(grip * radius); brake just in time for it (rally driver, not driving school)
  const WG = window.WX ? WX.grip : 1, ALAT = (A.cruise ? 8 : 21) * WG, BRAKE = (A.cruise ? 12 : 30) * (.25 + .75 * WG), TOP = (A.cruise ? (DRV.mw ? 33 : 22) : DRV.mw ? 97 : 72) * (.45 + .55 * WG); // Runde 141: weather // A.cruise (Runde 139, saved routes): sightseeing pace, at most ~80 km/h (120 on motorways), gentle in bends // late on the brakes, fast through bends (Runde 54); motorway ~350 km/h (Runde 76)
  let vt = TOP, dist = 0;
  for (let j = A.idx + 1; j < n - 2 && dist < 30 + sp * sp / (2 * BRAKE); j++) {
    const j0 = Math.max(0, j - 2), j1 = Math.min(n - 1, j + 2);
    const a1 = Math.atan2(Rt[j * 2] - Rt[j0 * 2], Rt[j * 2 + 1] - Rt[j0 * 2 + 1]), a2 = Math.atan2(Rt[j1 * 2] - Rt[j * 2], Rt[j1 * 2 + 1] - Rt[j * 2 + 1]);
    let d = Math.abs(a2 - a1); if (d > Math.PI) d = Math.PI * 2 - d;
    const span = Math.hypot(Rt[j1 * 2] - Rt[j0 * 2], Rt[j1 * 2 + 1] - Rt[j0 * 2 + 1]) || 1, radius = d > .02 ? span / d : 1e4;
    const vc = Math.max(12, Math.sqrt(ALAT * radius));
    vt = Math.min(vt, Math.sqrt(vc * vc + 2 * BRAKE * dist));
    dist += Math.hypot(Rt[j * 2 + 2] - Rt[j * 2], Rt[j * 2 + 3] - Rt[j * 2 + 1]);
  }
  if (Math.abs(diff) > .8) vt = Math.min(vt, 15);
  // look along the line: a parked car on it -> stop in front of it; parked cars close beside it (narrow street) -> at most ~50 km/h
  { let d = 0; for (let j = A.idx; j < n - 1 && d < 25 + sp * sp / (2 * BRAKE); j++) { const x = Rt[j * 2], z = Rt[j * 2 + 1];
      /* Runde 57: the autopilot may ram parked cars - no stopping, no slowing for them */
      d += Math.hypot(Rt[j * 2 + 2] - x, Rt[j * 2 + 3] - z); } }
  vt = Math.min(vt, Math.sqrt(2 * BRAKE * .6 * Math.max(0, endD - 8)) + 2); // stop at the address
  const lastD = Math.hypot(Rt[n * 2 - 2] - DV.x, Rt[n * 2 - 1] - DV.z); vt = Math.min(vt, Math.sqrt(2 * BRAKE * .6 * Math.max(0, lastD - 4)) + 3); // also before the end of the line (route may stop short of the goal, e.g. at a dead end)
  if (HT) vt = Math.max(12, Math.min(vt, 20)); // aimed at a pedestrian: fast enough to hit, not so fast it misses the turn
  let thr = vt > sp ? Math.min(1, (vt - sp) * .8 + .3) : Math.max(-1, (vt - sp) * .5);
  // now and then a drift: entering a real bend at speed, a short pull on the handbrake while staying on the gas; pure pursuit catches the slide
  // (only when the bend does not need hard braking anyway, and not above ~65 km/h: a phone test slid into a house at 85)
  if (A.dr > 0) { A.dr -= dt; return [Math.min(thr, .5), steer, true]; }
  A.cool = Math.max(0, (A.cool || 0) - dt);
  if (!A.cruise && !A.cool && Math.abs(diff) > .3 && Math.abs(diff) < 1.1 && sp > 12 && sp < 26 && vt > sp - 3 && endD > 60) { A.cool = 1.6; if (Math.random() < .75) { A.dr = .25 + Math.random() * .15; return [Math.min(thr, .5), steer, true]; } }
  return [thr, steer, false];
}

/* ================================================================ loot boxes + inventory (Runde 72)
   Small crates hang on house walls (about every fifth building, on an outside wall facing open ground). Tap one: the figure walks
   there (or loots at once when close), the crate pops open and pixel gold coins burst out and fly into the inventory, quick and snappy.
   Opened crates stay empty for 24 h (saved on the device). */
/* Runde 74: neon outlines for things worth finding (crates now, more objects later). A slightly larger copy drawn from the inside
   (back faces) in one neon colour; its thickness grows with distance so it stays ~2 render pixels wide; it pulses gently.
   On/off in the profile (stored on the device). Every outlined object registers its hull in OUTLINE.list. */
const OUTLINE = { on: store.get('hx.outline') !== false, list: [], mat: new THREE.MeshBasicMaterial({ color: 0xff2bd6, transparent: true, depthWrite: false, fog: false }) };
// drawn as a slightly larger copy just before the object itself (both after the scene, the object over it): only the rim stays -
// also for things on a wall, where back faces would sink into the masonry
function setOutline(on) { OUTLINE.on = on; store.set('hx.outline', on); for (const h of OUTLINE.list) h.visible = on; }
function pxWorld(x, y, z) { // metres per render pixel at this point
  if (cam.isOrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / (rt ? rt.height : innerHeight);
  return Math.hypot(x - cam.position.x, y - cam.position.y, z - cam.position.z) * 2 * Math.tan(cam.fov * Math.PI / 360) / (rt ? rt.height : innerHeight); }
const INV = Object.assign({ gold: 0 }, store.get('hx.inv') || {});
const LOOTED = store.get('hx.loot') || {}; { const now = Date.now(); for (const k in LOOTED) if (now - LOOTED[k] > 864e5) delete LOOTED[k]; }
const CRATES = { list: [], byId: new Map(), mesh: null, hull: null, t: 0, max: 90, W: 1.05, H: .82, Dp: .62 }; // 1.5 x the first size (Runde 74)
function pixCanvas(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g); return c; }
const COIN_CV = pixCanvas(10, 10, g => { // pixel gold coin
  const px = (x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };
  const rows = ['...oooo...', '..oGGGGo..', '.oGLLGGGo.', 'oGLGGGGDGo', 'oGLGGGGDGo', 'oGGGGGGDGo', 'oGGGGGDDGo', '.oGGDDDGo.', '..oGGGGo..', '...oooo...'];
  const C = { o: '#6b3d0c', G: '#f2b53a', L: '#fff2a8', D: '#c9861c' };
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (C[ch]) px(x, y, C[ch]); })); });
const COIN_URL = COIN_CV.toDataURL();
function crateTex() { const c = pixCanvas(16, 16, g => {
    g.fillStyle = '#9a5a26'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#b9733a'; for (const y of [2, 7, 12]) g.fillRect(1, y, 14, 3);                 // planks
    g.fillStyle = '#7a4318'; for (const y of [5, 10]) g.fillRect(1, y, 14, 1);
    g.fillStyle = '#3e220c'; g.fillRect(0, 0, 16, 1); g.fillRect(0, 15, 16, 1); g.fillRect(0, 0, 1, 16); g.fillRect(15, 0, 1, 16); // frame
    g.fillStyle = '#5a3212'; for (let i = 1; i < 15; i++) { g.fillRect(i, i, 1, 1); }                 // diagonal brace
    g.fillStyle = '#d9d2c0'; for (const [x, y] of [[1, 1], [14, 1], [1, 14], [14, 14]]) g.fillRect(x, y, 1, 1); // nails
    g.fillStyle = '#6b3d0c'; g.fillRect(6, 5, 4, 5); g.fillStyle = '#f2c046'; g.fillRect(7, 6, 2, 3); g.fillStyle = '#fff2a8'; g.fillRect(7, 6, 1, 1); // gold lock
  }); const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; return t; }
const LOOT_DAY = Math.floor(Date.now() / 864e5); // Runde 73: a new random set of crates every day (stable while playing)
function boxHash(x, z, salt) { let h = Math.imul(Math.round(x * 2) | 0, 73856093) ^ Math.imul(Math.round(z * 2) | 0, 19349663) ^ Math.imul((salt || 0) + LOOT_DAY, 83492791); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function scanBoxes() { // crates on the buildings around the player (deterministic: the same building always has its crate in the same place)
  const R = 150, seen = new Set(), out = [];
  for (let ix = Math.floor((P.x - R) / CELL); ix <= Math.floor((P.x + R) / CELL); ix++) for (let iz = Math.floor((P.z - R) / CELL); iz <= Math.floor((P.z + R) / CELL); iz++)
    for (const b of bgrid.get(gk(ix, iz)) || []) {
      if (seen.has(b)) continue; seen.add(b); const p = b.p, n = p.length / 2; if (n < 3 || b.h - b.base < 3) continue;
      const hb = boxHash(p[0], p[1], 1); if (hb > .2) continue;                                // about every fifth building - which ones changes daily
      const r1 = boxHash(p[2], p[3], 2), r2 = boxHash(p[0] + p[2], p[1] - p[3], 3), r3 = boxHash(p[1], p[0], 4);
      for (let tries = 0; tries < n; tries++) { const i = (Math.floor(r1 * n * 7) + tries) % n, j = (i + 1) % n;   // a random outside wall
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1], L = Math.hypot(bx - ax, bz - az); if (L < 4) continue;
        const f = .15 + .7 * r2; let nx = (bz - az) / L, nz = -(bx - ax) / L; const mx = ax + (bx - ax) * f, mz = az + (bz - az) * f; // anywhere along the wall, not in the middle
        if (inPoly(mx + nx * .5, mz + nz * .5, p)) { nx = -nx; nz = -nz; }
        if (buildingAt(mx + nx * 1.2, mz + nz * 1.2) || buildingAt(mx + nx * 3, mz + nz * 3)) continue; // party wall / courtyard gap: no
        const id = LOOT_DAY + ':' + Math.round(mx * 2) + ',' + Math.round(mz * 2); if (LOOTED[id]) break;
        const gy = terrainH(mx + nx * .8, mz + nz * .8);
        out.push({ id, x: mx + nx * (CRATES.Dp / 2 + .03), z: mz + nz * (CRATES.Dp / 2 + .03), y: gy + .85 + r3 * 1.6, yaw: Math.atan2(nx, nz), nx, nz, gold: 3 + Math.floor(boxHash(mz, mx, 5) * 7) }); break; } // 0.85-2.45 m high
    }
  out.sort((a, b) => Math.hypot(a.x - P.x, a.z - P.z) - Math.hypot(b.x - P.x, b.z - P.z)); CRATES.list = out.slice(0, CRATES.max);
  if (!CRATES.mesh) { const geo = new THREE.BoxGeometry(CRATES.W, CRATES.H, CRATES.Dp); CRATES.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ map: crateTex(), transparent: true }), CRATES.max); CRATES.mesh.renderOrder = 11; CRATES.mesh.frustumCulled = false; scene.add(CRATES.mesh);
    CRATES.hull = new THREE.InstancedMesh(geo, OUTLINE.mat, CRATES.max); CRATES.hull.renderOrder = 10; CRATES.hull.frustumCulled = false; CRATES.hull.visible = OUTLINE.on; scene.add(CRATES.hull); OUTLINE.list.push(CRATES.hull); }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1);
  CRATES.list.forEach((bx, k) => { e.set(0, bx.yaw, 0); q.setFromEuler(e); v.set(bx.x, bx.y, bx.z); m.compose(v, q, s1); CRATES.mesh.setMatrixAt(k, m); });
  CRATES.mesh.count = CRATES.list.length; CRATES.mesh.instanceMatrix.needsUpdate = true; }
function updateHulls() { // outline: thicker far away (constant on screen), pulsing
  const H = CRATES.hull; if (!H || !H.visible) return; const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  const pulse = 1 + .35 * Math.sin(time * 5);
  CRATES.list.forEach((b, k) => { const t = Math.max(.05, pxWorld(b.x, b.y, b.z) * 2.2) * pulse; e.set(0, b.yaw, 0); q.setFromEuler(e); v.set(b.x, b.y, b.z);
    sc.set(1 + 2 * t / CRATES.W, 1 + 2 * t / CRATES.H, 1 + 2 * t / CRATES.Dp); m.compose(v, q, sc); H.setMatrixAt(k, m); });
  H.count = CRATES.list.length; H.instanceMatrix.needsUpdate = true;
  OUTLINE.mat.color.setHSL(.86 + .04 * Math.sin(time * 2.5), 1, .55 + .1 * Math.sin(time * 5)); }
function updateLoot(dt) { if (!started || !P.placed) return; if ((CRATES.t -= dt) <= 0) { CRATES.t = .8; scanBoxes(); } updateHulls(); updatePops(dt); }
function boxUnder(cx, cy) {
  const r = view.getBoundingClientRect(), v = new THREE.Vector3(), w = new THREE.Vector3(); let best = null, bs = 1;
  for (const bx of CRATES.list) { if (Math.hypot(bx.x - P.x, bx.z - P.z) > 90) continue; v.set(bx.x, bx.y, bx.z).project(cam); if (v.z > 1 || v.z < -1) continue;
    w.set(bx.x, bx.y + 1.2, bx.z).project(cam); const px = (v.x + 1) / 2 * r.width + r.left, py = (1 - v.y) / 2 * r.height + r.top;
    const rad = Math.max(30, Math.abs(w.y - v.y) / 2 * r.height * 1.4), sc = Math.hypot(px - cx, py - cy) / rad; if (sc < bs) { bs = sc; best = bx; } }
  return best; }
function tapBox(bx) {
  const d = Math.hypot(bx.x - P.x, bx.z - P.z);
  if (d < 3.6) { lootBox(bx); return; }
  if (DRV.on) { if (d < 9) lootBox(bx); else toast('Zu weit weg – näher ranfahren oder aussteigen', 1400); return; }
  Object.assign(GOCAR, { n: { box: bx, x: bx.x + bx.nx * 1.4, z: bx.z + bx.nz * 1.4 }, t: 0, best: 1e9, still: 0 }); showCarMark(GOCAR.n); }
// the crate pops: a short swell and a flash, then it is gone; coins burst out
const POPS = [];
function lootBox(bx) {
  if (LOOTED[bx.id]) return; LOOTED[bx.id] = Date.now(); store.set('hx.loot', LOOTED);
  const k = CRATES.list.indexOf(bx); if (k >= 0) { CRATES.list.splice(k, 1); const m = new THREE.Matrix4(); CRATES.list.forEach((b, i) => { m.compose(new THREE.Vector3(b.x, b.y, b.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, b.yaw, 0)), new THREE.Vector3(1, 1, 1)); CRATES.mesh.setMatrixAt(i, m); }); CRATES.mesh.count = CRATES.list.length; CRATES.mesh.instanceMatrix.needsUpdate = true; }
  const pm = new THREE.Mesh(CRATES.mesh.geometry, CRATES.mesh.material.clone()); pm.material.emissive = new THREE.Color(1, .85, .4); pm.position.set(bx.x, bx.y, bx.z); pm.rotation.y = bx.yaw; scene.add(pm);
  POPS.push({ m: pm, t: 0 });
  const v = new THREE.Vector3(bx.x, bx.y + .2, bx.z).project(cam), r = view.getBoundingClientRect();
  coinBurst((v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top, bx.gold);
  if (navigator.vibrate) try { navigator.vibrate(18); } catch (e) { }
}
function updatePops(dt) { for (let i = POPS.length - 1; i >= 0; i--) { const p = POPS[i]; p.t += dt; const t = p.t / .22;
  const s = t < .45 ? 1 + t / .45 * .35 : Math.max(0, 1.35 * (1 - (t - .45) / .55)); p.m.scale.setScalar(s); p.m.material.emissiveIntensity = Math.max(0, 1 - t) * 1.2;
  if (t >= 1) { scene.remove(p.m); p.m.material.dispose(); POPS.splice(i, 1); } } }
// coins: DOM sprites over the game (sharp pixels at any size), burst out, then snap into the bag button
function coinBurst(x0, y0, n) {
  const bag = $('bInv').getBoundingClientRect(), tx = bag.left + bag.width * .3, ty = bag.top + bag.height / 2;
  snd.chest && snd.chest();
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div'); el.className = 'coinfly'; el.innerHTML = '<i style="background-image:url(' + COIN_URL + ')"></i>'; document.body.appendChild(el);
    const a = -Math.PI / 2 + (Math.random() - .5) * 2.4, sp = 50 + Math.random() * 60, bx = x0 + Math.cos(a) * sp, by = y0 + Math.sin(a) * sp * .9;
    const delay = 40 + i * 45, sz = 22 + Math.random() * 6;
    el.style.width = el.style.height = sz + 'px';
    const anim = el.animate([
      { transform: `translate(${x0 - sz / 2}px,${y0 - sz / 2}px) scale(.3)`, offset: 0 },
      { transform: `translate(${bx - sz / 2}px,${by - sz / 2}px) scale(1.15)`, offset: .38, easing: 'cubic-bezier(.5,0,.9,.4)' },
      { transform: `translate(${tx - sz / 2}px,${ty - sz / 2}px) scale(.55)`, offset: 1 }
    ], { duration: 560 + Math.random() * 90, delay, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'both' });
    anim.onfinish = () => { el.remove(); INV.gold++; store.set('hx.inv', INV); showGold(true); snd.coin && snd.coin(i); };
  }
}
function showGold(bump) { $('gold').textContent = INV.gold; $('invGold').textContent = INV.gold; if (bump) { const b = $('bInv'); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); } }
showGold(false);
$('bInv').addEventListener('click', () => { $('inv').hidden = !$('inv').hidden; showGold(false); });
$('invClose').addEventListener('click', () => { $('inv').hidden = true; });
document.querySelectorAll('.coinimg').forEach(i => { i.src = COIN_URL; });
[groundMat, bldMat, carMat].forEach(withLamp);
/* Runde 144: what the telephone booths (zellen.js) need */
window.HXZ_API = { scene, P, DRV, tiles, LAYERS, clearCars(x, z, r) { let n = 0; for (const [k, a] of carTiles) { if (k === 'drv') continue; for (let i = 0; i < a.length; i += 6) if (a[i + 3] >= 0 && a[i + 3] < 8 && (a[i] - x) ** 2 + (a[i + 1] - z) ** 2 < r * r) { a[i + 3] = -1; n++; } } if (n) { carDirty = true; carVer++; } return n; }, // Runde 188: no parked cars in front of a telephone booth
  get started() { return started; }, buildingAt: (x, z) => !!buildingAt(x, z), terrainH: (x, z) => terrainH(x, z), water: (x, z) => !!waterFloor(x, z),
  underground: (x, z) => !!(TUN.segs.length && underground(x, z, terrainH(x, z) + 1)), toLocal: (a, b) => toLocal(a, b), toLatLon: (x, z) => toLatLon(x, z), streetAt: (x, z) => streetAt(x, z, 40),
  night: () => Math.max(0, Math.min(1, (cur.lamp || 0) / 1.5)) };
/* Runde 141: what the weather module (wetter.js) needs */
window.HXWX_API = { scene, groundMat, bldMat, P, DV, DRV, store, get cam() { return cam; }, get iso() { return cam === iso; }, get isoZoom() { return isoZoom; }, get started() { return started; },
  terrainH: (x, z, y) => terrainH(x, z, y), underground: (x, z, y) => !!(TUN.segs.length && underground(x, z, y)), water: (x, z) => !!waterFloor(x, z), waterProbe, waterSurf: (x, z) => waterSurf(x, z), /* = the drawn water surface (measured: ray onto the water mesh) */ waterFloor: (x, z) => waterFloor(x, z), get camera() { return camera; }, remood: () => applyMood(cur), waterIce, get fogColor() { return scene.fog.color; } };
window.HXTR = { get SIGHTS() { return SIGHTS; }, player, isoCam: iso, setFigur, addEigenCard, get CARS() { let n = 0, g = 0; for (const a of carTiles.values()) for (let i = 0; i < a.length; i += 6) { n++; if (a[i + 3] < 0) g++; } return { n, weg: g }; }, get OCCDBG() { return { slots: occSlots.map(o => ({ a: +o.a.toFixed(2), cx: Math.round((o.b.minx + o.b.maxx) / 2 - P.x), cz: Math.round((o.b.minz + o.b.maxz) / 2 - P.z), h: Math.round(o.b.h - o.b.base), l2: o.b.l2 })), g: occG.map(o => o.g + ":" + o.a.toFixed(2)) }; }, HXL, withLamp, itemGhost, get BG() { return bgrid; }, get L2B() { return L2B; }, bldU: bldUniforms, beamTex: () => beamTex(), glowTex: () => glowTex(), get worker() { return worker; }, SPAN_APP, ELEV_APP, scene, terrainH, buildGraph, ONEW, P, DV, DRV, tiles, BINS, waterAt, waterSurf, buildingAt, inPoly, camera, streetAt, DIPS_APP, get ELEV() { return typeof ELEV_APP !== 'undefined' ? ELEV_APP : null; }, get camMode() { return camMode; }, get night() { return Math.max(0, Math.min(1, (cur.lamp || 0) / 1.5)); }, get TILEVER() { return TILEVER; }, get PRUEF() { return PRUEF; }, get ISO() { return ISO; } }; // Runde 81: traffic.js
window.HXD = { toLocal: (lat, lon) => toLocal(lat, lon), terrainH2: (x, z, y) => terrainH(x, z, y), get tiles() { return tiles; }, get mw() { return DRV.mw; }, buildGraph2: () => buildGraph(), attach: (G, x, z, h, n) => attach(G, x, z, h, n), get ONEW() { return ONEW; }, get CRATES() { return CRATES; }, get INV() { return INV; }, lootBox: b => lootBox(b), get worker() { return worker; }, get worldReady() { return worldReady; }, bldUniforms, groundAround: r => groundAround(r), JOBQ, onData: e => onData(e), toLatLon: (x, z) => toLatLon(x, z), lod2Top, bridgeElev, ELEV_APP, jump, objTop, surfAhead, CORR_APP, DZ_APP, dzH, terrainRaw, wakePts, waterAt, WFIELDS, enterCar, leaveCar, driveTo, nearestParked, buildGraph, nearestNode, aStar, DRV, DV, P, keys, meshes, scene, dipInfo, DIPS_APP, RAILS, railAt, get camera() { return camera; }, get renderer() { return renderer; }, get iso() { return iso; } }; // debugging in the browser console
// route on the mini and big map
function drawRouteMini(ctx, ms) {
  const R = DRV.route; if (!R || R.length < 4) return;
  ctx.strokeStyle = UIT[UI].r; ctx.lineWidth = 9; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  for (let i = (DRV.auto ? DRV.auto.idx : 0) * 2; i < R.length; i += 2) i === (DRV.auto ? DRV.auto.idx : 0) * 2 ? ctx.moveTo(R[i] * ms, R[i + 1] * ms) : ctx.lineTo(R[i] * ms, R[i + 1] * ms);
  ctx.stroke();
}
function drawRouteBig(ctx, toS) {
  const R = DRV.route; if (!R || R.length < 4) return;
  ctx.strokeStyle = '#4fc3ff'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  for (let i = 0; i < R.length; i += 2) { const [x, y] = toS(R[i], R[i + 1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
}

// Runde 122: read-only view of the build state for the loading info panel (ladeinfo.js)
window.HXGO = { toLocal: (a, b) => toLocal(a, b), toLatLon: (x, z) => toLatLon(x, z), jump: (x, z, label) => { $('bmInfo').textContent = label || 'Ziel'; jumpTo(x, z); }, driveTo: (x, z, l, n, line) => driveTo(x, z, l, n, line), stopAuto: () => stopAuto(), board: () => boardHere(), openBig: () => openBig(false), redraw: () => drawBig(), select: (x, z, l) => selectAt(x, z, l), center: (x, z, s) => { bm.cx = x; bm.cz = z; if (s) bm.s = s; drawBig(); }, get sel() { return bm.sel; }, get pos() { return DRV.on ? { x: DV.x, z: DV.z } : { x: P.x, z: P.z }; }, get driving() { return DRV.on; }, get auto() { return DRV.auto; }, get ready() { return worldReady; }, toast: (t, ms) => toast(t, ms), streetAt: (x, z) => streetAt(x, z, 60) };
window.HXLD = { get started() { return started; }, get worldReady() { return worldReady; }, loaded, JOBQ, TER, MX_COL, store, TERRAIN, groundAround: R => groundAround(R) };
if (profile && profile.lat) { $('profile').hidden = true; makeWorker(profile.lat, profile.lon); start(); }
else openProfile();
})();
