/* HoodExplorer – gespeicherte Orte und Strecken (Runde 139).
   Knopf ★ in der großen Karte öffnet „Orte & Strecken“:
   - Orte mit Kategorien (Vorschläge + eigene). Antippen zeigt den Ort auf der Karte, „Hin“ springt dorthin (weiter als 30 km:
     neuer Startpunkt, Seite lädt neu).
   - Strecken: Folge von Wegpunkten. „Abfahren“ setzt die Figur an den Start, holt das eigene Auto, steigt ein und der Autopilot
     fährt Wegpunkt für Wegpunkt ohne anzuhalten bis zum Ziel. Liegt der Start weiter als 30 km weg, wird nach dem Neuladen
     automatisch weitergemacht (hx.routePending).
   - Strecken anlegen und bearbeiten (Runde 140): „Neue Strecke“ oder ✎, dann Punkte auf der Karte antippen (hinten anhängen oder in den
     nächsten Abschnitt einfügen), Nummer antippen und Karte antippen verschiebt einen Punkt, ↑ / ✕ ordnen um bzw. löschen. Nach jeder
     Änderung sucht der Worker mit der A*-Wegsuche des Autopiloten den Straßenverlauf über die Straßenkacheln der ganzen Strecke und
     speichert ihn als dichte Folge von Straßenpunkten - die Fahrt folgt damit genau der geplanten Straße.
   Gespeichert auf dem Gerät (hx.orte). Vorschläge sind fest und lassen sich ausblenden, nicht löschen. */
