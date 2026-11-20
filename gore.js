/* Runde 152: Gore (Einstellungen → Gore, both off by default)
   - "Passanten zerplatzen": a car that hits a pedestrian at speed bursts them into chunks and blood splats, every time different
     (count, sizes, directions, spin, stains are random; the chunks take the colours of that pedestrian's clothes and skin)
   - "Autopilot fährt Passanten gezielt an": the autopilot steers at a pedestrian ahead when one is close to its route
   Cost: two draws in all (splats: instanced camera-facing discs - drops, a red burst and flesh/cloth pieces; stains: instanced
   ground quads; Runde 153: the 3D cube chunks are gone, the pieces are splats too);
   the CPU only walks the live pieces, nothing runs while nothing flies. */
(function () {
'use strict';
const X = window.HXTR; if (!X || !window.THREE) return;
const G = { on: false, hunt: false };
try { G.on = localStorage.getItem('hx.gore') === 'true'; G.hunt = localStorage.getItem('hx.goreAuto') === 'true'; } catch (e) { }
const R = Math.random, rr = (a, b) => a + (b - a) * R();

// ------------------------------------------------------------------ splats: camera-facing discs (blood drops and a short red burst), hard pixel edge, dithered fade
const MAXS = 900;
const sGeo = new THREE.InstancedBufferGeometry(); sGeo.index = new THREE.PlaneGeometry(1, 1).index; sGeo.setAttribute('position', new THREE.PlaneGeometry(1, 1).attributes.position);
const sPos = new THREE.InstancedBufferAttribute(new Float32Array(MAXS * 3), 3), sCol = new THREE.InstancedBufferAttribute(new Float32Array(MAXS * 3), 3), sSA = new THREE.InstancedBufferAttribute(new Float32Array(MAXS * 2), 2);
for (const a of [sPos, sCol, sSA]) a.setUsage(THREE.DynamicDrawUsage);
sGeo.setAttribute('iPos', sPos); sGeo.setAttribute('iCol', sCol); sGeo.setAttribute('iSA', sSA); sGeo.instanceCount = 0;
const sU = { uDim: { value: 1 } };
const sMat = new THREE.ShaderMaterial({ uniforms: sU,
  vertexShader: `attribute vec3 iPos, iCol; attribute vec2 iSA; varying vec3 vC; varying vec2 vP; varying float vA;
    void main(){ vC = iCol; vA = iSA.y; vP = position.xy * 2.0; vec4 mv = modelViewMatrix * vec4(iPos, 1.0); mv.xy += position.xy * iSA.x; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float uDim; varying vec3 vC; varying vec2 vP; varying float vA;
    void main(){ float r = dot(vP, vP); if (r > 1.0) discard;
      vec2 q = floor(mod(gl_FragCoord.xy, 4.0)); float b = mod(q.x * 8.0 + q.y * 4.0 + mod(q.x + q.y, 2.0) * 2.0, 16.0) / 16.0; // ordered dither: fade without blending
      if (b + .03 > vA) discard;
      gl_FragColor = vec4(vC * (r > .55 ? .72 : 1.0) * uDim, 1.0); }` });
const sMesh = new THREE.Mesh(sGeo, sMat); sMesh.frustumCulled = false; X.scene.add(sMesh);
const SP = []; // {x,y,z,vx,vy,vz,s,grow,r,g,b,life,max,mist,piece,rest,stain}

// ------------------------------------------------------------------ stains on the ground: four pixel splat shapes in one texture, a ring buffer
const MAXD = 400;
const dTex = (() => { const N = 32, cv = document.createElement('canvas'); cv.width = cv.height = N * 2; const g = cv.getContext('2d'); let sd = 11; const q = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (let c = 0; c < 4; c++) { const ox = (c % 2) * N, oy = (c >> 1) * N; g.fillStyle = '#fff';
    const blob = (x, y, r) => { g.beginPath(); g.arc(ox + x, oy + y, r, 0, 7); g.fill(); };
    blob(16, 16, 6 + q() * 3); for (let i = 0; i < 7 + c * 2; i++) { const a = q() * 6.283, d = 4 + q() * 9; blob(16 + Math.cos(a) * d, 16 + Math.sin(a) * d, .8 + q() * 3); }
    for (let i = 0; i < 3; i++) { const a = q() * 6.283; for (let k = 0; k < 5; k++) blob(16 + Math.cos(a) * (8 + k * 1.6), 16 + Math.sin(a) * (8 + k * 1.6), 1.6 - k * .25); } } // drips running out
  const t = new THREE.CanvasTexture(cv); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; return t; })();
const dGeo = new THREE.PlaneGeometry(1, 1); dGeo.rotateX(-Math.PI / 2);
const dCell = new THREE.InstancedBufferAttribute(new Float32Array(MAXD * 2), 2); dGeo.setAttribute('aCell', dCell);
const dMat = new THREE.MeshLambertMaterial({ map: dTex, alphaTest: .5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
dMat.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aCell;').replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_UV\nvUv = vUv * .5 + aCell;\n#endif'); };
dMat.customProgramCacheKey = () => 'hxgore';
const dMesh = new THREE.InstancedMesh(dGeo, dMat, MAXD); dMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXD * 3), 3);
dMesh.count = 0; dMesh.frustumCulled = false; X.scene.add(dMesh); let dI = 0;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function stain(x, z, size, stretch, ang, dark) {
  const y = X.terrainH(x, z) + .03 + (dI % 7) * .002; _e.set(0, ang, 0); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(size, 1, size * stretch); _m.compose(_p, _q, _s);
  dMesh.setMatrixAt(dI, _m); const k = dark ? rr(.28, .4) : rr(.42, .62); dMesh.instanceColor.setXYZ(dI, k, k * rr(.02, .08), k * rr(.03, .07));
  dCell.setXY(dI, (R() * 2 | 0) * .5, (R() * 2 | 0) * .5);
  dI = (dI + 1) % MAXD; dMesh.count = Math.min(MAXD, dMesh.count + 1); dMesh.instanceMatrix.needsUpdate = true; dMesh.instanceColor.needsUpdate = true; dCell.needsUpdate = true;
}

