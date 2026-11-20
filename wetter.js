/* HoodExplorer – Wetter (Runde 141): Regen, Gewitter, Schnee, Glatteis.
   Kept cheap for the frame rate:
   - precipitation: ONE THREE.Points draw call; the drops never touch the CPU - the vertex shader moves them (falling, wind,
     wrapping in a box around the camera), the fragment shader draws each point as a pixel streak (rain) or a flake (snow);
   - wet ground, puddles with raindrop rings, ice and snow cover: a few lines in the existing ground and house shaders
     (no extra geometry, no extra pass); the puddle pattern is a world-space noise the CPU computes the same way, so
     footsteps and tyres know where the puddles are;
   - splashes, spray, snow puffs: one small particle pool (Points, <= 360, only the live ones are uploaded);
   - footprints and tyre tracks in snow: one InstancedMesh ring buffer;
   - sound: rain, thunder, steps in puddles and snow, tyre hiss - generated with WebAudio, no files.
   Driving: app.js reads WX.grip (wet 0.8 … ice 0.25) for tyres, brakes, engine and the autopilot; walking reads walkV/walkA. */
(function () {
'use strict';
const A = window.HXWX_API; if (!A || !window.THREE) return;
const store = A.store, $ = id => document.getElementById(id);

// ------------------------------------------------------------------ kinds
const KINDS = [
  { id: 'klar', name: 'Klar', rain: 0, snow: 0, wet: 0, cover: 0, ice: 0, light: 1, fog: 1, sat: 1 },
  { id: 'wolken', name: 'Bewölkt', rain: 0, snow: 0, wet: 0, cover: 0, ice: 0, light: .8, fog: 1.35, sat: .82 },
  { id: 'regen', name: 'Regen', rain: .6, snow: 0, wet: 1, cover: 0, ice: 0, light: .68, fog: 1.9, sat: .72 },
  { id: 'gewitter', name: 'Gewitter', rain: 1, snow: 0, wet: 1, cover: 0, ice: 0, light: .5, fog: 2.3, sat: .62, storm: 1 },
  { id: 'schnee', name: 'Schnee', rain: 0, snow: .7, wet: .3, cover: 1, ice: .35, light: .9, fog: 2.6, sat: .6, frost: 1 },
  { id: 'glatteis', name: 'Glatteis', rain: 0, snow: 0, wet: .75, cover: .12, ice: 1, light: .82, fog: 1.6, sat: .7, frost: 1 },
  { id: 'wechsel', name: 'Wechselnd' }];
const AUTO_SEQ = ['klar', 'wolken', 'regen', 'wolken', 'klar', 'gewitter', 'regen', 'klar'];
let kindId = store.get('hx.wetter') || 'klar'; if (!KINDS.find(k => k.id === kindId)) kindId = 'klar';
let power = +(store.get('hx.wetterStaerke') || 1);
let autoI = 0, autoT = 0, target = null;
const W = { rain: 0, snow: 0, wet: 0, cover: 0, ice: 0, light: 1, fog: 1, sat: 1, storm: 0, frost: 0, freeze: 0 };
function pickTarget() { const id = kindId === 'wechsel' ? AUTO_SEQ[autoI % AUTO_SEQ.length] : kindId; target = KINDS.find(k => k.id === id); }
pickTarget();
// start in the chosen weather (no 30 s of drying up after a reload)
for (const k of ['rain', 'snow', 'wet', 'cover', 'ice', 'light', 'fog', 'sat']) W[k] = (target[k] || 0) * (k === 'rain' || k === 'snow' ? power : 1);
W.storm = target.storm || 0; W.frost = target.frost || 0;

// ------------------------------------------------------------------ shader parts (ground + houses)
const U = { uWxWet: { value: 0 }, uWxSnow: { value: 0 }, uWxIce: { value: 0 }, uWxRain: { value: 0 }, uWxT: { value: 0 }, uWxSky: { value: new THREE.Color(.6, .65, .7) } };
const GLSL = `uniform float uWxWet, uWxSnow, uWxIce, uWxRain, uWxT; uniform vec3 uWxSky;
float wxH(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float wxN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wxH(i), wxH(i + vec2(1.0, 0.0)), f.x), mix(wxH(i + vec2(0.0, 1.0)), wxH(i + vec2(1.0, 1.0)), f.x), f.y); }
float wxPud(vec2 p){ return wxN(p * 0.2) * 0.65 + wxN(p * 0.59) * 0.35; }`;
// puddles: the same noise on the CPU (footsteps, tyres)
const fr = x => x - Math.floor(x);
function wxH(x, y) { let a = fr(x * .1031), b = fr(y * .1031), c = fr(x * .1031); const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33); a += d; b += d; c += d; return fr((a + b) * c); }
function wxN(x, y) { const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = wxH(ix, iy), b = wxH(ix + 1, iy), c = wxH(ix, iy + 1), d = wxH(ix + 1, iy + 1); return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy; }
const pudTh = () => 1 - .3 * W.wet;
function puddleAt(x, z) { if (W.wet < .06 || W.cover > .55) return 0; const m = wxN(x * .2, z * .2) * .65 + wxN(x * .59, z * .59) * .35; if (m < pudTh()) return 0;
  const h = A.terrainH(x, z), hx = A.terrainH(x + 1, z), hz = A.terrainH(x, z + 1); return Math.abs(hx - h) + Math.abs(hz - h) < .3 ? 1 : 0; } // flat ground only (as in the shader)

function wrap(mat, kind) {
  const f = mat.onBeforeCompile;
  mat.onBeforeCompile = sh => { if (f) f(sh); Object.assign(sh.uniforms, U);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + GLSL);
    if (kind === 'ground') {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vWxN;\nvarying vec3 vWxP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n{ vec3 hxn = mat3(modelMatrix) * objectNormal; vWxN = length(hxn) > 0.01 ? normalize(hxn).y : 1.0; vWxP = (modelMatrix * vec4(transformed, 1.0)).xyz; }');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vWxN;\nvarying vec3 vWxP;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uWxWet + uWxSnow + uWxIce > 0.004) {
          vec3 wc = diffuseColor.rgb; float mx = max(wc.r, max(wc.g, wc.b)), mn = min(wc.r, min(wc.g, wc.b));
          float road = (mx - mn < 0.1 && mx < 0.8) ? 1.0 : 0.0;           // grey: asphalt, pavement, paving
          float wxFl = step(0.965, vWxN);
          diffuseColor.rgb *= 1.0 - uWxWet * (0.22 + 0.16 * road);       // wet ground is darker
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.85, 0.92), uWxIce * (road > 0.5 ? 0.16 : 0.38) * smoothstep(0.5, 0.8, vWxN)); // hoarfrost
          vec2 wp = vWxP.xz;
          // puddles: noise above a threshold that sinks the wetter it gets; mirror the sky, rings where drops fall in, ice in frost
          float green = (wc.g > wc.r * 1.06 && wc.g > wc.b * 1.04) ? 0.1 : 0.0; // fewer puddles on lawns
          float pm = wxPud(wp), th = 1.0 - 0.3 * uWxWet + green, pud = wxFl * step(th, pm) * step(0.06, uWxWet);
          float sn = clamp((uWxSnow * 1.25 - 0.25 - wxN(wp * 0.35) * 0.5) * 3.0, 0.0, 1.0) * smoothstep(0.55, 0.85, vWxN);
          sn = floor(sn * 3.0 + 0.5) / 3.0 * (road > 0.5 ? 0.6 : 1.0);   // pixel steps; streets get slush, not a white sheet
          if (pud > 0.5) {
            float deep = step(th + 0.035, pm);                            // 1-px dark rim, then the mirror
            float rip = 0.0;
            if (uWxRain > 0.01) { vec2 q = wp / 0.7, id = floor(q), f = fract(q); float h = wxH(id + 7.3), tt = fract(uWxT * (0.8 + h * 0.7) + h);
              vec2 ce = vec2(0.25) + 0.5 * vec2(wxH(id + 1.7), wxH(id + 3.1)); float d = length(f - ce), w = fwidth(q.x) * 1.3 + 0.02;
              rip = (1.0 - smoothstep(0.0, w, abs(d - tt * 0.42))) * (1.0 - tt) * step(h, uWxRain * 0.85 + 0.1); }
            vec3 mir = mix(uWxSky * 0.42 + wc * 0.1, vec3(0.80, 0.88, 0.95), uWxIce) + rip * 0.35 * (1.0 - uWxIce);
            diffuseColor.rgb = mix(diffuseColor.rgb * 0.7, wc * 0.18, deep) * (1.0 - sn);
            totalEmissiveRadiance += mir * deep * 0.85 * (1.0 - sn);
          } else if (uWxIce > 0.01) totalEmissiveRadiance += uWxSky * 0.07 * uWxIce * road; // black ice: a faint sheen on the streets
          diffuseColor.rgb = mix(diffuseColor.rgb, road > 0.5 ? vec3(0.78, 0.80, 0.85) : vec3(0.93, 0.95, 0.99), sn);
        }`);
    } else {
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uWxWet + uWxSnow > 0.004) { vec3 wn = normalize(vWNor);
          diffuseColor.rgb *= 1.0 - uWxWet * 0.16;
          float up = smoothstep(0.3, 0.6, abs(wn.y)), sn = clamp((uWxSnow * 1.3 - 0.3 - wxN(vRoof * 0.8) * 0.35) * 3.0, 0.0, 1.0) * up;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.98), floor(sn * 3.0 + 0.5) / 3.0); }`);
    } };
  mat.customProgramCacheKey = () => 'wx' + kind; mat.needsUpdate = true;
}
wrap(A.groundMat, 'ground'); wrap(A.bldMat, 'bld');

