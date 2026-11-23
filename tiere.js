/* HoodExplorer – animals, phase 1 (Runde 82): pigeons, gulls, fish, rats, cats.
   Sprites: daten/tiere.png (one colour-index byte per pixel, 0 = transparent) + daten/tiere.json (sheets, palettes), made by
   werkzeuge/tier_fabrik.py (Blender, rigged-by-code models with gait cycles) and werkzeuge/tier_atlas.py. Per sheet: rows = views
   0 right, 1 away-right, 2 away, 6 towards, 7 towards-right (3, 4, 5 are drawn mirrored), columns = frames (0-5 gait, 6-7 idle).
   Habitats from the map data only (general rules): squares/pedestrian zones -> pigeons, shores of big water -> gulls, water -> fish,
   wheelie bins and house walls at night -> rats, house fronts along small streets and parked car roofs -> cats.
   Animals live only around the player (like the traffic), one instanced draw call for all of them. */
const X2 = window.HXTR;
const TI = { on: true, meta: null, mesh: null, list: [], t: 0, spawnT: 0, max: matchMedia('(pointer:coarse)').matches ? 36 : 72, ms: 0, msN: 0, msAvg: 0, wind: 2.3 };
try { if (localStorage.getItem('hx.tiere') === 'false') TI.on = false; } catch (e) {}
if (/[?&]tiere=0/.test(location.search)) TI.on = false;
const TI_R = 95, TI_KILL = 135, TI_MAXI = 160;
const tR = Math.random, tHyp = Math.hypot, tClamp = (v, a, b) => Math.max(a, Math.min(b, v)), tPick = a => a[(tR() * a.length) | 0];

