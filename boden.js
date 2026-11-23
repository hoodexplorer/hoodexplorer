/* HoodExplorer – Bodentabelle (Runde 277). One row per kind of ground the figure (and the car) can be on; walking speed, grip,
   step sound and step effects all read these numbers - nothing about grounds is written anywhere else.
   Weather grounds blend in by their strength (snow cover 0..1, black ice 0..1, wetness 0..1), see wetter.js.
     lauf / sprint : top speed in m/s (only where the ground sets its own, i.e. in the water)
     v             : factor on the walking speed at full strength (deep snow is slower)
     a             : factor on how fast the figure speeds up / turns its speed (grip of the feet; low = sliding)
     rutsch        : extra factor on a in the moment (frozen lakes and rivers)
     grip          : grip of tyres at full strength (wet 0.8 ... ice 0.32)
     snd / vol / volSchnell : step sound from schritte.js, its level walking / running (null = silent)
     takt          : sound at loose intervals [min, max] s instead of every step (swimming)
     spur / staub / spritzer : footprints, a puff when running, splash and rings */
(function () {
'use strict';
const B = {
  trocken:   { v: 1,   a: 1,   grip: 1,   snd: null },
  nass:      {                 grip: .8,  snd: 'wet',    vol: 1,   volSchnell: 1.2 },
  pfuetze:   {                            snd: 'splash', vol: 1,   volSchnell: 1.25, spritzer: true, frostSnd: 'ice' },
  schnee:    { v: .75, a: .7,  grip: .55, snd: 'snow',   vol: 1,   volSchnell: 1.25, spur: true, staub: true },
  glatteis:  {         a: .15, grip: .32, snd: 'ice',    vol: .7,  volSchnell: .9 },
  eis:       {         rutsch: .6 },                                                   /* frozen water */
  waten:     { lauf: 3.5, sprint: 3.5, snd: 'splash', vol: .8, volSchnell: .8 },
  schwimmen: { lauf: 4.2, sprint: 9,   snd: 'swim',   vol: 1,  volSchnell: 1, takt: [.7, 1.6] }
};
/* the row for the feet of the figure: water state first, then the weather on the ground (same order as before Runde 277) */
function schritt(P, W, pfuetze) {
  if (P.swim) return 'schwimmen'; if (P.wade) return 'waten';
  if (pfuetze) return 'pfuetze'; if (W.cover > .3) return 'schnee'; if (W.frost && W.ice > .5) return 'glatteis'; if (W.wet > .3) return 'nass'; return 'trocken'; }
window.HXBODEN = Object.assign(B, { schritt });
})();
