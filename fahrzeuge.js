/* HoodExplorer – Fahrzeug-Baukasten (Runde 88). Aus dem Entwurf vergleiche/fahrzeuge/fahrzeug-baukasten.html übernommen.
   Wenige Grundkörper aus Quadern und Keilen (Pkw-Formen, Transporter, LKW-Fahrgestell, Bus) + Aufkleber aus einem Bogen, der beim
   Start per Code gemalt wird (25-cm-Raster: Zahlen 110/112, Kreuz, Symbole). Jede Fahrzeug-Variante wird einmal zu EINER Geometrie
   gebacken (Farbe je Ecke, Aufkleber über UV im Bogen, Art je Ecke: Karosserie, Glas, Blaulicht) und mit Instancing gezeichnet:
   ein Draw-Call je Variante, die gerade unterwegs ist. Karosseriefarbe, Blaulicht an/aus und Blinkphase je Fahrzeug.
   Schnittstelle: window.HXFZ = { variants, material, tick(t) } */
(() => {
'use strict';
/* ---------------- Aufkleberbogen (Atlas) ---------------- */
const PX = 4, AW = 256, AH = 256;                         // Diorama-Raster: 1 Aufkleber-Pixel = 25 cm = etwa ein Spielpixel; nichts Feineres
const atlas = document.createElement('canvas'); atlas.width = AW; atlas.height = AH;
const A = atlas.getContext('2d');
let ax = 0, ay = 0, arow = 0, aUsed = 0; const cells = {};
function alloc(key, w, h, paint) {
  if (cells[key]) return key;
  if (ax + w > AW) { ax = 0; ay += arow + 1; arow = 0; }
  const c = { x: ax, y: ay, w, h }; ax += w + 1; arow = Math.max(arow, h); aUsed = Math.max(aUsed, ay + h);
  A.save(); A.translate(c.x, c.y); paint(A, w, h); A.restore(); cells[key] = c; return key;
}
const FONT = {}; ('A010101111101101B110101110101110C011100100100011D110101101101110E111100110100111F111100110100100G011100101101011H101101111101101I111010010010111J001001001101010K101101110101101L100100100100111M101111111101101N110101101101101O010101101101010P110101110100100Q010101101110011R110101110101101S011100010001110T111010010010010U101101101101111V101101101101010W101101111111101X101101010101101Y101101010010010Z111001010100111' +
  '0111101101101111101011001001011121100010101001113110001010001110410110111100100151111001100011106011100110101010711100101001001081010101010101009010101011001110-000000111000000.000000000000010+000010111010000/001001010100100 000000000000000').replace(/(.)([01]{15})/g, (m, ch, b) => { FONT[ch] = b; return ''; });
function px(c, x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }
function txt(c, s, x, y, col, sc = 1) { let cx = x; for (const ch of s) { const g = FONT[ch] || FONT[' ']; for (let i = 0; i < 15; i++) if (g[i] === '1') px(c, cx + (i % 3) * sc, y + Math.floor(i / 3) * sc, sc, sc, col); cx += 4 * sc; } }
const tw = (s, sc = 1) => s.length * 4 * sc - sc;
// text sticker: one or more centred lines, optional background plate
function T(lines, col, bg, sc = 1) {
  lines = [].concat(lines); const w = Math.max(...lines.map(l => tw(l, sc))) + 2, h = lines.length * 6 * sc - sc + 2;
  return alloc('T|' + lines.join('/') + '|' + col + '|' + (bg || '') + sc, w, h, (c) => { if (bg) px(c, 0, 0, w, h, bg); lines.forEach((l, i) => txt(c, l, Math.round((w - tw(l, sc)) / 2), 1 + i * 6 * sc, col, sc)); });
}
const ICONS = { // 5 x 5: one icon = 1.25 m, readable at diorama size
  blitz: ['00110', '01100', '11110', '00110', '01100'], tropfen: ['00100', '01110', '01110', '11111', '01110'],
  rolle: ['11110', '11111', '00001', '00110', '00100'], haus: ['00100', '01110', '11111', '01010', '01110'],
  blatt: ['00111', '01111', '11110', '11100', '10000'], hammer: ['11110', '11110', '00100', '00100', '00100'],
  brot: ['01110', '11111', '10101', '11111', '01110'], paket: ['01110', '11111', '10001', '11111', '11111'],
  schluessel: ['10001', '11011', '01110', '00100', '00100'], herz: ['01010', '11111', '11111', '01110', '00100'],
  plus: ['00100', '00100', '11111', '00100', '00100'], flocke: ['10101', '01110', '11111', '01110', '10101'],
  pizza: ['11111', '01101', '01110', '00100', '00100'], flasche: ['00100', '00100', '01110', '01110', '01110']
};
function I(name, col, bg) { return alloc('I|' + name + '|' + col + '|' + (bg || ''), 7, 7, (c) => { if (bg) px(c, 0, 0, 7, 7, bg); ICONS[name].forEach((r, y) => [...r].forEach((b, x) => { if (b === '1') px(c, x + 1, y + 1, 1, 1, col); })); }); }
// band: rows of colours (null = clear), 2 px wide - stretched along the vehicle
function Bk(rows) { return alloc('B|' + rows.join(','), 2, rows.length, (c) => rows.forEach((r, y) => { if (r) px(c, 0, y, 2, 1, r); })); }
// patterns made for one size (roller shutters, corrugated steel, ladder rungs)
function P(name, w, h) {
  return alloc('P|' + name + '|' + w + '|' + h, w, h, (c) => {
    if (name === 'rolltor') for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) px(c, x, y, 1, 1, x % 5 === 4 ? '#5c1410' : y % 2 ? '#c9cdd2' : '#a9aeb4'); // aluminium shutters, 50 cm slats, 1.25 m doors with red frames
    if (name === 'sicke') for (let x = 0; x < w; x += 2) px(c, x, 0, 1, h, 'rgba(0,0,0,.22)');
    if (name === 'leiter') { px(c, 0, 0, 1, h, '#f1f3f5'); px(c, w - 1, 0, 1, h, '#f1f3f5'); for (let y = 0; y < h; y += 2) px(c, 1, y, w - 2, 1, '#aab0b8'); } // rungs every 50 cm
    if (name === 'adr') px(c, 0, 0, w, h, '#f08a00');
    if (name === 'warn') for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) px(c, x, y, 1, 1, ((x + y) >> 1) % 2 ? '#d61e1e' : '#f4f4f4');
  });
}
const atlasTex = new THREE.CanvasTexture(atlas);
atlasTex.magFilter = atlasTex.minFilter = THREE.NearestFilter; atlasTex.generateMipmaps = false;
const DECAL = new THREE.MeshLambertMaterial({ map: atlasTex, transparent: true, alphaTest: .5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

/* ---------------- Bausteine ---------------- */
const C = { glass: '#4f7199', tint: '#16181c', tyre: '#1b1c20', rim: '#a3a9b0', dark: '#2b2c31', head: '#fff3c4', tail: '#c4262a', grey: '#8d939a', chrome: '#c9cdd2' };
const MATS = {}; const mat = c => MATS[c] || (MATS[c] = c === C.glass ? glassMat() : new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
/* Scheiben: nicht schwarz. Helles Blaugrau, oben heller (Himmel spiegelt), unten dunkler (Innenraum), zwei schräge Lichtstreifen
   im Weltraum - sie wandern beim Fahren und Drehen über die Scheiben. Nur getönte Scheiben (C.tint) bleiben fast schwarz. */
function glassMat() {
  const m = new THREE.MeshLambertMaterial({ color: C.glass, flatShading: true });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vLP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz; vLP = transformed;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vLP;').replace('#include <color_fragment>', `#include <color_fragment>
      float up = clamp(vLP.y * 2.2 + 0.5, 0.0, 1.0);                              // 0 bottom .. 1 top of the window part
      diffuseColor.rgb *= mix(0.72, 1.18, up);
      float st = fract((vWP.x * 0.8 - vWP.z * 0.8 + vWP.y * 1.6) * 0.42);
      if (st < 0.07 || (st > 0.13 && st < 0.16)) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.93, 0.98), 0.75);`);
  };
  return m;
}
const LIGHTS = [];
let PART = 0; // Runde 140: articulated vehicles - every mesh remembers which part (0 front, 1.. trailer/rear section) it belongs to
function V(name, base) { const g = new THREE.Group(); g.userData = { tris: 0, name, base, stk: 0 }; return g; }
function add(g, geo, m, x, y, z, ry = 0) { const mesh = new THREE.Mesh(geo, typeof m === 'string' ? mat(m) : m); mesh.position.set(x, y, z); mesh.rotation.y = ry; mesh.userData.part = PART; g.add(mesh); g.userData.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3; return mesh; }
function box(g, w, h, l, x, y, z, c) { return add(g, new THREE.BoxGeometry(w, h, l), c, x, y + h / 2, z); }
// prism: a box whose top face is pulled back at the front (front) and back (back) and narrowed (taper) - windscreens, noses
function prism(g, w, h, l, x, y, z, c, front = 0, back = 0, taper = 1) {
  const geo = new THREE.BoxGeometry(w, h, l), p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) { p.setZ(i, p.getZ(i) > 0 ? l / 2 - front : -l / 2 + back); p.setX(i, p.getX(i) * taper); }
  geo.computeVertexNormals(); return add(g, geo, c, x, y + h / 2, z);
}
function cylZ(g, r1, r2, len, x, y, z, c, seg = 8, tilt = 0) { const geo = new THREE.CylinderGeometry(r1, r2, len, seg); geo.rotateX(-Math.PI / 2); if (tilt) geo.rotateX(tilt); return add(g, geo, c, x, y, z); }
function wheel(g, r, w, x, z) { const t = new THREE.CylinderGeometry(r, r, w, 6); t.rotateZ(Math.PI / 2); add(g, t, C.tyre, x, r, z); const h = new THREE.CylinderGeometry(r * .5, r * .5, w + .02, 6); h.rotateZ(Math.PI / 2); add(g, h, C.rim, x, r, z); }
function axle(g, r, w, W, z) { for (const s of [-1, 1]) wheel(g, r, w, s * (W / 2 - w / 2 + .05), z); }
function beacon(g, x, y, z, ph, amber, s = 1) { const m = new THREE.MeshBasicMaterial({ color: amber ? '#b8780f' : '#3157b8' }); add(g, new THREE.BoxGeometry(.5 * s, .32 * s, .45 * s), m, x, y + .16 * s, z); LIGHTS.push({ m, ph, on: new THREE.Color(amber ? '#ffd36a' : '#8ab8ff'), off: new THREE.Color(amber ? '#b8780f' : '#3157b8') }); } // 50 x 45 cm; aus: getöntes Blau wie eine Kunststoffkuppel, an: hell
function lightbar(g, y, z, w = 1.5) { box(g, w, .12, .5, 0, y, z, '#d9dde2'); beacon(g, -w / 2 + .26, y + .1, z, 0); beacon(g, w / 2 - .26, y + .1, z, 1); } // across the whole roof
function setUV(geo, c, stretch) {
  const uv = geo.attributes.uv; if (!uv.orig) uv.orig = uv.array.slice();
  const u0 = stretch ? (c.x + 1) / AW : (c.x + .02) / AW, u1 = stretch ? u0 : (c.x + c.w - .02) / AW, vt = 1 - (c.y + .02) / AH, vb = 1 - (c.y + c.h - .02) / AH;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.orig[i * 2], vb + (vt - vb) * uv.orig[i * 2 + 1]);
  uv.needsUpdate = true;
}
// sticker on both sides: fixed pixel size (text, icons) unless len/h given; stretch for bands
function stk(g, key, zc, yc, hw, o = {}) {
  const c = cells[key], L = o.len || c.w / PX * (o.sc || 1), H = o.h || c.h / PX * (o.sc || 1), out = [];
  for (const s of (o.sides || [1, -1])) { const geo = new THREE.PlaneGeometry(L, H); setUV(geo, c, o.stretch); const m = add(g, geo, DECAL, s * (hw + .012 + (o.off || 0)), yc, zc, s * Math.PI / 2); m.renderOrder = 2; out.push(m); }
  g.userData.stk++; return out;
}
function band(g, rows, zc, yc, hw, len, o = {}) { return stk(g, Bk(rows), zc, yc, hw, Object.assign({ len, stretch: true }, o)); }
function front(g, key, x, yc, zf, sc = 1) { const c = cells[key], geo = new THREE.PlaneGeometry(c.w / PX * sc, c.h / PX * sc); setUV(geo, c); add(g, geo, DECAL, x, yc, zf + .012); g.userData.stk++; }
function roofStk(g, key, y, z, sc = 1) { const c = cells[key], geo = new THREE.PlaneGeometry(c.w / PX * sc, c.h / PX * sc); setUV(geo, c); geo.rotateX(-Math.PI / 2); geo.rotateY(Math.PI / 2); add(g, geo, DECAL, 0, y + .012, z); g.userData.stk++; } // seen from above: the diorama camera looks at roofs
function topStk(g, key, w, len, x, y, z) { const c = cells[key], geo = new THREE.PlaneGeometry(w, len); setUV(geo, c); geo.rotateX(-Math.PI / 2); add(g, geo, DECAL, x, y, z); g.userData.stk++; }

/* ---------------- Grundkörper ---------------- */
// Pkw: front = +z. style hatch | estate | suv | kasten (Hochdachkombi)
function car(name, o = {}) {
  const g = V(name, o.base || 'Pkw'), L = o.L || 4.5, W = o.W || 1.8, s = o.style || 'estate', body = o.body || '#a9adb2', suv = s === 'suv', low = s === 'sport' || s === 'super' || s === 'cabrio', glass = o.tint ? C.tint : C.glass;
  const r = suv ? .37 : low ? .33 : .32, y0 = suv ? .32 : low ? .17 : .22, bh = suv ? .72 : low ? .5 : .6, top = y0 + bh;
  box(g, W, bh, L, 0, y0, 0, body);
  box(g, W + .02, .22, .14, 0, y0 - .02, L / 2 - .02, C.dark); box(g, W + .02, .22, .14, 0, y0 - .02, -L / 2 + .02, C.dark);
  let ch, cz, cl;
  if (s === 'kasten') {
    ch = .95; cl = .82 * L; cz = -.09 * L;
    box(g, W * .97, ch, cl - .75, 0, top, cz - .375, body);                                     // high box behind the windscreen
    prism(g, W * .95, ch, .8, 0, top, cz + cl / 2 - .4, C.glass, .62, 0, .94);                   // windscreen
    for (const sd of [-1, 1]) box(g, .03, .42, .7, sd * (W * .485 + .01), top + .38, cz + cl / 2 - 1.05, C.glass);
    g.userData.side = { z: cz - .75, len: cl - 1.6, y: top + ch / 2 - .05, hw: W * .485 }; g.userData.roofZ = cz - .375; g.userData.barZ = cz + cl / 2 - 1.1;
  } else if (s === 'cabrio') {                                                                 // open top: windscreen, seats, roll bars
    ch = .34; cl = .4 * L; cz = -.08 * L;
    prism(g, W * .9, ch, .45, 0, top, cz + cl / 2, glass, .32, 0, .92);
    box(g, W * .84, .04, cl - .3, 0, top - .02, cz - .1, '#3a2c26');
    for (const sd of [-1, 1]) { box(g, .5, .45, .45, sd * .4, top - .1, cz, '#5a3a2e'); box(g, .1, .32, .1, sd * .4, top + .25, cz - .3, C.dark); }
    g.userData.roofZ = cz; g.userData.barZ = cz; g.userData.side = { z: -.03 * L, len: L * .96, y: y0 + bh / 2, hw: W / 2 };
  } else {
    const cab = { hatch: [.56, -.08, .48, .16], estate: [.66, -.11, .48, .07], suv: [.64, -.1, .44, .08], saloon: [.5, -.05, .5, .42], limo: [.56, -.05, .5, .42], sport: [.44, -.12, .62, .52], super: [.42, -.06, .78, .62] }[s];
    ch = suv ? .6 : s === 'sport' ? .42 : s === 'super' ? .36 : .52; cl = cab[0] * L; cz = cab[1] * L; const f = cab[2], b = cab[3];
    prism(g, W * .93, ch, cl, 0, top, cz, glass, f, b, .9);
    // pillars in body colour split the side glass like doors (A, B, C) - glass is never one dark band
    const pz = { hatch: [.06], estate: [.1, -.24], saloon: [.04], limo: [.14, -.1], suv: [.1, -.24] }[s] || []; // B- and C-pillars as fractions of the cabin length
    for (const sd of [-1, 1]) for (const z of pz) box(g, .05, ch - .04, .14, sd * W * .44, top, cz + z * cl, body);
    box(g, W * .84, .07, cl - f - b + .04, 0, top + ch - .02, cz + (b - f) / 2, body); g.userData.roofZ = cz + (b - f) / 2; g.userData.barZ = cz + (b - f) / 2 + (cl - f - b) / 2 - .35;
    g.userData.side = { z: -.03 * L, len: L * .96, y: y0 + bh / 2, hw: W / 2 };
  }
  if (s === 'super') { box(g, W * .95, .1, .5, 0, top + .32, -L / 2 + .3, body); for (const sd of [-1, 1]) box(g, .08, .32, .2, sd * .6, top, -L / 2 + .3, C.dark); } // rear wing
  if (o.spoiler) box(g, W * .9, .06, .35, 0, top + .18, -L / 2 + .25, C.dark);
  if (o.chrome) { box(g, W + .02, .06, L * .9, 0, y0 + .05, 0, '#c9cdd2'); box(g, W * .5, .22, .04, 0, top - .3, L / 2 + .02, '#c9cdd2'); }
  for (const sd of [-1, 1]) { box(g, .34, .13, .04, sd * (W / 2 - .25), top - .2, L / 2 + .01, C.head); box(g, .3, .13, .04, sd * (W / 2 - .22), top - .2, -L / 2 - .03, C.tail); }
  const ww = low ? .3 : .24; axle(g, r, ww, W + .1, L / 2 - (low ? .9 : .78)); axle(g, r, ww, W + .1, -L / 2 + (low ? .95 : .82));
  g.userData.roof = top + ch + .02; g.userData.dims = { L, W, y0, bh, top };
  return g;
}
// Geländewagen (Runde 92): kastig und hoch, fast senkrechte Scheibe, flache Haube, Kotflügelverbreiterungen, große Räder.
// form: kurz | lang | offen | pickup; Extras: rad (Reserverad hinten), dach (Gepäckträger), kanister, schnorchel, bullbar, zelt, verdeck, dachfarbe
function gelaende(name, o = {}) {
  const g = V(name, 'Geländewagen'), f = o.form || 'kurz', L = f === 'lang' || f === 'pickup' ? 4.7 : 4.0, W = 1.86, body = o.body || '#5b6b3a';
  const r = .42, y0 = .52, bh = .62, top = y0 + bh, ch = .64, glass = o.tint ? C.tint : C.glass;
  box(g, W, bh, L, 0, y0, 0, body);
  box(g, W * .72, .26, L - .5, 0, .3, 0, C.dark);                                            // frame and axles under the body
  box(g, W * .55, .05, 1.1, 0, top, L / 2 - .6, body);                                       // raised bonnet middle
  const cabF = L / 2 - 1.2, cabB = f === 'pickup' ? cabF - 1.95 : -L / 2 + .04, cl = cabF - cabB, cz = (cabF + cabB) / 2;
  if (f === 'offen') {
    prism(g, W * .94, .5, .14, 0, top, cabF, glass, .06, 0, .98);                               // windscreen
    box(g, W * .96, .06, .16, 0, top + .5, cabF, C.dark);                                      // its frame
    box(g, W * .86, .05, cl - .3, 0, top - .03, cz - .1, '#2f2a26');                           // floor
    for (const sd of [-1, 1]) { box(g, .55, .48, .5, sd * .42, top - .05, cabF - .65, '#3c332c'); box(g, .55, .48, .5, sd * .42, top - .05, cabF - 1.55, '#3c332c'); }
    for (const sd of [-1, 1]) box(g, .09, .7, .09, sd * (W / 2 - .12), top, cabF - 1.1, C.dark); box(g, W - .1, .09, .09, 0, top + .66, cabF - 1.1, C.dark); // roll bar
    if (o.verdeck) { box(g, W * .98, .62, cl - .55, 0, top + .02, cz - .27, o.verdeck); for (const sd of [-1, 1]) box(g, .03, .32, cl - 1.0, sd * (W * .49 + .01), top + .22, cz - .4, glass); }
  } else {
    prism(g, W * .97, ch, cl, 0, top, cz, glass, .1, .02, .98);                                 // glasshouse: nearly upright
    box(g, W * .99, .08, cl - .08, 0, top + ch - .03, cz - .05, o.dachfarbe || body);           // roof
    const pz = f === 'lang' ? [.1, -.2] : f === 'pickup' ? [] : [-.05];
    for (const sd of [-1, 1]) { for (const z of pz) box(g, .06, ch - .05, .16, sd * W * .485, top, cz + z * cl, o.dachfarbe || body); box(g, .06, ch - .05, .14, sd * W * .485, top, cabB + .1, o.dachfarbe || body); }
  }
  if (f === 'pickup') { const bl = cabB + L / 2 - .1, bz = -L / 2 + bl / 2 + .02; box(g, W - .12, .06, bl - .1, 0, top - .02, bz, '#3a3632'); for (const sd of [-1, 1]) box(g, .08, .32, bl, sd * (W / 2 - .04), top, bz, body); box(g, W, .32, .08, 0, top, -L / 2 + .04, body);
    if (o.ladung) { box(g, .8, .5, .7, -.35, top, bz + .3, '#8a6a42'); box(g, .6, .4, .6, .45, top, bz - .4, '#6d7a52'); } }
  for (const z of [L / 2 - .78, -L / 2 + .82]) box(g, W + .16, .14, 1.12, 0, .8, z, C.dark);     // fender flares over the wheels
  box(g, W + .1, .24, .22, 0, .4, L / 2 + .06, C.dark); box(g, W + .1, .24, .2, 0, .4, -L / 2 - .05, C.dark);
  box(g, W * .48, .3, .04, 0, top - .38, L / 2 + .01, '#22252a');                              // grille
  for (const sd of [-1, 1]) { box(g, .26, .26, .05, sd * (W / 2 - .3), top - .38, L / 2 + .01, C.head); box(g, .18, .32, .05, sd * (W / 2 - .14), top - .3, -L / 2 - .02, C.tail); }
  if (o.bullbar) { for (const sd of [-1, 1]) box(g, .09, .7, .09, sd * .55, .35, L / 2 + .2, '#1d1f22'); box(g, 1.3, .09, .09, 0, .95, L / 2 + .2, '#1d1f22'); box(g, 1.3, .09, .09, 0, .6, L / 2 + .2, '#1d1f22'); }
  if (o.rad && f !== 'pickup') { cylZ(g, .4, .4, .26, 0, top + .1, -L / 2 - .16, C.tyre, 8); cylZ(g, .2, .2, .28, 0, top + .1, -L / 2 - .16, C.rim, 6); }
  if (o.schnorchel) { box(g, .12, ch + .5, .12, W / 2 + .07, top - .45, cabF - .05, '#1d1f22'); box(g, .16, .12, .26, W / 2 + .07, top + ch, cabF + .02, '#1d1f22'); }
  const roofY = f === 'offen' ? top + .72 : top + ch + .05;
  if (o.dach && f !== 'offen') { box(g, W * .92, .07, cl * .8, 0, roofY, cz - .1, '#26282c'); for (const sd of [-1, 1]) box(g, .05, .14, cl * .8, sd * W * .46, roofY, cz - .1, '#26282c');
    if (o.kanister) for (let i = 0; i < 3; i++) box(g, .3, .4, .45, -.5 + i * .5, roofY + .07, cz - cl * .3, '#3d5a2e'); }
  if (o.zelt && f !== 'offen') box(g, W * .94, .32, cl * .85, 0, roofY, cz - .05, o.zelt);
  axle(g, r, .34, W + .2, L / 2 - .78); axle(g, r, .34, W + .2, -L / 2 + .82);
  g.userData.side = { z: cz, len: cl, y: y0 + bh / 2, hw: W / 2 }; g.userData.roof = roofY; g.userData.roofZ = cz; g.userData.barZ = cabF - .5; g.userData.dims = { L, W, y0, bh, top };
  return g;
}
// Transporter (front = +z). o.win: side windows, o.koffer: box body (ambulance, small removals)
function van(name, o = {}) {
  const g = V(name, o.koffer ? 'Transporter + Koffer' : 'Transporter'), L = o.L || 5.9, W = 2.0, H = o.H || 2.6, y0 = .4, nose = 1.05, body = o.body || '#eeeeea';
  const cabTop = o.koffer ? 2.3 : H, zc = L / 2 - nose;                                         // zc: back edge of the bonnet
  prism(g, W * .97, .8, nose, 0, y0, L / 2 - nose / 2, body, .25, 0, .95);                     // bonnet
  prism(g, W * .95, cabTop - y0 - .88, nose * .82, 0, y0 + .8, zc + nose * .41, C.glass, nose * .56, 0, .95); // windscreen
  if (o.koffer) {
    box(g, W, cabTop - y0, 1.0, 0, y0, zc - .5, body);                                          // cab
    box(g, W + .26, 2.95 - .55, L - nose - .95, 0, .55, -nose / 2 - .475 - .1, o.box || body);  // box body
    g.userData.side = { z: -nose / 2 - .58, len: L - nose - 1.1, y: 1.75, hw: (W + .26) / 2, top: 2.95 };
  } else {
    box(g, W, H - y0, L - nose, 0, y0, -nose / 2, body);
    if (o.win) for (const sd of [-1, 1]) box(g, .03, .62, L - nose - 1.8, sd * (W / 2 + .005), 1.4, -nose / 2 - .25, C.glass);
    g.userData.side = { z: -nose / 2 - .55, len: L - nose - 1.4, y: 1.55, hw: W / 2, top: H };
  }
  box(g, W * .99, .1, .32, 0, cabTop - .1, zc + .1, body);
  for (const sd of [-1, 1]) box(g, .03, .62, .66, sd * (W / 2 + .005), 1.38, zc - .45, C.glass);
  box(g, W + .04, .28, .2, 0, .25, L / 2, C.dark); box(g, W + .04, .28, .16, 0, .25, -L / 2 - .05, C.dark);
  for (const sd of [-1, 1]) { box(g, .36, .16, .04, sd * .7, .85, L / 2 + .01, C.head); box(g, .14, .5, .04, sd * .9, .75, -L / 2 - .03 - (o.koffer ? .1 : 0), C.tail); }
  axle(g, .37, .26, W + .1, L / 2 - .8); axle(g, .37, .26, W + .1, -L / 2 + 1.05);
  g.userData.roof = (o.koffer ? 2.95 : H) + .01; g.userData.cabRoof = cabTop + .01; g.userData.dims = { L, W, H, zc };
  return g;
}
// LKW-Fahrgestell: Fahrerhaus + Aufbau. type: koffer | plane | tank | mixer | kipper | muell | hlf | tlf | dlk | none
function truck(name, o = {}) {
  const g = V(name, 'LKW-Fahrgestell'), L = o.L || 8, W = 2.45, crew = !!o.crew, cabL = crew ? 2.9 : 1.9, cabH = o.cabH || 3.0, cc = o.cab || '#e9e9e5';
  box(g, W * .72, .3, L - .3, 0, .55, -.1, C.dark);                                             // frame
  box(g, W * .98, .4, cabL - .2, 0, .55, L / 2 - cabL / 2, C.dark);                              // steps
  box(g, W, cabH - .95, cabL, 0, .95, L / 2 - cabL / 2, cc);
  box(g, W + .04, .45, .22, 0, .4, L / 2, C.dark);
  box(g, W * .88, 1.0, .04, 0, cabH - 1.35, L / 2 + .01, C.glass);
  for (const sd of [-1, 1]) { box(g, .03, .85, .95, sd * (W / 2 + .005), cabH - 1.3, L / 2 - .6, C.glass); if (crew) box(g, .03, .75, .9, sd * (W / 2 + .005), cabH - 1.25, L / 2 - 1.75, C.glass); box(g, .36, .18, .04, sd * .85, .7, L / 2 + .12, C.head); }
  const bodyL = L - cabL - .2, bz = -L / 2 + bodyL / 2, bc = o.body || '#f1f1ed';
  axle(g, .5, .4, W, L / 2 - 1.3); for (const z of (o.rear || [-L / 2 + 1.5])) axle(g, .5, .5, W, z);
  const t = o.type || 'koffer', sd = { z: bz, len: bodyL - .3, hw: W / 2 };
  if (t === 'koffer' || t === 'plane') { const bh = o.bh || 2.6; box(g, W + (t === 'plane' ? 0 : .05), bh, bodyL, 0, 1.05, bz, bc); sd.y = 1.05 + bh / 2; sd.h = bh; sd.hw = (W + .05) / 2; if (t === 'plane') { box(g, W, .12, bodyL, 0, .93, bz, C.dark); } if (o.kuehl) box(g, 1.4, .8, .45, 0, 2.3, -L / 2 + bodyL + .05, '#d5d7da'); }
  if (t === 'tank') { cylZ(g, 1.1, 1.1, bodyL - .3, 0, 2.15, bz, bc, 8); box(g, .6, .1, bodyL - .6, 0, 3.25, bz, C.grey); sd.y = 2.1; sd.hw = 1.1; }
  if (t === 'mixer') { cylZ(g, .7, 1.2, bodyL - .4, 0, 2.3, bz - .1, bc, 8, .14); box(g, 1.0, .9, .5, 0, 1.0, bz + bodyL / 2 - .3, C.grey); }
  if (t === 'kipper') { box(g, W, .95, bodyL, 0, 1.15, bz, bc); box(g, W - .25, .3, bodyL - .25, 0, 1.75, bz, '#8b7d68'); }
  if (t === 'muell') { box(g, W, 2.5, bodyL - .8, 0, 1.05, bz + .4, bc); prism(g, W, 2.3, 1.0, 0, 1.05, -L / 2 + .2, bc, 0, .55); box(g, W * .8, .8, .3, 0, .8, -L / 2 - .2, C.dark); sd.y = 2.3; sd.z = bz + .4; sd.len = bodyL - 1.2; }
  if (t === 'hlf' || t === 'tlf') { box(g, W, 2.35, bodyL, 0, 1.05, bz, bc); sd.y = 2.22; sd.h = 2.35; }
  if (t === 'hlf') { box(g, .45, .14, bodyL - 1.0, -.6, 3.4, bz, C.grey); topStk(g, P('leiter', 3, Math.round((bodyL - 1.0) * PX)), .75, bodyL - 1.0, .4, 3.42, bz); }
  if (t === 'dlk') {
    box(g, W, 1.15, bodyL, 0, 1.05, bz, bc); add(g, new THREE.CylinderGeometry(.85, .85, .3, 8), C.grey, 0, 2.35, -L / 2 + 1.5);
    const ll = L - .6, lz = -L / 2 + .2 + ll / 2;                                                // ladder from the turntable over the cab
    box(g, 1.1, .45, 1.2, 0, 2.45, -L / 2 + 1.5, '#d9dde2');
    for (const s2 of [-1, 1]) box(g, .22, .4, ll, s2 * .52, 2.9, lz, '#f1f3f5');
    topStk(g, P('leiter', 4, Math.round(ll * PX)), 1.0, ll, 0, 3.0, lz); sd.y = 1.6;
  }
  g.userData.side = sd; g.userData.roof = cabH + .01; g.userData.bodyTop = { hlf: 3.4, tlf: 3.4, dlk: 2.2, koffer: 1.05 + (o.bh || 2.6) }[t] || 3.4;
  g.userData.dims = { L, W, cabL, cabH, bodyL, bz };
  return g;
}
// Bus-Wagenteil; o.art: Gelenkbus
function bus(name, o = {}) {
  const g = V(name, 'Bus-Wagenteil'), W = 2.55, H = o.H || 3.05, y0 = .35, c = o.body || '#f1f1ec';
  const segs = o.art ? [[10.4, 4.35, 1, 0], [7.0, -4.75, 0, 1]] : [[o.L || 12, 0, 1, 1]];
  for (const [len, zc, isF, isR] of segs) { if (o.art) PART = isF ? 0 : 1;
    box(g, W, H - y0, len, 0, y0, zc, c);
    const z0 = zc - len / 2 + (isR ? .7 : .2), z1 = zc + len / 2 - (isF ? .5 : .2), wh = o.coach ? 1.15 : 1.35;
    for (const sd of [-1, 1]) box(g, .03, wh, z1 - z0, sd * (W / 2 + .005), H - wh - .3, (z0 + z1) / 2, C.glass);
    if (isF) { box(g, W * .92, 1.75, .04, 0, .95, zc + len / 2 + .01, C.glass); box(g, W * .8, .5, .05, 0, H - .62, zc + len / 2 + .02, '#ffb22e'); }
    if (isR) box(g, W * .8, .85, .04, 0, H - 1.3, zc - len / 2 - .01, C.glass);
    box(g, 1.4, .26, 2.6, 0, H, zc - len / 2 + 2.2, '#d9dad5');
    if (isF) axle(g, .5, .32, W, zc + len / 2 - 2.6); axle(g, .5, .45, W, isR ? zc - len / 2 + 2.9 : zc - len / 2 + 1.6);
    g.userData.segs = (g.userData.segs || []).concat([{ len, zc }]);
  }
  if (o.art) { for (const sd of [-1, 1]) { PART = 1; box(g, .3, .22, .05, sd * (W / 2 - .3), 1.0, -8.25 - .03, C.tail); } PART = 2; box(g, W * .86, H - y0 - .35, 1.0, 0, y0 + .15, -1.05, '#2c2e33'); PART = 0; // bellows: turns half as far as the rear section
    g.userData.joints = [{ p: 1, par: 0, z: -1.05, d: 4.3, max: .75 }, { p: 2, par: 0, z: -1.05, half: 1 }]; } // joint just behind the middle axle; d: joint to the rear axle
  g.userData.side = { hw: W / 2, H };
  return g;
}
// Schienen-Wagenteil (front = +z): nose at front/back, window band, bogies
function railcar(g, len, zc, o) {
  const W = o.W || 2.9, H = o.H || 4.0, y0 = o.y0 || 1.05, c = o.body, n = o.nose || 0, nf = o.noseF ? n : 0, nr = o.noseR ? n : 0;
  box(g, W, H - y0, len - nf - nr, 0, y0, zc + (nr - nf) / 2, c);
  const lowH = o.lowH || 1.15;
  if (nf) { prism(g, W, lowH, nf, 0, y0, zc + len / 2 - nf / 2, c, nf * .25, 0, .97); prism(g, W * .97, H - y0 - lowH, nf, 0, y0 + lowH, zc + len / 2 - nf / 2, C.glass, nf * .85, 0, .88); }
  if (nr) { prism(g, W, lowH, nr, 0, y0, zc - len / 2 + nr / 2, c, 0, nr * .25, .97); prism(g, W * .97, H - y0 - lowH, nr, 0, y0 + lowH, zc - len / 2 + nr / 2, C.glass, 0, nr * .85, .88); }
  if (o.win !== false) for (const sd of [-1, 1]) box(g, .03, o.winH || .9, len - nf - nr - 1.2, sd * (W / 2 + .005), y0 + (o.winY || 1.0), zc + (nr - nf) / 2, C.glass);
  const bl = o.bogie || 2.6; for (const e of [-1, 1]) box(g, W * .72, Math.max(.3, y0 - .25), bl, 0, .1, zc + e * (len / 2 - nf * .3 - nr * .3 - bl / 2 - .6), C.dark);
}
function railbed(g, len, zc, tram) {
  if (tram) { box(g, 3.4, .03, len, 0, -.03, zc, '#8f9298'); for (const s of [-1, 1]) box(g, .1, .015, len, s * .72, 0, zc, '#55585e'); return; }
  box(g, 3.6, .3, len, 0, -.42, zc, '#9b9385'); for (const s of [-1, 1]) box(g, .09, .12, len, s * .72, -.12, zc, '#6b6e74');
}

/* ---------------- Aufkleber-Kompositionen (Diorama-Regel) ----------------
   Raster 25 cm. Keine Wörter: Zahlen (110, 112), Kreuz und Symbole, mindestens 1,25 m groß.
   Die Kennung steht zusätzlich auf dem Dach, weil die Diorama-Kamera vor allem von oben schaut. */
const BL = { pol: ['#c8e61e', '#1f4ea3', '#1f4ea3'], rtw: ['#d6ee2c', '#ff4b2b', '#ff4b2b'], fw: ['#f4f4f4'], ktw: ['#ff4b2b', '#ff4b2b'] }; // Polizei: Blau-Silber mit Leuchtgelb; Rettung: Weiß mit Tagesleuchtrot
const SILBER = '#cdd2d7', POLBLAU = '#1f4ea3', FEUERROT = '#a9231c';
const ROT = '#c62128';
function polizeiCar(g) { const s = g.userData.side; band(g, BL.pol, s.z, s.y, s.hw, s.len, { h: .6 }); roofStk(g, T('110', POLBLAU), g.userData.roof, g.userData.roofZ - .3, .5); lightbar(g, g.userData.roof, g.userData.barZ); }
function firma(g, f) {
  const s = g.userData.side;
  band(g, f.band || [f.col, f.col], s.z, .8, s.hw, s.len + .6, { h: .5 });
  stk(g, I(f.icon, f.ink || '#ffffff', f.col), -1.0, 1.7, s.hw);                 // symbol on a plate in the firm's colour, 1.75 m
}
const FIRMEN = [
  { n: 'Elektro', icon: 'blitz', col: '#f2c400', ink: '#1e1e1e', band: ['#1e1e1e', '#f2c400'] },
  { n: 'Sanitär', icon: 'tropfen', col: '#1f6fc4' },
  { n: 'Malerei', icon: 'rolle', col: '#7a3eb1', band: ['#d6332b', '#f2b200', '#2f9a48', '#2a6fd0'] },
  { n: 'Dachdecker', icon: 'haus', col: '#a8302a' },
  { n: 'Gartenbau', icon: 'blatt', col: '#2e8a3c', body: '#e5ede0' },
  { n: 'Tischlerei', icon: 'hammer', col: '#875628' },
  { n: 'Bäckerei', icon: 'brot', col: '#b06a12', body: '#f3ead8' },
  { n: 'Paketdienst', icon: 'paket', col: '#0f5c60', body: '#1b8a8f', band: ['#0f5c60', '#0f5c60'] },
  { n: 'Hausmeister', icon: 'schluessel', col: '#34495e' }
];
const vanFirma = (f, name) => { const g = van(name || f.n, { body: f.body }); firma(g, f); return g; };
const plus = (g, z, y, hw, sc) => stk(g, I('plus', ROT, '#ffffff'), z, y, hw, { sc });

/* ---------------- Fahrzeuge ---------------- */
const B = {
  // Prinzip
  kombi: () => car('Kombi', { body: '#b4b8bd' }),
  kombiAuf: () => { const g = car('+ Aufkleber', { body: SILBER }); const s = g.userData.side; band(g, BL.pol, s.z, s.y, s.hw, s.len, { h: .6 }); roofStk(g, T('110', POLBLAU), g.userData.roof, g.userData.roofZ - .3, .5); return g; },
  streife: () => { const g = car('+ Blaulichtbalken', { body: SILBER }); polizeiCar(g); return g; },
  vanLeer: () => van('Transporter'),
  vanFirma: () => vanFirma(FIRMEN[0], '+ Firmenaufkleber'),
  vanKtw: () => { const g = van('+ Krankentransport'); const s = g.userData.side; band(g, BL.ktw, s.z + .3, 1.0, s.hw, s.len + 1.2, { h: .5 }); plus(g, -1.0, 1.75, s.hw); roofStk(g, I('plus', ROT, '#ffffff'), g.userData.roof, -1.0, 1.4); lightbar(g, g.userData.roof, 1.5, 1.8); return g; },
  vanPol: () => { const g = van('+ Polizei-Bulli', { body: SILBER }); const s = g.userData.side; band(g, BL.pol, s.z + .3, .9, s.hw, s.len + 1.2, { h: 1.0 }); stk(g, T('110', POLBLAU), -1.0, 1.95, s.hw); roofStk(g, T('110', POLBLAU), g.userData.roof, -1.0); lightbar(g, g.userData.roof, 1.5, 1.8); return g; },
  // Einsatz
  polKombi: () => { const g = car('Streifenwagen', { body: SILBER }); polizeiCar(g); return g; },
  polSuv: () => { const g = car('Polizei-SUV', { style: 'suv', body: SILBER, L: 4.7, W: 1.9 }); polizeiCar(g); return g; },
  polBulli: () => B.vanPol(),
  nef: () => { const g = car('Notarzt (NEF)', { body: '#f4f4f1' }); const s = g.userData.side; band(g, BL.rtw, s.z, s.y, s.hw, s.len, { h: .6 }); roofStk(g, I('plus', ROT, '#ffffff'), g.userData.roof, g.userData.roofZ - .3, .75); lightbar(g, g.userData.roof, g.userData.barZ); return g; },
  rtw: () => { const g = van('Rettungswagen (RTW)', { koffer: true, body: '#f4f4f1' }); const s = g.userData.side; band(g, BL.rtw, s.z, 1.0, s.hw, s.len + .2, { h: .6 }); band(g, BL.rtw, 1.4, 1.0, 1.0, 1.0, { h: .6 }); plus(g, s.z, 2.0, s.hw);
    roofStk(g, I('plus', ROT, '#ffffff'), g.userData.roof, s.z, 1.6); lightbar(g, g.userData.cabRoof, 1.3, 1.8); for (const x of [-.9, .9]) beacon(g, x, 2.96, -3.0, x > 0 ? 1 : 0); return g; },
  ktw: () => B.vanKtw(),
  fwSuv: () => { const g = car('Kommandowagen', { style: 'suv', body: FEUERROT, L: 4.7, W: 1.9 }); const s = g.userData.side; band(g, BL.fw, s.z, s.y - .1, s.hw, s.len, { h: .25 }); roofStk(g, T('112', '#ffffff'), g.userData.roof, g.userData.roofZ - .3, .5); lightbar(g, g.userData.roof, g.userData.barZ); return g; },
  elw: () => { const g = van('Einsatzleitwagen (ELW)', { body: FEUERROT }); const s = g.userData.side; band(g, BL.fw, s.z + .3, .95, s.hw, s.len + 1.2, { h: .25 }); stk(g, T('112', '#ffffff'), -1.0, 1.75, s.hw); roofStk(g, T('112', '#ffffff'), g.userData.roof, -1.0); lightbar(g, g.userData.roof, 1.5, 1.8); return g; },
  hlf: () => { const g = truck('Löschfahrzeug (HLF)', { crew: true, type: 'hlf', cab: FEUERROT, body: FEUERROT, L: 8.6 }); const d = g.userData.dims, s = g.userData.side;
    stk(g, P('rolltor', Math.round((d.bodyL - .4) * PX), 8), d.bz, 2.4, s.hw); band(g, BL.fw, 0, 1.15, s.hw, d.L - .2, { h: .25 }); band(g, BL.fw, 0, 3.3, s.hw, d.L - .2, { h: .15 }); stk(g, T('112', '#ffffff'), d.L / 2 - 1.45, 1.3, s.hw, { off: .004, sc: .5 });
    for (const x of [-.8, .8]) { beacon(g, x, d.cabH, d.L / 2 - .35, x > 0 ? 1 : 0); beacon(g, x, 3.4, -d.L / 2 + .35, x > 0 ? 0 : 1); } return g; },
  tlf: () => { const g = truck('Tanklöschfahrzeug (TLF)', { type: 'tlf', cab: FEUERROT, body: FEUERROT, L: 7.6 }); const d = g.userData.dims, s = g.userData.side;
    stk(g, P('rolltor', Math.round((d.bodyL - .4) * PX), 8), d.bz, 2.4, s.hw); band(g, BL.fw, 0, 1.15, s.hw, d.L - .2, { h: .25 }); band(g, BL.fw, 0, 3.3, s.hw, d.L - .2, { h: .15 }); stk(g, T('112', '#ffffff'), d.L / 2 - .95, 1.3, s.hw, { off: .004, sc: .5 }); roofStk(g, T('112', '#ffffff'), 3.4, d.bz);
    for (const x of [-.8, .8]) beacon(g, x, d.cabH, d.L / 2 - .35, x > 0 ? 1 : 0); return g; },
  dlk: () => { const g = truck('Drehleiter (DLK)', { type: 'dlk', cab: FEUERROT, body: FEUERROT, L: 9.8, rear: [-3.3, -4.6] }); const d = g.userData.dims, s = g.userData.side;
    band(g, BL.fw, 0, 1.15, s.hw, d.L - .2, { h: .25 }); stk(g, T('112', '#ffffff'), d.bz + .5, 1.65, s.hw, { off: .004, sc: .65 }); for (const x of [-.8, .8]) beacon(g, x, d.cabH, d.L / 2 - .35, x > 0 ? 1 : 0); return g; },
  // Handwerk & Alltag
  pritsche: () => { const g = V('Pritsche mit Dachleiter', 'Transporter (Fahrerhaus)'), v = van('x', { body: '#ef7d1a' }); // the van's cab part + a flat bed
    const keep = v.children.filter(m => m.position.z > .3 || m.geometry.type === 'CylinderGeometry'); keep.forEach(m => g.add(m.clone()));
    g.userData.tris = keep.reduce((a, m) => a + m.geometry.index.count / 3, 0);
    box(g, 2.0, 2.2, 1.0, 0, .4, 1.4, '#ef7d1a'); box(g, 2.0, .3, 3.8, 0, .75, -1.05, '#5d5f63');
    for (const sd of [-1, 1]) box(g, .06, .62, 3.8, sd * 1.0, 1.05, -1.05, '#ef7d1a'); box(g, 2.0, .62, .06, 0, 1.05, -2.95, '#ef7d1a');
    for (const sd of [-1, 1]) box(g, .14, .14, 4.2, sd * .6, 2.6, -.6, '#4b4d52');
    for (const sd of [-1, 1]) box(g, .1, 1.62, .1, sd * .93, 1.05, -2.8, '#4b4d52'); box(g, 1.96, .1, .1, 0, 2.55, -2.8, '#4b4d52'); /* Runde 111 (phone test): the ladder rack stands on a frame at the end of the bed - it floated over the open bed */ box(g, .75, .08, 4.4, 0, 2.74, -.6, '#d8dbdf'); topStk(g, P('leiter', 3, 18), .75, 4.4, 0, 2.825, -.6); return g; },
  pflege: () => { const g = car('Pflegedienst', { style: 'kasten', body: '#f4f4f1', L: 4.4 }); const s = g.userData.side; band(g, ['#e0457b'], 0, .45, g.userData.dims.W / 2, 4.2, { h: .25 }); stk(g, I('herz', '#ffffff', '#e0457b'), s.z, s.y, s.hw, { sc: .55 }); return g; },
  pizza: () => { const g = car('Pizzadienst', { style: 'hatch', body: '#d8352b', L: 3.9 }); box(g, .95, .45, .6, 0, g.userData.roof, -.3, '#f2f2ee'); stk(g, I('pizza', '#d8352b', '#f2f2ee'), -.3, g.userData.roof + .23, .475, { sc: .3 }); front(g, I('pizza', '#d8352b', '#f2f2ee'), 0, g.userData.roof + .23, -.0, .3); return g; },
  taxi: () => { const g = car('Taxi', { body: '#efe3bc' }); box(g, .9, .32, .45, 0, g.userData.roof, g.userData.roofZ, '#f6d64a'); return g; },
  // Geländewagen
  gwExpedition: () => gelaende('Expedition (kurz)', { body: '#5b6b3a', rad: true, dach: true, kanister: true }),
  gwSafari: () => gelaende('Safari (kurz)', { body: '#c9b48a', rad: true, schnorchel: true, bullbar: true }),
  gwKlassik: () => gelaende('Klassik (lang)', { form: 'lang', body: '#ecebe6', dachfarbe: '#1f2124', rad: true }),
  gwZelt: () => gelaende('Dachzelt (lang)', { form: 'lang', body: '#7fa6b8', dachfarbe: '#ecebe6', zelt: '#d6cdb6', rad: true }),
  gwJeep: () => gelaende('Jeep offen', { form: 'offen', body: '#b3312a', rad: true }),
  gwVerdeck: () => gelaende('Jeep mit Verdeck', { form: 'offen', body: '#2f4a32', verdeck: '#c8bfa4', rad: true }),
  gwPickup: () => gelaende('Pickup', { form: 'pickup', body: '#6b6f74', ladung: true, bullbar: true }),
  gwFoerster: () => { const g = gelaende('Förster', { body: '#2f4a32', dach: true, rad: true }); stk(g, I('blatt', '#ffffff', '#2e8a3c'), g.userData.side.z + .3, 1.6, g.userData.side.hw, { sc: .55 }); return g; },
  gwFeuerwehr: () => { const g = gelaende('Feuerwehr (lang)', { form: 'lang', body: FEUERROT, bullbar: true }); band(g, BL.fw, 0, .9, g.userData.dims.W / 2, g.userData.dims.L - .3, { h: .25 }); roofStk(g, T('112', '#ffffff'), g.userData.roof, g.userData.roofZ - .4, .5); lightbar(g, g.userData.roof, g.userData.barZ); return g; },
  // Pkw
  sportRot: () => car('Sportcoupé', { style: 'sport', body: '#c8201c', L: 4.4, W: 1.92 }),
  sportGelb: () => car('Sportcoupé mit Spoiler', { style: 'sport', body: '#f2c200', L: 4.4, W: 1.92, spoiler: true }),
  cabrio: () => car('Cabrio', { style: 'cabrio', body: '#2a63c4', L: 4.2, W: 1.85 }),
  supercar: () => car('Supersportwagen', { style: 'super', body: '#e8641a', L: 4.6, W: 2.0 }),
  limo: () => car('Limousine', { style: 'saloon', body: '#56606b', L: 4.9, W: 1.85 }),
  mafia: () => car('Mafia-Limousine', { style: 'limo', body: '#141518', L: 5.9, W: 1.95, tint: true, chrome: true }),
  // LKW
  umzug: () => { const g = truck('Koffer-LKW', { type: 'koffer', L: 7.6 }); const s = g.userData.side; band(g, ['#1f4fa8', '#1f4fa8'], s.z, 1.35, s.hw, s.len, { h: .5 }); stk(g, I('paket', '#ffffff', '#1f4fa8'), s.z, 2.6, s.hw, { sc: 1.2 }); return g; },
  kuehl: () => { const g = truck('Kühlkoffer', { type: 'koffer', kuehl: true, L: 7.6, cab: '#2a5fa6' }); const s = g.userData.side; stk(g, I('flocke', '#ffffff', '#5fa3e0'), s.z, 2.4, s.hw, { sc: 1.2 }); band(g, ['#2a5fa6', '#2a5fa6'], s.z, 1.35, s.hw, s.len, { h: .5 }); return g; },
  getraenke: () => { const g = truck('Pritsche mit Plane', { type: 'plane', L: 7.6, body: '#b52a24', cab: '#f1f1ed', bh: 2.4 }); const s = g.userData.side; stk(g, I('flasche', '#ffffff', '#b52a24'), s.z, s.y, s.hw, { sc: 1.3 }); return g; },
  sattel: () => { const g = truck('Sattelzug', { type: 'none', L: 6.0, cabH: 3.6, cab: '#3b3f46', rear: [-1.7] }); box(g, 2.2, .1, 1.4, 0, 1.12, -1.5, '#26272b');
    PART = 1; const tz = -7.6; box(g, 2.55, 2.9, 13.6, 0, 1.3, tz, '#2f63b8'); for (const sd of [-1, 1]) box(g, .3, .2, .05, sd * 1.0, .75, tz - 6.8 - .03, C.tail); box(g, 1.6, .35, 13.4, 0, .95, tz, C.dark); for (const z of [tz - 4.0, tz - 5.3, tz - 6.6]) axle(g, .5, .45, 2.55, z); box(g, 1.8, .9, .3, 0, .1, tz + 4.2, '#46484d');
    stk(g, P('sicke', 54, 11), tz, 2.75, 1.275); band(g, ['#f2f2f2', null, '#f2f2f2'], tz, 1.8, 1.275, 13.4, { h: .75, off: .004 }); PART = 0;
    g.userData.joints = [{ p: 1, par: 0, z: -1.5, d: 11.4, max: 1.45 }]; g.userData.dims.L = 17.2; return g; }, // Runde 140: semi-trailer on the fifth wheel (kingpin z -1.5), d: to the middle of its axles
  haenger: () => { const g = truck('Hängerzug', { type: 'plane', L: 7.6, body: '#3d6b45', cab: '#e9e9e5', bh: 2.5 }); // Runde 140: lorry with drawbar trailer - two joints:
    // the drawbar turns at the coupling behind the lorry, the trailer body on the turntable over its front axle
    box(g, .5, .25, .5, 0, .55, -3.95, C.dark); PART = 1; box(g, .16, .14, 1.9, 0, .7, -4.95, C.dark); box(g, 1.9, .25, .7, 0, .72, -6.0, C.dark); axle(g, .5, .45, 2.45, -6.0);
    PART = 2; const hz = -9.1; box(g, 2.45, .3, 6.8, 0, .95, hz, C.dark); box(g, 2.45, 2.5, 6.8, 0, 1.25, hz, '#3d6b45'); box(g, 2.45, .12, 6.8, 0, 1.13, hz, C.dark); axle(g, .5, .45, 2.45, -11.3);
    for (const sd of [-1, 1]) box(g, .3, .2, .05, sd * 1.0, .75, hz - 3.4 - .03, C.tail); band(g, ['#f2f2f2'], hz, 2.5, 1.225, 6.4, { h: .25, off: .004 }); PART = 0;
    g.userData.joints = [{ p: 1, par: 0, z: -3.95, d: 2.05, max: 1.1 }, { p: 2, par: 1, z: -6.0, d: 5.3, max: 1.0 }]; g.userData.dims.L = 16.4; return g; },
  tank: () => { const g = truck('Tankwagen', { type: 'tank', L: 8.4, cab: '#e9e9e5', body: '#c9ccd0', rear: [-2.6, -3.9] }); front(g, P('adr', 3, 2), 0, 1.0, 4.42); stk(g, P('adr', 3, 2), -1.0, 1.5, 1.1, { off: .02 }); return g; },
  mixer: () => { const g = truck('Betonmischer', { type: 'mixer', L: 8.2, cab: '#f2b400', body: '#e8e8e4', rear: [-2.4, -3.7] }); return g; },
  kipper: () => { const g = truck('Kipper', { type: 'kipper', L: 8.2, cab: '#f2b400', body: '#7c8187', rear: [-2.4, -3.7] }); return g; },
  muell: () => { const g = truck('Müllwagen', { type: 'muell', L: 8.6, cab: '#f07a12', body: '#f07a12', rear: [-2.6, -3.9] }); const s = g.userData.side; band(g, ['#f4f4f4', null, '#f4f4f4'], s.z, 1.5, s.hw, s.len + 1, { h: .75 }); beacon(g, 0, 3.0, 3.9, 0, true, 1.2); return g; },
  // Busse
  stadtbus: () => { const g = bus('Stadtbus 12 m'); band(g, ['#c8202a', '#c8202a'], 0, .7, 1.275, 11.6, { h: .5 }); return g; },
  gelenkbus: () => { const g = bus('Gelenkbus 18 m', { art: true }); g.userData.segs.forEach((sg, i) => { PART = i ? 1 : 0; band(g, ['#22843c', '#22843c'], sg.zc, .7, 1.275, sg.len - .4, { h: .5 }); }); PART = 0; return g; },
  reisebus: () => { const g = bus('Reisebus', { H: 3.7, body: '#20304f', coach: true }); band(g, ['#c9a227', '#e8e8e8'], 0, 1.6, 1.275, 11.6, { h: .5 }); return g; },
  schulbus: () => { const g = van('Kleinbus', { win: true, body: '#f1f1ec' }); const s = g.userData.side; band(g, ['#f2a400', '#f2a400'], s.z, .8, s.hw, s.len + 1, { h: .5 }); const zc = g.userData.dims.zc; box(g, 1.9, .5, .3, 0, 2.6, zc + .1, '#f2a400'); return g; },
  // Schiene
  tram: () => { const g = V('Straßenbahn 3-teilig', 'Schienen-Wagenteil'); const o = { W: 2.3, H: 3.4, y0: .4, nose: 1.4, lowH: 1.0, body: '#f2f2ee', winY: .95, winH: 1.25, bogie: 1.8 };
    railbed(g, 36, 0, true); railcar(g, 11, 11, Object.assign({ noseF: 1 }, o)); railcar(g, 9, 0, o); railcar(g, 11, -11, Object.assign({ noseR: 1 }, o));
    for (const z of [5.25, -5.25]) box(g, 2.0, 2.6, .6, 0, .55, z, '#2b2d31');
    box(g, 1.0, .15, 1.0, 0, 3.4, 0, '#54575d'); for (const s of [-1, 1]) { const m = box(g, .12, 1.05, .12, 0, 3.45, s * .25, '#2b2d31'); m.rotation.x = s * .55; }
    for (const z of [11, 0, -11]) band(g, ['#c8202a', '#c8202a'], z, .75, 1.15, z ? 9.4 : 8.8, { h: .5 });
    return g; },
  regio: () => { const g = V('Regionalzug 2-teilig', 'Schienen-Wagenteil'); const o = { body: '#f1f1ee', nose: 2.6 }; railbed(g, 40, 0); railcar(g, 17, 8.8, Object.assign({ noseF: 1 }, o)); railcar(g, 17, -8.8, Object.assign({ noseR: 1 }, o)); box(g, 2.5, 2.6, .6, 0, 1.2, 0, '#2b2d31');
    for (const z of [8.8, -8.8]) band(g, ['#1f8a4a', '#1f8a4a', '#f2c400'], z, 1.55, 1.45, 14, { h: .75 }); return g; },
  fern: () => { const g = V('Fernzug', 'Schienen-Wagenteil'); const o = { body: '#f4f4f2', nose: 6, lowH: 1.0, H: 4.0, y0: 1.0 }; railbed(g, 52, 0);
    railcar(g, 21, 13.2, Object.assign({ noseF: 1, win: false }, o)); railcar(g, 25, -10.6, Object.assign({}, o, { nose: 0 })); box(g, 2.5, 2.6, .6, 0, 1.2, 2.3, '#2b2d31');
    band(g, ['#2349a8', '#2349a8'], 14.5, 1.55, 1.45, 14, { h: .5 }); band(g, ['#2349a8', '#2349a8'], -10.6, 1.55, 1.45, 24.4, { h: .5 }); return g; },
  gueter: () => { const g = V('Güterzug', 'Schienen-Wagenteil'); railbed(g, 66, -10.8);
    const lz = 11; railcar(g, 18, lz, { body: '#c43b2c', W: 3.0, H: 4.2, y0: 1.2, win: false }); for (const e of [-1, 1]) { box(g, 2.6, 1.0, .04, 0, 2.9, lz + e * 9.02, C.glass); for (const sd of [-1, 1]) box(g, .03, .8, 1.0, sd * 1.505, 3.0, lz + e * 8.2, C.glass); }
    box(g, 2.0, .35, 8, 0, 4.2, lz, '#8e9298'); band(g, ['#f2f2f2'], lz, 1.9, 1.5, 17.6, { h: .25 });
    let z = 0.3; const flat = (len) => { box(g, 2.8, .35, len, 0, 1.0, z - len / 2, '#3a3c42'); for (const e of [-1, 1]) box(g, 2.1, .6, 2.4, 0, .12, z - len / 2 + e * (len / 2 - 2), C.dark); };
    flat(14); [['#2f7d4f', 6.1], ['#b8452a', 6.1]].forEach(([c, l], i) => { const cz = z - 3.6 - i * 6.6; box(g, 2.44, 2.6, l, 0, 1.35, cz, c); stk(g, P('sicke', Math.round(l * PX) - 1, 10), cz, 2.65, 1.22); }); z -= 15;
    flat(13); cylZ(g, 1.45, 1.45, 11.6, 0, 2.85, z - 6.5, '#d9dadc', 8); stk(g, P('adr', 3, 2), z - 6.5, 1.9, 1.3, { off: .04 }); z -= 14;
    flat(13); box(g, 2.9, 2.2, 12.6, 0, 1.2, z - 6.5, '#6b4a35'); box(g, 2.6, .2, 12.2, 0, 3.2, z - 6.5, '#2d2a26'); return g; }
};


/* ---------------- Backen: Gruppe -> eine Geometrie ---------------- */
// one white texel in the sticker sheet: all non-sticker vertices sample it (the texture then changes nothing)
const WHITE = alloc('WEISS', 2, 2, c => px(c, 0, 0, 2, 2, '#ffffff'));
function bake(g, bodyHex, part) {
  g.updateMatrixWorld(true);
  const wc = cells[WHITE], wu = (wc.x + 1) / AW, wv = 1 - (wc.y + 1) / AH;
  const P = [], N = [], Co = [], U = [], K = [];
  g.traverse(m => {
    if (!m.isMesh || (part !== undefined && (m.userData.part || 0) !== part)) return;
    const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()); geo.applyMatrix4(m.matrixWorld);
    const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv, mt = m.material;
    let k = 0, col = [1, 1, 1];
    if (mt === DECAL) k = 5;
    else if (mt.isMeshBasicMaterial) { const L = LIGHTS.find(l => l.m === mt); k = L && L.on.r > L.on.b ? 3 : 2; col = L ? [L.off.r, L.off.g, L.off.b] : [.2, .3, .7]; }
    else { const hex = '#' + mt.color.getHexString(); col = [mt.color.r, mt.color.g, mt.color.b]; if (hex === C.glass) k = 4; else if (hex === C.head) k = 6; else if (hex === C.tail) k = 7; else if (bodyHex && hex === bodyHex.toLowerCase()) k = 1; }
    for (let i = 0; i < p.count; i++) {
      P.push(p.getX(i), p.getY(i), p.getZ(i)); N.push(n.getX(i), n.getY(i), n.getZ(i)); Co.push(...col); K.push(k);
      if (k === 5) U.push(uv.getX(i), uv.getY(i)); else U.push(wu, wv);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(Co, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); geo.setAttribute('aK', new THREE.Float32BufferAttribute(K, 1));
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  return geo;
}

/* one material for all variants: sticker sheet + vertex colours; per instance iCol (body colour, r < 0 = keep),
   iVar = blink phase (0..1) + 2 blue light on + 4 indicator left + 8 indicator right + 16 braking; uNight 0..1 lights the lamps (Runde 95) */
const material = new THREE.MeshLambertMaterial({ vertexColors: true, map: atlasTex, alphaTest: .5 });
const U = { uTime: { value: 0 }, uNight: { value: 0 } };
material.onBeforeCompile = sh => {
  sh.uniforms.uTime = U.uTime; sh.uniforms.uNight = U.uNight;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aK; attribute vec3 iCol; attribute float iVar; varying float vK; varying float vVar; varying float vLX; varying vec3 vWP; varying vec3 vLQ;')
    .replace('#include <color_vertex>', '#include <color_vertex>\nvK = aK; vVar = iVar; if (aK > 0.5 && aK < 1.5 && iCol.r >= 0.0) vColor = iCol;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLX = position.x; vLQ = position; vec4 hxw = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\nhxw = instanceMatrix * hxw;\n#endif\nvWP = (modelMatrix * hxw).xyz;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uNight; varying float vK; varying float vVar; varying float vLX; varying vec3 vWP; varying vec3 vLQ;')
    .replace('#include <color_fragment>', `#include <color_fragment>
      if (vK > 3.5 && vK < 4.5) { float st = fract((vLQ.x * 0.8 - vLQ.z * 0.8 + vLQ.y * 1.6) * 0.42);   // glass: glint stripes fixed on the car (Runde 109: in world space they scrolled while driving)
        if (st < 0.07 || (st > 0.13 && st < 0.16)) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.93, 0.98), 0.75); }`)
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      float hxB = floor(vVar), hxSir = mod(floor(hxB / 2.0), 2.0), hxL = mod(floor(hxB / 4.0), 2.0), hxR = mod(floor(hxB / 8.0), 2.0), hxBrk = mod(floor(hxB / 16.0), 2.0);
      if (vK > 1.5 && vK < 3.5 && hxSir > 0.5) { float on = step(0.5, fract(uTime * 2.4 + fract(vVar) + step(0.0, vLX) * 0.5)); // blue lights flash left/right in turn
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vK < 2.5 ? vec3(0.62, 0.8, 1.0) : vec3(1.0, 0.86, 0.45), on);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vK < 2.5 ? vec3(0.35, 0.55, 1.0) : vec3(1.0, 0.7, 0.3), uNight * (1.0 - on) * 0.45); } // at night the dark half still glows a little
      if (vK > 5.5 && vK < 7.5) { // headlights and tail lights: lit at night, tail lights bright when braking; indicators blink amber on their side
        bool hxHead = vK < 6.5; float lit = hxHead ? uNight : max(uNight * 0.75, hxBrk);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, hxHead ? vec3(1.0, 0.97, 0.84) : vec3(1.0, 0.1, 0.06), lit);
        if ((vLX > 0.0 ? hxL : hxR) > 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.62, 0.1), step(0.5, fract(uTime * 1.5))); }`);
};

