/* HoodExplorer – Ausfall-Simulator (Runde 120). Nur zum Testen: ?ausfall=karte,gelaende lässt die Abrufe dieser Quellen
   scheitern, im Spiel (Seite) und in der Hintergrundberechnung (Worker) gleich. Ohne Parameter tut die Datei nichts.
   Form je Eintrag:  name        Netzfehler sofort
                     name:500    Antwort mit HTTP 500
                     name:langsam  hängt 20 s, dann Netzfehler (Zeitüberschreitung beim Server)
                     name@30     (an jede Form anhängbar) nur in den ersten 30 s nach dem Laden – zum Testen der Erholung
                     name>30     erst ab 30 s nach dem Laden – Ausfall mitten im Spiel
   Namen: karte, gelaende, lod2, luftbild, overpass, oepnv, suche, wiki, osm, strassen, baeume, zensus, material, extern (alles außer
   der eigenen Seite), oder ein beliebiges Stück der Adresse. */
(function (G) {
  let q = G.HX_AUSFALL_Q || ''; if (!q) try { q = new URLSearchParams(G.location.search).get('ausfall') || ''; } catch (e) {} // HX_AUSFALL_Q: for blob workers (no own address)
  if (!q || !G.fetch) return;
  const ALIAS = { karte: ['openfreemap'], gelaende: ['elevation-tiles', 'terrarium'], lod2: ['3d_gebaeude', 'lod2'], luftbild: ['wms', 'dop'],
    overpass: ['overpass'], oepnv: ['transitous'], suche: ['nominatim', 'photon'], wiki: ['wikipedia'], osm: ['daten/osm/'], strassen: ['daten/strassen/'],
    baeume: ['daten/baeume/'], zensus: ['daten/zensus/'], material: ['material.json'] };
  const regeln = q.split(',').map(s => s.trim()).filter(Boolean).map(s => { const [a1, ab] = s.split('>'), [a0, bis] = a1.split('@'), [n, m] = a0.split(':'); return { n, m: m || 'fehler', teile: ALIAS[n] || [n], bis: bis ? +bis * 1000 : Infinity, ab: ab ? +ab * 1000 : 0 }; });
  const t0 = Date.now();
  const orig = G.fetch.bind(G), self0 = G.location.origin;
  G.HX_AUSFALL = regeln.map(r => r.n + ':' + r.m + (r.bis < Infinity ? '@' + r.bis / 1000 : '') + (r.ab ? '>' + r.ab / 1000 : ''));
  G.fetch = function (input, opt) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const abs = (() => { try { return new URL(url, G.location.href); } catch (e) { return null; } })();
    for (const r of regeln) {
      const hit = r.n === 'extern' ? abs && abs.origin !== self0 : r.teile.some(t => url.includes(t));
      if (!hit || Date.now() - t0 > r.bis || Date.now() - t0 < r.ab) continue;
      if (r.m === '500') return Promise.resolve(new Response('simulierter Ausfall', { status: 500, statusText: 'Simuliert' }));
      if (r.m === 'langsam') return new Promise((_, rej) => { const t = setTimeout(() => rej(new TypeError('simuliert: Zeitüberschreitung')), 20000);
        const s = opt && opt.signal; if (s) s.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('abgebrochen', 'AbortError')); }); });
      return Promise.reject(new TypeError('simulierter Netzfehler: ' + r.n));
    }
    return orig(input, opt);
  };
})(self);