// ------------------------------------------------------------------ precipitation
const PN = 3200;
const pg = new THREE.BufferGeometry();
{ const p = new Float32Array(PN * 3), r = new Float32Array(PN); for (let i = 0; i < PN; i++) { p[i * 3] = Math.random(); p[i * 3 + 1] = Math.random(); p[i * 3 + 2] = Math.random(); r[i] = Math.random(); }
  pg.setAttribute('position', new THREE.BufferAttribute(p, 3)); pg.setAttribute('aR', new THREE.BufferAttribute(r, 1)); }
const PU = { uC: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3(36, 24, 36) }, uT: { value: 0 }, uSnow: { value: 0 }, uWind: { value: new THREE.Vector2() },
  uSize: { value: 7 }, uOrtho: { value: 0 }, uA: { value: 1 }, uLight: spriteUniforms.uLight };
const pMat = new THREE.ShaderMaterial({ uniforms: PU, transparent: true, depthWrite: false,
  vertexShader: `attribute float aR; uniform vec3 uC, uB; uniform float uT, uSnow, uSize, uOrtho; uniform vec2 uWind; varying float vA; varying float vS;
    void main(){
      float fall = mix(15.0 + aR * 4.0, 1.3 + aR * 0.8, uSnow);                      // m/s: rain, snow
      vec3 w = position * uB + vec3(uWind.x, -fall, uWind.y) * uT;
      w.x += uSnow * sin(uT * (0.7 + aR) + aR * 40.0) * 0.8; w.z += uSnow * cos(uT * (0.6 + aR) + aR * 25.0) * 0.8; // flakes sway
      w = uC + (fract((w - uC) / uB + 0.5) - 0.5) * uB;                              // fixed in the world, wrapped in a box around the camera
      vec4 mv = viewMatrix * vec4(w, 1.0); gl_Position = projectionMatrix * mv;
      float d = max(1.0, -mv.z);
      gl_PointSize = uOrtho > 0.5 ? uSize : clamp(uSize * 14.0 / d, 1.0, uSize * 1.6);
      vS = gl_PointSize;
      vec3 e = abs((w - uC) / uB) * 2.0; vA = 1.0 - smoothstep(0.75, 1.0, max(e.x, max(e.y, e.z))); // no hard box edge
    }`,
  fragmentShader: `uniform float uSnow, uA; uniform vec2 uWind; uniform vec3 uLight; varying float vA; varying float vS;
    void main(){
      vec2 c = gl_PointCoord - 0.5;
      if (uSnow > 0.5) { if (dot(c, c) > 0.2) discard; gl_FragColor = vec4(vec3(0.97, 0.98, 1.0) * max(uLight, vec3(0.35)), 0.95 * vA * uA); return; }
      float slant = clamp(uWind.x * 0.04, -0.6, 0.6);
      if (abs(c.x + c.y * slant) > 0.62 / vS) discard;                              // a 1-px streak
      gl_FragColor = vec4(vec3(0.72, 0.8, 0.9) * max(uLight, vec3(0.3)), 0.55 * vA * uA);
    }` });