/* ---------------- Varianten für den Verkehr ----------------
   w: Häufigkeit, cls: car (Karosseriefarbe aus den Autofarben), sport (bunte Farben), null (feste Farben)
   road: 0 überall, 1 nur Hauptstraßen und schneller, em: Blaulichtfahrzeug */
FIRMEN.forEach((f, i) => { B['h' + i] = () => vanFirma(f); });
const CAR_BODY = '#a9adb2', VAN_BODY = '#eeeeea';

/* Runde 107: Militärfahrzeuge in Flecktarn-Oliv. Gewicht 0: nie im Verkehr, nur zum Selbstfahren und für spätere Szenen. */
const OLIV = '#4b5320', OLIV2 = '#5b6b3a', TARN = ['#3a3f22', '#5c4a2e', '#6b7a3a', '#2b2c28'];
function tarn(g, W, y0, h, z0, L, n, seed) { let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (const sd of [-1, 1]) for (let i = 0; i < n; i++) box(g, .04, h * (.25 + r() * .35), L * (.08 + r() * .12), sd * (W / 2 + .02), y0 + r() * h * .6, z0 - L / 2 + r() * L, TARN[(r() * 4) | 0]); }
B.milWolf = () => { const g = gelaende('Bundeswehr-Geländewagen', { form: 'lang', body: OLIV, dachfarbe: OLIV2, rad: true, dach: true, kanister: true }); const d = g.userData.dims; tarn(g, d.W, d.y0, d.bh, 0, d.L, 6, 7); return g; };
B.milLkw = () => { const g = truck('Militär-LKW', { L: 8.4, cab: OLIV, body: OLIV2, type: 'plane', bh: 2.3, rear: [-2.0, -3.4] }); const d = g.userData.dims; tarn(g, d.W, .95, d.cabH - 1, d.L / 2 - d.cabL / 2, d.cabL, 3, 11); return g; };
B.milBoxer = () => { const g = V('Radpanzer 8x8', 'Militär'), L = 7.9, W = 2.95;
  box(g, W, 1.2, L - 1.6, 0, .75, -.5, OLIV); prism(g, W, 1.2, 1.6, 0, .75, L / 2 - 1.1, OLIV, 1.1, 0, .92);
  box(g, W * .92, 1.0, L * .62, 0, 1.95, -1.1, OLIV2); prism(g, W * .9, .4, 1.4, 0, 1.95, 1.4, OLIV2, .9, 0, .9);
  box(g, 1.0, .45, 1.1, .5, 2.95, -.4, '#3a3f22'); cylZ(g, .07, .07, 1.6, .5, 3.15, .7, '#2b2c28', 6);
  for (const z of [2.3, .9, -1.4, -2.8]) axle(g, .62, .45, W + .1, z);
  box(g, W * .7, .9, .05, 0, 1.0, -L / 2 + .3, '#3a3f22'); for (const sd of [-1, 1]) box(g, .3, .15, .05, sd * .9, 1.3, L / 2 - .3, C.head);
  tarn(g, W, .75, 2.2, -.5, L - 1, 7, 17); g.userData.side = { z: -.5, len: L - 2, y: 1.8, hw: W / 2 }; return g; };
