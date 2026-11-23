/* HoodExplorer – Figuren-Baukasten (Runde 106).
   Eine Gelenkfigur (Hüfte, Brust, Kopf am Hals, Ober-/Unterarm + Hand, Oberschenkel/Schienbein + Stiefel, Schal/Rucksack als
   Nachschwinger) und ein Katalog von Rollen. Jede Rolle ist dieselbe Figur mit anderen Parametern: Statur, Farben, Oberteil,
   Kopfbedeckung, Frisur, Rücken, Reflexstreifen, Rückenaufschrift, Gegenstand. Front = +z, Füße bei y = 0, Meter.
   Derselbe Katalog (zwischen KATALOG und ENDE, reines JSON) wird von werkzeuge/blender/hx_figuren.py gelesen. */
(() => {
const KATALOG = /*KATALOG*/[
 {"id":"wanderer","name":"Wanderer","gruppe":"Alltag","bau":"normal","haut":"#d8a27a","haar":"#4a3020","oben":"#2f4f9a","besatz":"#d11f22","hose":"#33291f","schuhe":"#2a1d14","stil":"jacke","kopf":"hut","kopfFarbe":"#d9c27a","frisur":"kurz","ruecken":"rucksack","schal":true},
 {"id":"polizist","name":"Polizist","gruppe":"Einsatz","bau":"kraeftig","haut":"#d8a27a","haar":"#3a2a1a","oben":"#1f3a6e","besatz":"#e6e6e2","hose":"#1f3a6e","schuhe":"#16181c","stil":"jacke","kopf":"polizei","kopfFarbe":"#1f3a6e","frisur":"kurz","streifen":"#cfd3d6","schrift":"POLIZEI"},
 {"id":"polizistin","name":"Polizistin","gruppe":"Einsatz","bau":"schmal","haut":"#c98d66","haar":"#2a1a10","oben":"#1f3a6e","besatz":"#e6e6e2","hose":"#1f3a6e","schuhe":"#16181c","stil":"jacke","kopf":"polizei","kopfFarbe":"#1f3a6e","frisur":"zopf","streifen":"#cfd3d6","schrift":"POLIZEI"},
 {"id":"feuerwehr","name":"Feuerwehrmann","gruppe":"Einsatz","bau":"kraeftig","haut":"#d8a27a","haar":"#3a2a1a","oben":"#2a3140","besatz":"#e8c21e","hose":"#2a3140","schuhe":"#16181c","stil":"mantel","kopf":"fwhelm","kopfFarbe":"#e9e6dc","frisur":"kurz","ruecken":"flasche","streifen":"#e8c21e","schrift":"FEUERWEHR"},
 {"id":"notaerztin","name":"Notärztin","gruppe":"Einsatz","bau":"schmal","haut":"#e2b08c","haar":"#7a4a22","oben":"#e8452a","besatz":"#f2f2ee","hose":"#e8452a","schuhe":"#16181c","stil":"jacke","kopf":"keiner","frisur":"zopf","streifen":"#e0e2e4","schrift":"NOTARZT"},
 {"id":"postbotin","name":"Postbotin","gruppe":"Alltag","bau":"normal","haut":"#e2b08c","haar":"#b07a3a","oben":"#f2c200","besatz":"#1a1a1a","hose":"#2a2d33","schuhe":"#16181c","stil":"jacke","kopf":"kappe","kopfFarbe":"#f2c200","frisur":"lang","ruecken":"tasche"},
 {"id":"paketbote","name":"Paketbote","gruppe":"Alltag","bau":"kraeftig","haut":"#8d5a3a","haar":"#1a1410","oben":"#5a3a20","besatz":"#f2b400","hose":"#5a3a20","schuhe":"#16181c","stil":"hemd","kopf":"kappe","kopfFarbe":"#5a3a20","frisur":"kurz"},
 {"id":"detektiv","name":"Detektiv","gruppe":"Rätsel","bau":"schmal","haut":"#d8a27a","haar":"#3a2a1a","oben":"#a68a5a","besatz":"#6b5236","hose":"#3e3a34","schuhe":"#2a1d14","stil":"mantel","kopf":"hut","kopfFarbe":"#5a4a38","frisur":"kurz","item":"lupe"},
 {"id":"journalistin","name":"Journalistin","gruppe":"Rätsel","bau":"schmal","haut":"#c98d66","haar":"#1a1410","oben":"#7a2f3a","besatz":"#e9e2d4","hose":"#2a2d33","schuhe":"#16181c","stil":"jacke","kopf":"keiner","frisur":"lang","ruecken":"tasche","item":"brief"},
 {"id":"foersterin","name":"Försterin","gruppe":"Natur","bau":"normal","haut":"#e2b08c","haar":"#7a4a22","oben":"#3d5a2e","besatz":"#6b4a2e","hose":"#5a4a32","schuhe":"#3a2a1a","stil":"jacke","kopf":"hut","kopfFarbe":"#3d5a2e","frisur":"zopf","ruecken":"rucksack"},
 {"id":"jaeger","name":"Jäger","gruppe":"Natur","bau":"kraeftig","haut":"#d8a27a","haar":"#5a4a3a","oben":"#4a5a32","besatz":"#e8641a","hose":"#4a4232","schuhe":"#3a2a1a","stil":"jacke","kopf":"muetze","kopfFarbe":"#e8641a","frisur":"kurz","ruecken":"rucksack","item":"gewehr"},
 {"id":"bauarbeiter","name":"Bauarbeiter","gruppe":"Alltag","bau":"kraeftig","haut":"#d8a27a","haar":"#3a2a1a","oben":"#e8641a","besatz":"#d9dc3a","hose":"#2f4a7a","schuhe":"#3a2a1a","stil":"weste","kopf":"bauhelm","kopfFarbe":"#f2c200","frisur":"kurz","streifen":"#e0e2e4"},
 {"id":"koechin","name":"Köchin","gruppe":"Alltag","bau":"normal","haut":"#e2b08c","haar":"#3a2a1a","oben":"#f2f2ee","besatz":"#1a1a1a","hose":"#2a2d33","schuhe":"#16181c","stil":"kittel","kopf":"kochmuetze","kopfFarbe":"#f8f8f4","frisur":"kurz"},
 {"id":"aerztin","name":"Ärztin","gruppe":"Alltag","bau":"schmal","haut":"#8d5a3a","haar":"#1a1410","oben":"#f2f2ee","besatz":"#4f8ac9","hose":"#4f8ac9","schuhe":"#e8e8e4","stil":"kittel","kopf":"keiner","frisur":"lang"},
 {"id":"taxifahrer","name":"Taxifahrer","gruppe":"Alltag","bau":"kraeftig","haut":"#d8a27a","haar":"#9a9a9a","oben":"#e8e4d8","besatz":"#1a1a1a","hose":"#2a2d33","schuhe":"#16181c","stil":"hemd","kopf":"kappe","kopfFarbe":"#1a1a1a","frisur":"kurz"},
 {"id":"pizzabote","name":"Pizzabote","gruppe":"Alltag","bau":"schmal","haut":"#e2b08c","haar":"#3a2a1a","oben":"#c4262a","besatz":"#f2f2ee","hose":"#2a2d33","schuhe":"#e8e8e4","stil":"hemd","kopf":"kappe","kopfFarbe":"#c4262a","frisur":"kurz","ruecken":"pizzabox"},
 {"id":"touristin","name":"Touristin","gruppe":"Alltag","bau":"normal","haut":"#f0c8a8","haar":"#d9b05a","oben":"#3aa6a0","besatz":"#f2c200","hose":"#d9c896","schuhe":"#e8e8e4","stil":"hemd","kopf":"kappe","kopfFarbe":"#f2f2ee","frisur":"zopf","ruecken":"rucksack","item":"karte"},
 {"id":"skaterin","name":"Skaterin","gruppe":"Alltag","bau":"schmal","haut":"#c98d66","haar":"#7a2f8a","oben":"#2a2d33","besatz":"#ff4fd8","hose":"#4a5a7a","schuhe":"#e8e8e4","stil":"hemd","kopf":"muetze","kopfFarbe":"#ff4fd8","frisur":"lang"},
 {"id":"gaertner","name":"Gärtner","gruppe":"Natur","bau":"normal","haut":"#d8a27a","haar":"#9a9a9a","oben":"#6f8f45","besatz":"#3d5a2e","hose":"#3d5a2e","schuhe":"#3a2a1a","stil":"weste","kopf":"hut","kopfFarbe":"#d9c27a","frisur":"kurz"},
 {"id":"cowboy","name":"Cowboy","gruppe":"Western","bau":"normal","haut":"#d8a27a","haar":"#5a3a20","oben":"#8a5a36","besatz":"#c4262a","hose":"#3a4a6a","schuhe":"#5a3a20","stil":"weste","kopf":"cowboy","kopfFarbe":"#7a5232","frisur":"kurz","schal":true},
 {"id":"sheriff","name":"Sheriff","gruppe":"Western","bau":"kraeftig","haut":"#d8a27a","haar":"#9a9a9a","oben":"#e9dcc0","besatz":"#3a2a1a","hose":"#5a4a38","schuhe":"#3a2a1a","stil":"weste","kopf":"cowboy","kopfFarbe":"#3a2a1a","frisur":"kurz","stern":true},
 {"id":"ritter","name":"Ritter","gruppe":"Mittelalter","bau":"kraeftig","haut":"#d8a27a","haar":"#5a3a20","oben":"#9aa0a6","besatz":"#8e1f2a","hose":"#7a8086","schuhe":"#4a4d55","stil":"mantel","kopf":"ritterhelm","kopfFarbe":"#9aa0a6","frisur":"keine","ruecken":"umhang"},
 {"id":"haendlerin","name":"Händlerin","gruppe":"Mittelalter","bau":"normal","haut":"#e2b08c","haar":"#7a4a22","oben":"#7a3525","besatz":"#e6d8b8","hose":"#5a4a38","schuhe":"#3a2a1a","stil":"mantel","kopf":"haube","kopfFarbe":"#efe6d2","frisur":"lang","ruecken":"tasche"},
 {"id":"runner","name":"Cyber-Runner","gruppe":"Cyberpunk","bau":"schmal","haut":"#c98d66","haar":"#4fe3ff","oben":"#1c1f2c","besatz":"#ff4fd8","hose":"#232a3d","schuhe":"#4fe3ff","stil":"jacke","kopf":"visier","kopfFarbe":"#4fe3ff","frisur":"irokese","streifen":"#4fe3ff"},
 {"id":"diva","name":"Diva","gruppe":"Glamour","bau":"feminin","haut":"#e2b08c","haar":"#2a1a10","oben":"#c4162a","besatz":"#f2c14e","hose":"#c4162a","schuhe":"#16181c","stil":"kleid","kopf":"keiner","frisur":"lang","absatz":true},
 {"id":"agentin","name":"Agentin","gruppe":"Glamour","bau":"feminin","haut":"#f0c8a8","haar":"#e8d08a","oben":"#16181c","besatz":"#3a3d44","hose":"#16181c","schuhe":"#16181c","stil":"jacke","kopf":"keiner","frisur":"lang","brille":true,"absatz":true},
 {"id":"partygast","name":"Partygast","gruppe":"Glamour","bau":"feminin","haut":"#8d5a3a","haar":"#1a1410","oben":"#a03fd0","besatz":"#f2c14e","hose":"#a03fd0","schuhe":"#f2c14e","stil":"kleid","kurz":true,"kopf":"keiner","frisur":"zopf","absatz":true},
 {"id":"soldat","name":"Soldat","gruppe":"Militär","bau":"kraeftig","haut":"#d8a27a","haar":"#3a2a1a","oben":"#5b6b3a","besatz":"#3a3f22","hose":"#4b5320","schuhe":"#2a2620","stil":"jacke","kopf":"militaerhelm","kopfFarbe":"#4b5320","frisur":"kurz","ruecken":"rucksack","packFarbe":"#4b5320","tarn":"#3a3f22","item":"gewehr"},
 {"id":"soldatin","name":"Soldatin","gruppe":"Militär","bau":"schmal","haut":"#e2b08c","haar":"#7a4a22","oben":"#5b6b3a","besatz":"#3a3f22","hose":"#4b5320","schuhe":"#2a2620","stil":"jacke","kopf":"militaerhelm","kopfFarbe":"#4b5320","frisur":"zopf","ruecken":"rucksack","packFarbe":"#4b5320","tarn":"#6b5a3a","item":"gewehr"},
 {"id":"offizier","name":"Offizier","gruppe":"Militär","bau":"normal","haut":"#d8a27a","haar":"#9a9a9a","oben":"#4b5320","besatz":"#e8c21e","hose":"#4b5320","schuhe":"#16181c","stil":"jacke","kopf":"barett","kopfFarbe":"#7a1f2a","frisur":"kurz","stern":true},
 {"id":"androide","name":"Androide","gruppe":"Cyberpunk","bau":"normal","haut":"#c9cdd2","haar":"#c9cdd2","oben":"#e8e8e4","besatz":"#4fe3ff","hose":"#8c9096","schuhe":"#4a4d55","stil":"hemd","kopf":"visier","kopfFarbe":"#ff4fd8","frisur":"keine","streifen":"#4fe3ff"}
]/*ENDE*/;

const M = new Map(), mat = c => { let m = M.get(c); if (!m) M.set(c, m = new THREE.MeshLambertMaterial({ color: c })); return m; };
const BOXG = new THREE.BoxGeometry(1, 1, 1), CYL = new Map(), cylG = (r0, r1, n) => { const k = r0 + ',' + r1 + ',' + n; let g = CYL.get(k); if (!g) { g = new THREE.CylinderGeometry(r1, r0, 1, n); g.translate(0, .5, 0); CYL.set(k, g); } return g; };
function box(par, w, h, d, x, y, z, c) { const o = new THREE.Mesh(BOXG, mat(c)); o.scale.set(w, h, d); o.position.set(x, y + h / 2, z); par.add(o); return o; }   // y = bottom
function cyl(par, r0, r1, h, x, y, z, c, n) { const o = new THREE.Mesh(cylG(r0, r1, n || 8), mat(c)); o.scale.set(1, h, 1); o.position.set(x, y, z); par.add(o); return o; } // y = bottom, r0 bottom
const piv = (par, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); par.add(g); return g; };
const TXT = new Map();
function label(text, col) { const k = text + col; if (TXT.has(k)) return TXT.get(k); const c = document.createElement('canvas'); c.width = 64; c.height = 16; const g = c.getContext('2d');
  g.font = 'bold 11px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(text, 32, 9);
  const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; const m = new THREE.MeshLambertMaterial({ map: t, transparent: true, alphaTest: .4 }); TXT.set(k, m); return m; }

/* builds role def into group g (cleared first); returns joints */
function make(def, g) {
  while (g.children.length) g.remove(g.children[0]);
  const d = Object.assign({}, KATALOG[0], { ruecken: null, schal: false, streifen: null, schrift: null, item: null, stern: false }, def);
  const fem = d.bau === 'feminin', b = d.bau === 'kraeftig' ? 1.15 : d.bau === 'schmal' || fem ? .9 : 1, lb = d.bau === 'kraeftig' ? 1.1 : d.bau === 'schmal' ? .92 : fem ? .88 : 1, J = { def: d };
  J.root = piv(g, 0, 0, 0);
  J.hips = piv(J.root, 0, .92, 0);
  box(J.hips, (fem ? .4 : .36) * b, .2, .22 * b, 0, -.2, 0, d.hose);
  /* Runde 107 (phone test: legs cut through the coat): long hems are two panels that swing with the thighs; a dress is a flared cone */
  const hem = { jacke: .26, mantel: .62, kittel: .55, weste: 0, hemd: 0 }[d.stil] || 0;
  if (hem) box(J.hips, .46 * b, Math.min(hem, .26), .27 * b, 0, .04 - Math.min(hem, .26), 0, d.oben);
  if (hem > .3) { J.skirt = [-1, 1].map(s => { const k = piv(J.hips, s * .11 * b, -.08, 0); const lp = Math.min(hem - .1, .3); box(k, .24 * b, lp, .29 * b, s * .01, -.1 - lp, 0, d.oben); return k; }); /* same pivot as the thigh */ /* Runde 116: panels end at the knee and follow the thigh fully - below the knee the shin bends back and cut through a longer panel */ }
  if (d.stil === 'kleid') cyl(J.hips, (d.kurz ? .27 : .32) * b, .19 * b, d.kurz ? .34 : .58, 0, d.kurz ? -.3 : -.54, 0, d.oben, 10);
  J.chest = piv(J.hips, 0, .06, 0);
  if (fem) { cyl(J.chest, .16 * b, .22 * b, .3, 0, 0, 0, d.oben); cyl(J.chest, .22 * b, .2 * b, .2, 0, .3, 0, d.oben); } else cyl(J.chest, .2 * b, .23 * b, .5, 0, 0, 0, d.oben);
  if (d.stil === 'weste') { cyl(J.chest, .215 * b, .245 * b, .4, 0, .04, 0, d.besatz); }
  if (d.stil === 'jacke' || d.stil === 'mantel' || d.stil === 'kittel') box(J.chest, .05, .42, .02, 0, .04, .225 * b, d.besatz); // zip / button line
  if (d.streifen) for (const y of [.12, .3]) cyl(J.chest, .218 * b, .232 * b, .05, 0, y, 0, d.streifen);
  if (d.stern) box(J.chest, .08, .08, .02, -.1, .32, .235 * b, '#e8c21e');
  if (d.schrift) { const p = new THREE.Mesh(new THREE.PlaneGeometry(.4 * b, .1), label(d.schrift, d.streifen || '#ffffff')); p.position.set(0, .38, -.236 * b); p.rotation.y = Math.PI; J.chest.add(p); }
  cyl(J.chest, .16 * b, .17 * b, .1, 0, .48, 0, d.schal ? d.besatz : d.oben);
  if (d.schal) { J.scarf = piv(J.chest, .08, .5, .15 * b); box(J.scarf, .09, .32, .04, 0, -.32, 0, d.besatz); }
  if (d.ruecken === 'rucksack') { const pc = d.packFarbe || '#5a3a26'; J.pack = piv(J.chest, 0, .45, -.2 * b); box(J.pack, .32, .36, .14, 0, -.4, -.06, pc); box(J.pack, .34, .07, .16, 0, -.08, -.06, '#3e2818'); }
  if (d.tarn) for (const [x, y, w, h] of [[-.1, .1, .12, .1], [.12, .25, .1, .12], [-.05, .36, .14, .07], [.08, .02, .09, .08]]) { box(J.chest, w, h, .02, x, y, .228 * b, d.tarn); box(J.chest, w, h, .02, -x, y + .04, -.228 * b, d.tarn); }
  if (d.ruecken === 'flasche') { J.pack = piv(J.chest, 0, .45, -.2 * b); for (const x of [-.08, .08]) cyl(J.pack, .075, .075, .42, x, -.46, -.08, '#c9cdd2'); }
  if (d.ruecken === 'tasche') { J.pack = piv(J.chest, .2 * b, .4, 0); box(J.pack, .1, .3, .3, .06, -.62, 0, '#6b4a2e'); }
  if (d.ruecken === 'pizzabox') { J.pack = piv(J.chest, 0, .45, -.2 * b); box(J.pack, .42, .42, .2, 0, -.44, -.1, '#c4262a'); }
  if (d.ruecken === 'umhang') { J.pack = piv(J.chest, 0, .48, -.2 * b); box(J.pack, .5 * b, 1.05, .04, 0, -1.05, -.02, d.besatz); }
  J.neck = piv(J.chest, 0, .56, 0); const H = J.neck;
  cyl(H, .17, .17, .34, 0, .02, 0, d.haut);
  box(H, .05, .06, .05, 0, .13, .17, d.haut === '#c9cdd2' ? '#9aa0a6' : '#c98d66');
  for (const s of [-1, 1]) box(H, .045, .06, .02, s * .07, .19, .165, '#1a1410');
  if (d.brille) box(H, .3, .07, .03, 0, .18, .175, '#121214');
  if (fem) box(H, .1, .025, .02, 0, .08, .171, '#b0303a');
  const hair = d.haar;
  if (d.frisur === 'kurz') { cyl(H, .175, .175, .1, 0, .26, 0, hair); box(H, .32, .2, .06, 0, .1, -.15, hair); }
  if (d.frisur === 'lang') { cyl(H, .178, .178, .12, 0, .25, 0, hair); box(H, .34, .42, .08, 0, -.06, -.14, hair); }
  if (d.frisur === 'zopf') { cyl(H, .178, .178, .12, 0, .25, 0, hair); box(H, .32, .16, .06, 0, .14, -.15, hair); box(H, .09, .28, .08, 0, -.12, -.2, hair); }
  if (d.frisur === 'irokese') box(H, .06, .14, .34, 0, .34, 0, hair);
  const kc = d.kopfFarbe || '#444';
  switch (d.kopf) {
    case 'hut': cyl(H, .34, .34, .035, 0, .32, 0, kc, 10); cyl(H, .18, .16, .17, 0, .35, 0, kc); cyl(H, .185, .185, .05, 0, .35, 0, d.oben); break;
    case 'cowboy': cyl(H, .4, .4, .03, 0, .32, 0, kc, 10); box(H, .1, .04, .8, -.36, .33, 0, kc); box(H, .1, .04, .8, .36, .33, 0, kc); cyl(H, .17, .13, .2, 0, .34, 0, kc); cyl(H, .175, .175, .04, 0, .35, 0, '#2a1d14'); break;
    case 'kappe': cyl(H, .185, .17, .13, 0, .27, 0, kc); box(H, .26, .03, .16, 0, .29, .22, kc); break;
    case 'polizei': cyl(H, .185, .19, .1, 0, .28, 0, '#16181c'); cyl(H, .19, .22, .08, 0, .38, 0, kc); box(H, .3, .03, .12, 0, .28, .22, '#16181c'); box(H, .06, .05, .02, 0, .32, .19, '#e8c21e'); break;
    case 'fwhelm': cyl(H, .21, .14, .22, 0, .26, 0, kc); box(H, .34, .16, .05, 0, .14, -.19, '#2a3140'); cyl(H, .212, .2, .04, 0, .3, 0, '#e8c21e'); box(H, .3, .1, .02, 0, .14, .19, '#9fd8ff'); break;
    case 'bauhelm': cyl(H, .23, .23, .02, 0, .29, 0, kc, 10); cyl(H, .2, .14, .17, 0, .29, 0, kc); break;
    case 'kochmuetze': cyl(H, .175, .175, .08, 0, .27, 0, kc); cyl(H, .19, .22, .24, 0, .35, 0, kc); break;
    case 'muetze': cyl(H, .185, .12, .22, 0, .24, 0, kc); cyl(H, .19, .19, .05, 0, .24, 0, d.besatz); break;
    case 'haube': cyl(H, .19, .15, .2, 0, .22, 0, kc); box(H, .36, .3, .06, 0, -.02, -.15, kc); break;
    case 'ritterhelm': cyl(H, .2, .2, .42, 0, -.02, 0, kc); cyl(H, .2, .1, .1, 0, .4, 0, kc); box(H, .26, .03, .02, 0, .19, .2, '#16181c'); box(H, .03, .14, .22, 0, .48, -.02, d.besatz); break;
    case 'visier': box(H, .36, .07, .06, 0, .17, .15, kc); break;
    case 'militaerhelm': cyl(H, .225, .15, .2, 0, .25, 0, kc); cyl(H, .23, .23, .03, 0, .24, 0, kc, 10); box(H, .16, .05, .02, 0, .3, .2, '#3a3f22'); break;
    case 'barett': box(H, .38, .07, .36, .03, .3, 0, kc); box(H, .05, .05, .02, -.1, .32, .18, '#e8c21e'); break;
  }
  J.upper = []; J.fore = []; J.thigh = []; J.shin = []; J.foot = []; J.hand = [];
  for (const [i, s] of [[0, -1], [1, 1]]) { // 0 = right side (x < 0, front = +z), 1 = left
    const sh = piv(J.chest, s * .27 * b, .42, 0); cyl(sh, .085 * lb, .075 * lb, .3, 0, -.3, 0, d.oben, 6); J.upper.push(sh);
    const el = piv(sh, 0, -.3, 0); cyl(el, .072 * lb, .06 * lb, .26, 0, -.26, 0, d.stil === 'weste' || d.stil === 'hemd' ? d.oben : d.oben, 6); box(el, .11, .11, .11, 0, -.36, 0, d.haut); J.fore.push(el);
    J.hand.push(piv(el, 0, -.33, .04));
    const hp = piv(J.hips, s * .11 * b, -.08, 0); cyl(hp, .095 * lb, .11 * lb, .4, 0, -.4, 0, d.stil === 'mantel' ? d.hose : d.hose, 6); J.thigh.push(hp);
    const kn = piv(hp, 0, -.4, 0); cyl(kn, .075 * lb, .09 * lb, .4, 0, -.4, 0, d.hose, 6); J.shin.push(kn);
    const ft = piv(kn, 0, -.4, 0); if (d.absatz) { box(ft, .12, .1, .22, 0, -.06, .09, d.schuhe); box(ft, .05, .1, .05, 0, -.14, -.06, d.schuhe); } else box(ft, .15, .12, .3, 0, -.12, .07, d.schuhe); J.foot.push(ft);
  }
  g.userData = J; return J;
}

/* procedural pose: s = {walk 0..1, run 0..1, phase, air 0..1, tuck 0..1, crouch 0..1, t} - same curves as the Blender study */
function pose(J, s) {
  const sin = Math.sin, p = s.phase, A = .55 + .45 * s.run, w = s.walk;
  for (let i = 0; i < 2; i++) { const q = p + i * Math.PI;
    J.thigh[i].rotation.set(-sin(q) * A * w - s.crouch * .6 - s.tuck * 1.3, 0, 0);
    J.shin[i].rotation.x = Math.max(0, sin(q + 1.3)) * (.9 + .8 * s.run) * w + s.crouch * 1.1 + s.tuck * 1.9;
    J.foot[i].rotation.x = (-Math.max(0, sin(q - .4)) * .35 + .1) * w - s.crouch * .4 + s.air * .3;
    J.upper[i].rotation.set(sin(q) * A * (.75 + .15 * s.run) * w + s.crouch * .6 - s.air * 2.2 * (1 - s.tuck * .5), 0, (i ? 1 : -1) * (.08 + s.air * .35));
    J.fore[i].rotation.x = -(.35 + (.25 + .85 * s.run) * w + Math.max(0, sin(q)) * .3 * w) * (1 - s.air * .4) - s.tuck * .6;
  }
  J.hips.position.y = .92 + (Math.abs(sin(p)) * (.035 + .035 * s.run) - .02 - .04 * s.run) * w - s.crouch * .18;
  J.hips.rotation.set(0, sin(p) * .12 * w, 0);
  J.chest.rotation.set((.06 + .22 * s.run) * w + s.crouch * .35 - s.air * .1, -sin(p) * .16 * w, 0);
  J.neck.rotation.set(-(.05 + .15 * s.run) * w, 0, 0);
  if (J.pack) J.pack.rotation.x = (.06 + Math.abs(sin(p + .6)) * (.1 + .15 * s.run)) * w + s.air * .25;
  if (J.skirt) for (let i = 0; i < 2; i++) J.skirt[i].rotation.x = J.thigh[i].rotation.x;
  if (J.scarf) J.scarf.rotation.x = .3 + Math.abs(sin(p + .9)) * (.35 + .55 * s.run) * w + s.air * 1.1;
  /* Runde 267 (Nutzer: 'she does not swim yet' - she walked on in the water): s.swim 0..1 - moving: front crawl, the body lies flat just under
     the surface (raised 0.45 m in its group, the game keeps the feet 1.5 m deep), arms circle in turn, the body rolls, the legs flutter; standing
     still: treading water, upright, arms sculling and legs pedalling */
  const sw = s.swim || 0; J.root.position.y = 0; if (sw <= 0) return;
  const mv = Math.min(1, w * 1.6), t = s.t || 0, mix = (a, b) => a + (b - a) * sw;
  J.root.position.y = mix(0, .26 * mv + .2 * (1 - mv)); /* Runde 268 (Nutzer: legs out of the water): lower, the legs slope down */
  J.hips.rotation.x = mix(J.hips.rotation.x, 1.25 * mv); J.hips.rotation.y = mix(J.hips.rotation.y, 0);
  J.chest.rotation.set(mix(J.chest.rotation.x, 0), mix(J.chest.rotation.y, sin(p) * .45 * mv), 0);
  J.neck.rotation.x = mix(J.neck.rotation.x, -1.05 * mv + .05);
  for (let i = 0; i < 2; i++) { const q = p + i * Math.PI, tq = t * 3.2 + i * Math.PI;
    const crawl = ((q % 6.2832) + 6.2832) % 6.2832 /* Runde 272 (Nutzer: arms turned the wrong way): the pull goes front -> down -> back under water, the arm comes forward over the water */, tread = sin(tq) * .35;
    J.upper[i].rotation.set(mix(J.upper[i].rotation.x, crawl * mv + .2 * (1 - mv)), 0, mix(J.upper[i].rotation.z, (i ? 1 : -1) * (.15 * mv + (.9 + tread) * (1 - mv))));
    J.fore[i].rotation.x = mix(J.fore[i].rotation.x, -.35 * mv - .5 * (1 - mv));
    if (i === 0 && s.hold) { /* Runde 275 (Nutzer: an item in the hand - that arm does not circle): held forward above the water, the other arm swims */
      J.upper[0].rotation.set(mix(J.upper[0].rotation.x, 2.6 * mv - 2.0 * (1 - mv)), 0, mix(J.upper[0].rotation.z, -.12)); J.fore[0].rotation.x = mix(J.fore[0].rotation.x, -.15); }
    J.thigh[i].rotation.set(mix(J.thigh[i].rotation.x, (-.5 + sin(q * 2.5) * .18) * mv + (-.5 + sin(tq) * .35) * (1 - mv)), 0, 0);
    J.shin[i].rotation.x = mix(J.shin[i].rotation.x, (.05 + Math.max(0, sin(q * 2.5 + 1)) * .15) * mv + (.8 + sin(tq + 1) * .4) * (1 - mv));
    J.foot[i].rotation.x = mix(J.foot[i].rotation.x, .3 * mv); } /* Runde 269: thighs turn against the lean of the body (-0.5): the legs slope 45 degrees down, not up */
  if (J.skirt) for (let i = 0; i < 2; i++) J.skirt[i].rotation.x = J.thigh[i].rotation.x;
}
/* Runde 277: soft joints - when the pose jumps (an item taken, into the water, landing, end of a flip), every joint keeps where it was and
   glides to the new pose on a critically damped spring (no overshoot, settled in ~0.3 s). Steady motion (walking, crawling) passes
   unchanged: only a change larger than the motion of one frame counts as a jump. Angles wrap, so a full turn of the crawl is no jump. */
function glatt(J, dt, w = 14) { if (!(dt > 0)) return;
  let S = J._glatt; if (!S) { S = J._glatt = []; const add = o => { if (o && o.isObject3D) S.push({ o, t: [0, 0, 0, 0], off: [0, 0, 0, 0], v: [0, 0, 0, 0], first: true }); };
    for (const k of ['root', 'hips', 'chest', 'neck', 'pack', 'scarf', 'upper', 'fore', 'thigh', 'shin', 'foot', 'skirt']) { const v = J[k]; if (Array.isArray(v)) v.forEach(add); else add(v); } } /* only what pose() sets every frame */
  const thr = Math.max(.3, 12 * dt), PI2 = Math.PI * 2;
  for (const c of S) { const o = c.o, now = [o.rotation.x, o.rotation.y, o.rotation.z, o.position.y];
    for (let k = 0; k < 4; k++) { let d = now[k] - c.t[k]; if (k < 3) d -= Math.round(d / PI2) * PI2;
      if (!c.first && Math.abs(d) > thr) c.off[k] -= d;
      const a = -w * w * c.off[k] - 2 * w * c.v[k]; c.v[k] += a * dt; c.off[k] += c.v[k] * dt; if (Math.abs(c.off[k]) < 1e-4 && Math.abs(c.v[k]) < 1e-3) c.off[k] = c.v[k] = 0;
      c.t[k] = now[k]; }
    c.first = false; o.rotation.set(now[0] + c.off[0], now[1] + c.off[1], now[2] + c.off[2]); o.position.y = now[3] + c.off[3]; } }
window.HXFIG = { KATALOG, make, pose, glatt, byId: id => { if (id === 'eigen') { try { const d = JSON.parse(localStorage.getItem('hx.figurEigen')); if (d) return d; } catch (e) {} } return KATALOG.find(r => r.id === id) || KATALOG[0]; } };
})();
