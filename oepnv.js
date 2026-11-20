/* HoodExplorer – echter Nahverkehr (Runde 89). Busse, Straßenbahnen, S-Bahnen, Regional- und Fernzüge nach Fahrplan und Echtzeit
   aus Transitous (MOTIS, offene DELFI-Daten, frei und ohne Schlüssel; nicht-kommerziell und sparsam nutzen):
     GET https://api.transitous.org/api/v5/map/trips?min=lat,lon&max=lat,lon&startTime=ISO&endTime=ISO&zoom=16
   liefert jede Fahrt als Abschnitte von Halt zu Halt (Linie, Abfahrt, Ankunft, Echtzeit ja/nein, Streckenverlauf als Polyline).
   - Abfrage in einem eigenen kleinen Worker (Netz + Entpacken der Polylines), das Spiel rechnet nur Positionen.
   - Ausschnitt um die Spielfigur, in Fahrtrichtung vorausgeschoben; neue Abfrage erst, wenn das abgedeckte Gebiet fast verlassen
     ist oder die Daten 75 s alt sind, nie öfter als alle 25 s; eine laufende Abfrage wird verworfen, wenn sie veraltet ist.
   - Ab 80 km/h nur noch Bahnen (Busse sieht man von der Autobahn kaum), Ausschnitt größer.
   - Zwischen den Abfragen: Position aus der Uhrzeit (Abfahrt -> Ankunft entlang des Streckenverlaufs, sanft anfahren und bremsen),
     Halt zwischen zwei Abschnitten = steht an der Haltestelle. Wagen eines Zuges folgen einzeln dem Gleis.
   - Bahnen werden aufs nächste OSM-Gleis gezogen; in Tunneln (U-Bahn, S-Bahn-Stammstrecken) und fern jedes Gleises nicht gezeigt.
   - Solange echte Busse da sind, setzt der simulierte Verkehr keine Linienbusse ein.
   Schalter im Profil: Nahverkehr an/aus, Quelle echt/simuliert, Busse, Bahnen, Züge (Runde 91). */
