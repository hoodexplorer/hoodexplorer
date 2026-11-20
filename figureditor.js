/* HoodExplorer – Figuren-Editor (Runde 113). Aus Stimmung → Figur → „Figur bearbeiten“: Teile und Farben der Gelenkfigur
   frei kombinieren (Baukasten aus figur.js), Vorschau dreht sich live, „Übernehmen“ speichert als „Eigene Figur“
   (localStorage hx.figurEigen + Vorschaubild hx.figurEigenBild) und setzt sie als Spielfigur. */
(() => {
  const X = window.HXTR, $ = id => document.getElementById(id);
  const O = {
    bau: [['schmal', 'Schmal'], ['normal', 'Normal'], ['kraeftig', 'Kräftig'], ['feminin', 'Feminin']],
    stil: [['jacke', 'Jacke'], ['mantel', 'Mantel'], ['kittel', 'Kittel'], ['weste', 'Weste'], ['hemd', 'Hemd'], ['kleid', 'Kleid']],
    kopf: [['keiner', 'Ohne'], ['hut', 'Hut'], ['cowboy', 'Cowboyhut'], ['kappe', 'Kappe'], ['muetze', 'Mütze'], ['polizei', 'Polizeimütze'], ['fwhelm', 'Feuerwehrhelm'], ['bauhelm', 'Bauhelm'], ['kochmuetze', 'Kochmütze'], ['haube', 'Haube'], ['ritterhelm', 'Ritterhelm'], ['militaerhelm', 'Gefechtshelm'], ['barett', 'Barett'], ['visier', 'Visier']],
    frisur: [['keine', 'Glatze'], ['kurz', 'Kurz'], ['lang', 'Lang'], ['zopf', 'Zopf'], ['irokese', 'Irokese']],
    ruecken: [['', 'Nichts'], ['rucksack', 'Rucksack'], ['tasche', 'Tasche'], ['flasche', 'Atemschutz'], ['pizzabox', 'Pizzabox'], ['umhang', 'Umhang']],
  };
  const COLS = [['haut', 'Haut'], ['haar', 'Haar'], ['oben', 'Oberteil'], ['besatz', 'Besatz'], ['hose', 'Hose'], ['schuhe', 'Schuhe'], ['kopfFarbe', 'Kopfbedeckung']];
  const SKIN = ['#f0c8a8', '#e2b08c', '#d8a27a', '#c98d66', '#8d5a3a', '#5a3a26'];
  const FLAGS = [['schal', 'Schal'], ['brille', 'Sonnenbrille'], ['absatz', 'Absatzschuhe'], ['stern', 'Stern'], ['kurz', 'Kurzes Kleid']];
  let def = null, R = null, scene, cam, grp, raf = 0, rot = 0;

  // ---- sheet
  $('fzSheet').insertAdjacentHTML('afterend', `<div class="sheet" id="feSheet" hidden>
    <h3>Figur bearbeiten <button class="ib glass" id="feClose" aria-label="Schließen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></h3>
    <div class="fe-top"><div class="fe-prev" id="fePrev"></div><div class="fe-side">
      <label class="fe-l" for="feBase">Ausgehen von</label><select id="feBase"></select>
      <div class="fe-btns"><button class="pl" type="button" id="feRand">Zufall</button><button class="pl fe-ok" type="button" id="feOk">Übernehmen</button></div></div></div>
    <div id="feBody"></div></div>`);
  const body = $('feBody');
  const seg = (key, label) => `<div class="fe-g"><span class="fe-l">${label}</span><div class="seg uiseg" data-k="${key}">${O[key].map(([v, n]) => `<button type="button" data-v="${v}">${n}</button>`).join('')}</div></div>`;
  body.innerHTML = seg('bau', 'Statur') + seg('stil', 'Schnitt') +
    `<div class="fe-g"><label class="fe-l" for="feKopf">Kopfbedeckung</label><select id="feKopf">${O.kopf.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>` +
    seg('frisur', 'Frisur') + seg('ruecken', 'Rücken') +
    `<div class="fe-g"><span class="fe-l">Hautton</span><div class="fe-sw" id="feSkin">${SKIN.map(c => `<button type="button" data-c="${c}" style="background:${c}" aria-label="Hautton ${c}"></button>`).join('')}</div></div>` +
    `<div class="fe-g"><span class="fe-l">Farben</span><div class="fe-cols">${COLS.map(([k, n]) => `<label class="fe-col"><input type="color" id="fc_${k}" data-k="${k}"><span>${n}</span></label>`).join('')}</div></div>` +
    `<div class="fe-g"><span class="fe-l">Extras</span><div class="fe-flags">${FLAGS.map(([k, n]) => `<label class="tog"><input type="checkbox" data-f="${k}"> ${n}</label>`).join('')}
      <label class="tog"><input type="checkbox" id="feStrOn"> Reflexstreifen <input type="color" id="feStr" value="#cfd3d6"></label>
      <label class="tog"><input type="checkbox" id="feTarnOn"> Tarnflecken <input type="color" id="feTarn" value="#3a3f22"></label>
      <label class="tog">Rückenaufschrift <input class="pin fe-txt" id="feTxt" maxlength="10" placeholder="z. B. POLIZEI"></label></div></div>`;
  $('feBase').innerHTML = '<option value="eigen">Eigene Figur</option>' + HXFIG.KATALOG.map(r => `<option value="${r.id}">${r.name}</option>`).join('');

  // ---- preview: own small renderer while the editor is open
  function startPrev() {
    if (R) return; R = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true }); R.setPixelRatio(1); R.setSize(150, 200); R.domElement.style.width = '150px'; R.domElement.style.height = '200px'; R.domElement.style.imageRendering = 'pixelated';
    $('fePrev').appendChild(R.domElement);
    scene = new THREE.Scene(); scene.add(new THREE.HemisphereLight(0xffffff, 0x665f55, .95)); const d = new THREE.DirectionalLight(0xffffff, .65); d.position.set(-2, 4, 3); scene.add(d);
    cam = new THREE.PerspectiveCamera(30, 150 / 200, .1, 50); cam.position.set(0, 1.2, 5.2); cam.lookAt(0, 1.0, 0);
    grp = new THREE.Group(); scene.add(grp); rebuild();
    const loop = t => { rot += .012; grp.rotation.y = Math.sin(rot) * .9 + .35; if (grp.userData.neck) HXFIG.pose(grp.userData, { walk: 0, run: 0, phase: 0, air: 0, tuck: 0, crouch: 0 }); R.render(scene, cam); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop); }
  function stopPrev() { cancelAnimationFrame(raf); if (R) { R.dispose(); R.forceContextLoss && R.forceContextLoss(); R.domElement.remove(); R = null; } }
  function rebuild() { if (grp) HXFIG.make(def, grp); sync(); }

  // ---- state <-> controls
  function sync() {
    for (const s of body.querySelectorAll('.seg[data-k]')) { const k = s.dataset.k, v = def[k] || ''; for (const b of s.children) b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false'); }
    $('feKopf').value = def.kopf || 'keiner';
    for (const [k] of COLS) { const i = $('fc_' + k); if (i && /^#[0-9a-f]{6}$/i.test(def[k] || '')) i.value = def[k]; }
    for (const b of $('feSkin').children) b.setAttribute('aria-pressed', b.dataset.c === def.haut ? 'true' : 'false');
    for (const c of body.querySelectorAll('[data-f]')) c.checked = !!def[c.dataset.f];
    $('feStrOn').checked = !!def.streifen; if (def.streifen) $('feStr').value = def.streifen;
    $('feTarnOn').checked = !!def.tarn; if (def.tarn) $('feTarn').value = def.tarn;
    $('feTxt').value = def.schrift || '';
  }
  body.addEventListener('click', e => { const b = e.target.closest('.seg[data-k] button'); if (b) { def[b.parentElement.dataset.k] = b.dataset.v || null; rebuild(); }
    const sw = e.target.closest('#feSkin button'); if (sw) { def.haut = sw.dataset.c; rebuild(); } });
  body.addEventListener('input', e => { const t = e.target;
    if (t.dataset.k && t.type === 'color') def[t.dataset.k] = t.value;
    else if (t.dataset.f) def[t.dataset.f] = t.checked;
    else if (t.id === 'feStrOn' || t.id === 'feStr') def.streifen = $('feStrOn').checked ? $('feStr').value : null;
    else if (t.id === 'feTarnOn' || t.id === 'feTarn') def.tarn = $('feTarnOn').checked ? $('feTarn').value : null;
    else if (t.id === 'feTxt') def.schrift = t.value.trim().toUpperCase() || null;
    else if (t.id === 'feKopf') def.kopf = t.value;
    if (grp) HXFIG.make(def, grp); });
  $('feKopf').addEventListener('change', e => { def.kopf = e.target.value; rebuild(); });
  $('feBase').addEventListener('change', e => { def = Object.assign({}, HXFIG.byId(e.target.value)); rebuild(); });
  const pick = a => a[(Math.random() * a.length) | 0], rc = () => '#' + [0, 0, 0].map(() => ((40 + Math.random() * 190) | 0).toString(16).padStart(2, '0')).join('');
  $('feRand').addEventListener('click', () => { def = Object.assign({}, def, { bau: pick(O.bau)[0], stil: pick(O.stil)[0], kopf: pick(O.kopf)[0], frisur: pick(O.frisur)[0], ruecken: pick(O.ruecken)[0] || null,
    haut: pick(SKIN), haar: pick(['#1a1410', '#3a2a1a', '#7a4a22', '#b07a3a', '#d9b05a', '#9a9a9a', '#7a2f8a']), oben: rc(), besatz: rc(), hose: rc(), schuhe: pick(['#16181c', '#2a1d14', '#e8e8e4', '#5a3a20']), kopfFarbe: rc(), schal: Math.random() < .2, brille: Math.random() < .15 }); rebuild(); });
  $('feOk').addEventListener('click', () => {
    const d = Object.assign({}, def, { id: 'eigen', name: 'Eigene Figur', gruppe: 'Eigene' });
    try { localStorage.setItem('hx.figurEigen', JSON.stringify(d)); if (R) { grp.rotation.y = .35; R.render(scene, cam); localStorage.setItem('hx.figurEigenBild', JSON.stringify(R.domElement.toDataURL('image/png'))); } } catch (e) {}
    X.addEigenCard(); X.setFigur('eigen'); close(); });
  function open() { def = Object.assign({}, (X.player && X.player.userData.def) || HXFIG.KATALOG[0]); $('feBase').value = HXFIG.byId(def.id).id; $('sheet').hidden = true; $('feSheet').hidden = false; startPrev(); sync(); }
  function close() { $('feSheet').hidden = true; stopPrev(); }
  $('feClose').addEventListener('click', close);
  $('bFigEdit').addEventListener('click', open);
})();
