/* HoodExplorer – simulated traffic, minimal setup (Runde 81).
   Cars drive on the route graph of the autopilot (X.buildGraph: one-way streets, motorways, bridges, tunnels), only around the
   player (spawned 60-220 m away, removed beyond 260 m). At every junction a car turns at random (straight on is more likely),
   keeps its distance to the car ahead and stops for the player. Right-hand traffic: on two-way streets a quarter of the road
   width right of the centre line. Drawn with the parked-car models, one instanced draw call per type.
   Cost: graph rebuilt at most every 4 s when tiles changed; per frame O(n^2) distance check for n <= 40 (PC) / 18 (phone). */
const X = window.HXTR; // the app's state (app.js runs in its own scope)
const TR = { on: true, G: null, ver: -1, t: 0, cars: [], meshes: [], max: matchMedia('(pointer:coarse)').matches ? 18 : 40, ms: 0, msN: 0, msAvg: 0, cell: null, time: 0, vx: 0, vz: 0 };
const TR_R = 220, TR_KILL = 260, TR_PER = 12; // TR_PER: most of one variant at the same time
/* Runde 88: the vehicles come from the vehicle kit (fahrzeuge.js): ~50 variants - cars, sports cars, vans of firms, lorries, buses,
   police / ambulance / fire brigade. One instanced mesh per variant, hidden while none of it drives. */
const TR_SPORT = ['#c8201c', '#f2c200', '#2a63c4', '#e8641a', '#1f8a4a', '#111214', '#e9e9e6', '#7a1f8a'].map(c => new THREE.Color(c));
let TR_V = [], TR_WSUM = [0, 0];
try { const v = localStorage.getItem('hx.traffic'); if (v === 'false') TR.on = false; } catch (e) {}
if (/[?&]verkehr=0/.test(location.search)) TR.on = false;
if (/^(west|mittel)$/.test(window.HX_WELT)) TR.on = false; // Runde 93: no cars in the Wild West and the Middle Ages
{ const m = /[?&]verkehr=(\d+)/.exec(location.search); if (m && +m[1] > 0) TR.max = Math.min(+m[1], 200); }

function trInit() {
  TR_V = window.HXFZ.build();
  TR_V.forEach(v => {
    const cap = v.cap = v.rail || v.bus || v.id === 'reisebus' ? 64 : TR_PER; // Runde 89: rail cars and buses also come from the real timetable (oepnv.js)
    const m = new THREE.InstancedMesh(v.geo, window.HXFZ.material, cap);
    m.geometry.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    m.geometry.setAttribute('iVar', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    m.count = 0; m.visible = false; m.frustumCulled = false; X.scene.add(m); TR.meshes.push(m);
    v.pm = (v.parts || []).map(pt => { const q = new THREE.InstancedMesh(pt.geo, window.HXFZ.material, cap); // Runde 140: trailer / rear section, same instance slot as the front
      q.geometry.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3)); q.geometry.setAttribute('iVar', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
      q.count = 0; q.visible = false; q.frustumCulled = false; X.scene.add(q); return q; });
  });
  TR_WSUM = [0, 1].map(main => TR_V.reduce((s, v) => s + (v.road && !main ? 0 : v.w), 0));
  const el = document.getElementById('tTraffic');
  if (el) { el.checked = TR.on; el.addEventListener('change', e => { TR.on = e.target.checked; try { localStorage.setItem('hx.traffic', TR.on); } catch (x) {} if (!TR.on) { TR.cars = []; trDraw(); } }); }
}

