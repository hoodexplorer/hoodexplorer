/* HoodExplorer – Lade-Infofenster (Runde 122). Solange die Welt im Matrix-Stil entsteht, zeigt ein kleines Fenster Prozent,
   Ladebalken, den Schritt, der gerade läuft („Baue Häuser …“), eine Liste aller Schritte mit Zählern und die verstrichene Zeit.
   Alles kommt aus echten Signalen: Nachrichten des Welt-Workers (ground, terrain, bld, lod2, trees, water, status, quelle),
   den Bau-Warteschlangen (JOBQ) und der Bodenabdeckung um die Figur (groundAround) – dieselben Größen, nach denen checkReady
   die Welt freigibt. Bei 100 % (worldReady) blendet es aus.
   Runde 123: zwei Ansichten – Normal (Prozent, Balken, laufender Schritt) und Detail (+ Schrittliste, Zähler, Fußzeile);
   der Knopf rechts oben schaltet um, die Wahl bleibt gespeichert (localStorage hx.ladeinfo = 'detail' | 'normal'). Liest den Bauzustand über window.HXLD (app.js). */
(() => {
  const hud = document.querySelector('.hud'), A = window.HXLD; if (!hud || !A) return;
  const { loaded, JOBQ, TER, MX_COL, store, TERRAIN } = A, groundAround = A.groundAround;
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // key, list label, sentence while running, weight in %
  const STEPS = [['netz', 'Verbindung', 'Verbinde mit dem Kartendienst', 8], ['gel', 'Gelände', 'Forme das Gelände', 10],
    ['str', 'Straßen', 'Ziehe Straßen und Wege', 26], ['hs', 'Häuser', 'Baue Häuser', 30], ['bm', 'Bäume', 'Pflanze Bäume', 8],
    ['vk', 'Verkehr', 'Lasse den Verkehr los', 6], ['fs', 'Feinschliff', 'Setze Licht und Feinschliff', 12]];
  const S = {}; for (const [k] of STEPS) S[k] = { s: 0, p: 0 }; // s: 0 waiting, 1 running, 2 done
  const KEYS = new Set(), N = { osm: 0, l2: 0, roads: 0, houses: 0, tiles: 0, trees: 0, water: 0, open: 0 }, SHOWN = { roads: 0, houses: 0, tiles: 0, trees: 0 };
  let t0 = 0, shown = 0, max0 = 1, max1 = 1, cov = 0, covT = 0, now = '', typed = 0, typeT = 0, phase = 'aus', outT = 0, note = '', noteT = 0;

  hud.insertAdjacentHTML('beforeend', `<div class="li glass" id="li" hidden>
    <div class="li-hd"><span class="li-t">Welt wird gebaut</span><span class="li-pc"><b id="liPc">0</b><small>%</small></span><button class="li-tg" id="liTg" type="button" aria-controls="liMore" aria-expanded="false" aria-label="Details zeigen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></div>
    <div class="li-bar" id="liBar" role="progressbar" aria-label="Ladefortschritt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="liFill"></i></div>
    <div class="li-now"><span class="li-ar" aria-hidden="true">›</span><span id="liNow"></span><span class="li-cur" aria-hidden="true"></span></div>
    <span class="li-sr" id="liSr" aria-live="polite"></span>
    <div class="li-more" id="liMore"><div>
    <ul class="li-steps">${STEPS.map(([k, l]) => `<li data-k="${k}"><i class="li-ic" aria-hidden="true"></i><span>${l}</span><em id="liC_${k}"></em></li>`).join('')}</ul>
    <div class="li-ft"><span id="liFt">warte auf Daten …</span><span id="liTime">0:00</span></div>
    </div></div>
    <div class="li-note" id="liNote" hidden></div></div>`);
  const el = id => document.getElementById(id), box = el('li'), fill = el('liFill'), pc = el('liPc'), nowEl = el('liNow'), rows = {};
  for (const li of box.querySelectorAll('[data-k]')) rows[li.dataset.k] = li;
  function view(d, save) { box.classList.toggle('det', d); const b = el('liTg'); b.setAttribute('aria-expanded', d); b.setAttribute('aria-label', d ? 'Weniger zeigen' : 'Details zeigen'); b.title = d ? 'Weniger zeigen' : 'Details zeigen'; el('liMore').inert = !d;
    if (save) try { localStorage.setItem('hx.ladeinfo', d ? 'detail' : 'normal'); } catch (e) {} }
  { let v = null; try { v = localStorage.getItem('hx.ladeinfo'); } catch (e) {} view(v === 'detail', false); }
  el('liTg').addEventListener('click', () => view(!box.classList.contains('det'), true));

  function colours() { // the panel takes the colour of the chosen Matrix rain
    const c = MX_COL[store.get('hx.mxColor') || 'gruen'];
    box.classList.toggle('rb', c === null); const a = c ? c[0] : '#7dff9a', b = c ? c[1] : '#00c853';
    box.style.setProperty('--mxa', a); box.style.setProperty('--mxb', b);
    const n = parseInt(b.slice(1), 16); box.style.setProperty('--mxg', `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},.35)`); }
  const count = c => { let k = 0; for (let i = 0; c && i < c.length; k++) i += 3 + c[i] * 2; return k; }; // entries in a collide array
  const roadLen = rs => { let L = 0; for (const r of rs || []) { const p = r.p; if (r.k === 'r' || r.k === 'p' || r.k === 't' || !p) continue; for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); } return L; }; // metres of carriageways (no footpaths, rails, tracks)
  const set = (k, s, p) => { const o = S[k]; if (s > o.s) o.s = s; if (p !== undefined) o.p = Math.max(o.p, Math.min(1, p)); };

  // ---- worker messages (called from onData in app.js)
  function msg(m) {
    if (phase === 'aus' || phase === 'weg') return;
    if (m.type === 'quelle') { if (!m.ok && !loaded.ground) S.netz.s = 1; return; } // map service down: connecting again, not done
    if (/^(ground|terrain|bld|lod2|trees|water)$/.test(m.type)) set('netz', 2); // only real data count as connected
    if (m.type === 'ground') { const seen = KEYS.has(m.key); KEYS.add(m.key); if (!seen) { N.tiles++; N.roads += roadLen(m.map && m.map.roads); N.osm += count(m.collide); } // a tile sent again (rebuilt) is not counted twice
      N.houses = Math.max(N.osm, N.l2); set('str', 1); if (N.houses) set('hs', 1);
      if (m.cars && m.cars.length) { N.cars = (N.cars || 0) + 1; set('vk', 1, N.cars / 3); } }
    else if (m.type === 'terrain') set('gel', 1, TER.tiles.size / 6);
    else if (m.type === 'bld') set('hs', 1);
    else if (m.type === 'lod2') { N.l2 += count(m.collide); N.houses = Math.max(N.osm, N.l2); set('hs', 1); } // LoD2 and OSM describe the same houses: take the larger count, not the sum
    else if (m.type === 'trees') { N.trees++; set('bm', 1, N.trees / 4); }
    else if (m.type === 'water') N.water++;
    else if (m.type === 'status') N.open = m.loading || 0;
  }
  // ---- short notes in the panel instead of a toast in the middle of the screen (map service down, slow data)
  function noteSet(t) { if (phase !== 'an') return false; note = t; noteT = performance.now(); const n = el('liNote'); n.textContent = t; n.hidden = false; n.classList.remove('pop'); void n.offsetWidth; n.classList.add('pop'); return true; }

  function current() { // the step shown as sentence: first running one, else first waiting one
    for (const [k, , v] of STEPS) if (S[k].s === 1) return [k, v];
    for (const [k, , v] of STEPS) if (S[k].s === 0) return [k, v];
    return ['', 'Fertig – viel Spaß!']; }
  const fmtN = n => Math.round(n).toLocaleString('de-DE'), fmtKm = m => (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';

  function tick(t) {
    requestAnimationFrame(tick);
    if (phase === 'aus') { if (A.started && !A.worldReady) { phase = 'an'; t0 = t; colours(); box.hidden = false; requestAnimationFrame(() => box.classList.add('on')); set('netz', 1); if (!TERRAIN) set('gel', 2); } else return; }
    if (phase === 'weg') return;
    const dt = Math.min(.1, (t - (tick.l || t)) / 1000); tick.l = t;
    // ---- progress of the steps from the real build state
    max0 = Math.max(max0, JOBQ[0].length); max1 = Math.max(max1, JOBQ[1].length);
    if (t - covT > 300 && loaded.ground) { covT = t; cov = groundAround(100) / 9; }
    if (loaded.ground) set('str', 1, cov * .75 + (1 - JOBQ[0].length / max0) * .25);
    if (loaded.ground && cov >= 7 / 9 && JOBQ[0].length < 4) set('str', 2);
    if (TER.tiles.size >= 6 || (S.str.s === 2 && TER.tiles.size)) set('gel', 2);
    if (loaded.bld) { set('hs', 1, .3 + (1 - JOBQ[1].length / max1) * .6); if (JOBQ[1].length < 4 && S.str.s === 2) set('hs', 2); } // houses stand on the streets' blocks: done only after them
    if (N.trees >= 4 || (S.str.s === 2 && N.trees)) set('bm', 2);
    if ((N.cars || 0) >= 3 || (S.str.s === 2 && N.cars)) set('vk', 2);
    if (S.str.s === 2 && S.hs.s === 2) set('fs', 1, .3);
    if (A.worldReady) for (const [k] of STEPS) set(k, 2);
    let target = 0; for (const [k, , , w] of STEPS) target += w * (S[k].s === 2 ? 1 : S[k].s === 1 ? .15 + .85 * S[k].p : 0);
    if (!A.worldReady) target = Math.min(97, target + Math.min(6, (t - t0) / 4000)); // a little life while the data trickle in, never 100 before ready
    shown += (Math.max(shown, target) - shown) * Math.min(1, dt * (A.worldReady ? 9 : 4));
    const p = Math.min(100, shown);
    fill.style.transform = `scaleX(${(p / 100).toFixed(4)})`; pc.textContent = p | 0;
    if ((p | 0) !== tick.pv) { tick.pv = p | 0; el('liBar').setAttribute('aria-valuenow', tick.pv); }
    // ---- rows and counters
    for (const [k] of STEPS) { const c = ['w', 'r', 'd'][S[k].s]; if (rows[k].dataset.s !== c) rows[k].dataset.s = c; }
    for (const k in SHOWN) SHOWN[k] += (N[k] - SHOWN[k]) * Math.min(1, dt * 6) + (N[k] > SHOWN[k] ? .5 : 0), SHOWN[k] = Math.min(SHOWN[k], N[k]);
    el('liC_str').textContent = N.roads ? fmtKm(SHOWN.roads) : ''; el('liC_hs').textContent = N.houses ? fmtN(SHOWN.houses) : '';
    el('liC_bm').textContent = N.water ? '+ Wasser' : ''; el('liC_gel').textContent = TERRAIN ? '' : 'flach';
    // ---- sentence with typewriter
    const [ck, cv] = current(), sentence = cv + (ck === 'hs' && N.houses ? ' · ' + fmtN(SHOWN.houses) : ck === 'str' && N.roads ? ' · ' + fmtKm(SHOWN.roads) : '') + (ck ? ' …' : '');
    if (cv !== now) { now = cv; typed = RM ? 999 : 0; el('liSr').textContent = cv; }
    if (typed < sentence.length && t - typeT > 16) { typeT = t; typed += 2; }
    const out = sentence.slice(0, typed); if (nowEl.textContent !== out) nowEl.textContent = out;
    // ---- footer: tiles, open requests, time
    const sec = (t - t0) / 1000 | 0; el('liTime').textContent = (sec / 60 | 0) + ':' + String(sec % 60).padStart(2, '0');
    const ft = (N.tiles ? fmtN(SHOWN.tiles) + (N.tiles === 1 ? ' Kachel' : ' Kacheln') : 'warte auf Daten …') + (N.open ? ' · ' + N.open + ' Anfragen offen' : '');
    if (el('liFt').textContent !== ft) el('liFt').textContent = ft;
    if (note && t - noteT > 9000) { note = ''; el('liNote').hidden = true; }
    // ---- out: hold "Fertig" briefly, then slide away
    if (A.worldReady && p > 99.5) { if (!outT) outT = t; if (t - outT > 650 && !box.classList.contains('out')) { box.classList.add('out'); setTimeout(() => { box.hidden = true; phase = 'weg'; }, 450); } }
  }
  requestAnimationFrame(tick);
  window.HXLI = { msg, note: noteSet, get state() { return { S, N, shown, phase }; } };
})();