B.milPanzer = () => { const g = V('Kampfpanzer', 'Militär'), L = 7.7, W = 3.7, tw = .62;
  for (const sd of [-1, 1]) { const x = sd * (W / 2 - tw / 2);
    box(g, tw, .95, L - .9, x, .05, 0, '#2b2c28'); cylZ(g, .45, .45, tw, x, .55, L / 2 - .5, '#2b2c28', 8, Math.PI / 2); cylZ(g, .45, .45, tw, x, .55, -L / 2 + .5, '#2b2c28', 8, Math.PI / 2);
    for (let i = 0; i < 7; i++) { const t = new THREE.CylinderGeometry(.36, .36, tw + .04, 8); t.rotateZ(Math.PI / 2); add(g, t, '#4a4d48', x, .42, -L / 2 + 1.0 + i * (L - 2) / 6); }
    box(g, tw + .06, .55, L - .4, x, .95, 0, OLIV); }
  box(g, W - 2 * tw, .9, L - 1.2, 0, .6, -.2, OLIV); prism(g, W - .1, .5, L - .6, 0, 1.4, 0, OLIV, 1.6, .2, .95);
  prism(g, 2.6, .9, 3.4, 0, 1.9, -.6, OLIV2, .8, .3, .85); box(g, 2.7, .3, 1.0, 0, 1.95, -2.6, '#3a3f22');
  cylZ(g, .14, .11, 5.2, 0, 2.3, 3.6, '#3a3f22', 8); cylZ(g, .2, .2, .7, 0, 2.3, 1.3, OLIV2, 8);
  add(g, new THREE.CylinderGeometry(.35, .35, .25, 8), '#3a3f22', .6, 2.9, -.8);
  for (const sd of [-1, 1]) box(g, .25, .12, .05, sd * 1.4, 1.3, L / 2 - .2, C.head);
  tarn(g, 2.7, 1.95, .8, -.6, 3.2, 4, 23); tarn(g, W + .1, .95, .5, 0, L - .5, 6, 29); g.userData.side = { z: 0, len: L - 1, y: 1.2, hw: W / 2 + .05 }; return g; };