(() => {
const X = window.HXTR, D = window.HXD;
const O = { on: true, trips: new Map(), items: [], box: null, inFlight: 0, last: 0, live: false, reqId: 0, railVer: -1, rail: new Map(),
  stats: { req: 0, kb: 0, err: 0, segs: 0, shown: 0, hidden: 0, ms: 0, msN: 0, msAvg: 0, modes: {} } };
/* Runde 91: settings - Nahverkehr an/aus, Quelle (echt = Transitous | sim = nur simuliert, kein Netz), Busse / Bahnen / Züge einzeln.
   Busse: BUS, COACH; Bahnen: TRAM, SUBWAY (U-/Stadtbahn), SUBURBAN (S-Bahn); Züge: Regional- und Fernverkehr.
   URL: ?oepnv=0 aus, ?oepnv=sim nur simuliert, ?oepnv=echt */
O.src = 'echt'; O.bus = true; O.bahn = true; O.zug = true;
try { const j = JSON.parse(localStorage.getItem('hx.oepnv2') || 'null'); if (j) Object.assign(O, { on: j.on !== false, src: j.src === 'sim' ? 'sim' : 'echt', bus: j.bus !== false, bahn: j.bahn !== false, zug: j.zug !== false });
  else if (localStorage.getItem('hx.oepnv') === 'false') O.on = false; } catch (e) {}
if (/^(west|mittel)$/.test(window.HX_WELT)) O.on = false; // Runde 93: no buses and trains in these worlds
{ const m = /[?&]oepnv=(\w+)/.exec(location.search); if (m) { if (m[1] === '0') O.on = false; else { O.on = true; if (m[1] === 'sim' || m[1] === 'echt') O.src = m[1]; } } }
const CAT = mode => /BUS|COACH/.test(mode) ? 'bus' : /TRAM|SUBWAY|SUBURBAN/.test(mode) ? 'bahn' : 'zug';
const want = mode => O.on && O[CAT(mode)];
const API = 'https://api.transitous.org/api/v5/map/trips';

// worker: fetch + JSON + polyline decoding off the main thread
const wsrc = `onmessage = async e => { const { url, id } = e.data;
  const dec = s => { let i = 0, la = 0, lo = 0; const o = []; while (i < s.length) { for (let k = 0; k < 2; k++) { let sh = 0, r = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32); const v = r & 1 ? ~(r >> 1) : r >> 1; if (k) lo += v; else la += v; } o.push(la / 1e5, lo / 1e5); } return o; };
  try { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(), d = JSON.parse(t);
    const out = d.map(s => ({ id: s.trips[0].tripId, name: s.trips[0].displayName || s.trips[0].routeShortName || '', mode: s.mode, dep: Date.parse(s.departure), arr: Date.parse(s.arrival), rt: !!s.realTime, pts: dec(s.polyline || '') }));
    postMessage({ id, out, bytes: t.length }); } catch (err) { postMessage({ id, err: String(err) }); } };`;
let W = null;
function worker() { if (!W) { // Runde 120: the ?ausfall= test switch reaches this worker too
    const aus = window.HX_AUSFALL ? 'self.HX_AUSFALL_Q = ' + JSON.stringify(new URLSearchParams(location.search).get('ausfall')) + '; importScripts(' + JSON.stringify(new URL('ausfall.js', location.href).href) + ');' : '';
    W = new Worker(URL.createObjectURL(new Blob([aus + wsrc], { type: 'text/javascript' }))); W.onmessage = onData; } return W; }

// train make-up per mode: [variant id, length, reversed]
const CARS = {
  TRAM: [['tramEnd', 11], ['tramMid', 9], ['tramEnd', 11, 1]], SUBURBAN: [['sEnd', 16], ['sMid', 16], ['sEnd', 16, 1]],
  REGIONAL_RAIL: [['reEnd', 17], ['reEnd', 17, 1]], REGIONAL_FAST_RAIL: [['reEnd', 17], ['reMid', 17], ['reEnd', 17, 1]],
  LONG_DISTANCE: [['feEnd', 21], ['feMid', 25], ['feMid', 25], ['feMid', 25], ['feEnd', 21, 1]], HIGHSPEED_RAIL: [['feEnd', 21], ['feMid', 25], ['feMid', 25], ['feMid', 25], ['feEnd', 21, 1]],
  NIGHT_RAIL: [['feEnd', 21], ['feMid', 25], ['feMid', 25], ['feEnd', 21, 1]], RAIL: [['reEnd', 17], ['reEnd', 17, 1]],
  SUBWAY: [['uEnd', 13], ['uMid', 13], ['uEnd', 13, 1]], // U-Bahn and Stadtbahn: only where they run above ground (tunnels hidden)
  BUS: [['stadtbus', 12]], COACH: [['reisebus', 12]]
};
const RAILM = /RAIL|TRAM|SUBURBAN|SUBWAY/;
let IDX = null;
function idx() { if (!IDX) { IDX = {}; for (const k in CARS) for (const [id] of CARS[k]) IDX[id] = window.HXFZ.index(id); IDX.gelenkbus = window.HXFZ.index('gelenkbus'); } return IDX; }

function request(px, pz, vx, vz) {
  const sp = Math.hypot(vx, vz), fast = sp > 22, half = fast ? 1800 : 1100, look = Math.min(900, sp * 30);
  const cx = px + (sp > 1 ? vx / sp * look : 0), cz = pz + (sp > 1 ? vz / sp * look : 0);
  const ll0 = D.toLatLon(cx - half, cz + half), ll1 = D.toLatLon(cx + half, cz - half); // south-west / north-east (z grows to the south)
  const t0 = new Date(Date.now() - 60000), t1 = new Date(Date.now() + 180000);
  const url = API + '?min=' + Math.min(ll0[0], ll1[0]).toFixed(5) + ',' + Math.min(ll0[1], ll1[1]).toFixed(5) + '&max=' + Math.max(ll0[0], ll1[0]).toFixed(5) + ',' + Math.max(ll0[1], ll1[1]).toFixed(5) +
    '&startTime=' + t0.toISOString().replace(/\.\d+Z$/, 'Z') + '&endTime=' + t1.toISOString().replace(/\.\d+Z$/, 'Z') + '&zoom=16';
  O.box = { cx, cz, half, fast, t: Date.now() }; O.inFlight = ++O.reqId; O.last = Date.now(); O.stats.req++;
  worker().postMessage({ url, id: O.reqId });
}
function onData(e) {
  const m = e.data; if (m.id === O.inFlight) O.inFlight = 0;
  if (m.err) { O.stats.err++; return; }
  O.stats.kb += m.bytes / 1024; const fast = O.box && O.box.fast;
  for (const s of m.out) {
    if (!CARS[s.mode] || s.pts.length < 4 || !(s.arr > s.dep - 1)) continue; if (fast && !RAILM.test(s.mode)) continue;
    let tr = O.trips.get(s.id); if (!tr) O.trips.set(s.id, tr = { mode: s.mode, name: s.name, segs: [], path: null, k: (s.name.charCodeAt(0) || 0) + s.name.length });
    if (tr.segs.some(q => q.dep === s.dep)) { const q = tr.segs.find(q => q.dep === s.dep); q.arr = s.arr; continue; } // newer times (realtime) win
    const P = []; for (let i = 0; i < s.pts.length; i += 2) { const p = D.toLocal(s.pts[i], s.pts[i + 1]); P.push(p.x, p.z); }
    tr.segs.push({ dep: s.dep, arr: s.arr, P }); tr.path = null; O.stats.segs++; O.stats.modes[s.mode] = (O.stats.modes[s.mode] || 0) + 1;
  }
  O.live = O.trips.size > 0;
}
// one path per trip: all its segments in order; stops are where segments meet
/* Runde 89 (Hamburg Hbf: the timetable lines of ICE and S-Bahn lay 20-60 m beside the OSM tracks, partly over the city tunnel):
   every point of a rail line is pulled onto the nearest track within 35 m; on a tunnel track or with no track near it, nothing is drawn */
function snap(x, z) {
  let best = null, bd = 35; const ix = Math.floor(x / 16), iz = Math.floor(z / 16);
  for (let u = -2; u <= 2; u++) for (let v = -2; v <= 2; v++) for (const g of O.rail.get((ix + u) * 100003 + iz + v) || []) {
    const ex = g[2] - g[0], ez = g[3] - g[1], L2 = ex * ex + ez * ez || 1, q = Math.max(0, Math.min(1, ((x - g[0]) * ex + (z - g[1]) * ez) / L2)), px = g[0] + ex * q, pz = g[1] + ez * q, d = Math.hypot(px - x, pz - z);
    if (d < bd) { bd = d; best = [px, pz, g[4]]; } }
  return best;
}
function path(tr) {
  tr.segs.sort((a, b) => a.dep - b.dep); const x = [], z = [], f = [], st = [], rail = RAILM.test(tr.mode);
  for (const g of tr.segs) { const P = g.P; let i0 = null;
    for (let i = 0; i < P.length; i += 2) { let px = P[i], pz = P[i + 1], hide = 0;
      if (rail) { const sn = snap(px, pz); if (!sn) hide = 1; else { px = sn[0]; pz = sn[1]; hide = sn[2]; } }
      const n = x.length; if (n && Math.hypot(px - x[n - 1], pz - z[n - 1]) < .05) { if (i0 === null) i0 = n - 1; continue; }
      x.push(px); z.push(pz); f.push(hide); if (i0 === null) i0 = x.length - 1; }
    st.push({ i0: i0 === null ? x.length - 1 : i0, i1: x.length - 1, dep: g.dep, arr: g.arr }); }
  const cum = [0]; for (let i = 1; i < x.length; i++) cum.push(cum[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]));
  for (const q of st) { q.s0 = cum[Math.max(0, q.i0)] || 0; q.s1 = cum[Math.max(0, q.i1)] || 0; }
  tr.path = { x, z, f, cum, st, L: cum[cum.length - 1] || 0, ver: O.railVer };
}
function at(p, s) { // point and direction on the path at length s (straight on beyond the ends)
  const c = p.cum, n = c.length; if (n < 2) return [p.x[0], p.z[0], 0, 1];
  let i; if (s <= 0) i = 1; else if (s >= c[n - 1]) i = n - 1; else { let lo = 1, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < s) lo = m + 1; else hi = m; } i = lo; }
  const sl = c[i] - c[i - 1] || 1, f = (s - c[i - 1]) / sl, dx = (p.x[i] - p.x[i - 1]) / sl, dz = (p.z[i] - p.z[i - 1]) / sl;
  return [p.x[i - 1] + (p.x[i] - p.x[i - 1]) * f, p.z[i - 1] + (p.z[i] - p.z[i - 1]) * f, dx, dz, p.f ? (p.f[i - 1] || p.f[i]) : 0];
}
const ease = f => f * f * (3 - 2 * f);
function headS(p, t) { // front of the vehicle along the path at time t, or null when not under way here
  const st = p.st; if (!st.length) return null;
  if (t < st[0].dep - 40000 || t > st[st.length - 1].arr + 25000) return null;
  if (t <= st[0].dep) return st[0].s0;
  for (let i = 0; i < st.length; i++) { const q = st[i];
    if (t <= q.arr) { const f = q.arr > q.dep ? Math.max(0, Math.min(1, (t - q.dep) / (q.arr - q.dep))) : 1; return q.s0 + (q.s1 - q.s0) * ease(f); }
    if (i + 1 < st.length && t < st[i + 1].dep) return q.s1; }               // waiting at the stop
  return st[st.length - 1].s1;
}
function railRebuild() { // tracks of the loaded tiles in a 16 m grid: [x0, z0, x1, z1, 0 surface | 1 tunnel]
  O.rail.clear(); O.railVer = X.TILEVER;
  for (const t of X.tiles.values()) for (const r of t.roads || []) { const tun = r.k === 't' && r.rail; if (r.k !== 'r' && !tun) continue; const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) { const g = [p[i], p[i + 1], p[i + 2], p[i + 3], tun ? 1 : 0], n = Math.max(1, Math.ceil(Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / 8)), ks = new Set();
      for (let k = 0; k <= n; k++) ks.add(Math.floor((p[i] + (p[i + 2] - p[i]) * k / n) / 16) * 100003 + Math.floor((p[i + 1] + (p[i + 3] - p[i + 1]) * k / n) / 16));
      for (const k of ks) { let l = O.rail.get(k); if (!l) O.rail.set(k, l = []); l.push(g); } } }
}
/* ---- simulated trams, U-/S-Bahnen and trains on the OSM tracks (source "nur simuliert", Runde 91) ----
   A train starts on a track 150-450 m from the player, runs along connected tracks (straight on at junctions) and is removed at the
   end of its line or 900 m away. Trams on tram tracks, U-Bahn on U-/Stadtbahn tracks, S-Bahn / regional / long-distance trains on
   main lines (no sidings, no bridges, no tunnels). */