const precip = new THREE.Points(pg, pMat); precip.frustumCulled = false; precip.renderOrder = 3; A.scene.add(precip);

// ------------------------------------------------------------------ splashes, spray, snow puffs
const FN = 360, fPos = new Float32Array(FN * 3), fInfo = new Float32Array(FN * 2), F = []; // info: age 0..1, kind
const fg = new THREE.BufferGeometry();
fg.setAttribute('position', new THREE.BufferAttribute(fPos, 3).setUsage(THREE.DynamicDrawUsage));
fg.setAttribute('aI', new THREE.BufferAttribute(fInfo, 2).setUsage(THREE.DynamicDrawUsage)); fg.setDrawRange(0, 0);
const fMat = new THREE.ShaderMaterial({ uniforms: { uLight: spriteUniforms.uLight, uOrtho: PU.uOrtho }, transparent: true, depthWrite: false,
  vertexShader: `attribute vec2 aI; uniform float uOrtho; varying vec2 vI; void main(){ vI = aI; vec4 mv = viewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
    float s = aI.y < 0.5 ? 0.07 : aI.y < 1.5 ? 0.22 + aI.x * 0.4 : 0.3 + aI.x * 0.45;               // world size: drop, crown, puff
    gl_PointSize = uOrtho > 0.5 ? max(1.0, s * 9.0) : clamp(s * 420.0 / max(1.0, -mv.z), 1.0, 40.0); }`,
  fragmentShader: `uniform vec3 uLight; varying vec2 vI; void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c);
    vec3 col = vI.y > 1.5 ? vec3(0.96, 0.97, 1.0) : vec3(0.82, 0.88, 0.95); float a = 1.0 - vI.x;
    if (vI.y > 0.5 && vI.y < 1.5) { if (abs(r - 0.38) > 0.12 || c.y > 0.15) discard; a *= 0.9; }     // splash crown: a ring, upper half
    else if (r > 0.5) discard;
    gl_FragColor = vec4(col * max(uLight, vec3(0.3)), a * (vI.y < 0.5 ? 0.6 : 0.85)); }` });
