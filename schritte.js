/* HoodExplorer – Schrittgeräusche auf nassem Boden, in Pfützen, auf Schnee und Eis (Runde 179).
   Werden beim Start Abtastwert für Abtastwert berechnet (je 6 Varianten) und beim Gehen zufällig, leicht verstimmt abgespielt.
   Grundlagen (Recherche):
   - Körnige Böden (Schnee, Kies): ein Schritt = viele winzige Bruch-Impulse in zufälligen Abständen (exponentiell verteilt), in
     Fersen- und Ballenphase (Nordahl/Serafin/Turchet, Aalborg: „crumpling“-Modell; Cook: PhISEM).
   - Wasser: der Klang kommt von Luftblasen. Blase mit Radius r schwingt mit f ≈ 3/r (Minnaert), klingt ab mit
     d = 0,13/r + 0,0072·r^-1,5 und steigt leicht in der Tonhöhe: f(t) = f0·(1 + 0,1·d·t) (van den Doel).
   Regel (Runde 180): Laufgeräusche nie hell - Schwerpunkt um 1,5–2,5 kHz, beim Abspielen zusätzlich Tiefpass 3 kHz (nerven sonst auf Dauer).
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
  function bubbleW(buf, sr, t0, r, amp) { const L = buf.length, f0 = 3 / r, d = .13 / r + .0072 * Math.pow(r, -1.5), sg = .1 * d, n0 = Math.floor(t0 * sr), n = Math.floor(6 / d * sr); let ph = 0; // wraps round: for loops
    for (let i = 0; i < n; i++) { const t = i / sr; ph += 2 * Math.PI * f0 * (1 + sg * t) / sr; buf[(n0 + i) % L] += amp * Math.sin(ph) * Math.exp(-d * t) * Math.min(1, t / .0004); } }
  function loopNoise(buf, sr, type, f, q, amp) { const L = buf.length, X = Math.floor(.25 * sr), tmp = new Float32Array(L + X); noise(tmp, sr, 0, 1e3, type, f, q, amp, .0001); // steady filtered noise, crossfaded into a seamless loop
    for (let i = 0; i < L; i++) buf[i] += i < X ? tmp[i] * (i / X) + tmp[L + i] * (1 - i / X) : tmp[i]; }
  function population(buf, sr, rate, rLo, rHi, gam, amp) { const L = buf.length / sr; let t = 0; // bubbles of a size distribution 1/r^gam (van den Doel)
    while ((t += -Math.log(1 - R() * .999) / rate) < L) { let r; do { r = rLo + R() * (rHi - rLo); } while (R() > Math.pow(rLo / r, gam));
      bubbleW(buf, sr, t, r, amp * Math.pow(r / rHi, .6) * (.4 + .6 * R())); } }
  function grains(buf, sr, t0, t1, rate, amp, fLo, fHi, dur0, dur1) { // Knirsch-Körner: Poisson-Folge winziger Rauschimpulse
    let t = t0; while (true) { t += -Math.log(1 - R() * .999) / rate; if (t > t1) break; const fade = 1 - (t - t0) / (t1 - t0) * .6, a = amp * fade * (.15 + .85 * Math.pow(R(), 2.5));
      noise(buf, sr, t, dur0 + R() * (dur1 - dur0), 'bp', fLo + R() * (fHi - fLo), 1.4 + R() * 2.6, a, .0003); } }
  function norm(buf, peak = .9) { let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); if (m > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / m; return buf; }
  const K = {
    // Runde 181: water - swimming strokes, shore lapping, quay slaps; loops for brooks/rivers and rain on water. Dark like the steps.
    swim(sr) { const b = new Float32Array(Math.floor(.5 * sr)); noise(b, sr, 0, .06, 'bp', 450 + R() * 150, .7, .8, .01); thump(b, sr, 0, 75, 20, .25);
      noise(b, sr, .02, .14, 'bp', 1000 + R() * 300, .6, .2, .015); const n = 5 + Math.floor(R() * 4); for (let i = 0; i < n; i++) bubble(b, sr, .02 + R() * .3, (2.5 + R() * 4) / 1000, .25 + R() * .25); return norm(b, .8); },
    lap(sr) { const b = new Float32Array(Math.floor(.7 * sr)); noise(b, sr, 0, .3, 'lp', 380, .7, .7, .06); const n = 2 + Math.floor(R() * 3);
      for (let i = 0; i < n; i++) bubble(b, sr, .05 + R() * .3, (4 + R() * 5) / 1000, .35 + R() * .3); noise(b, sr, .35, .2, 'bp', 700, .7, .12, .03); return norm(b, .7); },
    slap(sr) { const b = new Float32Array(Math.floor(.4 * sr)); noise(b, sr, 0, .05, 'bp', 380 + R() * 120, .8, 1, .006); thump(b, sr, 0, 65, 25, .3);
      for (let i = 0; i < 2; i++) bubble(b, sr, .03 + R() * .15, (3 + R() * 4) / 1000, .2); return norm(b, .7); },
    brook(sr) { const b = new Float32Array(Math.floor(2.4 * sr)); loopNoise(b, sr, 'lp', 700, .6, .5); population(b, sr, 140, 1.5 / 1000, 7 / 1000, 1.6, .5); return norm(b, .7); },
    rainwater(sr) { const b = new Float32Array(Math.floor(2.0 * sr)); loopNoise(b, sr, 'bp', 1300, .5, .25); population(b, sr, 260, 1.2 / 1000, 3 / 1000, 1.0, .35); return norm(b, .6); },
    snow(sr) { const b = new Float32Array(Math.floor(.34 * sr)); // Ferse: dumpfer Druck + dichtes Knirschen, Ballen: leiser, kürzer
      noise(b, sr, 0, .06, 'lp', 300, .7, .28, .004); thump(b, sr, 0, 70, 50, .08);
      grains(b, sr, .004, .13, 320 + R() * 120, .8, 600, 2800, .002, .006);
      noise(b, sr, .15, .045, 'lp', 320, .7, .12, .004); grains(b, sr, .152, .27, 220 + R() * 80, .5, 700, 3000, .0018, .0055); return norm(b); },
    splash(sr) { const b = new Float32Array(Math.floor(.42 * sr)); // Pfütze: Klatschen + Plumps, Spritzer, Blasen; Ballen hebt ab: Tropfen
      noise(b, sr, 0, .03, 'bp', 450 + R() * 200, .7, 1, .0015); thump(b, sr, 0, 85 + R() * 20, 32, .5);
      noise(b, sr, .006, .1 + R() * .04, 'bp', 1200 + R() * 500, .6, .25, .006);
      const nb = 4 + Math.floor(R() * 4); for (let i = 0; i < nb; i++) bubble(b, sr, .008 + R() * .14, (2 + R() * 4) / 1000, .25 + R() * .3);
      noise(b, sr, .2, .04, 'bp', 1400, .7, .07, .004); for (let i = 0; i < 2; i++) bubble(b, sr, .21 + R() * .1, (1.6 + R() * 1.6) / 1000, .12 + R() * .1); return norm(b); },
    wet(sr) { const b = new Float32Array(Math.floor(.26 * sr)); // nasser Boden ohne Pfütze: feuchtes Klatschen, kaum Blasen
      noise(b, sr, 0, .022, 'bp', 650 + R() * 300, .8, 1, .001); thump(b, sr, 0, 105 + R() * 25, 55, .14); noise(b, sr, .003, .04, 'bp', 1400, .7, .1, .003);
      if (R() < .7) bubble(b, sr, .02 + R() * .04, (1.6 + R() * 1.4) / 1000, .16);
      noise(b, sr, .13, .02, 'bp', 800 + R() * 300, .9, .45, .001); return norm(b, .8); },
    ice(sr) { const b = new Float32Array(Math.floor(.24 * sr)); // gefrorene Pfütze / Glatteis: harter Tritt, wenige helle Risse
      thump(b, sr, 0, 120, 70, .1); noise(b, sr, 0, .012, 'bp', 1300, 1.2, .8, .0005);
      grains(b, sr, .003, .08, 90, .7, 1600, 4200, .0012, .0035); noise(b, sr, .12, .01, 'bp', 1400, 1.2, .4, .0005); return norm(b, .8); }
  };
  function bank(kind, sr, n = 6) { const out = []; for (let i = 0; i < n; i++) { seed = 1 + i * 7919 + kind.length * 104729; out.push(K[kind](sr)); } return out; }
  const api = { bank, kinds: Object.keys(K) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HXSTEP = api;
})(typeof window !== 'undefined' ? window : this);