// ------------------------------------------------------------------ sound: a dull thump and a wet crunch (noise), made on the spot
let AC = null, NB = null;
function noise() { if (!NB) { NB = AC.createBuffer(1, AC.sampleRate, AC.sampleRate); const d = NB.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = R() * 2 - 1; } const n = AC.createBufferSource(); n.buffer = NB; return n; }
function squish(t, f0, f1, dur, q, vol) { // a band of noise sliding down: the wet part
  const n = noise(), f = AC.createBiquadFilter(), g = AC.createGain(); f.type = 'bandpass'; f.Q.value = q; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + .008); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  n.connect(f).connect(g).connect(AC.destination); n.start(t, R() * .5, dur + .05); }
function splat(k) { // Runde 153: a squelchy burst instead of a thump - a wet splash sliding down, a soft low body and a few drips
  try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); const t = AC.currentTime + .005, v = Math.min(1, .45 + .35 * k);
    squish(t, rr(2200, 3200), rr(250, 420), rr(.22, .32), rr(2.5, 4), .9 * v);
    squish(t + rr(.01, .03), rr(900, 1300), rr(120, 200), rr(.18, .26), rr(1.2, 2), .7 * v);
    const o = AC.createOscillator(), g = AC.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(rr(75, 95), t); o.frequency.exponentialRampToValueAtTime(38, t + .12);
    g.gain.setValueAtTime(.35 * v, t); g.gain.exponentialRampToValueAtTime(.0001, t + .14); o.connect(g).connect(AC.destination); o.start(t); o.stop(t + .16);
    for (let i = 0, nd = 3 + (R() * 5 | 0); i < nd; i++) squish(t + rr(.08, .55), rr(1400, 2600), rr(500, 900), rr(.03, .07), rr(5, 9), rr(.12, .3) * v); // drips and bits landing
  } catch (e) { } }