const fx = new THREE.Points(fg, fMat); fx.frustumCulled = false; fx.renderOrder = 3; A.scene.add(fx);
function spawn(x, y, z, vx, vy, vz, kind, life) { if (F.length >= FN) F.shift(); F.push({ x, y, z, vx, vy, vz, k: kind, t: 0, life }); }
function burst(x, y, z, n, sp, up, kind, bvx, bvz) { for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s = sp * (.4 + Math.random() * .6);
  spawn(x, y + .05, z, Math.cos(a) * s + (bvx || 0), up * (.5 + Math.random() * .7), Math.sin(a) * s + (bvz || 0), kind, .35 + Math.random() * .35); } }
function updateFx(dt) {
  let n = 0;
  for (let i = F.length - 1; i >= 0; i--) { const p = F[i]; p.t += dt; if (p.t >= p.life) { F.splice(i, 1); continue; }
    if (p.k !== 1) { p.vy -= (p.k === 2 ? 3 : 18) * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; if (p.k === 2) { p.vx *= 1 - dt * 2; p.vz *= 1 - dt * 2; } } }
  for (const p of F) { fPos[n * 3] = p.x; fPos[n * 3 + 1] = p.y; fPos[n * 3 + 2] = p.z; fInfo[n * 2] = p.t / p.life; fInfo[n * 2 + 1] = p.k; n++; }
  fg.setDrawRange(0, n); if (n) { fg.attributes.position.needsUpdate = true; fg.attributes.aI.needsUpdate = true; } fx.visible = n > 0;
}

// ------------------------------------------------------------------ footprints and tyre tracks in snow
const DN = 600; let dI = 0;
const dGeo = new THREE.PlaneGeometry(1, 1); dGeo.rotateX(-Math.PI / 2);
const dMesh = new THREE.InstancedMesh(dGeo, new THREE.MeshBasicMaterial({ color: 0x9aa6b8, transparent: true, opacity: .55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), DN);
dMesh.frustumCulled = false; dMesh.count = 0; dMesh.renderOrder = 1; A.scene.add(dMesh);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function decal(x, z, h, w, l) { _e.set(0, h, 0); _q.setFromEuler(_e); _p.set(x, A.terrainH(x, z) + .04, z); _s.set(w, 1, l); _m.compose(_p, _q, _s);
  dMesh.setMatrixAt(dI, _m); dI = (dI + 1) % DN; dMesh.count = Math.max(dMesh.count, dI || DN); dMesh.instanceMatrix.needsUpdate = true; }

// ------------------------------------------------------------------ sound
let ac = null, rainG = null, rainF = null, hissG = null, noiseBuf = null;
function audio() {
  if (ac) return ac;
  try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  const len = ac.sampleRate * 2; noiseBuf = ac.createBuffer(1, len, ac.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const loop = (type, f, q) => { const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true; const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = ac.createGain(); g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(ac.destination); s.start(); return [g, fl]; };
  [rainG, rainF] = loop('lowpass', 2400, .4); [hissG] = loop('highpass', 2600, .3);
  if (window.HXSTEP) for (const k of HXSTEP.kinds) STEPB[k] = HXSTEP.bank(k, ac.sampleRate, /^(brook|rainwater)$/.test(k) ? 1 : 6).map(a => { const b = ac.createBuffer(1, a.length, ac.sampleRate); b.getChannelData(0).set(a); return b; }); // Runde 179: footsteps (schritte.js)
  return ac;
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, () => { audio(); if (ac && ac.state !== 'running') ac.resume(); }, { passive: true })); // Runde 181: always - water sounds also in fine weather
function burstSnd(dur, type, f, q, vol, f2) { if (!ac || ac.state !== 'running') return; const t = ac.currentTime, s = ac.createBufferSource(); s.buffer = noiseBuf; const fl = ac.createBiquadFilter(), g = ac.createGain();
  fl.type = type; fl.frequency.setValueAtTime(f, t); if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur); fl.Q.value = q; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0005, t + dur);
  s.connect(fl); fl.connect(g); g.connect(ac.destination); s.start(t, Math.random()); s.stop(t + dur + .05); }
