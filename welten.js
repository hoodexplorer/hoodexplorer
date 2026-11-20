/* HoodExplorer – Weltenwechsler (Runde 93): Heute / Western / Cyberpunk / Mittelalter.
   Der Worker wendet die Regeln der Welt auf die OSM-Karte an und schickt je Kachel eine Liste von Modellen (m.welt:
   {v: Modell, x, y, z, ry, sx, sy, sz, t: Schildtext}). Die Modelle kommen aus Blender (welten/*.glb, gebaut von
   werkzeuge/blender/hx_spiel.py): je Modell ein beleuchteter Körper und optional leuchtende Teile. Hier wird je Modell
   ein InstancedMesh gezeichnet (ein Draw Call pro Modell und Teil). Schilder: ein gemeinsamer Textatlas, je Kachel ein Mesh.
   Umschalten: Optionen → Stimmung → Welt (lädt neu). URL: ?welt=heute|west|cyber|mittel */
(() => {
  const X = window.HXTR, WELT = window.HX_WELT || 'heute';
  const NAMES = { heute: 'Heute', west: 'Western', cyber: 'Cyberpunk', mittel: 'Mittelalter' };
  const MOOD = { heute: null, west: 'mittag', cyber: 'nacht', mittel: 'morgen' };
  // ---- switch in the options sheet
  const seg = document.getElementById('weltSeg');
  if (seg) for (const id in NAMES) {
    const b = document.createElement('button'); b.className = 'pl'; b.type = 'button'; b.textContent = NAMES[id]; b.setAttribute('aria-pressed', id === WELT ? 'true' : 'false');
    b.addEventListener('click', () => {
      if (id === WELT) return;
      try { localStorage.setItem('hx.welt', JSON.stringify(id)); if (MOOD[id]) { localStorage.setItem('hx.mood', JSON.stringify(MOOD[id])); localStorage.setItem('hx.auto', 'false'); } } catch (e) {}
      const u = new URL(location.href); u.searchParams.delete('welt'); location.href = u.toString();
    });
    seg.appendChild(b);
  }
  if (WELT === 'heute') { window.HXW = { tile() {}, drop() {}, welt: WELT }; return; }

  // ---- models
  const loader = new THREE.GLTFLoader(), V = new Map(), TILES = new Map(), dirty = new Set();
  const KITN = n => !!(window.HXMB && HXMB.KIT.has(n));
  const matBody = new THREE.MeshLambertMaterial({ vertexColors: true }), matGlow = new THREE.MeshBasicMaterial({ vertexColors: true });
  // line of sight to the player stays free: a hole through the models in front of the player (like the houses, Runde 68)
  const U = X.bldU;
  function seeThrough(mat) { mat.onBeforeCompile = sh => {
    sh.uniforms.uPlayer = U.uPlayer; sh.uniforms.uToCam = U.uToCam; sh.uniforms.uCamDist = U.uCamDist;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 uPlayer;\nvarying vec3 vRelW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 hxW = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\nhxW = instanceMatrix * hxW;\n#endif\nvRelW = (modelMatrix * hxW).xyz - uPlayer;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uToCam;\nuniform float uCamDist;\nvarying vec3 vRelW;\nfloat hxB2(vec2 a){a=floor(a);return fract(a.x*0.5+a.y*a.y*0.75);} float hxBayer(vec2 a){return hxB2(0.5*a)*0.25+hxB2(a);}')
      .replace('void main() {', 'void main() {\n  { vec3 rel = vRelW - vec3(0.0, 1.0, 0.0); float s = dot(rel, uToCam);\n    if (s > 0.3 && s < uCamDist && dot(rel.xz, uToCam.xz) > 0.4) { float dl = length(rel - uToCam * s); if (dl < 5.0 && hxBayer(gl_FragCoord.xy) < 0.85 * (1.0 - smoothstep(3.0, 5.0, dl))) discard; } }'); // Runde 167: a small dithered hole instead of a hard 12 m cylinder
  }; }
  if (U) [matBody, matGlow].forEach(seeThrough);
  let MAN = null; fetch('welten/welten.json?v=441').then(r => r.json()).then(j => { MAN = j; for (const k of dirty) load(k); });
  /* Runde 154: the castle of the medieval world is built here in code (no Blender model): rock base, curtain wall with battlements,
     four corner towers, gatehouse facing the town (+z), keep with lit windows and a banner, a hall with a steep roof */
  function burgParts() {
    const body = [], glow = []; let sd = 3; const q = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    const box = (L, x0, y0, z0, x1, y1, z1, c, j) => { const t = j === 0 ? 1 : .92 + q() * .16, k = [c[0] * t, c[1] * t, c[2] * t];
      const F = [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0]],
        [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]],
        [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]]];
      for (const [a, b, c2, d, n] of F) for (const v of [a, b, c2, a, c2, d]) L.push([v, n, k]); };
    const ST = [.64, .6, .54], ST2 = [.52, .49, .44], ROCK = [.4, .37, .33], ROOF = [.42, .2, .16], DARK = [.1, .08, .07], WOOD = [.35, .23, .14], RED = [.62, .1, .1];
    const W = 17, T = 2, H = 9;
    box(body, -W - 2, -30, -W - 2, W + 2, .4, W + 2, ROCK, 0); // rock base: carries the castle over sloping ground
    const merl = (x0, z0, x1, z1, y) => { const L = Math.hypot(x1 - x0, z1 - z0), n = Math.floor(L / 2); for (let i = 0; i < n; i += 1) { if (i % 2) continue; const u0 = i / n, u1 = (i + 1) / n;
      const ax = x0 + (x1 - x0) * u0, az = z0 + (z1 - z0) * u0, bx = x0 + (x1 - x0) * u1, bz = z0 + (z1 - z0) * u1; box(body, Math.min(ax, bx) - .5, y, Math.min(az, bz) - .5, Math.max(ax, bx) + .5, y + 1.2, Math.max(az, bz) + .5, ST); } };
    // curtain walls with battlements (gate gap on +z)
    box(body, -W, 0, -W, W, H, -W + T, ST); merl(-W, -W + .5, W, -W + .5, H);
    box(body, -W, 0, -W, -W + T, H, W, ST); merl(-W + .5, -W, -W + .5, W, H);
    box(body, W - T, 0, -W, W, H, W, ST); merl(W - .5, -W, W - .5, W, H);
    box(body, -W, 0, W - T, -4, H, W, ST); box(body, 4, 0, W - T, W, H, W, ST); merl(-W, W - .5, -4, W - .5, H); merl(4, W - .5, W, W - .5, H);
    // corner towers with pointed roofs (stepped, pixel style)
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const cx = sx * W, cz = sz * W, r = 3.4;
      box(body, cx - r, 0, cz - r, cx + r, 14, cz + r, ST2); for (let k = 0; k < 5; k++) { const rr = r + .4 - k * .8; box(body, cx - rr, 14 + k * 1.3, cz - rr, cx + rr, 15.3 + k * 1.3, cz + rr, ROOF); }
      box(glow, cx - .4, 10, cz + sz * r - (sz > 0 ? .02 : -.02) - (sz > 0 ? 0 : .1), cx + .4, 11.3, cz + sz * r + (sz > 0 ? .1 : .02), [1, .78, .4], 0); }
    // gatehouse: two towers over the gate, a dark gate with a wooden door
    box(body, -6, 0, W - 4, -2.4, 13, W + 1.5, ST2); box(body, 2.4, 0, W - 4, 6, 13, W + 1.5, ST2); box(body, -6, 9, W - 4, 6, 13, W + 1.5, ST2); merl(-6, W + 1, 6, W + 1, 13);
    box(body, -2.4, 6.3, W - 4, 2.4, 9, W + 1.5, DARK, 0); box(body, 2.2, 0, W - 3.6, 2.4, 6.2, W - .8, WOOD); box(body, -2.4, 0, W - 3.6, -2.2, 6.2, W - .8, WOOD); // open gate: dark passage roof, both wooden leaves swung back
    box(glow, -.5, 10.5, W + 1.5, .5, 11.8, W + 1.62, [1, .78, .4], 0);
    // keep (Bergfried) at the back, with lit windows and a banner
    box(body, -10, 0, -12, -1, 24, -3, ST2); merl(-10.5, -12.5, -.5, -12.5, 24); merl(-10.5, -2.5, -.5, -2.5, 24); merl(-10.5, -12.5, -10.5, -2.5, 24); merl(-.5, -12.5, -.5, -2.5, 24);
    for (const y of [12, 17, 21]) box(glow, -6.2, y, -2.95, -4.8, y + 1.6, -2.85, [1, .8, .45], 0);
    box(body, -5.6, 24, -7.6, -5.4, 31, -7.4, WOOD, 0); box(body, -5.4, 28.4, -7.55, -2.4, 30.6, -7.45, RED, 0);
    // hall (Palas) along the east wall, steep roof
    box(body, 3, 0, -13, 13, 10, 3, ST); for (let k = 0; k < 6; k++) { const w = 5.6 - k * 1; box(body, 8 - w, 10 + k * 1.2, -13.5, 8 + w, 11.2 + k * 1.2, 3.5, ROOF); }
    for (const z of [-10, -6, -2]) box(glow, 2.9, 6, z, 3, 7.6, z + 1.2, [1, .8, .45], 0);
    box(body, -13, 0, 6, -6, 4, 12, WOOD); // stable / shed in the bailey
    const geo = L => { const pos = [], nor = [], col = []; for (const [v, n, c] of L) { pos.push(...v); nor.push(...n); col.push(...c); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); return g; };
    return [{ geo: geo(body), mat: matBody }, { geo: geo(glow), mat: matGlow }];
  }
  function stufeParts() { // one stair step: 5.2 m wide, 1 m deep, 1 m high (scaled in height per step), stone with a darker front edge
    const P = [], N = [], C = []; const add = (x0, y0, z0, x1, y1, z1, k) => { const F = [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0]],
      [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]],
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]]];
      for (const [a, b, c, d, n] of F) for (const q of [a, b, c, a, c, d]) { P.push(...q); N.push(...n); C.push(...k); } };
    add(-2.6, 0, -.5, 2.6, 1, .5, [.58, .55, .5]); add(-2.9, 0, -.5, -2.6, 1.02, .5, [.48, .45, .41]); add(2.6, 0, -.5, 2.9, 1.02, .5, [.48, .45, .41]);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    return [{ geo: g, mat: matBody }]; }
  function load(name) {
    let v = V.get(name); if (v) return v;
    if (name === 'm_burg') { V.set(name, v = { parts: burgParts(), meshes: [], cap: 0, sign: null }); return v; }
    if (name === 'm_stufe') { V.set(name, v = { parts: stufeParts(), meshes: [], cap: 0, sign: null }); return v; }
    V.set(name, v = { parts: null, meshes: [], cap: 0, sign: MAN && MAN[name] ? MAN[name].schild : null });
    loader.load('welten/' + name + '.glb?v=441', g => {
      v.parts = []; g.scene.traverse(o => { if (o.isMesh) v.parts.push({ geo: o.geometry, mat: o.name.startsWith('leuchten') ? matGlow : matBody }); });
      rebuild(name);
    }, undefined, () => { v.parts = []; });
    return v;
  }
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), P3 = new THREE.Vector3(), S3 = new THREE.Vector3();
  function rebuild(name) {
    if (KITN(name)) return; // Runde 159: drawn by the medieval kit (mittel_bau.js), one mesh per tile
    const v = V.get(name); if (!v || !v.parts) return;
    const list = []; for (const arr of TILES.values()) for (const it of arr) if (it.v === name) list.push(it);
    if (list.length > v.cap) { // grow: new instanced meshes
      for (const m of v.meshes) X.scene.remove(m); v.cap = Math.max(16, 1 << Math.ceil(Math.log2(list.length)));
      v.meshes = v.parts.map(p => { const m = new THREE.InstancedMesh(p.geo, p.mat, v.cap); m.frustumCulled = false; X.scene.add(m); return m; });
    }
    for (const m of v.meshes) {
      list.forEach((it, i) => { P3.set(it.x, it.y, it.z); Q.setFromEuler(E.set(0, it.ry, 0)); S3.set(it.sx, it.sy, it.sz); M4.compose(P3, Q, S3); m.setMatrixAt(i, M4); });
      m.count = list.length; m.visible = list.length > 0; m.instanceMatrix.needsUpdate = true;
    }
  }

  // ---- sign text atlas (one texture for all signs, one mesh per tile)
  const AW = 2048, AH = 1024, RH = 64, atlas = document.createElement('canvas'); atlas.width = AW; atlas.height = AH;
  const actx = atlas.getContext('2d'), tex = new THREE.CanvasTexture(atlas), words = new Map(); let ax = 0, ay = 0;
  tex.anisotropy = 4;
  const signMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: .3, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  if (U) seeThrough(signMat);
  const NEON = ['#4fe3ff', '#ff4fd8', '#ffd24f', '#7dff6a', '#a07bff'];
  function word(st, t) {
    const key = st + '|' + t; let w = words.get(key); if (w) return w;
    const font = st === 'cyber' ? 'bold 46px Bahnschrift, "Arial Narrow", Arial, sans-serif' : st === 'mittel' ? 'italic bold 44px Georgia, serif' : 'bold 44px Georgia, serif';
    actx.font = font; const tw = Math.min(AW - 8, Math.ceil(actx.measureText(t).width) + 24);
    if (ax + tw > AW) { ax = 0; ay += RH; } if (ay + RH > AH) { actx.clearRect(0, 0, AW, AH); words.clear(); ax = ay = 0; } // full: start over (signs are redrawn on the next tiles)
    actx.save(); actx.font = font; actx.textAlign = 'center'; actx.textBaseline = 'middle';
    const cx = ax + tw / 2, cy = ay + RH / 2 + 2;
    if (st === 'cyber') { const c = NEON[Math.floor((t.length * 7 + t.charCodeAt(0)) % NEON.length)]; actx.shadowColor = c; actx.shadowBlur = 10; actx.fillStyle = c; actx.fillText(t, cx, cy); actx.shadowBlur = 0; actx.fillStyle = '#ffffff'; actx.globalAlpha = .85; actx.fillText(t, cx, cy); }
    else { actx.fillStyle = st === 'mittel' ? '#f0d78a' : '#f6e6bf'; actx.fillText(t, cx, cy); }
    actx.restore();
    w = { u0: ax / AW, u1: (ax + tw) / AW, v0: 1 - (ay + RH) / AH, v1: 1 - ay / AH, asp: tw / RH }; words.set(key, w); ax += tw + 4; tex.needsUpdate = true; return w;
  }
  const signMeshes = new Map();
  function signs(key) {
    const old = signMeshes.get(key); if (old) { X.scene.remove(old); old.geometry.dispose(); signMeshes.delete(key); }
    const arr = TILES.get(key); if (!arr || !MAN) return;
    const pos = [], uv = [];
    for (const it of arr) {
      if (!it.t) continue; const s = KITN(it.v) ? HXMB.sign(it) : MAN[it.v] && MAN[it.v].schild; if (!s) continue;
      const w = word(s.st, it.t), H = s.h * it.sy, W = Math.min(s.w * it.sx, w.asp * H), H2 = W / w.asp;
      const c = Math.cos(it.ry), sn = Math.sin(it.ry), lx = s.x * it.sx, ly = s.y * it.sy, lz = s.z * it.sz + .03;
      const px = it.x + lx * c + lz * sn, py = it.y + ly, pz = it.z - lx * sn + lz * c, ux = c, uz = -sn; // ux, uz: the sign's right
      const a = [px - ux * W / 2, py - H2 / 2, pz - uz * W / 2], b = [px + ux * W / 2, py - H2 / 2, pz + uz * W / 2], d = [px + ux * W / 2, py + H2 / 2, pz + uz * W / 2], e = [px - ux * W / 2, py + H2 / 2, pz - uz * W / 2];
      pos.push(...a, ...b, ...d, ...a, ...d, ...e); uv.push(w.u0, w.v0, w.u1, w.v0, w.u1, w.v1, w.u0, w.v0, w.u1, w.v1, w.u0, w.v1);
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const m = new THREE.Mesh(g, signMat); m.frustumCulled = false; X.scene.add(m); signMeshes.set(key, m);
  }

  // ---- tiles from the worker
  let pend = false;
  function flush() { pend = false; for (const n of dirty) { if (KITN(n)) continue; load(n); rebuild(n); } dirty.clear(); }
  function tile(key, list) {
    const old = TILES.get(key); if (old) for (const it of old) dirty.add(it.v);
    if (list && list.length) { TILES.set(key, list); for (const it of list) dirty.add(it.v); } else TILES.delete(key);
    kitTile(key); signs(key); if (!pend) { pend = true; setTimeout(flush, 120); }
  }
  /* Runde 159: medieval buildings from the kit - one merged mesh per tile, one material (atlas) for all */
  const KMESH = new Map();
  function kitTile(key) {
    if (!window.HXMB) return; const old = KMESH.get(key); if (old) { X.scene.remove(old); old.geometry.dispose(); KMESH.delete(key); }
    const arr = TILES.get(key); if (!arr) return; const g = HXMB.build(arr); if (!g) return;
    const m = new THREE.Mesh(g, HXMB.mat); m.frustumCulled = true; X.scene.add(m); KMESH.set(key, m);
  }
  if (window.HXMB) { HXMB.mat.onBeforeCompile = sh => HXMB.prep(sh, U); HXMB.mat.customProgramCacheKey = () => 'hxmittelkit2'; // Runde 167: see-through per building (in prep)
    HXMB.onReady = () => { for (const k of TILES.keys()) { kitTile(k); signs(k); } }; }
  function drop(prefix) { for (const k of [...TILES.keys()]) if (k.startsWith(prefix)) tile(k, null); for (const k of [...KMESH.keys()]) if (k.startsWith(prefix)) kitTile(k); }
  const wait = setInterval(() => { if (!MAN) return; clearInterval(wait); for (const k of TILES.keys()) signs(k); }, 300);
  window.HXW = { tile, drop, welt: WELT, get count() { let n = 0; for (const a of TILES.values()) n += a.length; return n; }, V, TILES };
})();