// ------------------------------------------------------------------ the burst
const colCache = new Map();
function coloursOf(p) { // the pedestrian's own colours: sampled from its baked figure
  const S = window.HXPASS; let c = colCache.get(p.var); if (c) return c; c = [];
  const m = S && S.meshes[p.var] && S.meshes[p.var][0]; const a = m && m.geometry.attributes.color;
  if (a) for (let i = 0; i < 40; i++) { const j = (R() * a.count) | 0; c.push([a.getX(j), a.getY(j), a.getZ(j)]); }
  if (!c.length) c.push([.6, .5, .4]); colCache.set(p.var, c); return c;
}
let tireBlood = 0, tireAcc = 0;
function burst(p, vx, vz, sp) {
  const k = Math.max(.45, Math.min(1.6, sp / 18)), cols = coloursOf(p), y0 = p.y, h = Math.atan2(vx, vz);
  const nC = Math.round(12 + R() * 10 + k * 12), big = 1 + (R() * 3 | 0); // pieces: flesh and cloth as splats that fly, bounce and lie a while
  for (let i = 0; i < nC; i++) { if (SP.length >= MAXS) SP.shift();
    const flesh = R() < .4, c = flesh ? [rr(.45, .7), rr(.03, .1), rr(.04, .1)] : cols[(R() * cols.length) | 0], spread = rr(1.5, 5) * k, a = R() * 6.283;
    SP.push({ x: p.x + rr(-.2, .2), y: y0 + rr(.3, 1.6), z: p.z + rr(-.2, .2), vx: vx * rr(.45, 1.15) + Math.cos(a) * spread, vy: rr(1.5, 6.5) * k, vz: vz * rr(.45, 1.15) + Math.sin(a) * spread,
      s: i < big ? rr(.26, .36) : rr(.1, .22), grow: 0, r: c[0], g: c[1], b: c[2], life: 0, max: rr(22, 34), mist: false, piece: true, rest: false, stain: true }); }
  const nS = Math.round(70 + 110 * k * rr(.7, 1.2));
  for (let i = 0; i < nS; i++) { if (SP.length >= MAXS) SP.shift(); const a = R() * 6.283, spread = rr(.5, 6) * k, dk = rr(.55, 1);
    SP.push({ x: p.x + rr(-.25, .25), y: y0 + rr(.4, 1.5), z: p.z + rr(-.25, .25), vx: vx * rr(.3, 1.1) + Math.cos(a) * spread, vy: rr(.5, 7) * k, vz: vz * rr(.3, 1.1) + Math.sin(a) * spread,
      s: rr(.05, .13), grow: 0, r: .62 * dk, g: .04 * dk, b: .05 * dk, life: 0, max: rr(.8, 2.2), mist: false }); }
  for (let i = 0; i < 5; i++) { if (SP.length >= MAXS) SP.shift(); // a short red burst where it hit
    SP.push({ x: p.x + rr(-.4, .4), y: y0 + rr(.6, 1.3), z: p.z + rr(-.4, .4), vx: vx * .25 + rr(-1, 1), vy: rr(.2, 1.2), vz: vz * .25 + rr(-1, 1), s: rr(.3, .6), grow: rr(2.2, 3.6), r: .55, g: .03, b: .04, life: 0, max: rr(.35, .6), mist: true }); }
  stain(p.x, p.z, rr(1.4, 2.4) * Math.min(1.3, k + .3), 1, R() * 6.283, true); // pool
  const sl = rr(2, 5) * Math.min(1.4, k); stain(p.x + Math.sin(h) * sl * .5, p.z + Math.cos(h) * sl * .5, rr(.8, 1.3), sl / 1.1, h, false); // smear along the car
  tireBlood = rr(25, 45); splat(k);
}

// ------------------------------------------------------------------ hits: the car's box against the pedestrians
function hits() {
  const S = window.HXPASS, D = X.DRV, V = X.DV; if (!S || !D.on || !D.car || !S.list.length) return;
  const sp = Math.hypot(V.vx, V.vz); if (sp < 3.5) return;
  const fx = Math.sin(V.h), fz = Math.cos(V.h), rx = Math.cos(V.h), rz = -Math.sin(V.h), L = D.car.len / 2 + .35, W = 1.25;
  for (let i = S.list.length - 1; i >= 0; i--) { const p = S.list[i], dx = p.x - V.x, dz = p.z - V.z; if (dx * dx + dz * dz > 40) continue;
    if (Math.abs(dx * fx + dz * fz) < L && Math.abs(dx * rx + dz * rz) < W && Math.abs(p.y - V.y) < 2) { S.list.splice(i, 1); burst(p, V.vx, V.vz, sp); if (hunted === p) hunted = null; G.count = (G.count || 0) + 1; } }
}

// ------------------------------------------------------------------ autopilot: a pedestrian ahead near the route becomes the target
let hunted = null, huntT = 0;
G.huntTarget = (Rt, idx, n) => {
  if (!G.on || !G.hunt) return null; const S = window.HXPASS, V = X.DV; if (!S) return null;
  const fx = Math.sin(V.h), fz = Math.cos(V.h), rx = Math.cos(V.h), rz = -Math.sin(V.h);
  if (hunted) { const dx = hunted.x - V.x, dz = hunted.z - V.z, al = dx * fx + dz * fz; if (S.list.indexOf(hunted) < 0 || al < -1 || al > 45 || (huntT += 1 / 60) > 8) hunted = null; else return hunted; }
  let best = null, bd = 1e9;
  for (const p of S.list) { const dx = p.x - V.x, dz = p.z - V.z, al = dx * fx + dz * fz, la = Math.abs(dx * rx + dz * rz); if (al < 6 || al > 38 || la > al * .55) continue;
    let near = 1e9; for (let k = idx; k < Math.min(n, idx + 50); k++) { const d = (Rt[k * 2] - p.x) ** 2 + (Rt[k * 2 + 1] - p.z) ** 2; if (d < near) near = d; } // close to the route: it fits the way
    if (near > 81 || X.buildingAt((p.x + V.x) / 2, (p.z + V.z) / 2)) continue;
    if (al < bd) { bd = al; best = p; } }
  if (best) { hunted = best; huntT = 0; } return best;
};