/* Runde 179 (phone test: steps in rain and snow sounded wrong - one soft noise puff for puddle, snow and ice alike, wet ground silent):
   pre-computed steps from schritte.js (snow = granular crunch, puddle = slap + splash + bubbles, wet ground = soft slap, ice = hard
   cracks), six variants each, played with a little random pitch and level */
const STEPB = {}, STEPV = { splash: .26, snow: .24, wet: .15, ice: .18, swim: .3, lap: .2, slap: .18 };
function stepSnd(kind, k = 1) { if (!ac || ac.state !== 'running') return; const L = STEPB[kind]; if (!L || !L.length) return;
  const s = ac.createBufferSource(), g = ac.createGain(), lp = ac.createBiquadFilter(); s.buffer = L[(Math.random() * L.length) | 0]; s.playbackRate.value = .9 + Math.random() * .2;
  lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = .5; // Runde 180: steps never bright - they get on one's nerves in the long run
  g.gain.value = STEPV[kind] * k * (.8 + Math.random() * .4); s.connect(lp); lp.connect(g); g.connect(ac.destination); s.start(); }
const sWhoosh = v => burstSnd(.6, 'bandpass', 900, .8, Math.min(.35, .08 + v * .006), 300);
function thunder(dist) { if (!ac || ac.state !== 'running') return; const t = ac.currentTime + dist, s = ac.createBufferSource(); s.buffer = noiseBuf; const fl = ac.createBiquadFilter(), g = ac.createGain();
  fl.type = 'lowpass'; fl.frequency.value = 160 + Math.random() * 120; g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.6 / (1 + dist * .4), t + .08); g.gain.exponentialRampToValueAtTime(.2 / (1 + dist * .4), t + .9);
  g.gain.exponentialRampToValueAtTime(.0005, t + 3.5); s.connect(fl); fl.connect(g); g.connect(ac.destination); s.loop = true; s.start(t); s.stop(t + 3.6); }

// ------------------------------------------------------------------ lightning
const flashEl = document.createElement('div'); flashEl.id = 'wxFlash'; flashEl.style.cssText = 'position:absolute;inset:0;background:#e8eeff;opacity:0;pointer-events:none;mix-blend-mode:screen';
{ const v = $('view'); v && v.parentNode ? v.parentNode.insertBefore(flashEl, v.nextSibling) : document.body.appendChild(flashEl); }
let flash = 0, flashT = 6 + Math.random() * 8, flashSeq = [];

// ------------------------------------------------------------------ mood (called from app.js applyMood)
const _grey = new THREE.Color(.55, .58, .62), _snowSky = new THREE.Color(.8, .83, .88);
let moodSig = '';
window.WX = {
  grip: 1, walkV: 1, walkA: 1,
  get state() { return Object.assign({ kind: kindId, power }, W); },
  puddleAt, get fxN() { return F.length; }, get stepBanks() { return Object.keys(STEPB).map(k => k + ':' + STEPB[k].length); }, stepSnd,
  mood(scene, hemi, sun, pu) {
    const L = W.light, g = 1 - L; // L < 1: overcast
    hemi.intensity *= .75 + .25 * L; sun.intensity *= L * L; scene.fog.density *= W.fog;
    scene.fog.color.lerp(W.snow > .05 || W.cover > .5 ? _snowSky : _grey, Math.min(.7, g * 1.1)).multiplyScalar(.85 + .15 * L);
    scene.background.lerp(scene.fog.color, Math.min(.85, g * 1.6 + (W.fog - 1) * .22)); // overcast: the blue goes
    pu.uSat.value *= W.sat; },
  set(id) { if (!KINDS.find(k => k.id === id)) return; kindId = id; store.set('hx.wetter', id); autoI = 0; autoT = 0; pickTarget(); markSeg(); },
  snap() { for (const k of ['rain', 'snow', 'wet', 'cover', 'ice', 'light', 'fog', 'sat']) W[k] = (target[k] || 0) * (k === 'rain' || k === 'snow' ? power : 1); W.freeze = target.frost && (target.ice || 0) > .9 ? 1 : 0; }, // tests: the target weather at once
  setPower(v) { power = v; store.set('hx.wetterStaerke', v); }
};

