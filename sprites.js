/* HoodExplorer – pixel sprites for trees and bushes.
   One small atlas is drawn once at start (no image files needed; later replaceable by drawn sprites from the editor).
   Every tile gets ONE instanced mesh: 4 vertices per tree instead of ~60, so far more trees fit on old phones.
   Wind sway is done in the vertex shader (one sin() per vertex), so the animation costs practically nothing.
   Types: 0 round broadleaf, 1 tall broadleaf, 2 dark broadleaf (oak/lime), 3 birch, 4 spruce, 5 pine, 6 bush, 7 flowering bush,
   8 forked broadleaf, 9 leaning broadleaf, 10 old thick oak, 11 young tree, 12 grey beech, 13 slim poplar, 14 low round bush, 15 larch */
/* Props (from 16): 16 wheelie bins, 17 bicycles, 18/19 person A (two animation frames), 20/21 person B, 22 air-conditioning unit,
   23 roof vent, 24 flower planter, 25 cafe table with parasol, 26 swing, 27 slide.
   Per instance: x, z, width, height, type, and (floor(baseY * 4) + seed): the base height lets props stand on flat roofs. */
const SPRITE_COLS = 8, SPRITE_ROWS = 6, SPRITE_PX = 48, SPRITE_PROP = 16;
/* Rows 4-5 and many cells above come as pixel art from Blender (werkzeuge/sprite_fabrik.py + sprite_atlas.py -> daten/sprites.png):
   28/29 duck, 30/31 pigeon, 32-37 bush side/top views (for the cross bushes), 38/39 gull, 40 satellite dish, 41 chimney. */
const SPRITE_BUSH = [6, 7, 14]; // used by the shader: bushes sway less

