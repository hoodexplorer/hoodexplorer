/* HoodExplorer – Zurück-Wischen abfangen (Runde 134). Auf dem Handy führt das Wischen vom Rand (Android „Zurück“) sonst zur
   vorherigen Seite – das Spiel ist plötzlich weg. Hier liegt ein eigener Eintrag im Verlauf über der Spielseite:
   - Zurück schließt zuerst das oberste offene Fenster (Figur, Fahrzeuge, Rucksack, Optionen, große Karte, Profil) – über dessen
     eigenen Schließen-Knopf, damit alles wie beim Antippen passiert.
   - Ist nichts offen, fragt eine Abfrage mit großen Knöpfen: „Weiterspielen“ (groß, oben) oder „Spiel verlassen“.
   Chrome überspringt beim Zurück Verlaufseinträge, die ohne Antippen angelegt wurden; darum wird der Eintrag bei jedem Antippen
   bei Bedarf neu gesetzt (höchstens 2 eigene Einträge). Kostet nichts pro Bild. */
(() => {
  const $ = id => document.getElementById(id);
  const TOP = [['feSheet', 'feClose'], ['fzSheet', 'fzClose'], ['inv', 'invClose'], ['sheet', 'bClose'], ['orte', 'orClose'], ['orRec', 'orRecX'], ['bigmap', 'bmClose'], ['profile', 'pClose']];
  let depth = 0, noGest = false, leaving = false;
  try { history.replaceState({ hx: 'basis' }, '', location.href); } catch (e) {}
  const push = gest => { try { history.pushState({ hx: 'wache' }, '', location.href); depth++; noGest = !gest; } catch (e) {} };
  const arm = () => { if (leaving) return; if (depth < 1 || (depth === 1 && noGest)) push(true); };
  addEventListener('pointerdown', arm, true); addEventListener('keydown', arm, true);

  document.body.insertAdjacentHTML('beforeend', `<div class="leaveq" id="leaveQ" hidden role="dialog" aria-modal="true" aria-labelledby="lqT">
    <div class="lq-card glass"><div class="lq-t" id="lqT">Spiel verlassen?</div>
      <p class="lq-p">Du hast zurück gewischt. Wenn du verlässt, wird die Seite geschlossen.</p>
      <button class="act wide lq-stay" id="lqStay" type="button">Weiterspielen</button>
      <button class="lq-go" id="lqGo" type="button">Spiel verlassen</button></div></div>`);
  const box = $('leaveQ');
  const ask = () => { box.hidden = false; $('lqStay').focus(); };
  $('lqStay').addEventListener('click', () => { box.hidden = true; });
  box.addEventListener('click', e => { if (e.target === box) box.hidden = true; }); // tap beside the card: keep playing
  $('lqGo').addEventListener('click', () => { leaving = true; box.hidden = true; history.go(-(depth + 1));
    setTimeout(() => { if (document.visibilityState === 'visible') { leaving = false; arm(); // no earlier page (opened directly): nothing to go back to
      const t = $('toast'); if (t) { t.textContent = 'Hier gibt es keine vorherige Seite – den Tab bitte über den Browser schließen'; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 3500); } } }, 700); });

  function closeTop() {
    if (!box.hidden) { box.hidden = true; return true; } // back again while asking: keep playing
    for (const [p, c] of TOP) { const el = $(p), b = $(c); if (el && !el.hidden && b && !b.hidden) { b.click(); return true; } }
    return false;
  }
  addEventListener('popstate', () => {
    if (leaving) return;
    depth = Math.max(0, depth - 1);
    if (!closeTop()) ask();
    if (depth === 0) push(false); // best effort right away; the next tap sets one Chrome will not skip
  });
  window.HXZB = { get depth() { return depth; }, ask, closeTop };
})();