/* Runde 181: water ambience around the figure (or the car), checked every 0.4 s on rings of 4-30 m: a running brook/river as a
   seamless bubble loop (louder the nearer), still water at natural banks: single low gluggs now and then, quay walls: soft slaps,
   rain on water: a quiet loop of small bubbles. All through the 3 kHz lowpass - dark like the steps. */
const WAMB = { t: 0, brook: null, rain: null, next: 0 };
function ambLoop(kind) { const s = ac.createBufferSource(), g = ac.createGain(), lp = ac.createBiquadFilter(); s.buffer = STEPB[kind][0]; s.loop = true; lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = .5;
  g.gain.value = 0; s.connect(lp); lp.connect(g); g.connect(ac.destination); s.start(0, Math.random() * s.buffer.duration); return g; }
function waterAmb(dt, x, z, swimming) {
  if (!ac || ac.state !== 'running' || !STEPB.brook || !A.waterProbe) return; if ((WAMB.t -= dt) > 0) return; WAMB.t = .4;
  let flowD = 99, stillD = 99, hard = false;
  for (const r of [0, 4, 9, 16, 24, 32]) for (let k = 0; k < (r ? 12 : 1); k++) { const a = k / 12 * 6.283, w = A.waterProbe(x + Math.cos(a) * r, z + Math.sin(a) * r); if (!w) continue;
    if (w.flow) flowD = Math.min(flowD, r); else if (r < stillD) { stillD = r; hard = w.hard; } }
  if (!WAMB.brook) { WAMB.brook = ambLoop('brook'); WAMB.rain = ambLoop('rainwater'); }
  const t = ac.currentTime, near = Math.min(flowD, stillD);
  WAMB.brook.gain.setTargetAtTime(flowD < 32 ? .16 * Math.pow(1 - flowD / 34, 2) : 0, t, .5);
  WAMB.rain.gain.setTargetAtTime(W.rain > .08 && near < 26 ? .1 * W.rain * Math.pow(1 - near / 28, 1.5) : 0, t, .5);
  if (stillD < 20 && !swimming && performance.now() > WAMB.next) { WAMB.next = performance.now() + 1200 + Math.random() * 2600; stepSnd(hard ? 'slap' : 'lap', Math.pow(1 - stillD / 22, 1.5) * (W.storm ? 1.4 : 1)); }
}