function makeSpriteAtlas() {
  const W = SPRITE_COLS * SPRITE_PX, H = SPRITE_ROWS * SPRITE_PX;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), img = g.createImageData(W, H), d = img.data;
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const hx = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  let ox = 0, oy = 0; // origin of the cell being drawn
  const put = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= SPRITE_PX || y >= SPRITE_PX) return; const o = ((oy + y) * W + ox + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; };
  const disc = (x, y, r, c) => { for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) if (a * a + b * b <= r * r + .6) put(x + a, y + b, c); };
  // leafy crown: many small clumps, shaded by position (light from the upper left), darkest at the bottom right
  function crown(cx, cy, rx, ry, pal, n, flowers) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()); pts.push([cx + Math.cos(a) * r * rx, cy + Math.sin(a) * r * ry]); }
    pts.sort((p, q) => (q[1] - cy) / ry + (q[0] - cx) / rx * .4 - ((p[1] - cy) / ry + (p[0] - cx) / rx * .4)); // dark clumps first, lit ones on top
    for (const [x, y] of pts) {
      const sh = (x - cx) / rx * .5 + (y - cy) / ry * .85 + (rnd() - .5) * .45;
      disc(x, y, 2 + Math.floor(rnd() * 2), pal[sh < -.5 ? 3 : sh < 0 ? 2 : sh < .5 ? 1 : 0]);
    }
    if (flowers) for (let i = 0; i < 26; i++) { const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * .85; put(cx + Math.cos(a) * r * rx, cy + Math.sin(a) * r * ry - 1, hx(flowers[i % flowers.length])); }
  }
  // tapered trunk with bark, a root flare at the foot and grass tufts around it (no hard cut where it meets the ground)
  function trunk(x, y0, y1, w, dark, light, o) {
    o = o || {}; const mid = [(dark[0] + light[0]) >> 1, (dark[1] + light[1]) >> 1, (dark[2] + light[2]) >> 1], deep = dark.map(v => v * .7);
    for (let y = y0; y <= y1; y++) {
      const t = (y - y0) / Math.max(1, y1 - y0), flare = y > y1 - 3 ? (y - (y1 - 3)) * .8 : 0;
      const ww = Math.max(2, w * (.75 + .25 * t)) + flare * 2, cx = x + (o.lean || 0) * (1 - t);
      for (let a = 0; a < ww; a++) {
        const f = a / ww; let c = f < .3 ? light : f < .65 ? mid : dark;
        if (rnd() < .12) c = deep; // bark
        put(cx - ww / 2 + a, y, c);
      }
    }
    if (o.fork) for (const sd of [-1, 1]) for (let k = 0; k < 9; k++) { put(x + sd * (1 + k * .7), y0 - k, k < 5 ? mid : dark); put(x + sd * (1 + k * .7) + sd, y0 - k, dark); }
    const G = [hx('#3f6a2e'), hx('#5a8a3a'), hx('#2f4a26')];
    for (let i = 0; i < 9; i++) { const gx = x + (rnd() - .5) * (w + 8), h = 1 + Math.floor(rnd() * 2); for (let k = 0; k < h; k++) put(gx, y1 - k, G[Math.floor(rnd() * 3)]); }
  }
  function cone(cx, base, top, half, pal, tiers) { // spruce: stacked jagged triangles
    for (let t = 0; t < tiers; t++) {
      const y0 = base - (base - top) * t / tiers * .92, y1 = y0 - (base - top) / tiers * 1.7, hw = half * (1 - t / tiers * .75);
      for (let y = Math.floor(y1); y <= y0; y++) {
        const f = (y - y1) / (y0 - y1), w = hw * f + (rnd() < .3 ? 1 : 0);
        for (let x = -w; x <= w; x++) { const sh = x / Math.max(1, hw) * .7 + (1 - f) * -.5 + (rnd() - .5) * .3; put(cx + x, y, pal[sh < -.45 ? 3 : sh < 0 ? 2 : sh < .45 ? 1 : 0]); }
      }
    }
  }
  const P = s => s.map(hx);
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, c); };
  const line = (x0, y0, x1, y1, c) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1; for (let i = 0; i <= n; i++) put(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, c); };
  const ring = (x, y, r, c) => { for (let a = 0; a < 40; a++) put(x + Math.cos(a / 40 * 6.283) * r, y + Math.sin(a / 40 * 6.283) * r, c); };
  // little pixel person drawn in MARKER colours (palette swap): the sprite shader gives every person its own skin, hair,
  // top and trousers and switches optional parts on or off (long hair, skirt, cap, beard, bag) -> thousands of different
  // people from four atlas cells. Shape B: longer coat, arms a little apart. Frame 1: idle step.
  function person(fr, shape) {
    const SK = [255, 0, 0], SK2 = [180, 0, 0], HA = [255, 255, 0], LH = [255, 128, 0], LHT = [255, 128, 128], BRD = [128, 255, 0], CAP = [128, 0, 255],
      SH = [0, 255, 0], SH2 = [0, 170, 0], LG = [255, 0, 255], LG2 = [170, 0, 170], SKT = [0, 255, 255], SKT2 = [0, 128, 255], BAG = [255, 0, 128], BAGT = [128, 128, 255], D = [30, 30, 30];
    const sw = fr ? 1 : -1, l1 = fr ? 1 : 0, l2 = fr ? 0 : 1, coat = shape ? 4 : 0, ax = shape ? 1 : 0;
    rect(29, 22, 34, 28, BAG);                                                            // bag (optional), arm drawn over it
    rect(19, 6, 20, 11, LH); rect(27, 6, 28, 11, LH);                                     // long hair beside the face (optional)
    rect(20, 4, 27, 11, SK); rect(26, 5, 27, 11, SK2); put(22, 8, D); put(25, 8, D);      // head
    rect(20, 3, 27, 5, HA); rect(19, 4, 20, 8, HA); rect(27, 4, 28, 6, HA);               // hair
    rect(20, 0, 27, 2, CAP); rect(27, 2, 31, 2, CAP);                                     // cap with brim (optional)
    rect(21, 10, 26, 11, BRD);                                                            // beard, else chin
    rect(18, 12, 29, 27 + coat, SH); rect(18, 12, 19, 27 + coat, SH2); rect(22, 12, 25, 13, SK); // top, neckline
    rect(15 - ax, 13, 17 - ax, 24 + sw, SH); rect(30 + ax, 13, 32 + ax, 24 - sw, SH); put(16 - ax, 25 + sw, SK); put(31 + ax, 25 - sw, SK); // arms, hands
    rect(19, 12, 20, 15, LHT); rect(27, 12, 28, 15, LHT);                                 // long hair over the shoulders, else top
    rect(19, 28 + coat, 23, 42 - l1, LG); rect(24, 28 + coat, 28, 42 - l2, LG); rect(19, 28 + coat, 20, 42 - l1, LG2); // legs: trousers, or bare under a skirt
    rect(19, 28 + coat, 28, 33 + coat, SKT2); rect(17, 29 + coat, 18, 33 + coat, SKT); rect(29, 29 + coat, 30, 33 + coat, SKT); // skirt: over the legs, flared sides optional
    rect(18, 43 - l1, 23, 44 - l1, D); rect(24, 43 - l2, 29, 44 - l2, D);                // shoes
    line(19, 12, 29, 22, BAGT);                                                           // bag strap, else top
  }
  const TR = hx('#4a3426'), TRL = hx('#6e4e36');
  const draw = [
    () => { trunk(24, 30, 47, 4, TR, TRL); crown(24, 19, 17, 15, P(['#2f4a26', '#3f6a2e', '#5a8a3a', '#86b04a']), 120); },
    () => { trunk(24, 34, 47, 4, TR, TRL); crown(24, 20, 12, 19, P(['#2c4524', '#3d6230', '#55823c', '#7aa44c']), 110); },
    () => { trunk(24, 30, 47, 5, TR, TRL); crown(24, 18, 19, 14, P(['#263d22', '#34552b', '#4a7034', '#6a9440']), 130); crown(16, 25, 8, 6, P(['#263d22', '#34552b', '#4a7034', '#6a9440']), 20); },
    () => { trunk(24, 22, 47, 3, hx('#cfcabd'), hx('#f2efe6')); for (let y = 24; y < 47; y += 3 + Math.floor(rnd() * 3)) put(23 + Math.floor(rnd() * 2), y, hx('#2a2a2a'));
      crown(24, 17, 12, 15, P(['#3a5a2a', '#55803a', '#78a548', '#a4c95e']), 80); },
    () => { trunk(24, 40, 47, 3, TR, TRL); cone(24, 44, 2, 15, P(['#16261a', '#203a24', '#2d4e30', '#3f6640']), 5); },
    () => { trunk(24, 16, 47, 3, hx('#7a4430'), hx('#a8623e')); crown(24, 12, 16, 9, P(['#1f3322', '#2c4a2e', '#3e6438', '#57804a']), 70); },
    () => { crown(24, 35, 20, 11, P(['#2a4424', '#3a5e2e', '#507a38', '#6e9a44']), 110); },
    () => { crown(24, 35, 19, 11, P(['#2a4424', '#3a5e2e', '#507a38', '#6e9a44']), 100, ['#e8a0b8', '#f4f0f0', '#f0d060']); },
    () => { trunk(24, 26, 47, 4, TR, TRL, { fork: 1 }); crown(16, 17, 11, 11, P(['#2f4a26', '#3f6a2e', '#5a8a3a', '#86b04a']), 60); crown(32, 15, 11, 12, P(['#2f4a26', '#3f6a2e', '#5a8a3a', '#86b04a']), 60); },
    () => { trunk(22, 28, 47, 4, hx('#3e2c22'), hx('#6a4a34'), { lean: 6 }); crown(29, 18, 15, 13, P(['#2c4524', '#3d6230', '#55823c', '#7aa44c']), 100); },
    () => { trunk(24, 30, 47, 8, hx('#3a2a20'), hx('#5e4430'), { fork: 1 }); crown(24, 16, 22, 14, P(['#243a20', '#33522a', '#4a6e32', '#6a8f3e']), 150); },
    () => { trunk(24, 26, 47, 2, TR, TRL); crown(24, 18, 9, 10, P(['#36552a', '#4f7a38', '#6e9e48', '#98c25a']), 45); },
    () => { trunk(24, 30, 47, 5, hx('#6a6a64'), hx('#a8a69c')); crown(24, 18, 18, 15, P(['#2a4a2a', '#3c6a34', '#58903e', '#82b450']), 130); },
    () => { trunk(24, 36, 47, 3, TR, TRL); crown(24, 20, 8, 20, P(['#2c4a24', '#3e6a2e', '#5a8a38', '#7eaa48']), 90); },
    () => { crown(24, 38, 15, 9, P(['#2d4826', '#3f6430', '#567e3a', '#759e48']), 70); },
    () => { trunk(24, 38, 47, 3, hx('#6a3e2a'), hx('#94603e')); cone(24, 42, 3, 13, P(['#3a5a26', '#4e7630', '#6a943c', '#8eb44e']), 4); },
    // ---- props: drawn so that the square cell maps onto a square sprite
    () => { // wheelie bins: black (residual), blue (paper), brown (organic)
      [['#3a3c40', '#55585e'], ['#2c5aa8', '#4a7ad0'], ['#6a4a2c', '#8e6a44']].forEach(([dk, lt], i) => { const x0 = 3 + i * 15;
        rect(x0, 18, x0 + 12, 44, hx(lt)); rect(x0 + 8, 18, x0 + 12, 44, hx(dk)); rect(x0 - 1, 15, x0 + 13, 18, hx(dk)); rect(x0 + 1, 22, x0 + 11, 22, hx(dk));
        rect(x0 + 1, 44, x0 + 3, 47, hx('#1c1c1c')); rect(x0 + 9, 44, x0 + 11, 47, hx('#1c1c1c')); });
    },
    () => { // two parked bicycles
      for (const [ox2, c] of [[2, '#c8402c'], [20, '#2c6aa8']]) { const C = hx(c), T = hx('#1e1e1e');
        ring(ox2 + 6, 38, 6, T); ring(ox2 + 21, 38, 6, T); line(ox2 + 6, 38, ox2 + 12, 28, C); line(ox2 + 12, 28, ox2 + 21, 38, C); line(ox2 + 12, 28, ox2 + 20, 28, C);
        line(ox2 + 20, 28, ox2 + 21, 38, C); line(ox2 + 20, 28, ox2 + 19, 24, C); rect(ox2 + 17, 23, ox2 + 22, 23, T); rect(ox2 + 10, 26, ox2 + 14, 26, T); }
    },
    () => person(0, 0),
    () => person(1, 0),
    () => person(0, 1),
    () => person(1, 1),
    () => { // air-conditioning unit on a flat roof
      rect(4, 14, 43, 44, hx('#c9ccce')); rect(4, 14, 43, 16, hx('#e8eaeb')); rect(38, 16, 43, 44, hx('#a2a6aa'));
      ring(20, 30, 10, hx('#6a6e72')); for (let a = 0; a < 6; a++) line(20, 30, 20 + Math.cos(a) * 8, 30 + Math.sin(a) * 8, hx('#4a4e52')); rect(4, 44, 43, 47, hx('#7a7e82'));
    },
    () => { // roof vent / stack
      rect(17, 10, 30, 47, hx('#9a9ea2')); rect(26, 10, 30, 47, hx('#7a7e82')); rect(14, 6, 33, 10, hx('#5a5e62')); rect(14, 6, 33, 7, hx('#8a8e92'));
    },
    () => { // planter with flowers
      rect(8, 30, 39, 47, hx('#8a5a3a')); rect(8, 30, 39, 32, hx('#a8744a')); rect(33, 32, 39, 47, hx('#6e462c'));
      crown(24, 24, 15, 7, P(['#2a4424', '#3a5e2e', '#507a38', '#6e9a44']), 40, ['#e85a5a', '#f4f0f0', '#f0c040', '#d070c0']);
    },
    () => { // cafe table with parasol and two chairs
      const R = hx('#d84a3a'), W = hx('#f2ece0'); for (let y = 6; y < 14; y++) { const w = Math.round((y - 6) * 2.6 + 4); for (let x = -w; x <= w; x++) put(24 + x, y, Math.floor((x + 40) / 6) % 2 ? R : W); }
      rect(23, 14, 24, 44, hx('#5a5a5a')); rect(14, 30, 33, 32, hx('#e8e2d6'));
      rect(6, 30, 8, 44, hx('#3a3a3a')); rect(6, 34, 12, 35, hx('#3a3a3a')); rect(39, 30, 41, 44, hx('#3a3a3a')); rect(35, 34, 41, 35, hx('#3a3a3a'));
    },
    () => { // swing: A-frame with two seats
      const F = hx('#c85a2a'), C = hx('#3a3a3a'); line(6, 47, 14, 8, F); line(7, 47, 15, 8, F); line(42, 47, 34, 8, F); line(41, 47, 33, 8, F); rect(13, 6, 35, 8, F);
      for (const sx of [18, 29]) { line(sx, 8, sx, 34, C); line(sx + 3, 8, sx + 3, 34, C); rect(sx - 1, 34, sx + 4, 36, hx('#2a6ac8')); }
    },
    () => { // slide with ladder and a little tower
      const R = hx('#e8b02a'), B = hx('#2a6ac8'), W = hx('#8a5a3a');
      rect(8, 14, 22, 16, W); rect(8, 16, 9, 47, W); rect(21, 16, 22, 47, W); for (let y = 20; y < 47; y += 5) rect(9, y, 20, y, W);
      rect(6, 6, 24, 9, B); line(6, 9, 15, 2, B); line(24, 9, 15, 2, B);
      for (let k = 0; k < 22; k++) { rect(22 + k, 16 + Math.round(k * 1.25), 24 + k, 18 + Math.round(k * 1.25), R); }
    }
  ];
  /* Runde 211: small single plants with a ragged foot (no straight bottom edge): a clump of leaves, flowers on top; several are
     scattered per bed and can be used anywhere (beds, gardens, planters). Drawn high in the cell, the foot thins out into single
     leaves and blades so it blends into the ground. */
  function plant(flowers, leaf) { const L = P(leaf || ['#2c4a26', '#3a5e30', '#4f7a3a', '#6a9a48']);
    for (let i = 0; i < 46; i++) { const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()), x = 24 + Math.cos(a) * r * 15, y = 30 + Math.sin(a) * r * 11; disc(x, y, 2 + (rnd() < .4 ? 1 : 0), L[(rnd() * 4) | 0]); }
    for (let i = 0; i < 16; i++) { const x = 12 + rnd() * 24, y0 = 36 + rnd() * 4, h = 3 + rnd() * 6; for (let k = 0; k < h; k++) put(x + (rnd() - .5), y0 + k, L[(rnd() * 3) | 0]); } // ragged foot: single blades
    if (flowers) for (let i = 0; i < 22; i++) { const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()), x = 24 + Math.cos(a) * r * 13, y = 27 + Math.sin(a) * r * 8 - 2; const c = hx(flowers[(rnd() * flowers.length) | 0]); disc(x, y, 1, c); put(x, y, hx('#fff6c8')); } }
  /* Runde 210: cemetery sprites - 42 grave light (red glass lantern with a flame; the flame glows at night), 43 grave planting
     (low heather/pansies/begonias in a mound), 44 small evergreen (boxwood ball or little thuja) */
  while (draw.length < 42) draw.push(null);
  draw.push(() => { const G = hx('#b8261e'), GD = hx('#7a1a16'), L = hx('#3a3a3a'), F = hx('#ffd75a'), FW = hx('#fff4c2');
      rect(17, 18, 30, 21, L); rect(18, 22, 29, 44, G); rect(18, 22, 20, 44, GD); rect(27, 22, 29, 44, GD); rect(16, 44, 31, 47, L);
      rect(22, 28, 25, 38, F); rect(23, 30, 24, 35, FW); put(23, 27, F); put(24, 26, FW); rect(21, 14, 26, 17, L); },
    () => plant(['#c4323a', '#e2585e', '#f29a9a', '#e8c24a', '#f2dc7a']),
    () => { if (rnd() < 2) { crown(24, 30, 13, 15, P(['#1f3d24', '#2a5030', '#36653a', '#4c7e46']), 70); rect(23, 44, 25, 47, hx('#4a3426')); } });
  draw.push(() => plant(['#7a3a8a', '#a65cb8', '#d08ad8', '#ffffff', '#b8b0d8']), // 45 cool flowers
    () => { const L = P(['#3f6a34', '#56843e', '#74a04a', '#8cb85a']); for (let i = 0; i < 40; i++) { const x = 10 + rnd() * 28, y1 = 44 - rnd() * 4, h = 10 + rnd() * 18, lean = (x - 24) * .35;
        for (let k = 0; k < h; k++) put(x + lean * k / h, y1 - k, L[Math.min(3, (k / h * 4) | 0)]); } },                      // 46 grass / fern tuft
    () => plant(['#b0508e', '#c86aa8', '#9a3c7c'], ['#3a4a2a', '#4a5e30', '#5f7438', '#7a8a44']));                          // 47 heather
  draw.forEach((f, t) => { if (!f) return; ox = (t % SPRITE_COLS) * SPRITE_PX; oy = Math.floor(t / SPRITE_COLS) * SPRITE_PX; f(); });
  // 1-px dark outline around every sprite: reads as crisp pixel art at any distance
  const a0 = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) a0[i] = d[i * 4 + 3];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (a0[i]) continue;
    const cell = Math.floor(x / SPRITE_PX) + 100 * Math.floor(y / SPRITE_PX); let nb = -1;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + a, yy = y + b; if (xx < 0 || yy < 0 || xx >= W || yy >= H || Math.floor(xx / SPRITE_PX) + 100 * Math.floor(yy / SPRITE_PX) !== cell) continue; const j = yy * W + xx; if (a0[j]) { nb = j; break; } }
    if (nb >= 0) { d[i * 4] = d[nb * 4] * .55; d[i * 4 + 1] = d[nb * 4 + 1] * .55; d[i * 4 + 2] = d[nb * 4 + 2] * .55; d[i * 4 + 3] = 255; }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  // pixel-art cells rendered in Blender replace the hand-coded ones once loaded (the game runs with the coded ones meanwhile)
  fetch('daten/sprites.json?v=6').then(r => r.ok ? r.json() : null).then(meta => { if (!meta) return;
    const im = new Image(); im.onload = () => { for (const n of meta.cells) { const x = (n % SPRITE_COLS) * SPRITE_PX, y = Math.floor(n / SPRITE_COLS) * SPRITE_PX; g.clearRect(x, y, SPRITE_PX, SPRITE_PX); g.drawImage(im, x, y, SPRITE_PX, SPRITE_PX, x, y, SPRITE_PX, SPRITE_PX); } tex.needsUpdate = true; };
    im.src = 'daten/sprites.png?v=6'; }).catch(() => {});
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