const SIM = { lines: [], ends: new Map(), ver: -1, list: [], seq: 0 };
function simLines() {
  SIM.ver = X.TILEVER; SIM.lines = []; SIM.ends.clear(); const seen = new Set();
  for (const t of X.tiles.values()) for (const r of t.roads || []) { if (r.k !== 'r' || !r.rk || r.rk === 4) continue; const p = r.p; if (p.length < 4) continue;
    const id = p[0].toFixed(1) + ',' + p[1].toFixed(1) + ',' + p[p.length - 2].toFixed(1); if (seen.has(id)) continue; seen.add(id);
    const L = { p, rk: r.rk, i: SIM.lines.length }; SIM.lines.push(L);
    for (const e of [0, 1]) { const x = e ? p[p.length - 2] : p[0], z = e ? p[p.length - 1] : p[1], k = Math.round(x / 3) * 100003 + Math.round(z / 3); let a = SIM.ends.get(k); if (!a) SIM.ends.set(k, a = []); a.push([L, e]); } }
}
function simNext(x, z, dx, dz, rk, used) { // the line that goes on straightest from (x, z) in direction (dx, dz)
  let best = null, bc = .6;
  for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) for (const [L, e] of SIM.ends.get((Math.round(x / 3) + u) * 100003 + Math.round(z / 3) + v) || []) {
    if (used.has(L.i) || (L.rk === 1) !== (rk === 1)) continue; const p = L.p, n = p.length;
    const sx = e ? p[n - 2] : p[0], sz = e ? p[n - 1] : p[1]; if (Math.hypot(sx - x, sz - z) > 3) continue;
    const nx = e ? p[n - 4] - p[n - 2] : p[2] - p[0], nz = e ? p[n - 3] - p[n - 1] : p[3] - p[1], c = (nx * dx + nz * dz) / (Math.hypot(nx, nz) * Math.hypot(dx, dz) || 1);
    if (c > bc) { bc = c; best = [L, e]; } }
  return best;
}
function simPath(L0, fwd) { // chained points: up to 250 m behind the start line, up to 2.5 km ahead
  const used = new Set([L0.i]), arr = []; const p = L0.p; for (let i = 0; i < p.length; i += 2) arr.push([p[i], p[i + 1]]); if (!fwd) arr.reverse();
  const grow = (list, ahead, limit) => { let len = 0; for (let i = 1; i < list.length; i++) len += Math.hypot(list[i][0] - list[i - 1][0], list[i][1] - list[i - 1][1]);
    for (let g = 0; g < 40 && len < limit; g++) { const a = ahead ? list[list.length - 1] : list[0], b = ahead ? list[list.length - 2] : list[1]; if (!b) break;
      const nx = simNext(a[0], a[1], a[0] - b[0], a[1] - b[1], L0.rk, used); if (!nx) break; const [L, e] = nx; used.add(L.i);
      const q = []; for (let i = 0; i < L.p.length; i += 2) q.push([L.p[i], L.p[i + 1]]); if (e) q.reverse(); q.shift();
      for (const pt of q) { const ref = ahead ? list[list.length - 1] : list[0]; len += Math.hypot(pt[0] - ref[0], pt[1] - ref[1]); if (ahead) list.push(pt); else list.unshift(pt); } } };
  grow(arr, true, 2500); const n0 = arr.length; grow(arr, false, 250); const back = arr.length - n0;
  const x = arr.map(q => q[0]), z = arr.map(q => q[1]), cum = [0]; for (let i = 1; i < x.length; i++) cum.push(cum[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]));
  return { x, z, cum, f: null, L: cum[cum.length - 1], s0: cum[back] };
}
function simUpdate(px, pz, dt) {
  if (SIM.ver !== X.TILEVER && (!SIM.at || Date.now() - SIM.at > 3000)) { SIM.at = Date.now(); simLines(); }
  SIM.list = SIM.list.filter(t => t.s < t.p.L - 20 && Math.hypot(t.hx - px, t.hz - pz) < 900 && O[t.cat]);
  const cap = { bahn: 7, zug: 3 }, cnt = { bahn: 0, zug: 0 }; for (const t of SIM.list) cnt[t.cat]++;
  for (let tries = 0; tries < 12; tries++) { if (!SIM.lines.length) break;
    const L = SIM.lines[(Math.random() * SIM.lines.length) | 0], cat = L.rk === 3 ? (O.bahn && (!O.zug || Math.random() < .45) ? 'bahn' : 'zug') : 'bahn';
    if (!O[cat] || cnt[cat] >= cap[cat]) continue; const d = Math.hypot(L.p[0] - px, L.p[1] - pz); if (d < 150 || d > 450) continue;
    const p = simPath(L, Math.random() < .5); if (p.L - p.s0 < 300) continue;
    const mode = L.rk === 1 ? 'TRAM' : L.rk === 2 ? 'SUBWAY' : cat === 'bahn' ? 'SUBURBAN' : Math.random() < .7 ? 'REGIONAL_RAIL' : 'HIGHSPEED_RAIL';
    const v = { TRAM: 8.5, SUBWAY: 12, SUBURBAN: 16, REGIONAL_RAIL: 22, HIGHSPEED_RAIL: 30 }[mode];
    SIM.list.push({ id: 'sim' + (++SIM.seq), p, s: p.s0, v, mode, cat, hx: L.p[0], hz: L.p[1] }); cnt[cat]++; break; }
  for (const t of SIM.list) { t.s += t.v * dt; const h = at(t.p, t.s); t.hx = h[0]; t.hz = h[1]; }
}
const OCC = []; // bus bodies placed this frame: [x, z, dx, dz] every 2 m
function place(items, key, p, s, mode, kseed, now) { // the cars of one vehicle along path p, front at s
  const I = idx(), cars = CARS[mode], rail = RAILM.test(mode); let off = 0, hidden = 0;
  /* Runde 94 (phone test Jahnplatz: two buses of different lines at the same stop stood inside each other): a bus whose body would
     overlap a bus already placed this frame in the same direction queues behind it (12 m steps, at most 72 m back) */
  if (!rail) for (let t = 0; t < 6; t++) { let hit = false; const tot = cars.reduce((a, c) => a + c[1], 0) + (cars[0][0] === 'stadtbus' && kseed % 3 === 0 ? 6 : 0);
    for (let u = 0; u <= tot; u += 4) { const q = at(p, s - u), x = q[0] - q[3] * 1.7, z = q[1] + q[2] * 1.7;
      if (OCC.some(o => Math.hypot(o[0] - x, o[1] - z) < 3.2 && o[2] * q[2] + o[3] * q[3] > .3)) { hit = true; break; } }
    if (!hit) break; s -= 12; }
  if (!rail) { const tot = cars.reduce((a, c) => a + c[1], 0) + 6; for (let u = 0; u <= tot; u += 2) { const q = at(p, s - u); OCC.push([q[0] - q[3] * 1.7, q[1] + q[2] * 1.7, q[2], q[3]]); } }
  for (let k = 0; k < cars.length; k++) { let [vid, len, rev] = cars[k]; if (vid === 'stadtbus' && kseed % 3 === 0) { vid = 'gelenkbus'; len = 18; }
    const sc = s - off - len / 2, q = at(p, sc); off += len + (rail ? .6 : 0);
    if (rail && p.f && (sc < 0 || sc > p.L)) { const sn = snap(q[0], q[1]); if (!sn || sn[2]) q[4] = 1; else { q[0] = sn[0]; q[1] = sn[1]; } } // cars still in the terminus behind the line's start: onto the nearest track
    if (!rail) { q[0] -= q[3] * 1.7; q[1] += q[2] * 1.7; } // buses keep right like the simulated cars (the timetable line runs on the street's centre)
    if (rail && q[4]) { hidden++; continue; } // tunnel or no track here
    const ck = key + ':' + k; let c = O.cache.get(ck); if (!c) O.cache.set(ck, c = { y: undefined, hx: 1e9, hz: 1e9 });
    if (Math.abs(q[0] - c.hx) + Math.abs(q[1] - c.hz) > 1) { c.hx = q[0]; c.hz = q[1]; c.y = X.terrainH(q[0], q[1], c.y === undefined ? undefined : c.y + 1); } c.used = now;
    items.push({ type: I[vid], x: q[0], y: c.y, z: q[1], h: Math.atan2(q[2], q[3]) + (rev ? Math.PI : 0), st: c }); } // st: state of an articulated bus (Runde 140)
  return hidden;
}
function update(px, pz, vx, vz, dt) {
  if (!O.on || !X.P.placed) { O.items = []; O.live = false; SIM.list = []; return; }
  const t0 = performance.now(), now = Date.now(), sp = Math.hypot(vx, vz), items = []; let hidden = 0; OCC.length = 0;
  if (O.railVer !== X.TILEVER && now - (O.railAt || 0) > 3000) { O.railAt = now; railRebuild(); } // tiles changed: new tracks (at most every 3 s)
  if (O.src === 'sim') { O.live = false; O.trips.clear(); simUpdate(px, pz, Math.min(dt || .016, .1));
    for (const t of SIM.list) hidden += place(items, t.id, t.p, t.s, t.mode, t.id.length, now); }
  else { SIM.list = [];
    // when to ask again: the area is nearly used up, the data is old, or we became fast (rail only) / slow again; nothing wanted: no request
    const b = O.box, out = !b || Math.abs(px - b.cx) > b.half * .55 || Math.abs(pz - b.cz) > b.half * .55;
    if ((O.bus || O.bahn || O.zug) && !O.inFlight && now - O.last > 25000 && (out || now - b.t > 75000 || (sp > 22) !== b.fast)) request(px, pz, vx, vz);
    if (O.inFlight && now - O.last > 20000) O.inFlight = 0; // lost answer
    let liveBus = false;
    for (const [id, tr] of O.trips) {
      if (!tr.segs.length || now > tr.segs.reduce((m, q) => Math.max(m, q.arr), 0) + 120000) { O.trips.delete(id); continue; }
      if (!want(tr.mode)) continue; if (CAT(tr.mode) === 'bus') liveBus = true;
      if (!tr.path || (RAILM.test(tr.mode) && tr.path.ver !== O.railVer)) path(tr); const p = tr.path, s = headS(p, now); if (s === null) continue;
      const h = at(p, s); if (Math.hypot(h[0] - px, h[1] - pz) > 600) continue;
      hidden += place(items, id, p, s, tr.mode, tr.k, now); }
    O.live = liveBus;
  }
  if (O.cache.size > 4000) for (const [k, c] of O.cache) if (now - (c.used || 0) > 60000) O.cache.delete(k);
  O.items = items; O.stats.shown = items.length; O.stats.hidden = hidden;
  O.stats.ms += performance.now() - t0; if (++O.stats.msN >= 60) { O.stats.msAvg = O.stats.ms / O.stats.msN; O.stats.ms = 0; O.stats.msN = 0; }
}
O.cache = new Map();
// simulated city buses (traffic.js) only when buses are wanted and no real ones run here
O.simBuses = () => O.on && O.bus && (O.src === 'sim' || !O.live);
// profile controls
(() => { const $ = id => document.getElementById(id), save = () => { try { localStorage.setItem('hx.oepnv2', JSON.stringify({ on: O.on, src: O.src, bus: O.bus, bahn: O.bahn, zug: O.zug })); } catch (x) {} },
    sync = () => { if ($('oepnvOpts')) $('oepnvOpts').classList.toggle('off', !O.on); };
  if ($('tOepnv')) { $('tOepnv').checked = O.on; $('tOepnv').addEventListener('change', e => { O.on = e.target.checked; sync(); save(); }); }
  if ($('tSrcReal')) { $('tSrcReal').checked = O.src === 'echt'; $('tSrcSim').checked = O.src === 'sim'; for (const id of ['tSrcReal', 'tSrcSim']) $(id).addEventListener('change', e => { if (e.target.checked) { O.src = e.target.value; O.box = null; O.last = 0; save(); } }); }
  for (const [id, k] of [['tBus', 'bus'], ['tBahn', 'bahn'], ['tZug', 'zug']]) if ($(id)) { $(id).checked = O[k]; $(id).addEventListener('change', e => { O[k] = e.target.checked; save(); }); }
  sync(); })();
O.sim = SIM;
window.OEPNV = O; window.updateOepnv = update;
})();
