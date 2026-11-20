/* HoodExplorer – Mittelalter-Baukasten im Spiel (Runde 159).
   Gebäude entstehen per Seed aus wenigen Flächen; die Details sind Pixel-Texturen (ein Atlas, welten/mittel_atlas.png),
   Sticker (Fenster, Türen, Zinnen, Tor, Schilder) und Sprites (Fässer, Kisten, Heu). Entworfen in Blender
   (werkzeuge/blender/hx_lowpoly.py, hx_tex.py, hx_atlas.py), hier dieselben Regeln in three.js-Koordinaten:
   x rechts, y oben, Vorderseite +z (wie die Modelle des Workers). Ein Mesh je Kachel, ein Material für alles.
   Shader: Zelle des Atlas per Vertex-Attribut (aCell), Wiederholung per fract(), Alpha-Schnitt für Sticker,
   aGlow = leuchtet nachts (Fenster, Laternen, Esse). */
(() => {
  const X = window.HXTR; if (!X || !window.THREE || (window.HX_WELT || 'heute') !== 'mittel') return;
  let CELLS = null; const atlas = new THREE.TextureLoader().load('welten/mittel_atlas.png?v=1', t => { t.needsUpdate = true; });
  atlas.magFilter = atlas.minFilter = THREE.NearestFilter; atlas.generateMipmaps = false; atlas.encoding = THREE.sRGBEncoding;
  fetch('welten/mittel_atlas.json?v=1').then(r => r.json()).then(j => { CELLS = j; if (window.HXMB) HXMB.onReady && HXMB.onReady(); });
  const uNight = { value: 0 }, uTime = { value: 0 };
  const mat = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: .5, side: THREE.DoubleSide });

  // ------------------------------------------------------------------ Geometrie-Sammler mit Lage-Stapel
  class K {
    constructor() { this.p = []; this.uv = []; this.c = []; this.g = []; this.s = []; this.spin = [0, 0, 0, 0]; this.T = [[0, 0, 0, 0]]; }
    push(x, y, z, r) { const [px, py, pz, pr] = this.T[this.T.length - 1], c = Math.cos(pr), s = Math.sin(pr); this.T.push([px + x * c + z * s, py + y, pz - x * s + z * c, pr + r]); }
    pop() { this.T.pop(); }
    P(x, y, z) { const [px, py, pz, pr] = this.T[this.T.length - 1], c = Math.cos(pr), s = Math.sin(pr); return [px + x * c + z * s, py + y, pz - x * s + z * c]; }
    poly(pts, uvs, cell, glow) { // Dreiecksfächer
      const C = CELLS[cell] || CELLS.c_putz; const W = pts.map(p => this.P(p[0], p[1], p[2]));
      for (let i = 1; i + 1 < W.length; i++) for (const k of [0, i, i + 1]) { this.p.push(...W[k]); this.uv.push(uvs[k][0], uvs[k][1]); this.c.push(C[0], C[1], C[2], C[3]); this.g.push(glow || 0); this.s.push(...this.spin); }
    }
    wall(a, b, y0, h, cell, rep) { // senkrechtes Viereck a=(x,z) → b; rep = [Meter je Kachel] → Wiederholung
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = rep ? L / rep[0] : .998, v = rep ? h / rep[1] : .998, o = rep ? 0 : .002;
      this.poly([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y0 + h, b[1]], [a[0], y0 + h, a[1]]], [[o, o], [u, o], [u, v], [o, v]], cell);
    }
    box(w, d, h, x, y, z, cell, rep, top = true) {
      const a = [x - w / 2, z + d / 2], b = [x + w / 2, z + d / 2], c = [x + w / 2, z - d / 2], e = [x - w / 2, z - d / 2];
      for (const [p, q] of [[a, b], [b, c], [c, e], [e, a]]) this.wall(p, q, y, h, cell, rep);
      if (top) this.poly([[a[0], y + h, a[1]], [b[0], y + h, b[1]], [c[0], y + h, c[1]], [e[0], y + h, e[1]]], [[0, 0], [w / (rep ? rep[0] : w), 0], [w / (rep ? rep[0] : w), d / (rep ? rep[1] : d)], [0, d / (rep ? rep[1] : d)]], cell);
    }
    prism(r, h, x, y, z, n, cell, rep = [3.2, 3.2]) {
      for (let i = 0; i < n; i++) { const a0 = i / n * 6.2832, a1 = (i + 1) / n * 6.2832, s = 2 * Math.PI * r / n / rep[0];
        this.poly([[x + Math.cos(a0) * r, y, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r], [x + Math.cos(a1) * r, y + h, z + Math.sin(a1) * r], [x + Math.cos(a0) * r, y + h, z + Math.sin(a0) * r]],
          [[i * s, 0], [(i + 1) * s, 0], [(i + 1) * s, h / rep[1]], [i * s, h / rep[1]]], cell); }
    }
    cone(r, h, x, y, z, n, cell, rot = 0) {
      const sl = Math.hypot(r, h), wb = 2 * r * Math.sin(Math.PI / n) / 1.6;
      for (let i = 0; i < n; i++) { const a0 = rot + i / n * 6.2832, a1 = rot + (i + 1) / n * 6.2832;
        this.poly([[x + Math.cos(a0) * r, y, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y, z + Math.sin(a1) * r], [x, y + h, z]], [[0, 0], [wb, 0], [wb / 2, sl / 1.6]], cell); }
    }
    sticker(name, x, y, z, rot = 0, w, h, out = .04, glow = 0) { // Bild auf der Wand, Blick +z (lokal), Mitte unten bei (x, y, z)
      const C = CELLS[name]; if (!C) return; w = w || C[4] / 20; h = h || C[5] / 20;
      this.push(x, y, z, rot); this.poly([[-w / 2, 0, out], [w / 2, 0, out], [w / 2, h, out], [-w / 2, h, out]], [[.002, .002], [.998, .002], [.998, .998], [.002, .998]], name, glow); this.pop();
    }
    sprite(name, x, y, z, k = 1, rot = 0) { // Kreuz aus zwei Bildern
      const C = CELLS[name]; if (!C) return; const w = C[4] / 20 * k, h = C[5] / 20 * k;
      for (const a of [rot, rot + Math.PI / 2]) { const c = Math.cos(a) * w / 2, s = Math.sin(a) * w / 2;
        this.poly([[x - c, y, z - s], [x + c, y, z + s], [x + c, y + h, z + s], [x - c, y + h, z - s]], [[.002, .002], [.998, .002], [.998, .998], [.002, .998]], name); }
    }
  }

  // ------------------------------------------------------------------ Bauteile
  const rnd = s => () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pick = (r, a) => a[Math.floor(r() * a.length)];
  const FACH = ['fach_x', 'fach_k', 'fach_leer', 'fach_raute'], GLAS = ['fenster_teal_gruen', 'fenster_blau_rot', 'fenster_teal_blau'];
  function walls(k, w, d, y, h, r, stone, putz2) { // vier Wände: Stein als eine Fläche je Seite, Fachwerk ein Viereck je Feld
    const P = [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]];
    for (let i = 0; i < 4; i++) { const a = P[i], c = P[(i + 1) % 4], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (stone) { k.wall(a, c, y, h, 'stein', [3.2, 3.2]); continue; }
      const n = Math.max(1, Math.round(L / 1.6));
      for (let j = 0; j < n; j++) k.wall([a[0] + (c[0] - a[0]) * j / n, a[1] + (c[1] - a[1]) * j / n], [a[0] + (c[0] - a[0]) * (j + 1) / n, a[1] + (c[1] - a[1]) * (j + 1) / n], y, h,
        putz2 ? pick(r, ['fach2_x', 'fach2_leer']) : pick(r, FACH)); }
  }
  function roof(k, w, d, h, y, tex, over = .5) { // Satteldach, First entlang x; Giebel, Windbretter mit hochgebogenen Enden
    const L = w + over * 2, S = d / 2 + over, sl = Math.hypot(S, h);
    for (const sd of [-1, 1]) k.poly([[-L / 2, y - .15, sd * S], [L / 2, y - .15, sd * S], [L / 2, y + h, 0], [-L / 2, y + h, 0]], [[0, 0], [L / 1.6, 0], [L / 1.6, sl / 1.6], [0, sl / 1.6]], tex);
    for (const e of [-1, 1]) { const x = e * w / 2, hz = h * (d / 2) / S;
      k.poly([[x, y, -d / 2], [x, y, d / 2], [x, y + hz, 0]], [[0, 0], [1, 0], [.5, 1]], 'c_putz');
      const xb = e * (L / 2 + .02);
      for (const sd of [-1, 1]) { const z0 = sd * (S + .05);
        k.poly([[xb, y - .1, z0], [xb, y + h + .1, 0], [xb, y + h + .4, 0], [xb, y + .25, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_balken');
        k.poly([[xb, y - .1, z0], [xb, y + .35, z0 + sd * .4], [xb, y + .65, z0 + sd * .4], [xb, y + .25, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_balken');
        k.poly([[xb, y + h + .1, 0], [xb, y + h + .6, -sd * .45], [xb, y + h + .9, -sd * .45], [xb, y + h + .4, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_balken'); } }
  }
  const ROOFS = ['dach_rot', 'dach_rot', 'dach_braun', 'dach_blau'], RED = ['dach_rot', 'dach_rot2', 'dach_rot3'];
  function house(k, o) { // o: {w, d, fl, seed, kind, roofs, sign}
    const r = rnd(o.seed), w = o.w, d = o.d, fl = o.fl, fh = 2.8, tex = pick(r, o.roofs || ROOFS), putz2 = r() < .35, glas = pick(r, GLAS), kind = o.kind || 'haus';
    let y = 0, ww = w, dd = d;
    for (let f = 0; f < fl; f++) {
      const stone = f === 0 && (r() < .55 || kind === 'turm' || kind === 'rathaus' || kind === 'taverne');
      walls(k, ww, dd, y, fh, r, stone, putz2);
      const nb = Math.max(1, Math.round(ww / 1.6));
      for (let i = 0; i < nb; i++) { const u = -ww / 2 + ww * (i + .5) / nb;
        if (f === 0 && i === Math.floor(nb / 2)) { k.sticker(stone ? 'tuer' : 'tuer_holz', u, y, dd / 2, 0); continue; }
        if (r() < .8) { const n = pick(r, [glas, glas, 'fenster_zu', 'fenster_blumen', 'fenster_licht']); k.sticker(n, u, y + .55, dd / 2, 0, 0, 0, .04, n === 'fenster_licht' ? 1 : 0); } }
      for (const [rot, px, pz, L] of [[Math.PI, 0, -dd / 2, ww], [-Math.PI / 2, -ww / 2, 0, dd], [Math.PI / 2, ww / 2, 0, dd]]) {
        const n = Math.max(1, Math.round(L / 1.6));
        for (let i = 0; i < n; i++) if (r() < .5) { const u = -L / 2 + L * (i + .5) / n, nm = pick(r, [glas, 'fenster_zu', 'fenster_licht']);
          k.push(px, 0, pz, rot); k.sticker(nm, u, y + .55, 0, 0, 0, 0, .04, nm === 'fenster_licht' ? 1 : 0); k.pop(); } }
      y += fh;
      if (f < fl - 1 && kind === 'haus') { ww += .5; dd += .5; }
    }
    if (kind === 'turm') k.cone(ww * .78, ww * 1.3, 0, y, 0, 4, tex, Math.PI / 4);
    else { roof(k, ww, dd, Math.max(2.4, dd * .42), y, tex); const cx = ww * .25 * (r() < .5 ? -1 : 1); k.box(.9, .9, 2.4 + dd * .3, cx, y, -dd * .15, 'stein', [3.2, 3.2]); }
    if (kind === 'rathaus') k.sticker('uhr', 0, y + .6, dd / 2 + .05, 0, 1.4, 1.4);
    if (r() < .6) k.sticker('laterne', -ww / 4, 2.0, dd / 2, 0, 0, 0, .1, 1);
    if (o.sign) k.sticker('c_holz_d', 0, fh - .55, dd / 2, 0, Math.min(ww - 1.2, 4.4), .8, .07); // Brett hinter dem Schildtext
    if (kind === 'taverne') { k.sticker('schild_krug', ww * .32, 2.1, dd / 2, 0, 0, 0, .5); for (let i = 0; i < 3; i++) k.sprite('fass', -ww / 2 + .8 + i * .9, 0, dd / 2 + .8); }
  }

  function castle(k, seed) { // passt zur Kollision des Workers (Mauern ±17, Türme an den Ecken, Torbau vorn, Bergfried, Palas)
    const r = rnd(seed);
    k.box(42, 42, 30.4, 0, -30, 0, 'stein', [3.2, 3.2], false);                         // Felssockel bis in den Hang
    k.poly([[-17, .41, 17], [17, .41, 17], [17, .41, -17], [-17, .41, -17]], [[0, 0], [34 / 1.6, 0], [34 / 1.6, 34 / 1.6], [0, 34 / 1.6]], 'pflaster');
    const H = 9, seg = (a, b) => { k.wall(a, b, .4, H, 'stein', [3.2, 3.2]); const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.floor(L / 1.6), ang = Math.atan2(b[0] - a[0], b[1] - a[1]) - Math.PI / 2;
      for (let i = 0; i < n; i++) { const u = (i + .5) / n; k.sticker('zinnen', a[0] + (b[0] - a[0]) * u, .4 + H, a[1] + (b[1] - a[1]) * u, ang, 1.6, 1.0, 0); } };
    // Außenseiten (im Uhrzeigersinn von vorn links), Innenseiten und Wehrgang
    seg([-17, 17], [-2.4, 17]); seg([2.4, 17], [17, 17]); seg([17, 17], [17, -17]); seg([17, -17], [-17, -17]); seg([-17, -17], [-17, 17]);
    for (const [a, b] of [[[-15, 15], [-15, -15]], [[-15, -15], [15, -15]], [[15, -15], [15, 15]], [[15, 15], [2.4, 15]], [[-2.4, 15], [-15, 15]]]) k.wall(a, b, .4, H - .3, 'stein', [3.2, 3.2]);
    for (const [x0, z0, x1, z1] of [[-17, -17, 17, -15], [15, -17, 17, 17], [-17, -17, -15, 17], [-17, 15, -2.4, 17], [2.4, 15, 17, 17]]) k.poly([[x0, H + .1, z1], [x1, H + .1, z1], [x1, H + .1, z0], [x0, H + .1, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_stein');
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const cx = sx * 17, cz = sz * 17;
      k.prism(3.4, 14, cx, .4, cz, 8, 'stein_turm'); k.cone(3.9, 7, cx, 14.4, cz, 8, pick(r, RED), Math.PI / 8);
      for (let j = 0; j < 2; j++) { const a = Math.atan2(sz, sx) + (j - .5) * .9; k.sticker(j ? 'fenster_bogen_licht' : 'fenster_bogen', cx + Math.cos(a) * 3.35, 6 + j * 3, cz + Math.sin(a) * 3.35, Math.atan2(Math.cos(a), Math.sin(a)), 0, 0, .06, j); } }
    // Torbau: zwei Blöcke und Sturz, Tor-Sticker, Banner, Zinnen, kleine Kegel
    k.box(3.6, 5.5, 12.6, -4.2, .4, 15.75, 'stein_turm', [3.2, 3.2]); k.box(3.6, 5.5, 12.6, 4.2, .4, 15.75, 'stein_turm', [3.2, 3.2]); k.box(4.8, 5.5, 5.6, 0, 7.4, 15.75, 'stein_turm', [3.2, 3.2]);
    k.sticker('tor', 0, .4, 18.5, 0, 4.8, 7.0, .03);
    for (const sx of [-4.2, 4.2]) { k.sticker('banner', sx, 5, 18.5, 0, 0, 0, .08); k.cone(1.6, 3.4, sx, 13, 15.75, 8, pick(r, RED)); }
    for (let i = 0; i < 4; i++) k.sticker('zinnen', -2.4 + i * 1.6, 13, 18.5, 0, 1.6, 1, 0);
    // Bergfried
    k.box(9, 9, 24, -5.5, .4, -7.5, 'stein_turm', [3.2, 3.2], false);
    for (let s = 0; s < 4; s++) { k.push(-5.5, 0, -7.5, s * Math.PI / 2); for (let i = 0; i < 5; i++) k.sticker('zinnen', -3.6 + i * 1.8, 24.4, 4.5, 0, 1.8, 1, 0);
      k.sticker(s % 2 ? 'fenster_bogen_licht' : 'fenster_bogen', 0, 14, 4.5, 0, 0, 0, .05, s % 2); k.sticker('fenster_bogen', 0, 19, 4.5, 0); k.pop(); }
    k.cone(5.6, 8, -5.5, 24.4, -7.5, 4, 'dach_rot2', Math.PI / 4); k.sticker('banner', -5.5, 16, -3, 0, 0, 0, .08);
    // Palas (Fachwerk auf Steinsockel), Schuppen, Fässer
    k.push(8, .4, -5, 0); house(k, { w: 10, d: 16, fl: 3, seed: seed + 4, kind: 'rathaus', roofs: RED }); k.pop();
    k.box(7, 6, 3.6, -9.5, .4, 9, 'bretter', [1.6, 1.6], false); k.poly([[-13.2, 4.4, 12.2], [-5.8, 4.4, 12.2], [-5.8, 3.4, 5.8], [-13.2, 3.4, 5.8]].map(p => [p[0], p[1], p[2]]), [[0, 0], [4.6, 0], [4.6, 4], [0, 4]], 'dach_braun');
    for (let i = 0; i < 3; i++) k.sprite('fass', 9 + i * .9, .4, 12); k.sprite('kiste', 7, .4, 12.5); k.sprite('heu', -11, .4, 4, .5);
  }

  function church(k, seed) { // Schiff 9 × 16, Westturm vorn (+z), Bogenfenster leuchten nachts
    const L = 16, W = 9, H = 7;
    k.box(W, L, H, 0, 0, 0, 'stein', [3.2, 3.2], false);
    k.push(0, 0, 0, Math.PI / 2); roof(k, L, W, 5, H, 'dach_blau'); k.pop();
    for (const z of [-4.5, -1.5, 1.5, 4.5]) for (const s of [-1, 1]) { k.push(s * W / 2, 0, z, s * Math.PI / 2); k.sticker('fenster_bogen_licht', 0, 2.6, 0, 0, 0, 0, .05, 1); k.pop(); }
    const T = 5.4, tz = L / 2 + T / 2;
    k.box(T, T, 17, 0, 0, tz, 'stein_turm', [3.2, 3.2], false); k.cone(T * .74, 11, 0, 17, tz, 4, 'dach_blau', Math.PI / 4);
    k.sticker('tuer', 0, 0, tz + T / 2, 0); k.sticker('uhr', 0, 10, tz + T / 2, 0, 1.4, 1.4); k.sticker('fenster_bogen', 0, 13, tz + T / 2, 0);
    for (const s of [1, 2, 3]) { k.push(0, 0, tz, s * Math.PI / 2); k.sticker('fenster_bogen', 0, 13, T / 2, 0); k.pop(); }
  }
  function well(k) { k.prism(1.6, .9, 0, 0, 0, 8, 'stein'); k.poly([...Array(8)].map((_, i) => [Math.cos(i / 8 * 6.283) * 1.5, .85, Math.sin(i / 8 * 6.283) * 1.5]), [...Array(8)].map(() => [.5, .5]), 'c_wasser');
    for (const s of [-1, 1]) k.box(.25, .25, 3, s * 1.3, 0, 0, 'c_holz_d'); k.push(0, 0, 0, 0); roof(k, 3.2, 2.2, 1.0, 3, 'dach_rot', .2); k.pop(); }
  function stall(k, seed) { const r = rnd(seed), cs = pick(r, [['c_rot', 'c_weiss'], ['c_blau', 'c_weiss'], ['c_gruen', 'c_creme'], ['c_gold', 'c_rot']]);
    k.box(3, 1.3, .9, 0, 0, 0, 'bretter_holz', [1.6, 1.6]);
    for (let i = 0; i < 6; i++) { const u0 = -1.6 + i * 3.2 / 6; k.poly([[u0, 2.4, 1.0], [u0 + 3.2 / 6, 2.4, 1.0], [u0 + 3.2 / 6, 2.9, -.8], [u0, 2.9, -.8]], [[0, 0], [1, 0], [1, 1], [0, 1]], cs[i % 2]); }
    for (const sx of [-1.45, 1.45]) k.box(.12, .12, 2.6, sx, 0, .6, 'c_holz_d', null, false);
    k.sprite('blumen', -.8, .9, 0, 1.2); k.sprite('heu', .7, .9, 0, .45); }

  // ------------------------------------------------------------------ Runde 160: Mühlen und Höfe
  function spinOn(k, x, y, z, code) { const W = k.P(x, y, z), ry = k.T[k.T.length - 1][3]; k.spin = [W[0], W[1], W[2], code + ((ry % 6.2832) + 6.2832) % 6.2832]; }
  function windmill(k, seed) { // Turmwindmühle: Steinsockel, Putzturm (8 Seiten), Holzkappe, Flügelkreuz als EIN Sticker, dreht sich
    k.prism(3.5, .9, 0, 0, 0, 8, 'stein'); k.prism(3.2, 9.5, 0, .9, 0, 8, 'putz', [1.6, 1.6]); k.cone(3.6, 4.0, 0, 10.4, 0, 8, 'dach_braun', Math.PI / 8);
    k.sticker('tuer_holz', 0, .9, 3.0, 0); k.sticker('fenster_licht', .9, 5.5, 2.95, .2, 0, 0, .04, 1); k.sticker('fenster_teal_gruen', -.6, 8, 2.9, -.15);
    spinOn(k, 0, 11.4, 3.5, 10); k.sticker('fluegel', 0, 2.9, 3.5, 0, 17, 17, 0); k.spin = [0, 0, 0, 0];
    for (let i = 0; i < 3; i++) k.sprite('heu', -2.2 + i * .9, 0, 4.4, .35);
  }
  function watermill(k, seed) { // Fachwerkhaus, Wasserrad vor der Wasserseite (+z), halb im Wasser, dreht sich
    house(k, { w: 8, d: 9, fl: 2, seed, kind: 'haus' });
    spinOn(k, 2.2, 1.6, 5.6, 100); k.sticker('wasserrad', 2.2, -1.6, 5.6, 0, 6.4, 6.4, 0); k.spin = [0, 0, 0, 0];
    for (const x of [.4, 4.0]) k.box(.25, .25, 2.4, x, -.6, 5.6, 'c_holz_d', null, false);
    for (let i = 0; i < 3; i++) k.sprite('kiste', -3 + i * .9, 0, 5.2);
  }
  function fence(k, a, b) { // zwei Latten als flache Streifen, Pfosten alle 2 m
    for (const y of [.45, .85]) k.poly([[a[0], y, a[1]], [b[0], y, b[1]], [b[0], y + .12, b[1]], [a[0], y + .12, a[1]]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_holz');
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / 2));
    for (let i = 0; i <= n; i++) k.box(.14, .14, 1.1, a[0] + (b[0] - a[0]) * i / n, 0, a[1] + (b[1] - a[1]) * i / n, 'c_holz_d', null, false);
  }
  function barn(k, seed) { // Scheune: Bretterwände, Strohdach, Tor mit Andreaskreuz (Sticker-Farbe), Heu, Koppel
    const r = rnd(seed);
    k.box(10, 14, 4.5, 0, 0, 0, 'bretter', [1.6, 1.6], false);
    k.push(0, 0, 0, Math.PI / 2); roof(k, 14, 10, 4.2, 4.5, 'dach_stroh', .7); k.pop();
    k.sticker('c_holz_d', 0, 0, 7, 0, 3.6, 3.6, .05);
    k.poly([[-1.8, 0, 7.07], [-1.5, 0, 7.07], [1.8, 3.6, 7.07], [1.5, 3.6, 7.07]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_holz'); k.poly([[1.5, 0, 7.07], [1.8, 0, 7.07], [-1.5, 3.6, 7.07], [-1.8, 3.6, 7.07]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_holz');
    k.sticker('c_holz_d', 0, 5.2, 7.05, 0, 1.4, 1.4, .05);
    for (let i = 0; i < 3; i++) k.sprite('heu', 6.6 + r() * 1.2, 0, -4 + i * 3.2, 1.0 + r() * .4);
    fence(k, [-6, -8], [-14, -8]); fence(k, [-14, -8], [-14, 8]); fence(k, [-14, 8], [-6, 8]);
    k.sprite('fass', 3, 0, 8); k.sprite('kiste', -3, 0, 8.2);
  }
  function farmhouse(k, seed) { // Bauernhaus: eingeschossig mit Steinsockel, tiefes Dach (Stroh/Ziegel/Schindel), Brunnen-Fass, Heu
    const r = rnd(seed); house(k, { w: 8, d: 9, fl: 1 + (r() < .4 ? 1 : 0), seed, kind: 'haus', roofs: ['dach_stroh', 'dach_stroh', 'dach_rot', 'dach_braun'] });
    k.sprite('fass', -3.6, 0, 5.4); k.sprite('heu', 4.6, 0, 3, .6); k.sprite('blumen', 1.5, 0, 5.2, 1.3);
  }

  // ------------------------------------------------------------------ Modell-Namen des Workers → Baukasten
  const DIM = { m_haus_a: [8.7, 10.7, 2], m_haus_b: [7.7, 11.7, 3], m_haus_c: [9.7, 10.7, 2], m_haus_d: [8.7, 12.7, 3], m_laden_a: [8.7, 10.7, 2], m_laden_b: [9.7, 11.7, 3],
    m_taverne: [10.7, 12.7, 3], m_rathaus: [14.7, 12.7, 3] };
  const KIT = new Set([...Object.keys(DIM), 'm_burg', 'm_kirche', 'm_brunnen', 'm_stand_a', 'm_stand_b', 'm_stufe', 'm_windmuehle', 'm_wassermuehle', 'm_scheune', 'm_bauernhaus']);
  const seedOf = it => (Math.abs(Math.round(it.x * 7.31) * 73856093 ^ Math.round(it.z * 3.17) * 19349663) % 2147483646) + 1;
  function item(k, it) {
    k.T = [[it.x, it.y, it.z, it.ry]]; const s = seedOf(it);
    if (DIM[it.v]) { const [w, d, fl] = DIM[it.v], kind = it.v === 'm_taverne' ? 'taverne' : it.v === 'm_rathaus' ? 'rathaus' : 'haus';
      house(k, { w: w - .4, d: d - .6, fl: kind === 'haus' ? fl - (fl === 3 && (s % 3 === 0) ? 1 : 0) : fl, seed: s, kind, sign: !!it.t }); }
    else if (it.v === 'm_burg') castle(k, s);
    else if (it.v === 'm_kirche') church(k, s);
    else if (it.v === 'm_brunnen') well(k);
    else if (it.v === 'm_stand_a' || it.v === 'm_stand_b') stall(k, s);
    else if (it.v === 'm_stufe') k.box(5.2, 1, it.sy, 0, 0, 0, 'stein', [3.2, 3.2]);
    else if (it.v === 'm_windmuehle') windmill(k, s);
    else if (it.v === 'm_wassermuehle') watermill(k, s);
    else if (it.v === 'm_scheune') barn(k, s);
    else if (it.v === 'm_bauernhaus') farmhouse(k, s);
  }
  function build(list) {
    if (!CELLS) return null; const k = new K();
    for (const it of list) if (KIT.has(it.v)) item(k, it);
    if (!k.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(k.p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(k.uv, 2));
    g.setAttribute('aCell', new THREE.Float32BufferAttribute(k.c, 4)); g.setAttribute('aGlow', new THREE.Float32BufferAttribute(k.g, 1));
    g.setAttribute('aSpin', new THREE.Float32BufferAttribute(k.s, 4));
    g.computeVertexNormals(); g.computeBoundingSphere(); return g;
  }
  // Schildanker für Text des Workers (welten.js): auf dem Brett über der Tür
  function sign(it) { const D = DIM[it.v]; if (!D) return null; return { x: 0, y: 2.8 - .15, z: (D[1] - .6) / 2 + .1, w: Math.min(D[0] - 1.6, 4.2), h: .6, st: 'mittel' }; }

  // ------------------------------------------------------------------ Material: Atlas-Zelle, Wiederholung, Nachtglühen
  function prep(sh) {
    sh.uniforms.uNight = uNight; sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aCell; attribute float aGlow; attribute vec4 aSpin; uniform float uTime; varying vec4 vCell; varying float vGlow;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCell = aCell; vGlow = aGlow;')
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
        if (aSpin.w > 5.0) { bool wh = aSpin.w > 50.0; float ry = aSpin.w - (wh ? 100.0 : 10.0), a = uTime * (wh ? -.7 : .45);
          vec3 n = vec3(sin(ry), 0.0, cos(ry)), q = transformed - aSpin.xyz; float c = cos(a), s = sin(a);
          transformed = aSpin.xyz + q * c + cross(n, q) * s + n * dot(n, q) * (1.0 - c); }`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vCell; varying float vGlow; uniform float uNight;')
      .replace('#include <map_fragment>', 'vec4 texelColor = texture2D(map, vCell.xy + fract(vUv) * vCell.zw); texelColor = mapTexelToLinear(texelColor); diffuseColor *= texelColor;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * (.35 + uNight * 1.2);');
  }
  (function tick(t) { uNight.value = X.night || 0; uTime.value = (t || 0) / 1000; requestAnimationFrame(tick); })();
  window.HXMB = { KIT, build, sign, mat, prep, uNight, get ready() { return !!CELLS; }, onReady: null };
})();