(() => {
  const $ = id => document.getElementById(id), G = () => window.HXGO;
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };

  // ---- suggestions (public places only)
  const ORTE0 = [
    ['Wahrzeichen', 'Brandenburger Tor, Berlin', 52.51625, 13.37770], ['Wahrzeichen', 'Kölner Dom', 50.94086, 6.95773],
    ['Wahrzeichen', 'Frauenkirche Dresden', 51.05165, 13.74213], ['Wahrzeichen', 'Elbphilharmonie, Hamburg', 53.54130, 9.98410],
    ['Wahrzeichen', 'Holstentor, Lübeck', 53.86640, 10.67920], ['Wahrzeichen', 'Neues Rathaus, München', 48.13729, 11.57550],
    ['Plätze', 'Römerberg, Frankfurt', 50.11048, 8.68197], ['Plätze', 'Prinzipalmarkt, Münster', 51.96194, 7.62807],
    ['Plätze', 'Schlossplatz, Stuttgart', 48.77829, 9.17990], ['Plätze', 'Hauptmarkt, Nürnberg', 49.45395, 11.07794],
    ['Plätze', 'Marktplatz, Bremen', 53.07572, 8.80721], ['Plätze', 'Alexanderplatz, Berlin', 52.52179, 13.41320],
    ['Wasser & Häfen', 'Landungsbrücken, Hamburg', 53.54568, 9.97056], ['Wasser & Häfen', 'Deutsches Eck, Koblenz', 50.36440, 7.60620],
    ['Wasser & Häfen', 'Rheinufer Rüdesheim', 49.97810, 7.92300], ['Wasser & Häfen', 'Blaues Wunder, Dresden', 51.05300, 13.80900],
    ['Burgen & Schlösser', 'Schloss Neuschwanstein', 47.55750, 10.74980], ['Burgen & Schlösser', 'Heidelberger Schloss', 49.41060, 8.71530],
    ['Burgen & Schlösser', 'Wartburg, Eisenach', 50.96620, 10.30630], ['Burgen & Schlösser', 'Burg Eltz', 50.20550, 7.33650],
    ['Natur', 'Königssee, Schönau', 47.59200, 12.98700], ['Natur', 'Bastei, Sächsische Schweiz', 50.96200, 14.07300],
  ].map(([kat, name, lat, lon], i) => ({ id: 'v' + i, kat, name, lat, lon, v: 1 }));
  // routes along real roads: waypoints a little apart, the autopilot finds the streets between them
  const STRECKEN0 = [
    { name: 'Rheintal: Bingen – Loreley – Koblenz (B 9)', kat: 'Flüsse', note: 'linkes Rheinufer, Burgen über dem Fluss, ~60 km',
      pts: [[49.9665, 7.8990, 'Bingen'], [50.0583, 7.7700, 'Bacharach'], [50.1070, 7.7270, 'Oberwesel'], [50.1530, 7.7130, 'St. Goar'], [50.2310, 7.5900, 'Boppard'], [50.3600, 7.6000, 'Koblenz']] },
    { name: 'Rheingau: Rüdesheim – Assmannshausen – Lorch (B 42)', kat: 'Flüsse', note: 'rechtes Rheinufer, Weinberge, ~15 km',
      pts: [[49.9777, 7.9230, 'Rüdesheim'], [49.9755, 7.9050, ''], [49.9741, 7.8842, ''], [49.9764, 7.8752, ''], [49.9874, 7.8652, 'Assmannshausen'], [50.0105, 7.8577, ''], [50.0201, 7.8380, ''], [50.0431, 7.8015, 'Lorch']] },
    { name: 'Moseltal: Cochem – Beilstein – Zell', kat: 'Flüsse', note: 'enge Moselschleifen, ~35 km',
      pts: [[50.1465, 7.1670, 'Cochem'], [50.1095, 7.2410, 'Beilstein'], [50.0290, 7.1810, 'Zell']] },
    { name: 'Elbe: Blaues Wunder – Schloss Pillnitz', kat: 'Flüsse', note: 'Dresdner Elbhang, ~8 km',
      pts: [[51.0541, 13.8148, 'Blaues Wunder'], [51.0349, 13.8365, 'Wachwitz'], [51.0122, 13.8708, 'Pillnitz']] }, // right bank (Pillnitzer Landstraße)
    { name: 'Berlin Mitte: Alexanderplatz – Brandenburger Tor – Potsdamer Platz', kat: 'Stadtfahrten', note: '~5 km',
      pts: [[52.5219, 13.4132, 'Alexanderplatz'], [52.51735, 13.39343, 'Unter den Linden'], [52.5163, 13.3810, 'Brandenburger Tor'], [52.5096, 13.3760, 'Potsdamer Platz']] },
    { name: 'Hamburg: Landungsbrücken – Speicherstadt – HafenCity', kat: 'Stadtfahrten', note: '~5 km',
      pts: [[53.5457, 9.9706, 'Landungsbrücken'], [53.5440, 9.9930, 'Speicherstadt'], [53.5410, 10.0010, 'HafenCity']] },
    { name: 'Romantische Straße: Rothenburg – Dinkelsbühl', kat: 'Landstraßen', note: 'Altstädte und Felder, ~45 km',
      pts: [[49.3770, 10.1790, 'Rothenburg'], [49.2350, 10.2470, 'Schillingsfürst'], [49.0700, 10.3200, 'Dinkelsbühl']] },
    { name: 'Allgäu: Füssen – Schwangau (Königsschlösser)', kat: 'Landstraßen', note: 'Berge und Seen, ~5 km',
      pts: [[47.5700, 10.7000, 'Füssen'], [47.5770, 10.7320, 'Schwangau'], [47.5560, 10.7420, 'Hohenschwangau']] },
  ].map((r, i) => Object.assign({ id: 'vs' + i, v: 1 }, r));

  const D = Object.assign({ orte: [], strecken: [], aus: [] }, store.get('hx.orte') || {});
  const save = () => store.set('hx.orte', D);
  const allOrte = () => ORTE0.filter(o => !D.aus.includes(o.id)).concat(D.orte);
  const allStr = () => STRECKEN0.filter(o => !D.aus.includes(o.id)).concat(D.strecken);
  const km = pts => { let s = 0; for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], dy = (b[0] - a[0]) * 111.2, dx = (b[1] - a[1]) * 111.2 * Math.cos(a[0] * Math.PI / 180); s += Math.hypot(dx, dy); } return s; };
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- UI
  const tb = document.querySelector('#bigmap .bmTop'); if (!tb) return;
  tb.insertAdjacentHTML('beforeend', '<button class="ib glass" id="bmOrte" type="button" aria-label="Orte und Strecken"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.8l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.6l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg></button>');
  $('bigmap').insertAdjacentHTML('beforeend', `<div class="orte glass" id="orte" hidden>
    <div class="or-head"><div class="or-tabs" role="tablist"><button type="button" class="or-tab on" data-t="o">Orte</button><button type="button" class="or-tab" data-t="s">Strecken</button></div>
      <button class="ib glass" id="orClose" type="button" aria-label="Schließen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="or-body" id="orBody"></div></div>
    <div class="or-rec glass" id="orRec" hidden><button type="button" id="orRecX" hidden></button></div>`);
  const box = $('orte'), body = $('orBody'); let tab = 'o', shown = null;
  const open = () => { box.hidden = false; render(); }, close = () => { box.hidden = true; };
  $('bmOrte').addEventListener('click', () => box.hidden ? open() : close());
  $('orClose').addEventListener('click', close);
  box.querySelectorAll('.or-tab').forEach(b => b.addEventListener('click', () => { tab = b.dataset.t; box.querySelectorAll('.or-tab').forEach(x => x.classList.toggle('on', x === b)); render(); }));

  function render() {
    if (tab === 'o') {
      const kats = [...new Set(allOrte().map(o => o.kat))];
      let h = `<div class="or-new"><input class="pin" id="orName" placeholder="Name des Ortes" maxlength="60"><input class="pin" id="orKat" placeholder="Kategorie" list="orKats" maxlength="30">
        <datalist id="orKats">${kats.map(k => `<option value="${esc(k)}">`).join('')}</datalist>
        <div class="or-row"><button type="button" class="pl" id="orHere">Hier speichern</button><button type="button" class="pl" id="orSel"${G().sel ? '' : ' disabled'}>Gewählten Punkt speichern</button></div></div>`;
      for (const k of kats) { h += `<div class="or-kat">${esc(k)}</div>`;
        for (const o of allOrte().filter(o => o.kat === k)) h += `<div class="or-item" data-id="${o.id}"><button type="button" class="or-name" data-a="show">${esc(o.name)}</button><button type="button" class="pl" data-a="go">Hin</button><button type="button" class="or-x" data-a="del" aria-label="${o.v ? 'Ausblenden' : 'Löschen'}">✕</button></div>`; }
      if (D.aus.length) h += `<button type="button" class="pl or-reset" id="orReset">Ausgeblendete Vorschläge wieder zeigen (${D.aus.length})</button>`;
      body.innerHTML = h;
      const add = (x, z) => { const ll = G().toLatLon(x, z), name = $('orName').value.trim() || G().streetAt(x, z) || 'Ort ' + (D.orte.length + 1), kat = $('orKat').value.trim() || 'Eigene';
        D.orte.push({ id: 'o' + Date.now(), kat, name, lat: +ll[0].toFixed(6), lon: +ll[1].toFixed(6) }); save(); render(); G().toast('Gespeichert: ' + name, 1600); };
      $('orHere').addEventListener('click', () => { const p = G().pos; add(p.x, p.z); });
      $('orSel').addEventListener('click', () => { const s = G().sel; if (s) add(s.x, s.z); });
      if ($('orReset')) $('orReset').addEventListener('click', () => { D.aus = []; save(); render(); });
    } else {
      const kats = [...new Set(allStr().map(o => o.kat || 'Eigene'))];
      let h = `<div class="or-row"><button type="button" class="pl or-ok" id="orNewR">+ Neue Strecke</button></div>
        <p class="or-hint">Abfahren: die Figur steigt am Start in ihr Auto, der Autopilot fährt die Strecke ab. Selbst lenken oder Gas geben beendet die Fahrt. ✎ bearbeitet eine Strecke.</p>`;
      for (const k of kats) { h += `<div class="or-kat">${esc(k)}</div>`;
        for (const r of allStr().filter(o => (o.kat || 'Eigene') === k)) { const d = dense(r), km0 = d ? kmOf(r) : km(viaOf(r));
          h += `<div class="or-item or-str" data-id="${r.id}"><button type="button" class="or-name" data-a="show">${esc(r.name)}<small>${viaOf(r).length} Wegpunkte · ${d ? '' : '~'}${km0.toFixed(0)} km${r.note ? ' · ' + esc(r.note) : ''}</small></button><button type="button" class="pl or-ok" data-a="drive">Abfahren</button><button type="button" class="or-x" data-a="edit" aria-label="Bearbeiten">✎</button><button type="button" class="or-x" data-a="del" aria-label="${r.v ? 'Ausblenden' : 'Löschen'}">✕</button></div>`; } }
      body.innerHTML = h;
      $('orNewR').addEventListener('click', () => edit(null));
    }
    body.querySelectorAll('.or-item').forEach(el => el.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => act(el.dataset.id, b.dataset.a))));
  }
  function act(id, a) {
    const o = allOrte().find(x => x.id === id), r = allStr().find(x => x.id === id), it = o || r; if (!it) return;
    if (a === 'del') { if (it.v) D.aus.push(id); else if (o) D.orte = D.orte.filter(x => x.id !== id); else D.strecken = D.strecken.filter(x => x.id !== id); if (shown === it) shown = null; save(); render(); G().redraw(); return; }
    if (a === 'show') { if (o) { const p = G().toLocal(o.lat, o.lon); G().center(p.x, p.z, .6); G().select(p.x, p.z, o.name); shown = null; }
      else { shown = r; const pp = (dense(r) || viaOf(r)).map(q => G().toLocal(q[0], q[1])); if (!dense(r)) calc(r).then(() => G().redraw(), () => {}); let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const p of pp) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
        const W = $('bigCv').clientWidth, H = $('bigCv').clientHeight - 170, s = Math.max(.002, Math.min(.6, .75 * Math.min(W / Math.max(1, x1 - x0), H / Math.max(1, z1 - z0)))); G().center((x0 + x1) / 2, (z0 + z1) / 2, s); }
      close(); return; }
    if (a === 'go') { const p = G().toLocal(o.lat, o.lon); close(); G().jump(p.x, p.z, o.name); return; }
    if (a === 'drive') { close(); startRoute(r); }
    if (a === 'edit') edit(r);
  }

  // ---- route data (Runde 140): via = the points the player set (lat, lon, name); pts = the street line between them, found by the
  // worker with the autopilot's A* over the street tiles (lat, lon, index of the via point or -1) - dense, every bend
  const viaOf = r => r.via || r.pts; // suggestions and routes from before Runde 140: their pts are the via points
  const ckey = r => JSON.stringify(r.pts.map(q => [q[0], q[1]])); // a suggestion whose points changed in an update is computed again
  const dense = r => r.via ? r.pts : (D.calc && D.calc[r.id] && D.calc[r.id].key === ckey(r) ? D.calc[r.id].pts : null);
  const kmOf = r => r.via ? (r.km || km(r.pts)) : (dense(r) ? D.calc[r.id].km : km(r.pts));
  let rseq = 0; const rwait = new Map();
  function plan(via) { // -> Promise of { pts, km } or { err, leg }
    const w = window.HXTR && HXTR.worker; if (!w) return Promise.resolve({ err: 'nochnicht', leg: 0 });
    if (!plan.on) { plan.on = 1; w.addEventListener('message', e => { if (e.data.type === 'route' && rwait.has(e.data.id)) { rwait.get(e.data.id)(e.data.r); rwait.delete(e.data.id); } }); }
    const id = ++rseq; return new Promise(res => { rwait.set(id, res); w.postMessage({ type: 'route', id, via: via.map(q => { const p = G().toLocal(q[0], q[1]); return [p.x, p.z]; }) }); });
  }
  const errText = r => r.err === 'weit' ? 'Abschnitt ' + (r.leg + 1) + ' ist zu lang – einen Punkt dazwischen setzen'
    : r.err === 'abseits' ? 'Punkt ' + (r.leg + 1 + (r.which || 0)) + ' liegt zu weit von einer Straße'
    : r.err === 'keinweg' ? 'Keine Straße von Punkt ' + (r.leg + 1) + ' nach ' + (r.leg + 2) + ' gefunden' : r.err === 'nochnicht' ? 'Karte lädt noch – gleich noch einmal' : 'Strecke konnte nicht berechnet werden';
  async function calc(r) { // suggestions / old routes: street line once, kept on the device
    if (dense(r)) return dense(r); const res = await plan(viaOf(r)); if (res.err) throw res;
    if (r.via) { r.pts = res.pts; r.km = res.km; } else { D.calc = D.calc || {}; D.calc[r.id] = { pts: res.pts, km: res.km, key: ckey(r) }; } save(); return res.pts; }
  const drivePts = r => { const v = viaOf(r), d = dense(r); return d.map(q => [q[0], q[1], q[2] >= 0 ? (v[q[2]][2] || '') : null]); };

  // ---- driving a route: the autopilot drives from street point to street point, at least ~280 m ahead each time (fewer
  // re-plans), never past a named waypoint (its name is announced)
  let RUN = null;
  const dist = (a, b) => Math.hypot((b[0] - a[0]) * 111200, (b[1] - a[1]) * 111200 * Math.cos(a[0] * Math.PI / 180));
  const nextI = (R, i) => { let d = 0; for (let k = i + 1; k < R.pts.length; k++) { d += dist(R.pts[k - 1], R.pts[k]); if (d >= 280 || R.pts[k][2] || k === R.pts.length - 1) return k; } return R.pts.length - 1; };
  async function startRoute(r) {
    let R; try { if (!dense(r)) G().toast('Strecke wird berechnet …', 2500); await calc(r); R = { name: r.name, src: r, pts: drivePts(r) }; } catch (e) { G().toast(errText(e), 3200); return; }
    const p0 = G().toLocal(R.pts[0][0], R.pts[0][1]);
    if (Math.hypot(p0.x, p0.z) > 30000) { store.set('hx.routePending', { pts: R.pts, name: R.name }); G().jump(p0.x, p0.z, R.pts[0][2] || R.name); return; } // far: new start point, continue after the reload
    const here = G().pos; $('bigmap').hidden = true;
    if (Math.hypot(here.x - p0.x, here.z - p0.z) > 80) { if (G().driving) { go(R, nextI(R, 0)); return; } G().jump(p0.x, p0.z, R.pts[0][2] || R.name); }
    setTimeout(() => board(R, 0), 1500);
  }
  function board(R, tries) {
    if (!G().ready) { setTimeout(() => board(R, tries), 1000); return; }
    if (G().board()) { go(R, nextI(R, 0)); G().toast(R.name + ' – los geht’s', 2400); return; }
    if (tries < 8) setTimeout(() => board(R, tries + 1), 1000); else G().toast('Hier ist kein Platz für ein Auto – ruf es selbst und tippe dann auf „Abfahren“', 3200);
  }
  function go(R, i) {
    const i0 = RUN && RUN.R === R ? RUN.i : 0; RUN = { R, i }; const q = R.pts[i], p = G().toLocal(q[0], q[1]), last = i >= R.pts.length - 1;
    const line = []; for (let k = Math.max(0, Math.min(i0, i - 1)); k <= i; k++) { const t = G().toLocal(R.pts[k][0], R.pts[k][1]); line.push(t.x, t.z); } // the planned street line from the last point to this one
    G().driveTo(p.x, p.z, q[2] || R.name, last ? undefined : () => { const k = nextI(R, i); if (R.pts[k][2]) G().toast('Weiter nach ' + R.pts[k][2], 1600); go(R, k); }, line);
    if (G().auto) G().auto.cruise = true; // sightseeing pace
  }
  // ---- map drawing: street line (dashed), waypoints as numbered dots
  function line(g, toScr, d, pts, col, via, selI) {
    if (!pts || !pts.length) return; const sp = pts.map(q => { const p = G().toLocal(q[0], q[1]); return toScr(p.x, p.z); });
    g.strokeStyle = 'rgba(20,14,6,.7)'; g.lineWidth = 7 * d; g.setLineDash([]); g.lineJoin = 'round'; g.beginPath(); sp.forEach(([x, y], k) => k ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke();
    g.strokeStyle = col; g.lineWidth = 3.5 * d; g.setLineDash([10 * d, 7 * d]); g.stroke(); g.setLineDash([]);
    if (!via) return; g.font = `bold ${10 * d}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    via.forEach((q, k) => { const p = G().toLocal(q[0], q[1]), [x, y] = toScr(p.x, p.z), end = k === 0 || k === via.length - 1, r = (end ? 9 : 7.5) * d;
      if (k === selI) { g.strokeStyle = '#ffffff'; g.lineWidth = 3 * d; g.beginPath(); g.arc(x, y, r + 4 * d, 0, 7); g.stroke(); }
      g.fillStyle = k === 0 ? '#7ee08a' : k === via.length - 1 ? '#ff6a5a' : col; g.strokeStyle = '#1a1206'; g.lineWidth = 2 * d; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); g.stroke();
      g.fillStyle = '#1a1206'; g.fillText(String(k + 1), x, y + .5 * d); }); }
  window.HXORT = {
    stopped() { RUN = null; },
    draw(g, toScr, d) {
      if (shown && shown !== (ed && ed.src)) line(g, toScr, d, dense(shown) || viaOf(shown), '#f2c46b', viaOf(shown));
      if (RUN && RUN.R.src !== shown) line(g, toScr, d, RUN.R.pts, '#7fd3ff', RUN.R.src ? viaOf(RUN.R.src) : null);
      if (ed) line(g, toScr, d, ed.pts && !ed.busy ? ed.pts : ed.via, '#ff7ad9', ed.via, ed.sel); },
    tap(x, z) { if (!ed || $('orRec').hidden) return; const ll = G().toLatLon(x, z), q = [+ll[0].toFixed(5), +ll[1].toFixed(5)]; // editor: a tap on the map sets a point
      if (ed.sel >= 0) { ed.via[ed.sel][0] = q[0]; ed.via[ed.sel][1] = q[1]; ed.sel = -1; }
      else if (ed.mode === 'ins' && ed.via.length >= 2) { let bi = 1, bd = Infinity; for (let k = 1; k < ed.via.length; k++) { const c = dist(ed.via[k - 1], q) + dist(q, ed.via[k]) - dist(ed.via[k - 1], ed.via[k]); if (c < bd) { bd = c; bi = k; } } ed.via.splice(bi, 0, [q[0], q[1], '']); }
      else ed.via.push([q[0], q[1], ed.via.length ? '' : (G().streetAt(x, z) || '')]);
      edChanged(); },
  };
  // after a reload for a far route: continue
  { const pend = store.get('hx.routePending'); if (pend && pend.pts) { store.set('hx.routePending', null); const wait = () => { if (!G() || !G().ready) { setTimeout(wait, 1000); return; } setTimeout(() => board({ name: pend.name, pts: pend.pts }, 0), 1500); }; setTimeout(wait, 1000); } }

  // ---- route editor: tap the map to add points (at the end, or „Einfügen“: into the nearest leg); tap a number, then the map, to move
  // that point; ↑ moves it one place forward, ✕ removes it. The street line is computed after every change.
  let ed = null;
  function edit(r) {
    const v = r ? viaOf(r).map(q => [q[0], q[1], typeof q[2] === 'string' ? q[2] : '']) : [];
    ed = { src: r, name: r ? r.name : '', kat: r ? (r.kat || 'Eigene') : 'Eigene', via: v, pts: r ? dense(r) : null, km: r ? kmOf(r) : 0, sel: -1, mode: 'end', busy: 0, err: '' };
    if (r) act(r.id, 'show'); else close();
    $('orRec').hidden = false; edRender(); if (v.length > 1 && !ed.pts) edChanged(); else G().redraw(); }
  let edT = 0, edSeq = 0;
  function edChanged() { ed.pts = null; ed.err = ''; ed.busy = ed.via.length > 1 ? 1 : 0; edRender(); G().redraw(); clearTimeout(edT);
    if (ed.via.length < 2) return; const my = ++edSeq, e0 = ed;
    edT = setTimeout(async () => { const res = await plan(e0.via); if (ed !== e0 || my !== edSeq) return; ed.busy = 0;
      if (res.err) ed.err = errText(res); else { ed.pts = res.pts; ed.km = res.km; } edRender(); G().redraw(); }, 300); }
  function edRender() {
    const el = $('orRec'), n = ed.via.length;
    const st = ed.busy ? 'Berechne Strecke …' : ed.err ? '⚠ ' + ed.err : n < 2 ? (n ? 'Weiter: nächsten Punkt auf der Karte antippen' : 'Auf der Karte den Start antippen') : n + ' Wegpunkte · ' + ed.km.toFixed(1) + ' km · ' + ed.pts.length + ' Straßenpunkte';
    const hint = ed.sel >= 0 ? 'Punkt ' + (ed.sel + 1) + ' gewählt: neue Stelle auf der Karte antippen' : ed.mode === 'ins' ? 'Antippen fügt einen Punkt in den nächsten Abschnitt ein' : 'Antippen hängt einen Punkt hinten an';
    el.innerHTML = `<div class="or-ed-h"><input class="pin" id="edName" placeholder="Name der Strecke" maxlength="70" value="${esc(ed.name)}"><input class="pin" id="edKat" placeholder="Kategorie" maxlength="30" value="${esc(ed.kat)}" list="edKats"><datalist id="edKats">${[...new Set(allStr().map(o => o.kat || 'Eigene'))].map(k => `<option value="${esc(k)}">`).join('')}</datalist></div>
      <div class="or-ed-s${ed.err ? ' bad' : ''}">${esc(st)}</div>
      <div class="or-ed-l">${ed.via.map((q, k) => `<div class="or-ed-r${k === ed.sel ? ' on' : ''}" data-i="${k}"><button type="button" class="or-ed-n" data-a="sel" aria-label="Punkt ${k + 1} verschieben">${k + 1}</button><input class="pin" data-a="name" maxlength="40" value="${esc(q[2] || '')}" placeholder="${k === 0 ? 'Start' : k === n - 1 ? 'Ziel' : 'Wegpunkt (ohne Ansage)'}"><button type="button" class="or-x" data-a="up" aria-label="Nach vorn"${k ? '' : ' disabled'}>↑</button><button type="button" class="or-x" data-a="del" aria-label="Entfernen">✕</button></div>`).join('')}</div>
      <div class="or-hint">${esc(hint)}</div>
      <div class="or-row"><button type="button" class="pl${ed.mode === 'end' ? ' on' : ''}" id="edEnd">Hinten anhängen</button><button type="button" class="pl${ed.mode === 'ins' ? ' on' : ''}" id="edIns">Einfügen</button></div>
      <div class="or-row"><button type="button" class="pl or-ok" id="orRecSave"${n >= 2 && ed.pts && !ed.busy ? '' : ' disabled'}>Speichern</button><button type="button" class="pl" id="orRecX">Abbrechen</button></div>`;
    $('edName').addEventListener('input', e => { ed.name = e.target.value; }); $('edKat').addEventListener('input', e => { ed.kat = e.target.value; });
    el.querySelectorAll('.or-ed-r').forEach(row => { const k = +row.dataset.i;
      row.querySelector('[data-a="name"]').addEventListener('input', e => { ed.via[k][2] = e.target.value.trim(); });
      row.querySelector('[data-a="sel"]').addEventListener('click', () => { ed.sel = ed.sel === k ? -1 : k; if (ed.sel >= 0) { const p = G().toLocal(ed.via[k][0], ed.via[k][1]); G().center(p.x, p.z); } edRender(); G().redraw(); });
      row.querySelector('[data-a="up"]').addEventListener('click', () => { if (!k) return; const t = ed.via[k]; ed.via[k] = ed.via[k - 1]; ed.via[k - 1] = t; ed.sel = -1; edChanged(); });
      row.querySelector('[data-a="del"]').addEventListener('click', () => { ed.via.splice(k, 1); ed.sel = -1; edChanged(); }); });
    $('edEnd').addEventListener('click', () => { ed.mode = 'end'; ed.sel = -1; edRender(); }); $('edIns').addEventListener('click', () => { ed.mode = 'ins'; ed.sel = -1; edRender(); });
    $('orRecX').addEventListener('click', edClose); $('orRecSave').addEventListener('click', edSave);
  }
  function edClose() { ed = null; $('orRec').hidden = true; G().redraw(); }
  function edSave() {
    if (!ed || ed.via.length < 2 || !ed.pts) return; const v = ed.via, a = v[0][2], b = v[v.length - 1][2];
    const r = { id: ed.src && !ed.src.v ? ed.src.id : 's' + Date.now(), name: ed.name.trim() || (a && b ? a + ' – ' + b : a ? 'Ab ' + a : b ? 'Nach ' + b : 'Strecke ' + (D.strecken.length + 1)), kat: ed.kat.trim() || 'Eigene', via: v.map(q => [q[0], q[1], q[2] || '']), pts: ed.pts, km: ed.km };
    if (ed.src && ed.src.note) r.note = ed.src.note;
    if (ed.src && ed.src.v) { if (!D.aus.includes(ed.src.id)) D.aus.push(ed.src.id); D.strecken.push(r); } // an edited suggestion becomes an own route
    else if (ed.src) D.strecken = D.strecken.map(x => x.id === r.id ? r : x); else D.strecken.push(r);
    save(); shown = r; edClose(); tab = 's'; box.querySelectorAll('.or-tab').forEach(x => x.classList.toggle('on', x.dataset.t === 's')); open(); G().toast('Strecke gespeichert', 1400); }
  window.HXORT.closePanel = () => { if (!box.hidden) { close(); return true; } if (!$('orRec').hidden) { edClose(); return true; } return false; };
})();
