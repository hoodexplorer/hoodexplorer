/* HoodExplorer – Lautstärke je Bereich (Runde 187).
   Alle Töne laufen über einen Regler je Bereich (GainNode je AudioContext und Bereich) statt direkt an den Ausgang; die Werte stehen in
   den Einstellungen unter „Ton“ (0 = aus) und bleiben im Gerät gespeichert (hx.ton). Gesamt wirkt auf alle Bereiche. */
(() => {
  const CATS = [['gesamt', 'Gesamt'], ['schritte', 'Schritte'], ['wasser', 'Wasser (Ufer, Bach, Fische)'], ['wetter', 'Wetter (Regen, Donner)'],
    ['fahrzeug', 'Fahrzeug (Motor, Reifen)'], ['aufprall', 'Aufprall (Auto)'], ['explosion', 'Explosionen'], ['sirene', 'Sirene'], ['gore', 'Gore'], ['effekte', 'Effekte (Münzen, Kisten)']];
  const D = { gesamt: .8, schritte: .7, wasser: .4, wetter: .7, fahrzeug: .7, aufprall: .7, explosion: .7, sirene: .5, gore: .8, effekte: .7 }; // Runde 189: Aufprall separate
  const v = Object.assign({}, D); try { Object.assign(v, JSON.parse(localStorage.getItem('hx.ton') || '{}')); } catch (e) { }
  const nodes = [], g = c => c === 'gesamt' ? v.gesamt : v.gesamt * (v[c] === undefined ? 1 : v[c]);
  function node(ac, cat) { for (const n of nodes) if (n[0] === ac && n[1] === cat) return n[2];
    const gn = ac.createGain(); gn.gain.value = g(cat); gn.connect(ac.destination); nodes.push([ac, cat, gn]); return gn; }
  function apply() { for (const [ac, cat, gn] of nodes) gn.gain.setTargetAtTime(g(cat), ac.currentTime, .05); }
  function set(c, x) { v[c] = x; try { localStorage.setItem('hx.ton', JSON.stringify(v)); } catch (e) { } apply(); }
  window.HXSND = { node, set, get: c => v[c], g, CATS, D };
  function ui() { const anchor = document.querySelector('details.grp[data-g="gore"]'); if (!anchor || document.querySelector('details.grp[data-g="ton"]')) return;
    const d = document.createElement('details'); d.className = 'grp'; d.dataset.g = 'ton';
    d.innerHTML = '<summary>Ton</summary><div class="grpb"><p class="small">Lautstärke je Bereich – ganz links ist aus.</p></div>'; const b = d.querySelector('.grpb'), inputs = [];
    for (const [c, name] of CATS) { const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = '<span></span><span class="rv"><input type="range" min="0" max="1" step="0.05"> <span class="tv"></span></span>'; row.firstChild.textContent = name;
      const r = row.querySelector('input'), lab = row.querySelector('.tv'); r.setAttribute('aria-label', 'Lautstärke ' + name); r.value = v[c];
      const show = () => { lab.textContent = +r.value === 0 ? 'aus' : Math.round(r.value * 100) + ' %'; }; show();
      r.addEventListener('input', () => { set(c, +r.value); show(); }); inputs.push([c, r, show]); b.appendChild(row); }
    const rs = document.createElement('div'); rs.className = 'row'; rs.innerHTML = '<button class="pl" type="button">Standard</button>';
    rs.querySelector('button').addEventListener('click', () => { for (const [c, r, show] of inputs) { r.value = D[c]; set(c, D[c]); show(); } }); b.appendChild(rs);
    anchor.parentNode.insertBefore(d, anchor); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui); else ui();
})();