// ------------------------------------------------------------------ per frame
const col = new THREE.Color();
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop); const dt = Math.min(.05, (now - last) / 1000); last = now;
  if (G.on) hits();
  // bloody tyres after a hit: marks behind the rear wheels, thinning out
  const D = X.DRV, V = X.DV;
  if (tireBlood > 0 && D.on && D.car) { const d = Math.hypot(V.vx, V.vz) * dt; tireBlood -= d; tireAcc += d;
    if (tireAcc > .45) { tireAcc = 0; const fx = Math.sin(V.h), fz = Math.cos(V.h), rx = Math.cos(V.h), rz = -Math.sin(V.h), L = D.car.len * .32;
      for (const sd of [-1, 1]) if (R() < tireBlood / 30) stain(V.x - fx * L + rx * .75 * sd, V.z - fz * L + rz * .75 * sd, .28, 2.2, V.h, false); } }
  if (!SP.length) { if (sGeo.instanceCount) sGeo.instanceCount = 0; return; }
  // splats
  let m = 0;
  for (let i = SP.length - 1; i >= 0; i--) { const s = SP[i]; s.life += dt;
    if (s.mist) { s.s += s.grow * dt; s.vy *= .9; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; }
    else if (s.piece) { if (!s.rest) { s.vy -= 20 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; const gy = X.terrainH(s.x, s.z) + s.s * .45;
        if (s.y < gy) { s.y = gy; if (s.stain && Math.abs(s.vy) > 3) { stain(s.x, s.z, rr(.3, .7), rr(1, 1.8), Math.atan2(s.vx, s.vz), false); s.stain = R() < .4; }
          s.vy = -s.vy * .28; s.vx *= .5; s.vz *= .5; if (Math.abs(s.vy) < .6 && s.vx * s.vx + s.vz * s.vz < .3) s.rest = true; } } } // lying pieces cost nothing but their draw
    else { s.vy -= 20 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      const gy = X.terrainH(s.x, s.z); if (s.y < gy + .02) { if (R() < .12) stain(s.x, s.z, rr(.14, .4), rr(1, 2.2), Math.atan2(s.vx, s.vz), false); SP.splice(i, 1); continue; } }
    if (s.life > s.max) { SP.splice(i, 1); continue; } }
  for (const s of SP) { sPos.setXYZ(m, s.x, s.y, s.z); sCol.setXYZ(m, s.r, s.g, s.b); sSA.setXY(m, s.s, s.mist ? Math.max(0, 1 - s.life / s.max) * .9 : s.piece ? Math.min(1, (s.max - s.life) / 2) : 1); m++; }
  sGeo.instanceCount = m; sPos.needsUpdate = sCol.needsUpdate = sSA.needsUpdate = true;
  sU.uDim.value = 1 - .55 * (X.night || 0);
}
requestAnimationFrame(loop);

// ------------------------------------------------------------------ settings
const tG = document.getElementById('tGore'), tA = document.getElementById('tGoreAuto'), bC = document.getElementById('bGoreClear');
function ui() { if (tG) tG.checked = G.on; if (tA) { tA.checked = G.hunt; tA.disabled = !G.on; } }
if (tG) tG.addEventListener('change', () => { G.on = tG.checked; if (!G.on) hunted = null; try { localStorage.setItem('hx.gore', G.on); } catch (e) { } ui(); });
if (tA) tA.addEventListener('change', () => { G.hunt = tA.checked; hunted = null; try { localStorage.setItem('hx.goreAuto', G.hunt); } catch (e) { } });
if (bC) bC.addEventListener('click', () => { SP.length = 0; dMesh.count = 0; dI = 0; tireBlood = 0; });
ui();
G.burst = burst; G.stats = () => ({ pieces: SP.filter(s => s.piece).length, splats: SP.length, stains: dMesh.count, hits: G.count || 0 });
window.HXGORE = G;
})();