const spriteUniforms = {
  uAtlas: { value: null }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
  uTime: { value: 0 }, uWind: { value: 1 }, uPlayer: { value: new THREE.Vector3() }, uSee: { value: 0 }, uLight: { value: new THREE.Color(1, 1, 1) },
  uFogColor: { value: new THREE.Color() }, uFogDensity: { value: 0 }, uFwd: { value: new THREE.Vector3(0, 0, 1) }, uFlat: { value: 1 },
  uTrees: { value: null }, uTreesOn: { value: 0 }, uSlot: { value: new Array(48).fill(-1) }, uDirRows: { value: 1 }
};
/* Static assets from 16 directions (werkzeuge/sprite_fabrik.py + sprite_atlas.py -> daten/dirs16.png): trees, bushes, bins, bikes,
   playground, parasols, roof props. Row = asset (dirs16.json "slots": type -> row), column = view (every 22.5 deg). The shader picks the
   view from the angle between camera and object (+ a fixed random turn per object) and blends into the next view with a pixel pattern
   just around the switch, so crowns don't jump when the camera turns. Same cost as before: one quad per object, one more texture. */
fetch('daten/dirs16.json?v=5').then(r => r.ok ? r.json() : null).then(meta => { if (!meta) return;
  new THREE.TextureLoader().load('daten/dirs16.png?v=5', t => { t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const sl = new Array(48).fill(-1); for (const k in meta.slots) sl[+k] = meta.slots[k];
    spriteUniforms.uSlot.value = sl; spriteUniforms.uDirRows.value = meta.rows; spriteUniforms.uTrees.value = t; spriteUniforms.uTreesOn.value = 1; window.HX_DIRS = true; }); }).catch(() => {});