// ------------------------------------------------------------------ per frame
let stepN = -1, swimN = -1, lastSpray = 0, puddleCD = 0, trackD = 0, lastX = 0, lastZ = 0, rainSplashAcc = 0;
const approach = (k, v, rate, dt) => { W[k] += Math.max(-rate * dt, Math.min(rate * dt, v - W[k])); };
WX.update = function (dt, time) {
  // targets and how fast the world follows (a shower wets quickly, drying takes longer, snow lies a while)
  if (kindId === 'wechsel' && (autoT += dt) > 150 + (autoI % 3) * 40) { autoT = 0; autoI++; pickTarget(); }
  const T = target;
  approach('rain', (T.rain || 0) * power, .35, dt); approach('snow', (T.snow || 0) * power, .3, dt);
  approach('light', T.light, .2, dt); approach('fog', T.fog, .4, dt); approach('sat', T.sat, .15, dt);
  if (W.rain > .05) approach('wet', 1, W.rain / 5, dt); else approach('wet', T.wet || 0, T.frost ? 1 / 20 : 1 / 45, dt);
  if (W.snow > .05) approach('cover', 1, W.snow / 10, dt); else approach('cover', T.cover || 0, W.rain > .05 ? 1 / 6 : T.frost ? 1 / 22 : 1 / 12, dt); // Runde 143: snow melts within ~12 s once it stops (rain: 6 s)
  approach('ice', T.ice || 0, 1 / 12, dt);
  const fz = T.frost && (T.ice || 0) > .9 ? 1 : 0; approach('freeze', fz, fz ? 1 / 10 : 1 / 15, dt); A.waterIce.value.set(W.freeze, W.cover); // Runde 143: lakes and rivers freeze at black ice (~9 s), thaw in 15 s W.storm = T.storm || 0; W.frost = T.frost || 0;
  WX.grip = Math.max(.22, (1 - .2 * W.wet * (1 - W.ice)) * (1 - .45 * W.cover) * (1 - .68 * W.ice));
  WX.walkV = 1 - .25 * W.cover; WX.walkA = Math.max(.12, 1 - .85 * W.ice - .3 * W.cover);
  const sig = [W.light, W.fog, W.sat, W.snow > .05 ? 1 : 0, W.cover > .5 ? 1 : 0].map(v => v.toFixed(3)).join();
  if (sig !== moodSig) { moodSig = sig; A.remood(); }

  U.uWxWet.value = W.wet; U.uWxSnow.value = W.cover; U.uWxIce.value = W.frost ? W.ice : 0; U.uWxRain.value = W.rain; U.uWxT.value = time; U.uWxSky.value.copy(A.fogColor);

  // precipitation box around the camera (chase) or the figure (isometric)
  const P = A.P, cam = A.cam, iso = A.iso, below = A.underground(P.x, P.z, P.y + 1);
  const amt = Math.max(W.rain, W.snow), snowing = W.snow > W.rain;
  precip.visible = amt > .01 && !below;
  if (precip.visible) {
    PU.uSnow.value = snowing ? 1 : 0; PU.uT.value = time; PU.uOrtho.value = iso ? 1 : 0;
    const wind = spriteUniforms.uWind.value; PU.uWind.value.set(wind * (snowing ? 1.2 : 2.2), wind * (snowing ? .4 : .7));
    if (iso) { const z = A.isoZoom; PU.uB.value.set(z * 3.4, z * 2.2, z * 3.4); PU.uC.value.set(P.x, P.y + z * .7, P.z); PU.uSize.value = snowing ? 2 : 6; }
    else { const f = new THREE.Vector3(); cam.getWorldDirection(f); PU.uB.value.set(38, 24, 38); PU.uC.value.copy(cam.position).addScaledVector(f, 15); PU.uSize.value = snowing ? 2.4 : 8; }
    pg.setDrawRange(0, Math.round(PN * Math.min(1, amt * (snowing ? .8 : 1)))); PU.uA.value = Math.min(1, amt * 2.5);
  }

  // drops hitting the ground near the figure: little crowns (rain) - only a handful per second
  if (W.rain > .05 && !below) { rainSplashAcc += dt * W.rain * (iso ? 70 : 45);
    while (rainSplashAcc >= 1) { rainSplashAcc--; const r = (iso ? 26 : 14) * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2, x = P.x + Math.cos(a) * r, z = P.z + Math.sin(a) * r;
      spawn(x, A.terrainH(x, z) + .04, z, 0, 0, 0, 1, .28); } }

  // the figure's footsteps: a step at every half stride (phase += pi)
  const DRV = A.DRV, DV = A.DV;
  if (!DRV.on && P.ground && !P.swim && !P.wade && Math.abs(P.speed) > .6) {
    const s = Math.floor(P.phase / Math.PI);
    if (s !== stepN) { stepN = s; const side = s % 2 ? 1 : -1, hx = Math.cos(P.yaw) * .14 * side, hz = -Math.sin(P.yaw) * .14 * side, x = P.x + hx, z = P.z + hz, fast = Math.abs(P.speed) > 7;
      if (puddleAt(x, z)) { const y = A.terrainH(x, z); spawn(x, y + .03, z, 0, 0, 0, 1, .3); burst(x, y, z, fast ? 9 : 5, fast ? 2.2 : 1.4, fast ? 3.2 : 2.2, 0, Math.sin(P.yaw) * P.speed * .25, Math.cos(P.yaw) * P.speed * .25); stepSnd(W.frost && W.ice > .5 ? 'ice' : 'splash', fast ? 1.25 : 1); }
      else if (W.cover > .3) { decal(x, z, P.yaw, .2, .32); stepSnd('snow', (fast ? 1.25 : 1) * Math.min(1, .4 + W.cover)); if (fast) burst(x, A.terrainH(x, z), z, 3, .8, 1, 2); }
      else if (W.frost && W.ice > .5) stepSnd('ice', fast ? .9 : .7); // black ice
      else if (W.wet > .3) stepSnd('wet', (fast ? 1.2 : 1) * Math.min(1, W.wet)); } } // wet ground: a soft wet slap (was silent)
  else if (DRV.on) stepN = -1;
  if (!DRV.on && (P.swim || P.wade) && Math.abs(P.speed) > .4) { const s = Math.floor(P.phase / Math.PI); if (s !== swimN) { swimN = s; stepSnd(P.swim ? 'swim' : 'splash', P.swim ? 1 : .8); } } // Runde 181: strokes and wading
  waterAmb(dt, DRV.on ? DV.x : P.x, DRV.on ? DV.z : P.z, P.swim);

  // driving: spray behind the wheels on a wet road, big splashes through puddles, tracks and white spray in snow
  const sp = DRV.on ? Math.hypot(DV.vx, DV.vz) : 0;
  if (DRV.on && !DV.air && DRV.car && sp > 2) {
    const fx = Math.sin(DV.h), fz = Math.cos(DV.h), rx = Math.cos(DV.h), rz = -Math.sin(DV.h), L = DRV.car.len * .32, y0 = DV.y;
    lastSpray += dt * sp * (W.wet * .9 + W.cover * .7);
    puddleCD -= dt;
    for (const sd of [-1, 1]) { const x = DV.x - fx * L + rx * .75 * sd, z = DV.z - fz * L + rz * .75 * sd;
      if (puddleCD <= 0 && sp > 5 && puddleAt(x, z) && !(W.frost && W.ice > .5)) { puddleCD = .35; sWhoosh(sp);
        for (let i = 0; i < Math.min(26, 6 + sp); i++) { const s2 = sd * (2 + Math.random() * 3) + (Math.random() - .5) * 2; spawn(x, y0 + .2, z, rx * s2 - fx * sp * .15 + DV.vx * .6, 2 + Math.random() * (2 + sp * .12), rz * s2 - fz * sp * .15 + DV.vz * .6, 0, .5 + Math.random() * .4); } } }
    while (lastSpray >= 1) { lastSpray--; const sd = Math.random() < .5 ? -1 : 1, x = DV.x - fx * (L + .4) + rx * .75 * sd, z = DV.z - fz * (L + .4) + rz * .75 * sd, snowy = W.cover > W.wet;
      spawn(x, y0 + .25, z, DV.vx * .55 + (Math.random() - .5) * 1.5 + rx * sd, .8 + Math.random() * 1.6, DV.vz * .55 + (Math.random() - .5) * 1.5 + rz * sd, snowy ? 2 : 0, snowy ? .6 : .4); }
    if (W.cover > .3 && (trackD += Math.hypot(DV.x - lastX, DV.z - lastZ)) > .7) { trackD = 0;
      for (const sd of [-1, 1]) decal(DV.x - fx * L + rx * .75 * sd, DV.z - fz * L + rz * .75 * sd, DV.h, .3, .9); }
  }
  lastX = DV.x; lastZ = DV.z;
  if (W.cover < .08 && dMesh.count) { dMesh.count = 0; dI = 0; } // melted: the tracks go with the snow

  updateFx(dt);

  // lightning: a double flash, thunder later the farther away it struck
  if (W.storm && W.rain > .4) { if ((flashT -= dt) <= 0) { flashT = 7 + Math.random() * 14; const d = .3 + Math.random() * 3.5; flashSeq = [0, .12 + Math.random() * .1]; flash = 0; thunder(d); } }
  if (flashSeq.length) { flash += dt; const on = flashSeq.some(t0 => flash > t0 && flash < t0 + .07); flashEl.style.opacity = on ? (below ? .1 : .55) : 0; if (flash > .5) { flashSeq = []; flashEl.style.opacity = 0; } }

  // sound levels
  if (ac && rainG) { const t = ac.currentTime, inCar = DRV.on ? 1 : 0;
    rainG.gain.setTargetAtTime(below ? W.rain * .02 : W.rain * (.07 + inCar * .04), t, .3); rainF.frequency.setTargetAtTime(inCar ? 900 : 2400, t, .3); // in the car: the drumming on the roof is duller
    hissG.gain.setTargetAtTime(DRV.on ? Math.min(.06, sp * W.wet * .0022) : 0, t, .2); }
};

// ------------------------------------------------------------------ menu
const seg = $('wxSeg');
function markSeg() { if (!seg) return; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.wx === kindId)); }
if (seg) { KINDS.forEach(k => { const b = document.createElement('button'); b.type = 'button'; b.textContent = k.name; b.dataset.wx = k.id; b.addEventListener('click', () => WX.set(k.id)); seg.appendChild(b); }); markSeg(); }
{ const r = $('rWx'); if (r) { r.value = power; r.addEventListener('input', () => WX.setPower(+r.value)); } }
A.remood();
})();