const trBase = w => w % 1000, trMw = w => Math.floor(w / 1000) % 2 === 1;
function trEdge(G, a, b) { const l = G.adj[a]; for (let k = 0; k < l.length; k += 3) if (l[k] === b) return k; return -1; }
function trNode(G, x, z) { // node of the (new) graph at a point, within 2 m
  const l = TR.cell.get(Math.floor(x / 4) * 100003 + Math.floor(z / 4)); let best = -1, bd = 4;
  for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) { const c = TR.cell.get((Math.floor(x / 4) + u) * 100003 + Math.floor(z / 4) + v); if (c) for (const n of c) { const d = (G.xs[n] - x) ** 2 + (G.zs[n] - z) ** 2; if (d < bd) { bd = d; best = n; } } }
  return best;
}
function trRebuild() {
  const keep = new Set(X.ONEW), G = X.buildGraph(); X.ONEW.clear(); keep.forEach(k => X.ONEW.add(k)); // the autopilot's one-way set stays as it was
  TR.cell = new Map(); for (let n = 0; n < G.xs.length; n++) { const k = Math.floor(G.xs[n] / 4) * 100003 + Math.floor(G.zs[n] / 4); let l = TR.cell.get(k); if (!l) TR.cell.set(k, l = []); l.push(n); }
  TR.G = G; TR.ver = X.TILEVER;
  // cars keep their place: find their nodes in the new graph, or leave
  TR.cars = TR.cars.filter(c => { const a = trNode(G, c.ax, c.az), b = trNode(G, c.bx, c.bz); if (a < 0 || b < 0 || trEdge(G, a, b) < 0) return !!c.park; c.a = a; c.b = b;
    if (c.dest && !c.park) { const t = trNear(G, c.tx, c.tz), p = t >= 0 && window.HXD ? HXD.aStar(G, b, t) : null; if (p) { c.path = [a].concat(p); c.pi = 1; c.n = p.length > 1 ? p[1] : -1; return true; } c.dest = 0; c.path = null; } // Runde 171: the run goes on in the new graph
    if (!c.park) c.n = trNext(c); return true; });
}
function trNear(G, x, z) { let t = -1, td = 60 * 60; for (let n = 0; n < G.xs.length; n++) { if (!G.adj[n].length) continue; const d = (G.xs[n] - x) ** 2 + (G.zs[n] - z) ** 2; if (d < td) { td = d; t = n; } } return t; }
/* Runde 171: an emergency run (gore scene) - a police car or ambulance starts out of the picture 90-230 m away, drives with blue light
   along the shortest way (aStar of the autopilot) to the place, parks at the kerb with the blue light still on; release() lets it drive
   off without it. Parked/dispatched cars are not removed by distance. */
