/* HoodExplorer data worker
 * Loads and turns live data into ready-to-draw geometry, off the main thread:
 *  - OpenFreeMap vector tiles (z14): ground, roads, water, parks, trees, building footprints (collision, fallback buildings)
 *  - basemap.de LoD2 (Germany): real 3D buildings with real roof shapes
 *  - Overpass API (lazy, low priority): building:colour / roof:colour to recolour LoD2 buildings
 * Everything fetched is cached in IndexedDB, so a second start is almost instant.
 */
'use strict';
try { importScripts('lib/earcut.min.js?v=2.2.4'); } catch (e) { importScripts('https://cdn.jsdelivr.net/npm/earcut@2.2.4/dist/earcut.min.js'); } // Runde 121: local copy first, CDN as fallback
importScripts('ausfall.js?v=663'); importScripts('sonderbau.js?v=663'); // Runde 206: Sonderbau-Baukasten // Runde 120: ?ausfall=... test switch (does nothing without it)

const R = 6378137, WORLD = 2 * Math.PI * R, HALF = WORLD / 2;
let TILEJSON = 'https://tiles.openfreemap.org/planet';
/* Source registry (daten/quellen.json): world-wide base sources plus optional regional upgrades with automatic fallback */
let QUELLEN = null, MATSTAT = null;
async function quellen() {
  if (QUELLEN) return QUELLEN;
  try { QUELLEN = await (await fetch('daten/quellen.json')).json(); } catch (e) { QUELLEN = { basis: {}, regionen: [] }; }
  if (QUELLEN.basis && QUELLEN.basis.karte && QUELLEN.basis.karte.url) TILEJSON = QUELLEN.basis.karte.url;
  const mq = QUELLEN.basis && QUELLEN.basis.material;
  if (mq) try { MATSTAT = await (await fetch(mq.pfad)).json(); } catch (e) { MATSTAT = null; }
  return QUELLEN;
}
function quelle(kind, lat, lon) { // first region that has this kind of data for the place, else null (= use the fallback)
  for (const r of (QUELLEN && QUELLEN.regionen) || []) { const b = r.bbox; if (r[kind] && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) return r[kind]; }
  return null;
}
function quellenAlle(kind, lat, lon) { // all regions with this kind of data for the place, in registry order
  return ((QUELLEN && QUELLEN.regionen) || []).filter(r => { const b = r.bbox; return r[kind] && lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]; }).map(r => r[kind]);
}
/* Runde 161: tile packs. The precomputed tiles (osm, strassen, baeume, zensus) lie in regional packs <dir>pak/<rx>_<ry>.pak
   (16 × 16 tiles, werkzeuge/pakete.py) instead of ~280 000 single files: 'HXPK', n, n × [x%16, y%16, flags, 0, offset, length],
   then the data (deflate-raw when flags & 1; equal tiles stored once). The index comes with one range request (8 KB), then
   exactly the bytes of one tile. A server without range requests sends the whole pack (a few hundred KB) - kept for the region.
   No pack (404): the old single file is fetched as before. Result like fetch: { ok, status, buf } */
const PAKS = new Map();
function pakOpen(dir, rk) {
  const key = dir + rk;
  if (!PAKS.has(key)) PAKS.set(key, (async () => {
    const url = dir + 'pak/' + rk + '.pak?v=1';
    let r = await fetch(url, { headers: { Range: 'bytes=0-8191' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    let buf = await r.arrayBuffer(), full = r.status === 200 ? buf : null, dv = new DataView(buf);
    if (buf.byteLength < 8 || dv.getUint32(0, true) !== 0x4b505848) return null; // 'HXPK'
    const n = dv.getUint32(4, true), need = 8 + n * 12;
    if (!full && buf.byteLength < need) { r = await fetch(url, { headers: { Range: 'bytes=0-' + (need - 1) } }); buf = await r.arrayBuffer(); if (r.status === 200) full = buf; dv = new DataView(buf); }
    const idx = new Map();
    for (let i = 0; i < n; i++) { const o = 8 + i * 12; idx.set(dv.getUint8(o) + '_' + dv.getUint8(o + 1), [dv.getUint32(o + 4, true), dv.getUint32(o + 8, true), dv.getUint8(o + 2)]); }
    return { url, idx, full };
  })().catch(e => { PAKS.delete(key); throw e; }));
  return PAKS.get(key);
}
async function inflate(u8) { return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer(); }
async function tileGet(dir, k, single) { // single: URL of the old single file (fallback)
  const [a, b] = k.split('_').map(Number), rk = Math.floor(a / 16) + '_' + Math.floor(b / 16), lk = (a - Math.floor(a / 16) * 16) + '_' + (b - Math.floor(b / 16) * 16);
  const P = await pakOpen(dir, rk);
  if (!P) { const r = await fetch(single); return { ok: r.ok, status: r.status, buf: r.ok ? await r.arrayBuffer() : null }; }
  const e = P.idx.get(lk); if (!e) return { ok: false, status: 404, buf: null };
  const [off, len, fl] = e; if (!len) return { ok: true, status: 200, buf: new ArrayBuffer(0) };
  let u8;
  if (P.full) u8 = new Uint8Array(P.full, off, len);
  else { const r = await fetch(P.url, { headers: { Range: 'bytes=' + off + '-' + (off + len - 1) } }); if (!r.ok) throw new Error('HTTP ' + r.status);
    const ab = await r.arrayBuffer(); if (r.status === 200) { P.full = ab; u8 = new Uint8Array(ab, off, len); } else u8 = new Uint8Array(ab); }
  return { ok: true, status: 200, buf: fl & 1 ? await inflate(u8) : u8.slice().buffer };
}
const quelleLocal = (kind, x, z) => { const ll = toLatLon(x, z); return quelle(kind, ll[0], ll[1]); };
const quelleMerc = (kind, X, Y) => quelle(kind, Math.atan(Math.sinh(Y / 6378137)) * 180 / Math.PI, X / 6378137 * 180 / Math.PI);
let L2BASE = 'https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gebaeude/';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const Z = 14;
let MVT_RADIUS = 750, MVT_DROP = 2600; // drop distance must exceed radius + half a tile diagonal (~1.1 km), otherwise edge tiles load in a loop   // real metres
let L2_RADIUS = 450, L2_DROP = 1000;

let O = null;                 // origin {X0, Y0, c}
const lx = X => (X - O.X0) * O.c, lz = Y => -(Y - O.Y0) * O.c;
const merc = (lat, lon) => ({ X: lon * Math.PI / 180 * R, Y: Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R });

/* ------------------------------------------------------------ cache */
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise(res => {
    try {
      const r = indexedDB.open('hoodexplorer', 2);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('files')) d.createObjectStore('files'); };
      r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
    } catch (e) { res(null); }
    setTimeout(() => res(null), 4000); // Runde 77: a cache that never answers must not stop the loading
  });
  return dbP;
}
async function cget(k, ttl) {
  const d = await db(); if (!d) return null;
  return new Promise(res => {
    setTimeout(() => res(null), 3000); // Runde 77: phone with a full or stuck storage - fetch it from the net instead of waiting for ever
    try {
      const q = d.transaction('files').objectStore('files').get(k);
      q.onsuccess = () => { const v = q.result; res(v && Date.now() - v.t < (ttl || 14 * 864e5) ? v.d : null); };
      q.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
async function cput(k, v) { const d = await db(); if (!d) return; try { d.transaction('files', 'readwrite').objectStore('files').put({ t: Date.now(), d: v }, k); } catch (e) { } }
/* Runde 60 (phone: no streets after walking on, "Lade Daten" for ever): a request that never answers held one of the 3 load slots for
   good - every fetch of the worker gives up after 45 s */
{ const _f = self.fetch.bind(self); self.fetch = (url, opt = {}) => { if (opt.signal || typeof AbortController === 'undefined') return _f(url, opt); const ac = new AbortController(), t = setTimeout(() => ac.abort(), 45000);
    return _f(url, Object.assign({}, opt, { signal: ac.signal })).then(r => { clearTimeout(t); return r; }, e => { clearTimeout(t); throw e; }); }; }
const mvtFail = new Map(); // tile key -> { n, until }: failed map tiles are tried again after 5, 10, 20 ... s (at most 6 times)
/* Runde 120 (simulated hanging map server): every data request gets 20 s for its answer (headers), then it fails and is retried later -
   before, a hanging server held its queue slot until the 60 s watchdog */
async function fetchOk(url, opt) { let t = 0; if (!opt || !opt.signal) { const c = new AbortController(); t = setTimeout(() => c.abort(), 20000); opt = Object.assign({}, opt, { signal: c.signal }); }
  try { const r = await fetch(url, opt); if (!r.ok) throw new Error('HTTP ' + r.status); return r; } finally { clearTimeout(t); } }

/* ------------------------------------------------------------ helpers */
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
const NAMED = { white: '#efece4', black: '#2c2c2c', grey: '#8c8a85', gray: '#8c8a85', darkgrey: '#56565a', darkgray: '#56565a', lightgrey: '#c9c7c1', lightgray: '#c9c7c1', silver: '#b9b8b4',
  red: '#a8483c', darkred: '#7a2e26', maroon: '#6c2c26', brown: '#7a5a44', darkbrown: '#5a3e2e', yellow: '#dfc878', beige: '#d9c9a8', cream: '#ece2c6', ivory: '#eee8d6', orange: '#cf8a4c',
  green: '#6f8a5a', darkgreen: '#3f5a3a', blue: '#5a7a9a', darkblue: '#334a6a', lightblue: '#9ab8cc', pink: '#d8a8a0', tan: '#c8b08a', sandstone: '#c9b48a', brick: '#9a4e3c', terracotta: '#b0603f', anthracite: '#3e4046', purple: '#7a5a7a' };
function parseCol(s) {
  if (!s) return null; s = String(s).trim().toLowerCase().replace(/[\s_-]/g, '');
  if (NAMED[s]) return hex(NAMED[s]);
  if (/^#[0-9a-f]{6}$/.test(s)) return hex(s);
  if (/^[0-9a-f]{6}$/.test(s)) return hex('#' + s);
  if (/^#[0-9a-f]{3}$/.test(s)) return hex('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]);
  return null;
}
const MATERIAL = { brick: '#9a4e3c', clinker: '#8e4636', stone: '#b9ad94', sandstone: '#c9b48a', wood: '#8a6a4a', timber_framing: '#e6dcc6', glass: '#7f9fb4', concrete: '#a9a79f', metal: '#8c9096', plaster: '#e6dfcf', steel: '#8c9096' };
const WALLS = ['#e9e4d8', '#ddd5c4', '#e6d9bf', '#d2cbbd', '#c8c1b2', '#efe9dc', '#e0d4bc', '#d8d2c6', '#a5523f', '#9a4e3c'].map(hex);
const ROOFS = ['#8c3b2e', '#9c4636', '#7a3a2e', '#5b3a32', '#3e4046', '#4a4c52', '#6a3a30', '#544a44'].map(hex);
const FLATROOF = hex('#7a7872');

function inPoly(x, z, p) { // p: Float32Array [x,z,...]
  let ins = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins;
  }
  return ins;
}
/* Runde 118 (phone test, Bielefeld Alter Markt: the lower part of a house wall flickered in jagged dark patches): the map data
   often has a house AND its parts as separate footprints (a 3 m shop part, a 13 m tower part inside a 10 m house). Their walls lie
   in the same plane and fight in the depth buffer. Rule for a footprint lying inside another one (every corner inside or within
   0.3 m of its outline): not higher than the outer one -> it is hidden anyway and left out; higher (or starting above it) -> it
   stays, moved 0.15 m inwards, so its walls stand behind the outer walls and only show above them. Same rule for the OSM
   building parts among each other (there it was a dark 1.8 m base part inside a 7.5 m part, with the very same corners). */
function insetRing(r0, d) { // r: [x,z,...] ring; moves every wall d metres inwards (mitre limited); a repeated end point is kept
  const L = r0.length, cl = L > 4 && r0[0] === r0[L - 2] && r0[1] === r0[L - 1], r = cl ? r0.slice(0, L - 2) : r0;
  const n = r.length / 2, sg = ringArea(r) > 0 ? 1 : -1, o = new Array(r.length);
  for (let i = 0; i < n; i++) { const a = (i + n - 1) % n, c = (i + 1) % n;
    let ux = r[i * 2] - r[a * 2], uz = r[i * 2 + 1] - r[a * 2 + 1], vx = r[c * 2] - r[i * 2], vz = r[c * 2 + 1] - r[i * 2 + 1]; const lu = Math.hypot(ux, uz) || 1, lv = Math.hypot(vx, vz) || 1; ux /= lu; uz /= lu; vx /= lv; vz /= lv;
    let nx = -(uz + vz) * sg, nz = (ux + vx) * sg; const nl = Math.hypot(nx, nz); if (nl < 1e-6) { nx = -uz * sg; nz = ux * sg; } else { nx /= nl; nz /= nl; }
    const cs = Math.max(.35, nx * -uz * sg + nz * ux * sg); o[i * 2] = r[i * 2] + nx * d / cs; o[i * 2 + 1] = r[i * 2 + 1] + nz * d / cs; }
  if (cl) o.push(o[0], o[1]); return o;
}
function nestedParts(items, part) { // part: OSM building parts { ring, h, mh } instead of map footprints { p, poly, h, minH }
  if (part) for (const it of items) if (it.p === undefined) { it.p = it.ring; it.minH = it.mh; Object.assign(it, bbox(it.ring)); }
  const drop = new Set(), byA = items.map(it => [it, Math.abs(ringArea(it.p))]).sort((a, b) => b[1] - a[1]);
  for (let i = 1; i < byA.length; i++) { const [a, aa] = byA[i]; if (aa < 1) continue;
    for (let j = 0; j < i; j++) { const [b] = byA[j]; if (drop.has(b) || a.minx < b.minx - .3 || a.maxx > b.maxx + .3 || a.minz < b.minz - .3 || a.maxz > b.maxz + .3) continue;
      let inside = true; for (let k = 0; k < a.p.length && inside; k += 2) inside = inPoly(a.p[k], a.p[k + 1], b.p) || nearRing(a.p[k], a.p[k + 1], b.p, .3);
      if (!inside) continue;
      if (a.h <= b.h + .3 && a.minH >= b.minH - .3) drop.add(a);
      else if (!a.inset) { a.inset = true; const r = insetRing(Array.from(part ? a.ring : a.poly[0]), .15);
        if (part) a.ring = a.p = r; else { a.poly = [r, ...a.poly.slice(1)]; a.p = Float32Array.from(r); } Object.assign(a, bbox(a.p)); }
      break; } }
  if (part) { for (const it of drop) it.hid = true; return; }
  if (!drop.size) return;
  gRemove(fpgrid, it => drop.has(it)); for (let i = items.length - 1; i >= 0; i--) if (drop.has(items[i])) items.splice(i, 1);
}
function ringArea(p) { let s = 0; for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) s += p[j] * p[i + 1] - p[i] * p[j + 1]; return s / 2; }

/* ------------------------------------------------------------ coordinates, census building age */
function toLatLon(x, z) { const X = x / O.c + O.X0, Y = -z / O.c + O.Y0; return [Math.atan(Math.sinh(Y / R)) * 180 / Math.PI, X / R * 180 / Math.PI]; }
const LAEA = (() => { // EPSG:3035 (ETRS89-LAEA), the grid of the German census
  const a = 6378137, e2 = 0.0066943800229, e = Math.sqrt(e2);
  const q = p => { const s = Math.sin(p); return (1 - e2) * (s / (1 - e2 * s * s) - 1 / (2 * e) * Math.log((1 - e * s) / (1 + e * s))); };
  const p0 = 52 * Math.PI / 180, l0 = 10 * Math.PI / 180, qp = q(Math.PI / 2), b1 = Math.asin(q(p0) / qp), Rq = a * Math.sqrt(qp / 2);
  const D = a * (Math.cos(p0) / Math.sqrt(1 - e2 * Math.sin(p0) ** 2)) / (Rq * Math.cos(b1));
  return (lat, lon) => { const p = lat * Math.PI / 180, l = lon * Math.PI / 180, b = Math.asin(Math.max(-1, Math.min(1, q(p) / qp)));
    const B = Rq * Math.sqrt(2 / (1 + Math.sin(b1) * Math.sin(b) + Math.cos(b1) * Math.cos(b) * Math.cos(l - l0)));
    return [4321000 + B * D * Math.cos(b) * Math.sin(l - l0), 3210000 + (B / D) * (Math.cos(b1) * Math.sin(b) - Math.sin(b1) * Math.cos(b) * Math.cos(l - l0))]; };
})();
const zTiles = new Map(), zReady = new Map();
function zensusTile(k) {
  if (!zTiles.has(k)) zTiles.set(k, (async () => {
    try {
      let buf = await cget('z:' + k, 365 * 864e5);
      if (!buf) { const r = await tileGet(ZPFAD, k, ZPFAD + k + '.bin'); buf = r.ok ? r.buf : new ArrayBuffer(0); if (r.ok || r.status === 404) cput('z:' + k, buf); }
      const b = new Uint8Array(buf), m = new Map();
      for (let i = 0; i + 6 < b.length; i += 7) m.set(b[i] * 100 + b[i + 1], b.subarray(i + 2, i + 7));
      zReady.set(k, m); return m;
    } catch (e) { zReady.set(k, new Map()); return null; }
  })());
  return zTiles.get(k);
}
let ZPFAD = 'daten/zensus/';
async function ensureZensus(x0, z0, x1, z1) {
  const q = quelleLocal('baujahr', (x0 + x1) / 2, (z0 + z1) / 2); if (!q) return; ZPFAD = q.pfad || ZPFAD;
  const keys = new Set();
  for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) {
    const ll = toLatLon(x0 + (x1 - x0) * i / 2, z0 + (z1 - z0) * j / 2), en = LAEA(ll[0], ll[1]);
    keys.add(Math.floor(en[0] / 10000) + '_' + Math.floor(en[1] / 10000));
  }
  await Promise.all([...keys].map(zensusTile));
}
// building age class from the census cell, picked by weight (1 <1919, 2 1919-48, 3 1949-78, 4 1979-2000, 5 2001+), 0 = unknown
function eraAt(x, z, seed) {
  const ll = toLatLon(x, z), en = LAEA(ll[0], ll[1]), tx = Math.floor(en[0] / 10000), ty = Math.floor(en[1] / 10000);
  const m = zReady.get(tx + '_' + ty); if (!m) return 0;
  const c = m.get(Math.floor((en[0] - tx * 10000) / 100) * 100 + Math.floor((en[1] - ty * 10000) / 100)); if (!c) return 0;
  let tot = 0; for (let i = 0; i < 5; i++) tot += c[i]; if (!tot) return 0;
  let r = seed * tot; for (let i = 0; i < 5; i++) { r -= c[i]; if (r < 0) return i + 1; } return 5;
}
/* ------------------------------------------------------------ terrain (switchable, registry 'gelaende', default: Terrarium tiles on AWS, world-wide)
   Heights are relative to the start point. Without a source or with the switch off everything stays flat (fallback). */
const SUN_L = (() => { const v = [-0.55, 0.7, -0.45], l = Math.hypot(...v); return v.map(a => a / l); })(); // light from the upper left of the map, like the sprites
let TERRAIN_ON = false, WELD = false, H0 = null; /* WELD: test variant 'shared corners' for the ground (&ecken=geteilt) */ const TZ = 13, tFiles = new Map(), tReady = new Map();
function terrTile(tx, ty, z) {
  z = z || TZ; const k = (z === TZ ? '' : z + ':') + tx + '_' + ty;
  if (!tFiles.has(k)) tFiles.set(k, (async () => {
    const q = QUELLEN && QUELLEN.basis && QUELLEN.basis.gelaende; if (!q || typeof OffscreenCanvas === 'undefined') return null;
    const url = q.url.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
    let buf = await cget(url);
    if (!buf) { buf = await (await fetchOk(url)).arrayBuffer(); cput(url, buf); }
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' })), cv = new OffscreenCanvas(256, 256), g = cv.getContext('2d');
    g.drawImage(bmp, 0, 0); const px = g.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768; // Terrarium encoding
    tReady.set(k, h);
    post({ type: 'terrain', tx, ty, z, h: h.slice() });
    return h;
  })().catch(e => { tFiles.delete(k); post({ type: 'warn', msg: 'Gelaende ' + k + ': ' + e.message }); return null; }));
  return tFiles.get(k);
}
const tPix = (x, z) => { const X = x / O.c + O.X0, Y = -z / O.c + O.Y0, n = (1 << TZ) * 256; return [(X + HALF) / WORLD * n, (HALF - Y) / WORLD * n]; };
async function ensureTerrain(x0, z0, x1, z1) {
  if (!TERRAIN_ON) return;
  const a = tPix(x0, z0), b = tPix(x1, z1), jobs = [];
  for (let ty = Math.floor(Math.min(a[1], b[1]) / 256); ty <= Math.floor(Math.max(a[1], b[1]) / 256); ty++)
    for (let tx = Math.floor(Math.min(a[0], b[0]) / 256); tx <= Math.floor(Math.max(a[0], b[0]) / 256); tx++) jobs.push(terrTile(tx, ty));
  await Promise.all(jobs);
  if (H0 === null) { const o = tPix(0, 0); await terrTile(Math.floor(o[0] / 256), Math.floor(o[1] / 256)); H0 = rawH(0, 0); if (H0 === null) H0 = 0; post({ type: 'terrainH0', h0: H0 }); }
}
// far view: coarse tiles (zoom 11, ~75 m per pixel, ~20 km per tile) around the player, only sent to the app for the distant hills
let farAt = null;
function ensureFar() {
  if (!TERRAIN_ON || !pos) return;
  if (farAt && Math.hypot(pos.X - farAt.X, pos.Y - farAt.Y) < 1500) return; farAt = { X: pos.X, Y: pos.Y };
  const n = (1 << 11) * 256, R0 = 4500 / O.c, px = X => (X + HALF) / WORLD * n, py = Y => (HALF - Y) / WORLD * n;
  for (let ty = Math.floor(py(pos.Y + R0) / 256); ty <= Math.floor(py(pos.Y - R0) / 256); ty++)
    for (let tx = Math.floor(px(pos.X - R0) / 256); tx <= Math.floor(px(pos.X + R0) / 256); tx++) terrTile(tx, ty, 11);
}
function rawPx(px, py) { const t = tReady.get(Math.floor(px / 256) + '_' + Math.floor(py / 256)); if (!t) return null; return t[(Math.floor(py) & 255) * 256 + (Math.floor(px) & 255)]; }
function rawH(x, z) { // bilinear between pixel centres
  const [px, py] = tPix(x, z), fx = px - 0.5, fy = py - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), u = fx - ix, v = fy - iy;
  const a = rawPx(ix, iy), b = rawPx(ix + 1, iy), c = rawPx(ix, iy + 1), d = rawPx(ix + 1, iy + 1);
  if (a === null || b === null || c === null || d === null) return a !== null ? a : null;
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function hAt(x, z) { if (!TERRAIN_ON || H0 === null) return 0; const h = rawH(x, z); return h === null ? 0 : h - H0; }
/* ------------------------------------------------------------ own OSM tiles (built offline from the Geofabrik extract, see werkzeuge/osm_kacheln.py) */
const LAEA_INV = (() => { // EPSG:3035 -> lat/lon (Snyder)
  const a = 6378137, e2 = 0.0066943800229, e = Math.sqrt(e2), e4 = e2 * e2, e6 = e4 * e2;
  const q = p => { const s = Math.sin(p); return (1 - e2) * (s / (1 - e2 * s * s) - 1 / (2 * e) * Math.log((1 - e * s) / (1 + e * s))); };
  const p0 = 52 * Math.PI / 180, l0 = 10 * Math.PI / 180, qp = q(Math.PI / 2), b1 = Math.asin(q(p0) / qp), Rq = a * Math.sqrt(qp / 2);
  const D = a * (Math.cos(p0) / Math.sqrt(1 - e2 * Math.sin(p0) ** 2)) / (Rq * Math.cos(b1));
  return (E, N) => {
    const x = E - 4321000, y = N - 3210000, rho = Math.hypot(x / D, D * y); if (rho < 1e-9) return [52, 10];
    const ce = 2 * Math.asin(rho / (2 * Rq));
    const b = Math.asin(Math.cos(ce) * Math.sin(b1) + D * y * Math.sin(ce) * Math.cos(b1) / rho);
    const lat = b + (e2 / 3 + 31 * e4 / 180 + 517 * e6 / 5040) * Math.sin(2 * b) + (23 * e4 / 360 + 251 * e6 / 3780) * Math.sin(4 * b) + (761 * e6 / 45360) * Math.sin(6 * b);
    const lon = l0 + Math.atan2(x * Math.sin(ce), D * rho * Math.cos(b1) * Math.cos(ce) - D * D * y * Math.sin(b1) * Math.sin(ce));
    return [lat * 180 / Math.PI, lon * 180 / Math.PI];
  };
})();
// Street View checks (Dresden suburbs): mappers tag light rendered walls as "grey"/#bbb; in reality they read as near-white.
// Pale, unsaturated tagged wall colours are lifted toward white; dark (anthracite) and coloured walls stay as tagged.
function liftWall(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, s = mx - mn;
  if (s < 0.1 && l > 0.55 && l < 0.9) { const k = (0.6 + l * 0.4) / l; return [Math.min(1, r * k), Math.min(1, g * k), Math.min(1, b * k)]; }
  return [r, g, b];
}
const OSMT = 2000, osmFiles = new Map(), osmReady = new Map();
function osmTile(k) {
  if (!osmFiles.has(k)) osmFiles.set(k, (async () => {
    let buf = null;
    try {
      buf = await cget('o6:' + k, 30 * 864e5);
      if (!buf) { const r = await tileGet(OPFAD, k, OPFAD + k + '.bin?v=3'); /* ?v: new tile version (castle grounds), never the old file from the browser cache */ buf = r.ok ? r.buf : new ArrayBuffer(0); if (r.ok || r.status === 404) cput('o5:' + k, buf); }
    } catch (e) { buf = new ArrayBuffer(0); }
    const out = { blds: [], pts: [], parts: [], areas: [] };
    if (buf.byteLength >= 8) {
      const dv = new DataView(buf), [tx, ty] = k.split('_').map(Number);
      // map tile metres to local coordinates through the tile corners (a 2 km tile is flat enough for a linear map)
      const P = (E, N) => { const ll = LAEA_INV(E, N), m = merc(ll[0], ll[1]); return [lx(m.X), lz(m.Y)]; };
      const o = P(tx * OSMT, ty * OSMT), ex = P(tx * OSMT + OSMT, ty * OSMT), ny = P(tx * OSMT, ty * OSMT + OSMT);
      const ax = (ex[0] - o[0]) / OSMT, az = (ex[1] - o[1]) / OSMT, bx = (ny[0] - o[0]) / OSMT, bz = (ny[1] - o[1]) / OSMT;
      const loc = (dx, dy) => [o[0] + ax * dx + bx * dy, o[1] + az * dx + bz * dy];
      let p = 4; const nb = dv.getUint32(p, true); p += 4;
      for (let i = 0; i < nb; i++, p += 16) {
        const [x, z] = loc(dv.getUint16(p, true), dv.getUint16(p + 2, true)), fl = dv.getUint8(p + 10);
        out.blds.push({ x, z, wall: fl & 1 ? liftWall(dv.getUint8(p + 4) / 255, dv.getUint8(p + 5) / 255, dv.getUint8(p + 6) / 255) : null,
          roof: fl & 2 ? [dv.getUint8(p + 7) / 255, dv.getUint8(p + 8) / 255, dv.getUint8(p + 9) / 255] : null,
          mat: dv.getUint8(p + 11), shape: dv.getUint8(p + 12), levels: dv.getUint8(p + 13), year: fl & 4 ? dv.getUint16(p + 14, true) : 0, util: !!(fl & 8), btype: (fl >> 4) & 7, landmark: !!(fl & 128) });
      }
      const np = dv.getUint32(p, true); p += 4;
      for (let i = 0; i < np; i++, p += 6) { const [x, z] = loc(dv.getUint16(p + 1, true), dv.getUint16(p + 3, true)); out.pts.push({ t: dv.getUint8(p), x, z, v: dv.getUint8(p + 5) }); }
      // version 2: building parts (Simple 3D Buildings) - towers, spires, domes as mapped in OSM
      if (dv.getUint8(3) >= 2 && p + 4 <= buf.byteLength) {
        const ns = dv.getUint32(p, true); p += 4;
        for (let i = 0; i < ns && p + 17 <= buf.byteLength; i++) {
          const nv = dv.getUint16(p, true), h = dv.getUint16(p + 2, true) / 10, mh = dv.getUint16(p + 4, true) / 10, rh = dv.getUint16(p + 6, true) / 10;
          const shape = dv.getUint8(p + 8), mat = dv.getUint8(p + 9), pf = dv.getUint8(p + 10);
          const wall = pf & 1 ? [dv.getUint8(p + 11) / 255, dv.getUint8(p + 12) / 255, dv.getUint8(p + 13) / 255] : null, roof = pf & 2 ? [dv.getUint8(p + 14) / 255, dv.getUint8(p + 15) / 255, dv.getUint8(p + 16) / 255] : null;
          p += 17; const ring = new Float32Array(nv * 2); let cx = 0, cz = 0;
          for (let k = 0; k < nv; k++, p += 4) { const [x, z] = loc(dv.getInt16(p, true) / 10, dv.getInt16(p + 2, true) / 10); ring[k * 2] = x; ring[k * 2 + 1] = z; cx += x; cz += z; }
          out.parts.push(Object.assign({ ring, h, mh, rh, shape, mat, wall, roof, x: cx / nv, z: cz / nv }, bbox(ring)));
        }
      }
      // version 3: areas (1 = castle / fortress grounds)
      if (dv.getUint8(3) >= 3 && p + 4 <= buf.byteLength) {
        const na = dv.getUint32(p, true); p += 4;
        for (let i = 0; i < na && p + 3 <= buf.byteLength; i++) {
          const kind = dv.getUint8(p), nv = dv.getUint16(p + 1, true); p += 3; const ring = new Float32Array(nv * 2);
          for (let k = 0; k < nv; k++, p += 4) { const [x, z] = loc(dv.getInt16(p, true), dv.getInt16(p + 2, true)); ring[k * 2] = x; ring[k * 2 + 1] = z; }
          out.areas.push(Object.assign({ kind, ring }, bbox(ring)));
        }
      }
    }
    osmReady.set(k, out); return out;
  })());
  return osmFiles.get(k);
}
let OPFAD = 'daten/osm/';
/* Runde 44: street cross-sections from OSM (werkzeuge/strassen_kacheln.py): width, lanes, sidewalks, parking per way piece.
   The map tiles have no widths - every street got its class standard (too wide on mountain roads, kerb trees in the lane). */
const strFiles = new Map(); let SPFAD = 'daten/strassen/', STR_ON = true;
function strTile(k) {
  if (!strFiles.has(k)) strFiles.set(k, (async () => {
    let buf = null;
    try { buf = await cget('s3:' + k, 30 * 864e5); if (!buf) { const r = await tileGet(SPFAD, k, SPFAD + k + '.bin?v=3'); buf = r.ok ? r.buf : new ArrayBuffer(0); if (r.ok || r.status === 404) cput('s3:' + k, buf); } } catch (e) { buf = new ArrayBuffer(0); }
    const out = []; if (buf.byteLength < 8) return out;
    const dv = new DataView(buf), [tx, ty] = k.split('_').map(Number);
    const P = (E, N) => { const ll = LAEA_INV(E, N), m = merc(ll[0], ll[1]); return [lx(m.X), lz(m.Y)]; };
    const o = P(tx * OSMT, ty * OSMT), ex = P(tx * OSMT + OSMT, ty * OSMT), ny = P(tx * OSMT, ty * OSMT + OSMT);
    const ax = (ex[0] - o[0]) / OSMT, az = (ex[1] - o[1]) / OSMT, bx = (ny[0] - o[0]) / OSMT, bz = (ny[1] - o[1]) / OSMT;
    let p = 4; const n = dv.getUint32(p, true); p += 4;
    for (let i = 0; i < n && p + 9 <= buf.byteLength; i++) {
      const c = dv.getUint8(p), ln = dv.getUint8(p + 1), wd = dv.getUint16(p + 2, true) / 10, sw = dv.getUint8(p + 4), pk = dv.getUint8(p + 5), ow = dv.getUint8(p + 6), np = dv.getUint16(p + 7, true); p += 9;
      const pts = new Float32Array(np * 2);
      for (let j = 0; j < np; j++, p += 4) { const E = dv.getInt16(p, true), N = dv.getInt16(p + 2, true); pts[j * 2] = o[0] + ax * E + bx * N; pts[j * 2 + 1] = o[1] + az * E + bz * N; }
      out.push({ c, ln, wd, sw, pk, ow, pts, ex: ax, ez: az, nx: bx, nz: bz });
    }
    return out;
  })());
  return strFiles.get(k);
}
async function strFor(x0, z0, x1, z1) {
  if (!STR_ON) return [];
  const q = QUELLEN && QUELLEN.basis && QUELLEN.basis.strassen; if (!q) return []; SPFAD = q.pfad || SPFAD;
  const keys = new Set(); for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3; j++) { const ll = toLatLon(x0 + (x1 - x0) * i / 3, z0 + (z1 - z0) * j / 3), en = LAEA(ll[0], ll[1]); keys.add(Math.floor(en[0] / OSMT) + '_' + Math.floor(en[1] / OSMT)); }
  const res = await Promise.all([...keys].map(strTile)), out = [], seen = new Set();
  for (const r of res) for (const s of r) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let i = 0; i < s.pts.length; i += 2) { a = Math.min(a, s.pts[i]); b = Math.max(b, s.pts[i]); c = Math.min(c, s.pts[i + 1]); d = Math.max(d, s.pts[i + 1]); }
    if (b < x0 - 30 || a > x1 + 30 || d < z0 - 30 || c > z1 + 30) continue; const key = s.pts[0].toFixed(1) + ',' + s.pts[1].toFixed(1) + ',' + s.pts.length; if (seen.has(key)) continue; seen.add(key); out.push(s); }
  return out;
}
/* cross-section of one street line from the OSM pieces along it: carriageway width, sidewalk per side (+1 = side of the ribbon normal
   (-dz, dx), -1 = the other), parking. Samples every 4 m; a piece counts when it lies within 8 m and runs the same way (|cos| > .85). */
const LANEW = [0, 3.5, 3.5, 3.25, 3.25, 3.1, 3, 3, 3, 3, 3];
function crossSection(line, idx, w0) {
  const ests = [], sws = [], n0 = { s: 0, m: 0 }; let swP = 0, swM = 0, swNo = 0, swSep = 0;
  sampleLineDir(line, 4, (x, z, dx, dz) => { n0.s++;
    const l = idx.get(Math.floor(x / 16) * 100003 + Math.floor(z / 16)); if (!l) return; let best = null, bd = 8;
    for (const [s, i] of l) { const P = s.pts, ex = P[i + 2] - P[i], ez = P[i + 3] - P[i + 1], L2 = ex * ex + ez * ez; if (L2 < .01) continue; const L = Math.sqrt(L2);
      if (Math.abs((ex * dx + ez * dz) / L) < .85) continue; const q = Math.max(0, Math.min(1, ((x - P[i]) * ex + (z - P[i + 1]) * ez) / L2)), d = Math.hypot(x - P[i] - ex * q, z - P[i + 1] - ez * q);
      if (d < bd) { bd = d; best = [s, ex / L, ez / L]; } }
    if (!best) return; n0.m++; const [s, ux, uz] = best;
    let e = null; if (s.wd) e = s.wd; else if (s.ln) e = s.ln * (LANEW[s.c] || 3) + 0.5 /* gutters, edge marking */ + ((s.pk & 1) ? 2 : 0) + ((s.pk & 2) ? 2 : 0) + ((s.pk & 8) ? 1.5 : 0) + ((s.pk & 16) ? 1.5 : 0); /* parking strips, painted cycle lanes */
    if (e) ests.push(e);
    if (s.sw) { if (s.sw === 1) swNo++; else if (s.sw === 4 || s.sw === 5) { swP++; swM++; } /* separate: the footway is its own OSM way, but the map tiles often drop it - keep ours (Berlin, Munich) */
      else { /* left of the OSM way direction (ux, uz) in local coordinates: +-90 degrees depending on the map's handedness (east -> x, north -> z) */
        const hand = Math.sign(s.ex * s.nz - s.nx * s.ez) || 1, lfx = -uz * hand, lfz = ux * hand, nrx = -dz, nrz = dx, isL = s.sw === 2;
        const side = (lfx * nrx + lfz * nrz) > 0 ? 1 : -1; if ((isL ? side : -side) > 0) swP++; else swM++; } } });
  const res = { w: w0, sideP: null, sideM: null, matched: n0.s ? n0.m / n0.s : 0, src: 0 };
  if (ests.length >= Math.max(2, n0.s * .4)) { ests.sort((a, b) => a - b); res.w = Math.max(3, Math.min(25, ests[ests.length >> 1])); res.src = 1; }
  const nsw = swP + swM + swNo + swSep; if (nsw >= Math.max(2, n0.s * .4)) { const half = nsw / 2;
    if (swNo + swSep > half) { res.sideP = false; res.sideM = false; } else { res.sideP = swP > nsw * .3; res.sideM = swM > nsw * .3; } }
  return res;
}
async function osmFor(x0, z0, x1, z1) { // all own OSM records inside a local box
  const q = quelleLocal('osm', (x0 + x1) / 2, (z0 + z1) / 2); if (!q) return { blds: [], pts: [], parts: [], areas: [] }; OPFAD = q.pfad || OPFAD;
  const keys = new Set();
  for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3; j++) { const ll = toLatLon(x0 + (x1 - x0) * i / 3, z0 + (z1 - z0) * j / 3), en = LAEA(ll[0], ll[1]); keys.add(Math.floor(en[0] / OSMT) + '_' + Math.floor(en[1] / OSMT)); }
  const res = await Promise.all([...keys].map(osmTile)), out = { blds: [], pts: [], parts: [], areas: [] };
  for (const r of res) { for (const b of r.blds) if (b.x >= x0 && b.x < x1 && b.z >= z0 && b.z < z1) out.blds.push(b); for (const q of r.pts) if (q.x >= x0 && q.x < x1 && q.z >= z0 && q.z < z1) out.pts.push(q);
    for (const q of r.parts || []) if (q.x >= x0 && q.x < x1 && q.z >= z0 && q.z < z1) out.parts.push(q);
    for (const q of r.areas || []) if (q.maxx >= x0 && q.minx < x1 && q.maxz >= z0 && q.minz < z1 && !out.areas.includes(q)) out.areas.push(q); }
  return out;
}
/* trees from the tree-cover map (ESA WorldCover 10 m, world-wide); null = not available here -> scatter fallback */
const bFiles = new Map();
function baumTile(k, pfad) {
  if (!bFiles.has(k)) bFiles.set(k, (async () => {
    let buf = await cget('b:' + k, 60 * 864e5);
    if (!buf) { const r = await tileGet(pfad, k, pfad + k + '.bin'); if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status); buf = r.ok ? r.buf : new ArrayBuffer(0); cput('b:' + k, buf); }
    if (buf.byteLength < 8) return null; // no trees in this tile
    const b = new Uint8Array(buf), w = b[4] | b[5] << 8, h = b[6] | b[7] << 8, mask = new Uint8Array(w * h);
    let p = 8, i = 0, on = 0;
    while (p < b.length && i < mask.length) { let n = 0, sh = 0, c; do { c = b[p++]; n += (c & 127) * Math.pow(2, sh); sh += 7; } while (c & 128); if (on) mask.fill(1, i, i + n); i += n; on ^= 1; }
    return { w, h, mask };
  })().catch(e => { bFiles.delete(k); throw e; }));
  return bFiles.get(k);
}
async function baumFor(x0, z0, x1, z1, rnd) {
  const q = QUELLEN && QUELLEN.basis && QUELLEN.basis.baeume; if (!q) return null;
  const a = toLatLon(x0, z1), b = toLatLon(x1, z0); // south-west, north-east
  const bb = q.bbox; if (bb && (a[1] < bb[0] || b[1] > bb[2] || a[0] < bb[1] || b[0] > bb[3])) return null;
  const T = q.raster || 0.025, pts = [];
  try {
    for (let iy = Math.floor(a[0] / T); iy <= Math.floor(b[0] / T); iy++) for (let ix = Math.floor(a[1] / T); ix <= Math.floor(b[1] / T); ix++) {
      const t = await baumTile(iy + '_' + ix, q.pfad); if (!t) continue;
      for (let r = 0; r < t.h; r++) {
        const lat = (iy + 1) * T - (r + 0.5) * T / t.h; if (lat < a[0] || lat > b[0]) continue;
        const zz = lz(merc(lat, 0).Y);
        for (let c = 0; c < t.w; c++) {
          if (!t.mask[r * t.w + c] || rnd() < 0.15) continue;
          const lon = ix * T + (c + rnd()) * T / t.w; if (lon < a[1] || lon > b[1]) continue;
          pts.push(lx(lon * Math.PI / 180 * R), zz + (rnd() - 0.5) * 6);
        }
      }
    }
  } catch (e) { return null; } // map not reachable: fall back to scattering trees over green areas
  return pts;
}
function eraFromYear(y) { return !y ? 0 : y < 1919 ? 1 : y < 1949 ? 2 : y < 1979 ? 3 : y < 2001 ? 4 : 5; }
function eraGuess(h, area) { return h > 22 ? 3 : area > 1500 ? 4 : 3; }
const ERA_WALLS = [null,
  // before 1919: cream, sand, pale ochre, soft pink, grey-blue, sage, sandstone
  ['#ecdcb8', '#e2c99a', '#e8d29a', '#e6c3b4', '#c4ccd0', '#c9d0b4', '#d6bf94', '#f0e6d2', '#dcb48c'],
  // 1919-48: brick and clinker, some ochre plaster
  ['#9a4e3c', '#8a4434', '#a8573f', '#b5643f', '#7a3e30', '#d9c08c', '#c9a77a'],
  // 1949-78: mostly white or off-white render, some post-war pastels and clinker
  ['#f3f1ea', '#eeede6', '#f2ece0', '#e9e7e0', '#f0eee8', '#e8e9e6', '#efe6cc', '#e6dcbc', '#dfe4df', '#9a4e3c'],
  // 1979-2000: white render, beige, clinker
  ['#efede6', '#e9e6dc', '#a8573f', '#d8cbb0', '#94503e', '#e6e0d2', '#c9b08a'],
  // 2001+: white, light grey, anthracite, wood
  ['#f2f0ea', '#e2e1dc', '#55585e', '#b9b6ae', '#a77d55', '#eae4d6', '#7d8086']].map(a => a && a.map(hex));
// Street View checks showed: most German facades are rendered (Putz); exposed brick is regional (north-west, coast) and era-bound.
const PLASTER = [null,
  ['#efe9dc', '#e8e6e0', '#dcdcd8', '#f2ece2', '#ecdcb8', '#e2c99a', '#e6c3b4', '#c4ccd0', '#c9d0b4', '#efd88f'],
  ['#e3c88c', '#ecd9a0', '#dccbaa', '#efeae0', '#cfcbc2', '#dcb8a6', '#e9dfc6'],
  ['#f3f1ea', '#eeede6', '#f2ece0', '#e9e7e0', '#f0eee8', '#efe6cc', '#e6dcbc', '#dfe4df', '#ecdfa8'],
  ['#efede6', '#e9e6dc', '#e6e0d2', '#d8cbb0', '#f2efe8', '#dcd8d0'],
  ['#f2f0ea', '#f4f2ee', '#e2e1dc', '#eeece6', '#55585e', '#b9b6ae', '#a77d55', '#eae4d6', '#f0eee8', '#d9d7d0']].map(a => a && a.map(hex));
const MATCOL = [null, null, hex('#e6dfcf'), hex('#c9b48a'), hex('#8a6a4a'), hex('#ece4d2'), hex('#7f9fb4'), hex('#a9a79f'), hex('#8c9096')]; // by material code
const STONE = ['#c9b48a', '#bfae8e', '#b3a68f', '#a8a294', '#c4b9a0', '#9d968a'].map(hex); // natural stone of castles and fortress walls without colour tag
/* Runde 137 (Google 3D, 40 squares: Mainz, Heidelberg, Frankfurt, Freiburg, Karlsruhe - churches drawn grey or white): south-west
   Germany builds its churches, castles and town halls from red Buntsandstein (Pfalz, Rhein-Main, Odenwald, Spessart, Main-Franken,
   Neckar, Black Forest, Breisgau). Churches and towers outside brick country are natural stone, not render. */
const RED_SAND = ['#a8584a', '#9e5446', '#b0645a', '#a35d4d', '#9a5a4c'].map(hex);
function redSandstone(x, z) { if (x === undefined) return false; const ll = toLatLon(x, z); return ll[0] >= 47.8 && ll[0] <= 50.35 && ll[1] >= 7.0 && ll[1] <= 10.3; }
function stoneWall(s, x, z) { const a = redSandstone(x, z) ? RED_SAND : STONE; return jitter(a[Math.floor(s * a.length)], s); }
function sacredWall(era, s, x, z) { const ll = toLatLon(x, z); return brickProb(1, ll[0], ll[1]) >= 0.4 ? wallFor(era, s, x, z) : stoneWall(s, x, z); }
const BRICK = ['#9a4e3c', '#8a4434', '#a8573f', '#b5643f', '#7a3e30', '#8e5a48'].map(hex);
const BRICK_ERA = [0, 0.6, 1.2, 0.5, 0.9, 0.3, 0.15];
const HALL = ['#c9ccce', '#aeb3b8', '#d8d8d2', '#8a9096', '#e2e0d8', '#7f8f9f', '#b9c2bf'].map(hex); // metal and panel facades of halls
function brickBase(lat, lon) { // rough regional share of exposed brick
  if (lon < 11 && (lat > 53.0 || (lat > 51.6 && lon < 7.9) || lat > 52.6)) return 0.6;     // north-west: Ostfriesland, Oldenburg, Münsterland, Niederrhein, Bremen/Hamburg
  if (lon < 11 && lat > 52.3) return 0.35;                                                  // rest of Lower Saxony / Schleswig-Holstein
  if (lon >= 11 && lat > 53.8) return 0.25;                                                 // Baltic coast towns
  return 0.12;                                                                              // centre, south and east (Berlin, Saxony …): rendered facades dominate
}
// probability of exposed brick: what OSM mappers recorded around here (by era), blended with the general rule as prior
function brickProb(era, lat, lon) {
  const prior = Math.min(0.9, brickBase(lat, lon) * (BRICK_ERA[era] || 0.5));
  if (!MATSTAT) return prior;
  // fine 0.1° cells where enough houses are tagged; otherwise the 0.5° cell, but capped in weight: it can be dominated by
  // a city 30 km away (Google 3D Monschau: Aachen's brick share made the Eifel half-timbered town red)
  let fc = null;
  if (MATSTAT.zellen_fein) { // own fine cell, else the 3×3 fine cells around it (~30 km), else the coarse cell
    const iy = Math.floor(lat / MATSTAT.fein), ix = Math.floor(lon / MATSTAT.fein);
    fc = MATSTAT.zellen_fein[iy + '_' + ix] || null;
    if (!fc) { const sum = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]; let n = 0;
      for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) { const z = MATSTAT.zellen_fein[(iy + a) + '_' + (ix + c)]; if (z) { n++; for (let e = 0; e < 6; e++) { sum[e][0] += z[e][0]; sum[e][1] += z[e][1]; } } }
      if (n) fc = sum; }
  }
  const cell = fc || (MATSTAT.zellen && MATSTAT.zellen[Math.floor(lat / MATSTAT.raster) + '_' + Math.floor(lon / MATSTAT.raster)]);
  if (!cell) return prior;
  let v = cell[era] || [0, 0]; if (v[0] + v[1] < 15) v = cell[0];
  /* Runde 137 (Google 3D/Street View, 40 squares: Dortmund, Karlsruhe, Kiel, Münster, Görlitz too red): mappers tag a brick facade
     far more often than a plain rendered one, so the tagged share overstates brick. The brick count is weighted down (x0.6). */
  let a = v[0] * 0.6, b = v[1]; if (!fc && a + b > 10) { const k = 10 / (a + b); a *= k; b *= k; }
  return (a + 15 * prior) / (a + b + 15);
}
// rendered wall colours that OSM mappers recorded around here (material.json "farben"), weighted by the square root of their
// count so the generic "white" tag does not drown the rest; only plausible plaster colours (not too dark, not garish)
const locCache = new Map();
function localColour(lat, lon, u) {
  const f = MATSTAT && MATSTAT.farben; if (!f) return null;
  const k = Math.floor(lat / MATSTAT.raster) + '_' + Math.floor(lon / MATSTAT.raster);
  let L = locCache.get(k);
  if (L === undefined) {
    L = null; const list = f[k];
    if (list) {
      const items = []; let tot = 0;
      for (const [q, n] of list) {
        const c = [parseInt(q[0], 16) / 15, parseInt(q[1], 16) / 15, parseInt(q[2], 16) / 15], [, sat, l] = rgb2hsl(c[0], c[1], c[2]);
        if (l < 0.5 || sat > 0.65) continue;
        const w = Math.sqrt(n); items.push([liftWall(c[0], c[1], c[2]), w]); tot += w;
      }
      if (items.length >= 3) L = { items, tot };
    }
    locCache.set(k, L);
  }
  if (!L) return null;
  let r = u * L.tot; for (const [c, w] of L.items) { r -= w; if (r < 0) return c; } return L.items[0][0];
}
function wallFor(era, s, x, z) {
  if (era === 6) { const c = jitter(HALL[Math.floor(s * HALL.length)], s); c.brick = false; return c; }
  // Street View Hamburg/Dresden: houses of one estate share material and often colour (built together). Decide per ~70 m cell
  // and era, with some houses deviating; old town houses (before 1919) stay individually varied.
  const ll = toLatLon(x, z), ck = era + ':' + Math.floor(x / 70) + ':' + Math.floor(z / 70), own = hashStr('o' + s) < (era <= 1 ? 0.6 : 0.2);
  const brick = (own ? hashStr('b' + s) : hashStr('bc' + ck)) < brickProb(era, ll[0], ll[1]);
  const a = brick ? BRICK : (PLASTER[era] || PLASTER[3]), pick = own || era <= 2 ? s : hashStr('pc' + ck);
  const loc = !brick && hashStr('lc' + (own || era <= 2 ? s : ck)) < 0.5 && localColour(ll[0], ll[1], pick);
  const c = jitter(loc || a[Math.floor(pick * a.length) % a.length], s); c.brick = brick; return c;
}
function eraWall(era, s) { const a = ERA_WALLS[era] || ERA_WALLS[3]; return jitter(a[Math.floor(s * a.length)], s); }

/* footprints of all buildings (from vector tiles): party walls, shops, collision */
/* Underpasses (phone test Bielefeld, Von-der-Recke-Strasse under Ostwestfalendamm and railway): OSM tags the bridge, the street below
   has no height. Everything lay on the same terrain, so every underpass looked like a level crossing. Rule: a street or path that
   crosses under a short road/rail bridge sinks into a trough - full depth under the bridge(s), straight ramps (10 %, paths 14 %) on
   both sides, retaining walls along the edges. The bridge itself keeps the terrain height. A dip is a straight strip:
   centre x/z, axis ux/uz along the street, half width hw, flat half length F, ramp length R, depth D. Shared by all tiles. */
/* Level-across streets (Runde 34) switched off: in bends and at junctions the corridors of several segments with different cross slopes
   overlap and road, sidewalk and lawn disagree again (phone test, Rheinstrasse). Needs a shared, finer height raster instead. */
let LEVEL_ROADS = false; // Runde 35 corridors - replaced by the shared height raster (Runde 40, see buildDZ)
/* Shared height raster (Runde 40): one 4 m grid per tile that says how much the ground is moved for level streets.
   Per node: W (0..1, how much of the street rule applies) and T (street axis height there). Height everywhere =
   terrain * (1 - W) + W * T, interpolated on the 4 m cells split along the same diagonal as the terrain grid. Ground, streets,
   sidewalks, objects, sprites, houses, the figure and the cars all read this one function - nothing can stick out of the street. */
let DZF = null, LEVEL_DZ = true, MERGE = true; const DZC = 4, DZB = 4;
function dzI(F, A, x, z) { const fx = x / DZC - F.gx0, fz = z / DZC - F.gz0, i = Math.floor(fx), j = Math.floor(fz); if (i < 0 || j < 0 || i >= F.nx - 1 || j >= F.nz - 1) return 0;
  const u = fx - i, v = fz - j, o = j * F.nx + i;
  if (u + v <= 1) { const a = A(o); return a + (A(o + 1) - a) * u + (A(o + F.nx) - a) * v; }
  const d = A(o + F.nx + 1); return d + (A(o + F.nx) - d) * (1 - u) + (A(o + 1) - d) * (1 - v); }
function dzLift(x, z, h) { const F = DZF; if (!F) return h; const w = dzI(F, o => F.W[o], x, z); if (w <= 0) return h; return h * (1 - w) + dzI(F, o => F.WT[o], x, z); }
function buildDZ(lines, halfW, bx0, bz0, bx1, bz1, ramps) { // ramps[li]: { E, Lr } = embankment of a raised bridge approach (Runde 51), else undefined
  const gx0 = Math.floor(bx0 / DZC), gz0 = Math.floor(bz0 / DZC), nx = Math.ceil(bx1 / DZC) - gx0 + 1, nz = Math.ceil(bz1 / DZC) - gz0 + 1;
  const W = new Float32Array(nx * nz), TS = new Float32Array(nx * nz), TN = new Float32Array(nx * nz); let any = false;
  lines.forEach((l, li) => { const a = halfW[li]; if (!(a > 0) || l.length < 4) return;
    const P = [l[0], l[1]]; for (let i = 0; i + 3 < l.length; i += 2) { const L = Math.hypot(l[i + 2] - l[i], l[i + 3] - l[i + 1]), n = Math.max(1, Math.ceil(L / 2)); for (let k = 1; k <= n; k++) P.push(l[i] + (l[i + 2] - l[i]) * k / n, l[i + 1] + (l[i + 3] - l[i + 1]) * k / n); }
    const m = P.length / 2 - 1, H = new Float32Array(m + 1), s0 = new Float32Array(m), s1 = new Float32Array(m), s = new Float32Array(m), R = 6;
    { /* axis height: terrain at stations every 8 m, linear in between (a smooth, nearly planar raster - big pieces stay whole) */ const st = [0]; let acc = 0; const cum = [0];
      for (let k = 1; k <= m; k++) { acc += Math.hypot(P[k * 2] - P[k * 2 - 2], P[k * 2 + 1] - P[k * 2 - 1]); cum.push(acc); }
      const ns = Math.max(1, Math.round(acc / 8)), sv = []; for (let q = 0; q <= ns; q++) { const t = acc * q / ns; let k = 0; while (k < m && cum[k + 1] < t) k++; const f = cum[k + 1] > cum[k] ? (t - cum[k]) / (cum[k + 1] - cum[k]) : 0; sv.push(hAt(P[k * 2] + (P[k * 2 + 2] - P[k * 2]) * f, P[k * 2 + 1] + (P[k * 2 + 3] - P[k * 2 + 1]) * f)); }
      for (let k = 0; k <= m; k++) { const t = acc ? cum[k] / acc * ns : 0, q = Math.min(ns - 1, Math.floor(t)); H[k] = sv[q] + (sv[q + 1] - sv[q]) * (t - q); } }
    /* only steep streets: strength from the cross slope (8 % -> 0, 14 % -> 1), widened and averaged over +-12 m along the street (gentle ramps) */
    for (let k = 0; k < m; k++) { const ex = P[k * 2 + 2] - P[k * 2], ez = P[k * 2 + 3] - P[k * 2 + 1], L = Math.hypot(ex, ez); if (L < 1e-3) continue;
      const qx = -ez / L, qz = ex / L, mx = P[k * 2] + ex / 2, mz = P[k * 2 + 1] + ez / 2, g = Math.abs(hAt(mx + qx * a, mz + qz * a) - hAt(mx - qx * a, mz - qz * a)) / (2 * a); s0[k] = Math.max(0, Math.min(1, (g - .08) / .06)); }
    for (let k = 0; k < m; k++) { let v = 0; for (let q = Math.max(0, k - R); q <= Math.min(m - 1, k + R); q++) v = Math.max(v, s0[q]); s1[k] = v; }
    for (let k = 0; k < m; k++) { let v = 0, c = 0; for (let q = Math.max(0, k - R); q <= Math.min(m - 1, k + R); q++) { v += s1[q]; c++; } s[k] = v / c; }
    const rp = ramps && ramps[li]; if (rp) { let cum = 0; for (let k = 0; k <= m; k++) { if (k) cum += Math.hypot(P[k * 2] - P[k * 2 - 2], P[k * 2 + 1] - P[k * 2 - 1]); H[k] += rp.E * Math.max(0, 1 - cum / rp.Lr); if (k < m) s[k] = cum < rp.Lr + 4 ? 1.1 : 0; } } /* 1.1: wins over the level-street rule on the same road */
    const e = a + DZB;
    for (let k = 0; k < m; k++) { if (s[k] < .01) continue; const x0 = P[k * 2], z0 = P[k * 2 + 1], ex = P[k * 2 + 2] - x0, ez = P[k * 2 + 3] - z0, L2 = ex * ex + ez * ez; if (L2 < 1e-6) continue;
      const i0 = Math.max(0, Math.ceil((Math.min(x0, x0 + ex) - e) / DZC) - gx0), i1 = Math.min(nx - 1, Math.floor((Math.max(x0, x0 + ex) + e) / DZC) - gx0);
      const j0 = Math.max(0, Math.ceil((Math.min(z0, z0 + ez) - e) / DZC) - gz0), j1 = Math.min(nz - 1, Math.floor((Math.max(z0, z0 + ez) + e) / DZC) - gz0);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const px = (i + gx0) * DZC, pz = (j + gz0) * DZC, q = Math.max(0, Math.min(1, ((px - x0) * ex + (pz - z0) * ez) / L2)), d = Math.hypot(px - x0 - ex * q, pz - z0 - ez * q); if (d >= e) continue;
        const w = (d <= a ? 1 : 1 - (d - a) / DZB) * s[k], t = H[k] + (H[k + 1] - H[k]) * q, o = j * nx + i; if (w <= 0) continue;
        if (w > W[o] + .05) { W[o] = w; TS[o] = t; TN[o] = 1; } else if (w > W[o] - .05) { if (w > W[o]) W[o] = w; TS[o] += t; TN[o]++; } any = true; } } });
  if (!any) return null;
  const WT = new Float32Array(nx * nz), T = new Float32Array(nx * nz), mod = new Uint8Array(nx * nz);
  for (let o = 0; o < W.length; o++) if (W[o] > .001) { W[o] = Math.min(1, W[o]); T[o] = TS[o] / TN[o]; WT[o] = W[o] * T[o]; } else W[o] = 0;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const o = j * nx + i; if (W[o] || W[o + 1] || W[o + nx] || W[o + nx + 1]) mod[o] = 1; }
  return { gx0, gz0, nx, nz, W, WT, T, mod };
}
const DIPS = new Map(), dipGrid = new Map(), dgk = (x, z) => Math.floor(x / 64) * 100003 + Math.floor(z / 64);
function addDip(d) { const k = Math.round(d.x) + ',' + Math.round(d.z); if (DIPS.has(k)) return;
  // the same underpass seen from a neighbouring tile (clipped differently) must not make a second, shifted trough: the first one wins
  // (Runde 87: only a trough of the same kind - a street trough beside a motorway trough is not the same underpass)
  for (const e of dipsIn(d.x - 1, d.z - 1, d.x + 1, d.z + 1)) if (!!e.cut === !!d.cut && !!e.portal === !!d.portal && Math.abs(e.ux * d.ux + e.uz * d.uz) > .85 && Math.abs(dipT(e, d.x, d.z)) < Math.min(e.hw, d.hw) * .5 && Math.abs(dipS(e, d.x, d.z)) < e.F + d.F + e.R) return; // (Runde 87: on the same centre line - the other carriageway 10 m beside it is not the same underpass)
  DIPS.set(k, d); const e = d.F + d.R + d.hw;
  for (let x = Math.floor((d.x - e) / 64); x <= Math.floor((d.x + e) / 64); x++) for (let z = Math.floor((d.z - e) / 64); z <= Math.floor((d.z + e) / 64); z++) { const kk = x * 100003 + z; let a = dipGrid.get(kk); if (!a) dipGrid.set(kk, a = []); a.push(d); } }
function dipsIn(x0, z0, x1, z1) { const out = new Set(); for (let x = Math.floor(x0 / 64); x <= Math.floor(x1 / 64); x++) for (let z = Math.floor(z0 / 64); z <= Math.floor(z1 / 64); z++) { const a = dipGrid.get(x * 100003 + z); if (a) for (const d of a) out.add(d); } return [...out]; }
const dipS = (d, x, z) => (x - d.x) * d.ux + (z - d.z) * d.uz, dipT = (d, x, z) => -(x - d.x) * d.uz + (z - d.z) * d.ux;
const dipProfile = (d, s) => { if (d.F < 0) { if (s > 0) return 0; s = -s; } else s = Math.abs(s); const F = Math.max(0, d.F); return s <= F ? d.D : s >= F + d.R ? 0 : d.D * (1 - (s - F) / d.R); }; // F < 0: tunnel approach, one-sided (Runde 79)
function dipAtList(L, x, z) { let m = 0; for (const d of L) { if (Math.abs(dipT(d, x, z)) > d.hw) continue; const v = dipProfile(d, dipS(d, x, z)); if (v > m) m = v; } return m; }
const wetCells = new Set(), wk = (x, z) => Math.floor(x / 8) * 100003 + Math.floor(z / 8); // 8 m cells with water (all loaded tiles)
const fpgrid = new Map(), castleAreas = new Set(), bridgeGrid = new Map(), bk = (i, j) => i * 100003 + j; // bridgeGrid: points every 2 m along bridge roads/paths (rdk cells)
function gAdd(grid, it) {
  for (let ix = Math.floor(it.minx / CELL); ix <= Math.floor(it.maxx / CELL); ix++)
    for (let iz = Math.floor(it.minz / CELL); iz <= Math.floor(it.maxz / CELL); iz++) { const k = gkey(ix, iz); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(it); }
}
function gRemove(grid, pred) { for (const [k, a] of grid) { const b = a.filter(i => !pred(i)); if (b.length) grid.set(k, b); else grid.delete(k); } }
function fpAt(x, z, not) {
  const a = fpgrid.get(gkey(Math.floor(x / CELL), Math.floor(z / CELL))); if (!a) return null; let best = null;
  for (const it of a) { if (it === not || x < it.minx || x > it.maxx || z < it.minz || z > it.maxz) continue; if (inPoly(x, z, it.p) && (!best || it.h > best.h)) best = it; }
  return best;
}
// coarse grid of where streets and squares are (6 m cells): decides which side of a house faces the street
const roadGrid = new Set(), rg = (x, z) => Math.floor(x / 6) * 100003 + Math.floor(z / 6);
function facesStreet(cx, cz, nx, nz) {
  for (let d = 2.5; d <= 16; d += 2.5) {
    const x = cx + nx * d, z = cz + nz * d;
    if (roadGrid.has(rg(x, z))) return true;
    if (d > 3 && fpAt(x, z)) return false; // another house in between
  }
  return false;
}
const SHOPRX =/shop|store|grocery|clothing|restaurant|cafe|fast_food|bar|pub|bank|pharmacy|bakery|hairdresser|ice_cream|beer|alcohol|jewel|books|shoes|butcher|florist|optician|gift|furniture|hardware|mobile|electronics|toys|beauty|laundry|kiosk|deli|confection|travel|post|chemist|supermarket|department|convenience|bicycle_shop|music|art|photo|tobacco|wine|tea|coffee|chocolate|cosmetics|perfum|stationery|copyshop|tailor|dry_cleaning|bookmaker|money|nightclub|biergarten|food_court/;

/* geometry writer (non-indexed, flat normals; optional per-vertex facade code) */
class Geo {
  constructor(useFac) { this.p = []; this.n = []; this.c = []; this.f = useFac ? [] : null; this.w = useFac ? [] : null; this.b = useFac ? [] : null; }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, col, hx, hy, hz, f0, f1, w0, w1, w2) {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz); if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    if (nx * hx + ny * hy + nz * hz < 0) { let t = bx; bx = cx; cx = t; t = by; by = cy; cy = t; t = bz; bz = cz; cz = t; nx = -nx; ny = -ny; nz = -nz; }
    this.p.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { this.n.push(nx, ny, nz); this.c.push(col[0], col[1], col[2]); if (this.f) { this.f.push(f0 || 0, f1 || 0); this.w.push(w0 || 0, w1 || 0, w2 || 0); this.b.push(0); } }
  }
  quad(a, b, c, d, col, hx, hy, hz, f0, f1, w0, w1, w2) { this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col, hx, hy, hz, f0, f1, w0, w1, w2); this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col, hx, hy, hz, f0, f1, w0, w1, w2); }
  flat(rings, y, col, f0, f1) { // rings: [outer, ...holes] Float arrays [x,z,...]
    const flatArr = [], holes = [];
    for (let r = 0; r < rings.length; r++) { if (r) holes.push(flatArr.length / 2); for (const v of rings[r]) flatArr.push(v); }
    const idx = earcut(flatArr, holes.length ? holes : null, 2);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 2, b = idx[i + 1] * 2, c = idx[i + 2] * 2;
      this.tri(flatArr[a], y, flatArr[a + 1], flatArr[b], y, flatArr[b + 1], flatArr[c], y, flatArr[c + 1], col, 0, 1, 0, f0, f1);
    }
    return { flatArr, idx };
  }
  box(x, y, z, sx, sy, sz, col) {
    const x0 = x - sx / 2, x1 = x + sx / 2, z0 = z - sz / 2, z1 = z + sz / 2, y1 = y + sy;
    this.quad([x0, y, z1], [x1, y, z1], [x1, y1, z1], [x0, y1, z1], col, 0, 0, 1);
    this.quad([x1, y, z0], [x0, y, z0], [x0, y1, z0], [x1, y1, z0], col, 0, 0, -1);
    this.quad([x1, y, z1], [x1, y, z0], [x1, y1, z0], [x1, y1, z1], col, 1, 0, 0);
    this.quad([x0, y, z0], [x0, y, z1], [x0, y1, z1], [x0, y1, z0], col, -1, 0, 0);
  }
  crown(x, y, z, r, h, col) { // low-poly octahedron, 6 sides
    const pts = []; for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2 + 0.3; pts.push([x + Math.cos(a) * r, y + h * 0.45, z + Math.sin(a) * r]); }
    const top = [x, y + h, z], bot = [x, y, z];
    for (let k = 0; k < 6; k++) {
      const a = pts[k], b = pts[(k + 1) % 6], mx = (a[0] + b[0]) / 2 - x, mz = (a[2] + b[2]) / 2 - z;
      const c2 = [col[0] * 1.06, col[1] * 1.06, col[2] * 1.06];
      this.tri(a[0], a[1], a[2], b[0], b[1], b[2], top[0], top[1], top[2], k % 2 ? col : c2, mx, 0.6, mz);
      this.tri(a[0], a[1], a[2], b[0], b[1], b[2], bot[0], bot[1], bot[2], col, mx, -0.6, mz);
    }
  }
  out() { return { pos: new Float32Array(this.p), nor: new Float32Array(this.n), col: new Float32Array(this.c), fac: this.f ? new Float32Array(this.f) : null, wal: this.w ? new Float32Array(this.w) : null, base: this.b ? new Float32Array(this.b) : null }; }
  // lift vertices from 'from' on by a fixed base height (a house stands on one level, its facade code uses heights above that base)
  lift(from, base) { if (!base) return; for (let i = from; i < this.p.length; i += 3) this.p[i + 1] += base; if (this.b) for (let i = from / 3; i < this.b.length; i++) this.b[i] = base; }
  // put ground geometry onto the terrain: flat parts are split where the terrain bends (more than ~15 cm off, not below 6 m), the thin layers
  // (areas, sidewalks, roads) are spread 3× further apart so the different triangulations never cut through each other
  // put ground geometry onto the terrain (phone test: stripes and triangles where thin layers cut through each other on slopes).
  // The terrain is a fixed grid of flat triangles (16 m, 48 m on flat tiles); every ground polygon is cut along that same grid and
  // lifted onto it, so all layers (meadow, square, sidewalk, road) lie exactly parallel and can never cut through each other.
  drape(hf) {
    if (!TERRAIN_ON) return;
    const P = this.p, N = this.n, C = this.c, np = [], nn = [], nc = [], gf = [], dt = [];
    // grid size from the roughness of this piece of map
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) { if (P[i] < x0) x0 = P[i]; if (P[i] > x1) x1 = P[i]; if (P[i + 2] < z0) z0 = P[i + 2]; if (P[i + 2] > z1) z1 = P[i + 2]; }
    let lo = Infinity, hi = -Infinity; for (let a = 0; a <= 8; a++) for (let b = 0; b <= 8; b++) { const h = hf(x0 + (x1 - x0) * a / 8, z0 + (z1 - z0) * b / 8); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const S = this.forceS || (hi - lo < 3 ? 48 : 16), gh = new Map(); this.S = S; // bridges reuse the ground's grid, else deck and road below disagree by decimetres
    const G = (i, j) => { const k = i * 100003 + j; let h = gh.get(k); if (h === undefined) { h = hf(i * S, j * S); gh.set(k, h); } return h; };
    const tH = (x, z) => { // piecewise flat terrain: each grid cell split along the diagonal
      const i = Math.floor(x / S), j = Math.floor(z / S), u = x / S - i, v = z / S - j;
      if (u + v <= 1) { const h00 = G(i, j); return h00 + (G(i + 1, j) - h00) * u + (G(i, j + 1) - h00) * v; }
      const h11 = G(i + 1, j + 1); return h11 + (G(i, j + 1) - h11) * (1 - u) + (G(i + 1, j) - h11) * (1 - v);
    };
    this.tH = tH;
    const sH = (x, z) => { // smooth (bilinear) terrain for the shading normal
      const i = Math.floor(x / S), j = Math.floor(z / S), u = x / S - i, v = z / S - j;
      return (G(i, j) * (1 - u) + G(i + 1, j) * u) * (1 - v) + (G(i, j + 1) * (1 - u) + G(i + 1, j + 1) * u) * v; };
    const clip = (poly, a, b, c) => { // keep the part with a*x + b*z + c >= 0
      const out = [];
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k], q = poly[(k + 1) % poly.length], dp = a * p[0] + b * p[2] + c, dq = a * q[0] + b * q[2] + c;
        if (dp >= 0) out.push(p);
        if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]); }
      }
      return out;
    };
    const DL = this.noDip ? [] : (this.dips || []);
    const area2 = p => { let a = 0; for (let k = 0; k < p.length; k++) { const q = p[(k + 1) % p.length]; a += p[k][0] * q[2] - q[0] * p[k][2]; } return Math.abs(a); };
    const SHORE = this.shore, CORR = this.noDip ? null : this.corr, TB = this.tileBox;
    /* shared height raster: delta to this drape's terrain per 4 m node (W * (T - terrain)), cached */
    const DZ = this.noDip || this.noShade ? null : DZF, dzc = DZ ? new Float32Array(DZ.nx * DZ.nz).fill(NaN) : null;
    const dzN = o => { let v = dzc[o]; if (v !== v) { const w = DZ.W[o]; if (!w) v = 0; else { const i = o % DZ.nx, j = (o - i) / DZ.nx; v = w * (DZ.T[o] - tH((i + DZ.gx0) * DZC, (j + DZ.gz0) * DZC)); if (Math.abs(v) < .01) v = 0; } dzc[o] = v; } return v; };
    const dzD = (x, z) => DZ ? dzI(DZ, dzN, x, z) : 0, tHz = (x, z) => tH(x, z) + dzD(x, z); this._tHz = tHz; // (raised decks measure against it, Runde 79)
    const dzTouch = (x0, z0, x1, z1) => { if (!DZ) return false; const i0 = Math.max(0, Math.floor(x0 / DZC) - DZ.gx0), i1 = Math.min(DZ.nx - 2, Math.floor(x1 / DZC) - DZ.gx0), j0 = Math.max(0, Math.floor(z0 / DZC) - DZ.gz0), j1 = Math.min(DZ.nz - 2, Math.floor(z1 / DZC) - DZ.gz0);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (DZ.mod[j * DZ.nx + i]) return true; return false; };
    /* adaptive: a piece stays whole while the height change over it is flat (within 1 cm) - on the straight level street and in the
       middle of a slope that is the rule; only where it bends (embankment edges, curves, junctions) it is cut into 16 / 8 / 4 m cells */
    let dzTol = .02; const dzFlat = poly => { const n = poly.length, D0 = poly.map(v => dzD(v[0], v[2]));
      let best = 0, ia = 1, ib = 2; for (let a = 1; a < n; a++) for (let b = a + 1; b < n; b++) { const ar = Math.abs((poly[a][0] - poly[0][0]) * (poly[b][2] - poly[0][2]) - (poly[b][0] - poly[0][0]) * (poly[a][2] - poly[0][2])); if (ar > best) { best = ar; ia = a; ib = b; } }
      if (best < 1e-6) return true;
      const x0 = poly[0][0], z0 = poly[0][2], ax = poly[ia][0] - x0, az = poly[ia][2] - z0, bx = poly[ib][0] - x0, bz = poly[ib][2] - z0, da = D0[ia] - D0[0], db = D0[ib] - D0[0], det = ax * bz - bx * az;
      const pl = (x, z) => { const u = ((x - x0) * bz - bx * (z - z0)) / det, v = (ax * (z - z0) - (x - x0) * az) / det; return D0[0] + da * u + db * v; };
      for (let k = 0; k < n; k++) if (Math.abs(D0[k] - pl(poly[k][0], poly[k][2])) > dzTol) return false;
      for (let k = 0; k < n; k++) { const p = poly[k], q = poly[(k + 1) % n], L = Math.hypot(q[0] - p[0], q[2] - p[2]), m = Math.floor(L / 1.5);
        for (let s = 1; s <= m; s++) { const x = p[0] + (q[0] - p[0]) * s / (m + 1), z = p[2] + (q[2] - p[2]) * s / (m + 1); if (Math.abs(dzD(x, z) - pl(x, z)) > dzTol) return false; } }
      let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity; for (const v of poly) { px0 = Math.min(px0, v[0]); px1 = Math.max(px1, v[0]); pz0 = Math.min(pz0, v[2]); pz1 = Math.max(pz1, v[2]); }
      for (let x = Math.ceil(px0 / DZC) * DZC; x <= px1; x += DZC) for (let z = Math.ceil(pz0 / DZC) * DZC; z <= pz1; z += DZC) { let ins = true;
        for (let k = 0; k < n && ins; k++) { const p = poly[k], q = poly[(k + 1) % n]; if ((q[0] - p[0]) * (z - p[2]) - (q[2] - p[2]) * (x - p[0]) < -1e-6 * (det > 0 ? 1 : 1)) ins = false; }
        if (!ins) { ins = true; for (let k = 0; k < n && ins; k++) { const p = poly[k], q = poly[(k + 1) % n]; if ((q[0] - p[0]) * (z - p[2]) - (q[2] - p[2]) * (x - p[0]) > 1e-6) ins = false; } }
        if (ins && Math.abs(dzD(x, z) - pl(x, z)) > dzTol) return false; }
      return true; };
    const dzRefine = (poly, c, out) => { if (dzFlat(poly)) { out(poly); return; }
      let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity; for (const v of poly) { px0 = Math.min(px0, v[0]); px1 = Math.max(px1, v[0]); pz0 = Math.min(pz0, v[2]); pz1 = Math.max(pz1, v[2]); }
      let pieces = [poly]; const cut = (a, b, cc) => { const o = []; for (const p of pieces) { const A = clip(p, a, b, cc), B = clip(p, -a, -b, -cc); if (A.length >= 3 && area2(A) > 1e-5) o.push(A); if (B.length >= 3 && area2(B) > 1e-5) o.push(B); } pieces = o; };
      for (let a = Math.floor(px0 / c) + 1; a * c < px1; a++) cut(1, 0, -a * c);
      for (let b = Math.floor(pz0 / c) + 1; b * c < pz1; b++) cut(0, 1, -b * c);
      for (let d = Math.floor((px0 + pz0) / c) + 1; d * c < px1 + pz1; d++) cut(1, 1, -d * c);
      for (const p of pieces) { if (c <= DZC) out(p); else if (pieces.length === 1) dzRefine(p, c / 2, out); else dzRefine(p, c / 2, out); } };
    // streets on slopes are level across (Runde 35): every street surface (road, sidewalk, curb, markings, lamps) was tagged with its own
    // street segment and takes its height only from that segment's axis (linear between the axis ends - same in every piece, so the layers of
    // one street never disagree). Everything else is cut away inside the street area (lv: index into CORR.segs, stride 6).
    const LV = this.lv, segD = (i, x, z) => { const S = CORR.segs, x0 = S[i], z0 = S[i + 1], ex = S[i + 2] - x0, ez = S[i + 3] - z0, q = Math.max(0, Math.min(1, ((x - x0) * ex + (z - z0) * ez) / (ex * ex + ez * ez))); return [Math.hypot(x - x0 - ex * q, z - z0 - ez * q), q]; };
    // continuous along the street: a point beyond the end of its own segment takes the neighbouring segment of the same line
    // (consecutive in corrSegs, joined end to start) - else every layer clamped differently at the joints (specks, broken curbs)
    // one height function for all street surfaces: the nearest levelled segment at this point (any street, any line) - joints between
    // segments, between two ways of one road and at junctions all agree (Rheinstrasse: one way's sidewalk stood above the other's road)
    const lvSeg = (i, x, z) => { const S = CORR.segs, l = CORR.grid.get(Math.floor(x / CORR.K) * 100003 + Math.floor(z / CORR.K)); let best = i, bd = segD(i, x, z)[0];
      if (l) for (const j of l) { if (j === i) continue; const ex = S[j + 2] - S[j], ez = S[j + 3] - S[j + 1], q = ((x - S[j]) * ex + (z - S[j + 1]) * ez) / (ex * ex + ez * ez); if (q < -.02 || q > 1.02) continue;
        const d = segD(j, x, z)[0]; if (d < bd - 1e-6) { bd = d; best = j; } } return best; };
    const lvH = (i0, x, z) => { const S = CORR.segs, i = lvSeg(i0, x, z), q = segD(i, x, z)[1], h0 = tH(S[i], S[i + 1]), ax = h0 + (tH(S[i + 2], S[i + 3]) - h0) * q, k = S[i + 5]; return k >= 1 ? ax : ax * k + tH(x, z) * (1 - k); }; // k < 1: only part of the cross slope taken out
    const inCorr = (x, z, skip = -1, m = 0) => { if (!CORR) return false; const l = CORR.grid.get(Math.floor(x / CORR.K) * 100003 + Math.floor(z / CORR.K)); if (!l) return false;
      for (const i of l) { if (i === skip || CORR.segs[i + 5] < .02) continue; const S = CORR.segs, ex = S[i + 2] - S[i], ez = S[i + 3] - S[i + 1], q = ((x - S[i]) * ex + (z - S[i + 1]) * ez) / (ex * ex + ez * ez);
        if (q > -.02 && q < 1.02 && segD(i, x, z)[0] < S[i + 4] - m) return true; } return false; }; // a box along the segment, no round caps beyond the street's end
    const corrAt = (x, z, skip = -1) => { if (!CORR) return -1; const l = CORR.grid.get(Math.floor(x / CORR.K) * 100003 + Math.floor(z / CORR.K)); if (!l) return -1;
      for (const i of l) { if (i === skip || CORR.segs[i + 5] < .02) continue; if (segD(i, x, z)[0] < CORR.segs[i + 4]) return i; } return -1; }; // round ends (clamped distance)
    const emit = (poly, col, k0 = 0, sh = 0, cr = 0, lv = -1, off = 0, dzd = 0) => {
      if (poly.length < 3) return;
      /* Runde 186 (phone test, pond in Bethel: a lawn lay over the lake): the vector tile's buffer reaches beyond the tile, and an area
         (park, lawn, forest) there was only cut where this tile's own water field knows water - the neighbour's lake was not in it.
         Areas end at the tile edge; the neighbour draws its own (with its water). */
      if (TB && !sh && poly[0][1] <= .02 && poly[0][1] > -.05) { let p = clip(poly, 1, 0, -TB[0]); if (p.length >= 3) p = clip(p, -1, 0, TB[2]); if (p.length >= 3) p = clip(p, 0, 1, -TB[1]); if (p.length >= 3) p = clip(p, 0, -1, TB[3]);
        if (p.length < 3 || area2(p) < 1e-4) return; poly = p; }
      if (CORR && !cr && lv >= 0) { // a street surface: cut at the station lines (ends of the nearby levelled segments), so the height is linear in every piece
        let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity; for (const v of poly) { px0 = Math.min(px0, v[0]); px1 = Math.max(px1, v[0]); pz0 = Math.min(pz0, v[2]); pz1 = Math.max(pz1, v[2]); }
        const ids = new Set(); for (let i = Math.floor(px0 / CORR.K); i <= Math.floor(px1 / CORR.K); i++) for (let j = Math.floor(pz0 / CORR.K); j <= Math.floor(pz1 / CORR.K); j++) { const l = CORR.grid.get(i * 100003 + j); if (l) for (const q of l) ids.add(q); }
        let pieces = [poly]; const S = CORR.segs;
        for (const i of ids) { if (S[i + 5] < .02) continue; const ex = S[i + 2] - S[i], ez = S[i + 3] - S[i + 1], L = Math.hypot(ex, ez); if (L < .1) continue; const ux = ex / L, uz = ez / L;
          for (const [qx, qz] of [[S[i], S[i + 1]], [S[i + 2], S[i + 3]]]) { const c = -(ux * qx + uz * qz); let mn = Infinity, mx = -Infinity; for (const v of poly) { const t = ux * v[0] + uz * v[2] + c; mn = Math.min(mn, t); mx = Math.max(mx, t); } if (mn >= 0 || mx <= 0) continue;
            if (Math.hypot(qx - Math.max(px0, Math.min(px1, qx)), qz - Math.max(pz0, Math.min(pz1, qz))) > S[i + 4] + 2) continue; // station line only near its station
            const o = []; for (const p of pieces) { const A = clip(p, ux, uz, c), B = clip(p, -ux, -uz, -c); if (A.length >= 3 && area2(A) > 1e-4) o.push(A); if (B.length >= 3 && area2(B) > 1e-4) o.push(B); } pieces = o; }
          if (pieces.length > 40) break; }
        for (const p of pieces) emit(p, col, k0, sh, 1, lv, off); return; }
      if (CORR && !cr && lv === -1) { // not a street surface: cut along the edges of nearby level streets and drop what lies inside them
        let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity; for (const v of poly) { px0 = Math.min(px0, v[0]); px1 = Math.max(px1, v[0]); pz0 = Math.min(pz0, v[2]); pz1 = Math.max(pz1, v[2]); }
        const ids = new Set(); for (let i = Math.floor(px0 / CORR.K); i <= Math.floor(px1 / CORR.K); i++) for (let j = Math.floor(pz0 / CORR.K); j <= Math.floor(pz1 / CORR.K); j++) { const l = CORR.grid.get(i * 100003 + j); if (l) for (const q of l) ids.add(q); }
        if (ids.size) { let pieces = [poly]; const S = CORR.segs;
          let whole = false;
          for (const i of ids) { if (S[i + 5] < .02) continue; /* not levelled here (junction): nothing to cut */ const x0 = S[i], z0 = S[i + 1], ex = S[i + 2] - x0, ez = S[i + 3] - z0, L = Math.hypot(ex, ez), nx = -ez / L, nz = ex / L, c0 = -(nx * x0 + nz * z0), a = S[i + 4];
            // only cut where the piece really crosses this street's edge: wholly outside -> skip, wholly inside -> drop without cutting
            let tMin = Infinity, tMax = -Infinity, qMin = Infinity, qMax = -Infinity; for (const v of poly) { const t = nx * v[0] + nz * v[2] + c0, q = ((v[0] - x0) * ex + (v[2] - z0) * ez) / (L * L); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); qMin = Math.min(qMin, q); qMax = Math.max(qMax, q); }
            const qm = a / L; if (tMin >= a || tMax <= -a || qMax <= -qm || qMin >= 1 + qm) continue; // round ends: the outer side of a bend is covered too (Wuppertal: grass on the road)
            if (tMin > -a && tMax < a && qMin > -.02 && qMax < 1.02) { whole = true; break; }
            for (const off of [a, -a]) { if (off > tMin && off < tMax) {} else continue; const o = []; for (const p of pieces) { const A = clip(p, nx, nz, c0 - off), Bp = clip(p, -nx, -nz, -(c0 - off)); if (A.length >= 3 && area2(A) > 1e-4) o.push(A); if (Bp.length >= 3 && area2(Bp) > 1e-4) o.push(Bp); } pieces = o; }
            if (pieces.length > 48) break; }
          if (whole) { let cx = 0, cz = 0; for (const v of poly) { cx += v[0]; cz += v[2]; } const ci = corrAt(cx / poly.length, cz / poly.length); emit(poly, col, k0, sh, 1, ci, ci >= 0 ? .15 : 0); return; }
          for (const p of pieces) { let cx = 0, cz = 0; for (const v of p) { cx += v[0]; cz += v[2]; } const ci = corrAt(cx / p.length, cz / p.length); emit(p, col, k0, sh, 1, ci, ci >= 0 ? .15 : 0); } return; } } // inside a street: 15 cm under it instead of cut away (where the street bands leave a gap, ground shows instead of sky)
      if (SHORE && !sh && poly[0][1] <= .02 && poly[0][1] > -.05) { // area layers only (not the base meadow, not roads, paths, piers)
        let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity; for (const v of poly) { px0 = Math.min(px0, v[0]); px1 = Math.max(px1, v[0]); pz0 = Math.min(pz0, v[2]); pz1 = Math.max(pz1, v[2]); }
        const segs = new Set(); for (let i = Math.floor(px0 / SHORE.K); i <= Math.floor(px1 / SHORE.K); i++) for (let j = Math.floor(pz0 / SHORE.K); j <= Math.floor(pz1 / SHORE.K); j++) { const l = SHORE.grid.get(i * 100003 + j); if (l) for (let q = 0; q < l.length; q += 4) segs.add(l[q] + ',' + l[q + 1] + ',' + l[q + 2] + ',' + l[q + 3]); }
        let pieces = [poly];
        for (const sg of segs) { const [ax, az, bx, bz] = sg.split(',').map(Number), ex = bx - ax, ez = bz - az, l = Math.hypot(ex, ez); if (l < .05) continue;
          if (Math.max(ax, bx) < px0 || Math.min(ax, bx) > px1 || Math.max(az, bz) < pz0 || Math.min(az, bz) > pz1) continue;
          const nx = -ez / l, nz = ex / l, c = -(nx * ax + nz * az), o = [];
          for (const p of pieces) { const A = clip(p, nx, nz, c), B = clip(p, -nx, -nz, -c); if (A.length >= 3 && area2(A) > 1e-4) o.push(A); if (B.length >= 3 && area2(B) > 1e-4) o.push(B); }
          pieces = o; if (pieces.length > 64) break; }
        for (const p of pieces) { let cx = 0, cz = 0; for (const v of p) { cx += v[0]; cz += v[2]; } if (SHORE.wet(cx / p.length, cz / p.length)) continue; emit(p, col, k0, 1, cr, lv, off); }
        return; }
      // cut the piece along the trough edges and the ramp breaks, so every piece lies wholly inside or outside and sinks linearly
      // (k0: troughs already handled for this piece - a piece lying on a cut line must not be cut again and again)
      if (k0 < DL.length) {
        let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity; for (const v of poly) { px0 = Math.min(px0, v[0]); px1 = Math.max(px1, v[0]); pz0 = Math.min(pz0, v[2]); pz1 = Math.max(pz1, v[2]); }
        for (let k = k0; k < DL.length; k++) { const d = DL[k], e = d.F + d.R + d.hw; if (px1 < d.x - e || px0 > d.x + e || pz1 < d.z - e || pz0 > d.z + e) continue;
          const nx = -d.uz, nz = d.ux, cT = -(nx * d.x + nz * d.z), cS = -(d.ux * d.x + d.uz * d.z);
          let pieces = [poly];
          const cut = (a, b, c) => { const o = []; for (const p of pieces) { const A = clip(p, a, b, c), B = clip(p, -a, -b, -c); if (A.length >= 3 && area2(A) > 1e-4) o.push(A); if (B.length >= 3 && area2(B) > 1e-4) o.push(B); } pieces = o; };
          cut(nx, nz, cT - d.hw); cut(nx, nz, cT + d.hw);
          for (const s of [-d.F - d.R, -d.F, d.F, d.F + d.R]) cut(d.ux, d.uz, cS - s);
          for (const p of pieces) emit(p, col, k + 1, sh, cr, lv, off); return;
        }
      }
      if (DZ && !dzd) { /* (the bed under the water too: where a street is cut deeper than 1.55 m into the slope it stuck out above it - phone test Rheinstrasse) piece over moved raster cells: cut along the 4 m cells and their diagonals, so it stays flat in every piece */
        let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity; for (const v of poly) { px0 = Math.min(px0, v[0]); px1 = Math.max(px1, v[0]); pz0 = Math.min(pz0, v[2]); pz1 = Math.max(pz1, v[2]); }
        if (dzTouch(px0, pz0, px1, pz1)) { dzTol = poly[0][1] < -1 ? .3 : poly[0][1] < -.05 ? .05 : .02; /* the base meadow lies 11 cm below the next layer */ dzRefine(poly, 16, p => emit(p, col, k0, sh, cr, lv, off, 1)); return; } }
      let sink = 0; // land areas lying on open water sink with the lowered water (tidal flats, beaches, reed in the river)
      if (this.sinkAt && poly[0][1] <= .02 && poly[0][1] > -.05) { let cx = 0, cz = 0; for (const v of poly) { cx += v[0]; cz += v[2]; } if (this.sinkAt(cx / poly.length, cz / poly.length)) sink = this.sinkAt.depth; }
      let cxp = 0, czp = 0; for (const v of poly) { cxp += v[0]; czp += v[2]; } cxp /= poly.length; czp /= poly.length;
      const inDip = DL.length ? DL.filter(d => Math.abs(dipT(d, cxp, czp)) < d.hw && Math.abs(dipS(d, cxp, czp)) < d.F + d.R) : DL;
      const dipV = (x, z) => { let m = 0; for (const d of inDip) { const v = dipProfile(d, dipS(d, x, z)); if (v > m) m = v; } return m; };
      if (MG && !inDip.length && lv < 0 && !off) { const y0 = poly[0][1]; let same = true; for (const v of poly) if (Math.abs(v[1] - y0) > 1e-6) { same = false; break; }
        if (same) { /* pieces of one layer and colour in one flat cell are collected and joined at the end (see mergeLoops) */ let key = null;
          if (dzd) { const a = Math.floor(cxp / DZC), b = Math.floor(czp / DZC), h2 = cxp / DZC - a + czp / DZC - b <= 1 ? 0 : 1; let ok = true;
            for (const v of poly) { const u = v[0] / DZC - a, w = v[2] / DZC - b; if (u < -1e-6 || w < -1e-6 || u > 1 + 1e-6 || w > 1 + 1e-6 || (h2 ? u + w < 1 - 1e-6 : u + w > 1 + 1e-6)) { ok = false; break; } }
            if (ok) key = 'd' + a + ',' + b + ',' + h2; }
          else { const i = Math.floor(cxp / S), j = Math.floor(czp / S); key = 's' + i + ',' + j + ',' + (cxp / S - i + czp / S - j <= 1 ? 0 : 1); }
          if (key) { const cell = key, par = key[0] === 'd' ? (() => { const i = Math.floor(cxp / S), j = Math.floor(czp / S); return 's' + i + ',' + j + ',' + (cxp / S - i + czp / S - j <= 1 ? 0 : 1); })() : null;
            key += '|' + y0.toFixed(4) + '|' + sink.toFixed(3) + '|' + col[0].toFixed(4) + ',' + col[1].toFixed(4) + ',' + col[2].toFixed(4);
            let g = MG.get(key); if (!g) MG.set(key, g = { polys: [], y: y0, sink, col, cell, par }); g.polys.push(poly.map(v => [v[0], v[2]])); return; } } }
      const EL = this.elev, L = poly.map(v => [v[0], (EL ? EL(v[0], v[2]) : 0) + v[1] + (lv >= 0 ? (off > 0 ? Math.min(lvH(lv, v[0], v[2]), tH(v[0], v[2])) : lvH(lv, v[0], v[2])) - off : tHz(v[0], v[2])) - sink - (inDip.length ? dipV(v[0], v[2]) : 0), v[2]]);
      // normal over all corners (Newell): clipped pieces often start with three corners on one line (phone test: holes in the ground)
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < L.length; k++) { const p = L[k], q = L[(k + 1) % L.length]; nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]); }
      const l = Math.hypot(nx, ny, nz); if (l < 1e-9) return;
      nx /= l; ny /= l; nz /= l; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      // hillshade in 6 % steps (like the sprite shading); slopes towards the light at most 15 % brighter, away at most 30 % darker
      // hill shading per corner from a smooth terrain normal (phone test: per-triangle steps showed the terrain grid as light and dark
      // triangles across roads and meadows); shared corners get the same value, so the shading runs on without edges
      const shade = v => { if (this.noShade) return [1, 0, 1, 0];
        const d = S * .5, gx = sH(v[0] + d, v[2]) - sH(v[0] - d, v[2]), gz = sH(v[0], v[2] + d) - sH(v[0], v[2] - d), l2 = Math.hypot(gx, 2 * d, gz);
        const mx = -gx / l2, my = 2 * d / l2, mz = -gz / l2, lit = mx * SUN_L[0] + my * SUN_L[1] + mz * SUN_L[2] - SUN_L[1];
        return [Math.max(0.7, Math.min(1.15, 1 + lit * 2.6)), mx, my, mz]; };
      const SH = L.map(shade);
      for (let k = 1; k + 1 < L.length; k++) {
        np.push(...L[0], ...L[k], ...L[k + 1]); gf.push(1);
        if (poly[0][1] > -.05) { const ux = L[k][0] - L[0][0], uy = L[k][1] - L[0][1], uz = L[k][2] - L[0][2], vx = L[k + 1][0] - L[0][0], vy = L[k + 1][1] - L[0][1], vz = L[k + 1][2] - L[0][2];
          if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1) dt.push(gf.length - 1); } /* detail: small piece of an upper layer (never the base meadow: no holes when far blocks leave it out) */
        for (const m of [0, k, k + 1]) { const q = SH[m]; if (this.noShade) nn.push(nx, ny, nz); else nn.push(q[1], q[2], q[3]); { const s = col[2] > .005 && col[2] < .016 ? 1 : q[0]; nc.push(col[0] * s, col[1] * s, col[2] * s); } } /* Runde 220: field code colours stay exact */
      }
    };
    /* Runde 42: join the flat pieces of one layer and colour per flat cell (the cuts along the terrain grid, the shore and the height
       raster leave many slivers: half of all ground triangles were smaller than 0.5 m^2). Inner edges cancel, the outline is traced,
       points on straight lines dropped, then triangulated again. Heights stay exact: inside one cell the ground is one plane. */
    const MG = MERGE && !this.noShade && !this.elev ? new Map() : null;
    const mergeLoops = polys => { const E = new Map(), PT = new Map(), K = q => Math.round(q[0] * 1000) + ',' + Math.round(q[1] * 1000);
      for (let p of polys) { let A = 0; for (let k = 0; k < p.length; k++) { const q = p[(k + 1) % p.length]; A += p[k][0] * q[1] - q[0] * p[k][1]; } if (A < 0) p = p.slice().reverse();
        for (let k = 0; k < p.length; k++) { const a = K(p[k]), b = K(p[(k + 1) % p.length]); if (a === b) continue; PT.set(a, p[k]); PT.set(b, p[(k + 1) % p.length]);
          const r = b + '|' + a, f = a + '|' + b; if (E.has(r)) E.delete(r); else if (E.has(f)) return null; else E.set(f, [a, b]); } }
      const out = new Map(); for (const [a, b] of E.values()) { if (out.has(a)) return null; out.set(a, b); }
      const loops = []; let guard = 0;
      while (out.size) { const st = out.keys().next().value; const lp = []; let cur = st;
        do { lp.push(PT.get(cur)); const nx = out.get(cur); out.delete(cur); if (nx === undefined || ++guard > 100000) return null; cur = nx; } while (cur !== st);
        let A = 0; for (let k = 0; k < lp.length; k++) { const q = lp[(k + 1) % lp.length]; A += lp[k][0] * q[1] - q[0] * lp[k][1]; } if (A <= 0) return null; // a hole: keep the pieces
        for (let k = 0; k < lp.length && lp.length > 3;) { const p = lp[(k + lp.length - 1) % lp.length], q = lp[k], r = lp[(k + 1) % lp.length], cr = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]), dt2 = (q[0] - p[0]) * (r[0] - q[0]) + (q[1] - p[1]) * (r[1] - q[1]);
          if (Math.abs(cr) < 2e-5 && dt2 > 0) lp.splice(k, 1); else k++; }
        loops.push(lp); }
      return loops; };
    const putTri = (a, b, c, g) => { // one triangle of a joined group: exact height, smooth hill shade, facing up
      let A = [a[0], g.y + tHz(a[0], a[1]) - g.sink, a[1]], B = [b[0], g.y + tHz(b[0], b[1]) - g.sink, b[1]], Cc = [c[0], g.y + tHz(c[0], c[1]) - g.sink, c[1]];
      if ((B[2] - A[2]) * (Cc[0] - A[0]) - (B[0] - A[0]) * (Cc[2] - A[2]) < 0) { const t = B; B = Cc; Cc = t; }
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = Cc[0] - A[0], vy = Cc[1] - A[1], vz = Cc[2] - A[2], cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, cl = Math.hypot(cx, cy, cz); if (cl < 1e-9) return;
      np.push(...A, ...B, ...Cc); gf.push(1); if (g.y > -.05 && cl < 1) dt.push(gf.length - 1);
      for (const v of [A, B, Cc]) { const d = S * .5, gx = sH(v[0] + d, v[2]) - sH(v[0] - d, v[2]), gz = sH(v[0], v[2] + d) - sH(v[0], v[2] - d), l2 = Math.hypot(gx, 2 * d, gz);
        const mx = -gx / l2, my = 2 * d / l2, mz = -gz / l2, lit = mx * SUN_L[0] + my * SUN_L[1] + mz * SUN_L[2] - SUN_L[1], q = Math.max(0.7, Math.min(1.15, 1 + lit * 2.6));
        nn.push(mx, my, mz); { const s = g.col[2] > .005 && g.col[2] < .016 ? 1 : q; nc.push(g.col[0] * s, g.col[1] * s, g.col[2] * s); } } };
    for (let i = 0; i < P.length; i += 9) {
      const a = [P[i], P[i + 1], P[i + 2]], b = [P[i + 3], P[i + 4], P[i + 5]], c = [P[i + 6], P[i + 7], P[i + 8]], col = [C[i], C[i + 1], C[i + 2]];
      if (N[i + 1] > 0.9 && a[1] < 0.25 && b[1] < 0.25 && c[1] < 0.25) { // ground layer: cut along the terrain grid
        const ci0 = Math.floor(Math.min(a[0], b[0], c[0]) / S), ci1 = Math.floor(Math.max(a[0], b[0], c[0]) / S);
        const cj0 = Math.floor(Math.min(a[2], b[2], c[2]) / S), cj1 = Math.floor(Math.max(a[2], b[2], c[2]) / S);
        for (let ci = ci0; ci <= ci1; ci++) for (let cj = cj0; cj <= cj1; cj++) {
          const gx = ci * S, gz = cj * S;
          let cell = clip(clip(clip(clip([a, b, c], 1, 0, -gx), -1, 0, gx + S), 0, 1, -gz), 0, -1, gz + S); if (cell.length < 3) continue;
          const lvT = LV && CORR ? LV.get(i / 9) : undefined, lv0 = lvT === undefined ? -1 : lvT;
          emit(clip(cell, -1, -1, gx + gz + S), col, 0, 0, 0, lv0); // lower-left half of the cell
          emit(clip(cell, 1, 1, -(gx + gz + S)), col, 0, 0, 0, lv0); // upper-right half
        }
      } else { // objects (poles, crowns, boxes): each vertex lifted by the terrain at its own x/z (corners shared by faces stay together)
        const lvO = LV && CORR ? LV.get(i / 9) : undefined;
        for (const v of [a, b, c]) np.push(v[0], v[1] + (lvO !== undefined && lvO >= 0 ? lvH(lvO, v[0], v[2]) : tHz(v[0], v[2])) - (DL.length ? dipAtList(DL, v[0], v[2]) : 0) + (this.elev ? this.elev(v[0], v[2]) : 0), v[2]); gf.push(0);
        { const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]; if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1) dt.push(gf.length - 1); } /* small object faces */
        for (let k = 0; k < 3; k++) { nn.push(N[i + k * 3], N[i + k * 3 + 1], N[i + k * 3 + 2]); nc.push(col[0], col[1], col[2]); }
      }
    }
    if (MG) { /* Runde 42, hidden layers: a layer that covers its whole cell (one outline = exactly the cell triangle) hides every lower
         layer in that cell - meadow under a residential area, area under the road. Exact test, so no holes can open. */
      const cover = new Map();
      for (const g of MG.values()) { g.loops = g.polys.length > 1 ? mergeLoops(g.polys) : g.polys.length === 1 ? [g.polys[0]] : null; if (g.sink) continue;
        const L = g.loops; if (!L || L.length !== 1 || L[0].length !== 3) continue; const c = g.cell[0] === 'd' ? DZC : S, t = L[0];
        if (Math.abs(Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0])) / 2 - c * c / 2) > 1e-3) continue;
        if (!(cover.get(g.cell) >= g.y)) cover.set(g.cell, g.y); }
      for (const [k, g] of MG) if (!g.sink && (cover.get(g.cell) > g.y + 1e-6 || (g.par && cover.get(g.par) > g.y + 1e-6))) MG.delete(k);
      for (const g of MG.values()) { const loops = g.polys.length > 1 ? g.loops : null;
        if (!loops) { for (const p of g.polys) for (let k = 1; k + 1 < p.length; k++) putTri(p[0], p[k], p[k + 1], g); continue; }
        const tris = [], ar = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2; let A0 = 0, A1 = 0;
        for (const p of g.polys) for (let k = 1; k + 1 < p.length; k++) A0 += ar(p[0], p[k], p[k + 1]);
        for (const lp of loops) { const fl = []; for (const q of lp) fl.push(q[0], q[1]); const ix = lp.length === 3 ? [0, 1, 2] : earcut(fl, null, 2);
          for (let k = 0; k < ix.length; k += 3) { const t = [lp[ix[k]], lp[ix[k + 1]], lp[ix[k + 2]]]; tris.push(t); A1 += ar(t[0], t[1], t[2]); } }
        if (Math.abs(A1 - A0) > 1e-3 + A0 * 1e-4) { for (const p of g.polys) for (let k = 1; k + 1 < p.length; k++) putTri(p[0], p[k], p[k + 1], g); continue; } // triangulation lost area: keep the pieces
        for (const t of tris) putTri(t[0], t[1], t[2], g); } }
    // low retaining edges along level streets: from the street edge down/up to the terrain beside it (both faces, no culling gaps)
    if (this.walls && CORR) { const S = CORR.segs, ED = [.5, .46, .4], BX0 = x0, BX1 = x1, BZ0 = z0, BZ1 = z1;
      for (let i = 0; i < S.length; i += 6) { const x0 = S[i], z0 = S[i + 1], ex = S[i + 2] - x0, ez = S[i + 3] - z0, L = Math.hypot(ex, ez); if (L < .5) continue; const nx = -ez / L, nz = ex / L, a = S[i + 4];
        for (const sd of [-1, 1]) for (let u = 0; u < L - .01; u += 5) { const u2 = Math.min(L, u + 5), ax = x0 + ex * u / L + nx * a * sd, az = z0 + ez * u / L + nz * a * sd, bx = x0 + ex * u2 / L + nx * a * sd, bz = z0 + ez * u2 / L + nz * a * sd, mx = (ax + bx) / 2, mz = (az + bz) / 2;
          if (mx < BX0 || mx > BX1 || mz < BZ0 || mz > BZ1) continue;
          // the edge reaches down/up to whatever lies beside: another level street (junction) or the terrain - no gap to the sky
          const oth = (px, pz) => { const o = corrAt(px + nx * .3 * sd, pz + nz * .3 * sd, i); return o >= 0 ? lvH(o, px, pz) : tH(px, pz); };
          const la = lvH(i, ax, az), lb = lvH(i, bx, bz), ta = oth(ax, az), tb = oth(bx, bz); if (Math.max(Math.abs(la - ta), Math.abs(lb - tb)) < .1) continue;
          const q = [[ax, la + .03, az], [bx, lb + .03, bz], [bx, tb - .05, bz], [ax, ta - .05, az]];
          // one face, turned to where it can be seen: a cut (terrain above the street) faces the street, a fill (street above) faces outwards
          const out = (la + lb) > (ta + tb), fx = out ? nx * sd : -nx * sd, fz = out ? nz * sd : -nz * sd;
          if (out && Math.min(la - ta, lb - tb) > 1) { // street more than 1 m above the slope: a railing on the valley side (Stuttgart Neue Weinsteige)
            const RL = [.3, .32, .34], rail = (y0, y1, x0r, z0r, x1r, z1r) => { const v = [[x0r, y0, z0r], [x1r, y0, z1r], [x1r, y1, z1r], [x0r, y1, z0r]];
              for (const tri of [[0, 1, 2], [0, 2, 3], [0, 2, 1], [0, 3, 2]]) { np.push(...v[tri[0]], ...v[tri[1]], ...v[tri[2]]); gf.push(0); for (let k = 0; k < 3; k++) { nn.push(fx, 0, fz); nc.push(RL[0], RL[1], RL[2]); } } };
            const ix = -nx * sd * .15, iz = -nz * sd * .15; // 15 cm inside the edge
            rail(la + .85, la + .97, ax + ix, az + iz, bx + ix, bz + iz);
            for (const t of [0, .5]) { const px = ax + (bx - ax) * t + ix, pz = az + (bz - az) * t + iz, ph = la + (lb - la) * t, ex2 = (bx - ax) / Math.hypot(bx - ax, bz - az) * .05, ez2 = (bz - az) / Math.hypot(bx - ax, bz - az) * .05;
              rail(ph, ph + .9, px - ex2, pz - ez2, px + ex2, pz + ez2); } }
          const P1 = q[0], P2 = q[1], P3 = q[2], cr = ((P2[1] - P1[1]) * (P3[2] - P1[2]) - (P2[2] - P1[2]) * (P3[1] - P1[1])) * fx + ((P2[2] - P1[2]) * (P3[0] - P1[0]) - (P2[0] - P1[0]) * (P3[2] - P1[2])) * fz;
          for (const tri of cr > 0 ? [[0, 1, 2], [0, 2, 3]] : [[0, 2, 1], [0, 3, 2]]) { np.push(...q[tri[0]], ...q[tri[1]], ...q[tri[2]]); gf.push(0); for (let k = 0; k < 3; k++) { nn.push(fx, 0, fz); nc.push(ED[0], ED[1], ED[2]); } } } } }
    // end caps: where a levelled stretch ends (no levelled segment continues at that end), a wall across the corridor from the street
    // height to the terrain - else the step stayed open and the sky showed through (Heidelberg)
    if (this.walls && CORR) { const S = CORR.segs, ED = [.5, .46, .4], ends = new Map(), ek = (x, z) => Math.round(x * 10) + ',' + Math.round(z * 10);
      for (let i = 0; i < S.length; i += 6) if (S[i + 5] >= .02) for (const e of [0, 2]) { const k = ek(S[i + e], S[i + e + 1]); ends.set(k, (ends.get(k) || 0) + 1); }
      for (let i = 0; i < S.length; i += 6) { if (S[i + 5] < .02) continue; const ex = S[i + 2] - S[i], ez = S[i + 3] - S[i + 1], L = Math.hypot(ex, ez); if (L < .1) continue; const nx = -ez / L, nz = ex / L, a = S[i + 4];
        for (const e of [0, 2]) { const cx = S[i + e], cz = S[i + e + 1]; if (ends.get(ek(cx, cz)) > 1 || cx < x0 || cx > x1 || cz < z0 || cz > z1) continue;
          const pts = []; for (let t = -a; t <= a + 1e-6; t += a / 2) pts.push([cx + nx * t, cz + nz * t]);
          const fx = e ? ex / L : -ex / L, fz = e ? ez / L : -ez / L;
          for (let q = 0; q + 1 < pts.length; q++) { const [ax, az] = pts[q], [bx, bz] = pts[q + 1], la = lvH(i, ax, az), lb = lvH(i, bx, bz), ta = tH(ax, az), tb = tH(bx, bz); if (Math.max(Math.abs(la - ta), Math.abs(lb - tb)) < .1) continue;
            const v = [[ax, la + .03, az], [bx, lb + .03, bz], [bx, tb - .05, bz], [ax, ta - .05, az]];
            for (const tri of [[0, 1, 2], [0, 2, 3], [0, 2, 1], [0, 3, 2]]) { np.push(...v[tri[0]], ...v[tri[1]], ...v[tri[2]]); gf.push(0); for (let k = 0; k < 3; k++) { nn.push(fx, 0, fz); nc.push(ED[0], ED[1], ED[2]); } } } } } }
    // retaining walls along both edges of every trough (only the stretches whose middle lies on this tile)
    if (this.walls) for (const d of DL) { const WALL = [.47, .42, .36], e = d.F + d.R;
      for (const sd of [-1, 1]) for (let s = -e; s < e - .01; s += 4) { const s2 = Math.min(e, s + 4), ox = -d.uz * d.hw * sd, oz = d.ux * d.hw * sd;
        const ax = d.x + d.ux * s + ox, az = d.z + d.uz * s + oz, bx = d.x + d.ux * s2 + ox, bz = d.z + d.uz * s2 + oz, mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (mx < x0 || mx > x1 || mz < z0 || mz > z1) continue;
        const ta = tHz(ax, az), tb = tHz(bx, bz), da = dipProfile(d, s), db = dipProfile(d, s2); if (da < .05 && db < .05) continue;
        { const ox2 = -d.uz * .6 * sd, oz2 = d.ux * .6 * sd, mxo = (ax + bx) / 2 + ox2, mzo = (az + bz) / 2 + oz2; let other = 0; for (const e2 of DL) if (e2 !== d) other = Math.max(other, dipAtList([e2], mxo, mzo)); if (other > Math.min(da, db) - .3) continue; } // beside it another trough as deep: one wide cutting (parallel tracks), no wall in between
        const q = [[ax, ta - da, az], [bx, tb - db, bz], [bx, tb + .25, bz], [ax, ta + .25, az]], hx = -ox, hz = -oz; // faces into the trough
        for (const [i0, i1, i2] of (sd > 0 ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]])) { /* winding so the face looks into the trough on both sides (one side was culled: sky showed through) */ const P1 = q[i0], P2 = q[i1], P3 = q[i2]; np.push(...P1, ...P2, ...P3); gf.push(0); const l = Math.hypot(hx, hz) || 1; for (let k = 0; k < 3; k++) { nn.push(hx / l, 0, hz / l); nc.push(WALL[0], WALL[1], WALL[2]); } } } }
    this.p = np; this.n = nn; this.c = nc; this.gf = gf; this.dt = dt;
  }
  // test variant: ground triangles share corners (same position and colour -> one vertex, normals averaged = soft slopes);
  // objects keep their own corners so poles and benches stay crisp. Returns indexed arrays.
  outWelded() {
    const P = this.p, N = this.n, C = this.c, nt = P.length / 9, gf = this.gf;
    const map = new Map(), pos = [], nor = [], col = [], idx = [];
    for (let t = 0; t < nt; t++) {
      const i = t * 9, ground = gf ? gf[t] === 1 : (N[i + 1] > 0.9 && P[i + 1] < 0.3 && P[i + 4] < 0.3 && P[i + 7] < 0.3);
      for (let k = 0; k < 3; k++) {
        const o = i + k * 3, key = Math.round(P[o] * 100) + ',' + Math.round(P[o + 1] * 100) + ',' + Math.round(P[o + 2] * 100) + ',' + Math.round(C[o] * 255) + ',' + Math.round(C[o + 1] * 255) + ',' + Math.round(C[o + 2] * 255) + (ground ? '' : ',' + t);
        let v = map.get(key);
        if (v === undefined) { v = pos.length / 3; map.set(key, v); pos.push(P[o], P[o + 1], P[o + 2]); nor.push(0, 0, 0); col.push(C[o], C[o + 1], C[o + 2]); }
        nor[v * 3] += N[o]; nor[v * 3 + 1] += N[o + 1]; nor[v * 3 + 2] += N[o + 2]; idx.push(v);
      }
    }
    for (let v = 0; v < nor.length; v += 3) { const l = Math.hypot(nor[v], nor[v + 1], nor[v + 2]) || 1; nor[v] /= l; nor[v + 1] /= l; nor[v + 2] /= l; }
    return { pos: new Float32Array(pos), nor: new Float32Array(nor), col: new Float32Array(col), idx: new Uint32Array(idx) };
  }
}

/* ------------------------------------------------------------ MVT decoding */
function Pbf(buf) { this.b = new Uint8Array(buf); this.p = 0; }
Pbf.prototype.v = function () { let r = 0, m = 1, b; do { b = this.b[this.p++]; r += (b & 127) * m; m *= 128; } while (b >= 128); return r; };
Pbf.prototype.skip = function (w) { if (w === 0) this.v(); else if (w === 1) this.p += 8; else if (w === 2) { const l = this.v(); this.p += l; } else if (w === 5) this.p += 4; };
const td = new TextDecoder();
function decodeMVT(buf) {
  const pb = new Pbf(buf), layers = {};
  while (pb.p < pb.b.length) {
    const tag = pb.v(), f = tag >> 3, w = tag & 7;
    if (f === 3 && w === 2) { const len = pb.v(), end = pb.p + len; const L = readLayer(pb, end); layers[L.name] = L; pb.p = end; }
    else pb.skip(w);
  }
  return layers;
}
function readLayer(pb, end) {
  const L = { name: '', keys: [], vals: [], feats: [], extent: 4096 };
  while (pb.p < end) {
    const tag = pb.v(), f = tag >> 3, w = tag & 7;
    if (f === 1) { const l = pb.v(); L.name = td.decode(pb.b.subarray(pb.p, pb.p + l)); pb.p += l; }
    else if (f === 2) { const l = pb.v(); L.feats.push([pb.p, pb.p + l]); pb.p += l; }
    else if (f === 3) { const l = pb.v(); L.keys.push(td.decode(pb.b.subarray(pb.p, pb.p + l))); pb.p += l; }
    else if (f === 4) { const l = pb.v(), e = pb.p + l; let val = null;
      while (pb.p < e) { const t2 = pb.v(), f2 = t2 >> 3, w2 = t2 & 7;
        if (f2 === 1) { const l2 = pb.v(); val = td.decode(pb.b.subarray(pb.p, pb.p + l2)); pb.p += l2; }
        else if (f2 === 2) { val = new DataView(pb.b.buffer, pb.b.byteOffset + pb.p, 4).getFloat32(0, true); pb.p += 4; }
        else if (f2 === 3) { val = new DataView(pb.b.buffer, pb.b.byteOffset + pb.p, 8).getFloat64(0, true); pb.p += 8; }
        else if (f2 === 4 || f2 === 5) val = pb.v();
        else if (f2 === 6) { const n = pb.v(); val = (n % 2) ? -(n + 1) / 2 : n / 2; }
        else if (f2 === 7) val = !!pb.v();
        else pb.skip(w2); }
      L.vals.push(val); }
    else if (f === 5) L.extent = pb.v();
    else pb.skip(w);
  }
  L.pb = pb;
  return L;
}
function readFeature(L, rng) {
  const pb = L.pb; pb.p = rng[0]; const ft = { props: {}, type: 0, geom: null };
  while (pb.p < rng[1]) {
    const tag = pb.v(), f = tag >> 3, w = tag & 7;
    if (f === 2) { const l = pb.v(), e = pb.p + l; while (pb.p < e) { const k = pb.v(), v = pb.v(); ft.props[L.keys[k]] = L.vals[v]; } }
    else if (f === 3) ft.type = pb.v();
    else if (f === 4) { const l = pb.v(), e = pb.p + l, g = []; while (pb.p < e) g.push(pb.v()); ft.geom = g; }
    else pb.skip(w);
  }
  return ft;
}
/* geometry -> rings/lines of local coords; returns array of Float64Array [x,z,...] */
function geomLines(ft, toL) {
  if (ft._clip) return ft._clip; // Runde 165: medieval streets cut to the pieces that serve a settlement
  const g = ft.geom, out = []; let x = 0, y = 0, cur = null, i = 0;
  while (i < g.length) {
    const ci = g[i++], cmd = ci & 7, cnt = ci >> 3;
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < cnt; k++) {
        const dx = g[i++], dy = g[i++]; x += (dx >> 1) ^ (-(dx & 1)); y += (dy >> 1) ^ (-(dy & 1));
        if (cmd === 1) { if (cur && cur.length >= 4) out.push(cur); cur = []; }
        const p = toL(x, y); cur.push(p[0], p[1]);
      }
    } else if (cmd === 7) { /* close: ring implied */ }
  }
  if (cur && cur.length >= 4) out.push(cur);
  return out;
}
function pointsOf(ft, toL) { // MVT point geometry
  const g = ft.geom, out = []; let x = 0, y = 0, i = 0;
  while (i < g.length) { const ci = g[i++], cmd = ci & 7, cnt = ci >> 3;
    if (cmd === 1) for (let k = 0; k < cnt; k++) { const dx = g[i++], dy = g[i++]; x += (dx >> 1) ^ (-(dx & 1)); y += (dy >> 1) ^ (-(dy & 1)); out.push(toL(x, y)); } else break; }
  return out;
}
function polygons(rings) { // classify by winding (local coords: z is south-positive like tile y)
  const polys = []; let curP = null;
  for (const r of rings) {
    if (r.length < 6) continue;
    const a = ringArea(r);
    if (a > 0) { curP = [r]; polys.push(curP); } else if (curP) curP.push(r);
  }
  return polys;
}

/* ------------------------------------------------------------ LoD2 index */
let l2root = null;
async function lod2Root() {
  if (l2root) return l2root;
  let j = await cget('l2root', 30 * 864e5);
  if (!j) { j = await (await fetchOk(L2BASE + 'lod2_3857_null.json')).json(); j = j.root.children.map(c => c.box); cput('l2root', j); }
  l2root = j; return j;
}
const l2cols = new Map();
function lod2Col(uri) {
  if (!l2cols.has(uri)) l2cols.set(uri, (async () => {
    let v = await cget('l2c:' + uri, 30 * 864e5);
    if (!v) {
      const j = await (await fetchOk(L2BASE + uri)).json(); const rt = j.root, T = rt.transform, G = rt.global_transform || [0, 0, 0];
      v = { ox: T[0] + G[0], oy: T[1] + G[1], oz: (T[2] || 0) + (G[2] || 0), dir: uri.slice(0, uri.lastIndexOf('/') + 1), tiles: rt.children.map(c => c.b) };
      cput('l2c:' + uri, v);
    }
    return v;
  })().catch(e => { l2cols.delete(uri); throw e; }));
  return l2cols.get(uri);
}
async function lod2TilesNear(X, Y, rM) { // rM: radius in mercator metres
  const q = quelleMerc('gebaeude3d', X, Y); if (!q) return []; // no 3D buildings here: footprints + estimated roofs are used
  L2BASE = q.url || L2BASE;
  const root = await lod2Root();
  const cols = root.filter(b => Math.abs(b[0] - X) < b[2] + rM && Y > b[1] - b[3] - rM && Y < b[1] + b[3] + rM)
    .sort((a, b) => Math.abs(a[0] - X) - Math.abs(b[0] - X)).slice(0, 3);
  const out = [];
  for (const b of cols) {
    let col; try { col = await lod2Col(b[5]); } catch (e) { continue; }
    for (const t of col.tiles) {
      const cx = col.ox + t[0], cy = col.oy + t[1];
      if (Math.abs(cx - X) < 500 + rM && Math.abs(cy - Y) < 500 + rM) out.push({ id: t[2], cx, cy, col });
    }
  }
  return out;
}

/* ------------------------------------------------------------ colour sources */
// spatial grid of polygons that carry colours: {p:Float32Array, minx,maxx,minz,maxz, wall, roof, src}
const CELL = 40, cgrid = new Map();
function gkey(ix, iz) { return ix * 100003 + iz; }
function gridAdd(item) {
  for (let ix = Math.floor(item.minx / CELL); ix <= Math.floor(item.maxx / CELL); ix++)
    for (let iz = Math.floor(item.minz / CELL); iz <= Math.floor(item.maxz / CELL); iz++) {
      const k = gkey(ix, iz); let a = cgrid.get(k); if (!a) cgrid.set(k, a = []); a.push(item);
    }
}
function gridRemove(pred) { for (const [k, a] of cgrid) { const b = a.filter(i => !pred(i)); if (b.length) cgrid.set(k, b); else cgrid.delete(k); } }
function colourAt(x, z) {
  const a = cgrid.get(gkey(Math.floor(x / CELL), Math.floor(z / CELL))); if (!a) return null;
  let best = null;
  for (const it of a) {
    if (x < it.minx || x > it.maxx || z < it.minz || z > it.maxz) continue;
    if (!inPoly(x, z, it.p)) continue;
    if (!best || it.src > best.src) best = it; // overpass (src 2) beats vector tile (src 1)
  }
  return best;
}
function nearRing(x, z, p, r) { for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) { const ax = p[j], az = p[j + 1], dx = p[i] - ax, dz = p[i + 1] - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)); if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < r * r) return true; } return false; }
function bbox(p) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let i = 0; i < p.length; i += 2) { if (p[i] < a) a = p[i]; if (p[i] > b) b = p[i]; if (p[i + 1] < c) c = p[i + 1]; if (p[i + 1] > d) d = p[i + 1]; } return { minx: a, maxx: b, minz: c, maxz: d }; }

/* ------------------------------------------------------------ building parts (OSM Simple 3D Buildings) */
const PART_MAT = { 1: '#9a4e3c', 2: '#e6dfcf', 3: '#b9b09c', 4: '#8a6a4a', 5: '#ece4d2', 6: '#5a7fa8', 7: '#b5b2aa', 8: '#8c9096' };
function partBuilding(G, pt, fp) {
  const ring = pt.ring, n = ring.length / 2, sgn = ringArea(ring) > 0 ? 1 : -1, cx = pt.x, cz = pt.z;
  const style = pt.mat === 6 ? 5 : fp && fp.btype ? fp.btype : 0, era = (fp && eraFromYear(fp.year)) || 1;
  const wall = pt.wall ? liftWall(...pt.wall) : pt.mat === 3 ? stoneWall(hashStr('pw' + cx.toFixed(0) + cz.toFixed(0)), cx, cz) /* stone: regional (red sandstone in the south-west) */ : pt.mat && PART_MAT[pt.mat] ? hex(PART_MAT[pt.mat]) : style === 3 ? stoneWall(hashStr('pw' + cx.toFixed(0) + cz.toFixed(0)), cx, cz) : style === 1 || style === 2 ? sacredWall(era, hashStr('pw' + cx.toFixed(0) + cz.toFixed(0)), cx, cz) : hex('#d8d2c4');
  const apex = pt.shape === 5 || pt.shape === 8 || pt.shape === 9 || pt.shape === 10;
  const roof = pt.roof || (apex && (pt.shape === 8 || pt.shape === 9) ? hex('#5f8a76') : apex ? hex('#45484e') : pt.shape > 1 ? hex('#5b5d62') : FLATROOF);
  const rh = pt.shape > 1 ? Math.min(pt.rh || (apex ? Math.min(12, (pt.maxx - pt.minx) * 0.9) : 2.5), pt.h - pt.mh) : 0, top = pt.h - rh, mh = pt.mh;
  const code = era + style * 512 + (pt.h - mh < 2.2 ? 8 : 0); // very low parts: plain walls
  // walls (outward normals as for the fallback houses)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); if (L < 0.01) continue;
    const ox = dz / L * sgn, oz = -dx / L * sgn, ta = ax * -oz + az * ox, tb = bx * -oz + bz * ox;
    if (top - mh > 0.05) G.quad([ax, mh, az], [bx, mh, bz], [bx, top, bz], [ax, top, az], wall, ox, 0, oz, code, Math.min(top, 499) + (rh > 0.5 ? 500 : 0), Math.min(ta, tb), Math.abs(tb - ta), top);
  }
  if (mh > 0.3) G.flat([ring], mh, wall, 0, 0); // underside of parts that start higher up (overhangs, upper tower stages)
  if (!rh) { G.flat([ring], top, roof, 0, 2); return; }
  if (apex) { // pyramid, cone, dome, onion: rings drawn towards the centre
    const prof = pt.shape === 8 ? [[0, 1], [.35, .93], [.62, .75], [.84, .47], [1, 0]] : pt.shape === 9 ? [[0, 1], [.22, 1.16], [.45, 1.04], [.68, .55], [.86, .18], [1, 0]] : [[0, 1], [1, 0]];
    for (let k = 0; k + 1 < prof.length; k++) {
      const [h0, s0] = prof[k], [h1, s1] = prof[k + 1], y0 = top + rh * h0, y1 = top + rh * h1;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n;
        const P0 = [cx + (ring[i * 2] - cx) * s0, y0, cz + (ring[i * 2 + 1] - cz) * s0], P1 = [cx + (ring[j * 2] - cx) * s0, y0, cz + (ring[j * 2 + 1] - cz) * s0];
        const Q0 = [cx + (ring[i * 2] - cx) * s1, y1, cz + (ring[i * 2 + 1] - cz) * s1], Q1 = [cx + (ring[j * 2] - cx) * s1, y1, cz + (ring[j * 2 + 1] - cz) * s1];
        const hx = (P0[0] + P1[0]) / 2 - cx, hz = (P0[2] + P1[2]) / 2 - cz;
        if (s1 > 0.001) G.quad(P0, P1, Q1, Q0, roof, hx, 0.6, hz); else G.tri(P0[0], P0[1], P0[2], P1[0], P1[1], P1[2], Q0[0], Q0[1], Q0[2], roof, hx, 0.6, hz);
      }
    }
    if (pt.shape === 9) G.box(cx, top + rh, cz, .15, Math.max(1, rh * 0.25), .15, hex('#c9a85a')); // little golden tip on onion domes
    return;
  }
  // ridge roofs on the oriented box of the part: gabled/mansard (2, 7), hipped/half-hipped (3, 4), skillion (6)
  const o = obb(ring); if (!o) { G.flat([ring], top, roof, 0, 2); return; }
  const hw = o.w / 2, hd = o.d / 2, P = (u, y, v) => [o.cx + u * o.c - v * o.s, top + y, o.cz + u * o.s + v * o.c];
  const T = (a, b, c, col, f0) => G.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col, (a[0] + b[0] + c[0]) / 3 - o.cx, (a[1] + b[1] + c[1]) / 3 - top - rh * 0.3, (a[2] + b[2] + c[2]) / 3 - o.cz, f0 || 0, f0 ? top : 0, 0, 0);
  const A = P(-hw, 0, hd), B = P(hw, 0, hd), C = P(hw, 0, -hd), D = P(-hw, 0, -hd);
  if (pt.shape === 6) { const A2 = P(-hw, rh, hd), B2 = P(hw, rh, hd);
    T(A2, B2, C, roof); T(A2, C, D, roof); T(A, B, B2, wall, code); T(A, B2, A2, wall, code); T(B, C, B2, wall, code); T(D, A, A2, wall, code); return; }
  const r = pt.shape === 3 || pt.shape === 4 ? Math.max(0, hw - hd) : hw, R1 = P(-r, rh, 0), R2 = P(r, rh, 0);
  T(A, B, R2, roof); T(A, R2, R1, roof); T(C, D, R1, roof); T(C, R1, R2, roof);
  if (r === hw) { T(B, C, R2, wall, code); T(D, A, R1, wall, code); } else { T(B, C, R2, roof); T(D, A, R1, roof); }
}
/* ------------------------------------------------------------ fallback building (no LoD2) */
const HOUSEY = /^(house|detached|semidetached_house|terrace|bungalow|farm|villa|residential|yes|cabin|church|chapel)$/;
function obb(p) {
  let best = null; const n = p.length / 2;
  for (let i = 0; i < n && i < 40; i++) {
    const j = (i + 1) % n, dx = p[j * 2] - p[i * 2], dz = p[j * 2 + 1] - p[i * 2 + 1], L = Math.hypot(dx, dz); if (L < 0.5) continue;
    const c = dx / L, s = dz / L; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < p.length; k += 2) { const u = p[k] * c + p[k + 1] * s, v = -p[k] * s + p[k + 1] * c; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const a = (u1 - u0) * (v1 - v0);
    if (!best || a < best.a) best = { a, c, s, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { c, s } = best, w = best.u1 - best.u0, d = best.v1 - best.v0;
  const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
  const cx = cu * c - cv * s, cz = cu * s + cv * c;
  if (w < d) { const t = w; w = d; d = t; const c2 = -s, s2 = c; c = c2; s = s2; }
  return { cx, cz, w, d, c, s, a: best.a };
}
/* Runde 136 (phone test Bielefeld, Kreuzstrasse: a house hung 16 m above a lawn): OSM building parts may start above the ground
   (min_height) - over a passage, on top of another part, or because the ground under them is higher than the street the height
   was measured from (hillside). In the game the last case floats. Rule: a raised part with nothing under it - no lower part
   reaching up to it, no road, path or railway underneath, and not a bridge between two buildings - is drawn down to the ground
   (and becomes solid like any house). */
function groundFloating(items, roads) { for (const it of items) if (it.minH >= 2) { if (floatFix(it, [items], roads)) gAdd(fpgrid, it); else if (it.minH >= 2.5 && !it.onPart && !it.bridgeP && !it.smallP) it.pillars = pillarsFor(it, roads); } }
/* Runde 204 (Brandenburger Tor: the attic floated above the passages): columns and pillars are often too thin for the map tiles
   (dropped by the tile's simplification), so a raised part over a road or an open arcade stands on nothing. Rule: a raised part
   that stays raised and is not carried by another part, not a bridge between buildings and not an oriel gets pillars from the
   ground to its bottom - rows along both long sides (more rows when it is deep), about every 4.5 m, thicker the higher it is,
   never on a road or path line (passages stay free), only where the part is above open ground. */
function pillarsFor(it, roads) { const o = obb(it.p); if (!o) return null; const H = it.minH, sz = Math.max(.45, Math.min(1.7, .07 * H + .35)), ins = sz / 2 + .3;
  const vs = [-o.d / 2 + ins, o.d / 2 - ins]; if (o.d > 14) for (let v = -o.d / 2 + 7; v < o.d / 2 - 6; v += 7) vs.push(v);
  const n = Math.max(2, Math.round((o.w - 2 * ins) / 4.5) + 1), out = [], segD = (x, z, q) => { let m = Infinity; for (let i = 0; i + 3 < q.length; i += 2) { const ax = q[i], az = q[i + 1], dx = q[i + 2] - ax, dz = q[i + 3] - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); m = Math.min(m, Math.hypot(ax + dx * t - x, az + dz * t - z)); } return m; };
  for (const v of vs) for (let k = 0; k < n; k++) { const u = -o.w / 2 + ins + k * (o.w - 2 * ins) / (n - 1), x = o.cx + u * o.c - v * o.s, z = o.cz + u * o.s + v * o.c;
    if (!inPoly(x, z, it.p) || fpAt(x, z)) continue; let onRoad = false;
    for (const r of roads) { if (r.k === 't' || r.p[0] === undefined) continue; if (segD(x, z, r.p) < 1.4 + sz / 2) { onRoad = true; break; } } if (onRoad) continue;
    out.push([x, z]); if (out.length >= 60) break; }
  return out.length ? { pts: out, sz, c: o.c, s: o.s } : null; }
function floatFix(it, lists, roads) {
  const ov = (a, b) => { for (let i = 0; i < a.p.length; i += 2) if (inPoly(a.p[i], a.p[i + 1], b.p)) return true; for (let i = 0; i < b.p.length; i += 2) if (inPoly(b.p[i], b.p[i + 1], a.p)) return true;
    let cx = 0, cz = 0; for (let i = 0; i < a.p.length; i += 2) { cx += a.p[i]; cz += a.p[i + 1]; } return inPoly(cx / (a.p.length / 2), cz / (a.p.length / 2), b.p); };
  const baseF = o => { if (o.bF === undefined) o.bF = !TERRAIN_ON ? 0 : o.ring ? hAt(o.x, o.z) : baseOf(o.p); return o.bF; }; // parts stand on the terrain at their centre
  // small or narrow raised parts are oriels, battlements, turrets, balconies, bridges: they belong to a wall beside them, not on the ground
  { const A = Math.abs(ringArea(it.p)); let per = 0; for (let i = 0; i < it.p.length; i += 2) { const j = (i + 2) % it.p.length; per += Math.hypot(it.p[j] - it.p[i], it.p[j + 1] - it.p[i + 1]); }
    if (A < 60 || 2 * A / per < 3) { it.smallP = true; return false; } }
  // low raised parts on flat ground are arcades, canopies on columns, halls on stilts: they stay open. Only high ones (8 m and more)
  // or ones on a slope (the ground under them differs by more than 2 m) are taken as standing on ground the terrain smooths away
  if (it.minH < 8) { if (!TERRAIN_ON) return false; let lo = Infinity, hi = -Infinity; for (let i = 0; i < it.p.length; i += 2) { const h = hAt(it.p[i], it.p[i + 1]); if (h < lo) lo = h; if (h > hi) hi = h; } if (hi - lo < 2) return false; }
  const bottom = baseF(it) + it.minH; let sup = false, near = 0;
  for (const l of lists) { for (const o of l) { if (o === it || !o.p || o.maxx < it.minx - 1 || o.minx > it.maxx + 1 || o.maxz < it.minz - 1 || o.minz > it.maxz + 1) continue; const om = o.minH0 !== undefined ? o.minH0 : o.minH || 0; // the mapped bottom, also after this rule drew it down
    if (om < it.minH && baseF(o) + o.h >= bottom - 1.5 && ov(it, o)) { sup = true; it.onPart = true; break; }
    if (baseF(o) + o.h >= bottom) near++; } if (sup) break; }
  if (!sup && near >= 2) { let per = 0; for (let i = 0; i < it.p.length; i += 2) { const j = (i + 2) % it.p.length; per += Math.hypot(it.p[j] - it.p[i], it.p[j + 1] - it.p[i + 1]); }
    if (2 * Math.abs(ringArea(it.p)) / per < 5) { sup = true; it.bridgeP = true; } } // a narrow bridge between two buildings (about under 5-6 m wide)
  if (!sup) for (const r of roads) { const q = r.p; if (r.k === 't') continue;
    for (let i = 0; i + 1 < q.length && !sup; i += 2) for (const u of [0, .5]) { const j = Math.min(q.length - 2, i + 2), x = q[i] + (q[j] - q[i]) * u, z = q[i + 1] + (q[j + 1] - q[i + 1]) * u;
      if (x >= it.minx && x <= it.maxx && z >= it.minz && z <= it.maxz && inPoly(x, z, it.p)) { sup = true; break; } }
    if (sup) break; }
  if (sup) return false;
  it.minH0 = it.minH; it.minH = 0; if (it.mh !== undefined) it.mh = 0; it.grounded = true;
  if (it.ring && TERRAIN_ON) { const lo = baseOf(it.p), c = hAt(it.x, it.z); if (c > lo) { it.h += c - lo; it.lift = lo; } } // a part: from the lowest ground under it, top unchanged
  return true;
}
function fallbackBuilding(G, poly, H, minH, wall, roof, seed, type, code, own) {
  const outer = poly[0], area = Math.abs(ringArea(outer));
  if (area < 6) return;
  for (let r = 0; r < poly.length; r++) {
    const p = poly[r], sgn = ringArea(p) > 0 ? 1 : -1;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length, ax = p[i], az = p[i + 1], bx = p[j], bz = p[j + 1], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); if (L < 0.01) continue;
      // outward normal of the ring itself: (dz, -dx) for positive area; for holes we flip it below
      let ox = dz / L * sgn, oz = -dx / L * sgn; if (r) { ox = -ox; oz = -oz; }
      const nb = fpAt((ax + bx) / 2 + ox * 0.8, (az + bz) / 2 + oz * 0.8, own); // neighbour right behind this wall?
      const util = own && (own.util || (H < 4.5 && area < 60)); // sheds, garages: no windows
      const c = code + ((nb && nb.h > 3) || util ? 8 : 0) + (facesStreet((ax + bx) / 2, (az + bz) / 2, ox, oz) ? 256 : 0);
      const ta = ax * -oz + az * ox, tb = bx * -oz + bz * ox; // position along the wall, same axis as in the shader
      G.quad([ax, minH, az], [bx, minH, bz], [bx, H, bz], [ax, H, az], wall, ox, 0, oz, c, H + ((own && own.levels) || 0) * 1000, Math.min(ta, tb), Math.abs(tb - ta), H);
    }
  }
  let pitched = false;
  if (H - minH < 14 && area < 450 && HOUSEY.test(type)) {
    const o = obb(outer);
    if (o && area / o.a > 0.8 && o.d > 3) {
      pitched = true;
      const rh = Math.min(7, Math.max(1.6, o.d * 0.42)), hw = o.w / 2 + 0.35, hd = o.d / 2 + 0.35;
      const P = (u, y, v) => [o.cx + u * o.c - v * o.s, H + y, o.cz + u * o.s + v * o.c];
      const r = seed < 0.7 ? hw : Math.max(0, hw - hd);
      const A = P(-hw, 0, hd), B = P(hw, 0, hd), C = P(hw, 0, -hd), D = P(-hw, 0, -hd), R1 = P(-r, rh, 0), R2 = P(r, rh, 0);
      const cy = H + rh * 0.3, T = (a, b, c, col, f0) => G.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col, (a[0] + b[0] + c[0]) / 3 - o.cx, (a[1] + b[1] + c[1]) / 3 - cy, (a[2] + b[2] + c[2]) / 3 - o.cz, f0 || 0, f0 ? H : 0, 0, 0);
      T(A, B, R2, roof); T(A, R2, R1, roof); T(C, D, R1, roof); T(C, R1, R2, roof);
      if (r === hw) { T(B, C, R2, wall, code); T(D, A, R1, wall, code); } else { T(B, C, R2, roof); T(D, A, R1, roof); }
    }
  }
  const fg = pitched ? null : flatGuess((code || 0) % 8, (code || 0) % 16 >= 8, seed);
  G.flat(poly, H, pitched ? roof : fg ? fg[0] : FLATROOF, 0, pitched ? 0 : fg ? fg[1] : 2);
}

/* ------------------------------------------------------------ vector tile -> geometry */
const TRAMBED = hex('#55575c'), TRAMRAIL = hex('#a7abb1');
const ROAD = { motorway: [12, '#4a4d52', .1], trunk: [10, '#4a4d52', .1], primary: [9, '#4c4f54', .09], secondary: [8, '#4e5156', .085], tertiary: [7, '#505358', .08],
  minor: [6, '#54575b', .07], service: [3.6, '#5c5e61', .06], track: [3, '#8a7a5c', .05], path: [2, '#c4b496', .045], raceway: [8, '#4e5156', .08], busway: [6, '#54575b', .07],
  rail: [1.6, '#5f5952', .046], transit: [1.4, '#5f5952', .046], bridleway: [2, '#b8a888', .045] };
const WL = () => TERRAIN_ON ? 1.2 : 0; // water surface this far below the land: quay walls and banks show (needs the terrain meadow, which is cut out over water)
const WCOL = { river: hex('#58808a'), canal: hex('#58808a'), lake: hex('#4f80a2'), ocean: hex('#3f7ba8'), sea: hex('#3f7ba8'), bay: hex('#3f7ba8'), dock: hex('#4b6d80'), pond: hex('#5b8a84'), stream: hex('#5f8c86'), ditch: hex('#66907f'), drain: hex('#66907f'), swimming_pool: hex('#5fb6cf'), basin: hex('#5b8a84'), reservoir: hex('#4f80a2') };
const PONTOON = hex('#8d9094'), QUAY = hex('#8e8a80'), PLANK = hex('#8a6a4a'), PEDESTRIAN = hex('#b9b2a6'), WATER = hex('#4f7f9c'), MARK = hex('#e3dccb');
const FLOOR = hex('#c2a982'), PAVED_LAND = hex('#a39e8e'); // industry, rail yards: grey; everything unmapped is meadow (see app.js ground)
const SIDEWALK = hex('#b8b1a3'), CURB = hex('#8d8a84'), POLE = hex('#34363a'), LAMP = [1, 1, 1];
// tree density per m² (satellite checks: parks, gardens and forests were far too bare)
const AREA = { wood: ['#4f6e3a', .014, 1 / 95], forest: ['#4f6e3a', .014, 1 / 95], grass: ['#7a9a52', .01, 0], meadow: ['#86a05a', .01, 0], park: ['#76985a', .012, 1 / 280],
  farmland: ['#a7a46b', .006, 0], wetland: ['#6f8a6a', .008, 0], scrub: ['#6a7a44', .011, 1 / 500], sand: ['#d8c99a', .009, 0], cemetery: ['#6f8a58', .012, 1 / 500],
  pitch: ['#5f9a5a', .016, 0], playground: ['#c9b07a', .016, 0], garden: ['#73975a', .012, 1 / 300], allotments: ['#86985a', .011, 1 / 250], stadium: ['#6b8a5a', .012, 0],
  village_green: ['#7a9a52', .01, 0], recreation_ground: ['#7a9a52', .01, 0], residential: ['#8f9e6c', .004, 1 / 380], nature_reserve: ['#5f7e45', .009, 1 / 250], heath: ['#8a8a5a', .008, 0], grassland: ['#86a05a', .009, 0],
  railway: ['#a39e8e', .004, 0], school: ['#a3a488', .004, 1 / 600], hospital: ['#a3a488', .004, 1 / 600], university: ['#a3a488', .004, 1 / 600], kindergarten: ['#a3a488', .004, 1 / 600], college: ['#a3a488', .004, 1 / 600] };
const CONIFER = ['#2f4a30', '#34502f', '#2a4430', '#3a5634'].map(hex), CANOPY = hex('#4a6638'), LEAF = ['#5f7a3a', '#4a6b3a', '#6f8a4a', '#3f5b3a', '#7a8a42'].map(hex), TRUNK = hex('#5a4030');

function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* Runde 93: world switch (Heute / Western / Cyberpunk / Mittelalter). Same OSM map, other rules: streets are filtered and
   recoloured, buildings are replaced by a few models from Blender (demo/welten/*.glb, placed by the app), trees become cacti.
   General rules only (POI class, distance to the street, spacing, building blocks), so it works everywhere. */
let WELT = 'heute', WOUT = null;
function weltRoad(cls, sub, spec) {
  if (WELT === 'heute') return spec;
  const ped = cls === 'path' && (sub === 'pedestrian' || sub === 'living_street');
  if (WELT === 'west') { if (/^(motorway|trunk|service|transit|busway|raceway|bridleway)$/.test(cls) || (cls === 'path' && !ped)) return null;
    if (cls === 'rail') return spec; return [Math.max(6, spec[0]), cls === 'track' ? '#c4955f' : '#b98a58', spec[2]]; }
  if (WELT === 'mittel') { if (/^(motorway|trunk|rail|transit|busway|raceway)$/.test(cls) || (cls === 'path' && /cycle/.test(sub || ''))) return null;
    if (cls === 'path') return [ped ? 5 : 2.6, ped ? '#8f8577' : '#9a8466', spec[2]];
    if (cls === 'track' || cls === 'service') return [Math.min(spec[0], 4), '#a88d64', spec[2]];
    return [Math.min(spec[0], 7), '#8f8577', spec[2]]; }
  if (WELT === 'cyber') { if (/^(track|service|bridleway)$/.test(cls) || (cls === 'path' && !ped)) return null;
    if (cls === 'rail' || cls === 'transit') return spec; return [spec[0], ped ? '#262638' : '#1c1c28', spec[2]]; }
  return spec;
}
function weltArea(c, dens) { return WELT === 'west' ? (dens > 1 / 300 ? '#cfa56a' : '#d8ad74') : WELT === 'cyber' ? (dens > 1 / 300 ? '#171724' : '#12121a') : c; }
function weltBase(x, z) { return TERRAIN_ON ? dzLift(x, z, hAt(x, z)) : 0; }
const W_WEST = { pub: 'SALOON', bar: 'SALOON', restaurant: 'SALOON', biergarten: 'SALOON', nightclub: 'SALOON', fast_food: 'CHUCK WAGON', bank: 'BANK', police: 'SHERIFF', townhall: 'SHERIFF',
  hotel: 'HOTEL', guest_house: 'HOTEL', pharmacy: 'DOC', doctors: 'DOC', dentist: 'DOC', cafe: 'COFFEE', bakery: 'BAKERY', hairdresser: 'BARBER', clothes: 'GENERAL STORE', shoes: 'BOOTS',
  jewelry: 'ASSAY OFFICE', theatre: 'OPERA', cinema: 'OPERA', books: 'GAZETTE', post_office: 'TELEGRAPH', weapons: 'GUNSMITH', hardware: 'HARDWARE', supermarket: 'GENERAL STORE', butcher: 'BUTCHER' };
const W_PRIO = { SALOON: 9, BANK: 8, SHERIFF: 8, HOTEL: 7, DOC: 6, 'GENERAL STORE': 6, BARBER: 5, GUNSMITH: 5, TELEGRAPH: 5 };
const W_MITTEL = { restaurant: 'TAVERNE', pub: 'TAVERNE', bar: 'TAVERNE', cafe: 'TAVERNE', biergarten: 'TAVERNE', fast_food: 'GARKÜCHE', wine: 'WEINKELLER', bakery: 'BÄCKER', pastry: 'BÄCKER',
  clothes: 'GEWANDHAUS', tailor: 'SCHNEIDER', shoes: 'SCHUSTER', jewelry: 'GOLDSCHMIED', pharmacy: 'APOTHEKE', hairdresser: 'BADER', beauty: 'BADER', doctors: 'BADER', dentist: 'BADER',
  bank: 'WECHSLER', books: 'SCHREIBER', stationery: 'SCHREIBER', pottery: 'TÖPFER', houseware: 'TÖPFER', weapons: 'SCHMIED', hardware: 'SCHMIED', furniture: 'SCHREINER', butcher: 'METZGER', townhall: 'RATHAUS', hotel: 'HERBERGE' };
const W_CYBER = { restaurant: 'RAMEN', fast_food: 'NUDELN 24/7', cafe: 'KAFFEE', bar: 'BAR', pub: 'BAR', nightclub: 'CLUB', bank: 'KREDIT', pharmacy: 'APOTHEKE', doctors: 'KLINIK',
  hotel: 'KAPSELHOTEL', clothes: 'MODE', mobile_phone: 'IMPLANTATE', electronics: 'CHIPS', optician: 'OPTIK', jewelry: 'CHROM', books: 'DATEN', hairdresser: 'STYLE', bakery: 'SYNTHBROT', supermarket: 'MARKT 24/7' };
const W_POOL = ['NEXUS', 'SYNTH', 'OMNI', 'DATEN', 'ARCADE', 'NEON', 'KAIROS', 'VOLT'], W_GEN = ['STORE', 'FEED & SEED', 'STABLES', 'LAUNDRY', 'SUPPLY', 'SALOON'];
// model sizes (local x = width along the front, z = depth; front faces +z), height for collision
const W_DIM = { w_saloon: [12, 12, 10], w_bank: [11, 11, 10], w_sheriff: [9, 10, 7], w_store: [14, 12, 7], w_hotel: [13, 12, 10], w_laden_a: [10, 10, 7], w_laden_b: [10, 11, 7], w_laden_c: [11, 10, 10],
  w_kapelle: [8, 14, 9], m_haus_a: [8.7, 10.7, 12], m_haus_b: [7.7, 11.7, 14], m_haus_c: [9.7, 10.7, 12], m_haus_d: [8.7, 12.7, 14], m_laden_a: [8.7, 10.7, 12], m_laden_b: [9.7, 11.7, 14],
  m_taverne: [10.7, 12.7, 15], m_rathaus: [14.7, 12.7, 15], c_turm: [19, 19, 110], m_burg: [38, 38, 22], m_windmuehle: [7.4, 7.4, 14], m_wassermuehle: [8.4, 9.6, 12], m_scheune: [10, 14, 9], m_bauernhaus: [8.4, 9.6, 11], m_schloss: [33, 42, 16], m_gutshof: [44, 40, 13], m_kapelle: [7, 15.2, 9], m_remise: [12.4, 6.4, 6], m_orangerie: [26.4, 8.4, 8] };
/* Runde 154: Mittelalter - castles and their towns. One chance per cell of a global grid (3600 mercator metres, ~2.2 km in Germany).
   The castle sits on the highest point of the cell (hills, ridges); its town lies on the nearest plain (gentle slope, low in the cell's
   relief), never on the hill. On flat land the town hugs the castle. Houses stand only in towns (plus a few farmsteads), so the
   land between is open. Terrain for the whole cell is loaded first (burgPrep), so every tile computes the same sites. */
const BURG_C = 3600, BURGS = new Map(); let BURG_CLR = [], HAMLETS = []; // HAMLETS (Runde 165): small house groups on river banks, this tile // castles of the tile being built: no trees inside
const BURG_A = ['Falken', 'Raben', 'Wolfs', 'Adler', 'Eber', 'Hirsch', 'Greifen', 'Löwen', 'Drachen', 'Eichen', 'Hohen', 'Schwarzen', 'Rot', 'Silber', 'Kron', 'Sturm', 'Bären', 'Habichts'],
  BURG_B = ['stein', 'fels', 'eck', 'berg', 'hagen', 'wart', 'horst', 'au', 'schild', 'stolz'];
function burgSite(i, j) {
  const key = i + ',' + j; if (BURGS.has(key)) return BURGS.get(key);
  let b = null;
  if (hashStr('burg' + key) < .72) {
    const S = [], N = 9; let hi = null, lo = Infinity;
    for (let a = 0; a < N; a++) for (let c = 0; c < N; c++) { const X = (i + .1 + .8 * a / (N - 1)) * BURG_C, Y = (j + .1 + .8 * c / (N - 1)) * BURG_C, h = TERRAIN_ON ? rawH(lx(X), lz(Y)) : 0;
      const q = { X, Y, h: h === null ? 0 : h }; S.push(q); if (!hi || q.h > hi.h + .01 || (Math.abs(q.h - hi.h) <= .01 && hashStr('bk' + a + c + key) > .5)) hi = q; if (q.h < lo) lo = q.h; }
    if (TERRAIN_ON) for (let a = -10; a <= 10; a++) for (let c = -10; c <= 10; c++) { const X = hi.X + a * 15 / O.c, Y = hi.Y + c * 15 / O.c, h = rawH(lx(X), lz(Y)); if (h !== null && h > hi.h) hi = { X, Y, h }; } // the summit itself, not the nearest coarse sample
    const relief = hi.h - lo; let site = hi, town = null;
    if (relief < 30) { site = S[Math.floor(hashStr('bs' + key) * S.length)]; const a = hashStr('bt' + key) * 6.283; town = { X: site.X + Math.cos(a) * 170 / O.c, Y: site.Y + Math.sin(a) * 170 / O.c }; }
    else { let bd = Infinity; const step = 25 / O.c;
      for (let a = 0; a < 25; a++) for (let c = 0; c < 25; c++) { const X = (i - .1 + 1.2 * a / 24) * BURG_C, Y = (j - .1 + 1.2 * c / 24) * BURG_C, x = lx(X), z = lz(Y), h = rawH(x, z); if (h === null) continue;
        if (h > lo + .4 * relief) continue; const hx1 = rawH(x + 25, z), hx0 = rawH(x - 25, z), hz1 = rawH(x, z + 25), hz0 = rawH(x, z - 25); if ([hx1, hx0, hz1, hz0].some(v => v === null)) continue;
        if (Math.max(Math.abs(hx1 - hx0), Math.abs(hz1 - hz0)) / 50 > .07) continue; // not flat enough
        const d = Math.hypot(X - site.X, Y - site.Y); if (d < bd) { bd = d; town = { X, Y }; } }
      if (!town) { const a = hashStr('bt' + key) * 6.283; town = { X: site.X + Math.cos(a) * 260 / O.c, Y: site.Y + Math.sin(a) * 260 / O.c }; } }
    const nm = 'Burg ' + BURG_A[Math.floor(hashStr('bn' + key) * BURG_A.length)] + BURG_B[Math.floor(hashStr('bm' + key) * BURG_B.length)];
    b = { X: site.X, Y: site.Y, tX: town.X, tY: town.Y, R: 300 + hashStr('br' + key) * 260, name: nm, key };
    if (realNear(site.X, site.Y, 6000 / O.c)) b = null; // Runde 163: a real castle nearby - no invented one
    hanseSnap(b);
  }
  BURGS.set(key, b); return b;
}
/* Runde 163: real castles and castle ruins from OSM (daten/burgen/<lat>_<lon>.json, werkzeuge/burgen.py; Germany): a castle stands
   where one stands or stood (Sparrenburg above Bielefeld); invented castles only where no real one lies within 6 km. The list is
   fixed, so every tile knows the same castles. Near-duplicates (several OSM objects of one castle) within 400 m count once. */
const REAL_CELLS = new Map(), REAL = [];
async function realLoad(lat, lon) {
  const k = Math.floor(lat) + '_' + Math.floor(lon); if (REAL_CELLS.has(k)) return REAL_CELLS.get(k);
  const pr = (async () => { let L = []; try { const r = await fetch('daten/burgen/' + k + '.json?v=2'); if (r.ok) L = await r.json(); } catch (e) { }
    L.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const c of L) { const m = merc(c[0], c[1]); if (REAL.some(o => Math.hypot(o.X - m.X, o.Y - m.Y) * O.c < 400)) continue; REAL.push({ X: m.X, Y: m.Y, name: c[2], ruin: c[3], key: 'R' + c[0] + ',' + c[1] }); } })();
  REAL_CELLS.set(k, pr); return pr;
}
const realNear = (X, Y, r) => REAL.some(o => Math.hypot(o.X - X, o.Y - Y) < r);
/* Runde 166: real palaces ("s"), moated palaces ("w") and manors ("g") from OSM (daten/schloesser/<lat>_<lon>.json). A palace that is
   also in the castle list stays a castle (no double building); near-duplicates within 300 m count once. */
const SCHL_CELLS = new Map(), SCHL = [];
async function schlLoad(lat, lon) {
  const k = Math.floor(lat) + '_' + Math.floor(lon); if (SCHL_CELLS.has(k)) return SCHL_CELLS.get(k);
  const pr = (async () => { let L = []; try { const r = await fetch('daten/schloesser/' + k + '.json?v=1'); if (r.ok) L = await r.json(); } catch (e) { }
    L.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const c of L) { const m = merc(c[0], c[1]); if (SCHL.some(o => Math.hypot(o.X - m.X, o.Y - m.Y) * O.c < 300)) continue; SCHL.push({ X: m.X, Y: m.Y, name: c[2], k: c[3], key: 'S' + c[0] + ',' + c[1] }); } })();
  SCHL_CELLS.set(k, pr); return pr;
}
/* Runde 167: old Hanse towns (daten/hanse.json, werkzeuge/hanse_pbf.py) are medieval towns by the same rules as the castle towns -
   houses, church in the middle, mills, roads only where people live - but at their real centre, larger, in brick (hz) and without
   a castle of their own. A castle within 3.5 km gets the Hanse town as its town (Sparrenburg → Bielefeld). */
let HANSE = null;
async function hanseLoad() { if (HANSE) return; HANSE = []; let L = []; try { const r = await fetch('daten/hanse.json?v=1'); if (r.ok) L = await r.json(); } catch (e) { }
  for (const c of L) { const m = merc(c[0], c[1]); HANSE.push({ X: m.X, Y: m.Y, name: c[2], key: 'H' + c[2], R: 650 + hashStr('hr' + c[2]) * 250 }); } }
function hanseSnap(b) { if (!b || !HANSE) return b; let best = null, bd = 3500 / O.c; for (const h of HANSE) { const d = Math.hypot(h.X - b.X, h.Y - b.Y); if (d < bd) { bd = d; best = h; } }
  if (best) { b.tX = best.X; b.tY = best.Y; b.R = best.R; b.hz = 1; } return b; }
function schlNear(x0, z0, x1, z1) { // palaces and manors of a box, local coordinates (not where a real castle stands)
  const out = []; for (const o of SCHL) { const x = lx(o.X), z = lz(o.Y); if (x < x0 - 60 || x > x1 + 60 || z < z0 - 60 || z > z1 + 60) continue;
    if (/villa/i.test(o.name) || REAL.some(c => Math.hypot(c.X - o.X, c.Y - o.Y) * O.c < 300)) continue; out.push({ x, z, name: o.name, k: o.k, key: o.key }); }
  return out;
}
function townFor(sX, sY, key, span) { // the nearest plain to a castle site: gentle slope, low in the local relief, never on the hill
  const hs = TERRAIN_ON ? rawH(lx(sX), lz(sY)) : 0; let lo = Infinity;
  if (TERRAIN_ON) for (let a = -4; a <= 4; a++) for (let c = -4; c <= 4; c++) { const h = rawH(lx(sX + a * span / 4), lz(sY + c * span / 4)); if (h !== null && h < lo) lo = h; }
  const relief = (hs === null ? 0 : hs) - lo; let town = null;
  if (!TERRAIN_ON || !(relief >= 30)) { const a = hashStr('bt' + key) * 6.283; return { X: sX + Math.cos(a) * 170 / O.c, Y: sY + Math.sin(a) * 170 / O.c }; }
  let bd = Infinity;
  for (let a = -12; a <= 12; a++) for (let c = -12; c <= 12; c++) { const X = sX + a * span / 11, Y = sY + c * span / 11, x = lx(X), z = lz(Y), h = rawH(x, z); if (h === null || h > lo + .4 * relief) continue;
    const hx1 = rawH(x + 25, z), hx0 = rawH(x - 25, z), hz1 = rawH(x, z + 25), hz0 = rawH(x, z - 25); if ([hx1, hx0, hz1, hz0].some(v => v === null)) continue;
    if (Math.max(Math.abs(hx1 - hx0), Math.abs(hz1 - hz0)) / 50 > .07) continue;
    const d = Math.hypot(X - sX, Y - sY); if (d < bd) { bd = d; town = { X, Y }; } }
  if (!town) { const a = hashStr('bt' + key) * 6.283; town = { X: sX + Math.cos(a) * 260 / O.c, Y: sY + Math.sin(a) * 260 / O.c }; }
  return town;
}
async function burgPrep(X0, Y0, X1, Y1) { // castles touching this box (plus a town radius): load the real list and the terrain, then fix their sites
  await hanseLoad();
  for (const h of HANSE) if (!BURGS.has(h.key) && h.X > X0 - 3000 / O.c && h.X < X1 + 3000 / O.c && h.Y > Y0 - 3000 / O.c && h.Y < Y1 + 3000 / O.c) BURGS.set(h.key, { X: h.X, Y: h.Y, tX: h.X, tY: h.Y, R: h.R, name: h.name, key: h.key, nb: 1, hz: 1 });
  { const pad = 9000 / O.c, a = Math.atan(Math.sinh((Y0 - pad) / 6378137)) * 180 / Math.PI, b = Math.atan(Math.sinh((Y1 + pad) / 6378137)) * 180 / Math.PI,
      c = (X0 - pad) / 6378137 * 180 / Math.PI, d = (X1 + pad) / 6378137 * 180 / Math.PI;
    for (let la = Math.floor(a); la <= Math.floor(b); la++) for (let lo = Math.floor(c); lo <= Math.floor(d); lo++) { await realLoad(la + .5, lo + .5); await schlLoad(la + .5, lo + .5); }
    const near = 1200 / O.c;
    for (const o of REAL) { if (BURGS.has(o.key) || o.X < X0 - near || o.X > X1 + near || o.Y < Y0 - near || o.Y > Y1 + near) continue;
      const span = 1500 / O.c; if (TERRAIN_ON) await ensureTerrain(lx(o.X - span * 1.1), lz(o.Y + span * 1.1), lx(o.X + span * 1.1), lz(o.Y - span * 1.1));
      const t = townFor(o.X, o.Y, o.key, span);
      BURGS.set(o.key, hanseSnap({ X: o.X, Y: o.Y, tX: t.X, tY: t.Y, R: 300 + hashStr('br' + o.key) * 260, name: o.name || (o.ruin ? 'Burg' : 'Burg'), key: o.key, real: 1 })); } }
  const m = 900 / O.c, i0 = Math.floor((X0 - m) / BURG_C), i1 = Math.floor((X1 + m) / BURG_C), j0 = Math.floor((Y0 - m) / BURG_C), j1 = Math.floor((Y1 + m) / BURG_C);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { if (BURGS.has(i + ',' + j)) continue;
    if (TERRAIN_ON) await ensureTerrain(lx((i - .15) * BURG_C), lz((j + 1.15) * BURG_C), lx((i + 1.15) * BURG_C), lz((j - .15) * BURG_C));
    burgSite(i, j); }
}
function burgsNear(x0, z0, x1, z1) { // sites as local coordinates, for one tile
  const out = []; for (const b of BURGS.values()) { if (!b) continue; const x = lx(b.X), z = lz(b.Y), tx = lx(b.tX), tz = lz(b.tY);
    if (Math.min(x, tx) > x1 + 1000 || Math.max(x, tx) < x0 - 1000 || Math.min(z, tz) > z1 + 1000 || Math.max(z, tz) < z0 - 1000) continue; out.push({ x, z, tx, tz, R: b.R, name: b.name, key: b.key, nb: b.nb, hz: b.hz }); }
  return out;
}
function weltBauten(items, roads, collide, map, plazas, box, wet) {
  const out = WOUT, R = roads.filter(r => r.k === 'm' || (r.k === 'p' && r.w >= 5)), grid = new Map(), C = 24;
  for (const r of R) { const p = r.p; for (let i = 0; i + 3 < p.length; i += 2) { const x0 = Math.min(p[i], p[i + 2]), x1 = Math.max(p[i], p[i + 2]), z0 = Math.min(p[i + 1], p[i + 3]), z1 = Math.max(p[i + 1], p[i + 3]);
    if ((x1 - x0) * (z1 - z0) > 300 * 300) continue;
    for (let a = Math.floor(x0 / C); a <= Math.floor(x1 / C); a++) for (let b = Math.floor(z0 / C); b <= Math.floor(z1 / C); b++) { const k = a * 100003 + b; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(r, i); } } }
  const near = (x, z, md) => { let bd = md, bx = 0, bz = 0, bw = 0; const n = Math.ceil(md / C);
    for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) { const l = grid.get((Math.floor(x / C) + a) * 100003 + Math.floor(z / C) + b); if (!l) continue;
      for (let k = 0; k < l.length; k += 2) { const p = l[k].p, i = l[k + 1], ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z); if (d < bd) { bd = d; bx = px; bz = pz; bw = l[k].w; } } }
    return bd < md ? { d: bd, x: bx, z: bz, w: bw } : null; };
  const chosen = [], free = (x, z, r) => !chosen.some(c => Math.hypot(c.x - x, c.z - z) < Math.max(r, c.r));
  const put = (v, x, z, ry, t, sx, sy, sz, r) => { let y = weltBase(x, z); if (v === 'm_burg') for (let a = -19; a <= 19; a += 9.5) for (let b = -19; b <= 19; b += 9.5) y = Math.max(y, weltBase(x + a, z + b)); /* the castle floor: the highest ground under it, nothing pokes through */ out.push({ v, x, y, z, ry, sx: sx || 1, sy: sy || 1, sz: sz || 1, t: t || '' }); if (r) chosen.push({ x, z, r });
    if (v === 'm_burg') { // Runde 154: the castle collides piece by piece - rock base (walk on it), walls, towers, keep, hall; the gate stays open
      const c = Math.cos(ry), s = Math.sin(ry), rect = (x0, z0, x1, z1, h) => { const ring = []; for (const [u, v2] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) ring.push(x + u * c + v2 * s, z - u * s + v2 * c); collide.push(4, y + h, y - 30, ...ring); return ring; };
      map.blds.push(Float32Array.from(rect(-19, -19, 19, 19, .4)));
      for (const r of [[-17, -17, 17, -15, 9], [-17, -17, -15, 17, 9], [15, -17, 17, 17, 9], [-17, 15, -2.4, 17, 9], [2.4, 15, 17, 17, 9], [-6, 13, -2.4, 18.5, 13], [2.4, 13, 6, 18.5, 13],
        [-20.4, -20.4, -13.6, -13.6, 14], [13.6, -20.4, 20.4, -13.6, 14], [-20.4, 13.6, -13.6, 20.4, 14], [13.6, 13.6, 20.4, 20.4, 14], [-10, -12, -1, -3, 24], [3, -13, 13, 3, 10], [-13, 6, -6, 12, 4]]) rect(...r);
      // a stone stair from the gate down to the slope (castles on hills stand on a rock base above the ground in front)
      for (let v = 19; v < 70; v++) { const T = .4 - (v - 18) * .4, wx = x + (v + .5) * s, wz = z + (v + .5) * c, g = weltBase(wx, wz) - y; if (T <= g + .05) break;
        rect(-2.6, v, 2.6, v + 1, T); out.push({ v: 'm_stufe', x: wx, y: y + g, z: wz, ry, sx: 1, sy: T - g, sz: 1, t: '' }); }
      return; }
    const D = W_DIM[v.startsWith('c_turm') || v.startsWith('c_stufen') ? 'c_turm' : v]; if (!D) return;
    const w = D[0] * (sx || 1) / 2, d = D[1] * (sz || 1) / 2, c = Math.cos(ry), s = Math.sin(ry), ring = [];
    for (const [u, v2] of [[-w, -d], [w, -d], [w, d], [-w, d]]) ring.push(x + u * c + v2 * s, z - u * s + v2 * c);
    collide.push(4, D[2] * (sy || 1) + y, y, ...ring); map.blds.push(Float32Array.from(ring)); };
  // in front of the street: the model's front (+z) looks at the nearest street, set back to the street edge
  const front = (it, v, md) => { const nr = near(it.cx, it.cz, md); if (!nr) return null; const D = W_DIM[v]; let dx = nr.x - it.cx, dz = nr.z - it.cz; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const back = nr.w / 2 + D[1] / 2 + (v.startsWith('w_') ? 4.5 : 1.5); return { x: nr.x - dx * back, z: nr.z - dz * back, ry: Math.atan2(dx, dz), dx, dz }; };
  for (const it of items) { let cx = 0, cz = 0; for (let i = 0; i < it.p.length; i += 2) { cx += it.p[i]; cz += it.p[i + 1]; } it.cx = cx / (it.p.length / 2); it.cz = cz / (it.p.length / 2); it.ar = Math.abs(ringArea(it.p)); it.hs = hashStr('w' + it.cx.toFixed(1) + ',' + it.cz.toFixed(1)); }
  if (WELT === 'west') {
    const cand = [];
    for (const it of items) { if (it.ar < 40) continue; const n = W_WEST[it.poi] || (it.poi ? 'STORE' : null); cand.push({ it, n, pr: n ? (W_PRIO[n] || 3) + it.hs : it.ar > 120 ? it.hs * .5 : -1 }); }
    cand.sort((a, b) => b.pr - a.pr); let ns = 0;
    for (const c of cand) { if (c.pr < 0) break; const poi = !!c.n, sp = poi ? 34 : 70;
      const v = c.n === 'SALOON' ? 'w_saloon' : c.n === 'BANK' ? 'w_bank' : c.n === 'SHERIFF' ? 'w_sheriff' : c.n === 'HOTEL' ? 'w_hotel' : c.n === 'GENERAL STORE' ? 'w_store' : ['w_laden_a', 'w_laden_b', 'w_laden_c'][Math.floor(c.it.hs * 3)];
      const f = front(c.it, v, poi ? 28 : 22); if (!f || !free(f.x, f.z, sp)) continue;
      put(v, f.x, f.z, f.ry, c.n || W_GEN[Math.floor(c.it.hs * 7) % W_GEN.length], 1, 1, 1, sp);
      if (c.n === 'SALOON' && ns++ % 2 === 0) put('w_kutsche', f.x + f.dx * 14 - f.dz * 6, f.z + f.dz * 14 + f.dx * 6, f.ry + Math.PI / 2);
      if (poi && c.it.hs > .85) put(c.it.hs > .9 ? 'w_wasserturm' : 'w_windpumpe', f.x - f.dx * 14 + f.dz * 6, f.z - f.dz * 14 - f.dx * 6, c.it.hs * 6, '', 1, 1, 1, 10);
    }
  } else if (WELT === 'mittel') {
    const TW = box ? burgsNear(box[0], box[1], box[2], box[3]) : [];
    const townD = (x, z) => { let best = 9; for (const t of TW) { const d = Math.hypot(x - t.tx, z - t.tz) / t.R; if (d < best) best = d; } return best; }; // distance to the nearest town centre, in town radii
    const inTown = (x, z, hs) => { const d = townD(x, z); return d < .65 || (d < 1 && hs > (d - .65) / .35); };
    for (const t of TW) if (!t.nb && box && t.x >= box[0] && t.x < box[2] && t.z >= box[1] && t.z < box[3] && !wet(t.x, t.z)) { const rt = Math.atan2(t.tx - t.x, t.tz - t.z); let ry = rt, best = -Infinity; for (let k = 0; k < 16; k++) { const a = rt + k / 16 * 6.283, h = weltBase(t.x + Math.sin(a) * 32, t.z + Math.cos(a) * 32) - .02 * Math.min(k, 16 - k); if (h > best) { best = h; ry = a; } } // the gate looks down the gentlest side (towards the town when it is as gentle)
      const n0 = out.length; put('m_burg', t.x, t.z, ry, t.name, 1, 1, 1, 46); const o = out[n0]; o.tx = t.tx; o.tz = t.tz; o.R = t.R; BURG_CLR.push(t.x, t.z); } // gate towards the town; the town centre goes along (map)
    /* Runde 160: every town gets a windmill on the highest open ground just outside it and, where water is near, a watermill
       on the bank with its wheel towards the water */
    const inBox = (x, z) => box && x >= box[0] && x < box[2] && z >= box[1] && z < box[3];
    const offRoad = (x, z, r) => { const nr = near(x, z, r + 8); return !nr || nr.d > nr.w / 2 + r; };
    const forest = (x, z) => map.areas.some(a => a.k === 'f' && inPoly(x, z, a.rings[0])); // mills stand on open land
    /* Runde 166: palaces and manors. The worker fixes the base form (wings or pavilions, with or without moat; manor mirrored, 4 or 5
       bays) and passes it as it.f - the kit (mittel_bau.js) builds exactly that, so collision and look agree. Rects in the kit's
       Blender frame (x right, y back, front -y): [x0, y0, x1, y1, height]; three.js local = (x, -y). */
    const putGross = (v, x, z, ry, f, name) => {
      const c = Math.cos(ry), s = Math.sin(ry), L = [];
      if (v === 'm_schloss') { const FL = f[0] === 'f', wa = f[1] === 'w', W = FL ? 28.8 : 22.4, zi = wa ? .6 : 0, H = zi + 13;
        if (wa) { const IX = W / 2 + (FL ? 3.8 : 4.7), IY0 = -(6.4 + (FL ? 13.4 : 8.7)), IY1 = 6.4 + (FL ? 1.5 : 4.7), M = 6;
          L.push([-IX - M - 1, IY0 - M - 1, IX + M + 1, IY1 + M + 1, .02], [-IX, IY0, IX, IY1, zi], // ground, island
            [-IX - M, IY0 - M, -1.9, IY0, 1], [1.9, IY0 - M, IX + M, IY0, 1], [-IX - M, IY1, IX + M, IY1 + M, 1], [-IX - M, IY0, -IX, IY1, 1], [IX, IY0, IX + M, IY1, 1]); // moat
          for (let i = 0; i < 4; i++) { const y0 = IY0 - M - .3 + i * (M + .3) / 4; L.push([-1.9, y0, 1.9, y0 + (M + .3) / 4, .15 * (i + 1)]); } } // bridge in four low steps
        else L.push(FL ? [-16.4, -25, 16.4, 8.4, .02] : [-16.4, -17.8, 16.4, 11.6, .02]);
        if (FL) { L.push([-14.4, -6.4, 14.4, 6.4, H], [8, -16, 14.4, -6.4, H], [-14.4, -16, -8, -6.4, H]); if (wa) L.push([12.1, -18.3, 16.7, -13.7, H + 4], [-16.7, -18.3, -12.1, -13.7, H + 4]); }
        else L.push([-14.4, -9.6, 14.4, 9.6, H + 3]);
        L.push([-4.8, -7.2, 4.8, -6.4, H], [-1.8, -9.8, 1.8, -7.2, zi + 1.2]); }
      else { const sx = f[0] === 'l' ? -1 : 1, hw = +f[1] * 3.2, left = sx > 0 ? -23.2 : -20, right = sx > 0 ? 20 : 23.2, ys = sx > 0 ? -9.2 : -7.6, ys2 = sx > 0 ? -7.6 : -9.2;
        L.push([left - 1, -19.5, right + 1, 20.6, .02], [-hw / 2, 10, hw / 2, 19.6, 13], // ground, manor house
          sx > 0 ? [-23.2, -9.2, -12, 10, 11.6] : [12, -9.2, 23.2, 10, 11.6], sx > 0 ? [12, -7.6, 20, 10, 7] : [-20, -7.6, -12, 10, 7], // barn, stable
          [left, -12.25, -2.6, -11.75, 2.2], [2.6, -12.25, right, -11.75, 2.2], [left - .25, -12, left + .25, ys, 2.2], [right - .25, -12, right + .25, ys2, 2.2],
          [-12, 10, -hw / 2, 10.5, 2.2], [hw / 2, 10, 12, 10.5, 2.2]);
        if (f[2] === 't') L.push([-3.8, -14.5, -1.4, -9.5, 5.4], [1.4, -14.5, 3.8, -9.5, 5.4]); else L.push([-3.1, -12.45, -2.2, -11.55, 3], [2.2, -12.45, 3.1, -11.55, 3]); } // gatehouse or gate pillars
      const ring = (x0, y0, x1, y1) => { const R = []; for (const [u, w] of [[x0, -y1], [x1, -y1], [x1, -y0], [x0, -y0]]) R.push(x + u * c + w * s, z - u * s + w * c); return R; };
      const G = L[0]; let y = -Infinity; for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { const u = G[0] + (G[2] - G[0]) * i / 4, w = -(G[1] + (G[3] - G[1]) * j / 4); y = Math.max(y, weltBase(x + u * c + w * s, z - u * s + w * c)); } // the floor: the highest ground under it
      out.push({ v, x, y, z, ry, sx: 1, sy: 1, sz: 1, t: name || '', f }); chosen.push({ x, z, r: v === 'm_schloss' ? 40 : 32 });
      for (const q of L) { const R = ring(q[0], q[1], q[2], q[3]); collide.push(4, y + q[4], y - 30, ...R); if (q[4] > 2) map.blds.push(Float32Array.from(R)); }
      for (let i = 0; i < 40; i++) { const v0 = -G[1] + i, T = .02 - (i + 1) * .4, wx = x + (v0 + .5) * s, wz = z + (v0 + .5) * c, g = weltBase(wx, wz) - y; if (T <= g + .05) break; // on a slope: a stone stair from the front down to the ground (like the castle)
        collide.push(4, y + T, y - 30, ...ring(-2.6, -(v0 + 1), 2.6, -v0)); out.push({ v: 'm_stufe', x: wx, y: y + g, z: wz, ry, sx: 1, sy: T - g, sz: 1, t: '' }); }
      for (const [u, w] of [[-14, -14], [14, -14], [14, 14], [-14, 14], [0, -18], [0, 18]]) BURG_CLR.push(x + u * c + w * s, z - u * s + w * c); // the estate stands in a clearing
      // Runde 167: outbuildings beside the estate (kit frame like L): manor chapel, carriage shed; palace chapel, orangery behind
      const sat = (v2, bx, by, rot) => { const X = x + bx * c - by * s, Z = z - bx * s - by * c; if (wet(X, Z) || !offRoad(X, Z, 4)) return; put(v2, X, Z, ry + rot, '', 1, 1, 1, 10); BURG_CLR.push(X, Z); };
      const hk = hashStr('sat' + Math.round(x) + ',' + Math.round(z));
      if (v === 'm_gutshof') { const sx = f[0] === 'l' ? -1 : 1; if (hk < .5) sat('m_kapelle', sx > 0 ? G[2] + 5 : G[0] - 5, -6, 0); if (hashStr('re' + hk) < .5) sat('m_remise', sx > 0 ? G[0] - 4.5 : G[2] + 4.5, 2, -sx * Math.PI / 2); }
      else { if (hk < .55) sat('m_kapelle', (hk < .27 ? -1 : 1) * (G[2] + 6), -2, 0); if (hashStr('or' + hk) < .6) sat('m_orangerie', 0, G[3] + 7, 0); }
    };
    for (const q of schlNear(box[0], box[1], box[2], box[3])) { if (!inBox(q.x, q.z) || wet(q.x, q.z) || !free(q.x, q.z, 36) || (q.k === 'g' && townD(q.x, q.z) < 1)) continue; // a manor is a country estate, never inside a town
      const nr = near(q.x, q.z, 90), t = TW.length ? TW.reduce((a, b) => Math.hypot(a.tx - q.x, a.tz - q.z) < Math.hypot(b.tx - q.x, b.tz - q.z) ? a : b) : null;
      const ry = nr ? Math.atan2(nr.x - q.x, nr.z - q.z) : t ? Math.atan2(t.tx - q.x, t.tz - q.z) : hashStr('sr' + q.key) * 6.283; // the front looks at the road (or the town)
      if (q.k === 'g') putGross('m_gutshof', q.x, q.z, ry, (hashStr('gs' + q.key) < .5 ? 'l' : 'r') + (hashStr('gn' + q.key) < .5 ? 4 : 5) + (hashStr('gt' + q.key) < .4 ? 't' : '-'), q.name);
      else putGross('m_schloss', q.x, q.z, ry, (hashStr('sf' + q.key) < .5 ? 'f' : 'p') + (q.k === 'w' || hashStr('sw' + q.key) < .25 ? 'w' : '-'), q.name); }
    for (const t of TW) {
      let best = null, bh = -Infinity;
      for (let k = 0; k < 12; k++) { const a = hashStr('wm' + t.key) * 6.283 + k / 12 * 6.283, d = t.R * (1.05 + .25 * hashStr('wd' + t.key + k)), x = t.tx + Math.cos(a) * d, z = t.tz + Math.sin(a) * d;
        if (!inBox(x, z) || wet(x, z) || !free(x, z, 22) || !offRoad(x, z, 6) || forest(x, z)) continue; const h = weltBase(x, z); if (h > bh) { bh = h; best = { x, z }; } }
      if (best) { const nr = near(best.x, best.z, 60); put('m_windmuehle', best.x, best.z, nr ? Math.atan2(nr.x - best.x, nr.z - best.z) : 0, '', 1, 1, 1, 22); BURG_CLR.push(best.x, best.z); }
      let wm = null, wd = Infinity;
      for (let ri = 0; ri < 6; ri++) for (let k = 0; k < 16; k++) { const a = k / 16 * 6.283, d = t.R * (.4 + ri * .18), x = t.tx + Math.cos(a) * d, z = t.tz + Math.sin(a) * d;
        if (!inBox(x, z) || wet(x, z) || !free(x, z, 16) || !offRoad(x, z, 5)) continue;
        for (let q = 0; q < 8; q++) { const b2 = q / 8 * 6.283, wx = x + Math.sin(b2) * 8, wz = z + Math.cos(b2) * 8; if (wet(wx, wz) && !wet(x + Math.sin(b2) * 4, z + Math.cos(b2) * 4)) { if (d < wd) { wd = d; wm = { x, z, ry: b2 }; } break; } } }
      if (wm) { put('m_wassermuehle', wm.x, wm.z, wm.ry, '', 1, 1, 1, 16); BURG_CLR.push(wm.x, wm.z); }
    }
    /* Runde 167: the church stands in the middle of the town, as it was - the nearest free spot to the centre, off the streets, tower to
       the west (altar east); the houses keep 26 m away, so a church square forms. Collision: nave and tower. */
    const kirche = (x, z, ry, hz) => { const n0 = out.length; put('m_kirche', x, z, ry, '', 1, 1, 1, 26); const o = out[n0]; if (hz) o.f = 'h'; const c = Math.cos(ry), s2 = Math.sin(ry), y = o.y;
      for (const [u0, v0, u1, v1, h] of [[-4.5, -8, 4.5, 8, 12], [-2.7, 8, 2.7, 13.4, hz ? 37 : 28]]) { const R = []; for (const [u, w] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) R.push(x + u * c + w * s2, z - u * s2 + w * c); collide.push(4, y + h, y, ...R); map.blds.push(Float32Array.from(R)); } };
    const kt = [];
    for (const t of TW) { if (!inBox(t.tx, t.tz) || kt.some(q => Math.hypot(q.x - t.tx, q.z - t.tz) < 250)) continue; let best = null;
      for (let r = 0; r <= 140 && !best; r += 6) { const n = Math.max(1, Math.round(r / 3)); for (let k = 0; k < n; k++) { const a = k / n * 6.283 + r * .1, x = t.tx + Math.cos(a) * r, z = t.tz + Math.sin(a) * r;
        if (wet(x, z) || !free(x, z, 26) || !offRoad(x, z, 10)) continue; best = { x, z }; break; } }
      if (best) { kirche(best.x, best.z, -Math.PI / 2, t.hz); kt.push(best); } }
    const ch = kt.length ? null : items.filter(it => (it.btype === 1 || it.poi === 'place_of_worship') && townD(it.cx, it.cz) < .8).sort((a, b) => b.ar - a.ar)[0];
    if (ch && ch.ar > 150) { const o = obb(ch.p); if (o) kirche(o.cx, o.cz, Math.atan2(o.c, o.s), false); }
    for (const pl of plazas.slice().sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a))).slice(0, 2)) { if (Math.abs(ringArea(pl)) < 600) break;
      let x = 0, z = 0; for (let i = 0; i < pl.length; i += 2) { x += pl[i]; z += pl[i + 1]; } x /= pl.length / 2; z /= pl.length / 2; if (!inPoly(x, z, pl) || !free(x, z, 18) || townD(x, z) > .8) continue;
      put('m_brunnen', x, z, 0, '', 1, 1, 1, 18); for (let k = 0; k < 5; k++) { const a = k / 5 * 6.283 + .4, sx = x + Math.cos(a) * 9, sz = z + Math.sin(a) * 9; if (inPoly(sx, sz, pl)) put(k % 2 ? 'm_stand_a' : 'm_stand_b', sx, sz, Math.atan2(x - sx, z - sz)); } }
    const farm = new Set(), isFarm = it => { const k = Math.floor(it.cx / 250) + ',' + Math.floor(it.cz / 250); if (farm.has(k) || hashStr('fh' + k) > .25 || it.ar < 60) return false; farm.add(k); return true; }; // farmsteads: at most one per 250 m cell, in a quarter of the cells
    const cand = items.filter(it => it !== ch && it.ar > 30 && (inTown(it.cx, it.cz, it.hs) || (it.farm = isFarm(it)))).map(it => ({ it, n: W_MITTEL[it.poi] || null })) /* Runde 154: only in towns, plus a few farmsteads */.map(c => Object.assign(c, { pr: (c.n === 'RATHAUS' ? 5 : c.n ? 2 : 0) + c.it.hs })).sort((a, b) => b.pr - a.pr);
    const used = {}, dg = new Map(), dk = (x, z) => Math.floor(x / 50) * 100003 + Math.floor(z / 50); // building density: dense old cores keep their houses close together
    for (const it of items) dg.set(dk(it.cx, it.cz), (dg.get(dk(it.cx, it.cz)) || 0) + 1);
    for (const c of cand) { let n = c.n; const dense = (dg.get(dk(c.it.cx, c.it.cz)) || 0) >= 9, sp = n ? 13 : dense ? 15 : 60; if (n && (used[n] || 0) >= (n === 'TAVERNE' ? 3 : 1)) n = null;
      const v = n === 'RATHAUS' ? 'm_rathaus' : n === 'TAVERNE' ? 'm_taverne' : n ? (c.it.hs < .5 ? 'm_laden_a' : 'm_laden_b') : ['m_haus_a', 'm_haus_b', 'm_haus_c', 'm_haus_d'][Math.floor(c.it.hs * 4)];
      if (c.it.farm) { const f = front(c.it, 'm_bauernhaus', 30); if (!f || !free(f.x, f.z, 20) || !inBox(f.x, f.z)) continue; // Runde 166: a building on the tile edge is in both tiles - only the tile that holds the farm builds it // Runde 160: a farmstead - farmhouse to the road, barn beside it, set back
        if (hashStr('gh' + c.it.hs) < .2 && !forest(f.x, f.z)) { const gx = f.x - f.dx * 14.7, gz = f.z - f.dz * 14.7; // Runde 166: every fifth farmstead on open land is a manor, its gate to the road
          if (free(gx, gz, 34) && ![[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20]].some(([a, b]) => wet(gx + a, gz + b))) { putGross('m_gutshof', gx, gz, f.ry, (hashStr('gs' + c.it.hs) < .5 ? 'l' : 'r') + (hashStr('gn' + c.it.hs) < .5 ? 4 : 5) + (hashStr('gt' + c.it.hs) < .4 ? 't' : '-'), ''); continue; } }
        put('m_bauernhaus', f.x, f.z, f.ry, '', 1, 1, 1, 12); const sd = hashStr('fs' + c.it.hs) < .5 ? -1 : 1, rx = Math.cos(f.ry), rz = -Math.sin(f.ry);
        const bx = f.x + rx * sd * 11 - f.dx * 5, bz = f.z + rz * sd * 11 - f.dz * 5; if (!forest(f.x, f.z) && free(bx, bz, 12) && !wet(bx, bz) && offRoad(bx, bz, 7)) { put('m_scheune', bx, bz, f.ry + sd * Math.PI / 2, '', 1, 1, 1, 12); BURG_CLR.push((f.x + bx) / 2, (f.z + bz) / 2); } continue; } // in a wood: just the house (forester), no barn
      const f = front(c.it, v, 22); if (!f || !free(f.x, f.z, sp)) continue; if (n) used[n] = (used[n] || 0) + 1; put(v, f.x, f.z, f.ry, n || '', 1, 1, 1, sp); }
    for (const h of HAMLETS) { const n = h.n; // Runde 165: a hamlet - houses in a loose ring, fronts to its little green
      if (n >= 4 && !wet(h.x, h.z) && free(h.x, h.z, 10) && hashStr('hk' + Math.round(h.x)) < .7) put('m_kapelle', h.x, h.z, Math.atan2(h.fx, h.fz), '', 1, 1, 1, 9); // Runde 167: a chapel on the green
      for (let i = 0; i < n; i++) { const a = Math.atan2(h.fz, h.fx) + Math.PI + (i - (n - 1) / 2) * .9, r = 16 + hashStr('hr' + i + Math.round(h.x)) * 6, x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
        const v = ['m_haus_a', 'm_haus_b', 'm_haus_c', 'm_haus_d'][Math.floor(hashStr('hv' + i + Math.round(h.z)) * 4)]; if (!free(x, z, 12) || wet(x, z)) continue; put(v, x, z, Math.atan2(h.x - x, h.z - z), '', 1, 1, 1, 12); } }
    // the town is a town even where today there are few buildings: houses along its streets, dense in the core, thinning out
    for (const t of TW) { for (const r of R) { if (r.k !== 'm' || r.b || r.a || r.t) continue;
      sampleLineDir(r.p, 15, (x, z, dx, dz) => { const d = Math.hypot(x - t.tx, z - t.tz) / t.R; if (d > .8) return;
        for (const sd of [-1, 1]) { const hs = hashStr('mh' + x.toFixed(0) + ',' + z.toFixed(0) + sd); if (hs > 1.15 - d) continue;
          const v = ['m_haus_a', 'm_haus_b', 'm_haus_c', 'm_haus_d'][Math.floor(hashStr('mv' + x.toFixed(0) + z.toFixed(0) + sd) * 4)], D = W_DIM[v], o = r.w / 2 + D[1] / 2 + 1.5;
          const hx = x - dz * o * sd, hz = z + dx * o * sd; if (!free(hx, hz, 13) || wet(hx, hz)) continue; const nr = near(hx, hz, o + 4); if (nr && nr.d < nr.w / 2 + D[1] / 2) continue; // not on another street
          put(v, hx, hz, Math.atan2(dz * sd, -dx * sd), '', 1, 1, 1, 13); } }); } }
    if (TW.some(t => t.hz)) for (const it of out) if (/^m_(haus|laden|taverne|rathaus)/.test(it.v)) { let bt = null, bd = 1.25; for (const t of TW) { const d = Math.hypot(it.x - t.tx, it.z - t.tz) / t.R; if (d < bd) { bd = d; bt = t; } } if (bt && bt.hz) it.f = 'h'; } // Runde 167: brick houses in Hanse towns
  } else if (WELT === 'cyber') {
    const n = items.length, par = items.map((_, i) => i), fd = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const a = items[i], b = items[j]; if (a.minx - 2 < b.maxx + 2 && b.minx - 2 < a.maxx + 2 && a.minz - 2 < b.maxz + 2 && b.minz - 2 < a.maxz + 2) par[fd(i)] = fd(j); }
    const groups = new Map(); items.forEach((it, i) => { const k = fd(i); let g = groups.get(k); if (!g) groups.set(k, g = []); g.push(it); });
    let pi = 0;
    for (const bs of groups.values()) { const A = bs.reduce((s2, b) => s2 + b.ar, 0); if (A <= 60) continue;
      const pts = []; for (const b of bs) for (let i = 0; i < b.p.length; i++) pts.push(b.p[i]); const o = obb(Float32Array.from(pts)); if (!o) continue;
      const named = (bs.find(b => W_CYBER[b.poi]) || {}).poi, nx = Math.max(1, Math.round(o.w / 55)), nz = Math.max(1, Math.round(o.d / 55));
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) { const u = (i + .5) / nx * o.w - o.w / 2, v = (j + .5) / nz * o.d - o.d / 2, x = o.cx + u * o.c - v * o.s, z = o.cz + u * o.s + v * o.c, k = hashStr('c' + x.toFixed(1) + z.toFixed(1));
        if (nx * nz > 1 && k < .4) continue;
        const cw = o.w / nx, cd = o.d / nz, w = Math.max(10, Math.min(22, cw - 8)), d = Math.max(10, Math.min(22, cd - 8)), H = Math.min(150, 35 + Math.sqrt(cw * cd) * 1.6 + k * 55);
        const t = named && (i + j === 0 || k > .5) ? W_CYBER[named] : W_POOL[pi++ % W_POOL.length];
        const nr = near(x, z, 80), ry = nr ? Math.atan2(nr.x - x, nr.z - z) : Math.atan2(o.c, o.s);
        put(['c_turm_a', 'c_turm_b', 'c_turm_c', 'c_stufen_a', 'c_stufen_b'][Math.floor(k * 5)], x, z, ry, t, w / 16, H / 100, d / 16, 0); } }
    let lc = 0; for (const r of R) { if (r.k !== 'm' || r.w < 5) continue; sampleLineDir(r.p, 30, (x, z, dx, dz) => { const sd = lc % 2 ? 1 : -1, o = r.w / 2 + 1.2; put(lc++ % 2 ? 'c_laterne_a' : 'c_laterne_b', x - dz * o * sd, z + dx * o * sd, Math.atan2(dz * sd, -dx * sd));
      if (lc % 9 === 0) { const y = weltBase(x, z) + 24 + hashStr('h' + lc) * 50; out.push({ v: lc % 18 ? 'c_auto_a' : 'c_auto_b', x, y, z, ry: Math.atan2(dx, dz), sx: 1, sy: 1, sz: 1, t: '' }); }
      if (lc % 23 === 0) put(lc % 46 ? 'c_ramen' : 'c_holo', x - dz * (o + 3) * -sd, z + dx * (o + 3) * -sd, Math.atan2(-dz * sd, dx * sd), lc % 46 ? 'RAMEN' : W_POOL[lc % W_POOL.length]); }); }
  }
}
function buildMVT(layers, tx, ty, l2tiles, osm) {
  WOUT = WELT === 'heute' ? null : []; BURG_CLR = []; HAMLETS = [];
  osm = osm || { blds: [], pts: [] };
  const synthLamps = osm.pts.filter(p => p.t === 6).length < 5; // invent street lamps only where OSM has none
  const strIdx = new Map(), STS = { lines: 0, wset: 0, swset: 0, dw: 0 }; // OSM street pieces by 16 m cell (each segment in every cell it passes, +8 m)
  for (const s of (osm.streets || [])) { const P = s.pts; for (let i = 0; i + 3 < P.length; i += 2) { const x0 = Math.min(P[i], P[i + 2]) - 8, x1 = Math.max(P[i], P[i + 2]) + 8, z0 = Math.min(P[i + 1], P[i + 3]) - 8, z1 = Math.max(P[i + 1], P[i + 3]) + 8;
    if ((x1 - x0) * (z1 - z0) > 400 * 400) continue; for (let a = Math.floor(x0 / 16); a <= Math.floor(x1 / 16); a++) for (let b = Math.floor(z0 / 16); b <= Math.floor(z1 / 16); b++) { const k = a * 100003 + b; let l = strIdx.get(k); if (!l) strIdx.set(k, l = []); l.push([s, i]); } } }
  const rdir = new Map(), rdk = (x, z) => Math.floor(x / 8) * 100003 + Math.floor(z / 8); // road direction samples for crossings
  const roadAt = (x, z) => { let best = null, bd = 64; const ix = Math.floor(x / 8), iz = Math.floor(z / 8);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const arr = rdir.get((ix + a) * 100003 + iz + b); if (!arr) continue;
      for (const s of arr) { const d = (s[0] - x) ** 2 + (s[1] - z) ** 2; if (d < bd) { bd = d; best = s; } } } return best; };
  const n = 1 << Z, ext0 = 4096;
  /* Runde 47 (phone test Koblenz Hohenfelder Strasse: traffic lights in the middle of the road): things moved to "the kerb" of the nearest
     street line can land on the next carriageway (dual carriageways, turning lanes, junctions). onRoad: any carriageway here;
     kerbFree: push the point further out along (nx, nz) until it stands on none, at most 8 m - else null (the thing is left out) */
  const onRoad = (x, z) => { const ix = Math.floor(x / 8), iz = Math.floor(z / 8);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const arr = rdir.get((ix + a) * 100003 + iz + b); if (!arr) continue;
      for (const s of arr) { if (s[4] < 2.5) continue; /* paths */ const ex = x - s[0], ez = z - s[1], along = Math.abs(ex * s[2] + ez * s[3]), across = Math.abs(-ex * s[3] + ez * s[2]); if (along < 1.2 && across < s[4] / 2 + .25) return true; } }
    return false; };
  const kerbFree = (x, z, nx, nz) => { if (self.KERBOFF) return [x, z]; for (let k = 0; k <= 16; k++) { const px = x + nx * k * .5, pz = z + nz * k * .5; if (!onRoad(px, pz)) return [px, pz]; } return null; };
  const mk = ext => (x, y) => { const X = (tx + x / ext) / n * WORLD - HALF, Y = HALF - (ty + y / ext) / n * WORLD; return [lx(X), lz(Y)]; };
  const ground = new Geo(), bridgeG = new Geo(), waterG = new Geo(), glow = new Geo(), buckets = new Map(), collide = [], names = [], nameIdx = new Map(), samples = [], spawn = [], start = [], sqNames = [], pedNames = new Set();
  { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0); ground.tileBox = [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1])]; } // Runde 186: areas end at the tile edge
  const map = { areas: [], roads: [], blds: [] };
  /* Runde 165: medieval countryside - streets only where people live (towns, farmsteads, hamlets) plus the through roads that join
     the settlements; the land between becomes forest with clearings, real brooks and lakes stay */
  let MED = null;
  if (WELT === 'mittel') { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0), bx = [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1])];
    const TW = burgsNear(bx[0], bx[1], bx[2], bx[3]), farms = [], fseen = new Set();
    const townD = (x, z) => { let b = 9; for (const t of TW) { const d = Math.hypot(x - t.tx, z - t.tz) / t.R; if (d < b) b = d; } return b; };
    const BL = layers.building; if (BL) { const toB = mk(BL.extent || ext0);
      for (const rng of BL.feats) { const f = readFeature(BL, rng); if (f.type !== 3) continue; const ln = geomLines(f, toB)[0]; if (!ln || ln.length < 6) continue;
        let x = 0, z = 0; for (let i = 0; i < ln.length; i += 2) { x += ln[i]; z += ln[i + 1]; } x /= ln.length / 2; z /= ln.length / 2;
        const k = Math.floor(x / 250) + ',' + Math.floor(z / 250); if (fseen.has(k) || hashStr('fh' + k) > .25 || townD(x, z) < 1) continue; fseen.add(k); farms.push(x, z); } }
    const SC = schlNear(bx[0], bx[1], bx[2], bx[3]), vn = (x, z) => { const S = 160, i = Math.floor(x / S), j = Math.floor(z / S), u = x / S - i, v = z / S - j, h = (a, b) => hashStr('fw' + a + ',' + b), su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
      return (h(i, j) * (1 - su) + h(i + 1, j) * su) * (1 - sv) + (h(i, j + 1) * (1 - su) + h(i + 1, j + 1) * su) * sv; };
    MED = { box: bx, TW, townD, farms, vn, ponds: [], near: (x, z, r) => { for (let i = 0; i < farms.length; i += 2) if ((farms[i] - x) ** 2 + (farms[i + 1] - z) ** 2 < r * r) return true; for (const h of HAMLETS) if ((h.x - x) ** 2 + (h.z - z) ** 2 < r * r) return true;
      for (const q of SC) if ((q.x - x) ** 2 + (q.z - z) ** 2 < (r + 30) ** 2) return true; return false; } }; }
  ground.spr = []; // trees and bushes as sprites
  if (false) { // (meadow is now built at the end, cut out over water)
    const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0), x0 = Math.min(c0[0], c1[0]), x1 = Math.max(c0[0], c1[0]), z0 = Math.min(c0[1], c1[1]), z1 = Math.max(c0[1], c1[1]), G = hex('#8fa067'), n = 8;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const ax = x0 + (x1 - x0) * i / n, bx = x0 + (x1 - x0) * (i + 1) / n, az = z0 + (z1 - z0) * j / n, bz = z0 + (z1 - z0) * (j + 1) / n;
      ground.quad([ax, -0.02, az], [bx, -0.02, az], [bx, -0.02, bz], [ax, -0.02, bz], G, 0, 1, 0); }
  }
  const cars = []; // parked cars as baked sprites: x, z, heading, type, colour, seed
  const rnd = mulberry(tx * 7919 + ty);
  let fpItems = [];
  const spanLines = [], pathBr = [], sideBr = [], hallPolys = [], lowLines = [], brLines = [], allLines = [], drvA = [], drvLines = [], corrSegs = [], bridgeDry = [], railSegs = [], dryLines = [], dryPolys = [], greenPolys = [], pierLines = [], playPolys = [], cemPolys = [], meadowPolys = [], fieldPolys = [], tallFields = new Set(), pitchPolys = [], plazaPolys = [], waterPolys = [], waterLines = [], parkRings = [], forestRings = [], waterRings = [], walkLines = [], indPolys = [], resPolys = [], hedgeCand = [], treeCand = [], roadCells = new Set(), rc = (x, z) => Math.floor(x / 3) * 100003 + Math.floor(z / 3); // trees are planted last, away from roads and houses

  // areas (landcover, landuse, park, water)
  for (const ln of ['landcover', 'landuse', 'park', 'water']) {
    const L = layers[ln]; if (!L) continue; const toL = mk(L.extent || ext0);
    for (const rng of L.feats) {
      const f = readFeature(L, rng); if (f.type !== 3) continue;
      let col, y, dens = 0, kind;
      if (ln === 'landuse' && /^(industrial|commercial|retail)$/.test(f.props.class)) { for (const poly of polygons(geomLines(f, toL))) { indPolys.push(Float32Array.from(poly[0])); if (f.props.class === 'industrial') hallPolys.push(indPolys[indPolys.length - 1]); ground.flat(poly, .004, WELT === 'heute' ? PAVED_LAND : hex(WELT === 'west' ? '#d0a46c' : WELT === 'cyber' ? '#191926' : '#a39a7c')); } continue; }
      if (ln === 'landuse' && /^(residential|garden)$/.test(f.props.class)) for (const poly of polygons(geomLines(f, toL))) resPolys.push(Float32Array.from(poly[0]));
      if (ln === 'water') { if (f.props.brunnel === 'tunnel') continue; col = WCOL[f.props.class] || WATER; y = .02 - WL(); kind = 'w';
        if (/^(lake|pond|reservoir|basin)$/.test(f.props.class || 'lake')) { let ar = 0, cut = false; const tb0 = mk(ext0)(0, 0), tb1 = mk(ext0)(ext0, ext0), bx0 = Math.min(tb0[0], tb1[0]), bx1 = Math.max(tb0[0], tb1[0]), bz0 = Math.min(tb0[1], tb1[1]), bz1 = Math.max(tb0[1], tb1[1]);
          for (const poly of polygons(geomLines(f, toL))) { ar += Math.abs(ringArea(poly[0])); const r = poly[0]; for (let i = 0; i < r.length && !cut; i += 2) if (r[i] < bx0 + 1 || r[i] > bx1 - 1 || r[i + 1] < bz0 + 1 || r[i + 1] > bz1 - 1) cut = true; }
          // a lake cut by the tile edge only shows a piece here: its size is unknown, so it counts as a mid-size lake in every tile it touches
          // (the area of the piece gave the two halves of one lake different colours with a straight seam - phone test, Schwangau)
          col = cut ? hex('#56808a') : ar < 400000 ? hex('#5e8068') : ar < 3e6 ? hex('#56808a') : WCOL.lake; } } // small lakes murky green, big lakes blue
      else { const a = AREA[f.props.class] || AREA[f.props.subclass]; if (!a) continue; col = hex(weltArea(a[0], a[2])); y = a[1]; dens = a[2]; kind = dens > 1 / 300 ? 'f' : 'g';
        if (MED && /^(residential|commercial|industrial|retail|railway|construction|garages|brownfield|landfill|military|parking|cemetery|school|university|hospital)$/.test(f.props.class)) { const g0 = geomLines(f, toL)[0]; if (g0) { let x = 0, z = 0; for (let i = 0; i < g0.length; i += 2) { x += g0[i]; z += g0[i + 1]; } if (MED.townD(x / (g0.length / 2), z / (g0.length / 2)) > 1.05) continue; } } }
      const G0 = ln === 'water' ? waterG : ground;
      for (const poly of polygons(geomLines(f, toL))) {
        /* Runde 218 (fields as one block with a shader): farmland gets a code colour instead of its colour - red = crop (8 kinds, by
           hash of the field), green = row direction (the long side of the field), blue = 2/255 marks it. The ground shader paints rows,
           crop colours and wind waves from it; no extra geometry. Only where the world keeps the field colour (today, middle ages). */
        let colF = col;
        if (f.props.class === 'farmland' && WELT !== 'west' && WELT !== 'cyber') { const o = obb(poly[0]); let a = o ? Math.atan2(o.s, o.c) : 0; if (o && o.d > o.w) a += Math.PI / 2;
          a = ((a % Math.PI) + Math.PI) % Math.PI; const r0 = poly[0], hsh = Math.abs(Math.sin(r0[0] * 12.9898 + r0[1] * 78.233) * 43758.5453) % 1;
          colF = [(16 + 32 * Math.floor(hsh * 8)) / 255, Math.round(a / Math.PI * 255) / 255, 2 / 255]; }
        const t = G0.flat(poly, y, colF);
        /* Runde 220: standing crops as one raised block that follows the ground: the field outline drawn in by ~1 m, lifted to the crop
           height (wheat .9, barley .8, rapeseed 1.2, maize 2.1 m) and joined to the edge by a slanted band (code blue 3 = side: the shader
           paints stalks). The drape puts both on the terrain like every ground layer. Beet, ploughed, young cereal and stubble stay flat. */
        if (colF !== col && poly.length === 1) { const crop = Math.round((colF[0] * 255 - 16) / 32), Hc = [.9, .8, 1.2, 2.1, 0, 0, 0, 0][crop];
          let r = Array.from(poly[0]); if (r.length > 4 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1]) r = r.slice(0, -2);
          const n = r.length / 2, A0 = ringArea(r);
          if (Hc > 0 && n >= 3 && Math.abs(A0) > 400) { const d = Hc > 2 ? 1.1 : .8, sg = A0 > 0 ? 1 : -1, ins = [];
            for (let i = 0; i < n; i++) { const p0 = (i + n - 1) % n, p2 = (i + 1) % n, ax = r[i * 2] - r[p0 * 2], az = r[i * 2 + 1] - r[p0 * 2 + 1], bx = r[p2 * 2] - r[i * 2], bz = r[p2 * 2 + 1] - r[i * 2 + 1];
              const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1, n1x = -az / la * sg, n1z = ax / la * sg, n2x = -bz / lb * sg, n2z = bx / lb * sg;
              let mx = n1x + n2x, mz = n1z + n2z; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml; const k = Math.min(3, 1 / Math.max(.33, mx * n1x + mz * n1z));
              ins.push(r[i * 2] + mx * d * k, r[i * 2 + 1] + mz * d * k); }
            const A1 = ringArea(ins); let cx0 = 0, cz0 = 0; for (let i = 0; i < n; i++) { cx0 += ins[i * 2]; cz0 += ins[i * 2 + 1]; }
            if (Math.sign(A1) === Math.sign(A0) && Math.abs(A1) > Math.abs(A0) * .6 && Math.abs(A1) < Math.abs(A0) && inPoly(cx0 / n, cz0 / n, r)) {
              tallFields.add(poly[0]); G0.flat([Float32Array.from(ins)], y + Hc, colF); const side = [colF[0], colF[1], 3 / 255];
              for (let i = 0; i < n; i++) { const j = (i + 1) % n; G0.quad([r[i * 2], y + .006, r[i * 2 + 1]], [r[j * 2], y + .006, r[j * 2 + 1]], [ins[j * 2], y + Hc, ins[j * 2 + 1]], [ins[i * 2], y + Hc, ins[i * 2 + 1]], side, 0, 1, 0); } } } }
        map.areas.push({ k: kind, rings: poly.map(r => Float32Array.from(r)) });
        if (kind === 'w') { waterRings.push(poly[0]); waterPolys.push(poly); }
        else if (ln !== 'landuse' || /^(grass|meadow|farmland|village_green|recreation_ground|cemetery|allotments|orchard|vineyard)$/.test(f.props.class)) greenPolys.push(poly);
        if (f.props.class === 'playground' || f.props.subclass === 'playground') playPolys.push(poly[0]);
        if (f.props.class === 'cemetery' || f.props.subclass === 'grave_yard') cemPolys.push(poly[0]); // Runde 204
        if (f.props.class === 'pitch' || f.props.subclass === 'pitch') pitchPolys.push(poly[0]);
        if (/^(park|meadow|grass|village_green|recreation_ground|garden|nature_reserve)$/.test(f.props.class || '') || /^(meadow|garden)$/.test(f.props.subclass || '')) meadowPolys.push(poly[0]); else if (/^(farmland|orchard)$/.test(f.props.class || '') && !tallFields.has(poly[0])) fieldPolys.push(poly[0]); // Runde 213 (220: not under standing crops)
        if (/^(wood|forest)$/.test(f.props.class) || /^(wood|forest)$/.test(f.props.subclass || '')) forestRings.push(poly[0]);
        if (ln === 'park' || /^(park|garden|cemetery)$/.test(f.props.class)) parkRings.push(poly[0]);
        if (dens > 0 && !osm.trees) { // no tree map here: scatter trees over green areas (fallback)
          const fa = t.flatArr, ix = t.idx;
          for (let i = 0; i < ix.length; i += 3) {
            const a = ix[i] * 2, b = ix[i + 1] * 2, c = ix[i + 2] * 2;
            const ar = Math.abs((fa[b] - fa[a]) * (fa[c + 1] - fa[a + 1]) - (fa[c] - fa[a]) * (fa[b + 1] - fa[a + 1])) / 2;
            let cnt = ar * dens; cnt = Math.floor(cnt) + (rnd() < cnt % 1 ? 1 : 0);
            const big = dens >= 1 / 150 ? 1.5 : 1.15; // forest trees larger: closed canopy
            for (let k = 0; k < cnt && k < 400; k++) {
              let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
              const x = fa[a] + u * (fa[b] - fa[a]) + v * (fa[c] - fa[a]), z = fa[a + 1] + u * (fa[b + 1] - fa[a + 1]) + v * (fa[c + 1] - fa[a + 1]);
              treeCand.push(x, z, big + rnd() * 0.7);
            }
          }
        }
      }
    }
  }
  const inResEarly = (x, z) => resPolys.some(q => inPoly(x, z, q));
  // rivers, streams, canals and ditches drawn as lines (Google 3D Oberammergau: the river was missing, only its meadow showed)
  const bankCand = [];
  { const L = layers.waterway; if (L) { const toL = mk(L.extent || ext0), WW = { river: 10, canal: 7, stream: 2.6, ditch: 1.3, drain: 1.3 };
    for (const rng of L.feats) {
      const f = readFeature(L, rng); if (f.type !== 2 || f.props.brunnel === 'tunnel') continue;
      const w = WW[f.props.class]; if (!w) continue;
      for (const line of geomLines(f, toL)) {
        { // the river band only outside lakes: inside it lay 8 mm under the lake surface and showed through as a darker stripe (phone test, Schwangau)
          const inLake = (x, z) => { for (const pl of waterPolys) if (inPoly(x, z, pl[0])) return true; return false; }; let run = [];
          const flush = () => { if (run.length >= 4) ribbon(waterG, run, w, .012 - WL(), WCOL[f.props.class] || WATER) /* all water at one level: figure, wake and rings rely on it (streams at 40 % hid the rings) */; run = []; };
          for (let i = 0; i + 3 < line.length; i += 2) { if (inLake((line[i] + line[i + 2]) / 2, (line[i + 1] + line[i + 3]) / 2)) { flush(); continue; } if (!run.length) run.push(line[i], line[i + 1]); run.push(line[i + 2], line[i + 3]); }
          flush(); }
        waterLines.push(line, w);
        if (w <= 10 && w > 2) sampleLineDir(line, 3.4, (x, z, dx, dz) => { for (const sd of [-1, 1]) bankCand.push(x - dz * (w / 2 + 1.4) * sd, z + dx * (w / 2 + 1.4) * sd); });
      }
    } } }
  // roads
  if (MED) { // Runde 166: ponds - now and then a small water in the middle of a clearing, on level ground, away from settlements
    const [bx0, bz0, bx1, bz1] = MED.box, S = 160;
    for (let i = Math.floor(bx0 / S); i <= Math.floor(bx1 / S); i++) for (let j = Math.floor(bz0 / S); j <= Math.floor(bz1 / S); j++) { const key = i + ',' + j;
      if (hashStr('tp' + key) > .14) continue; const x = (i + .25 + .5 * hashStr('tx' + key)) * S, z = (j + .25 + .5 * hashStr('tz' + key)) * S;
      if (x < bx0 + 32 || x > bx1 - 32 || z < bz0 + 32 || z > bz1 - 32 || MED.vn(x, z) > .32 || MED.townD(x, z) < 1.3 || MED.near(x, z, 90) || waterRings.some(q => inPoly(x, z, q))) continue;
      const R = 7 + hashStr('tr' + key) * 9, ring = []; let h0 = Infinity, h1 = -Infinity;
      for (let k = 0; k < 14; k++) { const a = k / 14 * 6.283, rr = R * (.8 + .4 * hashStr('tq' + key + ',' + k)), px = x + Math.cos(a) * rr * 1.25, pz = z + Math.sin(a) * rr; ring.push(px, pz); const h = weltBase(px, pz); h0 = Math.min(h0, h); h1 = Math.max(h1, h); }
      if (h1 - h0 > 1.2) continue; // a pond needs level ground
      waterG.flat([ring], .02 - WL(), hex('#5e8068')); map.areas.push({ k: 'w', rings: [Float32Array.from(ring)] }); waterRings.push(ring); waterPolys.push([ring]); MED.ponds.push(x, z, R * 1.5); BURG_CLR.push(x, z); } }
  if (MED) { // Runde 165: hamlets - every ~400 m along rivers and streams, now and then a group of 3-5 houses on the dry bank
    for (let k = 0; k < waterLines.length; k += 2) { const line = waterLines[k], w = waterLines[k + 1]; if (w < 2.5) continue;
      sampleLineDir(line, 400, (x, z, dx, dz) => { if (hashStr('hm' + Math.round(x / 50) + ',' + Math.round(z / 50)) > .22) return;
        for (const sd of [-1, 1]) { const hx = x - dz * (w / 2 + 34) * sd, hz = z + dx * (w / 2 + 34) * sd; if (MED.townD(hx, hz) < 1.4 || waterRings.some(q => inPoly(hx, hz, q))) continue;
          if (HAMLETS.some(h => Math.hypot(h.x - hx, h.z - hz) < 300)) return; HAMLETS.push({ x: hx, z: hz, fx: dz * sd, fz: -dx * sd, n: 3 + Math.floor(hashStr('hn' + Math.round(hx)) * 3) }); return; } }); } }
  { const L = layers.transportation; if (L) { const toL = mk(L.extent || ext0);
    for (const rng of L.feats) {
      const f = readFeature(L, rng), cls = f.props.class, sub = f.props.subclass;
      if (MED && f.type === 2 && !/^(primary|secondary|tertiary)$/.test(cls)) { // only streets that serve a settlement; the through roads join them all
        const ok = (x, z) => MED.townD(x, z) < 1.15 || MED.near(x, z, 110), clip = [];
        for (const line of geomLines(f, toL)) { // densify to ~10 m, keep the runs that lie in a settlement or lead to a farm / hamlet
          const pts = []; for (let i = 0; i + 3 < line.length; i += 2) { const n = Math.max(1, Math.ceil(Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]) / 10)); for (let q = 0; q < n; q++) pts.push(line[i] + (line[i + 2] - line[i]) * q / n, line[i + 1] + (line[i + 3] - line[i + 1]) * q / n); }
          pts.push(line[line.length - 2], line[line.length - 1]); let run = [];
          for (let i = 0; i < pts.length; i += 2) { if (ok(pts[i], pts[i + 1])) run.push(pts[i], pts[i + 1]); else { if (run.length >= 4) clip.push(run); run = []; } }
          if (run.length >= 4) clip.push(run); }
        if (!clip.length) continue; f._clip = clip; }
      if (f.props.brunnel !== 'tunnel' && (f.props.layer || 0) < 0 && f.type === 2 && /^(rail|transit|motorway|trunk|primary|secondary)$/.test(cls)) for (const line of geomLines(f, toL)) lowLines.push(line); /* railways and through roads in a cutting (not underground footways) */ // lowered (cutting): bridges over them stay at street level
      if (f.props.brunnel === 'tunnel' && f.type === 2 && ROAD[cls] && !/^(path|track|bridleway|pier)$/.test(cls)) for (const line of geomLines(f, toL)) map.roads.push({ w: ROAD[cls][0], k: 't', p: Float32Array.from(line), a: cls === 'motorway' ? 1 : 0, rail: cls === 'rail' || cls === 'transit' ? 1 : 0, o: +f.props.oneway || 0 }); // tunnels: known to the game (portals), not drawn or driven (Runde 79)
      if (f.props.brunnel === 'tunnel' || (f.props.layer || 0) < 0) continue;
      if (cls === 'pier') { // jetties and piers: plank deck just above the water, posts along the edges
        if (f.type === 3) for (const poly of polygons(geomLines(f, toL))) { const big = Math.abs(ringArea(poly[0])) > 250; ground.flat(poly, .45 - WL(), big ? PONTOON : PLANK); pierLines.push(poly[0], big ? -1 : 0); dryPolys.push(poly); }
        else if (f.type === 2) for (const line of geomLines(f, toL)) { ribbon(ground, line, 2.4, .45 - WL() * .6, PLANK); pierLines.push(line, 2.4); dryLines.push(line, 2.4);
          sampleLineDir(line, 3, (x, z, dx, dz) => { for (const sd of [-1, 1]) ground.box(x - dz * 1.25 * sd, -.4 - WL(), z + dx * 1.25 * sd, .22, .95 + WL() * .4, .22, hex('#4a3a2a')); }); }
        continue; }
      if (f.type === 3) { for (const poly of polygons(geomLines(f, toL))) { dryPolys.push(poly); const t = ground.flat(poly, .03, WELT === 'heute' ? PEDESTRIAN : hex(WELT === 'west' ? '#c9a06a' : WELT === 'cyber' ? '#262638' : '#8f8577')); plazaPolys.push(Float32Array.from(poly[0])); map.areas.push({ k: 'p', rings: [Float32Array.from(poly[0])] }); /* squares for the app (Runde 82: pigeons) */ const fa = t.flatArr, ix = t.idx;
          for (let i = 0; i < ix.length; i += 3) { const a = ix[i] * 2, b = ix[i + 1] * 2, c = ix[i + 2] * 2; // squares and pedestrian zones count as street
            for (let u = 0; u <= 1; u += .2) for (let v = 0; u + v <= 1; v += .2) roadGrid.add(rg(fa[a] + u * (fa[b] - fa[a]) + v * (fa[c] - fa[a]), fa[a + 1] + u * (fa[b + 1] - fa[a + 1]) + v * (fa[c + 1] - fa[a + 1]))); } } continue; }
      if (f.type !== 2) continue;
      let spec = ROAD[cls]; if (!spec) continue;
      if (cls === 'path' && (sub === 'pedestrian' || sub === 'living_street')) spec = [5, '#c2b59c', .05];
      if (cls === 'minor' && sub === 'living_street') spec = [5, '#b9ad97', .05];
      spec = weltRoad(cls, sub, spec); if (!spec) continue;
      const isBr = f.props.brunnel === 'bridge', RG = isBr ? bridgeG : ground; // bridges: own geometry that keeps the terrain height over troughs
      const w0 = spec[0], col = hex(spec[1]), y = spec[2] + (isBr ? .06 : 0); // deck above everything at ground level (it crosses over it)
      const walk0 = /^(minor|tertiary|secondary|primary)$/.test(cls) && sub !== 'living_street' && !isBr;
      for (let line of geomLines(f, toL)) { let w = w0, walk = walk0, swSide = 0; /* swSide: 0 both, +1 / -1 only on that side of the ribbon normal */
        if (strIdx.size && !/^(rail|transit|path|track|bridleway|pier)$/.test(cls)) { const xs = crossSection(line, strIdx, w0); STS.lines++;
          if (xs.src) { STS.wset++; STS.dw += xs.w - w0; w = xs.w; }
          if (xs.sideP !== null && !isBr && cls !== 'motorway' && cls !== 'trunk') { STS.swset++; walk = xs.sideP || xs.sideM; swSide = xs.sideP && xs.sideM ? 0 : xs.sideP ? 1 : xs.sideM ? -1 : 0; } }
        if (WELT !== 'heute') walk = false;
        if (LEVEL_ROADS && !isBr && w >= 3 && !/^(rail|transit|path|track|bridleway)$/.test(cls)) { // a street that gets levelled: points every 10 m, so it follows the terrain along
          const a = w / 2 + (walk ? 2.3 : 0); let steep = false, gmax = 0;
          for (let i = 0; i + 3 < line.length; i += 2) { const L = Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]); if (L < .5) continue; const nx = -(line[i + 3] - line[i + 1]) / L, nz = (line[i + 2] - line[i]) / L;
            for (const t of [.25, .5, .75]) { const mx = line[i] + (line[i + 2] - line[i]) * t, mz = line[i + 1] + (line[i + 3] - line[i + 1]) * t; const g = Math.abs(hAt(mx + nx * a, mz + nz * a) - hAt(mx - nx * a, mz - nz * a)) / (2 * a); gmax = Math.max(gmax, g); if (g > .08) steep = true; } }
          // (narrowing steep roads to 75 % was dropped: neighbouring OSM ways of one road got different widths, notches at the joints) // are narrower than their class suggests (Heidelberg Neue Schlossstrasse: one lane)
          if (steep) { const d = [line[0], line[1]]; for (let i = 0; i + 3 < line.length; i += 2) { const L = Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]), n = Math.max(1, Math.ceil(L / 10)); for (let k = 1; k <= n; k++) d.push(line[i] + (line[i + 2] - line[i]) * k / n, line[i + 1] + (line[i + 3] - line[i + 1]) * k / n); } line = d; } }
        if (isBr) for (let i = 0; i + 3 < line.length; i += 2) { // bridge: stone parapets on both sides (not on railway bridges), deck slab underneath
          const x0 = line[i], z0 = line[i + 1], x1 = line[i + 2], z1 = line[i + 3], L = Math.hypot(x1 - x0, z1 - z0); if (L < .3) continue;
          const dx = (x1 - x0) / L, dz = (z1 - z0) / L, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, o = w / 2 + .25, PAR = hex('#9a958b');
          if (cls !== 'rail' && cls !== 'transit') { for (const sd of [-1, 1]) obox(bridgeG, mx - dz * o * sd, 0, mz + dx * o * sd, L + .05, .95, .3, dx, dz, PAR); railSegs.push(x0, z0, x1, z1, o); } // railings: also solid in the game
          if (!/^(path|track|bridleway)$/.test(cls)) obox(bridgeG, mx, -1.1, mz, L + .05, 1.1, w + (cls === 'rail' || cls === 'transit' ? 3 : .8), dx, dz, hex('#8e8b84'));
        }
        if (!isBr && !/^(rail|transit|path|track|bridleway|pier)$/.test(cls)) { drvLines.push(line); drvA.push(w / 2 + (walk ? 2.3 : 0)); }
        const lineSeg = []; // per segment of this line: index into corrSegs when the segment is levelled, else -1
        if (!isBr && w >= 3 && !/^(rail|transit|path|track|bridleway)$/.test(cls)) for (let i = 0; i + 3 < line.length; i += 2) { lineSeg[i / 2] = -1; // streets level across on slopes: segments with > 4 % cross slope
          const x0 = line[i], z0 = line[i + 1], x1 = line[i + 2], z1 = line[i + 3], L = Math.hypot(x1 - x0, z1 - z0); if (L < .5) continue;
          const a = w / 2 + (walk ? 2.3 : 0), nx = -(z1 - z0) / L, nz = (x1 - x0) / L, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          const gs = (hAt(mx + nx * a, mz + nz * a) - hAt(mx - nx * a, mz - nz * a)) / (2 * a); if (LEVEL_ROADS && Math.abs(gs) > .08) lineSeg[i / 2] = -2; }
        if (lineSeg.includes(-2)) for (let i = 0; i + 3 < line.length; i += 2) { if (Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]) < .5) { lineSeg[i / 2] = -1; continue; } lineSeg[i / 2] = corrSegs.length; const a = w / 2 + (walk ? 2.3 : 0), L = Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]), nx = -(line[i + 3] - line[i + 1]) / L, nz = (line[i + 2] - line[i]) / L, mx = (line[i] + line[i + 2]) / 2, mz = (line[i + 1] + line[i + 3]) / 2;
          const gs = Math.abs(hAt(mx + nx * a, mz + nz * a) - hAt(mx - nx * a, mz - nz * a)) / (2 * a); corrSegs.push(line[i], line[i + 1], line[i + 2], line[i + 3], a, Math.min(1, 2.4 / Math.max(1e-3, gs * a))); } /* k: share of the cross slope taken out, so the edge stays below ~2.4 m (steep Rhine slopes) */ // the whole street level, not only the steep pieces: no steps where the slope crosses 4 % // gs: cross slope along the normal
        if (isBr && !/^(path|track|bridleway|pier|rail|transit)$/.test(cls)) brLines.push({ line, w, cls, layer: +f.props.layer || 1 }); /* road bridges only: railway approaches get no ramp from the height raster */ else if (!isBr) allLines.push({ line, cls, w }); else if (/^(path|track|bridleway)$/.test(cls)) sideBr.push({ line, w, cls }); // footbridges: lifted with a raised road bridge they run along (Runde 79)
        if (isBr && cls !== 'pier') spanLines.push({ line, w, cls }); if (isBr && /^(path|track|bridleway)$/.test(cls)) pathBr.push({ line, w, cls, layer: +f.props.layer || 1 }); // Runde 83: deck spans, footbridges over expressways
        if (isBr) bridgeDry.push(line, w + 1); else dryLines.push(line, w + 1); // every street and path is walkable, also where OSM water lies underneath (promenades on flood walls, Baumwall); bridges: walkable, but the water flows on underneath
        if (f.props.brunnel === 'bridge') sampleLine(line, 2, (x, z) => { const k = bk(Math.floor(x / 8), Math.floor(z / 8)); let a = bridgeGrid.get(k); if (!a) bridgeGrid.set(k, a = []); a.push(x, z); }); // bridges: LoD2 decks over them are no houses
        if (cls !== 'rail' && cls !== 'transit' && cls !== 'path' && cls !== 'track') sampleLineDir(line, 2, (x, z, dx, dz) => { const k = rdk(x, z); let a = rdir.get(k); if (!a) rdir.set(k, a = []); a.push([x, z, dx, dz, w, y]); });
        if (walk || cls === 'minor' || cls === 'service') sampleLineDir(line, 2.2, (x, z, dx, dz) => { for (const sd of [-1, 1]) { const off = w / 2 + (walk ? 3.3 : 1.3); /* property line right behind the sidewalk */ hedgeCand.push(x - dz * off * sd, z + dx * off * sd); } });
        const tg0 = ground.p.length / 9, tw0 = glow.p.length / 9; // street surfaces drawn from here on get tagged with their segment
        if (walk) { // sidewalks with a curb on both sides, and street lamps on them
          walkLines.push(line, w, cls);
          if (swSide) { const sl = offsetLine(line, swSide * 1.15); ribbon(ground, sl, w + 2.3, .033, SIDEWALK); ribbon(ground, line, w + 0.5, .036, CURB); }
          else { ribbon(ground, line, w + 4.6, .033, SIDEWALK);
          ribbon(ground, line, w + 0.5, .036, CURB); }
          let side = 1;
          if (synthLamps) sampleLineDir(line, 27, (x, z, dx, dz) => {
            const off = w / 2 + 1.7, px = x - dz * off * side, pz = z + dx * off * side; side = -side;
            ground.box(px, 0, pz, .16, 4.2, .16, POLE);
            glow.box(px, 4.1, pz, .55, .32, .55, LAMP); glow.quad([px - .27, 4.1, pz - .27], [px + .27, 4.1, pz - .27], [px + .27, 4.1, pz + .27], [px - .27, 4.1, pz + .27], LAMP, 0, -1, 0);
          });
        }
        if (cls === 'transit' && sub === 'tram') { /* Runde 90: tram tracks in the street - a grey track bed above the carriageway (it lay below it,
           invisible in streets) and two steel rails, 1435 mm gauge: two more ribbons per tram line */
          ribbon(RG, line, 2.6, .105 + (isBr ? .06 : 0), TRAMBED); for (const sd of [-1, 1]) ribbon(RG, offsetLine(line, sd * .72), .14, .111 + (isBr ? .06 : 0), TRAMRAIL); }
        else ribbon(RG, line, w, y, col);
        { const rr = (cls === 'path' || cls === 'track') ? 0 : Math.ceil((w / 2 + 1.5) / 3); /* footpaths: trees may stand right next to them */ sampleLine(line, 2.5, (x, z) => { const ix = Math.floor(x / 3), iz = Math.floor(z / 3); for (let a = -rr; a <= rr; a++) for (let b = -rr; b <= rr; b++) roadCells.add((ix + a) * 100003 + iz + b); if (cls !== 'rail' && cls !== 'transit') roadGrid.add(rg(x, z)); }); }
        if (w >= 7 && cls !== 'rail' && (WELT === 'heute' || WELT === 'cyber')) dashes(RG, line, y + .012);
        if (lineSeg.some(v => v >= 0)) { tagStreet(ground, tg0, line, lineSeg); tagStreet(glow, tw0, line, lineSeg); }
        else if (!isBr) for (const [G, t0] of [[ground, tg0], [glow, tw0]]) { if (!G.lv) G.lv = new Map(); for (let t = t0; t < G.p.length / 9; t++) G.lv.set(t, -2); } // street that is not levelled: never cut or lowered (it forms the junction)
        map.roads.push({ w, k: cls === 'rail' || cls === 'transit' ? 'r' : (cls === 'path' || cls === 'track' ? 'p' : 'm'), p: Float32Array.from(line), o: +f.props.oneway || 0, a: cls === 'motorway' ? 1 : 0, t: cls === 'trunk' ? 1 : 0, r: +f.props.ramp || 0, b: f.props.brunnel ? 1 : 0, rk: cls === 'transit' ? (sub === 'tram' ? 1 : 2) : cls === 'rail' ? (f.props.service ? 4 : 3) : 0 }); // rk (Runde 91): 1 tram, 2 U-/Stadtbahn, 3 main line, 4 siding/yard // o: one-way; t: trunk road (Kraftfahrstrasse), r: ramp (Runde 83) (1 along, -1 against the line), a: motorway (Runde 76)
        if (cls === 'minor' || cls === 'service' || cls === 'path' || cls === 'tertiary') sampleLine(line, 22, (x, z) => spawn.push(x, z));
        if ((/^(minor|tertiary|secondary|primary)$/.test(cls) || (cls === 'path' && sub === 'pedestrian')) && f.props.brunnel !== 'bridge') sampleLine(line, 8, (x, z) => start.push(x, z)); // start points: middle of real streets only
      }
    } } }
  /* Runde 51: raised bridges (phone test Bielefeld Stapenhorststrasse: the Ostwestfalendamm runs on a viaduct 6 m above the street and
     its junction; the game had both on one level). A bridge that crosses a street, path or railway where no trough was dug (junctions
     under it, long viaducts) is lifted 5.5 m; connected bridge pieces too; the roads leading on get an embankment ramp (6 %) through
     the height raster; piers every 18 m, never on a carriageway. */
  const RAISE = 5.5, raised = [], elevSegs = [], Lr0 = RAISE / .06, tileKey = tx + '/' + ty;
  const tb = (() => { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0); return [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1])]; })();
  /* Runde 87 (Bremen Hochstrasse Breitenweg: the deck sagged 2-3 m at a tile border): a tile sees its neighbours' lines only clipped (a
     buffer around its own square), so its deck there has a different height (other chain ends). Decks over the tile's own square are
     marked as its own (half width > 0), the others as foreign (< 0): the game takes a foreign deck only where the owner has none */
  const ownP = (p, m = 0) => p[0] >= tb[0] - m && p[0] <= tb[2] + m && p[1] >= tb[1] - m && p[1] <= tb[3] + m;
  /* embankment ramps on the roads that continue from a raised end (following connected lines, most aligned first, up to 92 m).
     Runde 79: a ramp that reaches the edge of the tile is handed over (PENDR) - the neighbour tile carries it on (motorway A2 at
     Bielefeld: the road dropped 4 m within 9 m where the ramp stopped at the tile border) */
  const rampChains = ends => { const nearP = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5;
    // Runde 79 (Bielefeld Ostring: the cycle path on the bridge dropped 4 m at its end): footpaths and cycle paths that go on get the ramp too
    const PL = allLines.filter(o => /^(path|track|bridleway)$/.test(o.cls)).map(o => o.line);
    for (const e of ends) { let cur = e.p, ddx = e.dx, ddz = e.dz, got = e.got || 0; const used = new Set(), usedP = new Set(); let moved = false;
      /* Runde 87 (Bremen Hauptbahnhof: the tile never finished - a ramp kept picking the copy it had just made of a zero-length line,
         drvLines grew by one each turn, for ever): only the tile's own lines are followed (not the ramp copies), zero-length lines are
         skipped, at most 200 steps */
      const n0 = drvLines.length; let steps = 0;
      while (got < Lr0 && steps++ < 200) { let best = null, bs = -2;
        for (const [src, arr, us] of [[0, drvLines, used], [1, PL, usedP]]) for (let li = 0; li < (src ? arr.length : n0); li++) { if (us.has(li)) continue; const L = arr[li]; if (L.length < 4) continue; const a = [L[0], L[1]], z = [L[L.length - 2], L[L.length - 1]];
          for (const [q, rev] of [[a, false], [z, true]]) { if (!nearP(q, cur)) continue; const nx = rev ? L[L.length - 4] - L[L.length - 2] : L[2] - L[0], nz = rev ? L[L.length - 3] - L[L.length - 1] : L[3] - L[1], c = (nx * ddx + nz * ddz) / ((Math.hypot(nx, nz) * Math.hypot(ddx, ddz)) || 1); if (c > bs) { bs = c; best = { li, rev, src }; } } }
        if (!best || bs < .3) { // nothing goes on here: at the tile edge hand the rest over to the neighbour
          if (moved || e.got === undefined) { const m = 14; if (cur[0] < tb[0] + m || cur[0] > tb[2] - m || cur[1] < tb[1] + m || cur[1] > tb[3] - m) if (!PENDR.some(q => q.from === tileKey && Math.hypot(q.p[0] - cur[0], q.p[1] - cur[1]) < 1)) PENDR.push({ p: cur, dx: ddx, dz: ddz, got, from: tileKey }); }
          break; }
        (best.src ? usedP : used).add(best.li); moved = true; const L0 = best.src ? PL[best.li] : drvLines[best.li], L = best.rev ? (() => { const r = []; for (let i = L0.length - 2; i >= 0; i -= 2) r.push(L0[i], L0[i + 1]); return r; })() : Array.from(L0);
        let len = 0; for (let i = 0; i + 3 < L.length; i += 2) len += Math.hypot(L[i + 2] - L[i], L[i + 3] - L[i + 1]);
        if (len < .05) continue; // (marked used above: never again)
        const E = RAISE * Math.max(0, 1 - got / Lr0); drvLines.push(L); drvA.push(best.src ? 1.6 : drvA[best.li]); (drvLines.ramps = drvLines.ramps || [])[drvLines.length - 1] = { E, Lr: Lr0 - got };
        got += len; cur = [L[L.length - 2], L[L.length - 1]]; ddx = L[L.length - 2] - L[L.length - 4]; ddz = L[L.length - 1] - L[L.length - 3]; } } };
  if (TERRAIN_ON && (brLines.length || pathBr.length)) {
    const DLt = (() => { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0); return dipsIn(Math.min(c0[0], c1[0]) - 200, Math.min(c0[1], c1[1]) - 200, Math.max(c0[0], c1[0]) + 200, Math.max(c0[1], c1[1]) + 200); })();
    const segX = (a, b, c, d) => { const ex = b[0] - a[0], ez = b[1] - a[1], fx = d[0] - c[0], fz = d[1] - c[1], den = ex * fz - ez * fx; if (Math.abs(den) < 1e-9) return null;
      const t = ((c[0] - a[0]) * fz - (c[1] - a[1]) * fx) / den, u = ((c[0] - a[0]) * ez - (c[1] - a[1]) * ex) / den; return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + ex * t, a[1] + ez * t] : null; };
    /* Runde 83 (Bielefeld Ostwestfalendamm: the Haller Weg bridge and footbridges crossed the expressway at its own level): a bridge over a
       motorway or trunk road (Kraftfahrstrasse) is lifted whatever its own class and length - footbridges included (they were never lifted) */
    const FASTL = allLines.filter(o => /^(motorway|trunk)$/.test(o.cls)).map(o => o.line);
    const crossFast = L => { for (const M of FASTL) for (let i = 0; i + 3 < L.length; i += 2) for (let j = 0; j + 3 < M.length; j += 2) if (segX([L[i], L[i + 1]], [L[i + 2], L[i + 3]], [M[j], M[j + 1]], [M[j + 2], M[j + 3]])) return true; return false; };
    for (const b of pathBr) if (crossFast(b.line)) brLines.push(Object.assign({ path: true }, b));
    const isRaised = new Array(brLines.length).fill(false);
    brLines.forEach((b, bi) => { const L = b.line; const hE = Math.min(hAt(L[0], L[1]), hAt(L[L.length - 2], L[L.length - 1]));
      const cum = [0]; for (let i = 0; i + 3 < L.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(L[i + 2] - L[i], L[i + 3] - L[i + 1])); const tot = cum[cum.length - 1];
      if (b.layer >= 2 && tot >= 40) { const mx = L[Math.floor(L.length / 4) * 2], mz = L[Math.floor(L.length / 4) * 2 + 1]; if (hE - hAt(mx, mz) <= 3) { isRaised[bi] = true; (self.RAISEDWHY = self.RAISEDWHY || []).push(toLatLon(mx, mz).map(v => +v.toFixed(5)).concat(['layer' + b.layer])); } } // layer 2+: above something that is itself raised or a square (Hannover Raschplatzhochstrasse)
      for (const o of allLines) { if (isRaised[bi]) break; const M = o.line;
        for (let i = 0; i + 3 < L.length && !isRaised[bi]; i += 2) for (let j = 0; j + 3 < M.length; j += 2) {
          const c = segX([L[i], L[i + 1]], [L[i + 2], L[i + 3]], [M[j], M[j + 1]], [M[j + 2], M[j + 3]]); if (!c) continue;
          { const sc = cum[i / 2] + Math.hypot(c[0] - L[i], c[1] - L[i + 1]); if (sc < 8 || tot - sc < 8) continue; } // at the abutment: a junction at the bridge end, nothing passes under (Ludwigshafen harbour bridge)
          { const sc = cum[i / 2] + Math.hypot(c[0] - L[i], c[1] - L[i + 1]), hl = hAt(L[0], L[1]) + (hAt(L[L.length - 2], L[L.length - 1]) - hAt(L[0], L[1])) * sc / tot; if (hl - hAt(c[0], c[1]) > 3) continue; } // a valley under a viaduct: room enough already (Runde 83: against the line between the ends, not the lower end - a bridge leaving a dam was lifted)
          if (dipAtList(DLt, c[0], c[1]) > 1) continue; // the street below was dug into a trough: the bridge stays where it is
          isRaised[bi] = true; if (!/^(path|track|bridleway)$/.test(o.cls)) b.road = true; if (/^(motorway|trunk)$/.test(o.cls)) b.overFast = true; (self.RAISEDWHY = self.RAISEDWHY || []).push(toLatLon(c[0], c[1]).map(v => +v.toFixed(5)).concat([o.cls])); break; } } });
    brLines.forEach((b, bi) => { if (!isRaised[bi] || b.overFast) return; const L = b.line, hE = Math.min(hAt(L[0], L[1]), hAt(L[L.length - 2], L[L.length - 1])); // a motorway/trunk road really passes under (same tests as above)
      const cum = [0]; for (let i = 0; i + 3 < L.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(L[i + 2] - L[i], L[i + 3] - L[i + 1])); const tot = cum[cum.length - 1];
      for (const M of FASTL) for (let i = 0; i + 3 < L.length && !b.overFast; i += 2) for (let j = 0; j + 3 < M.length; j += 2) { const c = segX([L[i], L[i + 1]], [L[i + 2], L[i + 3]], [M[j], M[j + 1]], [M[j + 2], M[j + 3]]); if (!c) continue;
        const sc = cum[i / 2] + Math.hypot(c[0] - L[i], c[1] - L[i + 1]); if (sc < 8 || tot - sc < 8) continue; if (hAt(L[0], L[1]) + (hAt(L[L.length - 2], L[L.length - 1]) - hAt(L[0], L[1])) * sc / tot - hAt(c[0], c[1]) > 3) continue; if (dipAtList(DLt, c[0], c[1]) > 1) continue; b.overFast = true; break; } });
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5, ends = b => [[b.line[0], b.line[1]], [b.line[b.line.length - 2], b.line[b.line.length - 1]]];
    for (let changed = true; changed;) { changed = false; brLines.forEach((b, i) => { if (isRaised[i]) return; for (let j = 0; j < brLines.length; j++) if (isRaised[j] && ends(b).some(p => ends(brLines[j]).some(q => near(p, q)))) { isRaised[i] = true; changed = true; break; } }); }
    { /* systematic test (Runde 52): streets over railways and motorways in a cutting were humped (Hamburg Altmannbruecke, Berlin Kaiserdamm).
         Raised only: groups with a motorway/trunk (or their ramps) or 250 m and more of bridge; never over a lowered line (layer < 0) */
      const grp = new Array(brLines.length).fill(-1); let ng = 0;
      for (let i = 0; i < brLines.length; i++) { if (!isRaised[i] || grp[i] >= 0) continue; const st = [i]; grp[i] = ng;
        while (st.length) { const a = st.pop(); for (let j = 0; j < brLines.length; j++) if (isRaised[j] && grp[j] < 0 && ends(brLines[a]).some(p => ends(brLines[j]).some(q => near(p, q)))) { grp[j] = ng; st.push(j); } } ng++; }
      const lineLen = L => { let l = 0; for (let k = 0; k + 3 < L.length; k += 2) l += Math.hypot(L[k + 2] - L[k], L[k + 3] - L[k + 1]); return l; };
      for (let g = 0; g < ng; g++) { const mem = brLines.map((b, i) => [b, i]).filter(([, i]) => grp[i] === g); let len = 0, fast = false, low = false, road = false;
        let lay2 = false; const totLen = mem.reduce((a, [b]) => a + lineLen(b.line), 0); for (const [b] of mem) { len += lineLen(b.line); if (b.road) road = true; if (b.layer >= 2) lay2 = true; if (b.cls === 'motorway' || b.cls === 'trunk' || b.overFast) fast = true;
          const L = b.line; if (!(b.layer >= 2 && totLen >= 250)) for (const M of lowLines) { if (low) break; for (let i = 0; i + 3 < L.length && !low; i += 2) for (let j = 0; j + 3 < M.length; j += 2) if (segX([L[i], L[i + 1]], [L[i + 2], L[i + 3]], [M[j], M[j + 1]], [M[j + 2], M[j + 3]])) { low = true; break; } } }
        if (lay2 && len >= 250) fast = true; /* layer 2+ only on long viaducts (Hannover Raschplatz ~1 km; Berlin Kaiserdamm is layer 2 over a U-Bahn bridge, short) */
        let wet = 0, nsm = 0; if (!road && len >= 250) for (const [b] of mem) sampleLine(b.line, 10, (x, z) => { nsm++; for (const pl of waterPolys) if (inPoly(x, z, pl[0])) { wet++; break; } });
        const overLand = nsm > 0 && wet / nsm < .3; /* a long viaduct over land (Hamburg B4 Hochstrasse runs along above the street) vs. a river bridge with a bank path under it (Dresden, Frankfurt) */
        if (low || !(fast || (len >= 250 && (road || overLand)))) for (const [, i] of mem) isRaised[i] = false; } } // a long river bridge over a bank path only: stays at street level (Frankfurt Floesserbruecke)
    /* Runde 79 (Bielefeld Ostring: the cycle path is mapped as its own bridge beside the road bridge - the road went up, the path stayed
       down and lay half inside the raised deck, a 4 m step): bridges that run alongside a raised one (>= 70 % of their length within
       its width + 6 m, roughly parallel) are lifted with it - sidewalks, cycle paths, separately mapped carriageways */
    { const rl = brLines.filter((b, i) => isRaised[i]); const along = b => { let n = 0, ok = 0; const L = b.line;
        sampleLineDir(L, 3, (x, z, dx, dz) => { n++; for (const r of rl) { const M = r.line; for (let j = 0; j + 3 < M.length; j += 2) { const ex = M[j + 2] - M[j], ez = M[j + 3] - M[j + 1], l2 = ex * ex + ez * ez; if (l2 < .01) continue;
          const u = Math.max(0, Math.min(1, ((x - M[j]) * ex + (z - M[j + 1]) * ez) / l2)); if (Math.hypot(M[j] + ex * u - x, M[j + 1] + ez * u - z) < r.w / 2 + 6 && Math.abs(ex * dx + ez * dz) / Math.sqrt(l2) > .8) { ok++; return; } } } });
        return n > 0 && ok / n >= .7; };
      if (rl.length) { brLines.forEach((b, i) => { if (!isRaised[i] && along(b)) isRaised[i] = true; }); for (const b of sideBr) if (along(b)) { brLines.push(Object.assign({ layer: 1, side: true }, b)); isRaised.push(true); } } }
    brLines.forEach((b, i) => { if (!isRaised[i]) return; raised.push(b); }); // Runde 83: the deck of a raised bridge is a spanning deck (below), 5.5 m above the line between its ends
    /* Runde 79: at a free end (abutment) the deck reaches 3 m onto the ramp - the 4 m height raster rounds the top of the ramp off there
       (a 1 m step when driving off the bridge) */
    /* Runde 84 (OWD: carriageway bridge and slip-road bridge merge at one node, both coming from behind - neither end got its ramp, a 4.7 m
       step): an end is inside the raised structure only if another raised line goes ON forward from it */
    const goesOn = (b, p, k) => { const L = b.line, ox = k ? L[L.length - 2] - L[L.length - 4] : L[0] - L[2], oz = k ? L[L.length - 1] - L[L.length - 3] : L[1] - L[3];
      return raised.some(o => { if (o === b) return false; const M = o.line; for (const [q, n] of [[[M[0], M[1]], [M[2], M[3]]], [[M[M.length - 2], M[M.length - 1]], [M[M.length - 4], M[M.length - 3]]]]) if (near(p, q) && ((n[0] - q[0]) * ox + (n[1] - q[1]) * oz) > 0) return true; return false; }); };
    for (const b of raised) { const L = b.line; for (const k of [0, 1]) { const p = k ? [L[L.length - 2], L[L.length - 1]] : [L[0], L[1]], q = k ? [L[L.length - 4], L[L.length - 3]] : [L[2], L[3]];
      if (goesOn(b, p, k)) continue; const dx = p[0] - q[0], dz = p[1] - q[1], l = Math.hypot(dx, dz) || 1;
      elevSegs.push(p[0], p[1], p[0] + dx / l * 3, p[1] + dz / l * 3, b.w / 2 + 1.6, RAISE); } }
    // embankment ramps on the roads that continue from a raised end (following connected lines, most aligned first, up to 92 m)
    const Lr = RAISE / .06, rEnds = []; for (const b of raised) for (const [p, k] of [[ends(b)[0], 0], [ends(b)[1], 1]]) { if (goesOn(b, p, k)) continue; const L = b.line, i = k ? L.length - 4 : 2; rEnds.push({ p, dx: k ? L[L.length - 2] - L[L.length - 4] : L[0] - L[2], dz: k ? L[L.length - 1] - L[L.length - 3] : L[1] - L[3] }); }
    /* Runde 79 (systematic test of motorway interchanges): at the end of a raised bridge often several roads go on (slip roads branch
       off); only the best aligned one got a ramp, the others dropped 5.5 m. Now every road leaving the end forwards starts a ramp chain */
    { const extra = []; for (const e of rEnds) { const firsts = [];
        for (let li = 0; li < drvLines.length; li++) { const L = drvLines[li]; for (const [q, rev] of [[[L[0], L[1]], false], [[L[L.length - 2], L[L.length - 1]], true]]) { if (!near(q, e.p)) continue;
          const nx = rev ? L[L.length - 4] - L[L.length - 2] : L[2] - L[0], nz = rev ? L[L.length - 3] - L[L.length - 1] : L[3] - L[1], c = (nx * e.dx + nz * e.dz) / ((Math.hypot(nx, nz) * Math.hypot(e.dx, e.dz)) || 1);
          if (c > .15 && !raised.some(b => b.line === L)) firsts.push([c, nx, nz]); } }
        firsts.sort((a, b) => b[0] - a[0]); for (const f of firsts.slice(1)) extra.push({ p: e.p, dx: f[1], dz: f[2] }); }
      rEnds.push(...extra); }
    rampChains(rEnds);
    // piers under the raised decks
    const PIER = hex('#a8a59e'); for (const b of raised) sampleLineDir(b.line, 18, (x, z, dx, dz) => { if (onRoad(x, z) || fpAt(x, z)) return; obox(ground, x, 0, z, 1.0, RAISE - 1.1, Math.min(b.w * .6, 6), dx, dz, PIER); });
  }
  if (TERRAIN_ON) { const m = 16, inc = PENDR.filter(e => e.from !== tileKey && e.p[0] > tb[0] - m && e.p[0] < tb[2] + m && e.p[1] > tb[1] - m && e.p[1] < tb[3] + m);
    for (const e of inc) { // pick the ramp up on our own line where it passes the handed-over point (tiles overlap: line ends differ)
      const dl = Math.hypot(e.dx, e.dz) || 1; let best = null, bd = 6;
      for (let li = 0; li < drvLines.length; li++) { const L = drvLines[li]; for (let i = 0; i + 3 < L.length; i += 2) { const ex = L[i + 2] - L[i], ez = L[i + 3] - L[i + 1], l2 = ex * ex + ez * ez; if (l2 < .01) continue;
          const u = Math.max(0, Math.min(1, ((e.p[0] - L[i]) * ex + (e.p[1] - L[i + 1]) * ez) / l2)), d = Math.hypot(L[i] + ex * u - e.p[0], L[i + 1] + ez * u - e.p[1]), c = (ex * e.dx + ez * e.dz) / (Math.sqrt(l2) * dl);
          if (d < bd && Math.abs(c) > .5) { bd = d; best = { li, i, u, rev: c < 0 }; } } }
      if (!best) continue; const L0 = drvLines[best.li], px = L0[best.i] + (L0[best.i + 2] - L0[best.i]) * best.u, pz = L0[best.i + 1] + (L0[best.i + 3] - L0[best.i + 1]) * best.u, sub = [px, pz];
      if (!best.rev) for (let k = best.i + 2; k < L0.length; k += 2) sub.push(L0[k], L0[k + 1]); else for (let k = best.i; k >= 0; k -= 2) sub.push(L0[k], L0[k + 1]);
      if (sub.length < 4) continue; let len = 0; for (let k = 0; k + 3 < sub.length; k += 2) len += Math.hypot(sub[k + 2] - sub[k], sub[k + 3] - sub[k + 1]);
      drvLines.push(sub); drvA.push(drvA[best.li]); (drvLines.ramps = drvLines.ramps || [])[drvLines.length - 1] = { E: RAISE * Math.max(0, 1 - e.got / Lr0), Lr: Lr0 - e.got };
      if (e.got + len < Lr0) rampChains([{ p: [sub[sub.length - 2], sub[sub.length - 1]], dx: sub[sub.length - 2] - sub[sub.length - 4], dz: sub[sub.length - 1] - sub[sub.length - 3], got: e.got + len }]); } }
  /* Runde 83 (Ostwestfalendamm: on the dam the road dipped to street level at every underpass): a bridge follows the natural terrain only
     where the ground under it is not lower than the line between its two ends - over an underpass, a valley or a river the deck spans
     straight from abutment to abutment. Bridges of one chain (OSM splits them) count as one; lifted bridges keep their +5.5 m */
  const spanSegs = [], upRamps = [];
  if (TERRAIN_ON && spanLines.length) { const rset = new Set(raised.map(b => b.line)), SL = spanLines, nr = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5;
    const E = SL.map(b => [[b.line[0], b.line[1]], [b.line[b.line.length - 2], b.line[b.line.length - 1]]]), dirOut = (i, k) => { const L = SL[i].line; return k ? [L[L.length - 2] - L[L.length - 4], L[L.length - 1] - L[L.length - 3]] : [L[0] - L[2], L[1] - L[3]]; },
      nb = (i, k) => { const o = [], a = dirOut(i, k); for (let j = 0; j < SL.length; j++) if (j !== i) for (const kk of [0, 1]) if (nr(E[i][k], E[j][kk])) { const b = dirOut(j, kk); if (-(a[0] * b[0] + a[1] * b[1]) / ((Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1])) || 1) > .3) o.push([j, kk]); } return o; }; // Runde 84: only a bridge that goes ON (not two that merge from behind, a V) continues the chain
    const used = new Set();
    const chainFrom = (i0, k0) => { const pts = [], ws = []; let i = i0, k = k0, up = false, rail = false; // k: the end we enter by; up: a raised bridge in the chain
      while (i !== undefined && !used.has(i)) { used.add(i); if (rset.has(SL[i].line)) up = true; if (/^(rail|transit)$/.test(SL[i].cls)) rail = true; const L = SL[i].line, seq = []; if (k === 0) for (let q = 0; q < L.length; q += 2) seq.push([L[q], L[q + 1]]); else for (let q = L.length - 2; q >= 0; q -= 2) seq.push([L[q], L[q + 1]]);
        for (const p of (pts.length ? seq.slice(1) : seq)) { pts.push(p); ws.push(SL[i].w); }
        const out = nb(i, 1 - k); if (out.length !== 1 || nb(out[0][0], out[0][1]).length !== 1) break; [i, k] = out[0]; }
      return { pts, ws, up, rail }; };
    const chains = []; for (let i = 0; i < SL.length; i++) for (const k of [0, 1]) if (!used.has(i) && nb(i, k).length !== 1) chains.push(chainFrom(i, k));
    for (let i = 0; i < SL.length; i++) if (!used.has(i)) chains.push(chainFrom(i, 0));
    /* Runde 84 (Essen A40 in its cutting: the bridges over it lay down in the cutting - their mapped pieces end on the slopes): over a
       motorway, trunk road or railway the deck keeps 4.7 m above that line (its trough included), falling off at most 10 % towards the ends */
    const DLs = (() => { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0); return dipsIn(Math.min(c0[0], c1[0]) - 200, Math.min(c0[1], c1[1]) - 200, Math.max(c0[0], c1[0]) + 200, Math.max(c0[1], c1[1]) + 200); })();
    const UNDER = allLines.filter(o => /^(motorway|trunk|rail|transit)$/.test(o.cls)).map(o => o.line);
    const sX = (a, b, c, d) => { const ex = b[0] - a[0], ez = b[1] - a[1], fx = d[0] - c[0], fz = d[1] - c[1], den = ex * fz - ez * fx; if (Math.abs(den) < 1e-9) return null;
      const t = ((c[0] - a[0]) * fz - (c[1] - a[1]) * fx) / den, u = ((c[0] - a[0]) * ez - (c[1] - a[1]) * ex) / den; return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null; };
    for (const ch of chains) { const P0 = ch.pts; if (P0.length < 2 || ch.rail) continue; const req = []; let acc = 0; // railway bridges: the line below is dug in instead (Runde 83)
      for (let i = 0; i + 1 < P0.length; i++) { const sl = Math.hypot(P0[i + 1][0] - P0[i][0], P0[i + 1][1] - P0[i][1]);
        for (const M of UNDER) for (let j = 0; j + 3 < M.length; j += 2) { const t = sX(P0[i], P0[i + 1], [M[j], M[j + 1]], [M[j + 2], M[j + 3]]); if (t === null) continue;
          const cx = P0[i][0] + (P0[i + 1][0] - P0[i][0]) * t, cz = P0[i][1] + (P0[i + 1][1] - P0[i][1]) * t; req.push([acc + sl * t, hAt(cx, cz) - dipAtList(DLs, cx, cz) + 4.7]); }
        acc += sl; }
      if (!req.length) continue; ch.req = req; // resample every 4 m so the deck can bend over the line below
      const pts = [P0[0]], ws = [ch.ws[0]]; for (let i = 0; i + 1 < P0.length; i++) { const sl = Math.hypot(P0[i + 1][0] - P0[i][0], P0[i + 1][1] - P0[i][1]), n = Math.max(1, Math.ceil(sl / 4)); for (let q = 1; q <= n; q++) { pts.push([P0[i][0] + (P0[i + 1][0] - P0[i][0]) * q / n, P0[i][1] + (P0[i + 1][1] - P0[i][1]) * q / n]); ws.push(ch.ws[i]); } }
      ch.pts = pts; ch.ws = ws; }
    for (const ch of chains) if (!ch.req && ch.pts.length > 1) { const P0 = ch.pts, pts = [P0[0]], ws = [ch.ws[0]]; for (let i = 0; i + 1 < P0.length; i++) { const sl = Math.hypot(P0[i + 1][0] - P0[i][0], P0[i + 1][1] - P0[i][1]), n = Math.max(1, Math.ceil(sl / 8)); for (let q = 1; q <= n; q++) { pts.push([P0[i][0] + (P0[i + 1][0] - P0[i][0]) * q / n, P0[i][1] + (P0[i + 1][1] - P0[i][1]) * q / n]); ws.push(ch.ws[i]); } } ch.pts = pts; ch.ws = ws; } // (short pieces: each one belongs to one tile)
    const ownSeg = (a, b) => ownP([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    for (const { pts, ws, up, req } of chains) { if (pts.length < 2) continue; const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const T = cum[cum.length - 1]; if (T < 6 && !up) continue; const hA = hAt(pts[0][0], pts[0][1]), hB = hAt(pts[pts.length - 1][0], pts[pts.length - 1][1]), lin = s => hA + (hB - hA) * s / T + (up ? RAISE : 0);
      if (up) { const D = i => Math.max(lin(cum[i]), hAt(pts[i][0], pts[i][1]) + 4.7); for (let i = 0; i + 1 < pts.length; i++) spanSegs.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], (ws[i] / 2 + 1.6) * (ownSeg(pts[i], pts[i + 1]) ? 1 : -1), D(i), D(i + 1));
        // Runde 84: every free end of a raised chain gets its ramp (a bridge lifted only as part of a chain had none: 4.7 m step on the OWD)
        for (const [i, j] of [[0, 1], [pts.length - 1, pts.length - 2]]) { const p = pts[i];
          if (raised.some(b => { const L = b.line; return nr(p, [L[0], L[1]]) || nr(p, [L[L.length - 2], L[L.length - 1]]); })) continue; // a raised line's own end: it has its ramp already
          upRamps.push({ p, dx: p[0] - pts[j][0], dz: p[1] - pts[j][1], got: 0 }); }
        continue; } // raised: 5.5 m over the ends, at least 4.7 m over the ground
      let sag = 0; for (let i = 0; i + 1 < pts.length; i++) { const L = cum[i + 1] - cum[i], n = Math.max(1, Math.ceil(L / 3)); for (let q = 0; q <= n; q++) { const s = cum[i] + L * q / n, x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * q / n, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * q / n; sag = Math.max(sag, lin(s) - hAt(x, z)); } }
      const need = s => { let m = -Infinity; if (req) for (const [sc, hr] of req) m = Math.max(m, hr - .1 * Math.abs(s - sc)); return m; };
      let lift = 0; for (let i = 0; i < pts.length; i++) lift = Math.max(lift, need(cum[i]) - lin(cum[i]));
      if (sag < 1.5 && lift < .5) continue; // the ground under it is (nearly) where the deck is and nothing below needs room: nothing to span
      const D = i => Math.max(lin(cum[i]), hAt(pts[i][0], pts[i][1]) - .3, Math.min(need(cum[i]), lin(cum[i]) + .1 * Math.min(cum[i], T - cum[i]))); // the lift starts at the ends (max 10 %): no step at the abutment (ramps on the approaches did not take hold)
      for (let i = 0; i + 1 < pts.length; i++) spanSegs.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], (ws[i] / 2 + 1.6) * (ownSeg(pts[i], pts[i + 1]) ? 1 : -1), D(i), D(i + 1)); } }
  if (upRamps.length) rampChains(upRamps);
  if (self.RAISEDWHY && self.RAISEDWHY.length) { post({ type: 'info', msg: 'RAISED ' + JSON.stringify(self.RAISEDWHY) }); self.RAISEDWHY = []; }
  /* shared height raster for this tile (+-40 m), before houses, objects and sprites take their heights from it */
  DZF = null; if (TERRAIN_ON && LEVEL_DZ) { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0); DZF = buildDZ(drvLines, drvA, Math.min(c0[0], c1[0]) - 40, Math.min(c0[1], c1[1]) - 40, Math.max(c0[0], c1[0]) + 40, Math.max(c0[1], c1[1]) + 40, drvLines.ramps); }
  // names
  const tunCells = new Set(); for (const r of map.roads) if (r.k === 't') sampleLine(r.p, 2, (x, z) => tunCells.add(Math.floor(x / 4) * 100003 + Math.floor(z / 4)));
  { const L = layers.transportation_name; if (L) { const toL = mk(L.extent || ext0);
    for (const rng of L.feats) {
      const f = readFeature(L, rng); const nm = f.props.name_de || f.props.name; if (!nm || (f.type !== 2 && f.type !== 3)) continue;
      /* Runde 137 (40 squares: "Rheinufertunnel", "Verteilerebene StadtBahn-Station" shown on the square above): tunnels, underground
         levels and indoor ways are not where the figure walks - their names are left out */
      if (f.props.brunnel === 'tunnel' || (+f.props.layer || 0) < 0 || (+f.props.level || 0) < 0 || f.props.indoor || f.props.subclass === 'corridor') continue;
      let id = nameIdx.get(nm); if (id === undefined) { id = names.length; names.push(nm); nameIdx.set(nm, id); }
      if (f.type === 3) { for (const poly of polygons(geomLines(f, toL))) { sqNames.push(id, poly[0].length / 2); for (const v of poly[0]) sqNames.push(v); } continue; } // a named square as an area
      if (f.props.subclass === 'pedestrian' || f.props.class === 'pedestrian') pedNames.add(id);
      for (const line of geomLines(f, toL)) sampleLine(line, 12, (x, z) => { if (!tunCells.has(Math.floor(x / 4) * 100003 + Math.floor(z / 4))) samples.push(x, z, id); }); // the name layer has no tunnel flag: points on a tunnel line are left out
    } } }
  // buildings: first all footprints (needed for party walls and shops), then geometry
  { const L = layers.building; if (L) { const toL = mk(L.extent || ext0), tkey = tx + '/' + ty;
    const feats = L.feats.map(r => readFeature(L, r)).filter(f => f.type === 3 && !f.props.hide_3d);
    const freq = new Map(); for (const f of feats) { const c = f.props.colour; if (c) freq.set(c, (freq.get(c) || 0) + 1); }
    let dflt = null; for (const [c, k] of freq) if (k > feats.length * 0.3) dflt = c;
    const items = []; fpItems = items;
    for (const f of feats) {
      const H = Math.max(2.5, +f.props.render_height || 6), minH = +f.props.render_min_height || 0;
      const wallTag0 = f.props.colour && f.props.colour !== dflt ? parseCol(f.props.colour) : null, wallTag = wallTag0 && liftWall(...wallTag0);
      for (const poly of polygons(geomLines(f, toL))) {
        const outer = Float32Array.from(poly[0]), bb = bbox(outer);
        const it = Object.assign({ p: outer, h: H, minH, tile: tkey, shop: false, poly, wallTag }, bb);
        if (minH < 2) gAdd(fpgrid, it);
        items.push(it);
      }
    }
    /* Runde 206: Sonderbauten - houses whose centre lies in the ground rectangle of a landmark model get no mesh of their own
       (their outline still collides); the model itself is built by the tile that holds its centre */
    const sonderHere = []; if (WELT === 'heute' && self.SONDER && ground.tileBox) { const TB = ground.tileBox;
      for (const e of SONDER.list) { const m = merc(e.lat, e.lon), ax = lx(m.X), az = lz(m.Y), fr = SONDER.frame(e, ax, az); let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of fr.rect) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        if (x1 < TB[0] || x0 > TB[2] || z1 < TB[1] || z0 > TB[3]) continue;
        for (const it of items) { let cx = 0, cz = 0; for (let i = 0; i < it.p.length; i += 2) { cx += it.p[i]; cz += it.p[i + 1]; } cx /= it.p.length / 2; cz /= it.p.length / 2; if (SONDER.inRect(cx, cz, fr.rect)) it.sonder = e.id; }
        if (ax >= TB[0] && ax < TB[2] && az >= TB[1] && az < TB[3]) sonderHere.push({ e, ax, az, rect: fr.rect }); } }
    nestedParts(items); // Runde 118: footprints lying inside another one (building parts) - walls on top of each other flickered
    groundFloating(items, map.roads);
    // shops, cafés, … inside a footprint -> shopfront on the ground floor
    const P = layers.poi; if (P) { const toP = mk(P.extent || ext0);
      for (const rng of P.feats) { const f = readFeature(P, rng); if (f.type !== 1) continue;
        if (!SHOPRX.test((f.props.class || '') + ' ' + (f.props.subclass || ''))) continue;
        for (const pt of pointsOf(f, toP)) { const b = fpAt(pt[0], pt[1]); if (b) b.shop = true; } } }
    if (WELT !== 'heute' && P) { const toP = mk(P.extent || ext0); for (const rng of P.feats) { const f = readFeature(P, rng); if (f.type !== 1) continue; for (const pt of pointsOf(f, toP)) { const b = fpAt(pt[0], pt[1]); if (b && !b.poi) b.poi = f.props.subclass || f.props.class; } } }
    // own OSM records: colours, material and year of construction attached to the footprint they fall into
    for (const r of osm.blds) {
      const fp = fpAt(r.x, r.z); if (!fp) continue;
      if (r.year) fp.year = r.year;
      if (r.levels) fp.levels = r.levels;
      if (r.btype) fp.btype = r.btype; if (r.landmark) fp.landmark = true; if (r.mat === 6) fp.btype = 5; // glass facade wins over the building type (new Memorial Church: blue glass)
      if (r.util) fp.util = true;
      if (r.wall || r.roof || r.mat) {
        const brick = r.mat === 1 && !r.wall, wall = r.wall || (brick ? BRICK[Math.floor(hashStr('m' + r.x) * BRICK.length)] : r.mat === 3 ? stoneWall(hashStr('m' + r.x), r.x, r.z) : r.mat && MATCOL[r.mat] ? MATCOL[r.mat] : null);
        gridAdd(Object.assign({ p: fp.p, wall, roof: r.roof, brick, src: 3, tile: tkey }, bbox(fp.p)));
      }
    }
    // castle and fortress grounds (OSM historic=castle/fort): every building inside without an own type gets the castle facade,
    // no shopfronts and awnings (Sparrenburg Bielefeld: castle building with residential windows, kiosk with coloured awnings)
    for (const a of osm.areas || []) if (a.kind === 1) castleAreas.add(a);
    for (const a of osm.areas || []) if (a.kind === 1) for (const it of items) {
      if (it.btype || it.maxx < a.minx || it.minx > a.maxx || it.maxz < a.minz || it.minz > a.maxz) continue;
      let cx = 0, cz = 0; for (let i = 0; i < it.p.length; i += 2) { cx += it.p[i]; cz += it.p[i + 1]; } cx /= it.p.length / 2; cz /= it.p.length / 2;
      if (inPoly(cx, cz, a.ring)) { it.btype = 3; it.shop = false; }
    }
    // halls: large flat buildings, or buildings in industrial/commercial areas
    for (const it of items) {
      const ar = Math.abs(ringArea(it.p)); let cx = 0, cz = 0; for (let i = 0; i < it.p.length; i += 2) { cx += it.p[i]; cz += it.p[i + 1]; } cx /= it.p.length / 2; cz /= it.p.length / 2;
      const ind = hallPolys.some(q => inPoly(cx, cz, q)); // Runde 64: only industrial land - retail/commercial land is the shopping street in the old town (Bielefeld Breite Strasse)
      if (!it.util && !it.landmark && !(it.year && it.year < 1950) && !it.btype && !(it.levels > 3) && ((ar > 1200 && it.h < 16) || (ind && ar > 250 && it.h < 22))) it.hall = true; // listed or old warehouses are no sheet-metal halls (Hamburg Speicherstadt)
    }
    if (WELT !== 'heute') { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0); weltBauten(items.filter(it => it.minH < 2), map.roads, collide, map, plazaPolys, [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1])], (x, z) => waterRings.some(q => inPoly(x, z, q))); gRemove(fpgrid, i => i.tile === tkey); fpItems = []; }
    else for (const it of items) {
      const { poly, p: outer, minH, wallTag } = it; let H = it.h;
      let cx = 0, cz = 0; for (let i = 0; i < outer.length; i += 2) { cx += outer[i]; cz += outer[i + 1]; } cx /= outer.length / 2; cz /= outer.length / 2;
      const seed = hashStr(cx.toFixed(1) + ',' + cz.toFixed(1)), area = Math.abs(ringArea(outer)), osrc = colourAt(cx, cz);
      const base = TERRAIN_ON ? baseOf(outer) : 0;
      // castle and fortress walls on a slope are retaining walls: they reach up to the highest ground under them plus a parapet
      // (Sparrenburg: bastions without height tag stood 5 m high at the foot of the hill, far below the courtyard)
      if (TERRAIN_ON && it.btype === 3 && minH < 2) { let top = -Infinity; for (let i = 0; i < outer.length; i += 2) top = Math.max(top, hAt(outer[i], outer[i + 1])); if (top + 1.5 > base + H) { H = top + 1.5 - base; it.h = H; } }
      if (minH < 2) { collide.push(outer.length / 2, H + base, base, ...outer); ground.flat(poly, .045, FLOOR); } // floor: visible when the house is cut open
      map.blds.push(outer);
      if (wallTag) gridAdd(Object.assign({ p: outer, wall: wallTag, roof: null, src: 1, tile: tkey }, bbox(outer)));
      // which LoD2 tile owns this footprint?
      const X = cx / O.c + O.X0, Y = -cz / O.c + O.Y0;
      let owner = 'none';
      for (const t of l2tiles) if (Math.abs(X - t.cx) <= 500 && Math.abs(Y - t.cy) <= 500) { owner = t.id; break; }
      let G = buckets.get(owner); if (!G) buckets.set(owner, G = new Geo(true));
      const era = it.hall ? 6 : (eraFromYear(it.year) || eraAt(cx, cz, seed) || eraGuess(H, area));
      let wall = (osrc && osrc.wall) || wallTag || (it.btype === 3 ? stoneWall(seed, cx, cz) : it.btype === 1 || it.btype === 2 ? sacredWall(era, seed, cx, cz) : wallFor(era, seed, cx, cz));
      if (osrc && osrc.wall) { wall = wall.slice(); wall.brick = !!osrc.brick; }
      const roof = (osrc && osrc.roof) || roofGuess(cx, cz, seed, H);
      const from = G.p.length;
      fallbackBuilding(G, poly, H, minH, wall, roof, seed, 'yes', era + (it.shop ? 16 : 0) + (hashStr('v' + seed) < 0.5 ? 32 : 0) + (wall.brick ? 128 : 0) + (it.btype || 0) * 512, it);
      if (it.pillars && owner === 'none') { (map.stuetzen || (map.stuetzen = [])).push({ x: Math.round(cx), z: Math.round(cz), n: it.pillars.pts.length, minH: +minH.toFixed(1), h: +H.toFixed(1), ar: Math.round(area) }); const Pp = it.pillars, pc = [Math.min(1, wall[0] * 1.06), Math.min(1, wall[1] * 1.06), Math.min(1, wall[2] * 1.06)]; // Runde 204: the pillars under a raised part
        for (const [x, z] of Pp.pts) { const b0 = TERRAIN_ON ? hAt(x, z) : 0, top = base + minH + .2; obox2(ground, x, 0, z, Pp.sz, top - b0, Pp.sz, Pp.c, Pp.s, pc, false);
          const hs = Pp.sz / 2, ux = Pp.c * hs, uz = Pp.s * hs, vx = -Pp.s * hs, vz = Pp.c * hs; collide.push(4, top, b0, x - ux - vx, z - uz - vz, x + ux - vx, z + uz - vz, x + ux + vx, z + uz + vz, x - ux + vx, z - uz + vz); } }
      G.lift(from, base);
      if (it.sonder) { const v0 = from / 3; G.p.length = from; G.n.length = from; G.c.length = from; if (G.f) { G.f.length = v0 * 2; G.w.length = v0 * 3; G.b.length = v0; } } // Runde 206: the landmark model stands here instead
      it.poly = null; it.cx = cx; it.cz = cz; it.G = G; it.r0 = from; it.r1 = G.p.length;
    }
    for (const s of sonderHere) { let G = buckets.get('none'); if (!G) buckets.set('none', G = new Geo(true)); const from = G.p.length; // Runde 206: the landmark models of this tile
      let base = 0; if (TERRAIN_ON) { base = Infinity; for (const [x, z] of s.rect.concat([[s.ax, s.az]])) base = Math.min(base, hAt(x, z)); }
      const n = SONDER.emit(s.e, s.ax, s.az, G); G.lift(from, base); (map.sonder || (map.sonder = [])).push({ id: s.e.id, name: s.e.name, x: Math.round(s.ax), z: Math.round(s.az), tris: n }); }
  } }
  // airports (Google Hamburg: runways, taxiways and aprons were missing, only grass): OpenMapTiles layer 'aeroway'
  { const L = layers.aeroway; if (L) { const toL = mk(L.extent || ext0), ASP = hex('#55585d'), CON = hex('#b4b2aa'), WHT = hex('#f0f0ea'), YEL = hex('#e2b93a'), aprons = [];
    const stripe = (line, off, wid, y, col, dash, gap) => { for (let i = 0; i + 3 < line.length; i += 2) { const x0 = line[i], z0 = line[i + 1], ex = line[i + 2] - x0, ez = line[i + 3] - z0, L2 = Math.hypot(ex, ez); if (L2 < .5) continue;
        const dx = ex / L2, dz = ez / L2, nx = -dz, nz = dx;
        for (let u = 0; u < L2; u += dash + gap) { const u1 = Math.min(L2, u + dash), ax = x0 + dx * u + nx * off, az = z0 + dz * u + nz * off, bx = x0 + dx * u1 + nx * off, bz = z0 + dz * u1 + nz * off;
          ground.quad([ax - nx * wid / 2, y, az - nz * wid / 2], [bx - nx * wid / 2, y, bz - nz * wid / 2], [bx + nx * wid / 2, y, bz + nz * wid / 2], [ax + nx * wid / 2, y, az + nz * wid / 2], col, 0, 1, 0); } } };
    for (const rng of L.feats) { const f = readFeature(L, rng), cls = f.props.class;
      if (f.type === 3) { const col = cls === 'apron' || cls === 'helipad' ? CON : cls === 'runway' || cls === 'taxiway' ? ASP : null; if (!col) continue;
        for (const poly of polygons(geomLines(f, toL))) { ground.flat(poly, cls === 'apron' ? .026 : .027, col); if (cls === 'apron') aprons.push(poly[0]); } }
      else if (f.type === 2 && (cls === 'runway' || cls === 'taxiway')) for (const line of geomLines(f, toL)) {
        if (cls === 'runway') { ribbon(ground, line, 45, .028, ASP); stripe(line, 0, .9, .031, WHT, 30, 20); stripe(line, 21, .9, .031, WHT, 1e9, 0); stripe(line, -21, .9, .031, WHT, 1e9, 0);
          for (const end of [0, 1]) { const i = end ? line.length - 4 : 0, dx0 = line[i + 2] - line[i], dz0 = line[i + 3] - line[i + 1], l0 = Math.hypot(dx0, dz0) || 1, dx = dx0 / l0, dz = dz0 / l0, sg = end ? -1 : 1;
            const px = end ? line[line.length - 2] : line[0], pz = end ? line[line.length - 1] : line[1];
            { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0); if (Math.min(Math.abs(px - c0[0]), Math.abs(px - c1[0]), Math.abs(pz - c0[1]), Math.abs(pz - c1[1])) < 40) continue; } // a tile cut, not the runway end
            for (let k = -7; k <= 7; k++) { if (Math.abs(k) < 1) continue; const o = k * 2.6, ax = px + dx * 6 * sg - dz * o, az = pz + dz * 6 * sg + dx * o; // threshold "piano keys"
              obox(ground, ax + dx * 15 * sg, .031, az + dz * 15 * sg, 30, .002, 1.6, dx, dz, WHT); } } }
        else { ribbon(ground, line, 22, .0275, ASP); stripe(line, 0, .45, .0315, YEL, 1e9, 0); } }
    }
    // parked airliners on the aprons (not on taxiway lines), a few per tile
    let np = 0;
    for (const q of aprons) { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (let i = 0; i < q.length; i += 2) { x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]); z0 = Math.min(z0, q[i + 1]); z1 = Math.max(z1, q[i + 1]); }
      for (let x = x0 + 30; x < x1 - 20; x += 70) for (let z = z0 + 30; z < z1 - 20; z += 70) { if (np > 14 || !inPoly(x, z, q) || fpAt(x, z) || fpAt(x + 25, z) || fpAt(x - 25, z) || fpAt(x, z + 25) || fpAt(x, z - 25) || rnd() < .4) continue;
        cars.push(x, z, Math.floor(rnd() * 8) * Math.PI / 4, 11, 3, rnd()); np++; } } } }
  // street furniture from own OSM tiles
  for (const p of osm.pts) {
    if ((WELT === 'west' || WELT === 'mittel') && p.t !== 1) continue; // Runde 93: no traffic lights, crossings, bus stops, lamps
    let { x, z } = p;
    if (p.t >= 4 || p.t === 1) { // bus stops, lamps, benches, fountains - and trees (phone test Rheinstrasse: street trees stood in the lane;
      // our carriageway comes from generalised lines and standard widths, real kerb trees land on it) - moved to the kerb on their own side
      const r = roadAt(x, z);
      if (r) { const [rx, rz, dx, dz, w] = r, nx = -dz, nz = dx, side = (x - rx) * nx + (z - rz) * nz;
        if (Math.abs(side) < w / 2 + (p.t === 1 ? 0.8 : 0.4)) { const sg = side < 0 ? -1 : 1, off = w / 2 + (p.t === 4 ? 1.6 : p.t === 1 ? 1.3 : 0.9); x = rx + nx * off * sg; z = rz + nz * off * sg;
          const f = kerbFree(x, z, nx * sg, nz * sg); if (!f) continue; x = f[0]; z = f[1]; } }
    }
    if (p.t === 1) { if (!fpAt(x, z)) tree(ground, x, z, p.v ? Math.min(2.4, Math.max(1, p.v / 7)) : 1.5 + rnd() * .7, rnd); }
    else if (p.t === 2) { // traffic light: pole, dark head, red/yellow/green
      // OSM puts signals as a node on the centre line of the road (phone test: pole in the middle of the street);
      // the poles go to the kerb on both sides, a little before the stop line
      const r = roadAt(x, z), spots = [];
      if (r) { const [rx, rz, dx, dz, w] = r, nx = -dz, nz = dx, off = w / 2 + 0.7;
        for (const sg of [1, -1]) { const f = kerbFree(rx + nx * off * sg - dx * 1.5 * sg, rz + nz * off * sg - dz * 1.5 * sg, nx * sg, nz * sg); if (f) spots.push(f); } }
      else if (!onRoad(x, z)) spots.push([x, z]);
      for (const [sx, sz] of spots) {
        if (fpAt(sx, sz)) continue;
        ground.box(sx, 0, sz, .14, 3.4, .14, POLE); ground.box(sx, 2.4, sz, .34, 1.0, .3, hex('#2a2c30'));
        glow.box(sx, 3.15, sz, .2, .2, .34, [1, .25, .2]); glow.box(sx, 2.85, sz, .2, .2, .34, [1, .8, .2]); glow.box(sx, 2.55, sz, .2, .2, .34, [.3, 1, .4]);
      }
    } else if (p.t === 3) { // pedestrian crossing across the nearest road
      const r = roadAt(x, z); if (!r) continue;
      const [rx, rz, dx, dz, w, y] = r, nx = -dz, nz = dx, hw = w / 2;
      if (p.v === 1) for (let k = -2; k <= 2; k++) { const cx = rx + dx * k * 1.0, cz = rz + dz * k * 1.0, sx = dx * .25, sz = dz * .25;
        ground.quad([cx - sx - nx * hw, .115, cz - sz - nz * hw], [cx + sx - nx * hw, .115, cz + sz - nz * hw], [cx + sx + nx * hw, .115, cz + sz + nz * hw], [cx - sx + nx * hw, .115, cz - sz + nz * hw], MARK, 0, 1, 0); }
      else for (const k of [-1.6, 1.6]) { const cx = rx + dx * k, cz = rz + dz * k, sx = dx * .1, sz = dz * .1;
        for (let t = -hw; t < hw; t += 1) ground.quad([cx - sx + nx * t, .115, cz - sz + nz * t], [cx + sx + nx * t, .115, cz + sz + nz * t], [cx + sx + nx * (t + .5), .115, cz + sz + nz * (t + .5)], [cx - sx + nx * (t + .5), .115, cz - sz + nz * (t + .5)], MARK, 0, 1, 0); }
    } else if (p.t === 4) { // bus stop: only the pole with the yellow-green H sign (the made-up shelter stood across pavements and roads)
      ground.box(x, 0, z, .1, 2.7, .1, POLE); ground.box(x, 2.25, z, .55, .55, .06, hex('#f1c400')); ground.box(x, 2.4, z, .3, .25, .07, hex('#2f8a3a'));
    } else if (p.t === 5) { // tram stop: platform and sign
      ground.box(x, 0, z, 8, .22, 2.2, hex('#9a968c')); ground.box(x, .22, z, .1, 2.6, .1, POLE); ground.box(x, 2.5, z, .6, .6, .06, hex('#c8231e'));
    } else if (p.t === 6) { ground.box(x, 0, z, .16, 4.2, .16, POLE); glow.box(x, 4.1, z, .55, .32, .55, LAMP); }
    else if (p.t === 7) { if (!fpAt(x, z)) { ground.box(x, .38, z, 1.6, .1, .5, hex('#7a5a3a')); ground.box(x, 0, z, 1.4, .38, .3, hex('#3a3c40')); } }
    else if (p.t === 8) { ground.box(x, 0, z, 2.4, .5, 2.4, hex('#a9a59a')); ground.box(x, .5, z, 2.0, .02, 2.0, WATER); ground.box(x, .5, z, .3, 1.2, .3, hex('#a9a59a')); }
  }
  // Street View (Dresden Neustadt, Gründerzeit): in closed street fronts the pavement runs up to the facade, no grass strip;
  // residential streets are lined with parked cars. Both derived from the geometry only (works everywhere).
  const paved = new Set(), nearRoad = (x, z) => { const r = roadAt(x, z); return !!r && Math.hypot(r[0] - x, r[1] - z) < r[4] / 2 + 2.8; };
  /* Runde 137 (Google 3D/Street View, 40 squares: Domplatte Köln, Heumarkt, Münsterplatz Freiburg, Magdeburger Domplatz, ...):
     unmapped open ground fell back to the meadow, so paved squares became lawns. Rule: in a dense centre (buildings cover a third of the 50 m around, a fifth
     outside residential land), open ground that is reachable from a street or square within 70 m without crossing a building, and
     is not mapped as green, water or anything else, is paving. Enclosed courtyards (no street access) and suburbs stay green. */
  if (WELT === 'heute') {
    const C = 4, c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0), X0 = Math.min(c0[0], c1[0]), Z0 = Math.min(c0[1], c1[1]), NX = Math.ceil(Math.abs(c1[0] - c0[0]) / C), NZ = Math.ceil(Math.abs(c1[1] - c0[1]) / C);
    const B = new Uint8Array(NX * NZ); for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) if (fpAt(X0 + (i + .5) * C, Z0 + (j + .5) * C)) B[j * NX + i] = 1;
    const S = new Uint32Array((NX + 1) * (NZ + 1)); for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) S[(j + 1) * (NX + 1) + i + 1] = B[j * NX + i] + S[j * (NX + 1) + i + 1] + S[(j + 1) * (NX + 1) + i] - S[j * (NX + 1) + i];
    const R = 12, dense = (i, j) => { const a = Math.max(0, i - R), b = Math.min(NX, i + R + 1), c = Math.max(0, j - R), d = Math.min(NZ, j + R + 1); const v = (S[d * (NX + 1) + b] - S[c * (NX + 1) + b] - S[d * (NX + 1) + a] + S[c * (NX + 1) + a]) / ((b - a) * (d - c)); return v >= .33 || (v >= .2 && !resAt(i, j)); };
    // residential land (front gardens, courtyards) needs a denser setting than centres, which are mapped as retail/commercial or not at all
    const RS = new Int8Array(NX * NZ).fill(-1), resAt = (i, j) => { const k = j * NX + i; if (RS[k] < 0) RS[k] = inResEarly(X0 + (i + .5) * C, Z0 + (j + .5) * C) ? 1 : 0; return RS[k] === 1; };
    const other = [...greenPolys.map(p => p[0]), ...waterPolys.map(p => p[0]), ...dryPolys.map(p => p[0])].map(r => Object.assign({ r }, bbox(r)));
    const mapped = (x, z) => { for (const o of other) if (x >= o.minx && x <= o.maxx && z >= o.minz && z <= o.maxz && inPoly(x, z, o.r)) return true; return false; };
    // a stand of trees (three or more within 10 m, from the tree map) is green ground, not a square: tree rows on squares are sparser
    const TC = new Uint8Array(NX * NZ); if (osm.trees) for (let t = 0; t < osm.trees.length; t += 2) { const ti = Math.floor((osm.trees[t] - X0) / C), tj = Math.floor((osm.trees[t + 1] - Z0) / C);
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) { const i = ti + a, j = tj + b; if (i >= 0 && j >= 0 && i < NX && j < NZ && TC[j * NX + i] < 255) TC[j * NX + i]++; } }
    const D = new Int16Array(NX * NZ).fill(-1), Q = [];
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) { const k = j * NX + i; if (B[k]) continue; const x = X0 + (i + .5) * C, z = Z0 + (j + .5) * C; if (roadGrid.has(rg(x, z)) && dense(i, j)) { D[k] = 0; Q.push(k); } }
    for (let q = 0; q < Q.length; q++) { const k = Q[q], i = k % NX, j = (k - i) / NX; if (D[k] >= 18) continue;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= NX || b >= NZ) continue; const n = b * NX + a; if (B[n] || D[n] >= 0 || TC[n] >= 3 || !dense(a, b)) continue; D[n] = D[k] + 1; Q.push(n); } }
    const PAVE = hex('#b4aea4'); let runs = 0;
    for (let j = 0; j < NZ && runs < 60000; j++) { let s0 = -1;
      for (let i = 0; i <= NX; i++) { let on = false; if (i < NX) { const k = j * NX + i; if (D[k] > 0) { const x = X0 + (i + .5) * C, z = Z0 + (j + .5) * C; on = !mapped(x, z); if (on) paved.add(rc(x, z)); } }
        if (on && s0 >= 0 && i - s0 >= 2) { const ax = X0 + s0 * C, bx = X0 + i * C, az = Z0 + j * C, bz = az + C; ground.quad([ax, .022, az], [bx, .022, az], [bx, .022, bz], [ax, .022, bz], PAVE, 0, 1, 0); runs++; s0 = i; } // short pieces: the ground is draped onto the terrain at its corners
        if (on && s0 < 0) s0 = i; else if (!on && s0 >= 0) { const ax = X0 + s0 * C, bx = X0 + i * C, az = Z0 + j * C, bz = az + C; ground.quad([ax, .022, az], [bx, .022, az], [bx, .022, bz], [ax, .022, bz], PAVE, 0, 1, 0); runs++; s0 = -1; } } }
  }
  // cumulative shares of car colours (cars.js CAR_COLOURS): black, silver, grey, white, dark blue, blue, red, green, beige, brown, yellow, orange
  const CARCOL = [.2, .38, .55, .72, .8, .86, .93, .96, .975, .99, .995, 1.01];
  {
    let ncars = 0; const carGrid = new Map(), TB = (() => { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0); return [Math.min(c0[0], c1[0]), Math.max(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[1], c1[1])]; })();
    for (let li = 0; li < walkLines.length; li += 3) {
      const line = walkLines[li], w = walkLines[li + 1], cls = walkLines[li + 2];
      let lineLen = 0; for (let i = 0; i + 3 < line.length; i += 2) lineLen += Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]);
      let along = 0; const lastSlot = [-99, -99, -99];
      sampleLineDir(line, 2.5, (x, z, dx, dz) => {
        along += 2.5;
        for (const sd of [-1, 1]) {
          const nx = -dz * sd, nz = dx * sd, e0 = w / 2 + 2.2;
          let hit = 0; for (let d = e0 + 0.5; d <= Math.max(w / 2 + 9, 13.5) /* the facades stay where they are when the carriageway gets narrower (Runde 44) */; d += 0.75) { if (fpAt(x + nx * d, z + nz * d)) { hit = d; break; } }
          if (hit) { // pave the gap between sidewalk and building
            for (let d = e0; d <= hit + 1; d += 1.5) paved.add(rc(x + nx * d, z + nz * d));
            const a0 = x - dx * 1.4, b0 = z - dz * 1.4, a1 = x + dx * 1.4, b1 = z + dz * 1.4, h2 = hit + 0.3;
            ground.quad([a0 + nx * e0, .032, b0 + nz * e0], [a1 + nx * e0, .032, b1 + nz * e0], [a1 + nx * h2, .032, b1 + nz * h2], [a0 + nx * h2, .032, b0 + nz * h2], SIDEWALK, 0, 1, 0);
          }
          // parked cars: built-up streets (a house within reach), not near junctions, both sides of minor streets, one side of bigger ones
          if (ncars > 3000 || (cls !== 'minor' && sd < 0) || cls === 'primary' || along < 12 || along > lineLen - 12) continue;
          if (w < 5.5 || (w < 7.5 && sd < 0)) continue; // Runde 55: room for parked cars and a lane (OSM widths make many streets narrower: cars stood in the lane, the autopilot never got past)
          let house = hit; if (!house) for (let d = w / 2 + 9; d <= w / 2 + 24 && !house; d += 3) if (fpAt(x + nx * d, z + nz * d)) house = d;
          if (!house) continue; // only where houses line the street (Google 3D Hinterzarten: no parking along meadows)
          if (along < lastSlot[sd + 1]) continue; const slot = Math.round(along); // next free spot (Runde 54, phone test: cars bumper to bumper): set after the car is placed
          const hsh = hashStr(slot + ':' + li + ':' + sd + ':' + tx); if (hsh < (cls === 'minor' ? 0.35 : cls === 'tertiary' ? 0.6 : 0.8)) continue; // gaps; through roads are parked much less
          if (fpAt(x + nx * (w / 2 - 1), z + nz * (w / 2 - 1))) continue;
          { /* Runde 62 (phone: a van across the road): not on the carriageway of a street running another way (a line that runs on
               through a junction put cars into the crossing street) */ const px = x + nx * (w / 2 - 1.05), pz = z + nz * (w / 2 - 1.05), ix = Math.floor(px / 8), iz = Math.floor(pz / 8); let cross = false;
            for (let a = -1; a <= 1 && !cross; a++) for (let b = -1; b <= 1 && !cross; b++) for (const q of (rdir.get((ix + a) * 100003 + iz + b) || [])) {
              if (Math.abs(q[2] * dx + q[3] * dz) > .7) continue; const ex = px - q[0], ez = pz - q[1];
              if (Math.abs(ex * q[2] + ez * q[3]) < 1.3 && Math.abs(-ex * q[3] + ez * q[2]) < q[4] / 2 + 2.2) { cross = true; break; } }
            if (cross) continue; }
          // baked car sprites (cars.js): type and colour by rough German frequencies; cars face the driving direction of their side
          const off = w / 2 - 1.05, cx = x + nx * off, cz = z + nz * off, h1 = hashStr('t' + hsh), h2 = hashStr('k' + hsh);
          const type = h1 < .1 ? 0 : h1 < .36 ? 1 : h1 < .48 ? 2 : h1 < .66 ? 3 : h1 < .82 ? 4 : h1 < .93 ? 5 : h1 < .96 ? 6 : 7;
          let colour = CARCOL.findIndex(c => (h2 < c)); if (colour < 0) colour = 0;
          if (type === 6) colour = 12; else if ((type === 5 || type === 7) && h2 < .55) colour = 3; // taxis ivory, vans mostly white
          const head = Math.atan2(dx, dz) + (sd > 0 ? 0 : Math.PI) + (hashStr('r' + hsh) < .12 ? Math.PI : 0);
          if (type === 7 && Math.abs(off) < 2.2) continue; // delivery trucks only where there is room
          { const fx2 = Math.sin(head), fz2 = Math.cos(head), k0 = Math.floor(cx / 8), k1 = Math.floor(cz / 8); let clash = false;
            if (cx < TB[0] || cx >= TB[1] || cz < TB[2] || cz >= TB[3]) continue; // only inside this tile: the neighbour places the rest (doubles at tile edges)
            for (let a = -1; a <= 1 && !clash; a++) for (let b = -1; b <= 1 && !clash; b++) for (const q of (carGrid.get((k0 + a) * 100003 + k1 + b) || [])) { const ex = cx - q[0], ez = cz - q[1];
              if (Math.abs(ex * fz2 - ez * fx2) < 1.6 && Math.abs(ex * fx2 + ez * fz2) < 6) { clash = true; break; } }
            if (clash) continue; const kk = k0 * 100003 + k1; let l = carGrid.get(kk); if (!l) carGrid.set(kk, l = []); l.push([cx, cz]); } // same row, closer than 6 m (two map lines of one street)
          cars.push(cx, cz, head, type, colour, hsh); ncars++; lastSlot[sd + 1] = along + (type === 5 || type === 7 ? 8 : 6.5); // 6.5 m from car to car (4.2-4.5 m long), 8 m after vans and trucks
        }
      });
    }
  }
  if (osm.trees) for (let i = 0; i < osm.trees.length; i += 2) treeCand.push(osm.trees[i], osm.trees[i + 1], 1.25 + rnd() * 0.6); // trees where the tree map says so
  // low greenery (Street View checks: front gardens, hedges and shrubs were missing everywhere): only in residential areas
  const inRes = (x, z) => resPolys.some(q => inPoly(x, z, q));
  const SHRUB = ['#3f5f34', '#4a6a3a', '#56743c', '#3a5530'].map(hex);
  let nb = 0;
  for (let i = 0; i < hedgeCand.length && nb < 2500; i += 2) {
    const x = hedgeCand[i], z = hedgeCand[i + 1];
    if (hashStr(Math.floor(x / 14) + ',' + Math.floor(z / 14)) < 0.45) continue; // hedges come in pieces, with gaps for gates and drives
    if (paved.has(rc(x, z)) || nearRoad(x, z) || fpAt(x, z) || fpAt(x + 1.5, z) || fpAt(x - 1.5, z) || fpAt(x, z + 1.5) || fpAt(x, z - 1.5) || !inRes(x, z)) continue; // never on carriageway or sidewalk
    shrub(ground, x, z, 1.0 + rnd() * .35, 1.3 + rnd() * .5, SHRUB[Math.floor(rnd() * SHRUB.length)]); nb++;
  }
  for (const it of fpItems) { // a few bushes around detached and small multi-family houses
    if (nb > 4000 || it.hall || it.util) continue;
    const ar = Math.abs(ringArea(it.p)); if (ar > 900) continue;
    for (let k = 0; k < 3; k++) {
      const side = Math.floor(rnd() * 4), d = 1.8 + rnd() * 3;
      const x = side === 0 ? it.minx - d : side === 1 ? it.maxx + d : it.minx + rnd() * (it.maxx - it.minx);
      const z = side === 2 ? it.minz - d : side === 3 ? it.maxz + d : it.minz + rnd() * (it.maxz - it.minz);
      if (roadCells.has(rc(x, z)) || paved.has(rc(x, z)) || nearRoad(x, z) || fpAt(x, z) || !inRes(x, z)) continue;
      shrub(ground, x, z, 0.9 + rnd() * .6, 1.2 + rnd() * .9, SHRUB[Math.floor(rnd() * SHRUB.length)]); nb++;
    }
    // Google 3D (villages, suburbs): detached houses nearly always have a tree or two in the garden; the 10 m tree map misses most of them
    if (ar < 300 && rnd() < 0.65) {
      const a = rnd() * Math.PI * 2, d = Math.max(it.maxx - it.minx, it.maxz - it.minz) / 2 + 4 + rnd() * 5;
      const x = (it.minx + it.maxx) / 2 + Math.cos(a) * d, z = (it.minz + it.maxz) / 2 + Math.sin(a) * d;
      if (!nearRoad(x, z) && !paved.has(rc(x, z)) && inRes(x, z)) treeCand.push(x, z, 0.95 + rnd() * 0.5);
    }
  }
  // small things that make streets look lived-in (pixel-art references, Street View): bins and bikes in front of houses,
  // planters, cafe tables and more people in front of shops. Only rules on the geometry, so it works everywhere.
  { let np = 0, nppl = 0;
    const pushP = (x, z, w, h, t) => { ground.spr.push(x, z, w, h, t, sprY(x, z, hashStr('p' + x.toFixed(1) + ',' + z.toFixed(1)))); np++; };
    for (const it of fpItems) {
      if (np > 2500 || it.hall || it.util) continue;
      const ar = Math.abs(ringArea(it.p)); if (ar < 50 || ar > 1500) continue;
      const cx = (it.minx + it.maxx) / 2, cz = (it.minz + it.maxz) / 2, r = roadAt(cx, cz); if (!r) continue;
      let dx = r[0] - cx, dz = r[1] - cz; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      let x = cx, z = cz, k = 0; while (fpAt(x, z) && k++ < 80) { x += dx * 0.5; z += dz * 0.5; }
      x += dx * 0.9; z += dz * 0.9; // just in front of the facade that faces the street
      if (Math.hypot(r[0] - x, r[1] - z) < r[4] / 2 + 0.8 || fpAt(x, z)) continue;
      const h = hashStr('pp' + cx.toFixed(1) + ',' + cz.toFixed(1)), sx = -dz, sz = dx; // sx, sz: along the facade
      if (it.shop) {
        if (h < .35) pushP(x + sx * 2, z + sz * 2, 2.6, 2.6, 25);
        if (h > .6) pushP(x - sx * 1.5, z - sz * 1.5, 1.1, 1.1, 24);
        if (h > .3 && h < .5) pushP(x + sx * 3.5, z + sz * 3.5, 1.8, 1.8, 17);
      } else if (inRes(x, z)) {
        if (h < .45) pushP(x + sx * (h * 6 - 1.5), z + sz * (h * 6 - 1.5), 2.0, 2.0, 16);
        else if (h < .6) pushP(x + sx * 1.5, z + sz * 1.5, 1.8, 1.8, 17);
        else if (h > .9) pushP(x - sx * 1.2, z - sz * 1.2, 1.0, 1.0, 24);
      }
    }
    for (let li = 0; li < walkLines.length && nppl < 500; li += 3) { // people on the pavement, more where there are shops
      const line = walkLines[li], w = walkLines[li + 1];
      sampleLineDir(line, 9, (x, z, dx, dz) => {
        for (const sd of [-1, 1]) {
          const ox = -dz * sd, oz = dx * sd, off = w / 2 + 1.1 + rnd() * 0.9, px = x + ox * off, pz = z + oz * off;
          let shop = false; for (let d = 2; d < 12 && !shop; d += 2.5) { const f = fpAt(px + ox * d, pz + oz * d); if (f) { shop = !!f.shop; break; } }
          if (rnd() > (shop ? 0.4 : 0.05) || fpAt(px, pz)) continue;
          pushP(px, pz, 1.9, 1.9, rnd() < .5 ? 18 : 20); nppl++;
        }
      });
    }
  }
  // building parts from OSM (Simple 3D Buildings): landmarks get their real towers, spires and domes
  const partsGeo = new Geo(true);
  { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0), bx0 = Math.min(c0[0], c1[0]), bx1 = Math.max(c0[0], c1[0]), bz0 = Math.min(c0[1], c1[1]), bz1 = Math.max(c0[1], c1[1]);
    if (WELT === 'heute' && osm.parts && !osm.parts.nested) { osm.parts.nested = true; nestedParts(osm.parts.slice(), true); } // Runde 118: a part inside another part
    const sRects = WELT === 'heute' && self.SONDER ? SONDER.list.map(e => { const m = merc(e.lat, e.lon); return SONDER.frame(e, lx(m.X), lz(m.Y)).rect; }).filter(r => r.some(([x, z]) => x > bx0 - 400 && x < bx1 + 400 && z > bz0 - 400 && z < bz1 + 400)) : [];
    for (const pt of (WELT === 'heute' ? osm.parts : null) || []) { // other worlds: no OSM building parts (towers, church spires)
      if (pt.hid) continue;
      if (pt.x < bx0 || pt.x >= bx1 || pt.z < bz0 || pt.z >= bz1 || pt.h - pt.mh < 0.3) continue;
      if (sRects.length && sRects.some(r => SONDER.inRect(pt.x, pt.z, r))) continue; // Runde 206: a landmark model stands here
      if (pt.mh >= 2 && !pt.fChk) { pt.fChk = 1; if (pt.p) floatFix(pt, [osm.parts, fpItems], map.roads); } // Runde 136: a raised part with nothing under it
      // building type: from the footprint, else from the nearest OSM building with a type (outlines of buildings in parts are
      // hidden in the map tiles, so the parts often have no footprint of their own)
      let fp = fpAt(pt.x, pt.z);
      if (!fp || !fp.btype) { let best = null, bd = 45; for (const r of osm.blds) if (r.btype) { const d = Math.hypot(r.x - pt.x, r.z - pt.z); if (d < bd) { bd = d; best = r; } } if (best) fp = { btype: best.mat === 6 ? 5 : best.btype, year: best.year }; }
      const from = partsGeo.p.length;
      partBuilding(partsGeo, pt, fp);
      if (TERRAIN_ON) partsGeo.lift(from, pt.lift !== undefined ? pt.lift : hAt(pt.x, pt.z));
    } }
  // sights (attractions, churches, monuments, castles, museums, town halls) with their names, for the info card in the game
  const sights = [];
  { const L = layers.poi; if (L) { const toP = mk(L.extent || ext0);
    for (const rng of L.feats) { const f = readFeature(L, rng); if (f.type !== 1) continue;
      const cls = (f.props.class || '') + ' ' + (f.props.subclass || ''), nm = f.props['name:de'] || f.props.name_de || f.props.name; if (!nm) continue;
      if (!/attraction|place_of_worship|monument|memorial|castle|museum|town_hall|theatre|viewpoint|ruins|fort|zoo|artwork|church|cathedral/.test(cls)) continue;
      for (const pt of pointsOf(f, toP)) if (!sights.some(q => q.name === nm && Math.hypot(q.x - pt[0], q.z - pt[1]) < 80)) sights.push({ name: nm, cls: (f.props.subclass || f.props.class || ''), x: pt[0], z: pt[1], rank: +f.props.rank || 99 });
    } } }
  // petrol stations (map POI 'fuel'): canopy on pillars, pump islands, price pylon at the road – recognisable at a glance
  { const L = layers.poi; if (L) { const toP = mk(L.extent || ext0), done = [];
    for (const rng of L.feats) { const f = readFeature(L, rng); if (f.type !== 1 || f.props.class !== 'fuel') continue;
      /* Runde 204 (phone: e-charging points stood there as petrol stations): the map puts charging stations in the class 'fuel'
         too (subclass charging_station) - they get one or two slim charging posts at the kerb, no canopy, no pumps */
      if (f.props.subclass === 'charging_station') { for (const pt of pointsOf(f, toP)) { if (fpAt(pt[0], pt[1]) || done.some(q => Math.hypot(q[0] - pt[0], q[1] - pt[1]) < 6)) continue; done.push([pt[0], pt[1]]);
          const r = roadAt(pt[0], pt[1]); let dx = 1, dz = 0; if (r) { dx = r[2]; dz = r[3]; } const n = hashStr('ev' + pt[0].toFixed(0)) < .5 ? 1 : 2, Wc = hex('#eef0ee'), Gc = hex('#2f9a4a'), Dc = hex('#3a3c40');
          for (let k = 0; k < n; k++) { const x = pt[0] + dx * (k - (n - 1) / 2) * 2.4, z = pt[1] + dz * (k - (n - 1) / 2) * 2.4;
            obox2(ground, x, 0, z, .42, 1.45, .3, dx, dz, Wc); obox2(ground, x, 1.2, z, .44, .22, .32, dx, dz, Gc); obox2(ground, x, .75, z, .2, .2, .34, dx, dz, Dc); } // post, green light band, socket
          sights.push({ name: 'Ladesäule', cls: 'charging', x: pt[0], z: pt[1], rank: 99, quiet: true }); } continue; }
      for (const pt of pointsOf(f, toP)) {
        if (done.some(q => Math.hypot(q[0] - pt[0], q[1] - pt[1]) < 40)) continue;
        const r = roadAt(pt[0], pt[1]); let dx = 1, dz = 0, nx = 0, nz = 1;
        if (r) { dx = r[2]; dz = r[3]; nx = r[0] - pt[0]; nz = r[1] - pt[1]; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l; }
        let x = pt[0], z = pt[1], k = 0; while (fpAt(x, z) && k++ < 40) { x += nx * 1; z += nz * 1; } // the point is often the shop: canopy in front of it
        x += nx * 6; z += nz * 6;
        if (r && Math.hypot(r[0] - x, r[1] - z) < r[4] / 2 + 6) { x -= nx * 4; z -= nz * 4; }
        if (fpAt(x, z)) continue; done.push([x, z]);
        const brand = [hex('#d2232a'), hex('#1f5fbf'), hex('#f2b705'), hex('#1b8a3a'), hex('#e35d10')][Math.floor(hashStr('fuel' + x.toFixed(0)) * 5)], W = hex('#f1f0ec'), G = hex('#8d8f93'), D = hex('#3a3c40');
        const pv = (u, v) => [x + dx * u + nx * v, z + dz * u + nz * v];
        { const c = [pv(-11, -8), pv(11, -8), pv(11, 8), pv(-11, 8)]; ground.quad([c[0][0], .04, c[0][1]], [c[1][0], .04, c[1][1]], [c[2][0], .04, c[2][1]], [c[3][0], .04, c[3][1]], hex('#a9a7a1'), 0, 1, 0); } // forecourt
        obox(ground, x, 4.6, z, 16, .55, 10, dx, dz, W); obox(ground, x, 4.45, z, 16.3, .25, 10.3, dx, dz, brand);                        // canopy with brand stripe
        for (const [u, v] of [[-6, -3.5], [6, -3.5], [-6, 3.5], [6, 3.5]]) { const q = pv(u, v); obox(ground, q[0], 0, q[1], .45, 4.5, .45, dx, dz, G); } // pillars
        for (const u of [-4, 0, 4]) { const q = pv(u, 0); obox(ground, q[0], 0, q[1], 1.6, .2, .9, dx, dz, G); obox(ground, q[0], .2, q[1], .7, 1.5, .45, dx, dz, W); obox(ground, q[0], 1.45, q[1], .72, .3, .47, dx, dz, brand); }
        const s0 = pv(-9, 7.5); obox(ground, s0[0], 0, s0[1], .5, 6.2, .5, dx, dz, D); obox(ground, s0[0], 4.2, s0[1], 1.8, 2.2, .35, dx, dz, brand); obox(ground, s0[0], 3.0, s0[1], 1.6, 1.1, .38, dx, dz, W); // price pylon
        sights.push({ name: f.props.name || 'Tankstelle', cls: 'fuel', x, z, rank: 99, quiet: true });
      } } } }
  // playgrounds: swings and slides (sprites); sports pitches: white lines, goals on large pitches
  /* Runde 196 (phone: the climbing frame / swing looked wrong from every side): the same playground often comes twice (two map layers,
     or a polygon over the tile edge) and each copy set its own swing - two frames 0.4-2.5 m apart, turned differently, read as one
     tangled frame. Now every playground item keeps 4 m from the others, and stands only inside its own tile. */
  const pgAt = [], TBp = ground.tileBox;
  for (const q of playPolys) {
    let ax = Infinity, bx = -Infinity, az = Infinity, bz = -Infinity; for (let i = 0; i < q.length; i += 2) { ax = Math.min(ax, q[i]); bx = Math.max(bx, q[i]); az = Math.min(az, q[i + 1]); bz = Math.max(bz, q[i + 1]); }
    const n = Math.min(4, 1 + Math.floor(Math.abs(ringArea(q)) / 250));
    for (let i = 0, tries = 0; i < n && tries < 20; tries++) { const x = ax + rnd() * (bx - ax), z = az + rnd() * (bz - az); if (!inPoly(x, z, q) || fpAt(x, z)) continue;
      if (TBp && (x < TBp[0] || x > TBp[2] || z < TBp[1] || z > TBp[3])) continue; if (pgAt.some(o => (o[0] - x) ** 2 + (o[1] - z) ** 2 < 16)) continue; pgAt.push([x, z]);
      const t = i % 2 ? 27 : 26; ground.spr.push(x, z, 3.2, 3.2, t, sprY(x, z, hashStr('pg' + x.toFixed(1)))); i++; }
  }
  /* Runde 204/209: fantasy cemeteries - the inside of a cemetery is filled with made-up graves: rows of plots in the cemetery's own
     direction (oriented box), blocks of 10 x 6 plots with gravel paths and low hedges between them. A grave is a stone curb with a
     bed (two flat faces, no box), a headstone (upright, stepped, pointed, lying plate, wooden or stone cross, now and then a stele or
     a figure), flowers, a small shrub, grave lights that glow at night. Family vaults and mausoleums (gable or pyramid roof, plinth,
     dark door) stand on block corners; a big cemetery without any building in it gets a small chapel with a ridge turret.
     Never on a mapped path or under a building, only inside the own tile; at most 450 graves per cemetery and 520 per tile
     (big cemeteries: whole blocks at random, the rest stays lawn and trees). About 9 faces a grave. Every cemetery goes into
     map.friedhoefe (centre, ring, size, graves, chapel) - for riddles later. Same seed, same cemetery. */
  /* Runde 215 (Sennefriedhof ~100 ha: only a small island of graves): ordinary graves are no ground geometry any more but a compact list
     (map.graves: x, y, z, ux, uz, width, curb, bed, kind, stone w, stone h, stone colour) that the app draws as instances in 32 m blocks -
     beds near (45 m), stones further (85 m), nothing beyond. So a big cemetery can be filled: up to 30 000 graves per tile. Vaults,
     chapel, paths and hedges stay geometry; plants and lights stay sprites (fewer per grave). */
  const GR = [], pack = c => (Math.round(c[0] * 255) << 16) + (Math.round(c[1] * 255) << 8) + Math.round(c[2] * 255);
  { const TBc = ground.tileBox, CAP = 20000; let used = 0; map.friedhoefe = [];
    const GRAN = ['#7d7f84', '#5d6066', '#9a9ca0', '#3a3b40', '#b8a789', '#2a2b30', '#d9d7d0', '#8a8274', '#6e5a4e'].map(hex), BED = ['#4f7a3a', '#5f8a40', '#6a8f45', '#6b4e36', '#a9a69c', '#3f6a34', '#7a9a50'].map(hex),
      CURB = ['#9a9890', '#b4b0a6', '#7c7a74', '#c8c2b4'].map(hex), FL = ['#c43a3a', '#e8c24a', '#e6e2da', '#b04ab0', '#e88a3a', '#d65a8a'].map(hex), WOOD = hex('#6b4a2e'), LIGHTC = [1, .3, .16], LBODY = hex('#5a2422'),
      GRAVEL = hex('#c2baa8'), HEDGE = hex('#3d5f34'), SHRUB = ['#2f5a34', '#3f6e3a', '#4c7a3e'].map(hex), ROOFD = hex('#4a5058'), CH_W = ['#e8e2d4', '#cdbb94', '#b88a6a'].map(hex), DOOR = hex('#3a2a20'), WIN = hex('#3d4a66'), FIG = hex('#e2e0da');
    const lid = (x, y, z, len, wid, ux, uz, col) => { const hx = ux * len / 2, hz = uz * len / 2, bx = -uz * wid / 2, bz = ux * wid / 2; ground.quad([x - hx - bx, y, z - hz - bz], [x - hx + bx, y, z - hz + bz], [x + hx + bx, y, z + hz + bz], [x + hx - bx, y, z + hz - bz], col, 0, 1, 0); };
    const box = (x, y, z, len, h, wid, ux, uz, col, top) => obox2(ground, x, y, z, len, h, wid, ux, uz, col, top);
    const cap = (x, y, z, len, wid, h, ux, uz, col) => { const hx = ux * len / 2, hz = uz * len / 2, bx = -uz * wid / 2, bz = ux * wid / 2, c = [[x - hx - bx, z - hz - bz], [x + hx - bx, z + hz - bz], [x + hx + bx, z + hz + bz], [x - hx + bx, z - hz + bz]];
      for (let k = 0; k < 4; k++) { const a = c[k], b = c[(k + 1) % 4]; ground.tri(a[0], y, a[1], b[0], y, b[1], x, y + h, z, col, (a[0] + b[0]) / 2 - x, .5, (a[1] + b[1]) / 2 - z); } }; // pyramid cap
    const ridge = (x, y, z, len, wid, h, ux, uz, col) => { const hx = ux * len / 2, hz = uz * len / 2, bx = -uz * wid / 2, bz = ux * wid / 2; // gable roof, ridge along u
      const A = [x - hx - bx, y, z - hz - bz], B2 = [x + hx - bx, y, z + hz - bz], C2 = [x + hx + bx, y, z + hz + bz], D = [x - hx + bx, y, z - hz + bz], E = [x - hx, y + h, z - hz], F = [x + hx, y + h, z + hz];
      ground.quad(A, B2, F, E, col, -bx, .6, -bz); ground.quad(D, C2, F, E, col, bx, .6, bz);
      ground.tri(A[0], A[1], A[2], D[0], D[1], D[2], E[0], E[1], E[2], col, -hx, 0, -hz); ground.tri(B2[0], B2[1], B2[2], C2[0], C2[1], C2[2], F[0], F[1], F[2], col, hx, 0, hz); };
    for (const q of cemPolys) { if (used >= CAP) break; const ar = Math.abs(ringArea(q)); if (ar < 250) continue; const o = obb(q); if (!o) continue; const bb = bbox(q);
      let st = Math.floor(hashStr('fh' + o.cx.toFixed(0) + ',' + o.cz.toFixed(0)) * 2147483645) + 1; const R = () => (st = st * 16807 % 2147483647) / 2147483647, pick = a => a[(R() * a.length) | 0];
      const rc2 = new Set(), ck = (x, z) => Math.floor(x / 2) * 100003 + Math.floor(z / 2);
      for (const r of map.roads) { const p = r.p; for (let i = 0; i + 3 < p.length; i += 2) { if (Math.max(p[i], p[i + 2]) < bb.minx - 3 || Math.min(p[i], p[i + 2]) > bb.maxx + 3 || Math.max(p[i + 1], p[i + 3]) < bb.minz - 3 || Math.min(p[i + 1], p[i + 3]) > bb.maxz + 3) continue;
        const dx = p[i + 2] - p[i], dz = p[i + 3] - p[i + 1], L = Math.hypot(dx, dz) || 1; for (let t = 0; t <= L; t += 1) rc2.add(ck(p[i] + dx * t / L, p[i + 1] + dz * t / L)); } }
      const nearRoad = (x, z) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (rc2.has(ck(x + a * 2, z + b * 2))) return true; return false; };
      const inside = (x, z) => (!TBc || (x >= TBc[0] && x <= TBc[2] && z >= TBc[1] && z <= TBc[3])) && inPoly(x, z, q) && !fpAt(x, z);
      const PW = 3.9, RW = 7.4, BU = 8, BV = 5, /* Runde 217/218: graves at the scale of the figure (~1.7x again) - it can hide behind a tall stone */ bw = BU * PW + 5, bd = BV * RW + 4, ux = o.c, uz = o.s, vx = -o.s, vz = o.c, W2 = (u, v) => [o.cx + u * ux + v * vx, o.cz + u * uz + v * vz];
      // a chapel for big cemeteries with no building at all inside (otherwise the mapped chapel or hall is there already)
      let chapel = null;
      if (ar > 6000) { let any = false; for (let u = -o.w / 2; u < o.w / 2 && !any; u += 8) for (let v = -o.d / 2; v < o.d / 2 && !any; v += 8) { const [x, z] = W2(u, v); if (inPoly(x, z, q) && fpAt(x, z)) any = true; }
        const [x, z] = W2(0, 0);
        if (!any && inside(x, z) && inside(...W2(6, 9)) && inside(...W2(-6, -9)) && !nearRoad(x, z)) {
          const wc = pick(CH_W); box(x, 0, z, 7, 6, 12, ux, uz, wc); ridge(x, 6, z, 12.4, 7.6, 4.5, vx, vz, ROOFD);
          const [tx, tz] = W2(0, -6.6); box(tx, 0, tz, 3, 11, 3, ux, uz, wc); cap(tx, 11, tz, 3.4, 3.4, 5, ux, uz, ROOFD);
          const [dx2, dz2] = W2(0, -8.15); box(dx2, 0, dz2, 1.4, 2.4, .1, ux, uz, DOOR);
          for (const sg of [-1, 1]) for (const v of [-2, 2]) { const [wx, wz] = W2(sg * 3.55, v); box(wx, 2.2, wz, .1, 2.2, .9, ux, uz, WIN); }
          chapel = { x: Math.round(x), z: Math.round(z) }; } }
      const blocks = []; for (let bu = -o.w / 2 + 2; bu + bw / 2 < o.w / 2 + bw / 2; bu += bw) for (let bv = -o.d / 2 + 2; bv < o.d / 2 - 2; bv += bd) blocks.push([bu, bv, R() + ((Math.round((bu + o.w) / bw) % 2) + 2 * (Math.round((bv + o.d) / bd) % 2)) * (R() < .85 ? 1 : 0)]); // spread: one of every 2x2 blocks first, all over the cemetery
      blocks.sort((a, b) => a[2] - b[2]); let n = 0;
      /* Runde 217: single graves spread over the whole cemetery (not whole fields here and there): every plot gets a grave with the same
         chance, so the cap is used evenly; each block its own density (55-100 %) for natural gaps */
      const dens = Math.min(1, (CAP - used) / Math.max(1, blocks.length * BU * BV * .8));
      for (const [bu, bv] of blocks) { if (used >= CAP) break; let placed = 0; const bd2 = dens * (.55 + R() * .45);
        for (let j = 0; j < BV; j++) for (let k = 0; k < BU; k++) { const u = bu + (k + .5) * PW, v = bv + (j + .5) * RW, [x, z] = W2(u, v);
          if (chapel && Math.hypot(x - chapel.x, z - chapel.z) < 16) continue;
          if (R() > bd2) continue;
          if (!inside(x + vx * 3, z + vz * 3) || !inside(x - vx * 3, z - vz * 3) || nearRoad(x, z)) continue;
          const r = R(), hx = x - vx * 2.4, hz = z - vz * 2.4; // head end of the plot
          if ((k === 0 || k === BU - 1) && (j === 0 || j === BV - 1) && r < .22) { // family vault / mausoleum on a block corner
            const c = pick(GRAN), H = 4.6 + R() * 2; box(x, 0, z, 3.8, .6, 6.2, ux, uz, pick(CURB)); box(x, .6, z, 3.4, H, 5.4, ux, uz, c);
            if (R() < .5) ridge(x, .6 + H, z, 5.8, 3.8, 1.8, vx, vz, c); else cap(x, .6 + H, z, 3.8, 5.8, 2.6, ux, uz, ROOFD);
            box(x - vx * 2.72, .6, z - vz * 2.72, 1.4, 3.0, .08, ux, uz, DOOR); roadCells.add(rc(x, z)); n++; used++; placed++; continue; }
          const dbl = R() < .14, w = dbl ? 3.4 : 2.2, y0 = .03;
          { const t = R(), kind = t < .34 ? 0 : t < .5 ? 1 : t < .62 ? 2 : t < .8 ? 3 : t < .95 ? 4 : t < .985 ? 5 : 6, c = kind === 3 && R() < .55 ? WOOD : pick(GRAN);
            GR.push(x, TERRAIN_ON ? dzLift(x, z, hAt(x, z)) : 0, z, ux, uz, w, pack(pick(CURB)), pack(pick(BED)), kind, Math.min(w, 1.2 + R() * 1.1), 1.6 + R() * 1.6, pack(c)); } // the app builds it
          /* Runde 210: planting and grave lights as sprites (one quad each, drawn with all the other sprites of the tile) */
          const sp = (sx, sz, w, h, t) => ground.spr.push(sx, sz, w, h, t, sprY(sx, sz, R()));
          if (R() < .35) { const np = 1 + ((R() * 3) | 0), kind = [43, 45, 46, 47][(R() * 4) | 0]; // Runde 211/215: single plants on some beds
            for (let q2 = 0; q2 < np; q2++) { const pu = (R() - .5) * (w - .5), pv = -.3 + R() * 2.2, s2 = .7 + R() * .4; sp(x + ux * pu + vx * pv, z + uz * pu + vz * pv, s2, s2 * (.8 + R() * .3), R() < .7 ? kind : [43, 45, 46, 47][(R() * 4) | 0]); } }
          if (R() < .12) sp(hx + vx * .75 - ux * w * .35, hz + vz * .75 - uz * w * .35, 1.0, 1.3 + R() * .4, 44); // small evergreen beside the stone
          if (R() < .15) sp(hx + vx * .7 + ux * .6, hz + vz * .7 + uz * .6, .4, .6, 42);  // grave light (flame glows at night)
          if (R() < .3) roadCells.add(rc(x, z)); n++; used++; placed++; } // Runde 215: forest cemeteries keep most of their trees between the graves
        if (placed > 2) { // gravel path and a low hedge along the block
          const [px, pz] = W2(bu + BU * PW / 2, bv - 3.1); if (inside(px, pz)) lid(px, .05, pz, BU * PW + 5, 3.6, ux, uz, GRAVEL);
          const [hx2, hz2] = W2(bu - 2.4, bv + BV * RW / 2); if (inside(hx2, hz2) && R() < .6) box(hx2, 0, hz2, .7, 1.1, BV * RW, ux, uz, HEDGE); } }
      map.friedhoefe.push({ x: o.cx, z: o.cz, ar: Math.round(ar), graves: n, chapel, ring: Array.from(q, v => Math.round(v * 10) / 10) }); } }
  if (GR.length) map.graves = Float32Array.from(GR);
  /* Runde 213 (foliage video: patches of one kind + scaled/fewer): loose clusters of wild flowers and grass on parks, meadows and lawns
     (a cluster centre every ~15-40 m, 4-12 plants of one kind within 2.5 m around it), and flower strips along field edges (poppy /
     cornflower / grass on the inner 2.5 m of farmland). Single plant sprites 43/45/46/47; the sprite shader thins them out with
     distance (none beyond 80 m). Hard cap per tile 650; never on roads, paths, buildings, only inside the own tile. */
  { const TBm = ground.tileBox, CAPM = 650; let nm = 0;
    const h2 = (a, b) => { let x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };
    const ok = (x, z, q) => (!TBm || (x >= TBm[0] && x <= TBm[2] && z >= TBm[1] && z <= TBm[3])) && inPoly(x, z, q) && !fpAt(x, z) && !roadCells.has(rc(x, z));
    const plant = (x, z, kind) => { const s = (kind === 46 ? .75 : .8) + h2(x, z) * .45; /* Runde 214: oversized like the other props, else invisible at pixel size 2 */ ground.spr.push(x, z, s, s * (.85 + h2(z, x) * .3), kind, sprY(x, z, h2(x * 3, z))); nm++; };
    for (const q of meadowPolys) { if (nm >= CAPM) break; const bb = bbox(q), ar = Math.abs(ringArea(q)); if (ar < 120) continue;
      let nc = Math.max(1, Math.round(ar / (h2(bb.minx, bb.minz) < .5 ? 300 : 700)));                       // some parks lusher than others
      for (let c = 0; c < nc * 3 && nm < CAPM; c++) { const cx = bb.minx + h2(c, bb.minx) * (bb.maxx - bb.minx), cz = bb.minz + h2(bb.minz, c + .5) * (bb.maxz - bb.minz);
        if (!ok(cx, cz, q)) continue; const r = h2(cx, cz), kind = r < .35 ? 46 : r < .58 ? 43 : r < .8 ? 45 : 47, n = 4 + ((h2(cz, cx) * 9) | 0);
        for (let i = 0; i < n && nm < CAPM; i++) { const a = h2(i, cx) * 6.283, d = Math.sqrt(h2(cz, i)) * 2.5, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d; if (ok(x, z, q)) plant(x, z, h2(x, i) < .85 ? kind : 46); }
        if (--nc <= 0) break; } }
    for (const q of fieldPolys) { if (nm >= CAPM) break; let cx0 = 0, cz0 = 0; for (let i = 0; i < q.length; i += 2) { cx0 += q[i]; cz0 += q[i + 1]; } cx0 /= q.length / 2; cz0 /= q.length / 2;
      for (let i = 0; i + 3 < q.length && nm < CAPM; i += 2) { const ax = q[i], az = q[i + 1], ex = q[i + 2] - ax, ez = q[i + 3] - az, L = Math.hypot(ex, ez); if (L < 4) continue;
        let nx = -ez / L, nz = ex / L; if (nx * (cx0 - ax) + nz * (cz0 - az) < 0) { nx = -nx; nz = -nz; }                 // inward
        for (let t = 1.5; t < L - 1 && nm < CAPM; t += 2.2 + h2(ax + t, az) * 4) { if (h2(t, ax) < .45) continue;             // a strip with gaps
          const d = .6 + h2(az, t) * 1.9, x = ax + ex / L * t + nx * d, z = az + ez / L * t + nz * d, r = h2(x * .2, z * .2); if (!ok(x, z, q)) continue;
          plant(x, z, r < .4 ? 43 : r < .65 ? 46 : r < .85 ? 45 : 47); } } } }
  for (const q of pitchPolys) {
    const o = obb(q); if (!o || o.w < 12 || o.d < 8) continue;
    const L2 = o.w / 2 - 1, D2 = o.d / 2 - 1, P2 = (u, v) => [o.cx + u * o.c - v * o.s, o.cz + u * o.s + v * o.c], Wt = hex('#f2f2ee');
    const line = (u0, v0, u1, v1) => { const a = P2(u0, v0), b = P2(u1, v1); ribbon(ground, [a[0], a[1], b[0], b[1]], 0.18, .03, Wt); };
    line(-L2, -D2, L2, -D2); line(-L2, D2, L2, D2); line(-L2, -D2, -L2, D2); line(L2, -D2, L2, D2); line(0, -D2, 0, D2);
    if (o.w > 40) for (const sg of [-1, 1]) { // football goals at both ends
      const a = P2(sg * L2, -3.6), b = P2(sg * L2, 3.6), m = P2(sg * L2, 0), ux = o.c, uz = o.s;
      ground.box(a[0], 0, a[1], .14, 2.4, .14, Wt); ground.box(b[0], 0, b[1], .14, 2.4, .14, Wt); obox(ground, m[0], 2.3, m[1], .14, .14, 7.3, ux, uz, Wt);
    }
  }
  // squares and pedestrian zones (Breitscheidplatz …): more people, café tables along the shops, planters
  for (let k = 0; k < plazaPolys.length; k++) {
    const q = plazaPolys[k]; let ax = Infinity, bx = -Infinity, az = Infinity, bz = -Infinity; for (let i = 0; i < q.length; i += 2) { ax = Math.min(ax, q[i]); bx = Math.max(bx, q[i]); az = Math.min(az, q[i + 1]); bz = Math.max(bz, q[i + 1]); }
    const area = Math.abs(ringArea(q)), n = Math.min(60, Math.floor(area / 140));
    for (let i = 0, tries = 0; i < n && tries < n * 4; tries++) {
      const x = ax + rnd() * (bx - ax), z = az + rnd() * (bz - az); if (!inPoly(x, z, q) || fpAt(x, z)) continue;
      const sd = hashStr('pl' + x.toFixed(1) + z.toFixed(1)), near = fpAt(x + 4, z) || fpAt(x - 4, z) || fpAt(x, z + 4) || fpAt(x, z - 4);
      const t = near && near.shop && sd < 0.45 ? 25 : sd < 0.12 ? 24 : (sd < 0.56 ? 18 : 20);
      ground.spr.push(x, z, t === 25 ? 2.6 : t === 24 ? 1.1 : 1.9, t === 25 ? 2.6 : t === 24 ? 1.1 : 1.9, t, sprY(x, z, sd)); i++;
    }
  }
  // Street View (Moritzburg, lake shores): banks of lakes and ponds are lined with shrubs and trees, not bare.
  // Only real shores count (tile-cut edges of water polygons are skipped); never on roads, sidewalks or in houses.
  { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0), bx0 = Math.min(c0[0], c1[0]) + 3, bx1 = Math.max(c0[0], c1[0]) - 3, bz0 = Math.min(c0[1], c1[1]) + 3, bz1 = Math.max(c0[1], c1[1]) - 3;
    let ns = 0;
    for (const ring of waterRings) {
      const ar = Math.abs(ringArea(ring)); if (ar < 150) continue; // tiny pools: no bank vegetation
      for (let i = 0; i + 3 < ring.length && ns < 3000; i += 2) {
        const ax = ring[i], az = ring[i + 1], ex = ring[i + 2] - ax, ez = ring[i + 3] - az, L = Math.hypot(ex, ez); if (L < 0.5) continue;
        for (let u = rnd() * 3; u < L; u += 3.2) {
          const px = ax + ex * u / L, pz = az + ez * u / L; if (px < bx0 || px > bx1 || pz < bz0 || pz > bz1) continue;
          let nx = -ez / L, nz = ex / L; if (inPoly(px + nx * 2.5, pz + nz * 2.5, ring)) { nx = -nx; nz = -nz; } // point to the land side
          const d = 1.2 + rnd() * 2.2, x = px + nx * d, z = pz + nz * d;
          if (hashStr(Math.floor(x / 18) + '/' + Math.floor(z / 18)) < 0.2) continue; // open spots (jetties, beaches)
          const rd = roadAt(x, z); if (rd && Math.hypot(rd[0] - x, rd[1] - z) < rd[4] / 2 + 2.8) continue;
          if (paved.has(rc(x, z)) || fpAt(x, z) || fpAt(x + nx * 4, z + nz * 4)) continue;
          if (rnd() < 0.22) tree(ground, x + nx * 1.5, z + nz * 1.5, 1.1 + rnd() * 0.6, rnd);
          else shrub(ground, x, z, 1.0 + rnd() * .5, 1.2 + rnd() * .9, SHRUB[Math.floor(rnd() * SHRUB.length)]);
          ns++;
        }
      }
    }
  }
  for (let i = 0, nbk = 0; i < bankCand.length && nbk < 2500; i += 2) { // bushes and trees along streams
    const x = bankCand[i] + (rnd() - .5), z = bankCand[i + 1] + (rnd() - .5);
    if (hashStr(Math.floor(x / 16) + '|' + Math.floor(z / 16)) < 0.25 || nearRoad(x, z) || paved.has(rc(x, z)) || fpAt(x, z)) continue;
    if (rnd() < 0.25) treeCand.push(x, z, 1.1 + rnd() * .6); else shrub(ground, x, z, .9 + rnd() * .5, 1.1 + rnd() * .8, SHRUB[Math.floor(rnd() * SHRUB.length)]);
    nbk++;
  }
  // Google 3D (Black Forest, Harz …): forests in Central Europe are mostly dark conifers; parks, gardens and streets mostly broadleaf.
  // Which forest is which is not in the free data, so forests get ~60 % conifers (German forest statistics), elsewhere ~8 %.
  const forestCells = new Map(), fk = (x, z) => Math.floor(x / 20) * 100003 + Math.floor(z / 20);
  for (const ring of forestRings) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]); }
    // big forests (> 20 ha) are mostly managed conifer forest; small woods in and around towns (Großer Garten Dresden) mostly broadleaf
    const share = Math.abs(ringArea(ring)) > 200000 ? 0.6 : 0.2;
    const inPark = (x, z) => parkRings.some(q => inPoly(x, z, q)); // woods inside city parks are planted broadleaf
    for (let x = Math.floor(x0 / 20) * 20 + 10; x < x1; x += 20) for (let z = Math.floor(z0 / 20) * 20 + 10; z < z1; z += 20) if (inPoly(x, z, ring)) forestCells.set(fk(x, z), inPark(x, z) ? 0.1 : Math.max(share, forestCells.get(fk(x, z)) || 0));
  }
  if (MED) { // Runde 165: the land between the settlements is wood, with clearings (smooth noise on a 160 m grid)
    const vn = MED.vn, P = MED.ponds, [bx0, bz0, bx1, bz1] = MED.box;
    for (let x = bx0 + 4; x < bx1; x += 9) for (let z = bz0 + 4; z < bz1; z += 9) { const jx = x + (rnd() - .5) * 7, jz = z + (rnd() - .5) * 7;
      if (vn(jx, jz) < .42 || MED.townD(jx, jz) < 1.2 || MED.near(jx, jz, 55)) continue; let wet = false; for (let k = 0; k < P.length; k += 3) if (Math.abs(P[k] - jx) < P[k + 2] && Math.abs(P[k + 1] - jz) < P[k + 2]) wet = true; if (wet) continue;
      treeCand.push(jx, jz, 1.2 + rnd() * .8); }
    for (const h of HAMLETS) BURG_CLR.push(h.x, h.z); }
  // keep phones fast: at most ~18000 sprite trees per tile; thinned trees get larger crowns to keep the canopy closed
  const step = Math.max(1, Math.ceil(treeCand.length / 3 / 18000)), grow = Math.sqrt(step); // sprites: 4 vertices per tree
  for (let i = 0; i < treeCand.length; i += 3 * step) {
    const x = treeCand[i], z = treeCand[i + 1];
    if (roadCells.has(rc(x, z)) || fpAt(x, z) || fpAt(x + 2.5, z) || fpAt(x - 2.5, z) || fpAt(x, z + 2.5) || fpAt(x, z - 2.5)) continue;
    const ts = Math.min(3, treeCand[i + 2] * grow);
    // the dark shadow under each crown (Google 3D Großer Garten: closed canopy) is drawn by the sprite shader, see sprites.js
    tree(ground, x, z, ts, rnd, rnd() < (forestCells.get(fk(x, z)) || 0.08));
  }
  // water mask (phone test: trees and bushes in the middle of lakes and rivers): the 10 m tree map, scattering and bank
  // planting don't know the exact shore, so every tree, bush and prop is checked once more against lakes (islands kept) and rivers
  { const wb = waterPolys.map(pl => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; const r = pl[0];
      for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); b = Math.max(b, r[i]); c = Math.min(c, r[i + 1]); d = Math.max(d, r[i + 1]); } return [a, b, c, d]; });
    const lineCells = new Map(), lk = (x, z) => Math.floor(x / 10) * 100003 + Math.floor(z / 10);
    for (let k = 0; k < waterLines.length; k += 2) { const line = waterLines[k], w = waterLines[k + 1];
      for (let i = 0; i + 3 < line.length; i += 2) { const seg = [line[i], line[i + 1], line[i + 2], line[i + 3], w / 2 + 0.6];
        const n = Math.ceil(Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]) / 5) + 1;
        for (let j = 0; j <= n; j++) { const x = line[i] + (line[i + 2] - line[i]) * j / n, z = line[i + 1] + (line[i + 3] - line[i + 1]) * j / n;
          for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const key = (Math.floor(x / 10) + a) * 100003 + Math.floor(z / 10) + b; let arr = lineCells.get(key); if (!arr) lineCells.set(key, arr = []); if (arr[arr.length - 1] !== seg) arr.push(seg); } } } }
    const wet = (x, z) => {
      for (let i = 0; i < waterPolys.length; i++) { const bb = wb[i]; if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
        const pl = waterPolys[i]; if (inPoly(x, z, pl[0])) { let island = false; for (let h = 1; h < pl.length; h++) if (inPoly(x, z, pl[h])) { island = true; break; } if (!island) return true; } }
      const segs = lineCells.get(lk(x, z));
      if (segs) for (const [ax, az, bx, bz, r] of segs) { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < r * r) return true; }
      return false;
    };
    if (waterPolys.length || waterLines.length) { const S = ground.spr, out = []; for (let i = 0; i < S.length; i += 6) if (!wet(S[i], S[i + 1])) for (let k = 0; k < 6; k++) out.push(S[i + k]); ground.spr = out; }
  }
  const wfield = waterPolys.length || waterLines.length ? waterField(waterPolys, waterLines, mk(ext0), { green: greenPolys, urban: resPolys.concat(indPolys, plazaPolys).map(p => [p]), blds: fpItems.map(it => [it.p]), paved: (x, z) => paved.has(rc(x, z)) || nearRoad(x, z), dryLines, dryPolys, bridgeDry }, ground) : null;
  if (TERRAIN_ON) meadow(ground, mk(ext0), wfield); // base ground of the tile, cut out where the (lowered) water is
  // land areas lying on open water (tidal flats, reed, beaches in the river - phone test Hamburg: boats in a meadow) sink to the water
  // level with the water, so they never cover it; streets, paths, piers and bridges keep their height (checked per drape piece)
  if (wfield && wfield.loops) { // shore outline for the area layers (park, lawn, forest...): cut exactly there, nothing of them on the water
    const f = wfield, grid = new Map(), K = 24;
    for (const { ring: r } of f.loops) for (let a = 0, n = r.length / 2; a < n; a++) { const b = (a + 1) % n, ax = r[a * 2], az = r[a * 2 + 1], bx = r[b * 2], bz = r[b * 2 + 1];
      for (let i = Math.floor(Math.min(ax, bx) / K); i <= Math.floor(Math.max(ax, bx) / K); i++) for (let j = Math.floor(Math.min(az, bz) / K); j <= Math.floor(Math.max(az, bz) / K); j++) { const k = i * 100003 + j; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(ax, az, bx, bz); } }
    ground.shore = { grid, K, wet: (x, z) => { const gx = Math.floor((x - f.x0) / f.c), gz = Math.floor((z - f.z0) / f.c); return gx >= 0 && gz >= 0 && gx < f.w && gz < f.h && f.data[(gz * f.w + gx) * 2] > 0; } }; }
  if (wfield && WL() > 0) { const f = wfield; ground.sinkAt = (x, z) => { const gx = Math.floor((x - f.x0) / f.c), gz = Math.floor((z - f.z0) / f.c); return gx >= 0 && gz >= 0 && gx < f.w && gz < f.h && f.data[(gz * f.w + gx) * 2] > 4; }; ground.sinkAt.depth = WL() + .05; }
  if (wfield) { const f = wfield; for (let z = 0; z < f.h; z += 2) for (let x = 0; x < f.w; x += 2) if (f.m[z * f.w + x] & 1) wetCells.add(wk(f.x0 + (x + .5) * f.c, f.z0 + (z + .5) * f.c)); delete wfield.m; }
  // boats: along both sides of jetties and at quays with open water in front (harbours, marinas, city rivers)
  { const BCOL = [3, 3, 3, 3, 4, 6, 1, 12]; let nb = 0;
    const boatType = r => r < .45 ? 8 : r < .85 ? 9 : 10, isWater = (x, z) => { if (!wfield) return false; const f = wfield, cx = Math.floor((x - f.x0) / f.c), cz = Math.floor((z - f.z0) / f.c); return cx >= 0 && cz >= 0 && cx < f.w && cz < f.h && f.data[(cz * f.w + cx) * 2] > 6; };
    const isWet = (x, z) => { if (!wfield) return false; const f = wfield, cx = Math.floor((x - f.x0) / f.c), cz = Math.floor((z - f.z0) / f.c); return cx >= 0 && cz >= 0 && cx < f.w && cz < f.h && f.data[(cz * f.w + cx) * 2] > 0; };
    const onDeck = (px, pz) => { for (let q = 0; q < pierLines.length; q += 2) { const l = pierLines[q], ww = pierLines[q + 1];
        if (!(ww > 0)) { if (inPoly(px, pz, l)) return true; continue; }
        for (let i = 0; i + 3 < l.length; i += 2) { const ax = l[i], az = l[i + 1], ex = l[i + 2] - ax, ez = l[i + 3] - az, qq = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1))); if (Math.hypot(ax + ex * qq - px, az + ez * qq - pz) < ww / 2 + .1) return true; } }
      return false; };
    for (let k = 0; k < pierLines.length; k += 2) { const line = pierLines[k], w = pierLines[k + 1] || 2.4;
      const big = w < 0; sampleLineDir(line, big ? 22 : 5.2, (x, z, dx, dz) => { for (const sd of [-1, 1]) { if (nb > 700 || rnd() < (big ? .55 : .15)) continue; /* marinas: boats side by side (Google Greetsiel) */ const t = big ? (rnd() < .7 ? 10 : 8) : rnd() < .6 ? 8 : 9, o = (pierLines[k + 1] > 0 ? w / 2 : 0) + (t === 8 ? 1.6 : t === 10 ? 2.6 : 1.9), bx = x - dz * o * sd, bz = z + dx * o * sd;
        if (!isWater(bx, bz)) continue;
        { // the whole hull on open water: off every deck (lines and areas, also the other arms of a T- or E-shaped jetty) and clear of
          // the boats already moored (phone test: boats lying across the jetty and in each other)
          const L2 = t === 8 ? 2.8 : t === 10 ? 7 : 3.8, ex = dx * L2, ez = dz * L2, o2 = t === 8 ? .8 : t === 10 ? 1.6 : 1.0; let bad = false;
          for (const [px, pz] of [[bx, bz], [bx + ex, bz + ez], [bx - ex, bz - ez], [bx + dz * o2, bz - dx * o2], [bx - dz * o2, bz + dx * o2], [bx + ex * .5 + dz * o2, bz + ez * .5 - dx * o2], [bx - ex * .5 - dz * o2, bz - ez * .5 + dx * o2]])
            if (!isWet(px, pz) || onDeck(px, pz)) { bad = true; break; }
          if (!bad) for (let q = cars.length - 6; q >= 0; q -= 6) { if (cars[q + 3] < 8) continue; const lq = cars[q + 3] === 10 ? 7 : 3.4; if (Math.hypot(cars[q] - bx, cars[q + 1] - bz) < (L2 + lq) * .55 + 1.2) { bad = true; break; } }
          if (bad) continue; }
        cars.push(bx, bz, Math.atan2(dx, dz) + (rnd() < .5 ? Math.PI : 0), t, BCOL[Math.floor(rnd() * BCOL.length)], rnd()); nb++; } }); }
    if (wfield) { const f = wfield;
      for (let z = 1; z < f.h - 1; z++) for (let x = 1; x < f.w - 1; x++) { const i = z * f.w + x; if (f.data[i * 2] !== 0 || f.data[i * 2 + 1] !== 255) continue; // hard shore cell (land)
        if (hashStr('bq' + Math.floor(x / 9) + '/' + Math.floor(z / 9)) > .1 || nb > 400) continue;
        for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = (z + uz * 4) * f.w + x + ux * 4, j2 = (z + uz * 8) * f.w + x + ux * 8;
          if (z + uz * 8 < 0 || z + uz * 8 >= f.h || x + ux * 8 < 0 || x + ux * 8 >= f.w || f.data[j * 2] < 12 || f.data[j2 * 2] < 28) continue;
          const t = boatType(hashStr('bt' + i)), off = t === 10 ? 4 : 2.6, wx = f.x0 + (x + .5) * f.c + ux * off, wz = f.z0 + (z + .5) * f.c + uz * off;
          if (cars.length) { let close = false; for (let q = cars.length - 6; q >= Math.max(0, cars.length - 60); q -= 6) if (cars[q + 3] >= 8 && Math.hypot(cars[q] - wx, cars[q + 1] - wz) < 14) { close = true; break; } if (close) break; }
          cars.push(wx, wz, Math.atan2(uz, -ux) * 0 + (ux !== 0 ? 0 : Math.PI / 2), t, t === 10 ? 3 : BCOL[Math.floor(hashStr('bc' + i) * BCOL.length)], hashStr('bs' + i)); nb++; break; } } } }
  { // underpass troughs of this tile and its neighbours (found before the build, see detectDips)
    const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0), bx0 = Math.min(c0[0], c1[0]) - 80, bx1 = Math.max(c0[0], c1[0]) + 80, bz0 = Math.min(c0[1], c1[1]) - 80, bz1 = Math.max(c0[1], c1[1]) + 80;
    ground.dips = glow.dips = dipsIn(bx0, bz0, bx1, bz1); ground.walls = true;
    // tunnel mouths (Runde 79): a dark opening in a concrete frame where a one-sided trough meets the ground
    for (const d of ground.dips) { if (!(d.F < 0) || d.x < bx0 || d.x > bx1 || d.z < bz0 || d.z > bz1) continue;
      const fr = hex('#9c9a94'), H = 5.2; // Runde 80: a frame - the tunnel tube behind it is drawn and driven by the game
      obox(ground, d.x + d.ux * .5, -d.D + H, d.z + d.uz * .5, 1.0, d.D - H + .05, d.hw * 2 + 1.2, d.ux, d.uz, fr); // header above the opening
      for (const sd of [-1, 1]) obox(ground, d.x + d.ux * .5 - d.uz * sd * (d.hw + .3), -d.D - .2, d.z + d.uz * .5 + d.ux * sd * (d.hw + .3), 1.0, d.D + .2, .6, d.ux, d.uz, fr); } }
  if (corrSegs.length) { // junctions: nodes shared by different streets (interior node of one, or 3+ ends) - levelling fades out 12..27 m around them
    const nodes = new Map(), nk = (x, z) => Math.round(x * 2) + ',' + Math.round(z * 2), J = [];
    drvLines.forEach((l, li) => { const n = l.length / 2; for (let v = 0; v < n; v++) { const k = nk(l[v * 2], l[v * 2 + 1]); let e = nodes.get(k); if (!e) nodes.set(k, e = { x: l[v * 2], z: l[v * 2 + 1], lines: new Set(), inner: false, ends: 0 }); if (!e.lines.has(li)) { e.lines.add(li); if (v > 0 && v < n - 1) e.inner = true; else e.ends++; } } });
    for (const e of nodes.values()) if (e.ends > 0 || (e.lines.size >= 2 && e.inner)) J.push(e.x, e.z); // every end of a street piece too: a levelled piece next to an unlevelled one left an open step (sky showed through)
    const jg = new Map(); for (let i = 0; i < J.length; i += 2) { const k = Math.floor(J[i] / 32) * 100003 + Math.floor(J[i + 1] / 32); let a = jg.get(k); if (!a) jg.set(k, a = []); a.push(J[i], J[i + 1]); }
    const jd = (x, z) => { let m = 1e9; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = jg.get((Math.floor(x / 32) + a) * 100003 + Math.floor(z / 32) + b); if (l) for (let i = 0; i < l.length; i += 2) m = Math.min(m, Math.hypot(l[i] - x, l[i + 1] - z)); } return m; };
    for (let i = 0; i < corrSegs.length; i += 6) { const d = Math.min(jd(corrSegs[i], corrSegs[i + 1]), jd(corrSegs[i + 2], corrSegs[i + 3]), jd((corrSegs[i] + corrSegs[i + 2]) / 2, (corrSegs[i + 1] + corrSegs[i + 3]) / 2));
      corrSegs[i + 5] *= Math.max(0, Math.min(1, (d - 12) / 15)); } }
  if (corrSegs.length) { const grid = new Map(), K = 24, B = 3; // street corridors (level across), indexed by 24 m cells incl. the 3 m embankment
    for (let i = 0; i < corrSegs.length; i += 6) { const x0 = corrSegs[i], z0 = corrSegs[i + 1], x1 = corrSegs[i + 2], z1 = corrSegs[i + 3], e = corrSegs[i + 4] + B;
      for (let gx = Math.floor((Math.min(x0, x1) - e) / K); gx <= Math.floor((Math.max(x0, x1) + e) / K); gx++) for (let gz = Math.floor((Math.min(z0, z1) - e) / K); gz <= Math.floor((Math.max(z0, z1) + e) / K); gz++) { const k = gx * 100003 + gz; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i); } }
    ground.corr = glow.corr = { segs: corrSegs, grid, K, B }; }
  if (STS.lines) post({ type: 'info', msg: 'STRBREITE ' + JSON.stringify(STS) });
  ground.drape(hAt); glow.forceS = ground.S; glow.drape(hAt); waterG.noShade = true; waterG.forceS = ground.S; waterG.drape(hAt); // everything on the ground's terrain grid: a pond on its own (coarser) grid lay above the meadow on slopes (phone test, Hohenschwangau)
  if (elevSegs.length || spanSegs.length) bridgeG.elev = (x, z) => { const T = bridgeG._tHz ? bridgeG._tHz(x, z) : hAt(x, z);
    for (let i = 0; i < elevSegs.length; i += 6) { const ex = elevSegs[i + 2] - elevSegs[i], ez = elevSegs[i + 3] - elevSegs[i + 1], L2 = ex * ex + ez * ez || 1, q = Math.max(0, Math.min(1, ((x - elevSegs[i]) * ex + (z - elevSegs[i + 1]) * ez) / L2)); if (Math.hypot(x - elevSegs[i] - ex * q, z - elevSegs[i + 1] - ez * q) < elevSegs[i + 4]) return hAt(x, z) + elevSegs[i + 5] - T; } // Runde 79: the deck is natural terrain + 5.5 m - ramps, troughs and dams of the roads below no longer make it wavy
    let sb = null, sdd = Infinity; for (let i = 0; i < spanSegs.length; i += 7) { const ex = spanSegs[i + 2] - spanSegs[i], ez = spanSegs[i + 3] - spanSegs[i + 1], L2 = ex * ex + ez * ez || 1, q = Math.max(0, Math.min(1, ((x - spanSegs[i]) * ex + (z - spanSegs[i + 1]) * ez) / L2)), d = Math.hypot(x - spanSegs[i] - ex * q, z - spanSegs[i + 1] - ez * q), dd = d + (spanSegs[i + 4] < 0 ? 1000 : 0); if (d < Math.abs(spanSegs[i + 4]) && dd < sdd) { sdd = dd; sb = spanSegs[i + 5] + (spanSegs[i + 6] - spanSegs[i + 5]) * q; } } if (sb !== null) return sb - T; // Runde 83: spanning deck, the nearest one (parallel bridges overlap)
    return 0; };
  bridgeG.noDip = true; bridgeG.forceS = ground.S; bridgeG.drape(hAt); // bridges keep the terrain height; appended to the ground mesh
  if (bridgeG.p.length) { ground.p = ground.p.concat(bridgeG.p); ground.n = ground.n.concat(bridgeG.n); ground.c = ground.c.concat(bridgeG.c); if (ground.gf && bridgeG.gf) ground.gf = ground.gf.concat(bridgeG.gf); }
  const detOut = (G, n) => { if (!G.dt) return null; const d = new Uint8Array(n); for (const t of G.dt) if (t < n) d[t] = 1; return d; };
  partsGeo.drapeSkip = true;
  // life: ducks in small groups on open water, pigeons circling over the houses, gulls over the water (all animated in the shader)
  if (wfield) { const f = wfield; let groups = 0;
    for (let tries = 0; tries < 400 && groups < 30; tries++) { const gx = Math.floor(rnd() * f.w), gz = Math.floor(rnd() * f.h), dv = f.data[(gz * f.w + gx) * 2]; if (dv < 12 || dv > 120) continue;
      const cx = f.x0 + (gx + .5) * f.c, cz = f.z0 + (gz + .5) * f.c, n = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) { const x = cx + (rnd() - .5) * 5, z = cz + (rnd() - .5) * 5; ground.spr.push(x, z, 1.9, 1.9, 28, Math.floor((hAt(x, z) - WL() + .3) * 4) + rnd() * .999); }
      groups++; }
    for (let k = 0, g2 = 0; k < 200 && g2 < 6; k++) { const gx = Math.floor(rnd() * f.w), gz = Math.floor(rnd() * f.h); if (f.data[(gz * f.w + gx) * 2] < 20) continue;
      const x = f.x0 + (gx + .5) * f.c, z = f.z0 + (gz + .5) * f.c; ground.spr.push(x, z, 2.8, 2.8, 38, Math.floor((hAt(x, z) + 10 + rnd() * 12) * 4) + rnd() * .999); g2++; } }
  { const c0 = mk(ext0)(0, 0), c1 = mk(ext0)(ext0, ext0);
    for (let k = 0; k < 10; k++) { const x = c0[0] + rnd() * (c1[0] - c0[0]), z = c0[1] + rnd() * (c1[1] - c0[1]); ground.spr.push(x, z, 2, 2, 30, Math.floor((hAt(x, z) + 14 + rnd() * 14) * 4) + rnd() * .999); } }
  // reflections (video "pixel art water": flip the image and lay it on the water): every tree or bush standing at the bank gets a
  // mirrored copy lying flat on the water in front of it; direction to the water is stored (0-7) so the shader only shows it when
  // the water lies between the tree and the camera. A few hundred extra sprites per tile, no second render pass.
  if (BURG_CLR.length) { const S = ground.spr, out = []; for (let i = 0; i < S.length; i += 6) { let ok = true; for (let k = 0; k < BURG_CLR.length; k += 2) if (Math.abs(S[i] - BURG_CLR[k]) < 26 && Math.abs(S[i + 1] - BURG_CLR[k + 1]) < 26) ok = false; if (ok) for (let k = 0; k < 6; k++) out.push(S[i + k]); } ground.spr = out; } // Runde 154: the castle stands in a clearing
  const refl = [];
  if (wfield) { const f = wfield, wat = (x, z) => { const gx = Math.floor((x - f.x0) / f.c), gz = Math.floor((z - f.z0) / f.c); return gx >= 0 && gz >= 0 && gx < f.w && gz < f.h && f.data[(gz * f.w + gx) * 2] > 4; };
    const S = ground.spr;
    for (let i = 0; i < S.length && refl.length < 4000 * 6; i += 6) { if (S[i + 4] >= 16 || S[i + 3] < 3 || S[i + 4] === 6 || S[i + 4] === 7 || S[i + 4] === 14) continue; const x = S[i], z = S[i + 1]; /* trees only: bushes barely show */
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, dx = Math.cos(a), dz = Math.sin(a);
        let d0 = 0; for (let d = 1.5; d <= 12; d += 1.5) if (wat(x + dx * d, z + dz * d)) { d0 = d; break; }
        if (!d0) continue;
        /* the mirror image lies on the water up to 1.3 x tree height (perspective) - only where the water really reaches that far and is wide enough (narrow streams, ditches: none) */
        const L = Math.max(8, S[i + 3] * 1.3), sx = -dz, sz = dx; let ok = true;
        for (let d = 2; d <= L && ok; d += 2) { const px = x + dx * (d0 + d), pz = z + dz * (d0 + d), w = S[i + 2] * .4; ok = wat(px, pz) && wat(px + sx * w, pz + sz * w) && wat(px - sx * w, pz - sz * w); }
        if (!ok) continue;
        const rx = x + dx * d0, rz = z + dz * d0, sd = S[i + 5] % 1;
        refl.push(rx, rz, S[i + 2], -(S[i + 3] + 100 * k), S[i + 4], Math.floor((hAt(rx, rz) - WL() + .65) * 4) + sd); /* base rounded to 25 cm: always just above the water surface; one copy per direction with water, the shader shows the one facing the camera */ } } }
  const dipsOut = []; for (const d of (ground.dips || [])) dipsOut.push(d.x, d.z, d.ux, d.uz, d.hw, d.F, d.R, d.D);
  const dzOut = DZF ? { x0: DZF.gx0 * DZC, z0: DZF.gz0 * DZC, nx: DZF.nx, nz: DZF.nz, c: DZC, W: DZF.W, WT: DZF.WT } : null; DZF = null;
  return { span: new Float32Array(spanSegs), elev: new Float32Array(elevSegs), dz: dzOut, corr: new Float32Array(corrSegs), waterS: waterG.S || 16, rails: new Float32Array(railSegs), dips: new Float32Array(dipsOut), refl: new Float32Array(refl), water: waterG.p.length ? Object.assign(waterG.out(), { field: wfield }) : null, welt: WOUT, items: fpItems, parts: partsGeo.p.length ? partsGeo.out() : null, sights, cars: new Float32Array(WELT === 'west' || WELT === 'mittel' ? [] : cars), spr: new Float32Array(ground.spr), ground: Object.assign(WELD ? ground.outWelded() : ground.out(), { det: detOut(ground, ground.p.length / 9) }), glow: Object.assign(glow.out(), { det: detOut(glow, glow.p.length / 9) }), buckets, collide: new Float32Array(collide), names, samples: new Float32Array(samples), sqNames: new Float32Array(sqNames), pedNames: [...pedNames], spawn: new Float32Array(spawn), start: new Float32Array(start), map };
}
/* Runde 204: an oriented box whose sides face outwards (obox below winds them inwards - seen from outside they were culled) and with a lid */
function obox2(G, x, y, z, len, h, wid, dx, dz, col, lid) {
  const ax = dx * len / 2, az = dz * len / 2, bx = -dz * wid / 2, bz = dx * wid / 2, y1 = y + h;
  const c = [[x - ax - bx, z - az - bz], [x + ax - bx, z + az - bz], [x + ax + bx, z + az + bz], [x - ax + bx, z - az + bz]];
  for (let k = 0; k < 4; k++) { const p = c[k], q = c[(k + 1) % 4], mx = (p[0] + q[0]) / 2 - x, mz = (p[1] + q[1]) / 2 - z;
    G.quad([q[0], y, q[1]], [p[0], y, p[1]], [p[0], y1, p[1]], [q[0], y1, q[1]], col, mx, 0, mz); }
  if (lid !== false) G.quad([c[0][0], y1, c[0][1]], [c[3][0], y1, c[3][1]], [c[2][0], y1, c[2][1]], [c[1][0], y1, c[1][1]], col, 0, 1, 0); }
function obox(G, x, y, z, len, h, wid, dx, dz, col) { // box oriented along (dx, dz)
  const ax = dx * len / 2, az = dz * len / 2, bx = -dz * wid / 2, bz = dx * wid / 2, y1 = y + h;
  const c = [[x - ax - bx, z - az - bz], [x + ax - bx, z + az - bz], [x + ax + bx, z + az + bz], [x - ax + bx, z - az + bz]];
  for (let k = 0; k < 4; k++) { const p = c[k], q = c[(k + 1) % 4], mx = (p[0] + q[0]) / 2 - x, mz = (p[1] + q[1]) / 2 - z;
    G.quad([p[0], y, p[1]], [q[0], y, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], col, mx, 0, mz); }
  G.quad([c[0][0], y1, c[0][1]], [c[1][0], y1, c[1][1]], [c[2][0], y1, c[2][1]], [c[3][0], y1, c[3][1]], col, 0, 1, 0);
}
function jitter(c, s) { const j = 0.95 + s * 0.1; return [Math.min(1, c[0] * j), Math.min(1, c[1] * j), Math.min(1, c[2] * j)]; }
// with G.spr set (map tiles), trees and bushes become pixel sprites (4 vertices each, see sprites.js); otherwise low-poly geometry
// a house stands on the lowest terrain point of its footprint (the uphill side disappears in the slope, nothing floats)
function baseOf(p) { let m = Infinity; const st = Math.max(2, Math.floor(p.length / 24) * 2); for (let i = 0; i < p.length; i += st) m = Math.min(m, dzLift(p[i], p[i + 1], hAt(p[i], p[i + 1]))); return isFinite(m) ? m : 0; }
const sprY = (x, z, sd) => Math.floor(dzLift(x, z, hAt(x, z)) * 4) + sd * 0.999; // base height (in quarter metres) + seed, see sprites.js
function shrub(G, x, z, r, h, col) {
  if (WELT === 'cyber' || WELT === 'west') return;
  if (G.spr) { const sd = hashStr('s' + Math.round(x * 10) + ',' + Math.round(z * 10)); G.spr.push(x, z, 2.3 * r, Math.max(1, h * .95), sd < .15 ? 7 : sd < .5 ? 14 : 6, sprY(x, z, sd)); return; }
  G.crown(x, -h * 0.4, z, r, h * 1.3, col);
}
function tree(G, x, z, s, rnd, conifer) {
  if (WELT === 'cyber') return;
  if (WELT === 'west') { if (WOUT && rnd() < .3) { const r = rnd(); WOUT.push({ v: r < .2 ? 'w_kaktus_b' : r < .4 ? 'w_kaktus_a' : r < .55 ? 'w_kaktus_c' : r < .7 ? 'w_fels_a' : r < .8 ? 'w_fels_b' : 'w_strauch', x, y: weltBase(x, z), z, ry: rnd() * 6.283, sx: s, sy: s, sz: s, t: '' }); } return; }
  if (G.spr) {
    const r = rnd(), sd = rnd();
    // sprite sorts (see sprites.js): [type, width, height] per size unit, picked by weight
    const T = conifer ? [[4, 3.6, 7.8, 60], [5, 4.4, 7.6, 25], [15, 3.6, 7.2, 15]]
      : [[0, 5.0, 6.4, 18], [1, 4.0, 7.0, 13], [2, 5.4, 6.4, 13], [3, 3.6, 6.6, 8], [8, 5.2, 6.6, 10], [9, 5.0, 6.4, 7], [10, 6.0, 6.8, 9], [11, 2.8, 5.0, 6], [12, 5.2, 6.6, 10], [13, 2.8, 7.6, 6]];
    let tot = 0; for (const t of T) tot += t[3]; let q = r * tot, pick = T[0]; for (const t of T) { q -= t[3]; if (q < 0) { pick = t; break; } }
    G.spr.push(x, z, pick[1] * s, pick[2] * s, pick[0], sprY(x, z, sd));
    return;
  }
  if (conifer) { // spruce/pine: slim dark cone in two tiers
    const c = CONIFER[Math.floor(rnd() * CONIFER.length)];
    G.box(x, 0, z, .35 * s, 1.6 * s, .35 * s, TRUNK);
    G.crown(x, 1.0 * s, z, 1.55 * s, 4.6 * s, c); G.crown(x, 3.6 * s, z, 1.05 * s, 3.6 * s, c);
    return;
  }
  G.box(x, 0, z, .45 * s, 2.6 * s, .45 * s, TRUNK);
  const leaf = LEAF[Math.floor(rnd() * LEAF.length)];
  if (rnd() < .3) G.crown(x, 1.6 * s, z, 1.9 * s, 6 * s, leaf);
  else G.crown(x, 2.0 * s, z, 2.4 * s, 4.2 * s, leaf);
}
function tagStreet(G, t0, line, lineSeg) { // triangles from t0 on: nearest segment of this line; levelled segments tag them (G.lv: triangle -> corr index)
  if (!G.lv) G.lv = new Map(); const P = G.p;
  for (let t = t0; t < P.length / 9; t++) { const cx = (P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3, cz = (P[t * 9 + 2] + P[t * 9 + 5] + P[t * 9 + 8]) / 3; let bi = -1, bd = Infinity;
    for (let i = 0; i + 3 < line.length; i += 2) { const x0 = line[i], z0 = line[i + 1], ex = line[i + 2] - x0, ez = line[i + 3] - z0, q = Math.max(0, Math.min(1, ((cx - x0) * ex + (cz - z0) * ez) / (ex * ex + ez * ez || 1))), d = Math.hypot(cx - x0 - ex * q, cz - z0 - ez * q); if (d < bd) { bd = d; bi = i / 2; } }
    const ci = lineSeg[bi]; if (ci !== undefined && ci >= 0) G.lv.set(t, ci); }
}
function offsetLine(l, d) { // polyline moved sideways by d along the ribbon normal (-dz, dx), corners on the bisector
  const out = []; const n = l.length / 2;
  for (let i = 0; i < n; i++) { let nx = 0, nz = 0;
    for (const j of [i - 1, i]) { if (j < 0 || j + 1 >= n) continue; const dx = l[j * 2 + 2] - l[j * 2], dz = l[j * 2 + 3] - l[j * 2 + 1], L = Math.hypot(dx, dz) || 1; nx += -dz / L; nz += dx / L; }
    const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L; let k = 1; if (i > 0 && i + 1 < n) { const dx = l[i * 2] - l[i * 2 - 2], dz = l[i * 2 + 1] - l[i * 2 - 1], Lq = Math.hypot(dx, dz) || 1; k = 1 / Math.max(.5, Math.abs((-dz / Lq) * nx + (dx / Lq) * nz)); }
    out.push(l[i * 2] + nx * d * k, l[i * 2 + 1] + nz * d * k); }
  return out; }
function ribbon(G, l, w, y, col) { // l: polyline [x, z, …]
  const h = w / 2;
  for (let i = 0; i + 3 < l.length; i += 2) {
    const ax = l[i], az = l[i + 1], bx = l[i + 2], bz = l[i + 3], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); if (L < 0.01) continue;
    const nx = -dz / L * h, nz = dx / L * h;
    G.quad([ax + nx, y, az + nz], [bx + nx, y, bz + nz], [bx - nx, y, bz - nz], [ax - nx, y, az - nz], col, 0, 1, 0);
  }
  if (w >= 3) for (let i = 0; i < l.length; i += 2) { // joints
    const x = l[i], z = l[i + 1];
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2, b = (k + 1) / 6 * Math.PI * 2; G.tri(x, y, z, x + Math.cos(a) * h, y, z + Math.sin(a) * h, x + Math.cos(b) * h, y, z + Math.sin(b) * h, col, 0, 1, 0); }
  }
}
function dashes(G, l, y) {
  let acc = 0;
  for (let i = 0; i + 3 < l.length; i += 2) {
    const ax = l[i], az = l[i + 1], dx = l[i + 2] - ax, dz = l[i + 3] - az, L = Math.hypot(dx, dz); if (L < 0.01) continue;
    const ux = dx / L, uz = dz / L, nx = -uz * .08, nz = ux * .08;
    for (let t = (6 - acc % 6) % 6; t + 2.5 < L; t += 6) {
      const sx = ax + ux * t, sz = az + uz * t, ex = sx + ux * 2.5, ez = sz + uz * 2.5;
      G.quad([sx + nx, y, sz + nz], [ex + nx, y, ez + nz], [ex - nx, y, ez - nz], [sx - nx, y, sz - nz], MARK, 0, 1, 0);
    }
    acc += L;
  }
}
function sampleLineDir(l, step, cb) { // like sampleLine, but also hands over the unit direction
  let acc = step / 2;
  for (let i = 0; i + 3 < l.length; i += 2) {
    const ax = l[i], az = l[i + 1], dx = l[i + 2] - ax, dz = l[i + 3] - az, L = Math.hypot(dx, dz);
    while (acc < L) { cb(ax + dx * acc / L, az + dz * acc / L, dx / L, dz / L); acc += step; }
    acc -= L;
  }
}
function sampleLine(l, step, cb) {
  let acc = step / 2;
  for (let i = 0; i + 3 < l.length; i += 2) {
    const ax = l[i], az = l[i + 1], dx = l[i + 2] - ax, dz = l[i + 3] - az, L = Math.hypot(dx, dz);
    while (acc < L) { cb(ax + dx * acc / L, az + dz * acc / L); acc += step; }
    acc -= L;
  }
}

/* ------------------------------------------------------------ LoD2 tile -> geometry */
function parseB3dm(buf, tile) {
  const dv = new DataView(buf);
  const ftj = dv.getUint32(12, true), ftb = dv.getUint32(16, true), btj = dv.getUint32(20, true), btb = dv.getUint32(24, true);
  let o = 28 + ftj + ftb;
  let ids = null; try { ids = JSON.parse(td.decode(new Uint8Array(buf, o, btj))).gml_id; } catch (e) { }
  o += btj + btb;
  const g0 = o, jl = dv.getUint32(g0 + 12, true);
  const gj = JSON.parse(td.decode(new Uint8Array(buf, g0 + 20, jl)));
  const bin = g0 + 20 + jl + 8;
  const read = (i) => {
    const a = gj.accessors[i], bv = gj.bufferViews[a.bufferView], comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const cs = { 5126: 4, 5123: 2, 5125: 4, 5121: 1 }[a.componentType], stride = bv.byteStride || cs * comps, base = bin + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = a.componentType === 5126 ? new Float32Array(a.count * comps) : new Uint32Array(a.count * comps);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < comps; c++) {
      const off = base + k * stride + c * cs;
      out[k * comps + c] = a.componentType === 5126 ? dv.getFloat32(off, true) : a.componentType === 5123 ? dv.getUint16(off, true) : a.componentType === 5125 ? dv.getUint32(off, true) : dv.getUint8(off);
    }
    return out;
  };
  const prims = gj.meshes[0].primitives;
  const parts = prims.map(pr => {
    const mat = gj.materials && gj.materials[pr.material], bc = mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor;
    const roof = bc ? (bc[0] > bc[1] + 0.2) : false; // reddish material = roof surfaces
    return { pos: read(pr.attributes.POSITION), nor: read(pr.attributes.NORMAL), bid: read(pr.attributes._BATCHID), idx: read(pr.indices), roof };
  });
  let nv = 0, ni = 0; for (const p of parts) { nv += p.pos.length / 3; ni += p.idx.length; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), bid = new Uint16Array(nv), kind = new Uint8Array(nv), idx = new Uint32Array(ni);
  const col = tile.col, c = O.c;
  let v = 0, ii = 0;
  for (const p of parts) {
    const n = p.pos.length / 3;
    for (let k = 0; k < n; k++) {
      const X = col.ox + p.pos[k * 3], Y = col.oy - p.pos[k * 3 + 2], H = p.pos[k * 3 + 1] + col.oz;
      pos[(v + k) * 3] = (X - O.X0) * c; pos[(v + k) * 3 + 1] = H; pos[(v + k) * 3 + 2] = -(Y - O.Y0) * c;
      let nx = p.nor[k * 3] / c, ny = p.nor[k * 3 + 1], nz = p.nor[k * 3 + 2] / c; const l = Math.hypot(nx, ny, nz) || 1;
      nor[(v + k) * 3] = nx / l; nor[(v + k) * 3 + 1] = ny / l; nor[(v + k) * 3 + 2] = nz / l;
      bid[v + k] = p.bid[k];
      kind[v + k] = p.roof ? (ny / l > 0.97 ? 2 : 1) : 0; // 0 wall, 1 pitched roof, 2 flat roof
    }
    for (let k = 0; k < p.idx.length; k++) idx[ii + k] = p.idx[k] + v;
    v += n; ii += p.idx.length;
  }
  // per-batch centroid (footprint) and identity
  let mb = 0; for (let k = 0; k < nv; k++) if (bid[k] > mb) mb = bid[k];
  const nb = Math.max(mb + 1, (ids && ids.length) || 0);
  const sx = new Float64Array(nb), sz = new Float64Array(nb), cnt = new Uint32Array(nb);
  for (let k = 0; k < nv; k++) { const b = bid[k]; sx[b] += pos[k * 3]; sz[b] += pos[k * 3 + 2]; cnt[b]++; }
  const cent = new Float32Array(nb * 2), seed = new Float32Array(nb), top = new Float32Array(nb);
  for (let k = 0; k < nv; k++) { const y = pos[k * 3 + 1]; if (y > top[bid[k]]) top[bid[k]] = y; }
  for (let b = 0; b < nb; b++) { cent[b * 2] = cnt[b] ? sx[b] / cnt[b] : 0; cent[b * 2 + 1] = cnt[b] ? sz[b] / cnt[b] : 0; seed[b] = hashStr(ids && ids[b] ? ids[b] : String(b + tile.id)); }
  // several batches (wall surfaces, roof surfaces) belong to the same building: group them by gml_id
  const grp = new Uint32Array(nb), gIndex = new Map();
  for (let b = 0; b < nb; b++) { const id = ids && ids[b] ? ids[b] : 'b' + b; let g = gIndex.get(id); if (g === undefined) { g = gIndex.size; gIndex.set(id, g); } grp[b] = g; }
  return { pos, nor, idx, bid, kind, cent, seed, top, nb, grp, ng: gIndex.size, roofM: null, roofT: null };
}
/* per-building traits -> vertex colour + facade code (aFac: x = era + 8*party wall + 16*shop, y = roof type) */
function colourLod2(t) {
  const n = t.pos.length / 3, col = new Float32Array(n * 3), fac = new Float32Array(n * 2);
  const gT = new Uint8Array(t.nb), wallC = [], roofC = [], flatC = [], code = new Float32Array(t.nb), rT = new Uint8Array(t.nb), own = [], lvls = new Uint8Array(t.nb);
  // hydraulic structures (Edersee dam: a 48 m wall drawn in a house colour): a building whose ground outline stands for a good
  // part in or right at the water is a dam, weir, lock or quay structure -> grey stone/concrete, no windows
  const wetG = new Uint8Array(t.ng || 0);
  if (wetCells.size && t.ng) { const an = new Uint32Array(t.ng), wn = new Uint32Array(t.ng), P = t.pos;
    for (let k = 0; k < P.length / 3; k += 2) { if (P[k * 3 + 1] > 1.5) continue; const g = t.grp[t.bid[k]], x = P[k * 3], z = P[k * 3 + 2]; an[g]++;
      let w = false; for (const [u, v] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) if (wetCells.has(wk(x + u, z + v))) { w = true; break; } if (w) wn[g]++; }
    for (let g = 0; g < t.ng; g++) if (an[g] >= 6 && wn[g] / an[g] > .6) wetG[g] = 1;
    // dams: long thin structures (> 60 m, length >= 4x width) with water within 12 m on part of the outline
    const sx = new Float64Array(t.ng), sz = new Float64Array(t.ng), sxx = new Float64Array(t.ng), szz = new Float64Array(t.ng), sxz = new Float64Array(t.ng), cn = new Uint32Array(t.ng), nw = new Uint32Array(t.ng);
    for (let k = 0; k < P.length / 3; k += 2) { if (P[k * 3 + 1] > 1.5) continue; const g = t.grp[t.bid[k]], x = P[k * 3], z = P[k * 3 + 2];
      cn[g]++; sx[g] += x; sz[g] += z; sxx[g] += x * x; szz[g] += z * z; sxz[g] += x * z;
      for (const [u, v] of [[12, 0], [-12, 0], [0, 12], [0, -12], [8, 8], [-8, -8], [8, -8], [-8, 8]]) if (wetCells.has(wk(x + u, z + v))) { nw[g]++; break; } }
    for (let g = 0; g < t.ng; g++) { if (wetG[g] || cn[g] < 8) continue; const n = cn[g], mx = sx[g] / n, mz = sz[g] / n, a = sxx[g] / n - mx * mx, c = szz[g] / n - mz * mz, b = sxz[g] / n - mx * mz;
      const tr = (a + c) / 2, dd = Math.sqrt(Math.max(0, tr * tr - (a * c - b * b))), l1 = tr + dd, l2 = Math.max(1e-3, tr - dd); // spread along the main axes
      const len = Math.sqrt(12 * l1), wid = Math.sqrt(12 * l2);
      if (len > 60 && len > 4 * wid && nw[g] / n > .3) wetG[g] = 1; } }
  const hasFp = new Uint8Array(t.ng || 0); if (t.ng) for (let b = 0; b < t.nb; b++) if (fpAt(t.cent[b * 2], t.cent[b * 2 + 1])) hasFp[t.grp[b]] = 1; // any part inside an OSM building outline
  for (let b = 0; b < t.nb; b++) {
    const s = t.seed[b], cx = t.cent[b * 2], cz = t.cent[b * 2 + 1], src = colourAt(cx, cz), fp = fpAt(cx, cz);
    own[b] = fp;
    const era = fp && fp.hall && t.top[b] < 22 ? 6 : eraFromYear(fp && fp.year) || eraAt(cx, cz, s) || eraGuess(t.top[b], fp ? (fp.maxx - fp.minx) * (fp.maxz - fp.minz) : 200);
    code[b] = era + (fp && fp.shop ? 16 : 0) + (hashStr('v' + s) < 0.5 ? 32 : 0) + ((fp && fp.btype) || 0) * 512; // building type -> facade style (church, tower, castle, hall, glass, civic)
    const fArea = fp ? Math.abs(ringArea(fp.p)) : 999;
    if ((fp && fp.util) || (t.top[b] < 4.5 && fArea < 60)) code[b] += 8; // shed, garage, tiny annex: no windows (drawn like a party wall)
    lvls[b] = (fp && fp.levels) || 0;
    const m = t.roofM && t.roofM[b * 3] >= 0 ? [t.roofM[b * 3], t.roofM[b * 3 + 1], t.roofM[b * 3 + 2]] : null;
    wallC[b] = src && src.wall ? src.wall : fp && fp.btype === 3 ? stoneWall(s, cx, cz) : fp && (fp.btype === 1 || fp.btype === 2) ? sacredWall(era, s, cx, cz) : wallFor(era, s, cx, cz);
    if (src && src.wall ? src.brick : wallC[b].brick) code[b] += 128;
    roofC[b] = m || (src && src.roof) || roofGuess(cx, cz, s, t.top[b]);
    flatC[b] = m || (src && src.roof) || FLATROOF;
    rT[b] = t.roofT ? t.roofT[b] : 255;
    if (wetG[t.grp[b]] && !hasFp[t.grp[b]] && t.top[b] > 3) { /* no OSM building on it: dams are man_made=dam, warehouses on a canal are buildings (Speicherstadt) */ wallC[b] = jitter(hex('#8f8d86'), s); code[b] = (code[b] & ~128) | 8; roofC[b] = flatC[b] = hex('#8a8880'); } // water structure: grey, no windows
    if (!m && !(src && src.roof)) { const g = flatGuess(era, fp && fp.util, s); if (g) { flatC[b] = g[0]; gT[b] = g[1]; } }
  }
  // party walls: a wall with another building right behind it gets no windows
  const party = new Uint8Array(n), P = t.pos, N = t.nor, I = t.idx;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i], b = I[i + 1], c = I[i + 2]; if (t.kind[a] !== 0) continue;
    const nx = N[a * 3], nz = N[a * 3 + 2], l = Math.hypot(nx, nz); if (l < 0.5) continue;
    const mx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3 + nx / l * 0.8, my = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3, mz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3 + nz / l * 0.8;
    const nb = fpAt(mx, mz, own[t.bid[a]]);
    if (nb && nb.h > Math.min(my, 3)) { party[a] = party[b] = party[c] = 1; }
  }
  // eave height per building (lowest point of the pitched roof), and the extent of every wall face along the wall,
  // so the shader can spread whole windows evenly over each wall and stop at the eave
  // eave = lowest point of the pitched roof of the whole building (all its batches)
  // (low roofs of the same building, e.g. entrance canopies or garages, must not pull the eave down: only roof points above half the height count)
  const gTop = new Float32Array(t.ng), gEave = new Float32Array(t.ng).fill(Infinity);
  for (let k = 0; k < n; k++) { const g = t.grp[t.bid[k]], y = P[k * 3 + 1]; if (y > gTop[g]) gTop[g] = y; }
  for (let k = 0; k < n; k++) { const g = t.grp[t.bid[k]], y = P[k * 3 + 1]; if (t.kind[k] === 1 && y >= gTop[g] * 0.5 && y < gEave[g]) gEave[g] = y; }
  const eaveOf = b => { const g = t.grp[b]; return isFinite(gEave[g]) ? gEave[g] : gTop[g]; };
  const faceOf = new Array(n), faces = new Map();
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i]; if (t.kind[a] !== 0) continue;
    const nx = N[a * 3], nz = N[a * 3 + 2], l = Math.hypot(nx, nz); if (l < 0.3) continue;
    const ux = nx / l, uz = nz / l, tgx = -uz, tgz = ux;
    const key = t.grp[t.bid[a]] + '|' + Math.round(Math.atan2(uz, ux) * 12) + '|' + Math.round((ux * P[a * 3] + uz * P[a * 3 + 2]) / 0.6);
    let f = faces.get(key); if (!f) faces.set(key, f = { lo: Infinity, hi: -Infinity, top: -Infinity, tgx, tgz, ux, uz, sx: 0, sz: 0, k: 0 });
    for (const v of [a, I[i + 1], I[i + 2]]) { const tt = P[v * 3] * f.tgx + P[v * 3 + 2] * f.tgz; if (tt < f.lo) f.lo = tt; if (tt > f.hi) f.hi = tt; if (P[v * 3 + 1] > f.top) f.top = P[v * 3 + 1]; f.sx += P[v * 3]; f.sz += P[v * 3 + 2]; f.k++; faceOf[v] = f; }
  }
  for (const f of faces.values()) f.street = facesStreet(f.sx / f.k, f.sz / f.k, f.ux, f.uz);
  const wal = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const b = t.bid[k], kd = t.kind[k], c = kd === 0 ? wallC[b] : kd === 2 ? flatC[b] : roofC[b];
    col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
    if (kd === 0) {
      const f = faceOf[k], e = eaveOf(b), gable = f && f.top > e + 1.0; // the wall reaches up into a gable -> side wall of a pitched roof
      // aFac.y packs: eave height (m) + 500 if the roof is pitched (knee wall under the roof) + storeys from OSM * 1000
      const pitched = isFinite(gEave[t.grp[b]]);
      fac[k * 2] = code[b] + (party[k] && !(code[b] % 16 >= 8) ? 8 : 0) + (gable ? 64 : 0) + (f && f.street ? 256 : 0);
      fac[k * 2 + 1] = Math.min(e, 499) + (pitched ? 500 : 0) + lvls[b] * 1000;
      if (f) { wal[k * 3] = f.lo; wal[k * 3 + 1] = f.hi - f.lo; wal[k * 3 + 2] = f.top; }
    }
    else fac[k * 2 + 1] = rT[b] !== 255 ? (kd === 1 && (rT[b] === 2 || rT[b] === 4) ? 0 : rT[b]) : (kd === 2 ? (gT[b] || 2) : 0);
  }
  return { col, fac, wal };
}

// air-conditioning units and vents on flat roofs (pixel-art references: roofs are never empty); only where the 3D data has a flat roof
function lod2Props(t, id, shown, tid) { // shown: the index actually drawn (after every hiding rule) - props only on visible roofs
  const G = new Geo(true), P = t.pos, I = shown, /* facade attributes (all 0): drawn with the house material, so they dissolve with their house (Runde 50) */ rnd = mulberry(hashStr('rp' + id) * 1e9 | 0), byG = new Map(), out = [];
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i], b = I[i + 1], c = I[i + 2]; if (t.kind[a] !== 2) continue;
    const y = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3; if (y < 3) continue;
    const ux = P[b * 3] - P[a * 3], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vz = P[c * 3 + 2] - P[a * 3 + 2], ar = Math.abs(ux * vz - uz * vx) / 2;
    if (ar < 2) continue;
    const g = t.grp[t.bid[a]]; let e = byG.get(g); if (!e) byG.set(g, e = { A: 0, tris: [] }); e.A += ar; e.tris.push(a, b, c, ar);
  }
  for (const e of byG.values()) {
    if (e.A < 60 || rnd() < 0.3) continue;
    const n = Math.min(5, Math.floor(e.A / 120) + 1);
    for (let k = 0; k < n; k++) {
      let r = rnd() * e.A, j = 0; for (; j < e.tris.length - 4; j += 4) { r -= e.tris[j + 3]; if (r < 0) break; }
      const a = e.tris[j], b = e.tris[j + 1], c = e.tris[j + 2]; let u = rnd() * .8 + .1, v = rnd() * .8 + .1; if (u + v > .95) { u *= .5; v *= .5; }
      const x = P[a * 3] + u * (P[b * 3] - P[a * 3]) + v * (P[c * 3] - P[a * 3]), z = P[a * 3 + 2] + u * (P[b * 3 + 2] - P[a * 3 + 2]) + v * (P[c * 3 + 2] - P[a * 3 + 2]);
      const y = P[a * 3 + 1] + u * (P[b * 3 + 1] - P[a * 3 + 1]) + v * (P[c * 3 + 1] - P[a * 3 + 1]);
      const rr = rnd(), ty = rr < .45 ? 22 : rr < .68 ? 23 : rr < .88 ? 40 : 41; // AC unit, vent, satellite dish, chimney
      const gb = t.gBase ? t.gBase[t.grp[t.bid[a]]] || 0 : 0, an = rnd() * Math.PI * 2;
      const n0 = G.p.length; roofThing(G, ty, x, y + gb, z, Math.cos(an), Math.sin(an), rnd());
      if (!G.gid) G.gid = []; for (let v = n0 / 3; v < G.p.length / 3; v++) G.gid.push((tid || 0) * 8192 + (t.grp[t.bid[a]] % 8192)); // vanishes with its building
    }
  }
  const geo = G.p.length ? G.out() : null; if (geo && G.gid) geo.gid = Float32Array.from(G.gid);
  return { spr: new Float32Array(out), geo };
}
/* Roof things as small solid bodies (Runde 45; phone test: the sprites were drawn from 30 deg above, seen from roof height on a slope
   the AC unit showed its top and looked tilted). Hard-edged things that are seen from any height are geometry, 6-40 triangles each. */
function roofThing(G, ty, x, y, z, dx, dz, s) { const n0 = G.p.length; roofThing0(G, ty, x, y, z, dx, dz, s);
  for (let i = n0; i < G.p.length; i += 3) { G.p[i] = x + (G.p[i] - x) * 1.4; G.p[i + 1] = y + (G.p[i + 1] - y) * 1.4; G.p[i + 2] = z + (G.p[i + 2] - z) * 1.4; }
  if (G.b) for (let i = n0 / 3; i < G.b.length; i++) G.b[i] = y; } // 1.4 x life size: must read in the iso view; base = the roof it stands on
function roofThing0(G, ty, x, y, z, dx, dz, s) {
  const GREY = hex('#c9cbc8'), DARK = hex('#3c3f42'), MID = hex('#8d9093'), BRICK = hex('#8a4a36'), CAP = hex('#4a4643');
  if (ty === 22) { // air-conditioning unit: box with the fan grille on its long side
    obox(G, x, y, z, 1.3, .85, .8, dx, dz, GREY);
    const fx = x - dz * .41, fz = z + dx * .41; obox(G, fx, y + .15, fz, .6, .55, .02, dx, dz, DARK);
  } else if (ty === 23) { // vent pipe with a cap
    obox(G, x, y, z, .45, .7, .45, dx, dz, MID); obox(G, x, y + .7, z, .7, .1, .7, dx, dz, DARK);
  } else if (ty === 41) { // chimney
    obox(G, x, y, z, .7, 1.4 + s * .6, .55, dx, dz, BRICK); obox(G, x, y + 1.4 + s * .6, z, .8, .12, .65, dx, dz, CAP);
  } else { // satellite dish on a short mast, facing south (+z) and 30 deg up
    obox(G, x, y, z, .07, .75, .07, 1, 0, MID);
    const cy = y + .85, cz = z + .05, R = .5, ny = Math.sin(Math.PI / 6), nz = Math.cos(Math.PI / 6), ux = 1, uy = 0, uz = 0, vx = 0, vy = nz, vz = -ny; // disc axes u (east), v (in the disc plane)
    const W = hex('#e4e4de'), N8 = 10; for (let k = 0; k < N8; k++) { const a0 = k / N8 * Math.PI * 2, a1 = (k + 1) / N8 * Math.PI * 2;
      const p = a => [x + (ux * Math.cos(a) + vx * Math.sin(a)) * R, cy + (uy * Math.cos(a) + vy * Math.sin(a)) * R, cz + (uz * Math.cos(a) + vz * Math.sin(a)) * R], A = p(a0), B = p(a1);
      G.tri(x, cy, cz, A[0], A[1], A[2], B[0], B[1], B[2], W, 0, ny, nz); G.tri(x, cy, cz, A[0], A[1], A[2], B[0], B[1], B[2], MID, 0, -ny, -nz); } // front white, back grey
    G.tri(x, cy, cz, x - .03, cy + ny * .4, cz + nz * .4, x + .03, cy + ny * .4, cz + nz * .4, DARK, 1, 0, 0); G.tri(x, cy, cz, x - .03, cy + ny * .4, cz + nz * .4, x + .03, cy + ny * .4, cz + nz * .4, DARK, -1, 0, 0); // arm
    obox(G, x, cy + ny * .4 - .05, cz + nz * .4, .1, .1, .12, 1, 0, DARK); // receiver
  }
}
function postRoofThings(key, g) { post({ type: 'roofthings', key: key + ':rt', pos: g ? g.pos : null, nor: g ? g.nor : null, col: g ? g.col : null, fac: g ? g.fac : null, wal: g ? g.wal : null, base: g ? g.base : null, gid: g && g.gid ? g.gid : null }, g ? [g.pos.buffer, g.nor.buffer, g.col.buffer, g.fac.buffer, g.wal.buffer, g.base.buffer].concat(g.gid ? [g.gid.buffer] : []) : []); }
function rasterFill(m, W, H, x0, z0, C, polys, bit) { // scanline fill, even-odd over each polygon's outer ring and holes
  const xs = [];
  for (const pl of polys) {
    let a = Infinity, b = -Infinity; for (const r of pl) for (let i = 1; i < r.length; i += 2) { if (r[i] < a) a = r[i]; if (r[i] > b) b = r[i]; }
    const ra = Math.max(0, Math.floor((a - z0) / C)), rb = Math.min(H - 1, Math.ceil((b - z0) / C));
    for (let row = ra; row <= rb; row++) {
      const z = z0 + (row + .5) * C; xs.length = 0;
      for (const r of pl) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const zi = r[i + 1], zj = r[j + 1]; if ((zi > z) !== (zj > z)) xs.push(r[i] + (z - zi) / (zj - zi) * (r[j] - r[i])); }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) { const ca = Math.max(0, Math.ceil((xs[k] - x0) / C - .5)), cb = Math.min(W - 1, Math.floor((xs[k + 1] - x0) / C - .5)); for (let c = ca; c <= cb; c++) m[row * W + c] |= bit; }
    }
  }
}
/* Water field of one map tile (2 m raster): distance of every water cell to the nearest shore and the kind of that shore.
   Sent once as a small texture; the water shader draws depth bands, waves, foam and quay shadows from it (one texture read).
   Tile-cut edges are no shore (outside counts as water). With terrain the water lies 1.2 m below the land: quay walls
   (stone) and banks (earth) are built here as one face per run of shore cells. */
/* Shore outline (phone test: the banks were 2 m stairs - many zigzags and triangles): marching squares over the land/water raster
   (diagonals instead of steps), loops closed along the tile edge (outside counts as water), then simplified (Douglas-Peucker, 1 m).
   Returns loops [x, z, ...] with land: true when the loop encloses land (else it encloses a lake inside land). */
function shoreLoops(land, W, H, x0, z0, C) {
  const L = (i, j) => i >= 0 && j >= 0 && i < W && j < H && land(i, j);
  const P = new Map(), key = (u, v) => Math.round(u * 2) * 100003 + Math.round(v * 2), seg = [];
  const add = (u1, v1, u2, v2) => { const a = key(u1, v1), b = key(u2, v2); for (const [k, u, v] of [[a, u1, v1], [b, u2, v2]]) if (!P.has(k)) P.set(k, { u, v, n: [] }); P.get(a).n.push(b); P.get(b).n.push(a); };
  for (let j = -1; j < H; j++) for (let i = -1; i < W; i++) {
    const c = (L(i, j) ? 1 : 0) | (L(i + 1, j) ? 2 : 0) | (L(i + 1, j + 1) ? 4 : 0) | (L(i, j + 1) ? 8 : 0); if (c === 0 || c === 15) continue;
    const T = [i + .5, j], R = [i + 1, j + .5], B = [i + .5, j + 1], Lf = [i, j + .5];
    const S = { 1: [[Lf, T]], 2: [[T, R]], 3: [[Lf, R]], 4: [[R, B]], 5: [[Lf, T], [R, B]], 6: [[T, B]], 7: [[Lf, B]], 8: [[Lf, B]], 9: [[T, B]], 10: [[T, R], [Lf, B]], 11: [[R, B]], 12: [[Lf, R]], 13: [[T, R]], 14: [[Lf, T]] }[c];
    for (const [a, b] of S) add(a[0], a[1], b[0], b[1]); }
  const loops = [], used = new Set();
  for (const [k0, p0] of P) { if (used.has(k0)) continue; const ring = []; let prev = null, k = k0;
    for (let g = 0; g < 1e6; g++) { used.add(k); const p = P.get(k); ring.push(x0 + (p.u + .5) * C, z0 + (p.v + .5) * C); const nx = p.n[0] !== prev ? p.n[0] : p.n[1]; prev = k; k = nx; if (k === undefined || k === k0) break; }
    if (ring.length >= 8) loops.push(ring); }
  const dp = (pts, tol) => { // Douglas-Peucker on an open chain [x, z, ...]
    const n = pts.length / 2, keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const st = [[0, n - 1]];
    while (st.length) { const [a, b] = st.pop(); const ax = pts[a * 2], az = pts[a * 2 + 1], ex = pts[b * 2] - ax, ez = pts[b * 2 + 1] - az, l = Math.hypot(ex, ez) || 1; let md = 0, mi = -1;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i * 2] - ax) * ez - (pts[i * 2 + 1] - az) * ex) / l; if (d > md) { md = d; mi = i; } }
      if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
    const o = []; for (let i = 0; i < n; i++) if (keep[i]) o.push(pts[i * 2], pts[i * 2 + 1]); return o; };
  const out = [];
  for (const r of loops) { const n = r.length / 2; let far = 0, fd = 0; for (let i = 1; i < n; i++) { const d = (r[i * 2] - r[0]) ** 2 + (r[i * 2 + 1] - r[1]) ** 2; if (d > fd) { fd = d; far = i; } }
    const A = dp(r.slice(0, far * 2 + 2), C * .5), B = dp(r.slice(far * 2).concat(r.slice(0, 2)), C * .5);
    const s2 = A.concat(B.slice(2, B.length - 2)); if (s2.length < 6) continue;
    // which side is land? interior lies left of a counter-clockwise loop (x/z maths)
    let ar = 0; for (let i = 0, j = s2.length - 2; i < s2.length; j = i, i += 2) ar += s2[j] * s2[i + 1] - s2[i] * s2[j + 1];
    // which side is land: test both sides of the outline segment by segment until one side is land and the other water
    let ar0 = 0; for (let a = 0, b = r.length - 2; a < r.length; b = a, a += 2) ar0 += r[b] * r[a + 1] - r[a] * r[b + 1];
    let li = -1; for (let i = 0; i + 3 < r.length && li < 0; i += 2) { const mx = (r[i] + r[i + 2]) / 2, mz = (r[i + 1] + r[i + 3]) / 2, ex = r[i + 2] - r[i], ez = r[i + 3] - r[i + 1], l = Math.hypot(ex, ez) || 1;
      const side = q => L(Math.floor((mx - ez / l * q - x0) / C), Math.floor((mz + ex / l * q - z0) / C));
      const lft = side(C * .7), rgt = side(-C * .7); if (lft !== rgt) li = (lft ? 1 : 0) ^ (ar0 < 0 ? 1 : 0); }
    if (li < 0) continue;
    out.push({ ring: Float32Array.from(s2), land: li === 1 }); }
  return out;
}
function waterField(polys, lines, toL, cls, G) {
  const c0 = toL(0, 0), c1 = toL(4096, 4096), x0 = Math.min(c0[0], c1[0]), z0 = Math.min(c0[1], c1[1]), C = 2;
  const W = Math.ceil((Math.max(c0[0], c1[0]) - x0) / C), H = Math.ceil((Math.max(c0[1], c1[1]) - z0) / C), N = W * H;
  const m = new Uint8Array(N); // bit 1 water, 2 green/natural land, 4 settlement area, 8 house
  rasterFill(m, W, H, x0, z0, C, polys, 1);
  for (let k = 0; k < lines.length; k += 2) { const l = lines[k], r = lines[k + 1] / 2, rc0 = Math.ceil(r / C); // rivers and streams drawn as lines
    for (let i = 0; i + 3 < l.length; i += 2) { const L = Math.hypot(l[i + 2] - l[i], l[i + 3] - l[i + 1]), n = Math.ceil(L) + 1;
      for (let s = 0; s <= n; s++) { const x = l[i] + (l[i + 2] - l[i]) * s / n, z = l[i + 1] + (l[i + 3] - l[i + 1]) * s / n, cx = Math.floor((x - x0) / C), cz = Math.floor((z - z0) / C);
        for (let u = -rc0; u <= rc0; u++) for (let v = -rc0; v <= rc0; v++) { const X = cx + u, Z = cz + v; if (X < 0 || Z < 0 || X >= W || Z >= H) continue; if ((u * C) ** 2 + (v * C) ** 2 <= r * r + 1) m[Z * W + X] |= 1; } } } }
  rasterFill(m, W, H, x0, z0, C, cls.green, 2); rasterFill(m, W, H, x0, z0, C, cls.urban, 4); rasterFill(m, W, H, x0, z0, C, cls.blds, 8);
  const wat = i => m[i] & 1;
  // shore type (Google 3D Landungsbruecken: in towns the shore is a quay wall, not a beach): natural on green land without houses
  // or settlement within 40 m; hard in settlement areas, near houses, on paved ground or next to a road
  const anyBit = (x, z, r, bit) => { for (let v = -r; v <= r; v++) for (let u = -r; u <= r; u++) { const X = x + u, Z = z + v; if (X >= 0 && Z >= 0 && X < W && Z < H && (m[Z * W + X] & bit)) return true; } return false; };
  const greenShare = (x, z, r) => { let g = 0, n = 0; for (let v = -r; v <= r; v += 2) for (let u = -r; u <= r; u += 2) { const X = x + u, Z = z + v; if (X < 0 || Z < 0 || X >= W || Z >= H) continue; const k = m[Z * W + X]; if (k & 1) continue; n++; if (k & 2) g++; } return n ? g / n : 0; };
  // natural: a real green strip along the water (>= 60 % green land within 12 m) and no house within 20 m (Dresden Elbwiesen);
  // otherwise walled when houses or settlement lie within 40 m or the ground is paved (Berlin Kupfergraben, Hamburg)
  const hardAt = (x, z) => { if ((m[z * W + x] & 2) && greenShare(x, z, 6) >= .6 && !anyBit(x, z, 10, 8)) return false;
    return !!((m[z * W + x] & 12) || cls.paved(x0 + (x + .5) * C, z0 + (z + .5) * C) || anyBit(x, z, 20, 12)); };
  const d = new Float32Array(N).fill(1e9), lab = new Uint8Array(N);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) { const i = z * W + x; if (wat(i)) continue; d[i] = 0;
    if ((x > 0 && wat(i - 1)) || (x < W - 1 && wat(i + 1)) || (z > 0 && wat(i - W)) || (z < H - 1 && wat(i + W))) lab[i] = hardAt(x, z) ? 2 : 1; }
  const WLv = WL();
  const loops = shoreLoops((i, j) => !wat(j * W + i), W, H, x0, z0, C);
  if (G) { let nw = 0; const BANK = hex('#76704e'), X1 = x0 + W * C, Z1 = z0 + H * C, edge = (x, z) => x < x0 + .01 || z < z0 + .01 || x > X1 - .01 || z > Z1 - .01;
    const cellW = (x, z) => { const gi = Math.floor((x - x0) / C), gj = Math.floor((z - z0) / C); return gi >= 0 && gj >= 0 && gi < W && gj < H && wat(gj * W + gi); };
    // bank / quay faces along the simplified outline: long straight pieces instead of 2 m steps
    for (const { ring: r } of loops) for (let a = 0, n = r.length / 2; a < n; a++) { if (nw++ > 12000) break;
      const b = (a + 1) % n, ax = r[a * 2], az = r[a * 2 + 1], bx = r[b * 2], bz = r[b * 2 + 1]; if (edge(ax, az) && edge(bx, bz)) continue; // tile border, not a shore
      const ex = bx - ax, ez = bz - az, l = Math.hypot(ex, ez); if (l < .05) continue; let nx = -ez / l, nz = ex / l; const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (!cellW(mx + nx * C * .8, mz + nz * C * .8)) { nx = -nx; nz = -nz; } // normal towards the water
      let hard = false; for (let q = .3; q <= 1.6 && !hard; q += .65) { const gi = Math.floor((mx - nx * C * q - x0) / C), gj = Math.floor((mz - nz * C * q - z0) / C); if (gi >= 0 && gj >= 0 && gi < W && gj < H && lab[gj * W + gi] === 2) hard = true; }
      if (WLv > 0) G.quad([ax, -WLv - .3, az], [bx, -WLv - .3, bz], [bx, .03, bz], [ax, .03, az], hard ? QUAY : BANK, nx, 0, nz);
      else if (hard) obox(G, mx - nx * .3, 0, mz - nz * .3, l, .45, .6, ex / l, ez / l, QUAY); } // flat world: low quay kerb
  }
  // chamfer distance transform, carrying the kind of the nearest shore along
  const D2 = 1.4142;
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) { const i = z * W + x; if (!wat(i)) continue;
    const t = (j, c) => { if (d[j] + c < d[i]) { d[i] = d[j] + c; lab[i] = lab[j]; } };
    if (x > 0) t(i - 1, 1); if (z > 0) { t(i - W, 1); if (x > 0) t(i - W - 1, D2); if (x < W - 1) t(i - W + 1, D2); } }
  for (let z = H - 1; z >= 0; z--) for (let x = W - 1; x >= 0; x--) { const i = z * W + x; if (!wat(i)) continue;
    const t = (j, c) => { if (d[j] + c < d[i]) { d[i] = d[j] + c; lab[i] = lab[j]; } };
    if (x < W - 1) t(i + 1, 1); if (z < H - 1) { t(i + W, 1); if (x < W - 1) t(i + W + 1, D2); if (x > 0) t(i + W - 1, D2); } }
  // piers and bridges: walkable, so they count as land in the field the game uses for walking (bit 16)
  if (cls.dryPolys) rasterFill(m, W, H, x0, z0, C, cls.dryPolys, 16);
  if (cls.dryLines) for (let k = 0; k < cls.dryLines.length; k += 2) { const l = cls.dryLines[k], r = cls.dryLines[k + 1] / 2, rc0 = Math.ceil(r / C);
    for (let i = 0; i + 3 < l.length; i += 2) { const L = Math.hypot(l[i + 2] - l[i], l[i + 3] - l[i + 1]), n = Math.ceil(L) + 1;
      for (let s2 = 0; s2 <= n; s2++) { const x = l[i] + (l[i + 2] - l[i]) * s2 / n, z = l[i + 1] + (l[i + 3] - l[i + 1]) * s2 / n, cx = Math.floor((x - x0) / C), cz = Math.floor((z - z0) / C);
        for (let u = -rc0; u <= rc0; u++) for (let v = -rc0; v <= rc0; v++) { const X = cx + u, Z = cz + v; if (X < 0 || Z < 0 || X >= W || Z >= H) continue; if ((u * C) ** 2 + (v * C) ** 2 <= r * r + 1) m[Z * W + X] |= 16; } } } }
  // bridges: water flows on underneath (texture unchanged - phone test: a foamy 'shore' flickered along a bridge over the Trave),
  // walking uses a separate mask
  const dry = new Uint8Array(N); let nDry = 0;
  if (cls.bridgeDry) for (let k = 0; k < cls.bridgeDry.length; k += 2) { const l = cls.bridgeDry[k], r = cls.bridgeDry[k + 1] / 2, rc0 = Math.ceil(r / C);
    for (let i = 0; i + 3 < l.length; i += 2) { const L = Math.hypot(l[i + 2] - l[i], l[i + 3] - l[i + 1]), n = Math.ceil(L) + 1;
      for (let s2 = 0; s2 <= n; s2++) { const x = l[i] + (l[i + 2] - l[i]) * s2 / n, z = l[i + 1] + (l[i + 3] - l[i + 1]) * s2 / n, cx = Math.floor((x - x0) / C), cz = Math.floor((z - z0) / C);
        for (let u = -rc0; u <= rc0; u++) for (let v = -rc0; v <= rc0; v++) { const X = cx + u, Z = cz + v; if (X < 0 || Z < 0 || X >= W || Z >= H) continue; if ((u * C) ** 2 + (v * C) ** 2 <= r * r + 1) { dry[Z * W + X] = 1; nDry++; } } } } }
  /* Runde 181: flow - the direction of the nearest river or stream line (OSM draws waterways downstream), spread over the water by a
     breadth-first walk (up to 150 m); lakes and harbours without a waterway line stay still (128, 128 = no flow) */
  /* Runde 191 (phone test: a pond fed by a stream 'rushed' all the time - the flow had spread 150 m over the whole pond): the flow
     reaches only the stream itself and a few metres beside it (half its width + 8 m, at most 150 m), so a pond or lake it runs into stays still */
  const flow = new Uint8Array(N * 2).fill(128), fdep = new Uint8Array(N), flim = new Uint8Array(N), fq = [];
  for (let k = 0; k < lines.length; k += 2) { const l = lines[k], lim = Math.min(75, Math.max(2, Math.ceil(((lines[k + 1] || 0) / 2 + 8) / C)));
    for (let i = 0; i + 3 < l.length; i += 2) { const ex = l[i + 2] - l[i], ez = l[i + 3] - l[i + 1], L = Math.hypot(ex, ez); if (L < .1) continue; const ux = ex / L, uz = ez / L, n = Math.ceil(L / C) + 1;
      for (let s = 0; s <= n; s++) { const cx = Math.floor((l[i] + ex * s / n - x0) / C), cz = Math.floor((l[i + 1] + ez * s / n - z0) / C); if (cx < 0 || cz < 0 || cx >= W || cz >= H) continue;
        const j = cz * W + cx; if (!wat(j) || fdep[j]) continue; fdep[j] = 1; flim[j] = lim; flow[j * 2] = Math.round(128 + ux * 127); flow[j * 2 + 1] = Math.round(128 + uz * 127); fq.push(j); } } }
  for (let h = 0; h < fq.length; h++) { const i = fq[h]; if (fdep[i] >= flim[i]) continue; const x = i % W, z = (i - x) / W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, z > 0 ? i - W : -1, z < H - 1 ? i + W : -1]) if (j >= 0 && !fdep[j] && wat(j)) { fdep[j] = fdep[i] + 1; flim[j] = flim[i]; flow[j * 2] = flow[i * 2]; flow[j * 2 + 1] = flow[i * 2 + 1]; fq.push(j); } }
  const data = new Uint8Array(N * 2);
  for (let i = 0; i < N; i++) { data[i * 2] = wat(i) && !(m[i] & 16) ? Math.max(1, Math.min(255, Math.round(d[i] * C * 4))) : 0; data[i * 2 + 1] = lab[i] === 2 ? 255 : 0; } // distance in 0.25 m (up to 63 m); 0 = land, pier or bridge
  return { data, flow, dry: nDry ? dry : null, w: W, h: H, x0, z0, c: C, m, loops };
}
// base ground of a tile with terrain: meadow quads per row run of land cells, so the lowered water is not covered
function meadow(G, toL, f) {
  const c0 = toL(0, 0), c1 = toL(4096, 4096), x0 = Math.min(c0[0], c1[0]), x1 = Math.max(c0[0], c1[0]), z0 = Math.min(c0[1], c1[1]), z1 = Math.max(c0[1], c1[1]), MW = hex(WELT === 'west' ? '#dcb27a' : WELT === 'cyber' ? '#101018' : '#8fa067');
  if (!f) { const n = 8; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const ax = x0 + (x1 - x0) * i / n, bx = x0 + (x1 - x0) * (i + 1) / n, az = z0 + (z1 - z0) * j / n, bz = z0 + (z1 - z0) * (j + 1) / n;
      G.quad([ax, -0.08, az], [bx, -0.08, az], [bx, -0.08, bz], [ax, -0.08, bz], MW, 0, 1, 0); } return; }
  // land as polygons from the simplified shore outline (outer loops with their lakes as holes) - smooth banks, far fewer triangles
  const outer = f.loops.filter(o => o.land), holes = f.loops.filter(o => !o.land), groups = outer.map(o => [o.ring]);
  const area = r => { let a = 0; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1]; return Math.abs(a / 2); };
  for (const hl of holes) { let best = -1, ba = Infinity; for (let k = 0; k < outer.length; k++) if (inPoly(hl.ring[0], hl.ring[1], outer[k].ring)) { const a = area(outer[k].ring); if (a < ba) { ba = a; best = k; } } if (best >= 0) groups[best].push(hl.ring); }
  for (const g of groups) G.flat(g, -0.08, MW);
  // bed under everything, below the water level: closes every gap between the smoothed shore and the water outline (sky showed through)
  if (WL() > 0) { const BED = hex('#4a4a38'), n = 16; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const ax = x0 + (x1 - x0) * i / n, bx = x0 + (x1 - x0) * (i + 1) / n, az = z0 + (z1 - z0) * j / n, bz = z0 + (z1 - z0) * (j + 1) / n;
    { /* only where the water field has water within 8 m (the bed was a whole extra layer under every tile) */ let wet = false; const gx0 = Math.max(0, Math.floor((ax - 8 - f.x0) / f.c)), gx1 = Math.min(f.w - 1, Math.floor((bx + 8 - f.x0) / f.c)), gz0 = Math.max(0, Math.floor((az - 8 - f.z0) / f.c)), gz1 = Math.min(f.h - 1, Math.floor((bz + 8 - f.z0) / f.c));
      for (let gz = gz0; gz <= gz1 && !wet; gz++) for (let gx = gx0; gx <= gx1; gx++) if (f.data[(gz * f.w + gx) * 2] > 0) { wet = true; break; } if (!wet) continue; }
    G.quad([ax, -WL() - .35, az], [bx, -WL() - .35, az], [bx, -WL() - .35, bz], [ax, -WL() - .35, bz], BED, 0, 1, 0); } }
}
/* LoD2 plausibility (Sparrenburg Bielefeld: the whole fortress was one block with a flat top at tower height, 55 m above the slope).
   A cadastre outline that covers a castle, a walled courtyard or a building complex sometimes comes out as one block at the height of
   its highest point. Sign: a large flat top over ground that OSM shows as open (courtyard) or as much lower buildings.
   There the OSM buildings are drawn instead. General rule, no list of places. */
function inTri(x, z, t, k) {
  const ax = t[k], az = t[k + 1], bx = t[k + 2], bz = t[k + 3], cx = t[k + 4], cz = t[k + 5];
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz), d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz), d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
}
function blockGroups(d, prev) {
  const set = new Set(), tris = new Map(); set.bids = new Set(); if (!fpgrid.size) return { set, tris };
  const P = d.pos, I = d.idx, top = new Float32Array(d.ng).fill(-1e9), all = new Map();
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i], b = I[i + 1], c = I[i + 2]; if (d.kind[a] !== 2) continue; // roof surfaces only
    const g = d.grp[d.bid[a]], ym = Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]);
    let t = all.get(g); if (!t) all.set(g, t = []);
    t.push(P[a * 3], P[a * 3 + 2], P[b * 3], P[b * 3 + 2], P[c * 3], P[c * 3 + 2], (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3);
    if (ym > top[g]) top[g] = ym;
  }
  // bridge decks: LoD2 sometimes holds a bridge as floating flat surfaces, even inside the same building as the gate house
  // (Sparrenburg gate bridge: 1-3 m above ground, drawn as a white house over the path). Surfaces that never touch the ground,
  // are at most 4 m thick and lie over a bridge road or path of the map are no house.
  const bids = new Set();
  if (bridgeGrid.size) {
    const nb = d.nb, lo = new Float32Array(nb).fill(1e9), hi = new Float32Array(nb).fill(-1e9);
    for (let k = 0; k < P.length / 3; k++) { const b = d.bid[k], y = P[k * 3 + 1]; if (y < lo[b]) lo[b] = y; if (y > hi[b]) hi[b] = y; }
    const near = (x, z, r) => { const ci = Math.floor(x / 8), cj = Math.floor(z / 8);
      for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) { const a = bridgeGrid.get(bk(ci + u, cj + v)); if (a) for (let i = 0; i < a.length; i += 2) if ((a[i] - x) ** 2 + (a[i + 1] - z) ** 2 < r * r) return true; }
      return false; };
    const hitB = new Set(), cand = new Map();
    for (let i = 0; i < I.length; i += 3) { const a = I[i], b = d.bid[a]; if (lo[b] < 0.6 || hi[b] - lo[b] > 4 || hi[b] > 12) continue;
      const cx = (P[a * 3] + P[I[i + 1] * 3] + P[I[i + 2] * 3]) / 3, cz = (P[a * 3 + 2] + P[I[i + 1] * 3 + 2] + P[I[i + 2] * 3 + 2]) / 3;
      cand.set(b, [cx, cz]); if (!hitB.has(b) && near(cx, cz, 3)) hitB.add(b); }
    // neighbouring floating surfaces of the same structure (sides, underside) go with it
    for (const [b, c] of cand) { if (hitB.has(b)) { bids.add(b); continue; } for (const h of hitB) { const q = cand.get(h); if (d.grp[h] === d.grp[b] && Math.hypot(q[0] - c[0], q[1] - c[1]) < 15) { bids.add(b); break; } } }
    // whole bridges (stand on piers, so not floating): most of their upper surface lies on a bridge road -> drawn from the map instead
    const upA = new Float32Array(d.ng), upN = new Float32Array(d.ng);
    for (let i = 0; i < I.length; i += 3) { const a = I[i], b = I[i + 1], c = I[i + 2], g = d.grp[d.bid[a]];
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz); if (l < 1e-6 || Math.abs(ny) / l < .8) continue;
      const ar = l / 2, cy = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3; if (cy < .5) continue; // floor faces are no top
      upA[g] += ar; if (near((P[a * 3] + P[b * 3] + P[c * 3]) / 3, (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3, 5)) upN[g] += ar; }
    for (let g = 0; g < d.ng; g++) if (upA[g] > 30 && upN[g] / upA[g] > .6) { if (!set.has(g) && !(prev && prev.has(g))) post({ type: 'info', msg: 'LoD2-Brücke durch Kartenbrücke ersetzt: ' + upA[g].toFixed(0) + ' m²' }); set.add(g); }
    if (bids.size && !(prev && prev.bids && prev.bids.size === bids.size)) post({ type: 'info', msg: 'LoD2-Brückenflächen ausgeblendet: ' + bids.size });
  }
  // castle and town walls: LoD2 models bastions of hill fortresses as solid cylinders up to the height of the whole complex
  // (Sparrenburg: Kiekstattrondell 47 m). Where OSM maps the wall, it is drawn from OSM (retaining wall up to the courtyard).
  { const wn = new Uint32Array(d.ng), an = new Uint32Array(d.ng);
    for (let k = 0; k < P.length / 3; k += 2) { if (P[k * 3 + 1] > 1.5) continue; const g = d.grp[d.bid[k]]; an[g]++; if (wallAt(P[k * 3], P[k * 3 + 2])) wn[g]++; }
    for (const [g, t] of all) if (an[g] >= 4 && wn[g] / an[g] > .6 && !set.has(g)) { set.add(g); tris.set(g, t); if (!prev || !prev.has(g)) post({ type: 'info', msg: 'LoD2-Burgmauer durch OSM ersetzt: Dach ' + top[g].toFixed(0) + ' m' }); } }
  // inside castle and fortress grounds LoD2 often gives bastions and the whole complex the height of its highest point
  // (Sparrenburg: a 45 m cylinder where a bastion stands). There, a structure much taller than OSM says - or where OSM has
  // no building at all - is drawn from OSM (or left out).
  if (castleAreas.size) {
    const cx = new Float64Array(d.ng), cz = new Float64Array(d.ng), cn = new Uint32Array(d.ng), cov = new Uint32Array(d.ng), oh = new Float32Array(d.ng);
    const tLo = new Float32Array(d.ng).fill(1e9), tHi = new Float32Array(d.ng).fill(-1e9);
    for (let k = 0; k < P.length / 3; k += 2) { if (P[k * 3 + 1] > 1.5) continue; const g = d.grp[d.bid[k]], x = P[k * 3], z = P[k * 3 + 2]; cx[g] += x; cz[g] += z; cn[g]++;
      if (TERRAIN_ON) { const h = hAt(x, z); if (h < tLo[g]) tLo[g] = h; if (h > tHi[g]) tHi[g] = h; }
      const fp = fpAt(x, z) || (wallAt(x, z) ? { h: 0 } : null); if (fp) { cov[g]++; if (fp.h > oh[g]) oh[g] = fp.h; } }
    for (const [g, t] of all) { if (set.has(g) || !cn[g] || top[g] < 20) continue;
      const x = cx[g] / cn[g], z = cz[g] / cn[g]; let inside = false;
      for (const a of castleAreas) if (x >= a.minx && x <= a.maxx && z >= a.minz && z <= a.maxz && inPoly(x, z, a.ring)) { inside = true; break; }
      if (!inside) continue;
      // height above the HIGHEST ground under it (a castle on a slope is legitimately tall on the valley side), flat top only
      const above = top[g] - (TERRAIN_ON && tHi[g] > -1e8 ? tHi[g] - tLo[g] : 0);
      let flatA = 0, allA = 0; for (let k = 0; k < t.length; k += 7) { const ar = Math.abs((t[k + 2] - t[k]) * (t[k + 5] - t[k + 1]) - (t[k + 4] - t[k]) * (t[k + 3] - t[k + 1])) / 2; allA += ar; if (t[k + 6] > top[g] - 1.5) flatA += ar; }
      if (cov[g] / cn[g] >= .5 && above > 2 * Math.max(oh[g], 6) && flatA > .7 * allA) { set.add(g); tris.set(g, t); if (!prev || !prev.has(g)) post({ type: 'info', msg: 'LoD2 im Burggelände ersetzt: ' + above.toFixed(0) + ' m über Kuppe (OSM ' + oh[g].toFixed(0) + ' m, Abdeckung ' + Math.round(cov[g] / cn[g] * 100) + ' %)' }); }
    }
  }
  for (const [g, t] of all) {
    if (top[g] < 12 || set.has(g)) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < t.length; k += 7) for (let m = 0; m < 6; m += 2) { x0 = Math.min(x0, t[k + m]); x1 = Math.max(x1, t[k + m]); z0 = Math.min(z0, t[k + m + 1]); z1 = Math.max(z1, t[k + m + 1]); }
    if ((x1 - x0) * (z1 - z0) < 2500) continue;
    let plat = 0, cov = 0; const hs = [];
    for (let x = x0 + 1.5; x < x1; x += 3) for (let z = z0 + 1.5; z < z1; z += 3) {
      let h = -1e9; for (let k = 0; k < t.length; k += 7) if (t[k + 6] > h && inTri(x, z, t, k)) h = t[k + 6];
      if (h < top[g] - 2) continue; plat++;
      const fp = fpAt(x, z); if (fp) { cov++; hs.push(fp.h); }
    }
    if (plat * 9 < 2500) continue;
    hs.sort((a, b) => a - b); const med = hs.length ? hs[hs.length >> 1] : 0, share = cov / plat;
    // top mostly over open ground in OSM, but OSM does know buildings there, and they are much lower
    if (share >= 0.08 && share <= 0.5 && top[g] >= 1.5 * med) { set.add(g); tris.set(g, t); if (!prev || !prev.has(g)) post({ type: 'info', msg: 'LoD2-Block ersetzt: Dach ' + top[g].toFixed(0) + ' m, ' + (plat * 9) + ' m², OSM-Anteil ' + (share * 100).toFixed(0) + ' %, OSM-Höhe ' + med.toFixed(0) + ' m' }); }
  }
  set.bids = bids; return { set, tris };
}
function wallAt(x, z) { // an OSM castle/town wall here (inside or on its outline - LoD2 walls stand exactly on the outline)
  const a = fpgrid.get(gkey(Math.floor(x / CELL), Math.floor(z / CELL))); if (!a) return false;
  for (const it of a) if (it.util && it.btype === 3 && x > it.minx - 2 && x < it.maxx + 2 && z > it.minz - 2 && z < it.maxz + 2 && (inPoly(x, z, it.p) || nearRing(x, z, it.p, 1.5))) return true;
  return false;
}
function blockIdx(rec) {
  const d = rec.data, I = rec.idx0, bids = rec.block.bids; if (!rec.block.size && !(bids && bids.size)) return I.slice();
  const keep = []; for (let i = 0; i < I.length; i += 3) { const b = d.bid[I[i]]; if (!rec.block.has(d.grp[b]) && !(bids && bids.has(b))) keep.push(I[i], I[i + 1], I[i + 2]); }
  return Uint32Array.from(keep);
}
// OSM fallback buildings inside replaced blocks (their buckets were held back because LoD2 covers the tile)
function rescueFor(rec) {
  const key = 'l:' + rec.tile.id + ':r';
  if (!rec.block || !rec.block.size) { if (rec.rescued) { post({ type: 'drop', prefix: key }); rec.rescued = false; } return; }
  const R = new Geo(true);
  for (const m of mvt.values()) if (m.items) for (const it of m.items) {
    if (!it.G || it.G.sent || it.cx === undefined) continue;
    let inside = false; for (const t of rec.blockTris.values()) { for (let k = 0; k < t.length && !inside; k += 7) inside = inTri(it.cx, it.cz, t, k); if (inside) break; }
    if (!inside) continue;
    const G = it.G, v0 = it.r0 / 3, v1 = it.r1 / 3;
    for (let i = it.r0; i < it.r1; i++) { R.p.push(G.p[i]); R.n.push(G.n[i]); R.c.push(G.c[i]); R.w.push(G.w[i]); }
    for (let v = v0; v < v1; v++) { R.f.push(G.f[v * 2], G.f[v * 2 + 1]); R.b.push(G.b[v]); }
  }
  if (!R.p.length) return;
  const g = R.out(); rec.rescued = true;
  post({ type: 'bld', key, pos: g.pos, nor: g.nor, col: g.col, fac: g.fac, wal: g.wal, base: g.base }, [g.pos.buffer, g.nor.buffer, g.col.buffer, g.fac.buffer, g.wal.buffer, g.base.buffer]);
}
// MVT footprints arrive after the LoD2 tile: check again and update the index of the shown mesh
function recheckBlock(rec) {
  const b = blockGroups(rec.data, rec.block), same = b.set.size === rec.block.size && [...b.set].every(g => rec.block.has(g)) && b.set.bids.size === (rec.block.bids ? rec.block.bids.size : 0);
  if (!same) {
    rec.block = b.set; rec.blockTris = b.tris; const idx = blockIdx(rec), rp = lod2Props(rec.data, rec.tile.id, idx), spr = rp.spr;
    post({ type: 'lod2idx', key: 'l:' + rec.tile.id, idx, spr }, [idx.buffer, spr.buffer]); postRoofThings('l:' + rec.tile.id, rp.geo);
  }
  rescueFor(rec);
}
/* ------------------------------------------------------------ roofs measured from aerial photos (features only, never shown) */
function roofTypeOf(r, g, b, flat) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0;
  if (b > r + 0.08 && b > g + 0.03 && mx < 0.42 && s > 0.22) return 3;  // solar panels (dark, clearly blue; dark slate is not)
  if (flat && g > r + 0.03 && g > b + 0.03) return 4;                    // green roof
  if (s < 0.12) return flat ? 2 : (mx < 0.38 ? 1 : 0);                  // gravel / slate / grey tiles
  return flat ? 2 : 0;                                                   // tiles
}
// typical roof materials in Germany; a measured colour is matched by hue and lightness, so a hazy aerial photo still gives a clean colour
const ROOF_TONES = { tile: ['#a8503a', '#9c4636', '#8c3b2e', '#b6603f', '#7a3a2e', '#6e3b30', '#5b3a32', '#8a5a44'].map(hex),
  dark: ['#3e4046', '#4a4c52', '#34363b', '#55575c'].map(hex), grey: ['#6e6e6c', '#7c7a76', '#62646a', '#8a8884'].map(hex), flat: ['#8a877e', '#7a7872', '#9a988f', '#6a6862'].map(hex),
  solar: ['#2c3a5a', '#33405e'].map(hex), green: ['#7a8550', '#6a7a46'].map(hex), copper: ['#5f8a76'].map(hex) };
function rgb2hsl(r, g, b) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; let h = 0, s = 0;
  if (d > 1e-6) { s = d / (1 - Math.abs(2 * l - 1)); h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; if (h < 0) h += 1; } return [h, s, l]; }
// regions where slate roofs dominate (Eifel, Hunsrück/Mosel, Sauerland/Siegerland, Westerwald, Harz, Thüringer Wald, Erzgebirge)
const SLATE = [[50.0, 50.75, 6.0, 7.4], [49.6, 50.2, 6.6, 7.8], [50.8, 51.45, 7.6, 8.7], [50.45, 50.8, 7.6, 8.1], [51.6, 51.95, 10.3, 11.2], [50.4, 50.8, 10.5, 11.6], [50.4, 50.75, 12.5, 13.6]];
function slateRegion(x, z) { const ll = toLatLon(x, z); return SLATE.some(b => ll[0] >= b[0] && ll[0] <= b[1] && ll[1] >= b[2] && ll[1] <= b[3]); }
// flat roofs without aerial data (Google 3D checks, Dresden): most flat roofs built after 2000 are green (sedum, brownish green),
// some carry solar panels; older flat roofs are mostly gravel/bitumen. Returns [colour, roof type] or null for plain gravel.
function flatGuess(era, util, s) {
  if (util) return null;
  const r = hashStr('fl' + s), pg = era === 5 ? 0.55 : era === 4 ? 0.18 : era === 6 ? 0.05 : 0.08, ps = era === 5 ? 0.15 : era === 6 ? 0.2 : 0.06;
  if (r < pg) return [ROOF_TONES.green[Math.floor(s * 2) % 2], 4];
  if (r < pg + ps) return [ROOF_TONES.solar[Math.floor(s * 2) % 2], 3];
  return null;
}
/* Runde 137 (Google 3D, 40 squares: Frankfurt, Wiesbaden, Bonn, Düsseldorf, Karlsruhe, Potsdam): tall city buildings (eaves from about
   14 m, four storeys and more) mostly carry slate, zinc or dark concrete tiles; red tiles are the rule on low houses. Only without
   aerial data. */
function roofGuess(x, z, s, h) { return (slateRegion(x, z) && hashStr('sl' + s) < 0.8) || (h >= 14 && hashStr('hr' + s) < 0.65) ? ROOF_TONES.dark[Math.floor(s * ROOF_TONES.dark.length)] : ROOFS[Math.floor(hashStr('r' + s) * ROOFS.length)]; }
function snapRoof(r, g, b, type, flat) {
  let set = type === 3 ? ROOF_TONES.solar : type === 4 ? ROOF_TONES.green : type === 1 ? ROOF_TONES.dark : flat || type === 2 ? ROOF_TONES.flat : null;
  const [h, s, l] = rgb2hsl(r, g, b);
  if (!set) { // pitched roof with some colour: reddish/brownish -> tiles, greenish-blue -> copper, otherwise dark/grey
    if ((h < 0.12 || h > 0.9) && s > 0.06) set = ROOF_TONES.tile; else if (h > 0.35 && h < 0.55 && s > 0.12) set = ROOF_TONES.copper; else set = l < 0.4 ? ROOF_TONES.dark : ROOF_TONES.grey; // Google 3D Bavaria: light grey concrete tiles are common, not red
  }
  let best = set[0], bd = Infinity;
  for (const c of set) { const [h2, , l2] = rgb2hsl(c[0], c[1], c[2]); const dh = Math.min(Math.abs(h - h2), 1 - Math.abs(h - h2)); const d = dh * 2 + Math.abs(l - l2) * 1.4; if (d < bd) { bd = d; best = c; } }
  return best;
}
async function measureRoofs(rec) {
  const t = rec.tile, lat = Math.atan(Math.sinh(t.cy / R)) * 180 / Math.PI, lon = t.cx / R * 180 / Math.PI;
  const srcs = quellenAlle('luftbild', lat, lon); // any open WMS with EPSG:3857 and CORS, registered in daten/quellen.json
  if (!srcs.length || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return false;
  const d = rec.data, roofM = new Float32Array(d.nb * 3).fill(-1), roofT = new Uint8Array(d.nb).fill(255);
  let any = false;
  for (const src of srcs) { // near state borders an image can be empty (white/black): those houses try the next source
    try { if (await measureWith(src, rec, roofM, roofT)) any = true; } catch (e) { post({ type: 'warn', msg: 'Luftbild ' + (src.ebene || '') + ': ' + e.message }); }
    let open = 0; for (let b = 0; b < d.nb; b++) if (roofM[b * 3] < 0) open++;
    if (open < d.nb * 0.05) break;
  }
  let done = 0; for (let b = 0; b < d.nb; b++) if (roofM[b * 3] >= 0) done++;
  post({ type: 'info', msg: 'Luftbild ' + rec.tile.id + ': ' + done + '/' + d.nb + ' Dächer gemessen' });
  if (!any) return false;
  d.roofM = roofM; d.roofT = roofT;
  return true;
}
async function measureWith(src, rec, roofM, roofT) {
  const t = rec.tile, S = 512, x0 = t.cx - 500, y1 = t.cy + 500;
  const url = src.url + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=' + src.ebene + '&STYLES=&CRS=EPSG:3857&BBOX=' + (t.cx - 500) + ',' + (t.cy - 500) + ',' + (t.cx + 500) + ',' + (t.cy + 500) + '&WIDTH=' + S + '&HEIGHT=' + S + '&FORMAT=image/jpeg';
  let buf = await cget(url);
  if (!buf) { buf = await (await fetchOk(url)).arrayBuffer(); cput(url, buf); }
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
  const cv = new OffscreenCanvas(S, S), g = cv.getContext('2d'); g.drawImage(bmp, 0, 0); const px = g.getImageData(0, 0, S, S).data;
  const d = rec.data, P = d.pos, I = d.idx, samples = Array.from({ length: d.nb }, () => []), flatN = new Uint32Array(d.nb), roofN = new Uint32Array(d.nb);
  const sample = (x, z, b) => {
    if (roofM[b * 3] >= 0) return; // already measured from an earlier source
    const X = x / O.c + O.X0, Y = -z / O.c + O.Y0, u = Math.floor((X - x0) / 1000 * S), v = Math.floor((y1 - Y) / 1000 * S);
    if (u < 0 || v < 0 || u >= S || v >= S) return; const o = (v * S + u) * 4;
    const mn = Math.min(px[o], px[o + 1], px[o + 2]), mx = Math.max(px[o], px[o + 1], px[o + 2]);
    if (mn >= 250 || mx <= 4) return; // no data here (outside the state's coverage)
    samples[b].push(px[o] / 255, px[o + 1] / 255, px[o + 2] / 255);
  };
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i], b = I[i + 1], c = I[i + 2], kd = d.kind[a]; if (kd === 0) continue;
    const bid = d.bid[a]; if (samples[bid].length > 180) continue;
    if (kd === 2) flatN[bid]++; else roofN[bid]++;
    const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3, cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
    sample(cx, cz, bid);
    for (const v of [a, b, c]) sample((cx + P[v * 3]) / 2, (cz + P[v * 3 + 2]) / 2, bid);
  }
  let got = 0;
  for (let b = 0; b < d.nb; b++) {
    const s = samples[b], n = s.length / 3; if (n < 4) continue; got++;
    const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => (s[p * 3] + s[p * 3 + 1] + s[p * 3 + 2]) - (s[q * 3] + s[q * 3 + 1] + s[q * 3 + 2]));
    let r = 0, gg = 0, bb = 0, k = 0;
    for (let i = Math.floor(n * 0.3); i < Math.ceil(n * 0.85); i++) { const j = order[i]; r += s[j * 3]; gg += s[j * 3 + 1]; bb += s[j * 3 + 2]; k++; } // drop shadows and glare
    r /= k; gg /= k; bb /= k;
    const flat = flatN[b] > roofN[b];
    roofT[b] = roofTypeOf(r, gg, bb, flat);
    if (!flat && roofT[b] === 0 && slateRegion(d.cent[b * 2], d.cent[b * 2 + 1])) { // slate country: only clearly red roofs are tiles
      const hsl = rgb2hsl(r, gg, bb); if (!((hsl[0] < 0.07 || hsl[0] > 0.95) && hsl[1] > 0.28)) roofT[b] = 1;
    }
    const snapped = snapRoof(r, gg, bb, roofT[b], flat); // aerial photos are hazy: map the measurement onto real roof tones
    roofM[b * 3] = snapped[0]; roofM[b * 3 + 1] = snapped[1]; roofM[b * 3 + 2] = snapped[2];
  }
  return got > 0;
}

/* ------------------------------------------------------------ Overpass colours (lazy) */
let opIdx = 0, opOffUntil = 0;
async function overpassColours(t) {
  const key = 'op2:' + t.id; let data = await cget(key, 7 * 864e5);
  if (!data && Date.now() < opOffUntil) return 0; // public Overpass servers are often blocked or overloaded: don't keep trying
  if (!data) {
    const toLL = (X, Y) => [Math.atan(Math.sinh(Y / R)) * 180 / Math.PI, X / R * 180 / Math.PI];
    const sw = toLL(t.cx - 560, t.cy - 560), ne = toLL(t.cx + 560, t.cy + 560), bb = sw[0].toFixed(5) + ',' + sw[1].toFixed(5) + ',' + ne[0].toFixed(5) + ',' + ne[1].toFixed(5);
    const q = '[out:json][timeout:25][bbox:' + bb + '];(way["building"]["roof:colour"];way["building"]["building:colour"];way["building"]["building:material"];way["building"]["roof:material"];relation["building"]["roof:colour"];relation["building"]["building:colour"];node["natural"="tree"];);out geom;';
    let err;
    for (let i = 0; i < OVERPASS.length; i++) {
      const ep = OVERPASS[(opIdx + i) % OVERPASS.length];
      try {
        const ac = new AbortController(), to = setTimeout(() => ac.abort(), 15000);
        const r = await fetchOk(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ac.signal }).finally(() => clearTimeout(to));
        const j = await r.json(); opIdx = (opIdx + i) % OVERPASS.length;
        data = [];
        for (const el of j.elements || []) {
          if (el.type === 'node') { data.push({ tree: [+el.lat.toFixed(7), +el.lon.toFixed(7)], h: parseFloat((el.tags || {}).height) || 0 }); continue; }
          const tg = el.tags || {}, geoms = el.type === 'way' ? [el.geometry] : (el.members || []).filter(m => m.role === 'outer').map(m => m.geometry);
          const wall = tg['building:colour'] || null, roof = tg['roof:colour'] || null, mat = tg['building:material'] || null, rmat = tg['roof:material'] || null;
          for (const g of geoms) { if (!g || g.length < 4) continue; const ll = []; for (const p of g) ll.push(+p.lat.toFixed(7), +p.lon.toFixed(7)); data.push({ ll, wall, roof, mat, rmat }); }
        }
        cput(key, data); break;
      } catch (e) { err = e; }
    }
    if (!data) { opOffUntil = Date.now() + 10 * 60000; throw err || new Error('overpass'); }
  }
  const RMAT = { roof_tiles: null, tile: null, slate: '#3e4046', metal: '#8a8e92', concrete: '#9a988f', copper: '#5f8a76', glass: '#7f9fb4', tar_paper: '#4a4a4a', gravel: '#8a877e', grass: '#6f8a4a', thatch: '#8a7a50', wood: '#7a5a40', eternit: '#6a6a6a' };
  let n = 0;
  const trees = new Geo(), trnd = mulberry(+t.id || 7);
  for (const d of data) {
    if (d.tree) { // single trees mapped in OSM (street trees, trees in courtyards)
      const m = merc(d.tree[0], d.tree[1]), x = lx(m.X), z = lz(m.Y);
      if (!fpAt(x, z)) tree(trees, x, z, d.h ? Math.min(1.8, Math.max(0.7, d.h / 12)) : 0.9 + trnd() * 0.5, trnd);
      continue;
    }
    const p = new Float32Array(d.ll.length);
    for (let i = 0; i < d.ll.length; i += 2) { const m = merc(d.ll[i], d.ll[i + 1]); p[i] = lx(m.X); p[i + 1] = lz(m.Y); }
    const wall = parseCol(d.wall) || (d.mat && MATERIAL[d.mat] ? hex(MATERIAL[d.mat]) : null);
    const roof = parseCol(d.roof) || (d.rmat && RMAT[d.rmat] ? hex(RMAT[d.rmat]) : null);
    if (!wall && !roof) continue;
    gridAdd(Object.assign({ p, wall, roof, src: 2, tile: 'op' + t.id }, bbox(p))); n++;
  }
  const g = trees.out();
  if (g.pos.length) post({ type: 'trees', key: 'l:' + t.id + ':trees', pos: g.pos, nor: g.nor, col: g.col }, [g.pos.buffer, g.nor.buffer, g.col.buffer]);
  return n;
}

/* ------------------------------------------------------------ scheduler */
let tilesUrl = null;
const mvt = new Map();   // key -> {state, rec}
const lod2 = new Map();  // id -> {state, tile, data}
let pos = null, running = 0, busy = false;
const queue = [];        // {key, kind, prio, run}

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function status() { let a = 0, b = 0; for (const v of mvt.values()) if (v.state === 'loading') a++; for (const v of lod2.values()) if (v.state === 'loading' || v.state === 'colour') b++; post({ type: 'status', loading: a + b + queue.length }); }

function enqueue(job) { queue.push(job); pump(); }
function pump() {
  /* Runde 61 (phone: teleporting back and forth, the new place got no streets): priorities are worked out again from where the player
     is NOW, and jobs for places that are far away by now are dropped (they are asked for again when needed) - before, the jobs of the
     old place kept their good rank and ran first, dozens of them after a few jumps */
  if (pos && O && !self.NOREPRIO) { const c = O.c, AX = pos.AX || pos.X, AY = pos.AY || pos.Y;
    for (let i = queue.length - 1; i >= 0; i--) { const j = queue[i]; if (!j.at) continue;
      const d = Math.min(Math.hypot(j.at[0] - pos.X, j.at[1] - pos.Y), Math.hypot(j.at[0] - AX, j.at[1] - AY) * 1.15) * c;
      j.prio = d + j.base + (d > j.dropDist() ? 1e5 : 0); } } // far by now: to the back, but still built (ready when the player jumps back)
  while (running < 3 && queue.length) {
    queue.sort((a, b) => a.prio - b.prio);
    const job = queue.shift(); running++; let freed = false;
    const free = () => { if (freed) return; freed = true; running--; status(); pump(); };
    /* Runde 77 (phone: "Lade Daten" for ever, no ground ahead): a job that never ends held one of the 3 slots for good; after 60 s
       its slot is freed and its tile is forgotten, so it is asked for again */
    const dog = setTimeout(() => { post({ type: 'warn', msg: job.kind + ': hängt, neu angefordert' }); try { if (job.cancel) job.cancel(); } catch (e) { } free(); }, 60000);
    job.run().catch(e => post({ type: 'warn', msg: job.kind + ': ' + (e && e.message || e) })).finally(() => { clearTimeout(dog); free(); });
  }
  status();
}

/* Runde 56 (phone: a fast drive stutters): the 128 m blocks are cut here, not on the main thread (8-22 ms per tile on a PC, ~5x on a
   phone, all in one frame); normals and colours go as 8-bit values (half the transfer and graphics memory) */
function chunkify(g, det) { const p = g.pos, ix = g.idx || null, nt = (ix ? ix.length : p.length / 3) / 3, groups = new Map(), CH = 128;
  for (let t = 0; t < nt; t++) { const a = ix ? ix[t * 3] : t * 3, b = ix ? ix[t * 3 + 1] : t * 3 + 1, c = ix ? ix[t * 3 + 2] : t * 3 + 2;
    const k = Math.floor((p[a * 3] + p[b * 3] + p[c * 3]) / 3 / CH) * 100003 + Math.floor((p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3 / CH);
    let l = groups.get(k); if (!l) groups.set(k, l = [[], []]); l[det && det[t] ? 1 : 0].push(a, b, c); }
  let tot = 0; for (const l of groups.values()) tot += l[0].length + l[1].length;
  const cidx = new Uint32Array(tot), cinfo = new Float32Array(groups.size * 9); let o = 0, ci = 0;
  for (const [l0, l1] of groups.values()) { const start = o; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const l of [l0, l1]) for (const v of l) { cidx[o++] = v; const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    cinfo.set([start, l0.length, l0.length + l1.length, x0, y0, z0, x1, y1, z1], ci * 9); ci++; }
  g.cidx = cidx; g.cinfo = cinfo; }
function quant8(g) { if (g.nor && !(g.nor instanceof Int8Array)) { const n = new Int8Array(g.nor.length); for (let i = 0; i < n.length; i++) n[i] = Math.round(Math.max(-1, Math.min(1, g.nor[i])) * 127); g.nor = n; }
  if (g.col && !(g.col instanceof Uint8Array)) { const c = new Uint8Array(g.col.length); for (let i = 0; i < c.length; i++) c[i] = Math.round(Math.max(0, Math.min(1, g.col[i])) * 255); g.col = c; } }
async function update() {
  if (!O || !pos || busy) return; busy = true;
  try { await quellen(); ensureFar(); } catch (e) { }
  try {
    await quellen();
    const { X, Y } = pos, c = O.c;
    if (!tilesUrl) {
      let tj = await cget('tilejson', 864e5);
      if (!tj) { tj = await (await fetchOk(TILEJSON)).json(); cput('tilejson', tj); }
      tilesUrl = tj.tiles[0];
    }
    // LoD2 tiles (Germany only)
    let l2 = [];
    try { l2 = await lod2TilesNear(X, Y, L2_RADIUS / c); } catch (e) { post({ type: 'warn', msg: 'LoD2-Index: ' + e.message }); }
    const AX = pos.AX || X, AY = pos.AY || Y; if (Math.hypot(AX - X, AY - Y) * c > 150) { try { for (const t of await lod2TilesNear(AX, AY, L2_RADIUS / c)) if (!l2.some(q => q.id === t.id)) l2.push(t); } catch (e) { } }
    for (const t of l2) {
      const d = Math.max(0, Math.min(Math.hypot(t.cx - X, t.cy - Y), Math.hypot(t.cx - AX, t.cy - AY) * 1.15) - 500) * c;
      if (WELT !== 'heute' || d > L2_RADIUS || lod2.has(t.id)) continue;
      const rec = { state: 'loading', tile: t, data: null }; lod2.set(t.id, rec);
      enqueue({ kind: 'LoD2', prio: d + 250, at: [t.cx, t.cy], base: -250, dropDist: () => L2_DROP, cancel: () => { if (lod2.get(t.id) === rec) lod2.delete(t.id); }, run: () => loadLod2(rec) }); // after the ground tiles nearby (Runde 58: ground, streets, then houses)
    }
    // vector tiles
    const n = 1 << Z, rM = MVT_RADIUS / c;
    const t0x = Math.floor((Math.min(X, AX) - rM + HALF) / WORLD * n), t1x = Math.floor((Math.max(X, AX) + rM + HALF) / WORLD * n);
    const t0y = Math.floor((HALF - (Math.max(Y, AY) + rM)) / WORLD * n), t1y = Math.floor((HALF - (Math.min(Y, AY) - rM)) / WORLD * n);
    for (let tx = t0x; tx <= t1x; tx++) for (let ty = t0y; ty <= t1y; ty++) {
      const key = tx + '/' + ty; if (mvt.has(key)) continue; { const fl = mvtFail.get(key); if (fl && Date.now() < fl.until) continue; } // Runde 120: never give up for good - after an outage the map must come back
      const cx = (tx + .5) / n * WORLD - HALF, cy = HALF - (ty + .5) / n * WORLD, dC = Math.hypot(cx - X, cy - Y), dA = Math.hypot(cx - AX, cy - AY);
      if (Math.min(dC, dA) > rM + WORLD / n * .75) continue; // only tiles near the player or near where they will be
      const rec = { state: 'loading', tx, ty }; mvt.set(key, rec);
      enqueue({ kind: 'Karte', prio: Math.min(dC, dA * 1.15) * c - 400, at: [cx, cy], base: -400, dropDist: () => MVT_DROP * .8, cancel: () => { if (mvt.get(key) === rec) mvt.delete(key); }, run: () => loadMVT(rec, key).catch(e => { mvt.delete(key); const fl = mvtFail.get(key) || { n: 0 }; fl.n++; fl.until = Date.now() + Math.min(60000, 4000 * Math.pow(2, fl.n - 1)); mvtFail.set(key, fl); post({ type: 'quelle', q: 'karte', ok: false }); throw e; }) });
    }
    // drop far data
    for (const [key, rec] of mvt) {
      const cx = (rec.tx + .5) / n * WORLD - HALF, cy = HALF - (rec.ty + .5) / n * WORLD;
      if (rec.state === 'loading') continue; // still in the queue or being built: dropped later when ready (else its result had nowhere to go)
      if (Math.hypot(cx - X, cy - Y) * c > MVT_DROP) { mvt.delete(key); gridRemove(i => i.tile === key); gRemove(fpgrid, i => i.tile === key); post({ type: 'drop', prefix: 'm:' + key }); }
    }
    for (const [id, rec] of lod2) {
      if (rec.state === 'loading') continue;
      if (Math.hypot(rec.tile.cx - X, rec.tile.cy - Y) * c > L2_DROP) { lod2.delete(id); gridRemove(i => i.tile === 'op' + id); post({ type: 'drop', prefix: 'l:' + id }); }
    }
  } catch (e) { post({ type: 'warn', msg: 'Update: ' + e.message }); }
  busy = false;
}

/* Underpass detection for one vector tile, run for the tile and its 8 neighbours before a tile is built: every tile then knows all
   troughs that reach into it (a trough found only later by a neighbour left the first tile's ground lying over it - phone test). */
const dipsDone = new Set();
function detectDips(layers, tx, ty) {
  const out = [], L = layers.transportation; if (!L) return out;
  const n = 1 << Z, mk = ext => (x, y) => { const X = (tx + x / ext) / n * WORLD - HALF, Y = HALF - (ty + y / ext) / n * WORLD; return [lx(X), lz(Y)]; }, toL = mk(L.extent || 4096);
    // bridges that streets and paths can pass under: short road and rail bridges (footbridges stand on stairs, the road below stays level;
    // a bridge over ground that is already lower than its ends is a viaduct over a valley - nothing to dig)
    const bsegs = [];
    /* length of the whole bridge, not of one map piece (Runde 53, Hamburg: a 400 m viaduct came as short pieces and the B4 under it was dug) */
    const bl = []; for (const rng of L.feats) { const f = readFeature(L, rng), cls = f.props.class; if (f.type !== 2 || f.props.brunnel !== 'bridge' || !ROAD[cls] || /^(path|track|bridleway|pier)$/.test(cls)) continue; for (const line of geomLines(f, toL)) if (line.length >= 4) { let len = 0; for (let i = 0; i + 3 < line.length; i += 2) len += Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]); bl.push({ f, cls, line, len }); } }
    { const nr = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5, en = l => [[l[0], l[1]], [l[l.length - 2], l[l.length - 1]]], g = new Array(bl.length).fill(-1); let ng = 0;
      for (let i = 0; i < bl.length; i++) { if (g[i] >= 0) continue; const st = [i]; g[i] = ng; let tot = 0, mem = [];
        while (st.length) { const a = st.pop(); mem.push(a); tot += bl[a].len; for (let j = 0; j < bl.length; j++) if (g[j] < 0 && en(bl[a].line).some(p => en(bl[j].line).some(q => nr(p, q)))) { g[j] = ng; st.push(j); } }
        /* Runde 87 (Bremen A270 at Vegesack: three streets meet ON the bridge - eleven 10-20 m pieces, 175 m together, counted as a viaduct
           and the motorway under it was not dug): the size of a street-bridge group is its extent (farthest two ends apart), not the sum */
        let ext = 0; for (const a of mem) for (const b of mem) for (const p of en(bl[a].line)) for (const q of en(bl[b].line)) ext = Math.max(ext, Math.hypot(p[0] - q[0], p[1] - q[1]));
        const c0 = mk(4096)(0, 0), c1 = mk(4096)(4096, 4096), inTile = q => q[0] > Math.min(c0[0], c1[0]) && q[0] < Math.max(c0[0], c1[0]) && q[1] > Math.min(c0[1], c1[1]) && q[1] < Math.max(c0[1], c1[1]);
        const whole = mem.every(a => en(bl[a].line).every(inTile)); // (a group cut at the tile's edge may go on: never counted as short)
        const fastG = mem.some(a => /^(motorway|trunk)$/.test(bl[a].cls)); // (motorway/trunk: the length - two carriageway bridges meeting in a V are long, not a cluster; Bielefeld OWD)
        for (const a of mem) { bl[a].chain = fastG ? tot : Math.min(tot, ext); bl[a].whole = whole; } ng++; } }
    for (const { f, cls, line, len, chain, whole } of bl) { { if (chain > 150) continue;
        const hE = Math.min(hAt(line[0], line[1]), hAt(line[line.length - 2], line[line.length - 1]));
        const low = (cls !== 'motorway' && cls !== 'trunk') || (chain <= 30 && whole); /* Runde 87 (Bremen A27 over the Bultenweg, A27 over the railway at the Bremer Kreuz: 8 m motorway bridges on the dam were never lifted - every crossing is within 8 m of an end - and nothing was dug): under a short motorway bridge the street or railway below is dug in (lifting the motorway would put a 180 m hump into it) */ /* (bridges > 150 m never get here) a street bridge that stays at street level (Runde 52); Runde 83: railway bridges too - they are never lifted, so a motorway under one is dug in (Berlin A100 under the Ringbahn at Halensee lay on the tracks) */
        for (let i = 0; i + 3 < line.length; i += 2) bsegs.push(line[i], line[i + 1], line[i + 2], line[i + 3], ROAD[cls][0] / 2 + 1, hE, low ? 1 : 0); } }
    const underpass = (line, cls, w, walk) => { // crossings of this street with the bridges -> one trough per group of neighbouring bridges
      if (!bsegs.length) return; const path = /^(path|track|bridleway)$/.test(cls), cut = /^(rail|transit|motorway|trunk)$/.test(cls);
      /* Runde 53: railways and motorways under a street bridge that stays at street level lie in a cutting (Hamburg Altmannbruecke,
         Berlin Kaiserdamm): deeper (overhead wires, lorries), long gentle ramps; only under those bridges */
      const D = path ? 3.2 : cut ? 5.5 : 4.6, R = D / (path ? .14 : cut ? .04 : .1), hw = w / 2 + (walk ? 2.6 : path ? .6 : cut ? 1.6 : 1);
      const cr = []; let acc = 0;
      for (let i = 0; i + 3 < line.length; i += 2) { const px = line[i], pz = line[i + 1], qx = line[i + 2], qz = line[i + 3], ex = qx - px, ez = qz - pz, sl = Math.hypot(ex, ez); if (sl < 1e-6) continue;
        for (let j = 0; j < bsegs.length; j += 7) { if (cut && !bsegs[j + 6]) continue; const ax = bsegs[j], az = bsegs[j + 1], fx = bsegs[j + 2] - ax, fz = bsegs[j + 3] - az, den = ex * fz - ez * fx; if (Math.abs(den) < 1e-9) continue;
          const t = ((ax - px) * fz - (az - pz) * fx) / den, u = ((ax - px) * ez - (az - pz) * ex) / den; if (t < 0 || t > 1 || u < 0 || u > 1) continue;
          const cx = px + ex * t, cz = pz + ez * t; if (bsegs[j + 5] - hAt(cx, cz) > 3) continue; // valley under a viaduct
          if (Math.hypot(cx - line[0], cz - line[1]) < 1.5 || Math.hypot(cx - line[line.length - 2], cz - line[line.length - 1]) < 1.5) continue; // Runde 87 (Bremen-Vegesack): a street that ENDS at the bridge goes on onto it - it does not pass under (it was dug 4.6 m)
          const sin = Math.abs(den) / (sl * Math.hypot(fx, fz)); cr.push(acc + sl * t, Math.min(40, bsegs[j + 4] / Math.max(.3, sin) + 2)); }
        acc += sl; }
      if (!cr.length) return;
      const at = s => { s = Math.max(0, Math.min(acc, s)); let a = 0; for (let i = 0; i + 3 < line.length; i += 2) { const sl = Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]); if (a + sl >= s || i + 4 >= line.length) { const t = sl > 0 ? Math.min(1, (s - a) / sl) : 0; return [line[i] + (line[i + 2] - line[i]) * t, line[i + 1] + (line[i + 3] - line[i + 1]) * t]; } a += sl; } return [line[0], line[1]]; };
      const idx = []; for (let k = 0; k < cr.length; k += 2) idx.push(k); idx.sort((a, b) => cr[a] - cr[b]);
      const groups = []; for (const k of idx) { const lo = cr[k] - cr[k + 1], hi = cr[k] + cr[k + 1], g = groups[groups.length - 1]; if (g && lo - g[1] < R) g[1] = Math.max(g[1], hi); else groups.push([lo, hi]); }
      for (const [lo, hi] of groups) {
        const A = at(lo - R * .5), B = at(hi + R * .5); let ux = B[0] - A[0], uz = B[1] - A[1]; const ul = Math.hypot(ux, uz); if (ul < 1) continue; ux /= ul; uz /= ul;
        const c = at((lo + hi) / 2), F = (hi - lo) / 2;
        // a bent street: widen the trough so the curve fits inside (up to 5 m), else a steeper ramp (16 %), else no trough
        const dev = RR => { let m = 0; for (let s = lo - RR; s <= hi + RR; s += 3) { if (s < 0 || s > acc) continue; const p = at(s); m = Math.max(m, Math.abs(-(p[0] - c[0]) * uz + (p[1] - c[1]) * ux)); } return m; };
        let R2 = R, dv = dev(R2); if (dv > hw * .7 + 5) { R2 = D / .16; dv = dev(R2); }
        if (dv <= hw * .7 + 5) out.push({ x: c[0], z: c[1], ux, uz, hw: hw + Math.max(0, dv - hw * .7), F, R: R2, D, cut: cut ? 1 : 0, cls, hw0: w / 2 + .5 }); } };
  for (const rng of L.feats) { const f = readFeature(L, rng), cls = f.props.class, sub = f.props.subclass;
    if (f.type !== 2 || f.props.brunnel === 'bridge' || f.props.brunnel === 'tunnel' || ((f.props.layer || 0) < 0 && !/^(rail|transit|motorway|trunk)$/.test(cls)) || !/^(minor|service|tertiary|secondary|primary|path|track|busway|bridleway|rail|transit|motorway|trunk)$/.test(cls)) continue; // Runde 83: motorways/railways in a cutting (layer < 0) are dug under bridges too - the terrain model fills the bridges in (Essen A40: the motorway climbed 7 m at every bridge)
    let w = ROAD[cls][0]; if ((cls === 'path' && (sub === 'pedestrian' || sub === 'living_street')) || (cls === 'minor' && sub === 'living_street')) w = 5;
    const walk = /^(minor|tertiary|secondary|primary)$/.test(cls) && sub !== 'living_street';
    for (const line of geomLines(f, toL)) underpass(line, cls, w, walk); }
  // no trough where another street or path joins or crosses inside it (junction under the bridge, Koeln-Ehrenfeld: the walls cut
  // across the side street) - those stay level, the bridge is drawn over them
  /* Runde 84 (Essen A40: footbridges, stairs and ramps mapped as bridges, a park lid - the motorway still climbed at every bridge): the
     terrain model fills the space under bridges in. Along motorways, trunk roads and railways the ground is searched for narrow humps
     (< 60 m, > 1.5 m, found by a morphological opening of the height profile) that a bridge of any kind crosses - there the line keeps
     its own level: small troughs exactly as deep as the hump (no fixed 5.5 m, no ramps of their own - the surrounding ground is the ramp) */
  { const BR = []; for (const rng of L.feats) { const f = readFeature(L, rng); if (f.type !== 2 || f.props.brunnel !== 'bridge' || f.props.class === 'pier') continue; for (const line of geomLines(f, toL)) for (let i = 0; i + 3 < line.length; i += 2) BR.push(line[i], line[i + 1], line[i + 2], line[i + 3]); }
    const crossB = (ax, az, bx, bz) => { for (let j = 0; j < BR.length; j += 4) { const ex = bx - ax, ez = bz - az, fx = BR[j + 2] - BR[j], fz = BR[j + 3] - BR[j + 1], den = ex * fz - ez * fx; if (Math.abs(den) < 1e-9) continue;
        const t = ((BR[j] - ax) * fz - (BR[j + 1] - az) * fx) / den, u = ((BR[j] - ax) * ez - (BR[j + 1] - az) * ex) / den; if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true; } return false; };
    if (BR.length) for (const rng of L.feats) { const f = readFeature(L, rng), cls = f.props.class; if (f.type !== 2 || f.props.brunnel || !/^(motorway|trunk|rail|transit)$/.test(cls)) continue;
      const hw = ROAD[cls][0] / 2 + 1.6, ST = 4, Wn = 7; // 4 m samples, window +-28 m (humps up to ~60 m wide)
      for (const line of geomLines(f, toL)) { const P = []; for (let i = 0; i + 3 < line.length; i += 2) { const L2 = Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]), n = Math.max(1, Math.ceil(L2 / ST)); for (let q = 0; q < n; q++) P.push([line[i] + (line[i + 2] - line[i]) * q / n, line[i + 1] + (line[i + 3] - line[i + 1]) * q / n]); }
        P.push([line[line.length - 2], line[line.length - 1]]); if (P.length < 2 * Wn + 3) continue;
        const h = P.map(p => hAt(p[0], p[1])), er = h.map((_, i) => { let m = Infinity; for (let k = Math.max(0, i - Wn); k <= Math.min(h.length - 1, i + Wn); k++) m = Math.min(m, h[k]); return m; });
        const op = er.map((_, i) => { let m = -Infinity; for (let k = Math.max(0, i - Wn); k <= Math.min(h.length - 1, i + Wn); k++) m = Math.max(m, er[k]); return m; });
        // whole humps (Runde 84 fix, OWD at Brackwede: digging stopped where the bridge was 16 m away and left a 7 m wall): a run of
        // samples above the opened profile is dug as a whole when it is > 1.5 m high somewhere and a bridge crosses it
        for (let i = 0; i < P.length;) { if (h[i] - op[i] < .25) { i++; continue; } let j = i, mx = 0; while (j < P.length && h[j] - op[j] >= .25) { mx = Math.max(mx, h[j] - op[j]); j++; }
          let near = false; if (mx >= 1.5) for (let k = Math.max(0, i - 2); k < Math.min(P.length - 1, j + 2) && !near; k++) near = crossB(P[k][0], P[k][1], P[k + 1][0], P[k + 1][1]);
          if (near) for (let k = i; k < j; k++) { const a = P[Math.max(0, k - 1)], b = P[Math.min(P.length - 1, k + 1)], ul = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            out.push({ x: P[k][0], z: P[k][1], ux: (b[0] - a[0]) / ul, uz: (b[1] - a[1]) / ul, hw, F: ST * .75, R: ST * .75, D: h[k] - op[k], cut: 1, cls, hump: 1 }); }
          i = j; } } } }
  /* Runde 83 (Essen A40 in its cutting: 156 of 253 troughs under bridges were dropped): the street that goes on from a bridge end is not a
     junction inside a motorway/railway trough - it is the street crossing over it */
  const bEnd = []; for (const b of bl) bEnd.push([b.line[0], b.line[1]], [b.line[b.line.length - 2], b.line[b.line.length - 1]]);
  const xs = []; for (const rng of L.feats) { const f = readFeature(L, rng), cls = f.props.class;
    if (f.type !== 2 || f.props.brunnel === 'bridge' || f.props.brunnel === 'tunnel' || (f.props.layer || 0) < 0 || !/^(motorway|trunk|primary|secondary|tertiary|minor|service|busway)$/.test(cls)) continue; // drivable only: footways crossing at a ramp end do no harm
    for (const line of geomLines(f, toL)) { const tb = bEnd.some(e => Math.hypot(e[0] - line[0], e[1] - line[1]) < 3 || Math.hypot(e[0] - line[line.length - 2], e[1] - line[line.length - 1]) < 3) ? 1 : 0; for (let i = 0; i + 3 < line.length; i += 2) xs.push(line[i], line[i + 1], line[i + 2], line[i + 3], tb); } }
  const joined = d => { if (d.cls === 'motorway') return false; /* Runde 87 (Bremen A27 under the Bremen-Hamburg railway: a service road beside the tracks, mapped without bridge/tunnel, "crossed" the motorway and cancelled its trough): nothing joins or crosses a motorway at grade - a line across it passes under or over */ const e = d.F + d.R * (1 - 1.5 / d.D); /* only where the trough is deeper than 1.5 m */ for (let i = 0; i < xs.length; i += 5) { if (d.cut && xs[i + 4]) continue; /* (Runde 87: tried for every trough - a slip road coming off another bridge then crossed a footpath trough and was dug 3 m, Bielefeld OWD: kept for cut troughs only) */
      const ax = xs[i], az = xs[i + 1], bx = xs[i + 2], bz = xs[i + 3], L2 = Math.hypot(bx - ax, bz - az); if (L2 < .5) continue;
      if (Math.abs(((bx - ax) * d.ux + (bz - az) * d.uz) / L2) > .8) continue; // along the trough: the street itself, its other lanes
      const sa = dipS(d, ax, az), sb = dipS(d, bx, bz), ta = dipT(d, ax, az), tb = dipT(d, bx, bz);
      if ((sa < -e && sb < -e) || (sa > e && sb > e) || (ta < -d.hw && tb < -d.hw) || (ta > d.hw && tb > d.hw)) continue;
      for (let k = 0; k <= 1.001; k += Math.min(1, 1.5 / L2)) { const s2 = sa + (sb - sa) * k, t2 = ta + (tb - ta) * k; if (Math.abs(s2) < e && Math.abs(t2) < d.hw) return true; } }
    return false; };
  const out2 = out.filter(d => !joined(d)); out.length = 0; out.push(...out2);
  /* Runde 119 (phone test Bielefeld Von-der-Recke-Strasse, underpass under the Ostwestfalendamm: the street bends there, the trough was
     widened to 20 m for the curve and its walls ran under the neighbouring houses - a house hung over the trough wall): a trough stays
     0.5 m away from every building footprint where it is deeper than 0.3 m; it is narrowed to that, but never below the carriageway */
  { const B = layers.building; if (B && out.length) { const tb = mk(B.extent || 4096), pts = [];
      for (const rng of B.feats) { const f = readFeature(B, rng); if (f.type !== 3) continue;
        for (const ring of geomLines(f, tb)) for (let i = 0; i + 3 < ring.length; i += 2) { const ax = ring[i], az = ring[i + 1], ex = ring[i + 2] - ax, ez = ring[i + 3] - az, n = Math.max(1, Math.ceil(Math.hypot(ex, ez))); for (let q = 0; q < n; q++) pts.push(ax + ex * q / n, az + ez * q / n); } }
      for (const d of out) { if (d.hump || !d.hw0) continue; const e = Math.abs(d.F) + d.R; let m = d.hw;
        for (let i = 0; i < pts.length; i += 2) { const sv = dipS(d, pts[i], pts[i + 1]); if (Math.abs(sv) > e) continue; const tv = Math.abs(dipT(d, pts[i], pts[i + 1])); if (tv - .5 >= m || dipProfile(d, sv) < .3) continue; m = tv - .5; }
        d.hw = Math.max(d.hw0, Math.min(d.hw, m)); } } }
  // never dig next to water (paths along a river under a bridge stay at the bank)
  const W = layers.water, wp = [], WL2 = layers.waterway, wl = [];
  if (W) { const tw = mk(W.extent || 4096); for (const rng of W.feats) { const f = readFeature(L === W ? L : W, rng); if (f.type !== 3 || f.props.brunnel === 'tunnel') continue; for (const poly of polygons(geomLines(f, tw))) wp.push(Float32Array.from(poly[0])); } }
  if (WL2) { const tw = mk(WL2.extent || 4096); for (const rng of WL2.feats) { const f = readFeature(WL2, rng); if (f.type !== 2 || f.props.brunnel === 'tunnel') continue; for (const line of geomLines(f, tw)) wl.push(line); } }
  const wet = (x, z) => { for (const p of wp) if (inPoly(x, z, p)) return true; for (const l of wl) for (let i = 0; i + 3 < l.length; i += 2) { const ax = l[i], az = l[i + 1], ex = l[i + 2] - ax, ez = l[i + 3] - az, q = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1))); if (Math.hypot(ax + ex * q - x, az + ez * q - z) < 4) return true; } return false; };
  /* Runde 79 (Hamburg Elbtunnel south portal: in Google the A7 sinks into a walled trough and dives under; in the game the lanes ran on
     at ground level and stopped in the open): every road/rail tunnel end that is a portal (a surface road or track goes on there, inside
     this tile) gets a one-sided trough down to the tunnel (6 m road, 7 m rail, 4.5 % ramp) - the ground over the tunnel stays */
  { const tc0 = mk(4096)(0, 0), tc1 = mk(4096)(4096, 4096), bx0 = Math.min(tc0[0], tc1[0]), bx1 = Math.max(tc0[0], tc1[0]), bz0 = Math.min(tc0[1], tc1[1]), bz1 = Math.max(tc0[1], tc1[1]);
    const surf = [], tun = []; for (const rng of L.feats) { const f = readFeature(L, rng); if (f.type !== 2 || !ROAD[f.props.class]) continue; const r = f.props.class === 'rail' || f.props.class === 'transit', T = f.props.brunnel === 'tunnel' ? tun : surf; for (const line of geomLines(f, toL)) T.push([line[0], line[1], r], [line[line.length - 2], line[line.length - 1], r]); }
    /* Runde 94 (phone test Bielefeld Herforder Strasse: a 7 m trench in the street over the Stadtbahn station under the main station):
       a portal needs a surface piece OF THE SAME KIND going on (rail after a rail tunnel, road after a road tunnel) - a street that
       happens to end above a tunnel joint (stations, layer changes) does not count. */
    for (const rng of L.feats) { const f = readFeature(L, rng), cls = f.props.class; if (f.type !== 2 || f.props.brunnel !== 'tunnel' || !ROAD[cls] || /^(path|track|bridleway|pier)$/.test(cls)) continue;
      const rail = cls === 'rail' || cls === 'transit', D = rail ? 7 : 6, w = ROAD[cls][0];
      const major = /^(motorway|trunk|primary|secondary|tertiary|rail|transit)$/.test(cls);
      for (const line of geomLines(f, toL)) { if (line.length < 4) continue; let len = 0; for (let i = 0; i + 3 < line.length; i += 2) len += Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]);
        if (len < (major ? 30 : 80)) continue; // building passages and short covered ways are mapped as tunnels too: no trough there
        for (const k of [0, 1]) { const px = k ? line[line.length - 2] : line[0], pz = k ? line[line.length - 1] : line[1], qx = k ? line[line.length - 4] : line[2], qz = k ? line[line.length - 3] : line[3];
          PST.cand++; if (px < bx0 || px > bx1 || pz < bz0 || pz > bz1) { PST.edge++; continue; } // clipped at the tile edge: no portal here
          if (!surf.some(e => e[2] === rail && Math.hypot(e[0] - px, e[1] - pz) < 8)) { PST.nosurf++; continue; } // no surface piece of this kind goes on: no portal
          const l = Math.hypot(qx - px, qz - pz) || 1; const tr = cls === 'transit', Dp = tr ? 6 : D; /* Runde 94: light rail ramps are steeper (7 %) and shallower than main-line or road ramps (Bielefeld Herforder Strasse ~90 m) */ out.push({ x: px, z: pz, ux: (qx - px) / l, uz: (qz - pz) / l, hw: Math.min(w, 8) / 2 + 1.2, F: -0.01, R: Dp / (tr ? .07 : .045), D: Dp, portal: 1, w: Math.min(w, 8), cls }); /* (at most 2 lanes per tube + walls: the default 12 m width cut into service roads) */ } } } }
  /* R5 (Berlin Dreieck Funkturm): a street that crosses a tunnel approach right at the portal runs over the tunnel mouth - the portal
     moves back behind it, so the street stays on solid ground.
     R6: a railway/motorway trough (Runde 53) is not dug where another street runs inside it at ground level (Berlin Halenseestrasse
     beside the tracks dropped 4.5 m) */
  { const surfL = []; for (const rng of L.feats) { const f = readFeature(L, rng), cls = f.props.class; if (f.type !== 2 || f.props.brunnel || !ROAD[cls] || /^(rail|transit|pier)$/.test(cls)) continue;
      for (const line of geomLines(f, toL)) surfL.push({ line, w: ROAD[cls][0], cls }); }
    const crossS = (d, own) => { let best = null; for (const o of surfL) { if (o.line === own) continue; const M = o.line;
        if (Math.hypot(M[0] - d.x, M[1] - d.z) < 3 || Math.hypot(M[M.length - 2] - d.x, M[M.length - 1] - d.z) < 3) continue; // the approach road itself
        for (let j = 0; j + 3 < M.length; j += 2) { const sl = Math.hypot(M[j + 2] - M[j], M[j + 3] - M[j + 1]); if (sl > .5 && Math.abs(((M[j + 2] - M[j]) * d.ux + (M[j + 3] - M[j + 1]) * d.uz) / sl) > .8) continue; /* Runde 94 (Herforder Strasse: Stadtbahn ramp in the middle of the street): a road running ALONG the trough does not cross it */
          for (let q = 0; q <= 1; q += .1) { const x = M[j] + (M[j + 2] - M[j]) * q, z = M[j + 1] + (M[j + 3] - M[j + 1]) * q, t = Math.abs(dipT(d, x, z)), sd = dipS(d, x, z);
          if (t < d.hw && sd > -d.R && sd < 6 && (best === null || sd > best.s)) best = { s: sd, w: o.w }; } } } return best; };
    for (const d of out) { if (!d.portal) continue; const c = crossS(d, null); if (!c) continue; const back = Math.min(0, c.s - c.w / 2 - 1.5); if (back < -d.R * .6) { d.drop = 1; PST.r5++; continue; }
      d.x += d.ux * back; d.z += d.uz * back; }
    // R7: a portal trough beside another road at ground level (a ramp diving under next to the motorway) is narrowed to stay clear of it
    const portalPts = out.filter(d => d.portal).map(d => [d.x - d.ux * 0, d.z - d.uz * 0]);
    for (const d of out) { if (!d.portal || d.drop) continue; let minT = Infinity;
      for (const o of surfL) { const M = o.line; let inside = 0, centre = 0, tmin = Infinity;
        if (portalPts.some(p => Math.hypot(M[0] - p[0], M[1] - p[1]) < 8 || Math.hypot(M[M.length - 2] - p[0], M[M.length - 1] - p[1]) < 8)) continue; // the ramp of the other direction: one wide trough together
        if (o.w < 4) continue; // footpaths and narrow service ways beside a ramp: cut off by the trough wall (stairs/ramps in reality)
        if (o.cls === d.cls || (/^(motorway|trunk)$/.test(o.cls) && /^(motorway|trunk)$/.test(d.cls))) { let par = 0, nn = 0; for (let j = 0; j + 3 < M.length; j += 2) { const ex = M[j + 2] - M[j], ez = M[j + 3] - M[j + 1], l = Math.hypot(ex, ez); if (l < .1) continue; nn++; if (Math.abs(ex * d.ux + ez * d.uz) / l > .9) par++; } if (nn && par / nn > .6) continue; } // parallel carriageways/tubes of the same road: one trough
        for (let j = 0; j + 3 < M.length; j += 2) { const L2 = Math.hypot(M[j + 2] - M[j], M[j + 3] - M[j + 1]), m = Math.max(1, Math.ceil(L2 / 3));
          for (let q = 0; q <= m; q++) { const x = M[j] + (M[j + 2] - M[j]) * q / m, z = M[j + 1] + (M[j + 3] - M[j + 1]) * q / m, t = Math.abs(dipT(d, x, z)); if (t < d.hw + o.w / 2 && dipProfile(d, dipS(d, x, z)) > 1) { inside++; if (t < 1.5) centre++; tmin = Math.min(tmin, t - o.w / 2); } } }
        if (inside >= 3 && centre < inside * .5) minT = Math.min(minT, tmin); } // not the approach road (that one runs down the middle)
      if (minT < d.hw) { const need = Math.min(d.w / 2 + .2, 1.8); if (minT - .2 < need) { d.drop = 1; PST.r7++; } else d.hw = minT - .2; } } // only a wall between the ramp and the lanes beside it (Munich Prinzregentenstrasse)
    for (const d of out) { if (!d.cut) continue; let n = 0; for (const o of surfL) { if (/^(motorway|trunk)$/.test(d.cls) && /^(motorway|trunk|path|track|bridleway)$/.test(o.cls)) continue; /* Runde 84 (Essen A40): a footway beside the motorway does not cancel its trough */ const M = o.line; for (let j = 0; j + 3 < M.length; j += 2) { const L2 = Math.hypot(M[j + 2] - M[j], M[j + 3] - M[j + 1]), m = Math.max(1, Math.ceil(L2 / 3));
          if (L2 > .5 && Math.abs(((M[j + 2] - M[j]) * d.ux + (M[j + 3] - M[j + 1]) * d.uz) / L2) < .8) continue; // Runde 87: a line ACROSS the trough passes under or over it (level crossings: see joined) - only streets running along inside count
          for (let q = 0; q <= m; q++) { const x = M[j] + (M[j + 2] - M[j]) * q / m, z = M[j + 1] + (M[j + 3] - M[j + 1]) * q / m; if (Math.abs(dipT(d, x, z)) < d.hw - 1 && dipProfile(d, dipS(d, x, z)) > 1.5) n++; } } }
      if (n >= 4) d.drop = 1; } }
  /* Runde 87 (Bremen: the A1, A27 and A281 stayed level under every railway bridge - a drainage ditch runs beside the motorway in the
     marsh, 10 m from the centre line, and "never dig next to water" dropped each trough): a motorway or railway trough has walls, water
     beside it does not matter - only water across its centre line (a river, a canal; wet() adds 4 m around streams) */
  return out.filter(d => { if (d.drop) return false; if (d.portal) return true; const tw = d.cut && !d.hump ? 0 : d.hw + 3; for (let s = -d.F - d.R; s <= d.F + d.R; s += 4) for (let t = -tw; t <= tw; t += 3) if (wet(d.x + d.ux * s - d.uz * t, d.z + d.uz * s + d.ux * t)) return false; return true; });
}
async function dipsAround(tx, ty, ownLayers) {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const k = (tx + dx) + '/' + (ty + dy); if (dipsDone.has(k)) continue;
    try { let layers = dx === 0 && dy === 0 ? ownLayers : null;
      if (!layers) { const url = tilesUrl.replace('{z}', Z).replace('{x}', tx + dx).replace('{y}', ty + dy); let buf = await cget(url); if (!buf) { buf = await (await fetchOk(url)).arrayBuffer(); cput(url, buf); } layers = decodeMVT(buf); }
      const n = 1 << Z, cx = (tx + dx + .5) / n * WORLD - HALF, cy = HALF - (ty + dy + .5) / n * WORLD, half = WORLD / n / 2;
      await ensureTerrain(lx(cx - half - 50), lz(cy + half + 50), lx(cx + half + 50), lz(cy - half - 50));
      for (const d of detectDips(layers, tx + dx, ty + dy)) addDip(d); dipsDone.add(k);
    } catch (e) { } }
}
const PST = { cand: 0, edge: 0, nosurf: 0, r5: 0, r7: 0 }; self.PST = PST; // (debug: self.PST counts candidates and why portals were left out)
const PENDR = []; // ramp ends handed over at tile borders (Runde 79)
function pendRebuild(from, n0) { // a neighbour that is already built gets rebuilt once, so it carries the ramp on
  const n = 1 << Z, done = new Set();
  for (let i = n0; i < PENDR.length; i++) { const e = PENDR[i]; if (e.from !== from) continue; const l = Math.hypot(e.dx, e.dz) || 1, x = e.p[0] + e.dx / l * 20, z = e.p[1] + e.dz / l * 20;
    const X = x / O.c + O.X0, Y = -z / O.c + O.Y0, tx = Math.floor((X + HALF) / WORLD * n), ty = Math.floor((HALF - Y) / WORLD * n), k = tx + '/' + ty;
    if (k === from || done.has(k)) continue; done.add(k); const r = mvt.get(k);
    if (r && r.state === 'ready' && !(r.rampFrom || (r.rampFrom = new Set())).has(from)) { r.rampFrom.add(from); r.state = 'loading'; enqueue({ kind: 'Karte', prio: -300, run: () => loadMVT(r, k) }); } } }
async function loadMVT(rec, key) {
  const url = tilesUrl.replace('{z}', Z).replace('{x}', rec.tx).replace('{y}', rec.ty);
  let buf = await cget(url);
  if (!buf) { buf = await (await fetchOk(url)).arrayBuffer(); cput(url, buf); }
  // which LoD2 tiles touch this vector tile? (needed to know which fallback buildings to hold back)
  const n = 1 << Z, cx = (rec.tx + .5) / n * WORLD - HALF, cy = HALF - (rec.ty + .5) / n * WORLD;
  let l2 = []; try { l2 = await lod2TilesNear(cx, cy, WORLD / n / 2 + 600); } catch (e) { }
  const half = WORLD / n / 2;
  await ensureZensus(lx(cx - half), lz(cy + half), lx(cx + half), lz(cy - half));
  await ensureTerrain(lx(cx - half - 50), lz(cy + half + 50), lx(cx + half + 50), lz(cy - half - 50));
  const osm = await osmFor(lx(cx - half), lz(cy + half), lx(cx + half), lz(cy - half));
  try { osm.streets = await strFor(lx(cx - half), lz(cy + half), lx(cx + half), lz(cy - half)); } catch (e) { osm.streets = []; }
  osm.trees = await baumFor(lx(cx - half), lz(cy + half), lx(cx + half), lz(cy - half), mulberry(rec.tx * 31 + rec.ty));
  post({ type: 'info', msg: 'Baumkarte ' + key + ': ' + (osm.trees ? osm.trees.length / 2 + ' Baeume' : 'nicht verfuegbar') });
  const layers = decodeMVT(buf); await dipsAround(rec.tx, rec.ty, layers);
  if (WELT === 'mittel') await burgPrep(cx - half, cy - half, cx + half, cy + half); // Runde 154: castles and towns around this tile
  const pn0 = PENDR.length; const out = buildMVT(layers, rec.tx, rec.ty, l2, osm);
  rec.state = 'ready'; if (PENDR.length > pn0) pendRebuild(key, pn0); rec.buckets = out.buckets; rec.items = out.items;
  const g = out.ground, gl = out.glow; chunkify(g, g.det); chunkify(gl, gl.det); quant8(g); quant8(gl);
  post({ type: 'ground', key: 'm:' + key, pos: g.pos, nor: g.nor, col: g.col, idx: g.idx || null, det: g.det, cidx: g.cidx, cinfo: g.cinfo, glow: gl, collide: out.collide, names: out.names, samples: out.samples, sqNames: out.sqNames, pedNames: out.pedNames, spawn: out.spawn, start: out.start, welt: out.welt, map: out.map, spr: out.spr, refl: out.refl, cars: out.cars, dips: out.dips, rails: out.rails, corr: out.corr, dz: out.dz, span: out.span, elev: out.elev }, [g.pos.buffer, g.nor.buffer, g.col.buffer, g.cidx.buffer, g.cinfo.buffer, gl.pos.buffer, gl.nor.buffer, gl.col.buffer, gl.cidx.buffer, gl.cinfo.buffer, out.spr.buffer, out.refl.buffer, out.cars.buffer]);
  if (out.water) { const w = out.water, f = w.field; if (f) f.S = out.waterS;
    { const tr = [w.pos.buffer, w.nor.buffer, w.col.buffer]; if (f) { tr.push(f.data.buffer); if (f.flow) tr.push(f.flow.buffer); if (f.dry) tr.push(f.dry.buffer); }
    post({ type: 'water', key: 'm:' + key + ':water', pos: w.pos, nor: w.nor, col: w.col, field: f }, tr); } }
  if (out.parts) { const g2 = out.parts; post({ type: 'bld', key: 'm:' + key + ':parts', pos: g2.pos, nor: g2.nor, col: g2.col, fac: g2.fac, wal: g2.wal, base: g2.base }, [g2.pos.buffer, g2.nor.buffer, g2.col.buffer, g2.fac.buffer, g2.wal.buffer, g2.base.buffer]); }
  if (out.sights.length) post({ type: 'sights', key: 'm:' + key, sights: out.sights });
  for (const [owner] of out.buckets) sendBucket(rec, key, owner);
  // LoD2 tiles already shown get another pass now that footprints, shops and colours are known
  for (const r of lod2.values()) if (r.data) { recolour(r); if (r.idx0) recheckBlock(r); }
}
function sendBucket(rec, key, owner) {
  if (!rec.buckets || !rec.buckets.has(owner)) return;
  if (owner !== 'none') { const l = lod2.get(owner); if (!l || l.state !== 'failed') { if (l || inRangeL2(owner)) return; } }
  const G = rec.buckets.get(owner); if (G.sent) return; G.sent = true;
  const g = G.out(); post({ type: 'bld', key: 'm:' + key + ':' + owner, pos: g.pos, nor: g.nor, col: g.col, fac: g.fac, wal: g.wal, base: g.base }, [g.pos.buffer, g.nor.buffer, g.col.buffer, g.fac.buffer, g.wal.buffer, g.base.buffer]);
}
function inRangeL2() { return true; } // LoD2 tile will be requested when the player gets close; until then fog hides it

let L2SEQ = 0; // Runde 68: every LoD2 building gets a number (tile number * 8192 + gml group): the app hides whole buildings by it
async function loadLod2(rec) {
  const t = rec.tile, url = L2BASE + t.col.dir + 'tiles/' + t.id + '.b3dm';
  try {
    let buf = await cget(url);
    if (!buf) { buf = await (await fetchOk(url)).arrayBuffer(); cput(url, buf); }
    rec.data = parseB3dm(buf, t);
  } catch (e) {
    rec.state = 'failed'; post({ type: 'warn', msg: 'LoD2 ' + t.id + ': ' + e.message });
    for (const [key, m] of mvt) if (m.state === 'ready') sendBucket(m, key, t.id);
    return;
  }
  rec.state = 'ready';
  await ensureZensus(lx(t.cx - 520), lz(t.cy + 520), lx(t.cx + 520), lz(t.cy - 520));
  const d = rec.data, { col, fac, wal } = colourLod2(d);
  const pos2 = d.pos.slice(), nor2 = d.nor.slice(), base = new Float32Array(pos2.length / 3);
  let idx2 = d.idx.slice();
  { // structures lower than 1.2 m (roofs of underground stations, garages under squares) are no buildings: with terrain they stuck
    // out of the street a few cm and turned into a dotted see-through area over road and cars (phone test, Augsburger Strasse)
    const gt = new Float32Array(d.ng).fill(-1e9); for (let k = 0; k < d.pos.length / 3; k++) { const g = d.grp[d.bid[k]]; if (d.pos[k * 3 + 1] > gt[g]) gt[g] = d.pos[k * 3 + 1]; }
    let low = 0; for (let g = 0; g < d.ng; g++) if (gt[g] < 1.2) low++;
    if (low) { const keep = []; for (let i = 0; i < idx2.length; i += 3) if (gt[d.grp[d.bid[idx2[i]]]] >= 1.2) keep.push(idx2[i], idx2[i + 1], idx2[i + 2]); idx2 = Uint32Array.from(keep); }
  }
  // landmarks mapped in parts (OSM Simple 3D Buildings) are drawn from those parts: hide the coarse LoD2 building
  // where at least 60 % of its ground points lie inside parts
  try {
    if (self.SONDER) { // Runde 206: LoD2 buildings standing where a landmark model stands are left out
      const rects = SONDER.list.map(e => { const m = merc(e.lat, e.lon); return SONDER.frame(e, lx(m.X), lz(m.Y)).rect; }).filter(r => r.some(([x, z]) => Math.abs(x - lx(t.cx)) < 900 && Math.abs(z - lz(t.cy)) < 900));
      if (rects.length) { const sx = new Float64Array(d.ng), sz = new Float64Array(d.ng), sn = new Uint32Array(d.ng), P = d.pos;
        for (let k = 0; k < P.length / 3; k++) { if (P[k * 3 + 1] > 1.5) continue; const g = d.grp[d.bid[k]]; sx[g] += P[k * 3]; sz[g] += P[k * 3 + 2]; sn[g]++; }
        const hide = new Uint8Array(d.ng); let nh = 0; for (let g = 0; g < d.ng; g++) if (sn[g] && rects.some(r => SONDER.inRect(sx[g] / sn[g], sz[g] / sn[g], r))) { hide[g] = 1; nh++; }
        if (nh) { const keep = []; for (let i = 0; i < idx2.length; i += 3) if (!hide[d.grp[d.bid[idx2[i]]]]) keep.push(idx2[i], idx2[i + 1], idx2[i + 2]); idx2 = Uint32Array.from(keep); } } }
    const om = await osmFor(lx(t.cx - 520), lz(t.cy + 520), lx(t.cx + 520), lz(t.cy - 520));
    if (om.parts.length) {
      const inG = new Uint32Array(d.ng), allG = new Uint32Array(d.ng), P = d.pos;
      for (let k = 0; k < P.length / 3; k++) { if (P[k * 3 + 1] > 1.5) continue; const g = d.grp[d.bid[k]], x = P[k * 3], z = P[k * 3 + 2]; allG[g]++;
        for (const q of om.parts) if (x >= q.minx - .5 && x <= q.maxx + .5 && z >= q.minz - .5 && z <= q.maxz + .5 && (inPoly(x, z, q.ring) || nearRing(x, z, q.ring, 0.8))) { inG[g]++; break; } }
      const hide = new Uint8Array(d.ng); let nh = 0; for (let g = 0; g < d.ng; g++) if (allG[g] && inG[g] / allG[g] >= 0.6) { hide[g] = 1; nh++; }
      if (nh) { const keep = []; for (let i = 0; i < idx2.length; i += 3) if (!hide[d.grp[d.bid[idx2[i]]]]) keep.push(idx2[i], idx2[i + 1], idx2[i + 2]); idx2 = Uint32Array.from(keep); }
    }
  } catch (e) { }
  if (TERRAIN_ON) await ensureTerrain(lx(t.cx - 520), lz(t.cy + 520), lx(t.cx + 520), lz(t.cy - 520)); // heights needed by the plausibility checks
  rec.idx0 = idx2.slice(); { const b = blockGroups(d); rec.block = b.set; rec.blockTris = b.tris; idx2 = blockIdx(rec); }
  if (TERRAIN_ON) { // every building (gml_id group) stands on the lowest terrain point under its ground floor
    await ensureTerrain(lx(t.cx - 520), lz(t.cy + 520), lx(t.cx + 520), lz(t.cy - 520));
    const gb = new Float32Array(d.ng).fill(Infinity), P = d.pos;
    for (let k = 0; k < P.length / 3; k++) { if (P[k * 3 + 1] > 1.5) continue; const g = d.grp[d.bid[k]], h = hAt(P[k * 3], P[k * 3 + 2]); if (h < gb[g]) gb[g] = h; }
    for (let k = 0; k < P.length / 3; k++) { const g = d.grp[d.bid[k]]; let b = gb[g]; if (!isFinite(b)) { b = hAt(d.cent[d.bid[k] * 2], d.cent[d.bid[k] * 2 + 1]); gb[g] = b; } base[k] = b; pos2[k * 3 + 1] += b; }
    d.gBase = gb;
  }
  const tid = (L2SEQ++ % 2000) + 1, gid = new Float32Array(pos2.length / 3); for (let k = 0; k < gid.length; k++) gid[k] = tid * 8192 + (d.grp[d.bid[k]] % 8192);
  /* Runde 75 (phone: "jumping onto it does not work" - a garage): many small LoD2 buildings (garages, sheds, annexes) have no OSM
     outline, and standing, jumping and walls only knew OSM outlines. Their outline now comes from LoD2 itself: the convex hull of the
     ground-level corners of each drawn building, up to 300 m2 (larger ones have OSM outlines; a hull would fill courtyards) */
  const collide = []; {
    const used = new Uint8Array(d.ng); for (let i = 0; i < idx2.length; i += 3) used[d.grp[d.bid[idx2[i]]]] = 1;
    const pts = new Map(), top = new Float32Array(d.ng).fill(-1e9);
    for (let k = 0; k < d.pos.length / 3; k++) { const g = d.grp[d.bid[k]]; if (!used[g]) continue; if (pos2[k * 3 + 1] > top[g]) top[g] = pos2[k * 3 + 1];
      if (d.pos[k * 3 + 1] < 1.0) { let l = pts.get(g); if (!l) pts.set(g, l = []); l.push([d.pos[k * 3], d.pos[k * 3 + 2]]); } }
    for (const [g, l] of pts) { if (l.length < 3) continue; l.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], hi = [];
      for (const p of l) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (let i = l.length - 1; i >= 0; i--) { const p = l[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
      const h = lo.slice(0, -1).concat(hi.slice(0, -1)); if (h.length < 3) continue;
      let A = 0, cx = 0, cz = 0; for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length]; A += a[0] * b[1] - b[0] * a[1]; cx += a[0]; cz += a[1]; } A = Math.abs(A) / 2; cx /= h.length; cz /= h.length;
      if (A < 4 || A > 300 || fpAt(cx, cz)) continue;                                   // OSM outline there: that one counts
      const base = d.gBase ? d.gBase[g] : 0; if (!isFinite(base) || top[g] - base < 1.2) continue;
      collide.push(h.length, top[g], base); for (const p of h) collide.push(p[0], p[1]); } }
  const rp = lod2Props(d, t.id, idx2, tid), spr = rp.spr; postRoofThings('l:' + t.id, rp.geo);
  post({ type: 'lod2', key: 'l:' + t.id, pos: pos2, nor: nor2, col, fac, wal, base, idx: idx2, spr, gid, collide: Float32Array.from(collide) }, [pos2.buffer, nor2.buffer, col.buffer, fac.buffer, wal.buffer, base.buffer, idx2.buffer, spr.buffer, gid.buffer]);
  rescueFor(rec);
  enqueue({ kind: 'Dächer', prio: 2000, run: async () => { try { if (await measureRoofs(rec) && lod2.get(t.id) === rec) recolour(rec); } catch (e) { post({ type: 'warn', msg: 'Luftbild ' + t.id + ': ' + e.message }); } } });
  // colours and trees now come from own OSM tiles (daten/osm); the public Overpass servers were blocked or overloaded.
  // Overpass stays available only as an opt-in fallback for places outside the prepared tiles.
  if (self.HX_OVERPASS) { opWait.push(rec); runOverpass(); }
}
const opWait = []; let opBusy = false;
async function runOverpass() {
  if (opBusy || !opWait.length) return; opBusy = true;
  opWait.sort((a, b) => Math.hypot(a.tile.cx - pos.X, a.tile.cy - pos.Y) - Math.hypot(b.tile.cx - pos.X, b.tile.cy - pos.Y));
  const rec = opWait.shift();
  if (lod2.get(rec.tile.id) === rec) {
    try { const n = await overpassColours(rec.tile); if (n && lod2.get(rec.tile.id) === rec) recolour(rec); }
    catch (e) { post({ type: 'warn', msg: 'Farben (Overpass): ' + e.message }); }
  }
  opBusy = false; post({ type: 'colours', waiting: opWait.length }); runOverpass();
}
function recolour(rec) {
  if (!rec.data) return; const { col, fac, wal } = colourLod2(rec.data);
  post({ type: 'recolour', key: 'l:' + rec.tile.id, col, fac, wal }, [col.buffer, fac.buffer, wal.buffer]);
}

/* light map tiles for the big map (pan anywhere, any zoom): only areas, streets and (at z14) house outlines, no 3D */
async function mapTile(z, x, y) {
  if (!tilesUrl || !O) return;
  const url = tilesUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  let buf = await cget(url); if (!buf) { buf = await (await fetchOk(url)).arrayBuffer(); cput(url, buf); }
  const layers = decodeMVT(buf), n = 1 << z, md = { areas: [], roads: [], blds: [] };
  const mk = ext => (px, py) => { const X = (x + px / ext) / n * WORLD - HALF, Y = HALF - (y + py / ext) / n * WORLD; return [lx(X), lz(Y)]; };
  // Runde 165: the big map of the medieval world shows the same countryside - through roads, towns of the castles known so far
  const MT = WELT === 'mittel' ? [...BURGS.values()].filter(Boolean).map(b => ({ x: lx(b.tX), z: lz(b.tY), R: b.R })) : null;
  const inTownM = (pts) => { if (!MT) return true; for (let i = 0; i < pts.length; i += 2) for (const t of MT) if (Math.hypot(pts[i] - t.x, pts[i + 1] - t.z) < t.R * 1.1) return true; return false; };
  for (const ln of ['landcover', 'landuse', 'park', 'water']) { const L = layers[ln]; if (!L) continue; const toL = mk(L.extent || 4096);
    for (const rng of L.feats) { const f = readFeature(L, rng); if (f.type !== 3) continue;
      if (MT && ln === 'landuse' && /^(residential|commercial|industrial|retail|railway|construction|garages|brownfield|landfill|military|parking|cemetery|school|university|hospital)$/.test(f.props.class) && !inTownM(geomLines(f, toL)[0] || [])) continue;
      let k; if (ln === 'water') k = 'w'; else { const a = AREA[f.props.class] || AREA[f.props.subclass]; if (!a) continue; k = a[2] > 1 / 300 ? 'f' : 'g'; }
      for (const poly of polygons(geomLines(f, toL))) md.areas.push({ k, rings: poly.map(r => Float32Array.from(r)) }); } }
  { const L = layers.transportation; if (L) { const toL = mk(L.extent || 4096);
    for (const rng of L.feats) { const f = readFeature(L, rng), cls = f.props.class; if (f.type !== 2 || f.props.brunnel === 'tunnel') continue;
      if (MT && (/^(motorway|trunk|rail|transit|busway|raceway)$/.test(cls) || (!/^(primary|secondary|tertiary)$/.test(cls) && !inTownM(geomLines(f, toL)[0] || [])))) continue;
      const spec = ROAD[cls]; const w = spec ? spec[0] : 3;
      for (const line of geomLines(f, toL)) md.roads.push({ w, k: cls === 'rail' || cls === 'transit' ? 'r' : (cls === 'path' || cls === 'track' ? 'p' : 'm'), p: Float32Array.from(line), o: +f.props.oneway || 0, a: cls === 'motorway' ? 1 : 0, b: f.props.brunnel ? 1 : 0 }); } } }
  if (z >= 14) { const L = layers.building; if (L) { const toL = mk(L.extent || 4096);
    for (const rng of L.feats) { const f = readFeature(L, rng); if (f.type !== 3) continue; for (const poly of polygons(geomLines(f, toL))) if (!MT || inTownM(poly[0])) md.blds.push(Float32Array.from(poly[0])); } } }
  post({ type: 'maptile', key: z + '/' + x + '/' + y, z, map: md });
}
/* Runde 135: "where am I" for the big map - house numbers and place names (neighbourhood, district, town) from the same vector map
   tiles as the map itself (mostly from the cache already), no extra service. z14: numbers + small places, z12: districts, z10: towns */
async function whereAmI(x, z) {
  if (!tilesUrl || !O) return null; const X = x / O.c + O.X0, Y = -z / O.c + O.Y0, nums = [], places = [];
  for (const zz of [14, 12, 10]) { const n = 1 << zz, tx = Math.floor((X + HALF) / WORLD * n), ty = Math.floor((HALF - Y) / WORLD * n);
    const url = tilesUrl.replace('{z}', zz).replace('{x}', tx).replace('{y}', ty);
    let buf; try { buf = await cget(url); if (!buf) { buf = await (await fetchOk(url)).arrayBuffer(); cput(url, buf); } } catch (e) { continue; }
    const layers = decodeMVT(buf);
    const pt = (L, f) => { const g = f.geom; if ((g[0] & 7) !== 1) return null; const zz2 = v => (v >> 1) ^ (-(v & 1)), ext = L.extent || 4096;
      const PX = (tx + zz2(g[1]) / ext) / n * WORLD - HALF, PY = HALF - (ty + zz2(g[2]) / ext) / n * WORLD; return [lx(PX), lz(PY)]; };
    if (zz === 14 && layers.housenumber) { const L = layers.housenumber; for (const r of L.feats) { const f = readFeature(L, r); const p = f.type === 1 && pt(L, f); if (p && f.props.housenumber) nums.push([p[0], p[1], String(f.props.housenumber)]); } }
    const L = layers.place; if (L) for (const r of L.feats) { const f = readFeature(L, r), nm = f.props['name:de'] || f.props.name_de || f.props.name; const p = f.type === 1 && nm && pt(L, f); if (p) places.push([p[0], p[1], f.props.class || '', nm]); } }
  return { nums, places };
}
/* Runde 140: saved routes (orte.js) - the autopilot's way of finding streets (A* over the street lines, one-ways, motorways
   preferred, service ways avoided), but over the z14 street tiles along the whole leg instead of only the loaded map. The result
   is the street line itself, simplified (every bend kept): many waypoints that lie on the street - the autopilot then only has
   to follow them. Tiles come from the same cache as the map. */
const RT_W = { motorway: 12, trunk: 10, primary: 9, secondary: 8, tertiary: 7, minor: 6, service: 3.6, busway: 6 }, rtLines = new Map();
async function rtTile(tx, ty) {
  const key = tx + '/' + ty; if (rtLines.has(key)) return rtLines.get(key);
  const url = tilesUrl.replace('{z}', 14).replace('{x}', tx).replace('{y}', ty), n = 1 << 14, out = [];
  try { let buf = await cget(url); if (!buf) { buf = await (await fetchOk(url)).arrayBuffer(); cput(url, buf); }
    const L = decodeMVT(buf).transportation;
    if (L) { const ext = L.extent || 4096, toL = (x, y) => { const X = (tx + x / ext) / n * WORLD - HALF, Y = HALF - (ty + y / ext) / n * WORLD; return [lx(X), lz(Y)]; };
      for (const r of L.feats) { const f = readFeature(L, r), w = RT_W[f.props.class]; if (f.type !== 2 || !w || f.props.access === 'no') continue;
        for (const line of geomLines(f, toL)) out.push({ p: line, w: f.props.class === 'motorway' ? 1012 : w, o: +f.props.oneway || 0 }); } }
  } catch (e) { out.err = 1; }
  if (rtLines.size > 400) rtLines.clear(); if (!out.err) rtLines.set(key, out); return out;
}
async function planLeg(ax, az, bx, bz) {
  const n = 1 << 14, T = (x, z) => { const X = x / O.c + O.X0, Y = -z / O.c + O.Y0; return [(X + HALF) / WORLD * n, (HALF - Y) / WORLD * n]; };
  const A = T(ax, az), B = T(bx, bz), len = Math.hypot(B[0] - A[0], B[1] - A[1]), pad = 1 + Math.min(2.5, len * .15), want = [];
  for (let tx = Math.floor(Math.min(A[0], B[0]) - pad); tx <= Math.floor(Math.max(A[0], B[0]) + pad); tx++)
    for (let ty = Math.floor(Math.min(A[1], B[1]) - pad); ty <= Math.floor(Math.max(A[1], B[1]) + pad); ty++) {
      const cx = tx + .5, cy = ty + .5, dx = B[0] - A[0], dy = B[1] - A[1], t = len ? Math.max(0, Math.min(1, ((cx - A[0]) * dx + (cy - A[1]) * dy) / (len * len))) : 0;
      if (Math.hypot(A[0] + dx * t - cx, A[1] + dy * t - cy) <= pad + .2) want.push([tx, ty]); }
  if (want.length > 260) return { err: 'weit' };
  const lines = []; for (let i = 0; i < want.length; i += 8) { const got = await Promise.all(want.slice(i, i + 8).map(([x, y]) => rtTile(x, y))); for (const g of got) for (const l of g) lines.push(l); }
  // graph: line corners closer than 2.5 m are one node (the same corner in two neighbouring tiles), one-ways only along
  const xs = [], zs = [], adj = [], cell = new Map();
  const nodeAt = (x, z) => { const cx = Math.floor(x / 4), cz = Math.floor(z / 4);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = cell.get((cx + a) * 100003 + cz + b); if (l) for (const k of l) if ((xs[k] - x) ** 2 + (zs[k] - z) ** 2 < 6.25) return k; }
    const k = xs.length; xs.push(x); zs.push(z); adj.push([]); const key = cx * 100003 + cz; let l = cell.get(key); if (!l) cell.set(key, l = []); l.push(k); return k; };
  const segs = []; // a, b (b ahead on a one-way), weight, one-way
  for (const r of lines) { let prev = -1; for (let i = 0; i < r.p.length; i += 2) { const k = nodeAt(r.p[i], r.p[i + 1]);
    if (prev >= 0 && prev !== k) { const d = Math.hypot(xs[k] - xs[prev], zs[k] - zs[prev]); if (r.o >= 0) adj[prev].push(k, d, r.w); if (r.o <= 0) adj[k].push(prev, d, r.w); segs.push(r.o < 0 ? k : prev, r.o < 0 ? prev : k, r.w, r.o ? 1 : 0); }
    prev = k; } }
  const SC = 24, sg = new Map();
  for (let i = 0; i < segs.length; i += 4) { const a = segs[i], b = segs[i + 1];
    for (let cx = Math.floor((Math.min(xs[a], xs[b]) - 6) / SC); cx <= Math.floor((Math.max(xs[a], xs[b]) + 6) / SC); cx++) for (let cz = Math.floor((Math.min(zs[a], zs[b]) - 6) / SC); cz <= Math.floor((Math.max(zs[a], zs[b]) + 6) / SC); cz++) { const key = cx * 100003 + cz; let l = sg.get(key); if (!l) sg.set(key, l = []); l.push(i); } }
  const deg = new Uint16Array(xs.length); for (let i = 0; i < segs.length; i += 4) { deg[segs[i]]++; deg[segs[i + 1]]++; }
  const near = (x, z, R, skip) => { let best = -1, bd = R * R, bt = 0; const cx = Math.floor(x / SC), cz = Math.floor(z / SC), m = Math.ceil(R / SC);
    for (let u = -m; u <= m; u++) for (let v = -m; v <= m; v++) { const l = sg.get((cx + u) * 100003 + cz + v); if (l) for (const i of l) { const a = segs[i], b = segs[i + 1]; if (skip && skip(a, b)) continue;
      const dx = xs[b] - xs[a], dz = zs[b] - zs[a], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - xs[a]) * dx + (z - zs[a]) * dz) / L2)), d = (xs[a] + dx * t - x) ** 2 + (zs[a] + dz * t - z) ** 2;
      if (d < bd) { bd = d; best = i; bt = t; } } }
    return best < 0 ? null : [best, bt, Math.sqrt(bd)]; };
  const split = (i, t) => { const a = segs[i], b = segs[i + 1], w = segs[i + 2], k = xs.length; xs.push(xs[a] + (xs[b] - xs[a]) * t); zs.push(zs[a] + (zs[b] - zs[a]) * t); adj.push([]);
    const da = Math.hypot(xs[k] - xs[a], zs[k] - zs[a]), db = Math.hypot(xs[k] - xs[b], zs[k] - zs[b]);
    adj[a].push(k, da, w); adj[k].push(b, db, w); if (!segs[i + 3]) { adj[k].push(a, da, w); adj[b].push(k, db, w); } return k; };
  // dead ends (lines cut at the tile edge, T-junctions without a shared corner) join the nearest other street within 6 m
  for (let k = 0; k < deg.length; k++) { if (deg[k] !== 1) continue; const hit = near(xs[k], zs[k], 6, (a, b) => a === k || b === k); if (!hit) continue;
    const w = segs[hit[0] + 2]; if (w >= 1000) continue; const m = split(hit[0], hit[1]), d = Math.hypot(xs[m] - xs[k], zs[m] - zs[k]); adj[m].push(k, d, w); adj[k].push(m, d, w); }
  // start and goal hang on up to 5 nearby streets (the nearest may be a closed-off way or the wrong carriageway): a virtual node joins
  // them, farther streets cost three times their distance - the search takes the nearest one that leads somewhere
  const attach = (x, z, out) => { const found = []; for (let k = 0; k < 5; k++) { const hit = near(x, z, 400, (a, b) => { for (let i = 0; i < found.length; i += 3) if (segs[found[i]] === a && segs[found[i] + 1] === b) return true; return false; }); if (!hit || (k && hit[2] > found.d0 + 120)) break; if (!k) found.d0 = hit[2]; found.push(hit[0]); found.push(hit[1], hit[2]); }
    if (!found.length) return -1; const v = xs.length; xs.push(x); zs.push(z); adj.push([]);
    for (let i = 0; i < found.length; i += 3) { const m = split(found[i], found[i + 1]), c = found[i + 2] * 3 + .1; if (out) adj[v].push(m, c, 6); else adj[m].push(v, c, 6); } return v; };
  const s = attach(ax, az, true), t = attach(bx, bz, false); if (s < 0 || t < 0) return { err: 'abseits', which: s < 0 ? 0 : 1 };
  // A* (cost like the autopilot: motorways fast, service ways slow)
  const N = xs.length, g = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N), hk = [], hf = [];
  const push = (k, f) => { hk.push(k); hf.push(f); let i = hk.length - 1; while (i) { const p = (i - 1) >> 1; if (hf[p] <= hf[i]) break; [hf[p], hf[i]] = [hf[i], hf[p]]; [hk[p], hk[i]] = [hk[i], hk[p]]; i = p; } };
  const pop = () => { const top = hk[0], lk = hk.pop(), lf = hf.pop(); if (hk.length) { hk[0] = lk; hf[0] = lf; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < hk.length && hf[l] < hf[m]) m = l; if (r < hk.length && hf[r] < hf[m]) m = r; if (m === i) break; [hf[m], hf[i]] = [hf[i], hf[m]]; [hk[m], hk[i]] = [hk[i], hk[m]]; i = m; } } return top; };
  const H = k => Math.hypot(xs[k] - xs[t], zs[k] - zs[t]) * .55;
  g[s] = 0; push(s, H(s));
  while (hk.length) { const k = pop(); if (done[k]) continue; done[k] = 1; if (k === t) break; const a = adj[k];
    for (let j = 0; j < a.length; j += 3) { const m = a[j], w = a[j + 2], ng = g[k] + a[j + 1] * (w >= 1000 ? .55 : w < 4 ? 1.6 : 1); if (ng < g[m]) { g[m] = ng; from[m] = k; push(m, ng + H(m)); } } }
  if (!done[t]) return { err: 'keinweg' };
  const path = []; for (let k = t; k >= 0; k = from[k]) if (k !== s && k !== t) path.push(xs[k], zs[k]); /* without the two virtual end nodes */ const P = []; for (let i = path.length - 2; i >= 0; i -= 2) P.push(path[i], path[i + 1]);
  return { p: P };
}
function dpSimplify(p, eps) { // Douglas-Peucker on [x, z, ...]: keeps every bend
  const n = p.length / 2; if (n < 3) return p.slice(); const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const st = [[0, n - 1]];
  while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; const ax = p[a * 2], az = p[a * 2 + 1], dx = p[b * 2] - ax, dz = p[b * 2 + 1] - az, L = Math.hypot(dx, dz) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((p[i * 2] - ax) * dz - (p[i * 2 + 1] - az) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  const o = []; for (let i = 0; i < n; i++) if (keep[i]) o.push(p[i * 2], p[i * 2 + 1]); return o; }
async function planRoute(via) { // via: [[x, z], ...] -> { pts: [[lat, lon, via index or -1]], km } or { err, leg }
  if (!tilesUrl || !O) return { err: 'nochnicht', leg: 0 };
  const pts = []; let km = 0;
  for (let i = 0; i + 1 < via.length; i++) { const r = await planLeg(via[i][0], via[i][1], via[i + 1][0], via[i + 1][1]); if (r.err) return { err: r.err, leg: i, which: r.which };
    const q = dpSimplify(r.p, 6); for (let k = 2; k < q.length; k += 2) km += Math.hypot(q[k] - q[k - 2], q[k + 1] - q[k - 1]) / 1000;
    for (let k = i ? 2 : 0; k < q.length; k += 2) { const ll = toLatLon(q[k], q[k + 1]); pts.push([+ll[0].toFixed(5), +ll[1].toFixed(5), k === 0 ? i : k === q.length - 2 ? i + 1 : -1]); } }
  return { pts, km };
}
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'dbg') { (async () => { let r; try { r = await eval(m.code); } catch (er) { r = String(er); } post({ type: 'dbg', r: JSON.stringify(r) }); })(); return; } // debug hook for test tools (werkzeuge/)
  if (m.type === 'route') { planRoute(m.via).then(r => post({ type: 'route', id: m.id, r }), er => post({ type: 'route', id: m.id, r: { err: 'fehler', msg: String(er), leg: 0 } })); return; }
  if (m.type === 'wo') { whereAmI(m.x, m.z).then(r => post({ type: 'wo', id: m.id, r }), () => post({ type: 'wo', id: m.id, r: null })); return; }
  if (m.type === 'maptile') { mapTile(m.z, m.x, m.y).catch(err => post({ type: 'maptile', key: m.z + '/' + m.x + '/' + m.y, z: m.z, map: null })); return; }
  if (m.type === 'init') { WELT = /^(west|cyber|mittel)$/.test(m.welt) ? m.welt : 'heute'; TERRAIN_ON = !!m.terrain; WELD = !!m.weld; LEVEL_DZ = m.eben !== false; STR_ON = m.breiten !== false; self.NOREPRIO = m.reprio === false; self.KERBOFF = m.kerboff === true; MERGE = m.verbinden !== false;
    { const v = Math.max(1, Math.min(3, m.view || 1)) - 1; MVT_RADIUS = [750, 1100, 1500][v]; MVT_DROP = [2600, 3000, 3400][v]; L2_RADIUS = WELT === 'heute' ? [450, 700, 950][v] : 0; L2_DROP = [1000, 1350, 1700][v]; } /* view distance setting */ const o = merc(m.lat, m.lon); O = { X0: o.X, Y0: o.Y, c: Math.cos(m.lat * Math.PI / 180) }; pos = { X: o.X, Y: o.Y }; update(); }
  else if (m.type === 'pos' && O) { pos = { X: m.x / O.c + O.X0, Y: -m.z / O.c + O.Y0, AX: (m.x + Math.max(-700, Math.min(700, (m.vx || 0) * 8))) / O.c + O.X0, AY: -(m.z + Math.max(-700, Math.min(700, (m.vz || 0) * 8))) / O.c + O.Y0 }; update(); } // AX/AY: where the player will be in ~8 s (Runde 56: load ahead at speed)
  else if (m.type === 'prefetch') { // warm the cache while the player is still in the profile screen
    TERRAIN_ON = !!m.terrain; WELD = !!m.weld;
    const o = merc(m.lat, m.lon); if (!O) { O = { X0: o.X, Y0: o.Y, c: Math.cos(m.lat * Math.PI / 180) }; pos = { X: o.X, Y: o.Y }; update(); }
  }
};