const V8 = [
  ['kombi', () => car('Kombi'), 14, 'car', CAR_BODY], ['schraeg', () => car('Kompakt', { style: 'hatch', L: 4.1 }), 18, 'car', CAR_BODY],
  ['limousine', () => car('Limousine', { style: 'saloon', L: 4.8 }), 10, 'car', CAR_BODY], ['suv', () => car('SUV', { style: 'suv', L: 4.6, W: 1.9 }), 9, 'car', CAR_BODY],
  ['hochdach', () => car('Hochdachkombi', { style: 'kasten', L: 4.4 }), 3, 'car', CAR_BODY],
  ['sport', () => car('Sportcoupé', { style: 'sport', L: 4.4, W: 1.92, body: '#c8201c' }), 1.6, 'sport', '#c8201c'], ['spoiler', () => car('Sportcoupé', { style: 'sport', L: 4.4, W: 1.92, body: '#f2c200', spoiler: true }), .6, 'sport', '#f2c200'],
  ['cabrio', () => car('Cabrio', { style: 'cabrio', L: 4.2, W: 1.85, body: '#2a63c4' }), .8, 'sport', '#2a63c4'], ['super', () => car('Supersportwagen', { style: 'super', L: 4.6, W: 2.0, body: '#e8641a' }), .3, 'sport', '#e8641a'],
  ['mafia', B.mafia || (() => car('Mafia-Limousine', { style: 'limo', body: '#141518', L: 5.9, W: 1.95, tint: true, chrome: true })), .12, null],
  ['taxi', B.taxi, 2.5, null], ['transporter', () => van('Transporter'), 4, 'car', VAN_BODY], ['kleinbus', B.schulbus, .3, null, 0, 0],
  ['pritsche', B.pritsche, .6, null], ['pflege', B.pflege, .7, null], ['pizza', B.pizza, .4, null]
].map(v => ({ id: v[0], make: v[1], w: v[2], cls: v[3], body: v[4], road: 0 }));
for (const [id, w] of [['gwExpedition', .45], ['gwSafari', .35], ['gwJeep', .35], ['gwVerdeck', .3], ['gwKlassik', .45], ['gwZelt', .25], ['gwPickup', .4], ['gwFoerster', .2]]) V8.push({ id, make: B[id], w, cls: null, road: 0 }); // Geländewagen (Runde 92)
V8.push({ id: 'gwFeuerwehr', make: B.gwFeuerwehr, w: .06, cls: null, road: 0, em: true });
for (let i = 0; i < FIRMEN.length; i++) V8.push({ id: 'firma' + i, make: B['h' + i], w: .55, cls: null, road: 0 });
for (const [id, w] of [['umzug', .7], ['kuehl', .5], ['getraenke', .5], ['sattel', .8], ['haenger', .5], ['tank', .25], ['mixer', .3], ['kipper', .35], ['muell', .45], ['stadtbus', 3], ['gelenkbus', 1.2], ['reisebus', .3]]) V8.push({ id, make: B[id], w, cls: null, road: 1, bus: /bus/.test(id) && id !== 'reisebus' });
for (const [id, w, road] of [['polKombi', .7, 0], ['polSuv', .25, 0], ['polBulli', .35, 0], ['nef', .18, 0], ['rtw', .45, 0], ['ktw', .25, 0], ['fwSuv', .08, 0], ['elw', .08, 0], ['hlf', .2, 1], ['tlf', .08, 1], ['dlk', .06, 1]]) V8.push({ id, make: B[id], w, cls: null, road, em: true });
for (const id of ['milWolf', 'milLkw', 'milBoxer', 'milPanzer']) V8.push({ id, make: B[id], w: 0, cls: null, road: 1, mil: true }); // Runde 107: never in traffic (w 0)
/* Schienenwagen einzeln (Runde 89): ein Zug ist eine Reihe Wagen, jeder folgt dem Gleis - auch durch Kurven. Vorne = +z;
   der hintere Endwagen ist derselbe Wagen, um 180 Grad gedreht. w: 0 = nie im simulierten Verkehr */