TR.dispatch = (x, z, id, hint) => { // Runde 172: hint = {x, z} - start there (ahead of the driver): the car comes towards him
  const G = TR.G, A = window.HXD && HXD.aStar; if (!G || !A || !TR.on || !TR_V.length) return null; const type = TR_V.findIndex(v => v.id === id); if (type < 0) return null;
  const t = trNear(G, x, z); if (t < 0) return null; const cam = X.camera, P = new THREE.Vector3(), starts = [];
  if (hint) { const near = []; for (let n = 0; n < G.xs.length; n++) { if (!G.adj[n].length) continue; const d = Math.hypot(G.xs[n] - hint.x, G.zs[n] - hint.z); if (d < 40 && Math.hypot(G.xs[n] - x, G.zs[n] - z) > 30 && (hint.fx === undefined || (G.xs[n] - hint.ox) * hint.fx + (G.zs[n] - hint.oz) * hint.fz > 20)) near.push([d, n]); } // ahead of the driver only
    near.sort((p, q) => p[0] - q[0]); for (const q of near.slice(0, 3)) starts.push(q[1]); }
  for (let tr = 0, tries = 0; tr < 150 + starts.length && tries < 4 + starts.length; tr++) { let a;
    if (tr < starts.length) a = starts[tr];
    else { a = (Math.random() * G.xs.length) | 0; const d = Math.hypot(G.xs[a] - x, G.zs[a] - z); if (d < 90 || d > 230 || !G.adj[a].length) continue;
      P.set(G.xs[a], X.terrainH(G.xs[a], G.zs[a]) + 1, G.zs[a]).project(cam); if (tr < 120 && P.z < 1 && Math.abs(P.x) < 1.1 && Math.abs(P.y) < 1.1) continue; } // fallback: from out of the picture
    tries++; const path = A(G, a, t); if (!path || path.length < 2 || path.length > 120) continue;
    const V = TR_V[type], c = { fromHint: tr < starts.length, a: path[0], b: path[1], path, pi: 1, dest: 1, tx: x, tz: z, t: 0, seed: Math.random(), type, len: V.len, siren: true, v: 0, x: G.xs[a], z: G.zs[a], y: 0, h: 0, col: null };
    trSetEdge(c); c.v = c.vmax * .6; c.h = Math.atan2(c.bx - c.ax, c.bz - c.az); c.x -= Math.cos(c.h) * c.off; c.z += Math.sin(c.h) * c.off; c.y = X.terrainH(c.x, c.z); c.n = path.length > 2 ? path[2] : -1;
    TR.cars.push(c); return c; }
  return null;
};
TR.release = c => { if (!c || TR.cars.indexOf(c) < 0) return; c.dest = 0; c.path = null; c.park = 0; c.siren = false; c.n = trNext(c); };
function trNext(c) { // the next node after b: random, straight on preferred, never back unless it is a dead end
  const G = TR.G, l = G.adj[c.b], dx = G.xs[c.b] - G.xs[c.a], dz = G.zs[c.b] - G.zs[c.a], dl = Math.hypot(dx, dz) || 1, opts = [];
  let sum = 0;
  for (let k = 0; k < l.length; k += 3) { const m = l[k]; if (m === c.a || trBase(l[k + 2]) < 5.5 && trBase(l[k + 2]) !== 10) continue;
    const ex = G.xs[m] - G.xs[c.b], ez = G.zs[m] - G.zs[c.b], co = (ex * dx + ez * dz) / ((Math.hypot(ex, ez) || 1) * dl); if (co < -.6) continue; // no sharp U-turns
    const wgt = (1.2 + co) ** 2 * (trMw(l[k + 2]) === trMw(G.adj[c.a][trEdge(G, c.a, c.b) + 2] || 0) ? 1 : .35); opts.push(m, wgt); sum += wgt; }
  if (!opts.length) return trEdge(G, c.b, c.a) >= 0 ? c.a : -1; // dead end: turn round if the street is two-way
  let r = Math.random() * sum; for (let i = 0; i < opts.length; i += 2) { r -= opts[i + 1]; if (r <= 0) return opts[i]; } return opts[opts.length - 2];
}
function trSetEdge(c) { const G = TR.G, k = trEdge(G, c.a, c.b), w = G.adj[c.a][k + 2], base = trBase(w), two = trEdge(G, c.b, c.a) >= 0;
  c.ax = G.xs[c.a]; c.az = G.zs[c.a]; c.bx = G.xs[c.b]; c.bz = G.zs[c.b]; c.L = Math.hypot(c.bx - c.ax, c.bz - c.az) || .01;
  c.off = two ? Math.min(base / 4, 2.2) : base >= 8 ? (c.seed > .5 ? 1 : -1) * base / 4 : 0; // right-hand traffic; wide one-way carriageways: a lane each side
  c.vmax = (trMw(w) ? (c.len > 7 ? 23 : 30) : base >= 8 ? 14 : 9.5) * (.85 + .25 * c.seed) * (c.siren ? 1.25 : 1); } // lorries and buses slower on the motorway, blue-light runs faster
function trSpawn(px, pz) {
  const G = TR.G, N = G.xs.length; if (!N) return;
  /* Runde 89 (motorway at 130 km/h = 36 m/s: new cars appeared all round, half of them behind the player and gone at once - ahead it
     thinned out): when moving fast, new cars come ahead (in a cone of +-70 deg) and up to 3 s of travel farther out */
  const sp = Math.hypot(TR.vx, TR.vz), fast = sp > 10 && !TR.nobias, R = TR_R + (fast ? Math.min(140, sp * 3) : 0);
  for (let tr = 0; tr < 40; tr++) { const a = (Math.random() * N) | 0, ex = G.xs[a] - px, ez = G.zs[a] - pz, d = Math.hypot(ex, ez); if (d < 60 || d > R) continue;
    if (fast && (ex * TR.vx + ez * TR.vz) / (d * sp) < .35) continue;
    const l = G.adj[a]; if (!l.length) continue; const k = 3 * ((Math.random() * l.length / 3) | 0), b = l[k], w = l[k + 2]; if (w >= 2000 || trBase(w) < 5.5 && trBase(w) !== 10) continue; // not on bridges/in tunnels (height), not on service ways
    if (Math.random() > Math.min(1, trBase(w) / 11)) continue; // more cars on the main roads than in side streets
    if (TR.cars.some(c => (c.a === a && c.b === b) || Math.hypot(c.x - G.xs[a], c.z - G.zs[a]) < 12)) continue;
    const main = trBase(w) >= 7 || trMw(w) ? 1 : 0, noBus = window.OEPNV && !window.OEPNV.simBuses(); // lorries and buses only on main roads; no simulated buses where the real ones run
    let sum = 0; for (const v of TR_V) if (!(v.road && !main) && !(noBus && v.bus)) sum += v.w;
    let r = Math.random() * sum, type = 0; for (let i = 0; i < TR_V.length; i++) { const v = TR_V[i]; if ((v.road && !main) || (noBus && v.bus)) continue; r -= v.w; if (r <= 0) { type = i; break; } }
    const V = TR_V[type], c = { a, b, t: 0, seed: Math.random(), type, len: V.len, siren: V.em && Math.random() < .55, v: 0, x: G.xs[a], z: G.zs[a], y: 0, h: 0 };
    c.col = V.cls === 'car' ? CAR_COLOURS[(Math.random() * 12) | 0] : V.cls === 'sport' ? TR_SPORT[(Math.random() * TR_SPORT.length) | 0] : null;
    trSetEdge(c); c.v = c.vmax * .6; c.h = Math.atan2(c.bx - c.ax, c.bz - c.az); c.x -= Math.cos(c.h) * c.off; c.z += Math.sin(c.h) * c.off; c.y = X.terrainH(c.x, c.z); c.n = trNext(c);
    TR.cars.push(c); return; }
}
/* Runde 174: siren - the German two-tone horn (a1 440 Hz / d2 587 Hz, 0.65 s each) for the nearest emergency vehicle on a run within
   160 m; silent while it stands or is parked. Volume by distance, left/right by the camera, the pitch drops as it passes (Doppler).
   One voice for all (only the nearest sounds); the audio context starts with the first touch or key (browser rule). */