(async () => { // load the atlas: index bytes -> luminance texture, palettes -> 16 x n texture
  try {
    const meta = await (await fetch('daten/tiere.json?v=438')).json();
    // the bytes are colour indices, not colours: no colour management, no premultiplied alpha
    const img = await createImageBitmap(await (await fetch('daten/tiere.png?v=441')).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const PW = meta.w / (meta.packed || 1); // texture width: two pixels per byte
    const cv = document.createElement('canvas'); cv.width = PW; cv.height = meta.h; const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const rgba = g.getImageData(0, 0, PW, meta.h).data, idx = new Uint8Array(PW * meta.h); for (let i = 0; i < idx.length; i++) idx[i] = rgba[i * 4];
    const names = Object.keys(meta.sheets), rows = names.length, pal = new Uint8Array(16 * rows * 4);
    for (const n of names) { const s = meta.sheets[n]; s.pal.forEach((c, i) => pal.set([c[0], c[1], c[2], 255], (s.row * 16 + i + 1) * 4)); }
    const at = new THREE.DataTexture(idx, PW, meta.h, THREE.LuminanceFormat, THREE.UnsignedByteType); at.magFilter = at.minFilter = THREE.NearestFilter; at.needsUpdate = true;
    const pt = new THREE.DataTexture(pal, 16, rows, THREE.RGBAFormat, THREE.UnsignedByteType); pt.magFilter = pt.minFilter = THREE.NearestFilter; pt.needsUpdate = true;
    meta.rows = rows; TI.meta = meta; tiMakeMesh(at, pt);
    const el = document.getElementById('tTiere'); if (el) { el.checked = TI.on; el.addEventListener('change', e => { TI.on = e.target.checked; try { localStorage.setItem('hx.tiere', TI.on); } catch (x) {} if (!TI.on) TI.list = []; }); }
  } catch (e) { console.error('Tiere: Atlas nicht geladen', e); }
})();

function tiMakeMesh(atlas, pal) {
  const q = new THREE.PlaneGeometry(1, 1); q.translate(0, .5, 0);
  const g = new THREE.InstancedBufferGeometry(); g.setIndex(q.index); g.setAttribute('position', q.getAttribute('position'));
  const mk = n => { const a = new THREE.InstancedBufferAttribute(new Float32Array(TI_MAXI * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  g.setAttribute('iP', mk(4)); g.setAttribute('iS', mk(4)); g.setAttribute('iC', mk(4)); g.setAttribute('iE', mk(4)); g.instanceCount = 0;
  const U = spriteUniforms; // shared with the trees and props: camera right/up, light, fog
  const mat = new THREE.ShaderMaterial({ transparent: true, side: THREE.DoubleSide,
    uniforms: { uAtlas: { value: atlas }, uPal: { value: pal }, uAt: { value: new THREE.Vector2(TI.meta.w, TI.meta.h) }, uRows: { value: TI.meta.rows },
      uRight: U.uRight, uUp: U.uUp, uLight: U.uLight, uFogColor: U.uFogColor, uFogDensity: U.uFogDensity },
    vertexShader: `
      attribute vec4 iP, iS, iC, iE; // iP: x, y, z, -; iS: width, height, foot, alpha; iC: cell x, y, w, h (atlas px); iE: mirror, palette row, water tint, -
      uniform vec3 uRight, uUp; uniform vec2 uAt;
      varying vec2 vUv; varying float vRow, vA, vTint, vFog;
      void main() {
        float h = position.y; float u = position.x + 0.5;
        vec3 p = iP.xyz + uRight * (position.x * iS.x) + vec3(0.0, (h - iS.z) * iS.y, 0.0) + (uUp - vec3(0.0, 1.0, 0.0)) * (h * h * iS.y);
        vec4 mv = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; vFog = -mv.z;
        float cu = iE.x > 0.5 ? 1.0 - u : u;
        vUv = vec2((iC.x + cu * iC.z) / uAt.x, (iC.y + (1.0 - h) * iC.w) / uAt.y);
        vRow = iE.y; vA = iS.w; vTint = iE.z;
      }`,
    fragmentShader: `
      uniform sampler2D uAtlas, uPal; uniform float uRows, uFogDensity; uniform vec3 uLight, uFogColor; uniform vec2 uAt;
      varying vec2 vUv; varying float vRow, vA, vTint, vFog;
      void main() {
        float px = floor(vUv.x * uAt.x), tx = floor(px * 0.5);                      // 4-bit atlas: two pixels per byte
        float b = floor(texture2D(uAtlas, vec2((tx + 0.5) / (uAt.x * 0.5), vUv.y)).r * 255.0 + 0.5);
        float i = mod(px, 2.0) < 0.5 ? floor(b / 16.0) : mod(b, 16.0); if (i < 0.5) discard;
        vec3 c = texture2D(uPal, vec2((i + 0.5) / 16.0, (vRow + 0.5) / uRows)).rgb;
        c *= uLight;
        c = mix(c, vec3(0.16, 0.3, 0.36) * uLight, vTint);              // fish under water
        float f = 1.0 - exp(-uFogDensity * uFogDensity * vFog * vFog); c = mix(c, uFogColor, clamp(f, 0.0, 1.0));
        gl_FragColor = vec4(c, vA);
      }` });
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 2; X2.scene.add(m); TI.mesh = m;
}

/* ---------------- habitat search (map data only) ---------------- */
function tiTilesNear(px, pz, r) { const out = []; for (const t of X2.tiles.values()) out.push(t); return out; }
function tiWaterFrac(x, z, r) { let n = 0; for (let k = 0; k < 12; k++) { const a = k / 12 * 6.283; if (X2.waterAt(x + Math.cos(a) * r, z + Math.sin(a) * r)) n++; } return n / 12; }
function tiRandomNear(px, pz, r0, r1) { const a = tR() * 6.283, d = r0 + tR() * (r1 - r0); return [px + Math.cos(a) * d, pz + Math.sin(a) * d]; }
// drivable roads (not pedestrian zones): in 8 m cells, rebuilt when tiles change - animals do not land or appear on the carriageway (Runde 86)
const TI_RD = { ver: -1, g: new Map() };
function tiOnRoad(x, z) { if (TI_RD.ver !== X2.TILEVER) { TI_RD.ver = X2.TILEVER; TI_RD.g.clear(); for (const t of X2.tiles.values()) for (const r of t.roads || []) { if (r.k !== 'm' && r.k !== 't') continue; const p = r.p, hw = r.w / 2 + .5;
      for (let i = 0; i + 3 < p.length; i += 2) { const sg = [p[i], p[i + 1], p[i + 2], p[i + 3], hw]; for (let ix = Math.floor((Math.min(p[i], p[i + 2]) - hw) / 8); ix <= Math.floor((Math.max(p[i], p[i + 2]) + hw) / 8); ix++) for (let iz = Math.floor((Math.min(p[i + 1], p[i + 3]) - hw) / 8); iz <= Math.floor((Math.max(p[i + 1], p[i + 3]) + hw) / 8); iz++) { const k = ix * 100003 + iz; let l = TI_RD.g.get(k); if (!l) TI_RD.g.set(k, l = []); l.push(sg); } } } }
  const l = TI_RD.g.get(Math.floor(x / 8) * 100003 + Math.floor(z / 8)); if (!l) return false;
  for (const s of l) { const ex = s[2] - s[0], ez = s[3] - s[1], L2 = ex * ex + ez * ez || 1, u = Math.max(0, Math.min(1, ((x - s[0]) * ex + (z - s[1]) * ez) / L2)); if (Math.hypot(s[0] + ex * u - x, s[1] + ez * u - z) < s[4]) return true; } return false; }
function tiFree(x, z) { return !X2.buildingAt(x, z) && !X2.waterAt(x, z) && !tiOnRoad(x, z); }
function tiPlazaPoint(px, pz) { // a point on a square or in a pedestrian street within reach
  const cands = [];
  for (const t of X2.tiles.values()) { for (const a of t.areas || []) if (a.k === 'p') { const r = a.rings[0]; let cx = 0, cz = 0; for (let i = 0; i < r.length; i += 2) { cx += r[i]; cz += r[i + 1]; } cx /= r.length / 2; cz /= r.length / 2; const d = tHyp(cx - px, cz - pz); if (d < TI_R + 40) cands.push({ r, d }); }
    for (const rd of t.roads || []) if (rd.k === 'p' && rd.w >= 4.5) { const p = rd.p, i = 2 * ((tR() * p.length / 2) | 0), d = tHyp(p[i] - px, p[i + 1] - pz); if (d < TI_R && d > 20) cands.push({ line: rd, x: p[i], z: p[i + 1], d }); } }
  for (let k = 0; k < 6 && cands.length; k++) { const c = tPick(cands);
    if (c.line) { if (tiFree(c.x, c.z)) return [c.x, c.z, null]; continue; }
    const r = c.r; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); z0 = Math.min(z0, r[i + 1]); z1 = Math.max(z1, r[i + 1]); }
    for (let j = 0; j < 8; j++) { const x = x0 + tR() * (x1 - x0), z = z0 + tR() * (z1 - z0), d = tHyp(x - px, z - pz); if (d > 18 && d < TI_R && X2.inPoly(x, z, r) && tiFree(x, z)) return [x, z, r]; } }
  return null; }
function tiShorePoint(px, pz) { for (let k = 0; k < 10; k++) { const [x, z] = tiRandomNear(px, pz, 20, TI_R); if (!tiFree(x, z)) continue; let w = -1;
    for (let j = 0; j < 8; j++) { const a = j / 8 * 6.283; if (X2.waterAt(x + Math.cos(a) * 6, z + Math.sin(a) * 6)) { w = a; break; } }
    if (w < 0) continue; if (tiWaterFrac(x + Math.cos(w) * 30, z + Math.sin(w) * 30, 25) < .6) continue; // only big water: lakes, rivers, the sea
    return [x, z, w]; } return null; }
function tiFishW(x, z) { return X2.waterAt(x, z) && !(X2.inPool && X2.inPool(x, z)); } /* Runde 262: fish never swim into a pool */
function tiWaterPoint(px, pz) { for (let k = 0; k < 12; k++) { const [x, z] = tiRandomNear(px, pz, 8, TI_R); if (!X2.waterAt(x, z) || (X2.inPool && X2.inPool(x, z))) continue; /* Runde 259: no fish in pools */ if (tiWaterFrac(x, z, 3) < 1) continue; return [x, z, tiWaterFrac(x, z, 25)]; } return null; }
function tiWallPoint(px, pz, nearBins) { // a point right beside a house wall (rats: along the walls; cats: in front of the houses)
  if (nearBins) { const bins = []; for (const b of X2.BINS.values()) for (let i = 0; i < b.length; i += 2) { const d = tHyp(b[i] - px, b[i + 1] - pz); if (d > 15 && d < TI_R) bins.push([b[i], b[i + 1]]); } if (bins.length && tR() < .7) { const b = tPick(bins); return [b[0] + (tR() - .5) * 2, b[1] + (tR() - .5) * 2]; } }
  for (let k = 0; k < 14; k++) { const [x, z] = tiRandomNear(px, pz, 15, TI_R); if (!tiFree(x, z)) continue;
    for (let j = 0; j < 8; j++) { const a = j / 8 * 6.283; if (X2.buildingAt(x + Math.cos(a) * 2.5, z + Math.sin(a) * 2.5)) return [x, z, a]; } } return null; }
function tiCarRoof(px, pz) { if (typeof carTiles === 'undefined') return null; const c = [];
  for (const a of carTiles.values()) for (let i = 0; i < a.length; i += 6) { const t = a[i + 3] | 0; if (t > 6) continue; const d = tHyp(a[i] - px, a[i + 1] - pz); if (d > 15 && d < 70) c.push([a[i], a[i + 1], a[i + 2], t]); }
  return c.length ? tPick(c) : null; }

/* ---------------- spawning: groups, each with its own rules ---------------- */
function tiAdd(o) { o.vx = o.vx || 0; o.vz = o.vz || 0; o.v = o.v || 0; o.f = 6; o.dist = 0; o.seed = tR() * 9; o.h = o.h || 0; o.y = o.y || 0; o.st = o.st || 0; o.t = 0; TI.list.push(o); return o; }
function tiCount(kind) { let n = 0; for (const o of TI.list) if (o.kind === kind) n++; return n; }
function tiSpawn(px, pz) {
  const night = X2.night, roll = tR();
  if (roll < .3 && tiCount('taube') < 30 && night < .6) { const p = tiPlazaPoint(px, pz); if (p) { const n = 5 + (tR() * 8 | 0), gid = tR();
      for (let i = 0; i < n; i++) { const x = p[0] + (tR() - .5) * 3, z = p[1] + (tR() - .5) * 3; if (!tiFree(x, z)) continue; tiAdd({ kind: 'taube', sp: tPick(['taube_grau', 'taube_grau', 'taube_grau', 'taube_weiss', 'taube_braun']), x, z, g: gid, poly: p[2] }); } return; } }
  if (roll < .5 && tiCount('moewe') < 16) { const p = tiShorePoint(px, pz); if (p) { const n = 3 + (tR() * 6 | 0), gid = tR();
      for (let i = 0; i < n; i++) { const x = p[0] + (tR() - .5) * 5, z = p[1] + (tR() - .5) * 5; if (!tiFree(x, z)) continue; tiAdd({ kind: 'moewe', sp: tPick(['moewe_silber', 'moewe_silber', 'moewe_lach', 'moewe_sturm']), x, z, g: gid, wdir: p[2] }); }
      for (let i = 0; i < 2; i++) { const cx = p[0] + Math.cos(p[2]) * 25, cz = p[1] + Math.sin(p[2]) * 25; tiAdd({ kind: 'moewe', sp: tPick(['moewe_silber', 'moewe_lach', 'moewe_sturm']), x: cx, z: cz, st: 2, h: 9 + tR() * 6, cx, cz, r: 8 + tR() * 8, ang: tR() * 6.28, g: gid }); }
      return; } }
  if (roll < .72 && tiCount('fisch') < 26) { const p = tiWaterPoint(px, pz); if (p) { const big = p[2] > .7, r2 = tR(), gid = tR();
      const [sp, n] = !big ? (r2 < .5 ? ['fisch_goldfisch', 3 + (tR() * 4 | 0)] : ['fisch_karpfen', 2 + (tR() * 3 | 0)]) : r2 < .5 ? ['fisch_barsch', 8 + (tR() * 8 | 0)] : r2 < .75 ? ['fisch_karpfen', 3 + (tR() * 3 | 0)] : r2 < .9 ? ['fisch_forelle', 2 + (tR() * 3 | 0)] : ['fisch_hecht', 1];
      for (let i = 0; i < n; i++) { const x = p[0] + (tR() - .5) * 2.5, z = p[1] + (tR() - .5) * 2.5; if (!X2.waterAt(x, z)) continue; tiAdd({ kind: 'fisch', sp, x, z, g: gid, vx: (tR() - .5) * .6, vz: (tR() - .5) * .6, ph: tR(), d: tR() }); } return; } }
  if (roll < .86 && night > .3 && tiCount('ratte') < 6) { const p = tiWallPoint(px, pz, true); if (p) { const n = 1 + (tR() < .4 ? 1 : 0);
      for (let i = 0; i < n; i++) tiAdd({ kind: 'ratte', sp: tR() < .75 ? 'ratte_wander' : 'ratte_haus', x: p[0] + (tR() - .5), z: p[1] + (tR() - .5), hx: p[0], hz: p[1] }); return; } }
  if (tiCount('katze') < 5) { const sp = tPick(['katze_getigert', 'katze_getigert', 'katze_schwarz', 'katze_grau', 'katze_weiss', 'katze_dreifarbig', 'katze_siam']);
    if (tR() < .3) { const c = tiCarRoof(px, pz); if (c) { const roof = [1.45, 1.42, 1.38, 1.4, 1.65, 2.0, 1.38][c[3]] || 1.45; tiAdd({ kind: 'katze', sp, x: c[0], z: c[1], st: 3, roof, v: (tR() * 8) | 0 }); return; } }
    const p = tiWallPoint(px, pz, false); if (p) tiAdd({ kind: 'katze', sp, x: p[0], z: p[1], hx: p[0], hz: p[1], v: (tR() * 8) | 0 }); }
}

/* ---------------- behaviour ---------------- */
function tiSteer(o, tx, tz, sp, k, dt) { const dx = tx - o.x, dz = tz - o.z, d = tHyp(dx, dz) || 1; o.vx += (dx / d * sp - o.vx) * Math.min(1, k * dt); o.vz += (dz / d * sp - o.vz) * Math.min(1, k * dt); }
function tiMove(o, dt, cyc, ok) { const nx = o.x + o.vx * dt, nz = o.z + o.vz * dt; if (ok && !ok(nx, nz)) { o.vx *= -.5; o.vz *= -.5; o.blocked = 1; return; } o.x = nx; o.z = nz;
  const s = tHyp(o.vx, o.vz); o.dist += s * dt; if (s > .06) { o.dir = Math.atan2(o.vz, o.vx); o.f = Math.floor(o.dist / cyc * 6) % 6; } else o.f = 6 + (Math.floor((TI.t + o.seed) / .7) % 2); }
function tiThreat(o) { // player on foot or in a car; a moving car scares from farther away
  const P = X2.P, DRV = X2.DRV, DV = X2.DV; if (DRV.on) { const sp = tHyp(DV.vx || 0, DV.vz || 0); return [DV.x, DV.z, sp > 2 ? 2.5 : 1]; } return [P.x, P.z, P.speed > 3 ? 1.6 : 1]; }
function tiUpdate(dt) {
  const [tx, tz, scare] = tiThreat(TI.list[0] || {}), L = TI.list;
  for (const o of L) { o.t += dt; const dP = tHyp(o.x - tx, o.z - tz) / scare;
    if (o.kind === 'taube' || (o.kind === 'moewe')) {
      const gull = o.kind === 'moewe', shy = gull ? (o.sp === 'moewe_lach' ? 3 : 2.2) : 3;
      if (o.st === 0) {
        if (dP < shy && !o.al) o.al = TI.t;
        if (!gull) for (const q of L) if (q !== o && q.g === o.g && q.st === 1 && TI.t - q.up < .6 && !o.al && tHyp(q.x - o.x, q.z - o.z) < 4) o.al = TI.t + tR() * .3; // alarm spreads through the flock
        if (gull && !o.al) for (const q of L) if (q !== o && q.st === 1 && TI.t - q.up < .3 && tHyp(q.x - o.x, q.z - o.z) < 1.3 && tR() < dt * 2) o.al = TI.t;
        if (o.al && TI.t >= o.al) { o.al = 0; o.st = 1; o.up = TI.t;
          const lead = L.find(q => q !== o && q.g === o.g && q.st === 1 && TI.t - q.up < 1.5);
          if (gull) { o.cx = o.x + (o.x - tx) * .6; o.cz = o.z + (o.z - tz) * .6; o.r = 4 + tR() * 3; o.ang = Math.atan2(o.z - o.cz, o.x - o.cx); }
          else if (lead) { o.tx = lead.tx + (tR() - .5) * 3; o.tz = lead.tz + (tR() - .5) * 3; }
          else { let best = null, bd = -1; for (let k = 0; k < 24; k++) { const a = tR() * 6.283, d = 12 + tR() * 18, x = o.x + Math.cos(a) * d, z = o.z + Math.sin(a) * d;
              if (!tiFree(x, z) || (o.poly && !X2.inPoly(x, z, o.poly) && k < 18)) continue; const s = tHyp(x - tx, z - tz); if (s > bd) { bd = s; best = [x, z]; } }
            if (!best) best = [o.x + (o.x - tx), o.z + (o.z - tz)]; o.tx = best[0]; o.tz = best[1]; } continue; }
        // on the ground: pigeons keep together and peck, gulls face the wind and stand about
        let cx = 0, cz = 0, n = 0, sx = 0, sz = 0;
        for (const q of L) { if (q === o || q.g !== o.g || q.st) continue; const dx = q.x - o.x, dz = q.z - o.z, d = tHyp(dx, dz); if (d < 4) { cx += q.x; cz += q.z; n++; } if (d < (gull ? .9 : .5) && d > 0) { sx -= dx / d; sz -= dz / d; } }
        o.wt = (o.wt || 0) - dt; if (o.wt < 0) { o.wt = 1 + tR() * (gull ? 5 : 3); const a = tR() * 6.28, sp = gull ? .45 : .4; o.wx = Math.cos(a) * sp; o.wz = Math.sin(a) * sp; if (tR() < (gull ? .65 : .4)) o.wx = o.wz = 0; }
        let vx = o.wx || 0, vz = o.wz || 0; if (n) { vx += (cx / n - o.x) * .07; vz += (cz / n - o.z) * .07; } vx += sx * .5; vz += sz * .5;
        if (dP < shy * 1.6) { vx += (o.x - tx) / (dP || 1) * .4; vz += (o.z - tz) / (dP || 1) * .4; }
        o.vx += (vx - o.vx) * Math.min(1, 3 * dt); o.vz += (vz - o.vz) * Math.min(1, 3 * dt);
        tiMove(o, dt, gull ? .5 : .22, tiFree); if (gull && tHyp(o.vx, o.vz) < .06 && o.wdir !== undefined) o.dir = o.wdir + Math.PI; // standing: head into the wind (it blows from the water)
        o.y = X2.terrainH(o.x, o.z);
      } else if (o.st === 1) { // flying: pigeons to their landing place, gulls one circle and back down nearby
        if (gull) { o.ang += dt * 1.1; const x = o.cx + Math.cos(o.ang) * o.r, z = o.cz + Math.sin(o.ang) * o.r; o.vx = (x - o.x) / dt; o.vz = (z - o.z) / dt; o.x = x; o.z = z;
          const up = TI.t - o.up; o.h += ((up < 3.5 ? 3.5 : 0) - o.h) * Math.min(1, 1.4 * dt); o.dir = Math.atan2(o.vz, o.vx);
          o.f = up < 1.2 || (TI.t + o.seed) % 4 < .8 ? Math.floor(TI.t * 8 + o.seed * 6) % 6 : 0;
          if (up > 4.5 && o.h < .25) { if (tiFree(o.x, o.z)) { o.st = 0; o.h = 0; o.vx = o.vz = 0; } else o.up = TI.t - 2; } }
        else { const d = tHyp(o.tx - o.x, o.tz - o.z); tiSteer(o, o.tx, o.tz, Math.min(7, 1 + d * 1.2), 2.5, dt);
          let ax = 0, az = 0, an = 0; for (const q of L) if (q !== o && q.g === o.g && q.st === 1 && tHyp(q.x - o.x, q.z - o.z) < 2.5) { ax += q.vx; az += q.vz; an++; }
          if (an) { o.vx += (ax / an - o.vx) * Math.min(1, dt); o.vz += (az / an - o.vz) * Math.min(1, dt); } const s = tHyp(o.vx, o.vz); if (s > 7) { o.vx *= 7 / s; o.vz *= 7 / s; }
          o.x += o.vx * dt; o.z += o.vz * dt; o.h += ((d > 3 ? 4 : d * 1.2) - o.h) * Math.min(1, 3 * dt); o.dir = Math.atan2(o.vz, o.vx); o.f = Math.floor(TI.t * 14 + o.seed * 6) % 6;
          if (d < .4 && o.h < .3) { o.st = 0; o.h = 0; o.vx = o.vz = 0; o.wt = 1; } }
        o.y = X2.terrainH(o.x, o.z) + o.h;
      } else { // gull soaring in a thermal over the water, beats its wings now and then
        o.ang += dt * .35 / Math.max(1, o.r * .12); const x = o.cx + Math.cos(o.ang) * o.r, z = o.cz + Math.sin(o.ang) * o.r * .8; o.vx = (x - o.x) / dt; o.vz = (z - o.z) / dt; o.x = x; o.z = z;
        o.dir = Math.atan2(o.vz, o.vx); o.f = (TI.t + o.seed * 3) % 7 < 1 ? Math.floor(TI.t * 8) % 6 : 0; o.y = X2.terrainH(o.x, o.z) + o.h + Math.sin(TI.t * .4 + o.seed) * 1.5; }
    } else if (o.kind === 'fisch') { // boids within the school, stay in the water, scatter near the player, carp jump now and then
      let ax = 0, az = 0, cx = 0, cz = 0, sx = 0, sz = 0, n = 0;
      for (const q of L) { if (q === o || q.kind !== 'fisch') continue; const dx = q.x - o.x, dz = q.z - o.z, d = tHyp(dx, dz); if (d > 2.6) continue;
        if (d < .6 && d > 0) { sx -= dx / d / d; sz -= dz / d / d; } if (q.fl > 0 && d < 1.6 && !(o.fl > 0)) o.fl = .8 + tR() * .5; if (q.g !== o.g) continue; n++; ax += q.vx; az += q.vz; cx += q.x; cz += q.z; }
      const coh = o.sp === 'fisch_barsch' ? .35 : o.sp === 'fisch_hecht' ? 0 : .1;
      if (n) { o.vx += ((ax / n - o.vx) * .9 + (cx / n - o.x) * coh + sx * .5) * dt; o.vz += ((az / n - o.vz) * .9 + (cz / n - o.z) * coh + sz * .5) * dt; } else { o.vx += sx * .5 * dt; o.vz += sz * .5 * dt; }
      o.vx += (tR() - .5) * .8 * dt; o.vz += (tR() - .5) * .8 * dt;
      if (dP < 4) { o.fl = Math.max(o.fl || 0, .9); o.vx += (o.x - tx) / (dP || 1) * 8 * dt; o.vz += (o.z - tz) / (dP || 1) * 8 * dt; }
      const s0 = tHyp(o.vx, o.vz) || 1, la = 1.2; if (!tiFishW(o.x + o.vx / s0 * la, o.z + o.vz / s0 * la)) { o.vx = -o.vx * .5 + (tR() - .5); o.vz = -o.vz * .5 + (tR() - .5); } // the shore: turn back
      o.fl = (o.fl || 0) - dt; const mx = o.fl > 0 ? 3.5 : o.sp === 'fisch_hecht' ? .4 : o.sp === 'fisch_karpfen' ? .7 : 1.3, mn = o.sp === 'fisch_hecht' ? .05 : .35, s = tHyp(o.vx, o.vz);
      if (s > mx) { o.vx *= mx / s; o.vz *= mx / s; } else if (s < mn) { o.vx *= mn / (s || 1); o.vz *= mn / (s || 1); }
      const nx = o.x + o.vx * dt, nz = o.z + o.vz * dt; if (tiFishW(nx, nz)) { o.x = nx; o.z = nz; }
      o.dir = Math.atan2(o.vz, o.vx); const sp = tHyp(o.vx, o.vz); o.ph = (o.ph + dt * (1 + sp * 2.2)) % 1; o.f = sp > .2 ? Math.floor(o.ph * 6) % 6 : 6 + (Math.floor(TI.t * 1.5 + o.d * 3) % 2);
      if (o.jump === undefined && o.sp === 'fisch_karpfen' && tR() < dt / 40) o.jump = 0;
      const ws = X2.waterSurf(o.x, o.z); o.y = (ws === null || ws === undefined ? X2.terrainH(o.x, o.z) : ws - (X2.waterDepth ? Math.min(.6, X2.waterDepth(o.x, o.z) * .5) : -.03)); /* Runde 264: fish swim below the see-through surface */
      if (o.jump !== undefined) { // Runde 184: every jump splashes - out of the water and back in (wetter.js WX.fishSplash: ring, drops, plip/plop)
        if (o.jump === 0 && window.WX && WX.fishSplash) WX.fishSplash(o.x, o.z, 'plip', o.vx, o.vz);
        o.jump += dt; o.y += Math.sin(Math.min(1, o.jump / 1.1) * Math.PI) * 1.1;
        if (o.jump > 1.1) { o.jump = undefined; if (window.WX && WX.fishSplash) WX.fishSplash(o.x, o.z, 'plop', o.vx, o.vz); if (o.temp) o.gone = 1; } }
    } else if (o.kind === 'ratte') { // along the walls, quick; flee at 6 m and vanish
      if (dP < 6 && o.st !== 2) { o.st = 2; o.t = 0; }
      if (o.st === 2) { tiSteer(o, o.x + (o.x - tx), o.z + (o.z - tz), 4, 6, dt); if (o.t > 2.5) o.gone = 1; }
      else { o.wt = (o.wt || 0) - dt; if (o.wt < 0 || o.blocked) { o.blocked = 0; o.wt = .8 + tR() * 2.5; const a = tR() * 6.28, r = tR() * 4; o.wx = o.hx + Math.cos(a) * r; o.wz = o.hz + Math.sin(a) * r; o.go = tR() < .7; }
        if (o.go && tHyp(o.wx - o.x, o.wz - o.z) > .2) tiSteer(o, o.wx, o.wz, 1.2, 6, dt); else { o.vx = o.vz = 0; } }
      tiMove(o, dt, .3, tiFree); o.y = X2.terrainH(o.x, o.z);
    } else if (o.kind === 'katze') { // sits mostly, strolls now and then; on a car roof it only sits, at 2 m it jumps down and walks off
      if (o.st === 3) { o.vx = o.vz = 0; o.f = 6 + (Math.floor((TI.t + o.seed) / 1.4) % 2); if (dP < 2.2) { o.st = 2; o.t = 0; } o.y = X2.terrainH(o.x, o.z) + o.roof; continue; }
      if (dP < 2.2 && o.st !== 2) { o.st = 2; o.t = 0; }
      if (o.st === 2) { tiSteer(o, o.x + (o.x - tx), o.z + (o.z - tz), 2.2, 5, dt); if (o.t > 2) { o.st = 0; o.hx = o.x; o.hz = o.z; } }
      else { o.wt = (o.wt || 0) - dt; if (o.wt < 0 || o.blocked) { o.blocked = 0; o.wt = 3 + tR() * 6; const a = tR() * 6.28, r = tR() * 5; o.wx = o.hx + Math.cos(a) * r; o.wz = o.hz + Math.sin(a) * r; o.go = tR() < .4; }
        if (o.go && tHyp(o.wx - o.x, o.wz - o.z) > .2) tiSteer(o, o.wx, o.wz, .7, 4, dt); else { o.vx = o.vz = 0; } }
      tiMove(o, dt, .7, tiFree); o.y = X2.terrainH(o.x, o.z);
    }
  }
}

/* ---------------- drawing ---------------- */
const TI_ROW = { 0: [0, 0], 1: [1, 0], 2: [2, 0], 3: [1, 1], 4: [0, 1], 5: [4, 1], 6: [3, 0], 7: [4, 0] }; // view -> stored row, mirrored
function tiDraw() {
  const m = TI.mesh, M = TI.meta; if (!m) return; const g = m.geometry, P4 = g.attributes.iP.array, S4 = g.attributes.iS.array, C4 = g.attributes.iC.array, E4 = g.attributes.iE.array;
  const r = spriteUniforms.uRight.value, rx = r.x, rz = r.z, fx = rz, fz = -rx; // camera right and "away" on the ground
  let n = 0;
  for (const o of TI.list) { if (n >= TI_MAXI) break; const fly = (o.kind === 'taube' || o.kind === 'moewe') && o.st >= 1, sh = M.sheets[o.sp + (fly ? '_flug' : '')]; if (!sh) continue;
    const dx = Math.cos(o.dir || 0), dz = Math.sin(o.dir || 0), a = Math.atan2(dx * fx + dz * fz, dx * rx + dz * rz), v = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8, [row, mir] = TI_ROW[v];
    const f = Math.min(o.f, sh.nf - 1), i = n * 4;
    P4[i] = o.x; P4[i + 1] = o.y; P4[i + 2] = o.z;
    S4[i] = sh.mw; S4[i + 1] = sh.mh; S4[i + 2] = sh.foot; S4[i + 3] = o.kind === 'fisch' && o.jump === undefined ? .8 - (o.d || 0) * .3 : 1;
    C4[i] = sh.x + f * sh.cw; C4[i + 1] = sh.y + row * sh.ch; C4[i + 2] = sh.cw; C4[i + 3] = sh.ch;
    E4[i] = mir; E4[i + 1] = sh.row; E4[i + 2] = o.kind === 'fisch' && o.jump === undefined ? .45 + (o.d || 0) * .25 : 0; n++; }
  g.instanceCount = n; for (const k of ['iP', 'iS', 'iC', 'iE']) { g.attributes[k].needsUpdate = true; g.attributes[k].updateRange.count = n * 4; }
}

function updateTiere(dt) {
  if (!TI.meta) return;
  const P = X2.P; if (!TI.on || !P.placed || X2.PRUEF !== null || X2.ISO !== null) { if (TI.list.length) { TI.list = []; tiDraw(); } return; }
  const t0 = performance.now(); dt = Math.min(dt, .1); TI.t += dt;
  const px = X2.DRV.on ? X2.DV.x : P.x, pz = X2.DRV.on ? X2.DV.z : P.z;
  TI.list = TI.list.filter(o => !o.gone && tHyp(o.x - px, o.z - pz) < TI_KILL);
  TI.spawnT -= dt; if (TI.spawnT < 0 && TI.list.length < TI.max) { TI.spawnT = .35; tiSpawn(px, pz); }
  tiUpdate(dt); tiDraw();
  TI.ms += performance.now() - t0; if (++TI.msN >= 60) { TI.msAvg = TI.ms / TI.msN; TI.ms = 0; TI.msN = 0; }
}
/* Runde 184: a fish that jumps now - the same animated sprite as the swimming ones (carp or perch), leaves after its jump */
TI.jump = (x, z, h) => { if (!TI.list || (X2.inPool && X2.inPool(x, z))) return null; /* Runde 262: no fish jumping in pools */ const o = tiAdd({ kind: 'fisch', sp: tR() < .6 ? 'fisch_karpfen' : 'fisch_barsch', x, z, g: -1 - Math.floor(tR() * 1e6), vx: Math.sin(h) * .7, vz: Math.cos(h) * .7, temp: 1 });
  o.jump = 0; o.d = 0; o.ph = 0; o.fl = 0; return o; };
window.updateTiere = updateTiere; window.TI = TI;