const RAIL = (name, len, o, band) => () => { const g = V(name, 'Schienen-Wagenteil'); railcar(g, len, 0, o); if (band) for (const [rows, y, h] of band) stk(g, Bk(rows), 0, y, (o.W || 2.9) / 2, { len: len - (o.noseF ? o.nose : 0) - 1, stretch: true, h }); if (o.panto) { box(g, 1.0, .15, 1.0, 0, o.H || 4, 0, '#54575d'); for (const s2 of [-1, 1]) { const m = box(g, .12, 1.05, .12, 0, (o.H || 4) + .05, s2 * .25, '#2b2d31'); m.rotation.x = s2 * .55; } } return g; };
const TRAM = { W: 2.3, H: 3.4, y0: .4, nose: 1.4, lowH: 1.0, body: '#f2f2ee', winY: .95, winH: 1.25, bogie: 1.8 };
const SB = { body: '#ecece8', nose: 2.6 }, RE = { body: '#f1f1ee', nose: 2.6 }, FE = { body: '#f4f4f2', nose: 6, lowH: 1.0, H: 4.0, y0: 1.0 };
for (const [id, mk] of [
  ['tramEnd', RAIL('Straßenbahn Kopf', 11, Object.assign({ noseF: 1 }, TRAM), [[['#c8202a', '#c8202a'], .75, .5]])],
  ['tramMid', RAIL('Straßenbahn Mitte', 9, Object.assign({ panto: 1 }, TRAM), [[['#c8202a', '#c8202a'], .75, .5]])],
  ['sEnd', RAIL('S-Bahn Kopf', 16, Object.assign({ noseF: 1 }, SB), [[['#c8202a', '#c8202a', '#c8202a'], 1.55, .75]])],
  ['sMid', RAIL('S-Bahn Mitte', 16, SB, [[['#c8202a', '#c8202a', '#c8202a'], 1.55, .75]])],
  ['reEnd', RAIL('Regionalzug Kopf', 17, Object.assign({ noseF: 1 }, RE), [[['#1f8a4a', '#1f8a4a', '#f2c400'], 1.55, .75]])],
  ['reMid', RAIL('Regionalzug Mitte', 17, RE, [[['#1f8a4a', '#1f8a4a', '#f2c400'], 1.55, .75]])],
  ['uEnd', RAIL('U-Bahn/Stadtbahn Kopf', 13, Object.assign({ noseF: 1, W: 2.65, H: 3.6, y0: .9, nose: 1.6, body: '#f2c400' }), [[['#2b2d31', '#2b2d31'], 1.35, .5]])],
  ['uMid', RAIL('U-Bahn/Stadtbahn Mitte', 13, { W: 2.65, H: 3.6, y0: .9, body: '#f2c400' }, [[['#2b2d31', '#2b2d31'], 1.35, .5]])],
  ['feEnd', RAIL('Fernzug Triebkopf', 21, Object.assign({ noseF: 1, win: false }, FE), [[['#2349a8', '#2349a8'], 1.55, .5]])],
  ['feMid', RAIL('Fernzug Wagen', 25, FE, [[['#2349a8', '#2349a8'], 1.55, .5]])]]) V8.push({ id, make: mk, w: 0, cls: null, road: 1, rail: true });
