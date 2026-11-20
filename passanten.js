/* HoodExplorer – Passanten aus dem Figuren-Baukasten (Runde 114).
   Wie bei den Fahrzeugen: jede Passanten-Variante wird beim Start in wenige Posen „gebacken“ (eine Geometrie mit Vertexfarben
   je Pose: 4 Gehbilder), ein InstancedMesh je Variante und Bild. Passanten laufen auf Gehwegen (Rand der Straßen, Fußwege)
   rund um die Spielfigur, wechseln das Gehbild nach zurückgelegtem Weg (Pixel-Animation in Stufen) und drehen an Hindernissen
   und Wegenden um. Welt-abhängig: Western → Cowboys, Mittelalter → Händler und Ritter, Cyberpunk → Runner und Androiden.
   Kosten: Varianten × 4 Draw Calls (nur belegte), Bewegung O(n) pro Bild. Schalter: Stimmung → Passanten (hx.passanten). */
(() => {
  const X = window.HXTR, F = window.HXFIG; if (!X || !F) return;
  const PHONE = matchMedia('(pointer:coarse)').matches, MAXN = PHONE ? 22 : 45, NV = PHONE ? 8 : 12, FR = 4;
  const S = { on: true, list: [], meshes: [], built: false, t: 0, next: 0 };
  try { const v = localStorage.getItem('hx.passanten'); if (v === 'false') S.on = false; } catch (e) {}
  const W = window.HX_WELT || 'heute';
  const POOL = { heute: ['wanderer', 'postbotin', 'paketbote', 'detektiv', 'journalistin', 'foersterin', 'bauarbeiter', 'koechin', 'aerztin', 'taxifahrer', 'pizzabote', 'touristin', 'skaterin', 'gaertner', 'diva', 'agentin', 'partygast'],
    west: ['cowboy', 'sheriff', 'cowboy', 'haendlerin'], mittel: ['haendlerin', 'ritter', 'haendlerin', 'haendlerin'], cyber: ['runner', 'androide', 'agentin', 'partygast'] }[W] || [];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, pick = a => a[(rnd() * a.length) | 0];
  const tint = (hex, k) => { const c = new THREE.Color(hex); c.offsetHSL((rnd() - .5) * .12 * k, (rnd() - .5) * .3 * k, (rnd() - .5) * .25 * k); return '#' + c.getHexString(); };

  // ---- bake one pose of a figure into a single geometry with vertex colours (textured parts like back lettering are left out)
  function bake(group) {
    group.updateMatrixWorld(true); const P = [], N = [], C = [];
    group.traverse(m => { if (!m.isMesh || m.material.map) return; const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()); g.applyMatrix4(m.matrixWorld);
      const p = g.attributes.position, n = g.attributes.normal, c = m.material.color; for (let i = 0; i < p.count; i++) { P.push(p.getX(i), p.getY(i), p.getZ(i)); N.push(n.getX(i), n.getY(i), n.getZ(i)); C.push(c.r, c.g, c.b); } g.dispose(); });
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); return geo;
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true }); if (X.withLamp) X.withLamp(mat);
  function build() {
    S.built = true; if (!POOL.length) return;
    for (let v = 0; v < NV; v++) {
      const d = Object.assign({}, F.byId(POOL[v % POOL.length])); d.item = null; d.schrift = null;
      if (W === 'heute' || v >= POOL.length) { d.oben = tint(d.oben, 1); d.hose = tint(d.hose, .7); d.haar = pick(['#1a1410', '#3a2a1a', '#7a4a22', '#b07a3a', '#d9b05a', '#9a9a9a', d.haar]); d.haut = pick(['#f0c8a8', '#e2b08c', '#d8a27a', '#c98d66', '#8d5a3a', d.haut]); }
      const g = new THREE.Group(), J = F.make(d, g), frames = [];
      for (let f = 0; f < FR; f++) { F.pose(J, { walk: .85, run: 0, phase: (f + .5) / FR * Math.PI * 2, air: 0, tuck: 0, crouch: 0 }); frames.push(bake(g)); }
      S.meshes.push(frames.map(geo => { const m = new THREE.InstancedMesh(geo, mat, MAXN); m.count = 0; m.visible = false; m.frustumCulled = false; X.scene.add(m); return m; }));
    }
  }

  // ---- where people walk: sidewalks beside streets (both sides) and footways
  function spawn(px, pz) {
    const tiles = [...X.tiles.values()]; if (!tiles.length) return;
    for (let tr = 0; tr < 30; tr++) {
      const t = pick(tiles), rs = t.roads; if (!rs || !rs.length) continue; const r = pick(rs); if (r.k === 'r' || r.k === 't' || r.a || r.p.length < 4) continue;
      const n = r.p.length / 2, i = 1 + ((rnd() * (n - 1)) | 0), ax = r.p[i * 2 - 2], az = r.p[i * 2 - 1], bx = r.p[i * 2], bz = r.p[i * 2 + 1], L = Math.hypot(bx - ax, bz - az); if (L < 2) continue;
      const u = rnd(), side = r.k === 'p' ? (rnd() - .5) * .8 : (rnd() < .5 ? -1 : 1) * (r.w / 2 + 1.6), dx = (bx - ax) / L, dz = (bz - az) / L;
      const x = ax + (bx - ax) * u - dz * side, z = az + (bz - az) * u + dx * side, d = Math.hypot(x - px, z - pz);
      if (d < 35 || d > 160 || X.buildingAt(x, z)) continue;
      S.list.push({ r, i, u: u * L, L, side, dir: rnd() < .5 ? 1 : -1, v: (r.k === 'p' ? 1.1 : 1.25) + rnd() * .5, x, z, y: X.terrainH(x, z), h: 0, var: (rnd() * S.meshes.length) | 0, step: rnd() * 4, wait: 0 });
      return;
    }
  }
  function advance(p, dt) {
    if (p.wait > 0) { p.wait -= dt; return; }
    const r = p.r; let s = p.u + p.dir * p.v * dt;
    while (s > p.L || s < 0) { // next segment of the line, or turn round at its end
      const ni = p.i + (s > p.L ? 1 : -1); if (ni < 1 || ni >= r.p.length / 2) { p.dir = -p.dir; s = Math.max(0, Math.min(p.L, s)); if (Math.random() < .3) p.wait = 1 + Math.random() * 3; break; }
      const over = s > p.L ? s - p.L : -s; p.i = ni; const L2 = Math.hypot(r.p[ni * 2] - r.p[ni * 2 - 2], r.p[ni * 2 + 1] - r.p[ni * 2 - 1]) || 1; p.L = L2; s = p.dir > 0 ? over : L2 - over; }
    const ax = r.p[p.i * 2 - 2], az = r.p[p.i * 2 - 1], bx = r.p[p.i * 2], bz = r.p[p.i * 2 + 1], L = p.L || 1, dx = (bx - ax) / L, dz = (bz - az) / L;
    const x = ax + dx * s - dz * p.side, z = az + dz * s + dx * p.side;
    if (X.buildingAt(x, z)) { p.dir = -p.dir; return; } // a house on the sidewalk line: turn round
    p.step += Math.hypot(x - p.x, z - p.z) / .45; p.u = s; p.x = x; p.z = z;
    const hh = Math.atan2(dx * p.dir, dz * p.dir); let dh = hh - p.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); p.h += dh * Math.min(1, dt * 8);
    if (!p.hy || Math.abs(x - p.hx) + Math.abs(z - p.hz) > 1) { p.hx = x; p.hz = z; p.y = X.terrainH(x, z, p.y + 1); p.hy = 1; }
  }
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), V3 = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1);
  function draw() {
    const cnt = S.meshes.map(() => new Array(FR).fill(0));
    for (const p of S.list) { const f = p.wait > 0 ? 0 : (p.step | 0) % FR, m = S.meshes[p.var][f]; Q.setFromEuler(E.set(0, p.h, 0)); M4.compose(V3.set(p.x, p.y, p.z), Q, ONE); m.setMatrixAt(cnt[p.var][f]++, M4); }
    S.meshes.forEach((fr, v) => fr.forEach((m, f) => { m.count = cnt[v][f]; m.visible = m.count > 0; m.instanceMatrix.needsUpdate = true; }));
  }
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(.1, (now - last) / 1000); last = now; requestAnimationFrame(loop);
    if (!S.built) { if (X.tiles.size) build(); return; }
    const P = X.P; if (!S.on || !P.placed || X.ISO !== null || X.PRUEF !== null) { if (S.list.length) { S.list = []; draw(); } return; }
    const px = P.x, pz = P.z; S.list = S.list.filter(p => Math.hypot(p.x - px, p.z - pz) < 190);
    if (S.list.length < MAXN && now > S.next) { spawn(px, pz); S.next = now + 120; }
    for (const p of S.list) advance(p, dt);
    draw();
  }
  requestAnimationFrame(loop);
  const el = document.getElementById('tPass');
  if (el) { el.checked = S.on; el.addEventListener('change', e => { S.on = e.target.checked; try { localStorage.setItem('hx.passanten', S.on); } catch (x) {} }); }
  window.HXPASS = S;
})();
