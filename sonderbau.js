/* HoodExplorer – Sonderbau-Baukasten im Worker (Runde 206).
   Bekannte Bauwerke als eigene Modelle statt geratener Klötze. Dieselben Module und Rezepte wie in Blender
   (werkzeuge/blender/hx_sonderbau.py), hier in JavaScript. Koordinaten der Rezepte wie in Blender: x rechts, y nach hinten,
   z oben, Vorderseite = -y, Meter. Ausgabe: Dreiecke für eine Geo des Workers (Spielkoordinaten: x, y oben, z), schlichte
   Farbflächen ohne Fensterraster des Haus-Shaders. Das Verzeichnis SONDER.list nennt je Bauwerk Lage (Mitte), Blickrichtung
   der Hauptfassade (Kompass, Grad) und Rezept. */
(() => {
  const HEX = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  const C = {
    dom: '#6f675d', dom_l: '#8a8174', dom_d: '#4f4943', blei: '#4d5560', blei_d: '#3a4049',
    sand: '#d8c69a', sand_l: '#e8dab4', sand_d: '#b39f73', weiss: '#eeeae0', weiss_d: '#d3cfc4', schiefer: '#5b6b88', schiefer_d: '#46536b',
    ziegel: '#a4472f', ziegel_d: '#7e3524', ziegel_l: '#b85a3e', glasur: '#2c2a2a', kupfer: '#64a08a', kupfer_d: '#4c806c',
    gold: '#e2b443', glas: '#9fd0e8', glas_d: '#6fa6c6', beton: '#c9c9c4', beton_d: '#a6a6a0', stahl: '#b8bcc2', fels: '#8a8578', fels_d: '#6c685e',
    rot: '#c8463a', fenster: '#2b2f3a', fenster_l: '#3f4a63', gras: '#62bd4d', putz_rot: '#c46a4c', backstein: '#8e4a35' };
  const COL = {}; for (const k in C) COL[k] = HEX(C[k]);
  const M = k => COL[k] || HEX(k);
  const TAU = Math.PI * 2;

  // ---------------------------------------------------------------- Sammler: Formen mit Lage-Stapel (Drehung nur um z)
  class B {
    constructor() { this.shapes = []; this.T = [[0, 0, 0, 0]]; }
    P(x, y, z) { const [tx, ty, tz, a] = this.T[this.T.length - 1], c = Math.cos(a), s = Math.sin(a); return [tx + x * c - y * s, ty + x * s + y * c, tz + z]; }
    at(x, y, z, rz, fn) { const [tx, ty, tz, a] = this.T[this.T.length - 1], c = Math.cos(a), s = Math.sin(a); this.T.push([tx + x * c - y * s, ty + x * s + y * c, tz + z, a + (rz || 0)]); try { fn(); } finally { this.T.pop(); } }
    add(V, F, col, convex = true) { this.shapes.push({ V: V.map(p => this.P(p[0], p[1], p[2])), F, col, convex }); }
    box(w, d, h, x, y, z, col, rz = 0) { const c = Math.cos(rz), s = Math.sin(rz), hw = w / 2, hd = d / 2, L = (u, v, q) => [x + u * c - v * s, y + u * s + v * c, z + q];
      this.add([L(-hw, -hd, 0), L(hw, -hd, 0), L(hw, hd, 0), L(-hw, hd, 0), L(-hw, -hd, h), L(hw, -hd, h), L(hw, hd, h), L(-hw, hd, h)], [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], col); }
    beam(a, b, t, col) { const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]); if (L < 1e-6) return;
      const z = d.map(v => v / L), up = Math.abs(z[2]) < .9 ? [0, 0, 1] : [1, 0, 0];
      let xv = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]; const xl = Math.hypot(...xv); xv = xv.map(v => v / xl);
      const yv = [z[1] * xv[2] - z[2] * xv[1], z[2] * xv[0] - z[0] * xv[2], z[0] * xv[1] - z[1] * xv[0]], h = t / 2, V = [];
      for (const q of [0, L]) for (const [u, v] of [[-h, -h], [h, -h], [h, h], [-h, h]]) V.push([a[0] + xv[0] * u + yv[0] * v + z[0] * q, a[1] + xv[1] * u + yv[1] * v + z[1] * q, a[2] + xv[2] * u + yv[2] * v + z[2] * q]);
      this.add(V, [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], col); }
    cyl(r0, r1, h, x, y, z, col, n = 8, axis = 'Z', rot = 0) { const V = [], F = [];
      for (let i = 0; i < n; i++) { const a = i / n * TAU + rot; V.push([Math.cos(a) * r0, Math.sin(a) * r0, 0], [Math.cos(a) * r1, Math.sin(a) * r1, h]); }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; F.push([2 * i, 2 * j, 2 * j + 1, 2 * i + 1]); }
      F.push([...Array(n).keys()].reverse().map(i => 2 * i)); if (r1 > 1e-4) F.push([...Array(n).keys()].map(i => 2 * i + 1));
      const T = axis === 'Y' ? p => [x + p[0], y + (p[2] - h / 2), z - p[1]] : axis === 'X' ? p => [x + (p[2] - h / 2), y + p[1], z - p[0]] : p => [x + p[0], y + p[1], z + p[2]];
      this.add(V.map(T), F, col); }
    gable(w, d, h, x, y, z, col, ridge = 'X') { const hw = w / 2, hd = d / 2; let V, F;
      if (ridge === 'X') { V = [[-hw, -hd, 0], [hw, -hd, 0], [hw, hd, 0], [-hw, hd, 0], [-hw, 0, h], [hw, 0, h]]; F = [[0, 3, 2, 1], [0, 1, 5, 4], [2, 3, 4, 5], [0, 4, 3], [1, 2, 5]]; }
      else { V = [[-hw, -hd, 0], [hw, -hd, 0], [hw, hd, 0], [-hw, hd, 0], [0, -hd, h], [0, hd, h]]; F = [[0, 3, 2, 1], [1, 2, 5, 4], [3, 0, 4, 5], [0, 1, 4], [2, 3, 5]]; }
      this.add(V.map(p => [p[0] + x, p[1] + y, p[2] + z]), F, col); }
    pyramid(w, d, h, x, y, z, col) { const hw = w / 2, hd = d / 2; this.add([[x - hw, y - hd, z], [x + hw, y - hd, z], [x + hw, y + hd, z], [x - hw, y + hd, z], [x, y, z + h]], [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], col); }
    ico(r, x, y, z, col, sz = 1) { const t = (1 + Math.sqrt(5)) / 2, k = r / Math.sqrt(1 + t * t);
      const P = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
      const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
      this.add(P.map(p => [x + p[0] * k, y + p[1] * k, z + p[2] * k * sz]), F, col); }
    poly(pts, h, z, col) { const n = pts.length, V = pts.map(p => [p[0], p[1], z]).concat(pts.map(p => [p[0], p[1], z + h]));
      const F = [[...Array(n).keys()].reverse(), [...Array(n).keys()].map(i => n + i)]; for (let i = 0; i < n; i++) F.push([i, (i + 1) % n, n + (i + 1) % n, n + i]);
      this.add(V, F, col, false); }
  }

  // ---------------------------------------------------------------- Module
  const win = (b, x, y, z, w, h, rz = 0, col = 'fenster', d = .4) => b.box(w, d, h, x, y, z, M(col), rz);
  const win_row = (b, x0, x1, y, z, n, w, h, col = 'fenster') => { for (let i = 0; i < n; i++) win(b, x0 + (x1 - x0) * (i + .5) / n, y, z, w, h, 0, col); };
  function spire8(b, x, y, z, r, h, col, crockets = true, cross = true) {
    b.cyl(r, .15, h, x, y, z, M(col), 8, 'Z', Math.PI / 8);
    if (crockets) for (let k = 0; k < 8; k++) { const a = k / 8 * TAU + Math.PI / 8;
      for (const t of [.18, .36, .54, .72]) { const rr = r * (1 - t) + .15 * t; b.cyl(.55 + r * .02, 0, 1.6 + r * .05, x + Math.cos(a) * rr, y + Math.sin(a) * rr, z + h * t, M(col), 4); } }
    if (cross) { b.cyl(.5, .3, 2.5, x, y, z + h, M(col), 6); b.ico(1.0, x, y, z + h + 3, M(col)); }
  }
  const pinnacle = (b, x, y, z, s, col) => { b.box(s, s, s * 1.6, x, y, z, M(col)); b.cyl(s * .55, 0, s * 2.6, x, y, z + s * 1.6, M(col), 4, 'Z', Math.PI / 4); };
  function gothic_tower(b, x, y, w, levels, spire_h, col = 'dom', col_d = 'dom_d', spire_col = null, win_col = 'fenster') {
    let z = 0;
    for (const [h, inset] of levels) { const ww = w - inset * 2;
      b.box(ww, ww, h, x, y, z, M(col));
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) { b.box(ww * .16, ww * .16, h + 2, x + sx * ww * .48, y + sy * ww * .48, z, M(col_d)); pinnacle(b, x + sx * ww * .48, y + sy * ww * .48, z + h + 2, ww * .1, col); }
      for (let face = 0; face < 4; face++) b.at(x, y, z, face * Math.PI / 2, () => { for (const k of [-1, 1]) win(b, k * ww * .2, -ww / 2 - .1, h * .18, ww * .17, h * .62, 0, win_col); });
      z += h; }
    const r8 = (w - levels[levels.length - 1][1] * 2) * .44;
    b.cyl(r8, r8, 14, x, y, z, M(col), 8, 'Z', Math.PI / 8);
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; win(b, x + Math.cos(a) * (r8 - .1), y + Math.sin(a) * (r8 - .1), z + 3, 1.6, 8, a + Math.PI / 2, win_col); }
    spire8(b, x, y, z + 14, r8, spire_h, spire_col || col);
  }
  function nave(b, x, y0, L, W, H, roof_h, aisle_w, aisle_h, bay, col = 'dom', col_d = 'dom_d', roof = 'blei', win_col = 'fenster', flying = true) {
    const yc = y0 + L / 2;
    b.box(W, L, H, x, yc, 0, M(col)); b.gable(W + 1, L, roof_h, x, yc, H, M(roof), 'Y');
    for (const s of [-1, 1]) { const ax = x + s * (W / 2 + aisle_w / 2);
      b.box(aisle_w, L, aisle_h, ax, yc, 0, M(col)); b.box(aisle_w + .6, L, 1.2, ax, yc, aisle_h, M(roof));
      const n = Math.max(2, Math.floor(L / bay));
      for (let i = 0; i <= n; i++) { const yy = y0 + i * L / n, bx = x + s * (W / 2 + aisle_w + 1.2);
        b.box(2.4, 2.6, aisle_h + 6, bx, yy, 0, M(col_d)); pinnacle(b, bx, yy, aisle_h + 6, 1.4, col);
        if (flying) b.beam([bx, yy, aisle_h + 4], [x + s * W / 2, yy, H - 4], 1.2, M(col_d));
        if (i < n) { const ym = yy + L / n / 2;
          b.at(x + s * (W / 2 + aisle_w), ym, 0, s * Math.PI / 2, () => win(b, 0, -.2, aisle_h * .2, bay * .45, aisle_h * .6, 0, win_col));
          b.at(x + s * W / 2, ym, 0, s * Math.PI / 2, () => win(b, 0, -.2, aisle_h + 3, bay * .5, H - aisle_h - 6, 0, win_col)); } } }
  }
  function apse(b, x, y, r, H, roof_h, col = 'dom', roof = 'blei', chapels = true, col_d = 'dom_d', win_col = 'fenster') {
    b.cyl(r, r, H, x, y, 0, M(col), 10); b.cyl(r + .5, 0, roof_h, x, y, H, M(roof), 10);
    for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; win(b, x + Math.cos(a) * (r - .1), y + Math.sin(a) * (r - .1), H * .45, r * .25, H * .45, a + Math.PI / 2, win_col); }
    if (chapels) { b.cyl(r + 7, r + 7, H * .42, x, y, 0, M(col), 14); b.cyl(r + 7.5, r, 4, x, y, H * .42, M(roof), 14);
      for (let k = 0; k < 14; k++) { const a = k / 14 * TAU, bx = x + Math.cos(a) * (r + 8), by = y + Math.sin(a) * (r + 8);
        b.box(2, 2, H * .42 + 5, bx, by, 0, M(col_d)); pinnacle(b, bx, by, H * .42 + 5, 1.2, col);
        if (k % 2) b.beam([bx, by, H * .42 + 3], [x + Math.cos(a) * r, y + Math.sin(a) * r, H - 4], 1.0, M(col_d)); } }
  }
  const column = (b, x, y, z, r, h, col, cap = true) => { b.cyl(r, r * .9, h, x, y, z, M(col), 8); if (cap) { b.box(r * 2.4, r * 2.4, r * .5, x, y, z + h - r * .5, M(col)); b.box(r * 2.3, r * 2.3, r * .4, x, y, z, M(col)); } };
  const colonnade = (b, x0, x1, y, z, n, r, h, col) => { for (let i = 0; i < n; i++) column(b, x0 + (x1 - x0) * i / (n - 1), y, z, r, h, col); };
  const pediment = (b, w, d, h, x, y, z, col) => b.gable(w, d, h, x, y, z, M(col), 'X');
  function quadriga(b, x, y, z, s = 1, col = 'kupfer') {
    for (let i = 0; i < 4; i++) { const px = x + (i - 1.5) * 1.15 * s;
      b.box(.7 * s, 2.2 * s, .9 * s, px, y - .8 * s, z + 1.2 * s, M(col));
      for (const lx of [-.22, .22]) for (const ly of [-1.5, -.1]) b.box(.18 * s, .18 * s, 1.2 * s, px + lx * s, y + ly * s, z, M(col));
      b.beam([px, y - 1.8 * s, z + 1.9 * s], [px, y - 2.4 * s, z + 3.0 * s], .45 * s, M(col)); b.box(.4 * s, .7 * s, .4 * s, px, y - 2.6 * s, z + 2.9 * s, M(col)); }
    b.box(2.4 * s, 1.4 * s, 1.2 * s, x, y + .9 * s, z + .6 * s, M(col));
    b.box(.6 * s, .5 * s, 2.2 * s, x, y + 1.0 * s, z + 1.8 * s, M(col)); b.ico(.35 * s, x, y + 1.0 * s, z + 4.3 * s, M(col));
    b.beam([x + .4 * s, y + 1.0 * s, z + 3.4 * s], [x + .9 * s, y + .6 * s, z + 6.2 * s], .18 * s, M(col)); b.box(.9 * s, .15 * s, .9 * s, x + .95 * s, y + .55 * s, z + 6.0 * s, M('gold'));
  }
  function dome(b, x, y, z, r, h, col, n = 12, rings = 7, profile = 'rund') {
    const f = profile === 'rund' ? t => Math.cos(t * Math.PI / 2) : profile === 'glocke' ? t => (t > .25 ? Math.pow(1 - t, .75) : 1 - .12 * t / .25 * 1.2) : t => 1 - t;
    for (let i = 0; i < rings; i++) { const t0 = i / rings, t1 = (i + 1) / rings; b.cyl(r * f(t0), Math.max(.2, r * f(t1)), h / rings, x, y, z + h * t0, M(col), n); }
  }
  function round_tower(b, x, y, r, h, col, roof_col, roof_h, n = 10, win_rows = 3, win_col = 'fenster', crown = false) {
    b.cyl(r, r, h, x, y, 0, M(col), n);
    for (let row = 0; row < win_rows; row++) for (let k = 0; k < n; k += 2) { const a = (k + row % 2) / n * TAU; win(b, x + Math.cos(a) * (r - .1), y + Math.sin(a) * (r - .1), h * (.25 + .5 * row / Math.max(1, win_rows)), r * .28, r * .45, a + Math.PI / 2, win_col); }
    if (crown) b.cyl(r + .6, r + .6, 1.2, x, y, h - 1.2, M(col), n);
    b.cyl(r + .5, 0, roof_h, x, y, h, M(roof_col), n);
  }
  const stepped_gable = (b, w, h, x, y, z, steps, col, d = 1) => { for (let i = 0; i < steps; i++) b.box(w * (1 - i / steps), d, h / steps, x, y, z + i * h / steps, M(col)); };
  function figure(b, x, y, z, s, col, arm_up = true) {
    for (const lx of [-.35, .35]) b.box(.5 * s, .6 * s, 3.2 * s, x + lx * s, y, z, M(col));
    b.box(1.4 * s, .9 * s, 3.0 * s, x, y, z + 3.2 * s, M(col)); b.box(1.8 * s, 1.0 * s, 1.4 * s, x, y, z + 2.8 * s, M(col));
    b.ico(.55 * s, x, y, z + 6.8 * s, M(col)); b.box(.15 * s, 1.0 * s, .7 * s, x - .5 * s, y, z + 7.0 * s, M(col)); b.box(.15 * s, 1.0 * s, .7 * s, x + .5 * s, y, z + 7.0 * s, M(col));
    if (arm_up) { b.beam([x + .7 * s, y, z + 5.8 * s], [x + 1.1 * s, y - .2 * s, z + 8.4 * s], .35 * s, M(col)); b.beam([x + 1.1 * s, y - .2 * s, z + 8.3 * s], [x + 1.4 * s, y - .3 * s, z + 15.5 * s], .22 * s, M('gold')); }
    b.beam([x - .7 * s, y, z + 5.8 * s], [x - 1.2 * s, y - .2 * s, z + 3.6 * s], .35 * s, M(col));
    b.cyl(.9 * s, .9 * s, .2 * s, x - 1.3 * s, y - .5 * s, z + 3.2 * s, M(col), 8, 'Y');
  }

  // ---------------------------------------------------------------- Rezepte
  const R = {};
  R.koelner_dom = b => {
    for (const sx of [-1, 1]) gothic_tower(b, sx * 20, 6, 23, [[28, 0], [24, .5], [22, 1.5], [24, 2.5]], 55);
    b.box(18, 12, 44, 0, 6, 0, M('dom')); win(b, 0, -.2, 14, 8, 24, 0); b.gable(18, 12, 12, 0, 6, 44, M('dom_l'), 'X'); win(b, 0, -.3, 0, 7, 11, 0);
    nave(b, 0, 12, 58, 15, 43, 18, 10, 19, 8.5);
    b.box(86, 22, 43, 0, 81, 0, M('dom')); b.gable(86, 23, 18, 0, 81, 43, M('blei'), 'X');
    for (const sx of [-1, 1]) { b.at(sx * 43, 81, 0, -sx * Math.PI / 2, () => win(b, 0, -.2, 12, 8, 24, 0)); pinnacle(b, sx * 43, 70, 43, 2, 'dom'); pinnacle(b, sx * 43, 92, 43, 2, 'dom'); }
    nave(b, 0, 92, 22, 15, 43, 18, 10, 19, 8.5); apse(b, 0, 118, 11, 43, 16);
    b.cyl(2.6, 2.6, 8, 0, 81, 61, M('dom_d'), 8); spire8(b, 0, 81, 69, 2.6, 40, 'gold', false);
  };
  R.ulmer_muenster = b => {
    gothic_tower(b, 0, 8, 26, [[30, 0], [26, 1], [24, 2.5], [22, 4]], 47, 'sand', 'sand_d');
    nave(b, 0, 21, 64, 16, 41, 20, 12, 21, 9, 'sand', 'sand_d', 'ziegel_d', 'fenster', false);
    nave(b, 0, 85, 26, 13, 28, 14, .01, 1, 9, 'sand', 'sand_d', 'ziegel_d', 'fenster', false);
    apse(b, 0, 111, 7, 28, 12, 'sand', 'ziegel_d', false);
    for (const sx of [-1, 1]) gothic_tower(b, sx * 9, 88, 7, [[30, 0], [18, .5], [12, 1]], 20, 'sand', 'sand_d');
  };
  R.brandenburger_tor = b => { const S = 'sand', D = 'sand_d';
    b.box(41, 13, 1.2, 0, 0, 0, M(D));
    for (const row of [-4.2, 4.2]) colonnade(b, -17.5, 17.5, row, 1.2, 6, .9, 13.5, S);
    for (const xw of [-10.5, -3.5, 3.5, 10.5]) b.box(1.6, 7.0, 13.5, xw, 0, 1.2, M(S));
    b.box(41, 12, 3.6, 0, 0, 14.7, M(S)); for (let i = 0; i < 30; i++) b.box(.5, .2, 1.6, -19.5 + i * 1.35, -6.05, 16.0, M(D));
    b.box(41, 12, .6, 0, 0, 18.3, M('sand_l')); b.box(26, 10, 3.2, 0, 0, 18.9, M(S)); b.box(14, 8, 1.8, 0, 0, 22.1, M(S)); b.box(15, 9, .5, 0, 0, 22.1, M(D));
    quadriga(b, 0, .5, 23.9, 1.45);
    for (const sx of [-1, 1]) { const cx = sx * 29;
      b.box(14, 10, 10, cx, 3, 0, M(S)); b.box(14.6, 10.6, 1.2, cx, 3, 10, M(D)); colonnade(b, cx - 5.5, cx + 5.5, -2.6, 0, 4, .55, 9, S); pediment(b, 14, 2.2, 2.6, cx, -2.4, 10, S);
      b.box(3.2, 7.4, 10, sx * 21.5, 1, 0, M(D)); }
  };
  R.neuschwanstein = b => { const W = 'weiss', RF = 'schiefer';
    b.poly([[-34, -26], [30, -30], [40, 8], [26, 34], [-30, 30], [-42, -2]], 14, -14, M('fels'));
    b.poly([[-30, -22], [26, -25], [34, 6], [22, 28], [-26, 26], [-36, -2]], 1.5, -1.5, M('fels_d'));
    b.at(6, 14, 0, -8 * Math.PI / 180, () => {
      b.box(52, 15, 30, 0, 0, 0, M(W)); b.gable(52.6, 16, 13, 0, 0, 30, M(RF), 'X');
      for (let row = 0; row < 5; row++) win_row(b, -24, 24, -7.6, 3 + row * 5.4, 11, 1.4, 2.6);
      for (const sx of [-1, 1]) b.box(1.2, 15, 9, sx * 26.3, 0, 30, M(W));
      b.box(8, 3, 8, -6, -9, 22, M(W)); b.gable(8.4, 3.4, 4, -6, -9, 30, M(RF), 'Y');
      round_tower(b, -27, 8, 4.0, 52, W, RF, 13);
      round_tower(b, 27, -7, 2.2, 38, W, RF, 8); round_tower(b, 27, 7, 2.2, 36, W, RF, 8); round_tower(b, -27, -7, 2.0, 34, W, RF, 7); });
    b.box(9, 9, 44, -14, -4, 0, M(W)); b.box(10, 10, 2, -14, -4, 44, M(W));
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) round_tower(b, -14 + sx * 4.8, -4 + sy * 4.8, 1.1, 49, W, RF, 5, 8, 0);
    b.at(-2, -22, 0, -4 * Math.PI / 180, () => {
      b.box(30, 10, 15, 0, 0, 0, M('putz_rot')); win(b, 0, -5.2, 0, 4, 7, 0);
      for (let row = 0; row < 2; row++) win_row(b, -12, 12, -5.2, 7 + row * 4, 7, 1.2, 2.2);
      for (const sx of [-1, 1]) { b.box(7, 7, 22, sx * 15, 0, 0, M('putz_rot')); for (let k = 0; k < 4; k++) { b.box(1.2, 1.2, 1.6, sx * 15 + (k - 1.5) * 1.9, -3.2, 22, M('putz_rot')); b.box(1.2, 1.2, 1.6, sx * 15 + (k - 1.5) * 1.9, 3.2, 22, M('putz_rot')); } }
      b.gable(30.4, 10.6, 5, 0, 0, 15, M(RF), 'X'); });
    b.at(-30, 0, 0, Math.PI / 2, () => { b.box(18, 11, 20, 0, 0, 0, M(W)); b.gable(18.4, 11.4, 8, 0, 0, 20, M(RF), 'X'); });
  };
  R.frauenkirche = b => { const S = 'sand_l', D = 'dom_d';
    b.poly([[-20, -25], [20, -25], [25, -12], [25, 12], [20, 25], [-20, 25], [-25, 12], [-25, -12]], 30, 0, M(S));
    for (const [px, py] of [[-25, 0], [25, 0], [0, -25], [0, 25]]) { const rz = Math.atan2(py, px) + Math.PI / 2;
      b.at(px * .96, py * .96, 0, rz, () => { b.box(14, 3, 30, 0, 0, 0, M(S)); pediment(b, 15, 3.4, 4, 0, 0, 30, S); win(b, 0, -1.7, 0, 3.6, 7, 0); }); }
    for (let k = 0; k < 16; k++) { const a = k / 16 * TAU; b.box(3, .4, 4, Math.cos(a) * 24, Math.sin(a) * 24, 4 + (k % 3) * 7, M(D), a + Math.PI / 2); }
    for (const [px, py] of [[-19, -19], [19, -19], [19, 19], [-19, 19]]) { b.cyl(4.2, 4.2, 44, px, py, 0, M(S), 10); dome(b, px, py, 44, 4.4, 5, S, 10, 4); b.cyl(1.2, .3, 6, px, py, 49, M(S), 8); }
    b.cyl(19, 19, 8, 0, 0, 30, M(S), 16); b.cyl(17.5, 17.5, 4, 0, 0, 38, M(S), 16);
    dome(b, 0, 0, 42, 17.5, 26, S, 16, 9, 'glocke');
    b.cyl(5.2, 5.2, 11, 0, 0, 68, M(S), 12); dome(b, 0, 0, 79, 5.4, 5, S, 12, 4); b.cyl(1.4, .5, 6, 0, 0, 84, M(S), 8);
    b.box(.6, .6, 4, 0, 0, 89, M('gold')); b.box(2.2, .6, .6, 0, 0, 91.5, M('gold'));
  };
  R.fernsehturm = b => {
    b.poly([[-28, -18], [28, -18], [36, 0], [28, 18], [-28, 18], [-36, 0]], 9, 0, M('beton_d'));
    for (let k = 0; k < 6; k++) b.pyramid(14, 10, 6, -22 + k * 9, 0, 9, M('beton'));
    b.cyl(16, 4.6, 200, 0, 0, 0, M('beton'), 16); b.cyl(4.6, 4.6, 4, 0, 0, 196, M('beton_d'), 16);
    b.ico(16.5, 0, 0, 213, M('stahl')); b.cyl(16.8, 16.8, 3.2, 0, 0, 208, M('fenster_l'), 20); b.cyl(16.2, 16.2, 2.4, 0, 0, 215, M('fenster_l'), 20);
    b.cyl(3.2, 2.4, 22, 0, 0, 228, M('beton'), 12);
    for (let i = 0; i < 12; i++) b.cyl(1.3 - i * .07, 1.25 - i * .07, 10, 0, 0, 250 + i * 10, M(i % 2 ? 'rot' : 'weiss'), 8);
  };
  R.holstentor = b => { const Z = 'ziegel', ZD = 'ziegel_d';
    b.box(22, 16, 25, 0, 0, 0, M(Z)); b.box(22.2, 16.2, 1.2, 0, 0, 10, M('glasur')); b.box(22.2, 16.2, 1.2, 0, 0, 18, M('glasur'));
    win(b, 0, -8.2, 0, 5, 9, 0); win(b, 0, -8.15, 0, 5.8, .8, 0, ZD);
    for (let row = 0; row < 3; row++) win_row(b, -9, 9, -8.2, 11.5 + row * 4.4, 6, 1.3, 2.6, 'weiss_d');
    stepped_gable(b, 22, 9, 0, -7.6, 25, 5, Z, 1.2); b.gable(22, 16, 9, 0, 0, 25, M('blei'), 'X');
    for (const sx of [-1, 1]) { round_tower(b, sx * 13, 0, 8.4, 28, Z, 'blei', 14, 14, 3, 'weiss_d');
      b.cyl(8.6, 8.6, 1.2, sx * 13, 0, 12, M('glasur'), 14); b.cyl(8.6, 8.6, 1.2, sx * 13, 0, 21, M('glasur'), 14); b.cyl(.5, .2, 4, sx * 13, 0, 42, M('gold'), 6); }
  };
  R.reichstag = b => { const S = 'sand', D = 'sand_d';
    b.box(137, 97, 26, 0, 0, 0, M(S)); b.box(138, 98, 1.5, 0, 0, 26, M(D));
    for (const [cx, cy] of [[-60, -40], [60, -40], [60, 40], [-60, 40]]) { b.box(20, 20, 36, cx, cy, 0, M(S)); b.box(21, 21, 1.5, cx, cy, 36, M(D)); }
    win_row(b, -48, 48, -48.6, 4, 16, 2.4, 5); win_row(b, -48, 48, -48.6, 14, 16, 2.4, 6);
    b.box(42, 6, 4, 0, -51, 0, M(D)); colonnade(b, -16, 16, -51, 4, 6, 1.2, 18, S); b.box(38, 7, 3, 0, -50.5, 22, M(S)); pediment(b, 38, 7, 6, 0, -50.5, 25, S);
    b.box(30, .4, 1.6, 0, -54.2, 22.6, M('gold'));
    b.cyl(21, 21, 2, 0, 0, 27.5, M('beton_d'), 24); dome(b, 0, 0, 29.5, 20, 23.5, 'glas', 24, 7);
    for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; b.beam([Math.cos(a) * 20, Math.sin(a) * 20, 29.5], [Math.cos(a) * 2, Math.sin(a) * 2, 53], .5, M('blei_d')); }
    for (const z of [35, 41, 47]) { const rr = 20 * Math.cos(Math.asin(Math.min(1, (z - 29.5) / 23.5))) + .2; b.cyl(rr, rr, .4, 0, 0, z, M('blei_d'), 24); }
  };
  R.hermannsdenkmal = b => {
    b.cyl(11, 11, 3, 0, 0, 0, M('fels'), 16); b.cyl(9, 9, 18, 0, 0, 3, M('sand_d'), 16);
    for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; column(b, Math.cos(a) * 9.2, Math.sin(a) * 9.2, 3, .55, 14, 'sand_d', false); win(b, Math.cos(a) * 8.9, Math.sin(a) * 8.9, 5, 2.2, 11, a + Math.PI / 2); }
    b.cyl(9.8, 9.8, 2, 0, 0, 21, M('sand'), 16); dome(b, 0, 0, 23, 9, 5, 'sand_d', 16, 4); b.cyl(3.2, 3.2, 3, 0, 0, 27, M('sand'), 12);
    figure(b, 0, 0, 30, 2.7, 'kupfer');
  };
  R.elbphilharmonie = b => {
    b.box(110, 36, 37, 0, 0, 0, M('backstein'));
    for (let row = 0; row < 7; row++) win_row(b, -52, 52, -18.2, 3 + row * 4.8, 36, .9, 1.6);
    const tops = u => 70 + 22 * Math.max(0, Math.cos((u - .78) * 5.5)) + 14 * Math.max(0, Math.cos((u - .3) * 6)) + 6 * Math.sin(u * 9), n = 24;
    for (let i = 0; i < n; i++) { const u = (i + .5) / n, x = -55 + 110 * u, t = tops(u);
      b.box(110 / n + .05, 36, t - 37, x, 0, 37, M('glas')); b.gable(110 / n + .05, 36, 3.5, x, 0, t, M('weiss'), 'X');
      for (let z = 40; z < t - 2; z += 6) b.box(110 / n - 1.2, .3, .5, x, -18.15, z, M('weiss_d')); }
    for (const x of [-30, 8, 34]) b.cyl(4, 4, .4, x, -18.3, 52, M('fenster'), 10, 'Y');
  };

  // ---------------------------------------------------------------- Verzeichnis: Mitte (lat, lon), Hauptfassade schaut nach front (Grad, 0 = Nord, 90 = Ost)
  const LIST = [
    { id: 'koelner_dom', name: 'Kölner Dom', lat: 50.94133, lon: 6.95812, front: 270 },
    { id: 'ulmer_muenster', name: 'Ulmer Münster', lat: 48.39841, lon: 9.99155, front: 270 },
    { id: 'brandenburger_tor', name: 'Brandenburger Tor', lat: 52.51627, lon: 13.37770, front: 90 },
    { id: 'neuschwanstein', name: 'Schloss Neuschwanstein', lat: 47.55755, lon: 10.74958, front: 64 },
    { id: 'frauenkirche', name: 'Frauenkirche Dresden', lat: 51.05186, lon: 13.74155, front: 270 },
    { id: 'fernsehturm', name: 'Berliner Fernsehturm', lat: 52.52082, lon: 13.40940, front: 0 },
    { id: 'holstentor', name: 'Holstentor', lat: 53.86640, lon: 10.67967, front: 270 },
    { id: 'reichstag', name: 'Reichstag', lat: 52.51862, lon: 13.37618, front: 270 },
    { id: 'hermannsdenkmal', name: 'Hermannsdenkmal', lat: 51.91165, lon: 8.83949, front: 270 },
    { id: 'elbphilharmonie', name: 'Elbphilharmonie', lat: 53.54130, lon: 9.98381, front: 180 },
  ];

  /* place(e, lx, lz): game coordinates of the centre. Returns the built model in game coordinates (triangles with outward hints) and
     the ground rectangle (4 corners) that it covers - inside it the generic houses and LoD2 buildings are left out. */
  const CACHE = new Map();
  function model(id) { if (CACHE.has(id)) return CACHE.get(id); const b = new B(); R[id](b);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of b.shapes) for (const p of s.V) { if (p[2] < -.5) continue; if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    const m = { shapes: b.shapes, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hw: (x1 - x0) / 2, hd: (y1 - y0) / 2 }; CACHE.set(id, m); return m; }
  function frame(e, ax, az) { const m = model(e.id), yaw = Math.PI - e.front * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    // Blender (x, y, z) -> game (x, z, -y), rotated by yaw about the vertical, centre of the model on the anchor
    const toG = p => { const gx = p[0] - m.cx, gz = -(p[1] - m.cy); return [ax + gx * c + gz * s, p[2], az - gx * s + gz * c]; };
    const rect = [[-m.hw, -m.hd], [m.hw, -m.hd], [m.hw, m.hd], [-m.hw, m.hd]].map(([u, v]) => { const g = toG([u + m.cx, v + m.cy, 0]); return [g[0], g[2]]; });
    return { m, toG, rect }; }
  function emit(e, ax, az, G) { const { m, toG } = frame(e, ax, az); let n = 0;
    for (const sh of m.shapes) { const V = sh.V.map(toG); let cx = 0, cy = 0, cz = 0; for (const p of V) { cx += p[0]; cy += p[1]; cz += p[2]; } cx /= V.length; cy /= V.length; cz /= V.length;
      for (const f of sh.F) { let fx = 0, fy = 0, fz = 0; for (const i of f) { fx += V[i][0]; fy += V[i][1]; fz += V[i][2]; } fx /= f.length; fy /= f.length; fz /= f.length;
        let hx = fx - cx, hy = fy - cy, hz = fz - cz;
        if (!sh.convex) { if (f.length > 4 && Math.abs(V[f[0]][1] - V[f[1]][1]) < 1e-6 && Math.abs(V[f[1]][1] - V[f[2]][1]) < 1e-6) { hx = 0; hz = 0; hy = fy > cy ? 1 : -1; } } // caps of extruded outlines
        for (let k = 1; k + 1 < f.length; k++) { const a = V[f[0]], b2 = V[f[k]], c2 = V[f[k + 1]]; G.tri(a[0], a[1], a[2], b2[0], b2[1], b2[2], c2[0], c2[1], c2[2], sh.col, hx, hy, hz); n++; } } }
    return n; }
  const inRect = (x, z, r) => { let ins = false; for (let i = 0, j = 3; i < 4; j = i++) { const a = r[i], b = r[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins; } return ins; };
  self.SONDER = { list: LIST, frame, emit, inRect, model };
})();
