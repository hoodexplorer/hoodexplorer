/* HoodExplorer – Mittelalter-Baukasten im Spiel (Runde 159).
   Gebäude entstehen per Seed aus wenigen Flächen; die Details sind Pixel-Texturen (ein Atlas, welten/mittel_atlas.png),
   Sticker (Fenster, Türen, Zinnen, Tor, Schilder) und Sprites (Fässer, Kisten, Heu). Entworfen in Blender
   (werkzeuge/blender/hx_lowpoly.py, hx_tex.py, hx_atlas.py), hier dieselben Regeln in three.js-Koordinaten:
   x rechts, y oben, Vorderseite +z (wie die Modelle des Workers). Ein Mesh je Kachel, ein Material für alles.
   Shader: Zelle des Atlas per Vertex-Attribut (aCell), Wiederholung per fract(), Alpha-Schnitt für Sticker,
   aGlow = leuchtet nachts (Fenster, Laternen, Esse). */
(() => {
  const X = window.HXTR; if (!X || !window.THREE || (window.HX_WELT || 'heute') !== 'mittel') return;
  let CELLS = null; const atlas = new THREE.TextureLoader().load('welten/mittel_atlas.png?v=3', t => { t.needsUpdate = true; });
  atlas.magFilter = atlas.minFilter = THREE.NearestFilter; atlas.onUpdate = () => { if (atlas.image) uAtSz.value.set(atlas.image.width, atlas.image.height); }; atlas.generateMipmaps = false; atlas.encoding = THREE.sRGBEncoding;
  fetch('welten/mittel_atlas.json?v=5').then(r => r.json()).then(j => { CELLS = j; if (window.HXMB) HXMB.onReady && HXMB.onReady(); });
  const uNight = { value: 0 }, uTime = { value: 0 }, uAtSz = { value: new THREE.Vector2(512, 512) };
  const mat = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: .5, side: THREE.DoubleSide }); mat.extensions = { derivatives: true }; // fwidth for the fade below

  // ------------------------------------------------------------------ Geometrie-Sammler mit Lage-Stapel
  class K {
    constructor() { this.p = []; this.uv = []; this.c = []; this.g = []; this.s = []; this.b = []; this.a = []; this.bc = [0, 0, 0]; this.spin = [0, 0, 0, 0]; this.T = [[0, 0, 0, 0]]; }
    push(x, y, z, r) { const [px, py, pz, pr] = this.T[this.T.length - 1], c = Math.cos(pr), s = Math.sin(pr); this.T.push([px + x * c + z * s, py + y, pz - x * s + z * c, pr + r]); }
    pop() { this.T.pop(); }
    P(x, y, z) { const [px, py, pz, pr] = this.T[this.T.length - 1], c = Math.cos(pr), s = Math.sin(pr); return [px + x * c + z * s, py + y, pz - x * s + z * c]; }
    poly(pts, uvs, cell, glow) { // Dreiecksfächer
      const C = CELLS[cell] || CELLS.c_putz; const W = pts.map(p => this.P(p[0], p[1], p[2]));
      for (let i = 1; i + 1 < W.length; i++) for (const k of [0, i, i + 1]) { this.p.push(...W[k]); this.uv.push(uvs[k][0], uvs[k][1]); this.c.push(C[0], C[1], C[2], C[3]); this.g.push(glow || 0); this.s.push(...this.spin); this.b.push(...this.bc); this.a.push(C[6] === undefined ? .5 : C[6], C[7] === undefined ? .5 : C[7], C[8] === undefined ? .5 : C[8]); }
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
  function walls(k, w, d, y, h, r, stone, putz2, hz) { // hz (Runde 167): Hansestadt - Backstein statt Bruchstein, Fachwerk mit Backstein // vier Wände: Stein als eine Fläche je Seite, Fachwerk ein Viereck je Feld
    const P = [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]];
    for (let i = 0; i < 4; i++) { const a = P[i], c = P[(i + 1) % 4], L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (stone) { k.wall(a, c, y, h, hz ? 'backstein' : 'stein', hz ? [1.6, 1.6] : [3.2, 3.2]); continue; }
      const n = Math.max(1, Math.round(L / 1.6));
      for (let j = 0; j < n; j++) k.wall([a[0] + (c[0] - a[0]) * j / n, a[1] + (c[1] - a[1]) * j / n], [a[0] + (c[0] - a[0]) * (j + 1) / n, a[1] + (c[1] - a[1]) * (j + 1) / n], y, h,
        hz ? pick(r, ['fachbs_x', 'fachbs_k', 'fachbs_leer']) : putz2 ? pick(r, ['fach2_x', 'fach2_leer']) : pick(r, FACH)); }
  }
  /* Runde 164 (phone test: gaps between roof and wall): the roof planes run exactly through the top edge of the long walls and
     the ridge - the eaves hang below the wall top - so the gable triangle (wall top → ridge) closes against the roof */
  function roof(k, w, d, h, y, tex, over = .35) { // Satteldach, First entlang x; Giebel, Windbretter mit hochgebogenen Enden
    const L = w + over * 2, S = d / 2 + over, ye = y - h * over / (d / 2), sl = Math.hypot(S, h + y - ye);
    for (const sd of [-1, 1]) k.poly([[-L / 2, ye, sd * S], [L / 2, ye, sd * S], [L / 2, y + h, 0], [-L / 2, y + h, 0]], [[0, 0], [L / 1.6, 0], [L / 1.6, sl / 1.6], [0, sl / 1.6]], tex);
    for (const e of [-1, 1]) { const x = e * w / 2;
      k.poly([[x, y, -d / 2], [x, y, d / 2], [x, y + h, 0]], [[0, 0], [d / 1.6, 0], [d / 3.2, h / 1.6]], 'putz'); // textured plaster gable, apex = ridge
      const xb = e * (L / 2 + .02);
      for (const sd of [-1, 1]) { const z0 = sd * (S + .02);
        k.poly([[xb, ye - .02, z0], [xb, y + h, 0], [xb, y + h + .18, 0], [xb, ye + .16, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_holz_d'); // slim brown boards
        k.poly([[xb, ye - .02, z0], [xb, ye + .16, z0 + sd * .2], [xb, ye + .32, z0 + sd * .2], [xb, ye + .16, z0]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_holz_d');
        k.poly([[xb, y + h, 0], [xb, y + h + .25, -sd * .22], [xb, y + h + .41, -sd * .22], [xb, y + h + .18, 0]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_holz_d'); } }
  }
  const ROOFS = ['dach_rot', 'dach_rot', 'dach_braun', 'dach_blau'], RED = ['dach_rot', 'dach_rot2', 'dach_rot3'];
  function house(k, o) { // o: {w, d, fl, seed, kind, roofs, sign}
    const r = rnd(o.seed), w = o.w, d = o.d, fl = o.fl, fh = 2.8, tex = pick(r, o.roofs || (o.hz ? RED : ROOFS)), putz2 = r() < .35, glas = pick(r, GLAS), kind = o.kind || 'haus';
    const jet = kind === 'haus' ? .5 * (fl - 1) : 0; let y = 0, ww = w - jet, dd = d - jet; // Runde 164: the top floor ends at the collision edge (camera did not clip into overhangs)
    for (let f = 0; f < fl; f++) {
      const stone = f === 0 && (r() < .55 || kind === 'turm' || kind === 'rathaus' || kind === 'taverne');
      walls(k, ww, dd, y, fh, r, stone || (o.hz && f === 0), putz2, o.hz);
      const nb = Math.max(1, Math.round(ww / 1.6));
      for (let i = 0; i < nb; i++) { const u = -ww / 2 + ww * (i + .5) / nb;
        if (f === 0 && i === Math.floor(nb / 2)) { k.sticker(stone ? 'tuer' : 'tuer_holz', u, y, dd / 2, 0); continue; }
        if (r() < .8) { const n = pick(r, [glas, glas, 'fenster_zu', 'fenster_blumen', 'fenster_licht']); k.sticker(n, u, y + .7, dd / 2, 0, Math.min(1.5, ww / nb - .1), Math.min(1.5, ww / nb - .1) * 2 / 3, .04, n === 'fenster_licht' ? 1 : 0); } } // Runde 164: window incl. shutters fits its bay
      for (const [rot, px, pz, L] of [[Math.PI, 0, -dd / 2, ww], [-Math.PI / 2, -ww / 2, 0, dd], [Math.PI / 2, ww / 2, 0, dd]]) {
        const n = Math.max(1, Math.round(L / 1.6));
        for (let i = 0; i < n; i++) if (r() < .5) { const u = -L / 2 + L * (i + .5) / n, nm = pick(r, [glas, 'fenster_zu', 'fenster_licht']);
          const sw = Math.min(1.5, L / n - .1); k.push(px, 0, pz, rot); k.sticker(nm, u, y + .7, 0, 0, sw, sw * 2 / 3, .04, nm === 'fenster_licht' ? 1 : 0); k.pop(); } }
      y += fh;
      if (f < fl - 1 && kind === 'haus') { ww += .5; dd += .5; k.poly([[-ww / 2, y, dd / 2], [ww / 2, y, dd / 2], [ww / 2, y, -dd / 2], [-ww / 2, y, -dd / 2]], [[0, 0], [1, 0], [1, 1], [0, 1]], 'c_balken'); } // closed underside of the jetty
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

  function church(k, seed, hz) { // Schiff 9 × 16, Westturm vorn (+z), Bogenfenster leuchten nachts; hz: Backsteingotik mit Kupferhelm
    const L = 16, W = 9, H = 7, ST = hz ? 'backstein' : 'stein', TT = hz ? 'backstein' : 'stein_turm', RF = hz ? 'dach_rot2' : 'dach_blau', SP = hz ? 'dach_kupfer' : 'dach_blau', RP = hz ? [1.6, 1.6] : [3.2, 3.2];
    k.box(W, L, H, 0, 0, 0, ST, RP, false);
    k.push(0, 0, 0, Math.PI / 2); roof(k, L, W, 5, H, RF); k.pop();
    for (const z of [-4.5, -1.5, 1.5, 4.5]) for (const s of [-1, 1]) { k.push(s * W / 2, 0, z, s * Math.PI / 2); k.sticker('fenster_bogen_licht', 0, 2.6, 0, 0, 0, 0, .05, 1); k.pop(); }
    const T = 5.4, tz = L / 2 + T / 2;
    const TH = hz ? 22 : 17; k.box(T, T, TH, 0, 0, tz, TT, RP, false); k.cone(T * .74, hz ? 15 : 11, 0, TH, tz, hz ? 8 : 4, SP, Math.PI / 4);
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

  // ------------------------------------------------------------------ Runde 166: Schloss und Gutshof (Port aus hx_lowpoly.py)
  /* Die Entwürfe sind in Blender-Lage geschrieben (x rechts, y nach hinten, z oben, Vorderseite -y). Der Adapter bl() setzt sie
     in three.js um: (x, y, z) → (x, z, -y); eine Drehung um z ist dieselbe wie um y. So bleibt der Code nah an der Vorlage. */
  const U1 = [[.002, .002], [.998, .002], [.998, .998], [.002, .998]], TAU = Math.PI * 2, GL = n => /_licht$|^laterne/.test(n) ? 1 : 0;
  function bl(k) {
    const b = {
      at(x, y, z, rz, fn) { k.push(x, z, -y, rz || 0); fn(); k.pop(); },
      poly(pts, uvs, cell, glow) { k.poly(pts.map(p => [p[0], p[2], -p[1]]), uvs, cell, glow); },
      wall(a, c, z0, h, cell, rep, uvs) { const L = Math.hypot(c[0] - a[0], c[1] - a[1]); if (rep) uvs = [[0, 0], [L / rep[0], 0], [L / rep[0], h / rep[1]], [0, h / rep[1]]];
        b.poly([[a[0], a[1], z0], [c[0], c[1], z0], [c[0], c[1], z0 + h], [a[0], a[1], z0 + h]], uvs || U1, cell); },
      sticker(name, x, y, z, rz = 0, w, h, out = .04) { const C = CELLS[name]; if (!C) return; w = w || C[4] / 20; h = h || C[5] / 20;
        b.at(x, y, z, rz, () => b.poly([[-w / 2, -out, 0], [w / 2, -out, 0], [w / 2, -out, h], [-w / 2, -out, h]], U1, name, GL(name))); },
      sprite(name, x, y, z = 0, kk = 1, rz = 0) { const C = CELLS[name]; if (!C) return; const w = C[4] / 20 * kk, h = C[5] / 20 * kk;
        for (const a of [rz, rz + Math.PI / 2]) { const c = Math.cos(a) * w / 2, s = Math.sin(a) * w / 2; b.poly([[x - c, y - s, z], [x + c, y + s, z], [x + c, y + s, z + h], [x - c, y - s, z + h]], U1, name); } },
      prism(r, h, x, y, z, n, cell, rep = [3.2, 3.2], top) { const Q = a => [x + Math.cos(a) * r, y + Math.sin(a) * r];
        for (let i = 0; i < n; i++) { const p = Q(i / n * TAU), q = Q((i + 1) / n * TAU), u0 = i * TAU * r / n / rep[0], u1 = (i + 1) * TAU * r / n / rep[0];
          b.poly([[...p, z], [...q, z], [...q, z + h], [...p, z + h]], [[u0, 0], [u1, 0], [u1, h / rep[1]], [u0, h / rep[1]]], cell); }
        if (top) b.poly([...Array(n)].map((_, i) => [...Q(i / n * TAU), z + h]), [...Array(n)].map(() => [.5, .5]), top); },
      cone(r, h, x, y, z, n, cell, rep = 1.6, rot = 0) { const sl = Math.hypot(r, h), wb = 2 * r * Math.sin(Math.PI / n);
        for (let i = 0; i < n; i++) { const a0 = rot + i / n * TAU, a1 = rot + (i + 1) / n * TAU;
          b.poly([[x + Math.cos(a0) * r, y + Math.sin(a0) * r, z], [x + Math.cos(a1) * r, y + Math.sin(a1) * r, z], [x, y, z + h]], [[0, 0], [wb / rep, 0], [wb / rep / 2, sl / rep]], cell); } },
      box(w, d, h, x, y, z, cell, rep = [3.2, 3.2], top = true) { const P = [[x - w / 2, y - d / 2], [x + w / 2, y - d / 2], [x + w / 2, y + d / 2], [x - w / 2, y + d / 2]];
        for (let i = 0; i < 4; i++) b.wall(P[i], P[(i + 1) % 4], z, h, cell, rep);
        if (top) b.poly(P.map(p => [...p, z + h]), [[0, 0], [w / rep[0], 0], [w / rep[0], d / rep[1]], [0, d / rep[1]]], cell); } };
    return b;
  }
  const v3 = { sub: (a, c) => [a[0] - c[0], a[1] - c[1], a[2] - c[2]], dot: (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2], len: a => Math.hypot(a[0], a[1], a[2]),
    cross: (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]] };
  v3.nrm = a => { const l = v3.len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function face(b, pts, cell, rep = [1.6, 1.6]) { // ebenes Vieleck, UV automatisch: u entlang der ersten Kante, v in der Fläche zur Mitte hin
    const q = []; for (const p of pts) if (!q.length || v3.len(v3.sub(p, q[q.length - 1])) > 1e-5) q.push(p);
    if (q.length > 2 && v3.len(v3.sub(q[0], q[q.length - 1])) < 1e-5) q.pop(); if (q.length < 3) return;
    const p0 = q[0], e1 = v3.nrm(v3.sub(q[1], p0)), n = [0, 0, 0];
    for (let i = 0; i < q.length; i++) { const a = q[i], c = q[(i + 1) % q.length]; n[0] += (a[1] - c[1]) * (a[2] + c[2]); n[1] += (a[2] - c[2]) * (a[0] + c[0]); n[2] += (a[0] - c[0]) * (a[1] + c[1]); }
    let e2 = v3.nrm(v3.cross(n, e1)); const cen = [0, 1, 2].map(j => q.reduce((s, p) => s + p[j], 0) / q.length); if (v3.dot(e2, v3.sub(cen, p0)) < 0) e2 = e2.map(v => -v);
    b.poly(q, q.map(p => [v3.dot(v3.sub(p, p0), e1) / rep[0], v3.dot(v3.sub(p, p0), e2) / rep[1]]), cell);
  }
  function walmdach(b, w, d, h, z, cell, over = .4) { // 2 Trapeze + 2 Walmdreiecke, Traufe = Wandlinie + Überstand
    if (w < d) { b.at(0, 0, 0, Math.PI / 2, () => walmdach(b, d, w, h, z, cell, over)); return; }
    const k = h / (d / 2), W = w / 2 + over, D = d / 2 + over, ze = z - over * k, zt = z + h, r = (w - d) / 2, A = [-W, -D, ze], B = [W, -D, ze], C = [W, D, ze], E = [-W, D, ze];
    if (r < 1e-3) { const F = [0, 0, zt]; for (const [p, q] of [[A, B], [B, C], [C, E], [E, A]]) face(b, [p, q, F], cell); return; }
    const F1 = [-r, 0, zt], F2 = [r, 0, zt]; face(b, [A, B, F2, F1], cell); face(b, [C, E, F1, F2], cell); face(b, [B, C, F2], cell); face(b, [E, A, F1], cell);
  }
  function krueppelwalm(b, w, d, h, z, cell, gcell, k = .35, over = .4, gover = .35, grep = [1.6, 1.6]) { // k = 0 → Satteldach
    const s = h / (d / 2), S = d / 2 + over, ze = z - over * s, zt = z + h; let xk, xr, xe, yk, zk;
    if (k <= 0) { xk = xr = xe = w / 2 + gover; yk = 0; zk = zt; } else { zk = z + h * (1 - k); yk = d / 2 * k; xk = w / 2; xr = w / 2 - yk; xe = w / 2 + gover; }
    for (const sd of [-1, 1]) { const p = [[-xe, sd * S, ze], [xe, sd * S, ze], [xk, sd * yk, zk], [xr, 0, zt], [-xr, 0, zt], [-xk, sd * yk, zk]]; face(b, sd < 0 ? p : [p[1], p[0], p[5], p[4], p[3], p[2]], cell); }
    for (const e of [-1, 1]) { if (k > 0) face(b, [[e * xk, -e * yk, zk], [e * xk, e * yk, zk], [e * xr, 0, zt]], cell);
      const x = e * w / 2, zg = k > 0 ? zk : z + h; face(b, [[x, -e * d / 2, z], [x, e * d / 2, z], [x, e * yk, zg], [x, -e * yk, zg]], gcell, grep); }
  }
  function mansarde(b, w, d, z, h1, h2, cell, cell2, inset = 1.2, over = .25) { // steiler Unterteil, flaches Walmdach darauf; gibt die Knickhöhe zurück
    const s = h1 / inset, ze = z - over * s, z1 = z + h1, ow = w / 2 + over, od = d / 2 + over, iw = w / 2 - inset, id = d / 2 - inset;
    const O = [[-ow, -od], [ow, -od], [ow, od], [-ow, od]], I = [[-iw, -id], [iw, -id], [iw, id], [-iw, id]];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; face(b, [[...O[i], ze], [...O[j], ze], [...I[j], z1], [...I[i], z1]], cell); }
    walmdach(b, w - 2 * inset, d - 2 * inset, h2, z1, cell2 || cell, 0); return z1;
  }
  function zwiebel(b, x, y, z, r, cell, n = 8) { // Zwiebelhaube: Bauch, Hals, Spitze
    const prof = [[r, 0], [r * 1.32, r * .62], [r * .42, r * 1.55], [r * .14, r * 1.9], [0, r * 2.5]], P = (rr, hh, a) => [x + Math.cos(a) * rr, y + Math.sin(a) * rr, z + hh];
    for (let j = 0; j + 1 < prof.length; j++) { const [r0, h0] = prof[j], [r1, h1] = prof[j + 1];
      for (let i = 0; i < n; i++) { const a0 = i / n * TAU, a1 = (i + 1) / n * TAU; face(b, r1 < 1e-4 ? [P(r0, h0, a0), P(r0, h0, a1), P(0, h1, a0)] : [P(r0, h0, a0), P(r0, h0, a1), P(r1, h1, a1), P(r1, h1, a0)], cell); } }
    b.cone(.08, r * .9, x, y, z + r * 2.45, 3, 'c_gold');
  }
  const frei = (p, rects, own) => rects.every((q, i) => i === own || !(q[0] + .05 < p[0] && p[0] < q[2] - .05 && q[1] + .05 < p[1] && p[1] < q[3] - .05));
  const ecken = (cx, cy, w, d) => [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]];
  function korpus(b, cx, cy, w, d, z0, sockel, fl, fh, cell, rep, sides = [1, 1, 1, 1], scell = 'sandstein') { // Baukörper ohne Deckel, gibt die Traufhöhe zurück
    const P = ecken(cx, cy, w, d);
    for (let i = 0; i < 4; i++) { if (!sides[i]) continue; const a = P[i], c = P[(i + 1) % 4]; if (sockel > 0) b.wall(a, c, z0, sockel, scell, [1.6, 1.6]); b.wall(a, c, z0 + sockel, fl * fh, cell, rep); }
    return z0 + sockel + fl * fh;
  }
  function fenster(b, r, cx, cy, w, d, z0, fl, fh, rects, own, wahl, o = {}) { // ein Fenster je Achse auf jeder Seite, nicht dort, wo ein Nachbarbau anschließt
    const bay = o.bay || 3.2, dz = o.dz != null ? o.dz : .7, sides = o.sides || [1, 1, 1, 1], size = o.size || [0, 0], P = ecken(cx, cy, w, d);
    for (let i = 0; i < 4; i++) { if (!sides[i]) continue; const a = P[i], c = P[(i + 1) % 4], L = Math.hypot(c[0] - a[0], c[1] - a[1]), th = Math.atan2(c[1] - a[1], c[0] - a[0]), nx = Math.sin(th), ny = -Math.cos(th), n = Math.max(1, Math.round(L / bay));
      for (let kk = 0; kk < n; kk++) { const u = (kk + .5) / n, px = a[0] + (c[0] - a[0]) * u, py = a[1] + (c[1] - a[1]) * u; if (!frei([px + nx * .3, py + ny * .3], rects, own)) continue;
        for (let f = 0; f < fl; f++) { if (o.skip && o.skip(i, kk, f)) continue; b.sticker(wahl(r), px, py, z0 + f * fh + dz, th, size[0], size[1]); } } }
  }
  function podest(b, x0, y0, x1, y1, cell) { // Fläche auf Bodenhöhe und Stützmauer bis tief in den Hang: am Hang schwebt nichts
    const P = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; for (let i = 0; i < 4; i++) b.wall(P[i], P[(i + 1) % 4], -14, 14.01, 'sandstein', [1.6, 1.6]);
    face(b, P.map(p => [...p, .015]), cell);
  }
  /* Maße, die auch der Worker für die Kollision kennt: Flügelform W = 9 Achsen, Pavillonform 7, Tiefe 4 Achsen à 3,2 m */
  function schloss(k, seed, form, wasser) { // Barockschloss: Mittelrisalit mit Giebel, Wappen, Portal, Freitreppe; Flügel um Ehrenhof oder Eckpavillons
    const b = bl(k), r = rnd(seed), BAY = 3.2, FH = 4.0, SO = 1.2, fl = 2, FL = form === 'fluegel';
    const putz = pick(r, ['putz_ocker', 'putz_weiss', 'putz_rose']), LIS = 'c_lis_' + putz.slice(5), dach = pick(r, ['mansarde', 'mansarde', 'walm']);
    const DS = 'dach_schiefer', REP = [3.2, 4.0], W = (FL ? 9 : 7) * BAY, D = 4 * BAY, ZT = SO + fl * FH, zi = wasser ? .6 : 0;
    const lit = r_ => r_() < .28 ? 'fenster_barock_licht' : 'fenster_barock';
    if (wasser) { // Insel, Graben, Ufermauer, Brücke mit Balustrade
      const IX = W / 2 + (FL ? 3.8 : 4.7), IY0 = -(D / 2 + (FL ? 13.4 : 8.7)), IY1 = D / 2 + (FL ? 1.5 : 4.7), M = 6;
      const In = [[-IX, IY0], [IX, IY0], [IX, IY1], [-IX, IY1]], Out = [[-IX - M, IY0 - M], [IX + M, IY0 - M], [IX + M, IY1 + M], [-IX - M, IY1 + M]];
      podest(b, -IX - M - 1, IY0 - M - 1, IX + M + 1, IY1 + M + 1, 'gras');
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4;
        face(b, [[...Out[i], .05], [...Out[j], .05], [...In[j], .05], [...In[i], .05]], 'wasser'); b.wall(In[i], In[j], 0, zi, 'sandstein', [1.6, 1.6]);
        if (i === 0) { b.wall([-1.9, Out[0][1]], Out[0], 0, .3, 'sandstein', [1.6, 1.6]); b.wall(Out[1], [1.9, Out[0][1]], 0, .3, 'sandstein', [1.6, 1.6]); }
        else b.wall(Out[j], Out[i], 0, .3, 'sandstein', [1.6, 1.6]); }
      face(b, In.map(p => [...p, zi]), 'kies');
      const y0 = IY0 - M - .3, y1 = IY0, bw = 1.9, Lb = y1 - y0;
      face(b, [[-bw, y0, .1], [bw, y0, .1], [bw, y1, zi], [-bw, y1, zi]], 'pflaster');
      for (const sx of [-1, 1]) { face(b, [[sx * bw, y0, 0], [sx * bw, y1, 0], [sx * bw, y1, zi], [sx * bw, y0, .1]], 'sandstein');
        b.poly([[sx * bw, y0, .1], [sx * bw, y1, zi], [sx * bw, y1, zi + 1], [sx * bw, y0, 1.1]], [[0, .002], [Lb / 1.6, .002], [Lb / 1.6, .998], [0, .998]], 'balustrade'); }
    } else podest(b, -W / 2 - (FL ? 2 : 5.2), FL ? -D / 2 - 3 * BAY - 9 : -D / 2 - 11.4, W / 2 + (FL ? 2 : 5.2), D / 2 + (FL ? 2 : 5.2), 'gras');
    const rects = [];
    b.at(0, 0, zi, 0, () => {
      const bodies = [['haupt', 0, 0, W, D, fl, [1, 1, 1, 1]]];
      if (FL) for (const sx of [-1, 1]) bodies.push(['fluegel', sx * (W / 2 - BAY), -D / 2 - 1.5 * BAY, 2 * BAY, 3 * BAY, fl, [1, 1, 0, 1]]);
      else for (const sx of [-1, 1]) for (const sy of [-1, 1]) bodies.push(['pavillon', sx * W / 2, sy * D / 2, 2 * BAY, 2 * BAY, fl + 1, [1, 1, 1, 1]]);
      const RW = 3 * BAY, YF = -D / 2 - .8;
      bodies.push(['risalit', 0, (YF - D / 2) / 2, RW, .8, fl, [1, 1, 0, 1]]);
      for (const q of bodies) rects.push([q[1] - q[3] / 2, q[2] - q[4] / 2, q[1] + q[3] / 2, q[2] + q[4] / 2]);
      bodies.forEach(([kind, cx, cy, w, d, f, sd], i) => {
        const zt = korpus(b, cx, cy, w, d, 0, SO, f, FH, putz, REP, sd);
        if (kind === 'risalit') { fenster(b, r, cx, cy, w, d, SO, f, FH, rects, i, lit, { size: [1.4, 2.6], sides: [1, 0, 0, 0], skip: (s, kk, f_) => s === 0 && kk === 1 && f_ === 0 }); return; }
        fenster(b, r, cx, cy, w, d, SO, f, FH, rects, i, lit, { size: [1.4, 2.6], sides: sd });
        if (kind === 'haupt') { let top;
          if (dach === 'mansarde') { const zk = mansarde(b, w, d, zt, 3.2, 1.4, DS, null, 1.4);
            for (const [side, rot] of [[0, 0], [2, Math.PI]]) for (let kk = 0; kk < Math.round(w / BAY); kk++) { const u = -w / 2 + (kk + .5) * BAY, wp = side === 0 ? [u, -d / 2 - .3] : [-u, d / 2 + .3];
              if ((side === 0 && Math.abs(u) < RW / 2) || (side === 2 && kk % 2) || !frei(wp, rects, i)) continue;
              b.at(0, 0, 0, rot, () => b.sticker(r() < .25 ? 'gaube_licht' : 'gaube', u, -d / 2, zt + .25, 0, 1.4, 2.0, .05)); }
            top = zk + 1.4; }
          else { walmdach(b, w, d, 4.0, zt, DS, .45); top = zt + 4.0; }
          if (FL) { b.prism(1.0, 2.9, 0, 0, top - 1.0, 6, LIS, [1.6, 1.6]); // Dachreiter mit Uhr und Zwiebelhaube
            for (const a of [-Math.PI / 2, -Math.PI * 5 / 6]) b.sticker('uhr_gold', Math.cos(a) * .866, Math.sin(a) * .866, top + .4, a + Math.PI / 2, .7, .7, .02);
            zwiebel(b, 0, 0, top + 1.9, 1.0, 'dach_kupfer', 6); } }
        else if (kind === 'fluegel') b.at(cx, cy, 0, 0, () => { if (dach === 'mansarde') mansarde(b, w, d, zt, 2.8, 1.0, DS, null, 1.1); else walmdach(b, w, d, 3.2, zt, DS, .45); });
        else b.at(cx, cy, 0, 0, () => { if (dach === 'mansarde') { const z1 = mansarde(b, w, d, zt, 2.6, 1.8, DS, null, 1.0); b.cone(.1, 1.2, 0, 0, z1 + 1.7, 3, 'c_gold'); }
          else { walmdach(b, w, d, 4.6, zt, DS, .4); b.cone(.1, 1.2, 0, 0, zt + 4.5, 3, 'c_gold'); } });
      });
      const e = RW / 2, GH = 2.0, sl = GH / e, yb = -D / 2 + 3.4; // Mittelrisalit: Dreiecksgiebel, Giebeldach, Gesims, Wappen, Portal, Freitreppe
      face(b, [[-e, YF, ZT], [e, YF, ZT], [0, YF, ZT + GH]], LIS);
      for (const sx of [-1, 1]) { const q = [[sx * (e + .35), YF - .3, ZT - .35 * sl], [0, YF - .3, ZT + GH + .02], [0, yb, ZT + GH + .02], [sx * (e + .35), yb, ZT - .35 * sl]];
        face(b, sx < 0 ? q : [q[3], q[2], q[1], q[0]], DS);
        b.poly([q[0], q[1], [0, YF - .3, ZT + GH - .25], [sx * (e + .35), YF - .3, ZT - .35 * sl - .27]], [[.5, .5], [.5, .5], [.5, .5], [.5, .5]], LIS); }
      b.sticker(pick(r, ['wappen', 'wappen_rot']), 0, YF, ZT + .15, 0, 1.3, 1.5, .05); b.sticker('portal', 0, YF, SO, 0, 2.8, 4.2, .05);
      const ty = YF - 2.6; face(b, [[-1.8, ty, 0], [1.8, ty, 0], [1.8, YF, SO], [-1.8, YF, SO]], 'treppe');
      for (const sx of [-1, 1]) { face(b, [[sx * 1.8, ty, 0], [sx * 1.8, YF, 0], [sx * 1.8, YF, SO]], 'sandstein'); b.sticker('laterne', sx * 2.1, YF, SO + 2.2, 0, 0, 0, .1); }
      if (FL && wasser) for (const sx of [-1, 1]) { const tx = sx * W / 2, ty2 = -D / 2 - 3 * BAY, TR = 2.3, TH = ZT + 3.0; // Ecktürme mit Zwiebelhauben
        b.prism(TR, TH, tx, ty2, 0, 8, putz, [3.2, 4.0]); zwiebel(b, tx, ty2, TH, TR, 'dach_kupfer');
        for (let kk = 0; kk < 8; kk++) { const a = (kk + .5) / 8 * TAU, dx = Math.cos(a), dy = Math.sin(a); if (dx * sx - dy < .55) continue;
          for (const zz of [SO + .7, SO + FH + .7, SO + 2 * FH + .4]) b.sticker(lit(r), tx + dx * TR * .924, ty2 + dy * TR * .924, zz, a + Math.PI / 2, 1.0, 1.85, .05); } }
      const hy0 = FL ? -D / 2 - 3 * BAY : YF - 2.6, hx_ = FL ? W / 2 - 2 * BAY : W / 2 - BAY; // Ehrenhof / Garten
      if (!wasser) face(b, [[-hx_, hy0 - 8, .03], [hx_, hy0 - 8, .03], [hx_, -D / 2, .03], [-hx_, -D / 2, .03]], 'kies');
      if (FL) { const by = -D / 2 - 1.5 * BAY - 1.0; b.prism(1.5, .7, 0, by, 0, 6, 'sandstein', [1.6, 1.6], 'wasser'); b.sprite('statue', 0, by, .7, .7);
        for (const sx of [-1, 1]) for (let kk = 0; kk < 3; kk++) b.sprite('formbaum', sx * (hx_ - 1.2), -D / 2 - 1.6 - kk * 3.0, 0, 1.0); }
      else for (const sx of [-1, 1]) { for (let kk = 0; kk < 3; kk++) b.sprite('formbaum', sx * (2.6 + kk * 2.6), YF - 4.5, 0, 1.0); b.sprite('statue', sx * 2.4, YF - 2.0, 0, .9); }
    });
  }
  function gutshof(k, seed, sx, nbW, torh) { // Hof-Karree: Herrenhaus hinten, Scheune und Stall an den Seiten (sx spiegelt), Hofmauer mit offenem Tor vorn
    const b = bl(k), r = rnd(seed), HX = 12, HY0 = -12, HY1 = 10;
    const hmat = pick(r, ['putz_weiss', 'putz_ocker', 'backstein']), hroof = pick(r, ['walm', 'krueppel', 'mansarde']);
    const hdach = hroof !== 'mansarde' ? pick(r, ['dach_rot', 'dach_rot2', 'dach_schiefer']) : pick(r, ['dach_schiefer', 'dach_rot2']);
    const nb = nbW || pick(r, [4, 5]), hw = nb * 3.2, hd = 9.6, FH = 3.6, SO = .6, fl = pick(r, [1, 2, 2]);
    const sw = 19.2, sd = 11.2, sh = 5.6, tw = 17.6, td = 8.0, th = 3.2, sl_ = HX + sd, sr_ = HX + td, left = sx > 0 ? -sl_ : -sr_, right = sx > 0 ? sr_ : sl_;
    podest(b, left - 1, HY0 - 7.5, right + 1, HY1 + hd + 1, 'gras');
    face(b, [[-HX, HY0, .03], [HX, HY0, .03], [HX, HY1, .03], [-HX, HY1, .03]], 'feldstein'); face(b, [[-2.2, HY0 - 7, .03], [2.2, HY0 - 7, .03], [2.2, HY0, .03], [-2.2, HY0, .03]], 'feldstein');
    b.at(0, HY1 + hd / 2, 0, 0, () => { // Herrenhaus
      const rep = hmat !== 'backstein' ? [3.2, FH] : [1.6, 1.6], zt = korpus(b, 0, 0, hw, hd, 0, SO, fl, FH, hmat, rep), mid = Math.floor(nb / 2);
      const wf = hmat !== 'backstein' ? (r_ => r_() < .3 ? 'fenster_barock_licht' : 'fenster_barock') : (r_ => pick(r_, ['fenster_teal_gruen', 'fenster_teal_gruen', 'fenster_licht', 'fenster_blumen']));
      fenster(b, r, 0, 0, hw, hd, SO, fl, FH, [], -1, wf, { dz: .6, size: hmat !== 'backstein' ? [1.2, 2.2] : [2.4, 1.6], skip: (s, kk, f) => s === 0 && f === 0 && kk === mid });
      const u = -hw / 2 + (mid + .5) * 3.2; b.sticker('tuer_gut', u, -hd / 2, SO - .1, 0, 1.6, 3.0);
      face(b, [[u - 1.3, -hd / 2 - 1.2, SO - .1], [u + 1.3, -hd / 2 - 1.2, SO - .1], [u + 1.3, -hd / 2, SO - .1], [u - 1.3, -hd / 2, SO - .1]], 'sandstein');
      b.wall([u - 1.3, -hd / 2 - 1.2], [u + 1.3, -hd / 2 - 1.2], 0, SO - .1, 'treppe', null, [[0, 0], [1.6, 0], [1.6, .3], [0, .3]]);
      for (const e of [-1, 1]) face(b, [[u + e * 1.3, -hd / 2 - 1.2, 0], [u + e * 1.3, -hd / 2, 0], [u + e * 1.3, -hd / 2, SO - .1], [u + e * 1.3, -hd / 2 - 1.2, SO - .1]], 'sandstein');
      if (hroof === 'walm') walmdach(b, hw, hd, 4.2, zt, hdach, .5);
      else if (hroof === 'krueppel') krueppelwalm(b, hw, hd, 4.6, zt, hdach, hmat, .35, .5, .35, rep);
      else { mansarde(b, hw, hd, zt, 2.8, 1.2, hdach, null, 1.2); for (let kk = 0; kk < nb; kk++) if (kk !== mid) b.sticker('gaube', -hw / 2 + (kk + .5) * 3.2, -hd / 2, zt + .25, 0, 1.3, 1.85, .05); }
      b.box(.8, .8, hroof !== 'mansarde' ? 6.5 : 5.0, hw * .3, 1.2, zt, 'backstein', [1.6, 1.6]); });
    const smat = pick(r, ['fachbs_leer', 'backstein', 'fachbs_leer']), srep = smat.startsWith('fach') ? [1.6, 2.8] : [1.6, 1.6], rot = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    b.at(-sx * (HX + sd / 2), HY1 - sw / 2, 0, rot, () => { // Scheune, Front zur Hofmitte
      korpus(b, 0, 0, sw, sd, 0, 0, 1, sh, smat, srep); krueppelwalm(b, sw, sd, 6.0, sh, pick(r, ['dach_rot', 'dach_rot3', 'dach_stroh']), 'bretter', .3, .6, .4);
      b.sticker('scheunentor', 0, -sd / 2, 0, 0, 3.6, 4.4); for (const u of [-6.4, 6.4]) b.sticker('fenster_stall', u, -sd / 2, 2.6, 0);
      b.at(0, 0, 0, Math.PI, () => b.sticker('scheunentor', 0, -sd / 2, 0, 0, 3.6, 4.4));
      b.sticker('wagen', -4.2, -sd / 2 - 2.0, 0, .35, 0, 0, 0); b.sprite('strohballen', 4.6, -sd / 2 - 1.2, 0, 1.0, .4); b.sprite('strohballen', 5.8, -sd / 2 - 1.5, 0, 1.0, 1.1); b.sprite('strohballen_eckig', 3.2, -sd / 2 - .9, 0, 1.0, .2); });
    b.at(sx * (HX + td / 2), HY1 - tw / 2, 0, -rot, () => { // Stall
      korpus(b, 0, 0, tw, td, 0, 0, 1, th, 'backstein', [1.6, 1.6]); krueppelwalm(b, tw, td, 3.4, th, pick(r, ['dach_rot2', 'dach_rot']), 'backstein', 0, .5, .35);
      for (let i = 0; i < 6; i++) { const u = -tw / 2 + (i + .5) * tw / 6; if (i === 1 || i === 4) b.sticker('tuer_holz', u, -td / 2, 0, 0); else b.sticker('fenster_stall', u, -td / 2, 1.5, 0); }
      for (let i = 0; i < 5; i++) b.sticker('fenster_stall', -tw / 2 + (i + .5) * tw / 5, td / 2, 1.5, Math.PI);
      b.sprite('huehner', -1.0, -td / 2 - 1.6, 0, 1.0, .3); b.sprite('huehner', 2.2, -td / 2 - 2.6, 0, 1.0, 1.4); b.sprite('fass', tw / 2 - 1.0, -td / 2 - .6); b.sprite('kiste', tw / 2 - 2.0, -td / 2 - .6); });
    const MH = 2.2, MT = .5, GW = 2.2, mauer = (a, c) => { const L = Math.hypot(c[0] - a[0], c[1] - a[1]), nx = (c[1] - a[1]) / L * MT / 2, ny = -(c[0] - a[0]) / L * MT / 2;
      const A1 = [a[0] + nx, a[1] + ny], C1 = [c[0] + nx, c[1] + ny], A2 = [a[0] - nx, a[1] - ny], C2 = [c[0] - nx, c[1] - ny];
      b.wall(A1, C1, 0, MH, 'backstein', [1.6, 1.6]); b.wall(C2, A2, 0, MH, 'backstein', [1.6, 1.6]); face(b, [[...A1, MH], [...C1, MH], [...C2, MH], [...A2, MH]], 'c_ziegel'); };
    mauer([left, HY0], [-GW - .4, HY0]); mauer([GW + .4, HY0], [right, HY0]);
    mauer([left, HY0], [left, sx > 0 ? HY1 - sw : HY1 - tw]); mauer([right, HY0], [right, sx > 0 ? HY1 - tw : HY1 - sw]);
    mauer([-HX, HY1 + .25], [-hw / 2, HY1 + .25]); mauer([hw / 2, HY1 + .25], [HX, HY1 + .25]);
    if (torh) { const TD = 5, TH = 5.4; // Runde 167: Torhaus über der Einfahrt - zwei Pfeilerbauten, Raum über der Durchfahrt, Walmdach, Wappen
      for (const e of [-1, 1]) b.box(2.4, TD, TH, e * 2.6, HY0, 0, 'backstein', [1.6, 1.6], false);
      b.box(2.8, TD, TH - 3.4, 0, HY0, 3.4, 'backstein', [1.6, 1.6], false);
      b.poly([[-1.4, HY0 - TD / 2, 3.4], [1.4, HY0 - TD / 2, 3.4], [1.4, HY0 + TD / 2, 3.4], [-1.4, HY0 + TD / 2, 3.4]], U1, 'c_holz_d');
      b.at(0, HY0, 0, 0, () => walmdach(b, 7.6, TD, 2.6, TH, 'dach_rot', .35));
      b.sticker(pick(r, ['wappen', 'wappen_rot']), 0, HY0 - TD / 2, 3.7, 0, 1.0, 1.15, .05); b.sticker('fenster_stall', 0, HY0 + TD / 2, 3.8, Math.PI); }
    else for (const e of [-1, 1]) { b.box(.9, .9, 3.0, e * (GW + .45), HY0, 0, 'backstein', [1.6, 1.6], false); b.cone(.75, .8, e * (GW + .45), HY0, 3.0, 4, 'c_ziegel', 1.6, Math.PI / 4);
      const hx0 = e * GW, px = hx0 - e * GW * Math.cos(1.15), py = HY0 + GW * Math.sin(1.15), u0 = e < 0 ? .002 : .998; // Torflügel nach innen offen
      b.poly([[hx0, HY0, .05], [px, py, .05], [px, py, 2.85], [hx0, HY0, 2.85]], [[u0, .002], [.5, .002], [.5, .998], [u0, .998]], 'hoftor'); }
    b.cone(1.8, 1.1, sx * 3.5, -3.0, 0, 6, 'mist', 1.6); const wx = -sx * 3.0; // Misthaufen; Ziehbrunnen oder Taubenhaus
    if (r() < .5) { b.prism(.9, .8, wx, 2.0, 0, 6, 'stein', [1.6, 1.6], 'wasser'); for (const e of [-1, 1]) b.box(.15, .15, 2.4, wx + e * .85, 2.0, 0, 'c_holz_d', [3.2, 3.2], false);
      face(b, [[wx - 1.2, 1.1, 2.2], [wx + 1.2, 1.1, 2.2], [wx + 1.2, 2.0, 2.9], [wx - 1.2, 2.0, 2.9]], 'dach_rot'); face(b, [[wx + 1.2, 2.9, 2.2], [wx - 1.2, 2.9, 2.2], [wx - 1.2, 2.0, 2.9], [wx + 1.2, 2.0, 2.9]], 'dach_rot'); }
    else { b.box(.25, .25, 3.2, wx, 2.0, 0, 'c_holz_d', [3.2, 3.2], false); b.box(1.4, 1.4, 1.2, wx, 2.0, 3.2, 'putz', [1.6, 1.6], false);
      for (const rr of [0, -Math.PI / 2, Math.PI / 2, Math.PI]) b.at(wx, 2.0, 0, rr, () => b.sticker('taubenschlag', 0, -.7, 3.2, 0, 1.4, 1.2, .03)); b.cone(1.15, 1.3, wx, 2.0, 4.4, 4, 'dach_rot', 1.6, Math.PI / 4); }
    b.sprite('fass', -sx * 7.0, 7.5); b.sprite('kiste', -sx * 7.8, 7.0); b.sprite('heu', sx * 6.0, 6.5, 0, .8);
  }

  // ------------------------------------------------------------------ Runde 167: Nebengebäude (Kapelle, Remise, Orangerie)
  function chapel(k, seed) { // Hof- oder Dorfkapelle: Schiff 6 × 10, halbrunde Apsis hinten, Dachreiter mit Glocke vorn, Tür im Giebel (+z)
    const r = rnd(seed), W = 6, L = 10, H = 4.6, wall = pick(r, ['stein', 'putz_weiss', 'backstein']), dach = pick(r, ['dach_rot', 'dach_rot2', 'dach_schiefer']);
    k.box(W, L, H, 0, 0, 0, wall, [3.2, 3.2], false);
    k.push(0, 0, 0, Math.PI / 2); roof(k, L, W, 3.4, H, dach, .3); k.pop();
    k.prism(2.6, H - .5, 0, 0, -L / 2, 8, wall); k.cone(2.9, 2.4, 0, H - .5, -L / 2, 8, dach, Math.PI / 8);
    for (const z of [-2.6, 0, 2.6]) for (const s of [-1, 1]) { k.push(s * W / 2, 0, z, s * Math.PI / 2); const lit = r() < .3; k.sticker(lit ? 'fenster_bogen_licht' : 'fenster_bogen', 0, 1.7, 0, 0, 0, 0, .05, lit ? 1 : 0); k.pop(); }
    k.sticker('tuer', 0, 0, L / 2, 0); k.sticker('fenster_bogen', 0, 3.4, L / 2, 0, .9, 1.3, .05);
    k.box(1.1, 1.1, 1.9, 0, H + 2.4, L / 2 - 1.3, 'c_holz_d', [1.6, 1.6], false); k.cone(.95, 2.3, 0, H + 4.3, L / 2 - 1.3, 4, 'dach_schiefer', Math.PI / 4);
    k.sticker('c_eisen', 0, H + 2.9, L / 2 - .74, 0, .5, .6, .02); // Glocke im Dachreiter
    k.sprite('busch', -3.8, 0, 3.4, .9); k.sprite('blumen', 2.2, 0, 5.6, 1.1);
  }
  function remise(k, seed) { // Wagenremise: drei offene Tore nach vorn (+z), Wagen und Stroh darin
    const r = rnd(seed), W = 12, D = 6, H = 3.6, m = pick(r, ['backstein', 'bretter']);
    k.wall([-W / 2, -D / 2], [W / 2, -D / 2], 0, H, m, [1.6, 1.6]); k.wall([-W / 2, D / 2], [-W / 2, -D / 2], 0, H, m, [1.6, 1.6]); k.wall([W / 2, -D / 2], [W / 2, D / 2], 0, H, m, [1.6, 1.6]);
    for (const x of [-W / 2 + .3, -2, 2, W / 2 - .3]) k.box(.6, .6, H, x, 0, D / 2 - .3, m, [1.6, 1.6], false);
    k.wall([-W / 2, D / 2], [W / 2, D / 2], H - .7, .7, m, [1.6, 1.6]);
    k.poly([[-W / 2, .02, D / 2], [W / 2, .02, D / 2], [W / 2, .02, -D / 2], [-W / 2, .02, -D / 2]], [[0, 0], [W / 1.6, 0], [W / 1.6, D / 1.6], [0, D / 1.6]], 'kies');
    roof(k, W, D, 2.2, H, pick(r, ['dach_rot', 'dach_rot2', 'dach_stroh']), .4);
    k.sticker('wagen', -4, 0, -1.6, 0, 0, 0, 0); k.sprite('strohballen', 0, 0, -1.2, 1.0, .3); k.sprite('kiste', 4, 0, -1.6); k.sprite('fass', 4.8, 0, -.6);
  }
  function orangerie(k, seed) { // langer Gartensaal: Sandsteinsockel, hohe Bogenfenster, Walmdach, Kübelbäume davor (+z)
    const r = rnd(seed), W = 26, D = 8, H = 5.2, p = pick(r, ['putz_ocker', 'putz_weiss', 'putz_rose']);
    k.box(W, D, .8, 0, 0, 0, 'sandstein', [1.6, 1.6], false); k.box(W, D, H - .8, 0, .8, 0, p, [3.2, 4.0], false);
    walmdach(bl(k), W, D, 2.0, H, 'dach_schiefer', .4);
    for (let i = 0; i < 9; i++) { const x = -W / 2 + (i + .5) * W / 9;
      if (i === 4) { k.sticker('portal', x, .8, D / 2, 0, 2.4, 3.8, .05); k.sticker(pick(r, ['wappen', 'wappen_rot']), x, 4.0, D / 2, 0, 1.0, 1.15, .06); continue; }
      const lit = r() < .3; k.sticker(lit ? 'fenster_bogen_licht' : 'fenster_bogen', x, 1.2, D / 2, 0, 1.8, 3.2, .05, lit ? 1 : 0);
      if (i < 8) k.sprite('formbaum', x + W / 18, 0, D / 2 + 2.2, .85); }
    for (const s of [-1, 1]) { k.push(s * W / 2, 0, 0, s * Math.PI / 2); k.sticker('fenster_bogen', 0, 1.2, 0, 0, 1.6, 2.8, .05); k.pop(); }
  }
  // ------------------------------------------------------------------ Modell-Namen des Workers → Baukasten
  const DIM = { m_haus_a: [8.7, 10.7, 2], m_haus_b: [7.7, 11.7, 3], m_haus_c: [9.7, 10.7, 2], m_haus_d: [8.7, 12.7, 3], m_laden_a: [8.7, 10.7, 2], m_laden_b: [9.7, 11.7, 3],
    m_taverne: [10.7, 12.7, 3], m_rathaus: [14.7, 12.7, 3] };
  const KIT = new Set([...Object.keys(DIM), 'm_burg', 'm_kirche', 'm_brunnen', 'm_stand_a', 'm_stand_b', 'm_stufe', 'm_windmuehle', 'm_wassermuehle', 'm_scheune', 'm_bauernhaus', 'm_schloss', 'm_gutshof', 'm_kapelle', 'm_remise', 'm_orangerie']);
  const BR = { m_burg: -1, m_schloss: -1, m_gutshof: -1, m_kirche: 10, m_orangerie: 13, m_windmuehle: 4.5, m_wassermuehle: 6, m_scheune: 8, m_bauernhaus: 6, m_kapelle: 6, m_remise: 6.5, m_brunnen: 0, m_stand_a: 0, m_stand_b: 0, m_stufe: 0 };
  const seedOf = it => (Math.abs(Math.round(it.x * 7.31) * 73856093 ^ Math.round(it.z * 3.17) * 19349663) % 2147483646) + 1;
  function item(k, it) {
    k.T = [[it.x, it.y, it.z, it.ry]]; const s = seedOf(it), D0 = DIM[it.v];
    k.bc = [it.x, it.z, D0 ? Math.hypot(D0[0], D0[1]) / 2 * .85 : BR[it.v] !== undefined ? BR[it.v] : 5]; // Runde 167: see-through per building, like today's world
    if (DIM[it.v]) { const [w, d, fl] = DIM[it.v], kind = it.v === 'm_taverne' ? 'taverne' : it.v === 'm_rathaus' ? 'rathaus' : 'haus';
      house(k, { w: w - .4, d: d - .6, fl: kind === 'haus' ? fl - (fl === 3 && (s % 3 === 0) ? 1 : 0) : fl, seed: s, kind, sign: !!it.t, hz: it.f === 'h' }); }
    else if (it.v === 'm_burg') castle(k, s);
    else if (it.v === 'm_kirche') church(k, s, it.f === 'h');
    else if (it.v === 'm_kapelle') chapel(k, s);
    else if (it.v === 'm_remise') remise(k, s);
    else if (it.v === 'm_orangerie') orangerie(k, s);
    else if (it.v === 'm_brunnen') well(k);
    else if (it.v === 'm_stand_a' || it.v === 'm_stand_b') stall(k, s);
    else if (it.v === 'm_stufe') k.box(5.2, 1, it.sy, 0, 0, 0, 'stein', [3.2, 3.2]);
    else if (it.v === 'm_windmuehle') windmill(k, s);
    else if (it.v === 'm_wassermuehle') watermill(k, s);
    else if (it.v === 'm_scheune') barn(k, s);
    else if (it.v === 'm_bauernhaus') farmhouse(k, s);
    else if (it.v === 'm_schloss') schloss(k, s, it.f && it.f[0] === 'p' ? 'pavillon' : 'fluegel', !!(it.f && it.f[1] === 'w')); // Grundform vom Worker (passt zur Kollision)
    else if (it.v === 'm_gutshof') gutshof(k, s, it.f && it.f[0] === 'l' ? -1 : 1, it.f ? +it.f[1] : 0, !!(it.f && it.f[2] === 't'));
  }
  function build(list) {
    if (!CELLS) return null; const k = new K();
    for (const it of list) if (KIT.has(it.v)) item(k, it);
    if (!k.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(k.p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(k.uv, 2));
    g.setAttribute('aCell', new THREE.Float32BufferAttribute(k.c, 4)); g.setAttribute('aGlow', new THREE.Float32BufferAttribute(k.g, 1));
    g.setAttribute('aSpin', new THREE.Float32BufferAttribute(k.s, 4)); g.setAttribute('aBld', new THREE.Float32BufferAttribute(k.b, 3)); g.setAttribute('aAvg', new THREE.Float32BufferAttribute(k.a, 3));
    g.computeVertexNormals(); g.computeBoundingSphere(); return g;
  }
  // Schildanker für Text des Workers (welten.js): auf dem Brett über der Tür
  function sign(it) { const D = DIM[it.v]; if (!D) return null; return { x: 0, y: 2.8 - .15, z: (D[1] - .6) / 2 + .1, w: Math.min(D[0] - 1.6, 4.2), h: .6, st: 'mittel' }; }

  // ------------------------------------------------------------------ Material: Atlas-Zelle, Wiederholung, Nachtglühen
  /* Runde 167 (phone test: houses cut open when turning, a circle in the diorama): like today's world, a building that really stands
     between the figure and the camera dissolves as a whole into a pixel pattern (72 % of its pixels); big estates (castle, palace,
     manor) only get a small dithered hole along the line of sight. Before, a hard 12 m cylinder cut everything near the view line. */
  function prep(sh, U) {
    sh.uniforms.uNight = uNight; sh.uniforms.uTime = uTime; sh.uniforms.uAtSz = uAtSz;
    const see = !!(U && U.uPlayer); if (see) { sh.uniforms.uPlayer = U.uPlayer; sh.uniforms.uToCam = U.uToCam; sh.uniforms.uCamDist = U.uCamDist; }
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aCell; attribute float aGlow; attribute vec4 aSpin; attribute vec3 aBld; attribute vec3 aAvg; uniform float uTime; varying vec4 vCell; varying float vGlow; varying vec3 vBld; varying vec3 vWp; varying vec3 vAvg;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCell = aCell; vGlow = aGlow; vBld = aBld; vAvg = aAvg;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
        if (aSpin.w > 5.0) { bool wh = aSpin.w > 50.0; float ry = aSpin.w - (wh ? 100.0 : 10.0), a = uTime * (wh ? -.7 : .45);
          vec3 n = vec3(sin(ry), 0.0, cos(ry)), q = transformed - aSpin.xyz; float c = cos(a), s = sin(a);
          transformed = aSpin.xyz + q * c + cross(n, q) * s + n * dot(n, q) * (1.0 - c); }`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vCell; varying float vGlow; uniform float uNight; varying vec3 vBld; varying vec3 vWp; varying vec3 vAvg; uniform vec2 uAtSz;' + (see ? '\nuniform vec3 uPlayer; uniform vec3 uToCam; uniform float uCamDist;\nfloat hxB2(vec2 a){a=floor(a);return fract(a.x*0.5+a.y*a.y*0.75);} float hxBayer(vec2 a){return hxB2(0.5*a)*0.25+hxB2(a);}' : ''))
      .replace('void main() {', see ? `void main() {
        if (vBld.z != 0.0 && uCamDist > 0.5) { float hl = max(length(uToCam.xz), 1e-4); vec2 tc = uToCam.xz / hl; float ch = uCamDist * hl;
          if (vBld.z > 0.0) { vec2 c = vBld.xy - uPlayer.xz; float s = dot(c, tc), d = abs(c.x * tc.y - c.y * tc.x);
            if (s > 0.0 && s - vBld.z < min(ch, vBld.z + 16.0) && d < vBld.z * 0.8 && hxBayer(gl_FragCoord.xy) < 0.72) discard; }
          else { vec3 rel = vWp - uPlayer - vec3(0.0, 1.0, 0.0); float s = dot(rel, uToCam);
            if (s > 0.3 && s < uCamDist && dot(rel.xz, uToCam.xz) > 0.4) { float dl = length(rel - uToCam * s); if (dl < 4.5 && hxBayer(gl_FragCoord.xy) < 0.85 * (1.0 - smoothstep(2.5, 4.5, dl))) discard; } } }` : 'void main() {')
      .replace('#include <map_fragment>', `vec4 texelColor = texture2D(map, vCell.xy + fract(vUv) * vCell.zw);
        vec2 hxTp = fwidth(vUv) * vCell.zw * uAtSz; // Runde 168: texels per screen pixel - where a texel gets smaller than a pixel (far away, Px 2 on phones)
        if (vAvg.r >= 0.0) texelColor.rgb = mix(texelColor.rgb, vAvg, smoothstep(0.75, 1.5, sqrt(hxTp.x * hxTp.y))); // fine bricks and tiles fade to their mean colour instead of flickering
        texelColor = mapTexelToLinear(texelColor); diffuseColor *= texelColor;`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * (.35 + uNight * 1.2);');
  }
  (function tick(t) { uNight.value = X.night || 0; uTime.value = (t || 0) / 1000; requestAnimationFrame(tick); })();
  window.HXMB = { KIT, build, sign, mat, prep, uNight, get ready() { return !!CELLS; }, onReady: null };
})();