let built = false;
function build() { // lazily: geometry for every variant, then the sheet goes to the GPU once
  if (built) return V8; built = true;
  for (const v of V8) { const g = v.make(); v.geo = bake(g, v.body); const bb = v.geo.boundingBox; v.len = bb.max.z - bb.min.z; v.tris = v.geo.attributes.position.count / 3; v.name = g.userData.name;
    if (g.userData.joints) { v.full = v.geo; v.geo = bake(g, v.body, 0); v.parts = g.userData.joints.map(j => Object.assign({ geo: bake(g, v.body, j.p) }, j)); } } // Runde 140: front part + trailer parts
  atlasTex.needsUpdate = true; return V8;
}
/* Runde 140: articulated vehicles (semi-trailer, drawbar trailer, articulated bus). Each trailer part hangs at a joint of its parent
   part and is pulled behind it like a real trailer: its axle point keeps its distance d to the joint and only moves towards it
   (tractrix) - in curves the trailer cuts inside, reversing folds it. Works for every caller (traffic, timetable buses, own vehicle):
   st = state per vehicle (kept by the caller), m0 = world matrix of the front part, hAt(x, z, yHint) = ground height,
   each(k, matrix) for every part. Cost: a few vector operations per part and frame; ground height only every 80 cm. */
const _am = [], _av = new THREE.Vector3(), _ae = new THREE.Euler(), _aq = new THREE.Quaternion(), _ap = new THREE.Vector3(), _as = new THREE.Vector3(1, 1, 1), _at = new THREE.Matrix4();
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
function artic(v, st, m0, hAt, each) {
  if (!v.parts) return; if (!st.aq) { st.aq = []; st.ay = []; st.as = []; } // own keys: the caller's state object may carry other fields (oepnv cache: y)
  const M = [m0], H = [Math.atan2(m0.elements[8], m0.elements[10])];
  for (let k = 0; k < v.parts.length; k++) { const pt = v.parts[k], pm = M[pt.par], hp = H[pt.par];
    _av.set(0, 0, pt.z).applyMatrix4(pm); const px = _av.x, py = _av.y, pz = _av.z; let h, pitch = 0;
    if (pt.half) { const hb = H[k]; h = hp + wrapA((hb !== undefined ? hb : hp) - hp) / 2; } // bellows: half way between the two sections
    else { let q = st.aq[k];
      if (!q || Math.hypot(q[0] - px, q[1] - pz) > pt.d * 1.6) { q = st.aq[k] = [px - Math.sin(hp) * pt.d, pz - Math.cos(hp) * pt.d]; st.as[k] = null; } // new or jumped: straight behind
      const dx = q[0] - px, dz = q[1] - pz, L = Math.hypot(dx, dz) || 1; q[0] = px + dx / L * pt.d; q[1] = pz + dz / L * pt.d;
      h = Math.atan2(px - q[0], pz - q[1]); const rel = wrapA(h - hp);
      if (Math.abs(rel) > pt.max) { h = hp + Math.sign(rel) * pt.max; q[0] = px - Math.sin(h) * pt.d; q[1] = pz - Math.cos(h) * pt.d; } // folded as far as it goes
      const sp = st.as[k]; if (!sp || Math.abs(sp[0] - q[0]) + Math.abs(sp[1] - q[1]) > .8) { st.as[k] = [q[0], q[1]]; st.ay[k] = hAt ? hAt(q[0], q[1], py + 1) : py; }
      pitch = -Math.atan2(py - st.ay[k], pt.d); if (!(Math.abs(pitch) < .5)) pitch = 0; }
    H[k + 1] = h; // parts are numbered 1.. in the joints list; H[0] is the front
    const m = _am[k] || (_am[k] = new THREE.Matrix4());
    _ae.set(pitch, h, 0, 'YXZ'); _aq.setFromEuler(_ae); _ap.set(px, py, pz); m.compose(_ap, _aq, _as); m.multiply(_at.makeTranslation(0, 0, -pt.z));
    M[k + 1] = m; each(k, m); }
}
window.HXFZ = { build, material, artic, tick(t, night) { U.uTime.value = t; if (night !== undefined) U.uNight.value = night; }, atlas, index: id => V8.findIndex(v => v.id === id) };
})();