const TR_S = { ac: null };
function trSirenAudio() { if (TR_S.ac) return TR_S.ac; try { const ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain(), p = ac.createStereoPanner ? ac.createStereoPanner() : null;
  o.type = 'sawtooth'; o.frequency.value = 440; f.type = 'lowpass'; f.frequency.value = 1900; f.Q.value = .7; g.gain.value = 0; o.connect(f); f.connect(g); if (p) { g.connect(p); p.connect(ac.destination); } else g.connect(ac.destination); o.start();
  Object.assign(TR_S, { ac, o, g, p }); return ac; } catch (e) { return null; } }
['pointerdown', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, () => { const ac = trSirenAudio(); if (ac && ac.state !== 'running') ac.resume(); }, { passive: true }));
function trSiren(px, pz) {
  const ac = TR_S.ac; if (!ac || ac.state !== 'running') return; const t = ac.currentTime; let best = null, bd = 160;
  if (TR.on) for (const c of TR.cars) if (c.siren && !c.park && c.v > .8) { const d = Math.hypot(c.x - px, c.z - pz); if (d < bd) { bd = d; best = c; } }
  if (!best) { TR_S.g.gain.setTargetAtTime(0, t, .12); return; }
  const dx = best.x - px, dz = best.z - pz, d = Math.hypot(dx, dz) || 1, away = (Math.sin(best.h) * dx + Math.cos(best.h) * dz) / d * best.v; // > 0: moving away
  const f0 = Math.floor(performance.now() / 650 + best.seed * 2) % 2 ? 587 : 440;
  TR_S.o.frequency.setTargetAtTime(f0 * 343 / (343 + away), t, .012);
  TR_S.g.gain.setTargetAtTime(Math.pow(1 - bd / 160, 2) * .14, t, .12);
  if (TR_S.p && X.camera) { const e = X.camera.matrixWorld.elements, rl = Math.hypot(e[0], e[2]) || 1; TR_S.p.pan.setTargetAtTime(Math.max(-.85, Math.min(.85, (dx * e[0] + dz * e[2]) / (d * rl))), t, .05); }
}
function updateTraffic(dt) {
  if (!TR.meshes.length) trInit();
  if (!X.P.placed || X.PRUEF !== null || X.ISO !== null) { if (TR.cars.length) { TR.cars = []; trDraw(); } if (TR_S.ac) trSiren(0, 0); return; }
  if (!TR.on) { // Runde 91: no cars, but buses and trains can still run
    if (TR.cars.length) TR.cars = []; if (TR_S.ac) trSiren(0, 0); // silent when traffic is switched off
    const ox = X.DRV.on ? X.DV.x : X.P.x, oz = X.DRV.on ? X.DV.z : X.P.z;
    if (window.updateOepnv) try { window.updateOepnv(ox, oz, 0, 0, Math.min(dt, .1)); } catch (e) { console.warn('oepnv', e); }
    trDraw(); return; }
  const t0 = performance.now(); dt = Math.min(dt, .1); TR.t += dt;
  const px = X.DRV.on ? X.DV.x : X.P.x, pz = X.DRV.on ? X.DV.z : X.P.z;
  if (X.TILEVER !== TR.ver && (TR.t > 4 || !TR.G)) { TR.t = 0; trRebuild(); }
  if (!TR.G) return;
  if (TR.lx !== undefined && dt > 0 && Math.hypot(px - TR.lx, pz - TR.lz) < 50) { const k = 1 - Math.exp(-dt * 2); TR.vx += ((px - TR.lx) / dt - TR.vx) * k; TR.vz += ((pz - TR.lz) / dt - TR.vz) * k; } TR.lx = px; TR.lz = pz; // player's velocity, smoothed
  const kill = TR_KILL + Math.min(140, Math.hypot(TR.vx, TR.vz) * 3);
  TR.cars = TR.cars.filter(c => c.dest || Math.hypot(c.x - px, c.z - pz) < kill);
  if (window.OEPNV && !(OEPNV.on && OEPNV.bus)) TR.cars = TR.cars.filter(c => !TR_V[c.type].bus); // buses switched off (Runde 91)
  for (let k = 0; k < 2 && TR.cars.length < TR.max; k++) trSpawn(px, pz);
  const G = TR.G, cs = TR.cars, ks = 1 - Math.exp(-dt * 6);
  for (let i = 0; i < cs.length; i++) { const c = cs[i], fx = Math.sin(c.h), fz = Math.cos(c.h);
    // gap to whatever is ahead in the lane: other cars, the player
    // gap = free road between the bumpers (vehicles are 3.9-18 m long)
    let gap = 99; const look = (ox, oz, lat, j, half) => { const rx = ox - c.x, rz = oz - c.z, al = rx * fx + rz * fz; if (al <= 0 || al > 40) return; if (Math.abs(rx * fz - rz * fx) > lat) return; if (j >= 0) { const o = cs[j], co = Math.sin(o.h) * fx + Math.cos(o.h) * fz; if (co < -.5) return; if (Math.abs(co) < .5 && j > i) return; } const free = al - c.len / 2 - half; if (free < gap) gap = free; };
    for (let j = 0; j < cs.length; j++) if (j !== i) look(cs[j].x, cs[j].z, 1.6, j, cs[j].len / 2);
    look(px, pz, 2.2, -1, .5);
    let vt = Math.min(c.vmax, Math.max(0, (gap - 2.5) * 1.1)); if (c.park) vt = 0; else if (c.dest && c.n < 0) vt = Math.min(vt, 2 + (c.L - c.t) * .6); // parked at the scene / slowing down to it
    if (c.n >= 0) { const nx = G.xs[c.n] - c.bx, nz = G.zs[c.n] - c.bz, co = (nx * (c.bx - c.ax) + nz * (c.bz - c.az)) / ((Math.hypot(nx, nz) || 1) * c.L); if (co < .75) vt = Math.min(vt, 4.5 + (c.L - c.t) * .55); } // slow down before turning
    c.brk = vt < c.v - .4 || (c.v < .6 && vt < 1); // Runde 95: brake lights when slowing down or standing in the queue
    c.sig = 0; if (c.n >= 0 && c.L - c.t < 30) { const nx = G.xs[c.n] - c.bx, nz = G.zs[c.n] - c.bz; let dh = Math.atan2(nx, nz) - Math.atan2(c.bx - c.ax, c.bz - c.az); dh = Math.atan2(Math.sin(dh), Math.cos(dh)); if (Math.abs(dh) > .5) c.sig = dh > 0 ? 1 : 2; } // indicator before a turn (heading grows towards the car's left)
    c.v += Math.max(-10 * dt, Math.min(3 * dt, vt - c.v)); if (c.v < 0) c.v = 0;
    if (c.dest && !c.park) { const dd = Math.hypot(c.x - c.tx, c.z - c.tz); c.stk = c.v < .4 ? (c.stk || 0) + dt : 0; if ((dd < 16 && c.v < 1.5) || (dd < 45 && c.stk > 4)) { c.park = 1; c.v = 0; c.off = Math.max(c.off, 0) + 1.3; } } // Runde 171: near the place and held up (the player, a queue): park here
    c.t += c.v * dt;
    while (c.t >= c.L) { if (c.n < 0) { if (c.dest) { c.t = c.L; if (!c.park) { c.park = 1; c.v = 0; c.off = Math.max(c.off, 0) + 1.3; } break; } c.dead = 1; break; } // Runde 171: at the scene: park at the kerb
      c.t -= c.L; c.a = c.b; c.b = c.n; trSetEdge(c); c.n = c.path ? (++c.pi + 1 < c.path.length ? c.path[c.pi + 1] : -1) : trNext(c); }
    if (c.dead) continue;
    const ux = (c.bx - c.ax) / c.L, uz = (c.bz - c.az) / c.L, tx = c.ax + ux * c.t - uz * c.off, tz = c.az + uz * c.t + ux * c.off; // right of travel = (-uz, ux)
    const ox = c.x, oz = c.z; c.x += (tx - c.x) * ks; c.z += (tz - c.z) * ks;
    if (Math.hypot(c.x - ox, c.z - oz) > .002) { const hh = Math.atan2(c.x - ox, c.z - oz); let dh = hh - c.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); c.h += dh * Math.min(1, dt * 10); }
    if (c.hx === undefined || Math.abs(c.x - c.hx) + Math.abs(c.z - c.hz) > .8) { // Runde 88: terrainH costs ~0.035 ms (decks, troughs) - height and pitch only every 80 cm
      c.hx = c.x; c.hz = c.z; c.y = X.terrainH(c.x, c.z, c.y + 1); const hl = Math.max(1.9, c.len / 2 - .8);
      c.hF = X.terrainH(c.x + fx * hl, c.z + fz * hl, c.y + 1); c.hB = X.terrainH(c.x - fx * hl, c.z - fz * hl, c.y + 1); c.hl = hl; } }
  TR.cars = cs.filter(c => !c.dead);
  if (window.updateOepnv) try { window.updateOepnv(px, pz, TR.vx, TR.vz, dt); } catch (e) { console.warn('oepnv', e); }
  trDraw(); trSiren(px, pz);
  TR.ms += performance.now() - t0; if (++TR.msN >= 60) { TR.msAvg = TR.ms / TR.msN; TR.ms = 0; TR.msN = 0; }
}
const _tq0 = new THREE.Quaternion(), _tsP = new THREE.Vector3(), _tc = new THREE.Color(), TR_GLOW = 600, _lv = new THREE.Vector3(), _tm2 = new THREE.Matrix4(), _tp2 = new THREE.Vector3(), _tq2 = new THREE.Quaternion(), _ts2 = new THREE.Vector3();
const _tm3 = new THREE.Matrix4(), _te = new THREE.Euler(), _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _tp = new THREE.Vector3(), _ts = new THREE.Vector3(1, 1, 1);
function trDraw() {
  const cnt = new Array(TR.meshes.length).fill(0);
  const night = Math.min(1, X.night * 1.4); TR.time += 1 / 60; window.HXFZ.tick(performance.now() / 1000, night);
  if (!TR.beam) { // Runde 98: the same lights as the own car (app.js makeCarLights): two light cones per vehicle and a glow on every lamp
    const geo = new THREE.PlaneGeometry(3.4, 13); geo.rotateX(-Math.PI / 2); geo.translate(0, 0, 6.3);
    TR.beamMat = new THREE.MeshBasicMaterial({ map: X.beamTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
    TR.beam = new THREE.InstancedMesh(geo, TR.beamMat, 240); TR.beam.frustumCulled = false; TR.beam.count = 0; X.scene.add(TR.beam);
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TR_GLOW * 3), 3)); pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TR_GLOW * 3), 3));
    TR.glow = new THREE.Points(pg, new THREE.PointsMaterial({ map: X.glowTex(), vertexColors: true, size: 1.25, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    TR.glow.frustumCulled = false; X.scene.add(TR.glow);
    for (const v of TR_V) { // lamp centres per side from the kit geometry (aK 6 head, 7 tail); trailer parts have their own (Runde 140)
      for (const o of [v].concat(v.parts || [])) { const P = o.geo.attributes.position, K = o.geo.attributes.aK, acc = {}; o.lamps = [];
      for (let i = 0; i < P.count; i++) { const k = K.getX(i); if (k !== 6 && k !== 7) continue; const key = k + (P.getX(i) < 0 ? 'R' : 'L'), a = acc[key] || (acc[key] = [0, 0, 0, 0, -1e9, k]); a[0] += P.getX(i); a[1] += P.getY(i); a[2] += P.getZ(i); a[3]++; a[4] = Math.max(a[4], k === 6 ? P.getZ(i) : -P.getZ(i)); }
      for (const key in acc) { const a = acc[key]; o.lamps.push({ x: a[0] / a[3], y: a[1] / a[3], z: a[2] / a[3], head: a[5] === 6, edge: a[5] === 6 ? a[4] : -a[4] }); } }
      const P = v.geo.attributes.position, K = v.geo.attributes.aK;
      const bc = {}; v.beacons = []; for (let i = 0; i < P.count; i++) { const k = K.getX(i); if (k !== 2 && k !== 3) continue; const key = k + (P.getX(i) >= 0 ? 'L' : 'R'), a = bc[key] || (bc[key] = [0, 0, 0, 0, k, P.getX(i) >= 0 ? .5 : 0]); a[0] += P.getX(i); a[1] += P.getY(i); a[2] += P.getZ(i); a[3]++; }
      for (const key in bc) { const a = bc[key]; v.beacons.push({ x: a[0] / a[3], y: a[1] / a[3], z: a[2] / a[3], blue: a[4] === 2, ph: a[5] }); } }
    /* Runde 99: blue light at night - a flashing pool of light on the ground under each beacon (in step with the beacon shader:
       on = fract(t * 2.4 + seed + side * .5) >= .5), and for the own emergency vehicle a real point light that lights the walls */
    { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.45, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      const pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
      TR.pool = new THREE.InstancedMesh(pg, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), 64);
      TR.pool.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(64 * 3), 3); TR.pool.frustumCulled = false; TR.pool.count = 0; X.scene.add(TR.pool);
      TR.siren = { position: new THREE.Vector3(), intensity: 0 }; if (X.withLamp) X.withLamp(window.HXFZ.material); } } // Runde 102: the blue light is lamp 1 of the per-pixel lamps (app.js hxLamp)
  const tNow = performance.now() / 1000; let np = 0, sirenAt = null;
  const pools = (v, seed, own) => { if (night < .05 || !v.beacons || !v.beacons.length) return;
    for (const b of v.beacons) { if (np >= 64) break; const on = ((tNow * 2.4 + seed + b.ph) % 1) >= .5 ? 1 : 0;
      _lv.set(b.x * 2.2, .2, b.z); _lv.applyMatrix4(_tm); _tm2.compose(_lv, _tq0, _tsP.set(13, 1, 13)); TR.pool.setMatrixAt(np, _tm2);
      const k = on * night * (own ? .55 : .5); if (b.blue) TR.pool.setColorAt(np, _tc.setRGB(.15 * k, .35 * k, 1 * k)); else TR.pool.setColorAt(np, _tc.setRGB(k, .6 * k, .15 * k)); np++;
      if (own && on && b.blue) { _lv.set(b.x * 2.5, b.y + .6, b.z); _lv.applyMatrix4(_tm); sirenAt = _lv.clone(); } } };
  TR.beamMat.opacity = night * .9; let nb = 0, ng = 0; const gp = TR.glow.geometry.attributes.position, gc = TR.glow.geometry.attributes.color;
  const lights = (v, moving, brk) => { if (night < .05) return; // _tm: the vehicle's world matrix (v: the variant or one of its parts)
    for (const l of v.lamps) {
      if (l.head && nb < 240) { _lv.set(l.x, .12 - 0, l.edge); _lv.applyMatrix4(_tm); _tm.decompose(_tp2, _tq2, _ts2); _tm2.compose(_lv, _tq2, _ts); TR.beam.setMatrixAt(nb++, _tm2); }
      if (ng < TR_GLOW) { _lv.set(l.x, l.y, l.z + (l.head ? .12 : -.12)); _lv.applyMatrix4(_tm); gp.setXYZ(ng, _lv.x, _lv.y, _lv.z);
        const k = l.head ? night * .85 : night * (brk ? 1 : moving ? .55 : .3) + (brk ? .25 : 0); if (l.head) gc.setXYZ(ng, k, k * .94, k * .78); else gc.setXYZ(ng, k, k * .14, k * .08); ng++; } } };
  const parts = (V, st, slot, iv, col, moving, brk) => { if (!V.pm || !V.pm.length) return; // Runde 140: trailer parts follow the front (HXFZ.artic)
    _tm3.copy(_tm); window.HXFZ.artic(V, st, _tm3, X.terrainH, (k, M) => { const q = V.pm[k]; q.setMatrixAt(slot, M); q.geometry.attributes.iVar.setX(slot, iv);
      if (col) q.geometry.attributes.iCol.setXYZ(slot, col.r, col.g, col.b); else q.geometry.attributes.iCol.setXYZ(slot, -1, 0, 0);
      if (night >= .05 && V.parts[k].lamps.length) { _tm.copy(M); lights(V.parts[k], moving, brk); } }); _tm.copy(_tm3); };
  if (window.OEPNV) for (const o of window.OEPNV.items) { const m = TR.meshes[o.type]; if (!m || cnt[o.type] >= TR_V[o.type].cap) continue; // real buses and trains (oepnv.js)
    _te.set(0, o.h, 0, 'YXZ'); _tq.setFromEuler(_te); _tp.set(o.x, o.y, o.z); _tm.compose(_tp, _tq, _ts); m.setMatrixAt(cnt[o.type], _tm);
    lights(TR_V[o.type], true, false); m.geometry.attributes.iVar.setX(cnt[o.type], 0); m.geometry.attributes.iCol.setXYZ(cnt[o.type], -1, 0, 0); if (o.st) parts(TR_V[o.type], o.st, cnt[o.type], 0, null, true, false); cnt[o.type]++; }
  for (const c of TR.cars) { const m = TR.meshes[c.type]; if (!m || cnt[c.type] >= TR_V[c.type].cap) continue; const fx = Math.sin(c.h), fz = Math.cos(c.h), hl = Math.max(1.9, c.len / 2 - .8);
    const hF = c.hF !== undefined ? c.hF : c.y, hB = c.hB !== undefined ? c.hB : c.y;
    _te.set(-Math.atan2(hF - hB, 2 * hl), c.h, 0, 'YXZ'); _tq.setFromEuler(_te); _tp.set(c.x, (hF + hB) / 2, c.z); _tm.compose(_tp, _tq, _ts); m.setMatrixAt(cnt[c.type], _tm);
    lights(TR_V[c.type], c.v > .3, c.brk); if (c.siren) pools(TR_V[c.type], Math.min(c.seed, .999), false);
    const iv = Math.min(c.seed, .999) + (c.siren ? 2 : 0) + (c.sig === 1 ? 4 : c.sig === 2 ? 8 : 0) + (c.brk ? 16 : 0); m.geometry.attributes.iVar.setX(cnt[c.type], iv); const col = c.col; if (col) m.geometry.attributes.iCol.setXYZ(cnt[c.type], col.r, col.g, col.b); else m.geometry.attributes.iCol.setXYZ(cnt[c.type], -1, 0, 0);
    parts(TR_V[c.type], c.art || (c.art = {}), cnt[c.type], iv, col, c.v > .3, c.brk); cnt[c.type]++; }
  { const D = X.DRV; if (D && D.on && D.mesh && D.car && D.car.fz !== undefined && TR_V[D.car.fz] && TR_V[D.car.fz].em) { D.mesh.getMatrixAt(0, _tm); pools(TR_V[D.car.fz], .5, true); } }
  TR.pool.count = np; TR.pool.visible = np > 0; TR.pool.instanceMatrix.needsUpdate = true; TR.pool.instanceColor.needsUpdate = true;
  if (X.HXL) { if (sirenAt) { X.HXL.uHxLP.value[1].copy(sirenAt); X.HXL.uHxLC.value[1].setRGB(.19, .38, 1).multiplyScalar(night * 1.2); } else X.HXL.uHxLC.value[1].setRGB(0, 0, 0); }
  TR.beam.count = night > .05 ? nb : 0; TR.beam.visible = TR.beam.count > 0; TR.beam.instanceMatrix.needsUpdate = true;
  TR.glow.geometry.setDrawRange(0, ng); TR.glow.visible = ng > 0; gp.needsUpdate = true; gc.needsUpdate = true;
  TR.meshes.forEach((m, t) => { for (const q of [m].concat(TR_V[t].pm || [])) { q.count = cnt[t]; q.visible = cnt[t] > 0; q.instanceMatrix.needsUpdate = true; q.geometry.attributes.iCol.needsUpdate = true; q.geometry.attributes.iVar.needsUpdate = true; } });
}
window.updateTraffic = updateTraffic; window.TR = TR; TR.S = TR_S;
