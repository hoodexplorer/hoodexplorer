/* HoodExplorer – Schrittgeräusche auf nassem Boden, in Pfützen, auf Schnee und Eis (Runde 179).
   Werden beim Start Abtastwert für Abtastwert berechnet (je 6 Varianten) und beim Gehen zufällig, leicht verstimmt abgespielt.
   Grundlagen (Recherche):
   - Körnige Böden (Schnee, Kies): ein Schritt = viele winzige Bruch-Impulse in zufälligen Abständen (exponentiell verteilt), in
     Fersen- und Ballenphase (Nordahl/Serafin/Turchet, Aalborg: „crumpling“-Modell; Cook: PhISEM).
   - Wasser: der Klang kommt von Luftblasen. Blase mit Radius r schwingt mit f ≈ 3/r (Minnaert), klingt ab mit
     d = 0,13/r + 0,0072·r^-1,5 und steigt leicht in der Tonhöhe: f(t) = f0·(1 + 0,1·d·t) (van den Doel).
   Läuft im Browser (window.HXSTEP) und in Node (module.exports) – für die Vergleichsdateien. */
(function (root) {
  let seed = 1; const R = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  function bq(type, f, q, sr) { // RBJ-Biquad (Koeffizienten normiert)
    const w = 2 * Math.PI * Math.min(f, sr * .45) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); let b0, b1, b2;
    if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; } else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    const a0 = 1 + al; return [b0 / a0, b1 / a0, b2 / a0, -2 * c / a0, (1 - al) / a0];
  }
  // gefiltertes Rauschen mit Hüllkurve: Anstieg att, Dauer dur (exponentielles Abklingen auf ~1 %)
  function noise(buf, sr, t0, dur, type, f, q, amp, att = .001) {
    const k = bq(type, f, q, sr), n0 = Math.floor(t0 * sr), n = Math.floor((dur + .01) * sr); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n && n0 + i < buf.length; i++) { const t = i / sr, e = t < att ? t / att : Math.exp(-4.6 * (t - att) / dur), x = (R() * 2 - 1) * e;
      const y = k[0] * x + k[1] * x1 + k[2] * x2 - k[3] * y1 - k[4] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; buf[n0 + i] += y * amp; }
  }
  function thump(buf, sr, t0, f, dec, amp) { const n0 = Math.floor(t0 * sr), n = Math.floor(5 / dec * sr); // tiefer, schnell abklingender Ton (der Fuß drückt auf)
    for (let i = 0; i < n && n0 + i < buf.length; i++) { const t = i / sr; buf[n0 + i] += amp * Math.sin(2 * Math.PI * f * t * (1 - .25 * Math.min(1, t * dec / 3))) * Math.exp(-dec * t) * Math.min(1, t / .002); } }
  function bubble(buf, sr, t0, r, amp) { // eine Luftblase (r in Metern)
    const f0 = 3 / r, d = .13 / r + .0072 * Math.pow(r, -1.5), sg = .1 * d, n0 = Math.floor(t0 * sr), n = Math.floor(6 / d * sr); let ph = 0;
    for (let i = 0; i < n && n0 + i < buf.length; i++) { const t = i / sr; ph += 2 * Math.PI * f0 * (1 + sg * t) / sr; buf[n0 + i] += amp * Math.sin(ph) * Math.exp(-d * t) * Math.min(1, t / .0004); } }
  function grains(buf, sr, t0, t1, rate, amp, fLo, fHi, dur0, dur1) { // Knirsch-Körner: Poisson-Folge winziger Rauschimpulse
    let t = t0; while (true) { t += -Math.log(1 - R() * .999) / rate; if (t > t1) break; const fade = 1 - (t - t0) / (t1 - t0) * .6, a = amp * fade * (.15 + .85 * Math.pow(R(), 2.5));
      noise(buf, sr, t, dur0 + R() * (dur1 - dur0), 'bp', fLo + R() * (fHi - fLo), 1.4 + R() * 2.6, a, .0003); } }
  function norm(buf, peak = .9) { let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); if (m > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / m; return buf; }
  const K = {
    snow(sr) { const b = new Float32Array(Math.floor(.34 * sr)); // Ferse: dumpfer Druck + dichtes Knirschen, Ballen: leiser, kürzer
      noise(b, sr, 0, .06, 'lp', 300, .7, .28, .004); thump(b, sr, 0, 70, 50, .08);
      grains(b, sr, .004, .13, 320 + R() * 120, .8, 1200, 5500, .0015, .005);
      noise(b, sr, .15, .045, 'lp', 320, .7, .12, .004); grains(b, sr, .152, .27, 220 + R() * 80, .5, 1400, 6000, .0012, .0045); return norm(b); },
    splash(sr) { const b = new Float32Array(Math.floor(.42 * sr)); // Pfütze: Klatschen + Plumps, Spritzer, Blasen; Ballen hebt ab: Tropfen
      noise(b, sr, 0, .03, 'bp', 650 + R() * 250, .7, 1, .0015); thump(b, sr, 0, 85 + R() * 20, 32, .5);
      noise(b, sr, .006, .1 + R() * .04, 'bp', 2200 + R() * 900, .6, .3, .006);
      const nb = 4 + Math.floor(R() * 4); for (let i = 0; i < nb; i++) bubble(b, sr, .008 + R() * .14, (1.1 + R() * 3.4) / 1000, .25 + R() * .3);
      noise(b, sr, .2, .04, 'bp', 2600, .7, .08, .004); for (let i = 0; i < 2; i++) bubble(b, sr, .21 + R() * .1, (.9 + R() * 1.3) / 1000, .12 + R() * .1); return norm(b); },
    wet(sr) { const b = new Float32Array(Math.floor(.26 * sr)); // nasser Boden ohne Pfütze: feuchtes Klatschen, kaum Blasen
      noise(b, sr, 0, .022, 'bp', 1100 + R() * 500, .8, 1, .001); thump(b, sr, 0, 105 + R() * 25, 55, .14); noise(b, sr, .003, .04, 'bp', 2600, .7, .12, .003);
      if (R() < .7) bubble(b, sr, .02 + R() * .04, (.7 + R() * .8) / 1000, .18);
      noise(b, sr, .13, .02, 'bp', 1500 + R() * 400, .9, .45, .001); return norm(b, .8); },
    ice(sr) { const b = new Float32Array(Math.floor(.24 * sr)); // gefrorene Pfütze / Glatteis: harter Tritt, wenige helle Risse
      thump(b, sr, 0, 120, 70, .1); noise(b, sr, 0, .012, 'bp', 2400, 1.2, .8, .0005);
      grains(b, sr, .003, .08, 90, .7, 3500, 9000, .0008, .0025); noise(b, sr, .12, .01, 'bp', 2600, 1.2, .4, .0005); return norm(b, .8); }
  };
  function bank(kind, sr, n = 6) { const out = []; for (let i = 0; i < n; i++) { seed = 1 + i * 7919 + kind.length * 104729; out.push(K[kind](sr)); } return out; }
  const api = { bank, kinds: Object.keys(K) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HXSTEP = api;
})(typeof window !== 'undefined' ? window : this);