const spriteMat = new THREE.ShaderMaterial({
  uniforms: spriteUniforms, side: THREE.DoubleSide,
  vertexShader: `
    attribute vec4 iA; // x, z, width, height
    attribute vec2 iB; // type, floor(baseY * 4) + seed
    uniform vec3 uRight, uUp, uPlayer, uFwd; uniform float uTime, uWind, uSee, uFlat, uTreesOn, uDirRows, uSlot[48];
    varying vec2 vUv, vUvB; varying float vSeed, vFogDepth, vSee, vH, vProp, vPerson, vMirror, vTree, vMix, vLamp, vPlant;
    void main() {
      float h = position.y; vH = h;
      vPerson = (iB.x > 17.5 && iB.x < 21.5) ? 1.0 : 0.0; vLamp = abs(iB.x - 42.0) < 0.5 ? 1.0 : 0.0; vPlant = (iB.x > 42.5 && iB.x < 47.5) ? 1.0 : 0.0;
      // wind: the crown sways, the foot stays put; every tree has its own phase, gusts roll through the town
      float gust = 0.6 + 0.4 * sin(uTime * 0.37 + iA.x * 0.013 + iA.y * 0.009);
      float seed = fract(iB.y), y0 = floor(iB.y) * 0.25;
      bool bush = abs(iB.x - 6.0) < 0.5 || abs(iB.x - 7.0) < 0.5 || abs(iB.x - 14.0) < 0.5, prop = iB.x > ${SPRITE_PROP}.0 - 0.5;
      float sway = (prop) ? 0.0 : sin(uTime * 1.3 + seed * 6.283) * uWind * gust * h * h * (bush ? 0.015 : 0.03);
      // vertex bending: the foot stands upright, only the upper part leans towards the isometric camera,
      // so trees don't poke into houses behind them (in the street view uUp is vertical and nothing bends)
      float hs = 1.0; if (vPerson > 0.5) { float r = fract(sin(seed * 91.7) * 4375.85); hs = r > 0.9 ? 0.66 : 0.9 + 0.16 * fract(r * 13.7); } // people: own height, now and then a child
      vec3 p = vec3(iA.x, y0, iA.y) + uRight * ((position.x + sway) * iA.z * hs) + vec3(0.0, h * iA.w * hs, 0.0) + (uUp - vec3(0.0, 1.0, 0.0)) * (h * h * iA.w * hs);
      vMirror = 0.0;
      if (abs(iB.x - 28.0) < 0.5) { p.x += sin(uTime * .13 + seed * 40.0) * 2.5; p.z += cos(uTime * .11 + seed * 31.0) * 2.5; p.y += sin(uTime * 2.0 + seed * 9.0) * .04; // ducks drift about
        /* Runde 183: now and then a duck dives (every 26-48 s, each its own time): tips under in 0.45 s, stays down ~2.3 s and comes up
           1-2 m further on - the move happens while it is under (the next dive cycle starts in the hidden middle), so it never jumps */
        float dP = 26.0 + seed * 22.0, dT = uTime + seed * 97.0, ph = mod(dT, dP), cyc = floor((dT - 1.6) / dP);
        p.x += sin(cyc * 7.1 + seed * 17.0) * 1.5; p.z += cos(cyc * 5.3 + seed * 23.0) * 1.5;
        if (ph < 3.2) p.y -= (ph < .45 ? ph / .45 : ph > 2.8 ? (3.2 - ph) / .4 : 1.0) * .9; }
      if (abs(iB.x - 30.0) < 0.5 || abs(iB.x - 38.0) < 0.5) { float a = uTime * (.22 + seed * .2) + seed * 60.0, rr = 10.0 + seed * 16.0; p.x += cos(a) * rr; p.z += sin(a) * rr; p.y += sin(uTime * .7 + seed * 20.0) * 1.5; } // birds circle
      if (iA.w < 0.0) { // reflection lying flat on the water, pointing towards the camera; only where the water is on the camera side
        float k8 = floor(-iA.w / 100.0), H = -iA.w - 100.0 * k8; vec2 toW = vec2(cos(k8 * 0.7854), sin(k8 * 0.7854));
        vec2 toCam = isOrthographic ? -normalize(uFwd.xz + 1e-5) : normalize(cameraPosition.xz - vec2(iA.x, iA.y) + 1e-5); // straight down on screen
        float camH = max(cameraPosition.y - y0, 1.0), dist = length(cameraPosition.xz - vec2(iA.x, iA.y));
        float k = isOrthographic ? uFlat : min(dist / camH, 1.2); // capped: the worker only checks water up to 1.3 x tree height // perspective: a flat image must be this long to look as tall as the tree
        float along = min(h * H * k, dist * .8), ws = isOrthographic ? 1.0 : max(.08, (dist - along) / dist); // closer to the camera = narrower, so it keeps the tree's width on screen
        p = vec3(iA.x, y0, iA.y) + uRight * ((position.x + sway * .5) * iA.z * ws) + vec3(toCam.x, 0.0, toCam.y) * along;
        vMirror = 1.0; if (dot(toW, toCam) < 0.924 || (!isOrthographic && dist < 14.0)) p.y -= 1000.0; } // of the copies (one per direction with water) only the one facing the camera shows
      vec4 mv = viewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      float t = iB.x;
      if (abs(t - 18.0) < 0.5 || abs(t - 20.0) < 0.5) t += step(0.5, fract(uTime * 1.2 + seed * 3.0)); // people: two-frame idle animation
      if (abs(t - 28.0) < 0.5) t += step(0.5, fract(uTime * 0.5 + seed * 3.0));                                       // ducks: dabbling
      if (abs(t - 30.0) < 0.5 || abs(t - 38.0) < 0.5) t += step(0.5, fract(uTime * (3.0 + seed * 2.0) + seed * 3.0)); // birds: wing beats
      float col = mod(t, ${SPRITE_COLS}.0), row = floor(t / ${SPRITE_COLS}.0);
      vUv = vec2((col + position.x + 0.5) / ${SPRITE_COLS}.0, (${SPRITE_ROWS}.0 - row - 1.0 + h) / ${SPRITE_ROWS}.0);
      vTree = 0.0; vMix = 0.0; vUvB = vUv;
      float slot = (uTreesOn > 0.5 && iB.x < 47.5) ? uSlot[int(iB.x + 0.5)] : -1.0;
      if (slot > -0.5) { // view from the camera's direction (view d = camera walked d x 22.5 deg clockwise around it), blended into the next one near the switch
        vec2 vd = isOrthographic ? uFwd.xz : vec2(iA.x, iA.y) - cameraPosition.xz;
        // plants blend into the next view near the switch; hard-edged objects (swings, bins, roof props) snap to the nearest view -
        // blending two views of a thin frame showed both frames at once (phone test: a swing with four legs)
        float a = atan(vd.x, -vd.y) / 0.3927 + (abs(iB.x - 40.0) < 0.5 ? 0.0 : floor(seed * 16.0)) /* satellite dishes all face south (view 0 = camera south of it) */ + (prop ? 0.5 : 0.0), f0 = floor(a), vy = (uDirRows - slot - 1.0 + h) / uDirRows;
        vUv = vec2((mod(f0, 16.0) + position.x + 0.5) / 16.0, vy); vUvB = vec2((mod(f0 + 1.0, 16.0) + position.x + 0.5) / 16.0, vy);
        vMix = prop ? 0.0 : smoothstep(0.3, 0.7, a - f0); vTree = 1.0; }
      vSeed = seed; vFogDepth = -mv.z; vProp = prop ? 1.0 : 0.0;
      // a tree standing in front of the player turns see-through (same pixel pattern as the houses)
      vSee = 0.0;
      if (uSee > 0.5) {
        vec3 base = vec3(iA.x, y0, iA.y);
        vec4 pc = projectionMatrix * viewMatrix * vec4(uPlayer + vec3(0.0, 1.0, 0.0), 1.0);
        vec4 bc = projectionMatrix * viewMatrix * vec4(base, 1.0), tc = projectionMatrix * viewMatrix * vec4(base + uUp * iA.w, 1.0), rc = projectionMatrix * viewMatrix * vec4(base + uRight * iA.z * 0.55, 1.0);
        vec2 pn = pc.xy / pc.w, bn = bc.xy / bc.w, tn = tc.xy / tc.w, rn = rc.xy / rc.w;
        float hw = abs(rn.x - bn.x) + 0.02;
        bool inside = abs(pn.x - bn.x) < hw && pn.y > min(bn.y, tn.y) - 0.02 && pn.y < max(bn.y, tn.y);
        bool front = (viewMatrix * vec4(base, 1.0)).z > (viewMatrix * vec4(uPlayer, 1.0)).z + 0.8;
        if (inside && front) vSee = 1.0;
      }
    }`,
  fragmentShader: `
    uniform sampler2D uAtlas, uTrees; uniform vec3 uLight, uFogColor; uniform float uFogDensity;
    varying vec2 vUv, vUvB; varying float vSeed, vFogDepth, vSee, vH, vProp, vPerson, vMirror, vTree, vMix, vLamp, vPlant; uniform float uTime, uDirRows;
    float hxB2(vec2 a){a=floor(a);return fract(a.x*0.5+a.y*a.y*0.75);}
    float hh(float k){ return fract(sin(vSeed * k + k * 0.37) * 43758.5453); }
    bool mk(vec3 c, vec3 m){ return all(lessThan(abs(c - m), vec3(0.08))); }
    vec3 skinC(float r){ return r < .2 ? vec3(.96,.80,.68) : r < .4 ? vec3(.91,.72,.58) : r < .6 ? vec3(.80,.60,.45) : r < .75 ? vec3(.65,.46,.33) : r < .9 ? vec3(.48,.33,.24) : vec3(.36,.25,.19); }
    vec3 hairC(float r){ return r < .22 ? vec3(.10,.08,.07) : r < .44 ? vec3(.30,.20,.12) : r < .6 ? vec3(.50,.34,.18) : r < .74 ? vec3(.86,.70,.38) : r < .82 ? vec3(.70,.30,.14) : r < .94 ? vec3(.62,.60,.58) : vec3(.90,.88,.84); }
    vec3 topC(float r){ return r < .1 ? vec3(.17,.35,.60) : r < .2 ? vec3(.78,.28,.23) : r < .3 ? vec3(.92,.92,.90) : r < .4 ? vec3(.20,.20,.22) : r < .48 ? vec3(.36,.55,.32) : r < .56 ? vec3(.90,.72,.25) : r < .64 ? vec3(.55,.38,.62) : r < .72 ? vec3(.46,.62,.72) : r < .8 ? vec3(.86,.55,.58) : r < .88 ? vec3(.55,.42,.30) : r < .94 ? vec3(.92,.48,.20) : vec3(.40,.44,.48); }
    vec3 legC(float r){ return r < .3 ? vec3(.17,.22,.36) : r < .45 ? vec3(.22,.22,.24) : r < .58 ? vec3(.40,.42,.46) : r < .7 ? vec3(.62,.52,.38) : r < .8 ? vec3(.30,.40,.58) : r < .9 ? vec3(.28,.24,.20) : vec3(.70,.66,.58); }
    vec3 extraC(float r){ return r < .3 ? vec3(.62,.16,.14) : r < .55 ? vec3(.15,.25,.45) : r < .75 ? vec3(.22,.22,.22) : vec3(.85,.80,.70); }
    vec4 swapP(vec3 m, out float kill) {
      bool longH = hh(3.1) > .55, skirt = hh(5.7) > .72, cap = hh(7.3) > .84, bag = hh(9.9) > .66, beard = !longH && hh(11.3) > .8;
      vec3 skin = skinC(hh(1.3)), hair = hairC(hh(2.9)), top = topC(hh(4.1)), leg = legC(hh(6.7)), ex = extraC(hh(8.3));
      kill = 0.0;
      if (mk(m, vec3(1., 0., 0.))) return vec4(skin, 1.); if (mk(m, vec3(.706, 0., 0.))) return vec4(skin * .82, 1.);
      if (mk(m, vec3(1., 1., 0.))) return vec4(hair, 1.);
      if (mk(m, vec3(1., .502, 0.))) { kill = longH ? 0. : 1.; return vec4(hair * .9, 1.); }
      if (mk(m, vec3(1., .502, .502))) return vec4(longH ? hair * .9 : top, 1.);
      if (mk(m, vec3(.502, 1., 0.))) return vec4(beard ? hair * .85 : skin, 1.);
      if (mk(m, vec3(.502, 0., 1.))) { kill = cap ? 0. : 1.; return vec4(ex, 1.); }
      if (mk(m, vec3(1., 0., .502))) { kill = bag ? 0. : 1.; return vec4(ex * .8, 1.); }
      if (mk(m, vec3(.502, .502, 1.))) return vec4(bag ? ex * .55 : top, 1.);
      if (mk(m, vec3(0., 1., 0.))) return vec4(top, 1.); if (mk(m, vec3(0., .667, 0.))) return vec4(top * .8, 1.);
      if (mk(m, vec3(0., 1., 1.))) { kill = skirt ? 0. : 1.; return vec4(leg, 1.); }
      if (mk(m, vec3(0., .502, 1.))) return vec4(leg * .95, 1.);
      if (mk(m, vec3(1., 0., 1.))) return vec4(skirt ? skin : leg, 1.); if (mk(m, vec3(.667, 0., .667))) return vec4((skirt ? skin : leg) * .8, 1.);
      return vec4(0.);
    }
    float hxBayer(vec2 a){return hxB2(0.5*a)*0.25+hxB2(a);}
    void main() {
      vec2 uvS = vUv;
      if (vMirror > 0.5) { float row = floor(vUv.y * ${SPRITE_ROWS * SPRITE_PX}.0); uvS.x += floor(sin(row * .9 + uTime * 2.2) * 1.6) / ${SPRITE_COLS * SPRITE_PX}.0; } // rows shift by whole pixels
      vec4 c = vTree > 0.5 ? texture2D(uTrees, hxBayer(gl_FragCoord.xy) < vMix ? uvS + (vUvB - vUv) : uvS) : texture2D(uAtlas, uvS); // dithered blend between two neighbouring views
      if (c.a < 0.5) discard;
      if (vMirror > 0.5) { float fy = fract(vUv.y * (vTree > 0.5 ? uDirRows : ${SPRITE_ROWS}.0)); if (hxBayer(gl_FragCoord.xy) < .5 + .4 * fy) discard; vec3 col = mix(c.rgb, vec3(.42, .56, .58), .55) * uLight * .9; // faint, fading out towards the treetop
        float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth); gl_FragColor = vec4(mix(col, uFogColor, clamp(f, 0.0, 1.0)), 1.0); return; }
      if (vPerson > 0.5) { // palette swap: marker colours -> this person's colours, optional parts on or off
        float kill = 0.0; vec4 r = swapP(c.rgb, kill);
        if (r.a > 0.5) { if (kill > 0.5) discard; c.rgb = r.rgb; }
        else { r = swapP(c.rgb / 0.55, kill); if (r.a > 0.5) { if (kill > 0.5) discard; c.rgb = r.rgb * 0.42; } } // the 1-px outline is a darkened marker
      }
      if (vSee > 0.5 && hxBayer(gl_FragCoord.xy) < 0.75) discard;
      // trees right in front of the camera (street view) dissolve instead of filling the screen with giant pixels
      if (vProp < 0.5 && vPerson < 0.5 && hxBayer(gl_FragCoord.xy) > clamp((vFogDepth - 3.0) / 7.0, 0.0, 1.0)) discard;
      // the foot dissolves into the (non-rotating) shadow patch on the ground, so no straight edge turns with the camera
      if (vPlant > 0.5 && vH < 0.22 && hxBayer(floor(vUv * vec2(${SPRITE_COLS * SPRITE_PX}.0, ${SPRITE_ROWS * SPRITE_PX}.0)) + vSeed * 7.0) > vH / 0.22) discard; // Runde 211: small plants fade into the ground
      if (vProp < 0.5 && vH < 0.07 && hxBayer(floor(vUv * vec2(${SPRITE_COLS * SPRITE_PX}.0, ${SPRITE_ROWS * SPRITE_PX}.0))) > vH / 0.07) discard;
      // each tree a little different: brightness and a slight shift towards yellow or blue-green
      vec3 tint = vProp > 0.5 ? vec3(1.0) : vec3(0.9 + vSeed * 0.2, 0.92 + fract(vSeed * 7.0) * 0.16, 0.88 + fract(vSeed * 13.0) * 0.18);
      vec3 col = c.rgb * tint * uLight;
      if (vLamp > 0.5 && c.r > 0.9 && c.g > 0.7) col = max(col, c.rgb * (1.0 + 0.6 * (1.0 - min(1.0, dot(uLight, vec3(.333)))))); // the flame keeps its light at night
      float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
      gl_FragColor = vec4(mix(col, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
    }`
});
// shadow under every crown: a flat round patch that darkens whatever lies below (grass or pavement), one draw call per tile
const shadowMat = new THREE.ShaderMaterial({
  uniforms: spriteUniforms, transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
  vertexShader: `
    attribute vec4 iA; attribute vec2 iB; varying vec2 vP;
    void main() {
      float s = iB.x > ${SPRITE_PROP}.0 - 0.5 ? 0.3 : (abs(iB.x - 6.0) < 0.5 || abs(iB.x - 7.0) < 0.5 || abs(iB.x - 14.0) < 0.5) ? 0.45 : 0.42; // radius relative to the sprite width
      vP = position.xz * 2.0;
      vec3 p = vec3(iA.x + position.x * iA.z * s * 2.0 + iA.z * 0.03, floor(iB.y) * 0.25 + 0.32, iA.y + position.z * iA.z * s * 1.7);
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: `
    varying vec2 vP;
    void main() {
      float r = dot(vP, vP); if (r > 1.0) discard;
      gl_FragColor = vec4(vec3(r < 0.12 ? 0.58 : r < 0.55 ? 0.68 : 0.8), 1.0);
    }`
});
const shadowQuad = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-.5, 0, -.5, .5, 0, -.5, .5, 0, .5, -.5, 0, .5]), 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
})();
const spriteQuad = (() => {
  const g = new THREE.BufferGeometry();
  // three rows (foot, 35 %, top) so the sprite can bend (see the vertex shader)
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-.5, 0, 0, .5, 0, 0, .5, .35, 0, -.5, .35, 0, .5, 1, 0, -.5, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5]);
  return g;
})();
// arr: Float32Array, stride 6 (x, z, width, height, type, seed)
function makeSpriteMesh(arr, shadow) {
  const n = arr.length / 6, g = new THREE.InstancedBufferGeometry(), q = shadow ? shadowQuad : spriteQuad;
  g.setIndex(q.index.clone()); g.setAttribute('position', q.getAttribute('position').clone()); // own copies: dispose() per tile is safe
  const ib = new THREE.InstancedInterleavedBuffer(arr, 6, 1);
  g.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0));
  g.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 2, 4));
  g.instanceCount = n;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, hm = 0;
  for (let i = 0; i < arr.length; i += 6) { x0 = Math.min(x0, arr[i]); x1 = Math.max(x1, arr[i]); z0 = Math.min(z0, arr[i + 1]); z1 = Math.max(z1, arr[i + 1]); hm = Math.max(hm, arr[i + 3] + Math.floor(arr[i + 5]) * .25); }
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, hm / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0, hm) / 2 + 10);
  const m = new THREE.Mesh(g, shadow ? shadowMat : spriteMat); m.matrixAutoUpdate = false; if (shadow) m.renderOrder = -1;
  return m;
}
// called every frame: sprites stand upright in the street view and face the isometric camera fully
function updateSprites(camObj, time, isIso, player, see) {
  const e = camObj.matrixWorld.elements, u = spriteUniforms;
  if (player) u.uPlayer.value.copy(player); u.uSee.value = see ? 1 : 0;
  const rx = e[0], rz = e[2], l = Math.hypot(rx, rz) || 1; u.uRight.value.set(rx / l, 0, rz / l);
  // lean towards the camera only as much as the camera looks down: upright at eye level, leaning back when seen from above
  // (otherwise squashed); nearby trees in the street view no longer tilt
  const down = Math.asin(Math.max(-1, Math.min(1, e[9]))), k = Math.max(0, Math.min(1, (down - 0.17) / 0.52));
  u.uUp.value.set(e[4] * k, 1 - k + e[5] * k, e[6] * k).normalize();
  u.uTime.value = time;
  // reflections: direction away from the camera on the ground and how long a flat mirror image must be to look as tall as the tree
  const fx = -e[8], fz = -e[10], fl = Math.hypot(fx, fz) || 1; u.uFwd.value.set(fx / fl, 0, fz / fl);
  const sinD = Math.max(.22, Math.min(.98, e[9])); u.uFlat.value = Math.sqrt(1 - sinD * sinD) / sinD * .9;
}
function lightSprites(hemi, sun, fog) {
  const L = spriteUniforms.uLight.value, a = hemi.intensity, s = sun.intensity;
  L.setRGB(hemi.color.r * a * .78 + hemi.groundColor.r * a * .22 + sun.color.r * s * .55,
           hemi.color.g * a * .78 + hemi.groundColor.g * a * .22 + sun.color.g * s * .55,
           hemi.color.b * a * .78 + hemi.groundColor.b * a * .22 + sun.color.b * s * .55);
  spriteUniforms.uFogColor.value.copy(fog.color); spriteUniforms.uFogDensity.value = fog.density;
}

