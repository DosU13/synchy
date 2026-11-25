/* SYNCHY: cinematic photo booth (front end).
 * Runs full screen in Chrome on the projector and talks to server.js.
 *
 * Guest buttons (a wireless presentation clicker works):
 *   right / "next"  (PageDown, Right arrow, Space, Enter, left click)  = start, shoot
 *   left / "back"   (PageUp, Left arrow, right click)                   = another film
 * Operator keys:
 *   F full screen · A AI on/off · M montage sound · C next camera
 *   R reload films, config and clips · D status panel · Esc back to idle
 *   N next montage clip · X hide this montage clip for good
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'),
    frame: $('frame'),
    cam: $('cam'),
    demo: $('demo'),
    still: $('still'),
    result: $('result'),
    tint: $('tint'),
    grain: $('grain'),
    leader: $('leader'),
    flash: $('flash'),
    montage: $('montage'),
    montage2: $('montage2'),
    clipCaption: $('clipCaption'),
    titleCard: $('titleCard'),
    tcName: $('tcName'),
    tcSub: $('tcSub'),
    idleStill: $('idleStill'),
    idleImg: $('idleImg'),
    idleGrain: $('idleGrain'),
    eventName: $('eventName'),
    topText: $('topText'),
    statusDot: $('statusDot'),
    toast: $('toast'),
    filmTitle: $('filmTitle'),
    subLine: $('subLine'),
    hintLeft: $('hintLeft'),
    hintRight: $('hintRight'),
    debug: $('debug'),
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const DEFAULTS = {
    eventName: 'SYNCHY',
    eventSubtitle: '',
    languages: ['ky', 'ru'],
    frameAspect: 2.39,
    mirror: true,
    countdownSeconds: 3,
    minDevelopSeconds: 4,
    resultSeconds: 14,
    selectTimeoutSeconds: 30,
    idleStillEverySeconds: 16,
    idleStillSeconds: 7,
    montageSound: false,
    montage: { crossfadeSeconds: 1.2 },
    showStatusDot: true,
    camera: { width: 1920, height: 1080, labelContains: '' },
    ai: { enabled: true, timeoutSeconds: 45 },
    texts: {},
  };

  // Color looks for the live preview and for the offline version of a photo.
  // filter: CSS filter; tint: a color laid over the picture with a blend mode and strength.
  const GRADES = {
    natural: { filter: 'saturate(1) contrast(1.08)', tint: '#d9b48a', blend: 'soft-light', alpha: 0.15 },
    warm: { filter: 'saturate(1.35) contrast(1.06) brightness(1.04)', tint: '#ff9b45', blend: 'soft-light', alpha: 0.28 },
    soft: { filter: 'saturate(1.05) contrast(0.95) brightness(1.06)', tint: '#ffc994', blend: 'soft-light', alpha: 0.3 },
    dusk: { filter: 'saturate(1.1) contrast(1.1) brightness(0.98)', tint: '#ff7a59', blend: 'soft-light', alpha: 0.26 },
    period: { filter: 'sepia(0.65) saturate(0.75) contrast(1.15) brightness(0.95)', tint: '#6b4a2b', blend: 'soft-light', alpha: 0.3 },
    gritty: { filter: 'saturate(0.55) contrast(1.25) brightness(0.92)', tint: '#3f5a46', blend: 'soft-light', alpha: 0.35 },
    noir: { filter: 'grayscale(1) contrast(1.45) brightness(0.92)', tint: '', blend: 'soft-light', alpha: 0 },
    desert: { filter: 'sepia(0.25) saturate(1.25) contrast(1.15)', tint: '#e08a3c', blend: 'soft-light', alpha: 0.35 },
    neon: { filter: 'saturate(1.3) contrast(1.25) brightness(0.88)', tint: '#3a2a8f', blend: 'soft-light', alpha: 0.45 },
    luxe: { filter: 'saturate(1.1) contrast(1.3) brightness(0.92)', tint: '#c8902e', blend: 'soft-light', alpha: 0.35 },
    horror: { filter: 'saturate(0.35) contrast(1.3) brightness(0.82)', tint: '#2f4a3a', blend: 'soft-light', alpha: 0.45 },
    carnival: { filter: 'saturate(1.6) contrast(1.15) brightness(1.02)', tint: '#d6338f', blend: 'soft-light', alpha: 0.3 },
    cold: { filter: 'saturate(0.65) contrast(1.12)', tint: '#4f7fae', blend: 'soft-light', alpha: 0.4 },
    dream: { filter: 'saturate(0.9) contrast(0.9) brightness(1.08)', tint: '#ffb3c7', blend: 'soft-light', alpha: 0.3 },
    fire: { filter: 'saturate(1.4) contrast(1.2) brightness(0.95)', tint: '#ff4d00', blend: 'soft-light', alpha: 0.38 },
    village: { filter: 'sepia(0.12) saturate(1.2) contrast(1.08) brightness(1.05)', tint: '#ffbf69', blend: 'soft-light', alpha: 0.25 },
    doc: { filter: 'saturate(0.8) contrast(1.05)', tint: '#8a9a8f', blend: 'soft-light', alpha: 0.15 },
    teal: { filter: 'saturate(0.85) contrast(1.15) brightness(0.95)', tint: '#0f6a7a', blend: 'soft-light', alpha: 0.4 },
    rich: { filter: 'saturate(1.35) contrast(1.12)', tint: '#b8323f', blend: 'soft-light', alpha: 0.22 },
  };

  // ----------------------------------------------------------------- state
  let cfg = DEFAULTS;
  let films = [];
  let filmIdx = 0;
  let lastFilmId = '';
  let state = 'boot';
  let token = 0; // changes on every state switch, so stale async work can tell it is stale
  let gallery = [];
  let montageList = []; // [{ url, film, file }]
  let montageBuilding = false; // the server is cutting new trailers into clips
  let montageSound = false;
  const ai = { configured: false, mock: false, model: '', lastOk: null, lastMs: 0, lastError: '' };
  let aiOff = false;
  let camReady = false;
  let camError = '';
  let camTry = 0;
  let camDeviceId = '';
  let camRetryTimer = 0;
  let demoRAF = 0;
  let resultAt = 0;
  let idleCursor = 0;
  let setupError = '';
  let toastTimer = 0;
  const timers = { select: 0, result: 0, idleStill: 0, idleHide: 0, hint: 0, clearStill: 0 };
  const grainFrames = [];

  // ------------------------------------------------------------ config/text
  function deepMerge(base, extra) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
    const out = { ...base };
    for (const [k, v] of Object.entries(extra)) {
      const b = base ? base[k] : undefined;
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, v) : v;
    }
    return out;
  }

  async function loadSetup() {
    try {
      const res = await fetch('/api/setup', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      cfg = deepMerge(DEFAULTS, data.config || {});
      films = (data.films || []).filter((f) => f && f.id && f.title);
      gallery = data.gallery || [];
      montageList = normalizeMontage(data.montage);
      montageBuilding = Boolean(data.montageBuilding);
      ai.configured = Boolean(data.ai && data.ai.configured);
      ai.mock = Boolean(data.ai && data.ai.mock);
      ai.model = (data.ai && data.ai.model) || '';
      setupError = '';
    } catch (err) {
      setupError = String(err.message || err);
      console.error('setup failed:', err);
    }
    if (!films.length) films = [{ id: 'film', title: 'Кино', grade: 'natural' }];
    filmIdx = Math.min(filmIdx, films.length - 1);
    montageSound = Boolean(cfg.montageSound);
    document.documentElement.style.setProperty('--ar', String(Number(cfg.frameAspect) || 2.39));
    document.documentElement.style.setProperty('--xfade', `${xfadeMs() / 1000}s`);
    el.eventName.textContent = cfg.eventName || '';
    el.tcName.textContent = cfg.eventName || '';
    el.tcSub.textContent = cfg.eventSubtitle || '';
    el.cam.classList.toggle('mirror', Boolean(cfg.mirror));
    if (setupError) el.debug.hidden = false;
    updateStatusDot();
  }

  function lines(key) {
    const entry = (cfg.texts || {})[key];
    if (!entry) return [];
    if (typeof entry === 'string') return [entry];
    return (cfg.languages || ['ky', 'ru']).map((lang) => entry[lang]).filter(Boolean);
  }

  function render(node, arr) {
    node.replaceChildren(
      ...arr.map((txt, i) => {
        const span = document.createElement('span');
        span.className = `ln ln${Math.min(i, 1)}`;
        span.textContent = txt;
        return span;
      }),
    );
  }

  function showTitle(arr, cls = '') {
    render(el.filmTitle, arr);
    el.filmTitle.className = `film-title ${cls}`.trim();
  }

  function filmLabel(film) {
    return [`«${film.title}»`];
  }

  function renderHint(node, key, dir) {
    node.replaceChildren();
    if (!key) return;
    const arrow = document.createElement('i');
    arrow.className = `arrow ${dir}`;
    const text = document.createElement('span');
    render(text, lines(key));
    if (dir === 'left') node.append(arrow, text);
    else node.append(text, arrow);
  }

  function showHints(leftKey, rightKey) {
    renderHint(el.hintLeft, leftKey, 'left');
    renderHint(el.hintRight, rightKey, 'right');
  }

  function showTop(key) {
    if (key) render(el.topText, lines(key));
    else el.topText.replaceChildren();
    el.eventName.hidden = Boolean(key);
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2500);
  }

  // ---------------------------------------------------------- state machine
  function setState(name) {
    state = name;
    token += 1;
    el.stage.className = `state-${name}`;
    for (const k of Object.keys(timers)) {
      clearTimeout(timers[k]);
      timers[k] = 0;
    }
    if (name !== 'countdown') clearLeader();
    if (name !== 'idle') {
      pauseMontage();
      el.idleStill.classList.remove('show');
    }
    return token;
  }

  function enterIdle({ latestFirst = false } = {}) {
    setState('idle');
    el.result.classList.remove('show');
    el.still.className = '';
    attractText();
    playMontage();
    if (!montageList.length) refreshMontage(true); // clips may have been cut meanwhile
    idleCursor = 0;
    scheduleIdleStill(latestFirst ? 1500 : idleGap() * 1000);
  }

  // Seconds between guest photos in idle; more often when there is no montage to watch.
  function idleGap() {
    const every = Number(cfg.idleStillEverySeconds) || 16;
    return montageList.length ? every : Math.max(2, every / 3);
  }

  function attractText() {
    showTitle(lines('attract'), 'attract');
    render(el.subLine, []);
    showHints(null, 'start');
    showTop(null);
  }

  function pickRandomFilm() {
    if (films.length < 2) return 0;
    let i = filmIdx;
    for (let n = 0; n < 10; n++) {
      i = Math.floor(Math.random() * films.length);
      if (films[i].id !== lastFilmId) break;
    }
    return i;
  }

  function enterSelect() {
    setState('select');
    el.result.classList.remove('show');
    el.still.className = '';
    filmIdx = pickRandomFilm();
    applyFilm(true);
    render(el.subLine, []);
    showHints('changeFilm', 'shoot');
    showTop(null);
    armSelectTimeout();
  }

  function armSelectTimeout() {
    clearTimeout(timers.select);
    timers.select = setTimeout(() => {
      if (state === 'select') enterIdle();
    }, cfg.selectTimeoutSeconds * 1000);
  }

  function nextFilm(step) {
    filmIdx = (filmIdx + step + films.length) % films.length;
    applyFilm(true);
    armSelectTimeout();
  }

  function applyFilm(animate) {
    const film = films[filmIdx];
    const g = GRADES[film.grade] || GRADES.natural;
    el.cam.style.filter = g.filter || 'none';
    el.demo.style.filter = g.filter || 'none';
    el.tint.style.backgroundColor = g.tint || 'transparent';
    el.tint.style.mixBlendMode = g.blend || 'soft-light';
    el.stage.style.setProperty('--tint-a', g.tint ? String(g.alpha) : '0');
    showTitle(filmLabel(film), 'film');
    if (animate) {
      el.filmTitle.classList.remove('flip');
      void el.filmTitle.offsetWidth; // restart the animation
      el.filmTitle.classList.add('flip');
    }
  }

  async function startCountdown() {
    const tk = setState('countdown');
    const film = films[filmIdx];
    showHints(null, null);
    showTop('getReady');
    sizeLeader();
    const total = Math.max(1, Number(cfg.countdownSeconds) || 3) * 1000;
    const t0 = performance.now();
    await new Promise((resolve) => {
      const step = (now) => {
        if (tk !== token) return resolve();
        const e = now - t0;
        if (e >= total) return resolve();
        drawLeader(Math.ceil((total - e) / 1000), (e % 1000) / 1000);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    if (tk !== token) return;
    clearLeader();
    await develop(film);
  }

  async function develop(film) {
    const tk = setState('developing');
    showTop(null);
    showHints(null, null);
    showTitle(filmLabel(film), 'film');
    render(el.subLine, lines('developing'));

    flash();
    const shot = grabFrame();
    const dataUrl = shot.toDataURL('image/jpeg', 0.92);
    lastFilmId = film.id;

    // Show the photo as a negative that slowly develops while the AI works.
    el.still.className = '';
    el.still.style.setProperty('--dev-s', '10s');
    await loadImage(el.still, dataUrl).catch(() => {});
    if (tk !== token) return;
    el.still.classList.add('show', 'negative');
    void el.still.offsetWidth; // commit the negative look before animating away from it
    el.still.classList.remove('negative');
    el.still.classList.add('developing');

    const minWait = sleep(Math.max(1, Number(cfg.minDevelopSeconds) || 4) * 1000);
    let url = '';
    let kind = 'local';
    if (aiUsable()) {
      try {
        const r = await stylize(film.id, dataUrl);
        url = r.url;
        kind = 'ai';
      } catch {
        /* fall back to the offline look below */
      }
    }
    if (tk !== token) return;
    if (!url) {
      url = renderLocal(shot, film).toDataURL('image/jpeg', 0.92);
      saveLocal(film.id, url);
    }
    await minWait;
    if (tk !== token) return;
    try {
      await loadImage(el.result, url);
    } catch {
      await loadImage(el.result, dataUrl).catch(() => {});
    }
    if (tk !== token) return;
    showResult(film, kind);
  }

  function showResult(film, kind) {
    const tk = setState('result');
    el.result.classList.add('show');
    timers.clearStill = setTimeout(() => {
      if (tk === token) el.still.className = '';
    }, 1600);
    showTitle(filmLabel(film), 'film');
    render(el.subLine, lines('starring'));
    showHints(null, null);
    showTop(null);
    resultAt = performance.now();
    timers.hint = setTimeout(() => {
      if (tk === token) showHints(null, 'again');
    }, 3000);
    timers.result = setTimeout(() => {
      if (tk === token) enterIdle({ latestFirst: true });
    }, Math.max(3, Number(cfg.resultSeconds) || 14) * 1000);
    updateStatusDot();
    if (kind !== 'ai' && aiUsable()) toast('offline look (AI failed)');
  }

  // ------------------------------------------------------------- the camera
  function startCamera() {
    clearTimeout(camRetryTimer);
    const myTry = ++camTry;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      enableDemo('this browser has no camera access');
      return;
    }
    const video = { width: { ideal: cfg.camera.width }, height: { ideal: cfg.camera.height } };
    if (camDeviceId) video.deviceId = { exact: camDeviceId };
    // If the permission prompt is never answered, show the demo picture meanwhile.
    const waitTimer = setTimeout(() => {
      if (myTry === camTry && !camReady) enableDemo('waiting for camera permission');
    }, 8000);
    navigator.mediaDevices
      .getUserMedia({ video, audio: false })
      .then(async (stream) => {
        clearTimeout(waitTimer);
        if (myTry !== camTry) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        stopStream();
        el.cam.srcObject = stream;
        try {
          await el.cam.play();
        } catch {
          /* autoplay of a muted video is allowed; ignore */
        }
        camReady = true;
        camError = '';
        disableDemo();
        const track = stream.getVideoTracks()[0];
        track.addEventListener('ended', () => {
          if (myTry !== camTry) return;
          camReady = false;
          enableDemo('camera disconnected');
          camRetryTimer = setTimeout(startCamera, 3000);
        });
        // Prefer the camera whose name contains config.camera.labelContains.
        const want = String(cfg.camera.labelContains || '').toLowerCase();
        if (want && !camDeviceId && !track.label.toLowerCase().includes(want)) {
          const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
          const match = devices.find((d) => d.label.toLowerCase().includes(want));
          if (match) {
            camDeviceId = match.deviceId;
            startCamera();
            return;
          }
        }
        updateStatusDot();
      })
      .catch((err) => {
        clearTimeout(waitTimer);
        if (myTry !== camTry) return;
        camReady = false;
        if (err && err.name === 'OverconstrainedError') camDeviceId = '';
        enableDemo((err && err.name) || String(err));
        if (!err || err.name !== 'NotAllowedError') camRetryTimer = setTimeout(startCamera, 5000);
      });
  }

  function stopStream() {
    const s = el.cam.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    el.cam.srcObject = null;
  }

  async function nextCamera() {
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      /* ignore */
    }
    if (!devices.length) {
      toast('no camera found');
      startCamera();
      return;
    }
    const track = el.cam.srcObject && el.cam.srcObject.getVideoTracks()[0];
    const current = track ? track.getSettings().deviceId : camDeviceId;
    const i = devices.findIndex((d) => d.deviceId === current);
    const next = devices[(i + 1) % devices.length];
    camDeviceId = next.deviceId;
    toast(`camera: ${next.label || 'camera ' + ((i + 1) % devices.length + 1)}`);
    startCamera();
  }

  function enableDemo(reason) {
    camError = reason;
    if (!el.demo.hidden) return updateStatusDot();
    el.demo.hidden = false;
    el.cam.hidden = true;
    startDemoFeed();
    updateStatusDot();
  }

  function disableDemo() {
    el.demo.hidden = true;
    el.cam.hidden = false;
    cancelAnimationFrame(demoRAF);
    demoRAF = 0;
  }

  // A moving test picture, used when there is no camera.
  function startDemoFeed() {
    const c = el.demo;
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext('2d');
    const blobs = Array.from({ length: 16 }, () => ({
      x: Math.random() * 1280,
      y: Math.random() * 720,
      r: 30 + Math.random() * 90,
      vx: (Math.random() - 0.5) * 0.6,
      hue: Math.floor(Math.random() * 360),
    }));
    cancelAnimationFrame(demoRAF);
    const draw = (t) => {
      const bg = ctx.createLinearGradient(0, 0, 0, 720);
      bg.addColorStop(0, '#34466a');
      bg.addColorStop(1, '#141a26');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1280, 720);
      for (const b of blobs) {
        b.x = (b.x + b.vx + 1280) % 1280;
        ctx.beginPath();
        ctx.fillStyle = `hsla(${b.hue}, 70%, 70%, 0.13)`;
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
      const sway = Math.sin(t / 900) * 14;
      ctx.fillStyle = '#3b4a66';
      ctx.beginPath();
      ctx.ellipse(640 + sway * 0.6, 720, 250, 230, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#c9a27e';
      ctx.beginPath();
      ctx.ellipse(640 + sway, 380, 72, 92, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '600 24px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('DEMO · камера табылган жок · камера не найдена', 640, 236);
      demoRAF = requestAnimationFrame(draw);
    };
    demoRAF = requestAnimationFrame(draw);
  }

  // Grabs exactly the part of the camera picture that is visible in the frame.
  function grabFrame() {
    const useCam = camReady && el.cam.videoWidth > 0;
    const src = useCam ? el.cam : el.demo;
    const sw0 = useCam ? el.cam.videoWidth : el.demo.width;
    const sh0 = useCam ? el.cam.videoHeight : el.demo.height;
    const ar = Number(cfg.frameAspect) || 2.39;
    let sw = sw0;
    let sh = sw0 / ar;
    if (sh > sh0) {
      sh = sh0;
      sw = sh0 * ar;
    }
    const sx = (sw0 - sw) / 2;
    const sy = (sh0 - sh) / 2;
    const outW = Math.round(Math.min(sw, 1920));
    const outH = Math.round(outW / ar);
    const c = document.createElement('canvas');
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext('2d');
    if (useCam && cfg.mirror) {
      ctx.translate(outW, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, outW, outH);
    return c;
  }

  // The offline version: the film's color look, glow, vignette and grain.
  function renderLocal(src, film) {
    const g = GRADES[film.grade] || GRADES.natural;
    const w = src.width;
    const h = src.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.filter = g.filter || 'none';
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
    if (g.tint) {
      ctx.globalCompositeOperation = g.blend || 'soft-light';
      ctx.globalAlpha = g.alpha;
      ctx.fillStyle = g.tint;
      ctx.fillRect(0, 0, w, h);
    }
    const glow = document.createElement('canvas');
    glow.width = w;
    glow.height = h;
    const gctx = glow.getContext('2d');
    gctx.filter = `blur(${Math.max(4, Math.round(w / 90))}px)`;
    gctx.drawImage(c, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.16;
    ctx.drawImage(glow, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 1;
    const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
    vg.addColorStop(0, '#ffffff');
    vg.addColorStop(1, '#3a3a3a');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    if (grainFrames.length) {
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.28;
      ctx.drawImage(grainFrames[Math.floor(Math.random() * grainFrames.length)], 0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    return c;
  }

  // -------------------------------------------------------------------- AI
  function aiUsable() {
    return ai.configured && !aiOff && cfg.ai.enabled !== false;
  }

  async function stylize(filmId, dataUrl) {
    const ctrl = new AbortController();
    const limit = ((Number(cfg.ai.timeoutSeconds) || 45) + 5) * 1000;
    const timer = setTimeout(() => ctrl.abort(), limit);
    const t0 = performance.now();
    try {
      const res = await fetch('/api/stylize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filmId, image: dataUrl }),
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      ai.lastOk = true;
      ai.lastMs = performance.now() - t0;
      ai.lastError = '';
      if (json.model) ai.model = json.model;
      if (json.entry) gallery.unshift(json.entry);
      return json;
    } catch (err) {
      ai.lastOk = false;
      ai.lastMs = performance.now() - t0;
      ai.lastError = err.name === 'AbortError' ? 'timed out' : String(err.message || err);
      throw err;
    } finally {
      clearTimeout(timer);
      updateStatusDot();
    }
  }

  function saveLocal(filmId, dataUrl) {
    fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filmId, image: dataUrl }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok && j.entry) gallery.unshift(j.entry);
      })
      .catch(() => {});
  }

  function loadImage(img, url) {
    return new Promise((resolve, reject) => {
      const abs = new URL(url, location.href).href;
      if (img.src === abs && img.complete && img.naturalWidth) return resolve();
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`could not load ${url.slice(0, 60)}`));
      img.src = url;
    });
  }

  // ------------------------------------------------------ idle: montage etc.
  // The montage plays in rounds: in every round each film shows one of its clips, in a
  // random order, so every film gets the same screen time; each film's clips take turns.
  // Two video layers: the next clip is loaded into the hidden layer and fades in on top.
  const mv = {
    layers: [el.montage, el.montage2],
    active: -1, // index of the layer on screen, -1 before the first clip
    item: null, // the clip on screen
    ready: null, // { idx, item }: the clip waiting in the hidden layer
    gen: 0, // changes whenever playback restarts or pauses, so stale callbacks stop
    loading: false,
    timer: 0,
    round: [], // films still to show in this round
    pools: new Map(), // film -> its clips not shown yet in this cycle
    lastGroup: '',
    fetchedAt: 0,
    refreshTimer: 0,
    captionTimer: 0,
  };

  function normalizeMontage(list) {
    return (Array.isArray(list) ? list : [])
      .map((m) => (typeof m === 'string' ? { url: m, film: '', file: '' } : m))
      .filter((m) => m && m.url)
      .map((m) => ({ url: String(m.url), film: String(m.film || ''), file: String(m.file || '') }));
  }

  function xfadeMs() {
    const s = Number(cfg.montage && cfg.montage.crossfadeSeconds);
    return Number.isFinite(s) ? Math.max(0, Math.min(5, s)) * 1000 : 1200;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Clips of one film form a group; a video without a film is a group of its own.
  function groupKey(item) {
    return item.film || item.url;
  }

  function nextMontageItem(depth = 0) {
    if (!montageList.length || depth > 2) return null;
    const byUrl = new Map(montageList.map((m) => [m.url, m]));
    if (!mv.round.length) {
      const groups = new Map();
      for (const m of montageList) {
        const k = groupKey(m);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(m.url);
      }
      mv.round = shuffle([...groups.keys()]);
      if (mv.round.length > 1 && mv.round[0] === mv.lastGroup) mv.round.push(mv.round.shift());
      for (const [k, urls] of groups) {
        const left = (mv.pools.get(k) || []).filter((u) => byUrl.has(u));
        mv.pools.set(k, left.length ? left : shuffle(urls.slice()));
      }
      refreshMontage(false); // pick up clips cut since the last look
    }
    while (mv.round.length) {
      const k = mv.round.shift();
      const pool = mv.pools.get(k) || [];
      while (pool.length) {
        const url = pool.pop();
        if (byUrl.has(url)) {
          mv.lastGroup = k;
          return byUrl.get(url);
        }
      }
    }
    return nextMontageItem(depth + 1);
  }

  function showTitleCard(on) {
    el.titleCard.hidden = !on;
    el.stage.dataset.montage = on ? '0' : '1';
    if (!on) return;
    for (const v of mv.layers) {
      v.classList.remove('on');
      if (!v.paused) v.pause();
    }
    mv.active = -1;
    mv.item = null;
    mv.ready = null;
    showClipCaption();
  }

  function playMontage() {
    if (!montageList.length) {
      mv.gen += 1;
      clearTimeout(mv.timer);
      showTitleCard(true);
      return;
    }
    showTitleCard(false);
    for (const v of mv.layers) v.muted = !montageSound;
    const cur = mv.active >= 0 ? mv.layers[mv.active] : null;
    const stillListed = mv.item && montageList.some((m) => m.url === mv.item.url);
    if (cur && stillListed && !cur.ended && !cur.error) {
      // back from the booth: go on where the montage stopped
      const gen = ++mv.gen;
      playVideo(cur);
      armMontage(gen);
      if (!mv.ready && montageList.length > 1) preloadNext(gen);
      showClipCaption();
      return;
    }
    advanceMontage();
  }

  function pauseMontage() {
    mv.gen += 1;
    mv.loading = false;
    clearTimeout(mv.timer);
    for (const v of mv.layers) if (!v.paused) v.pause();
  }

  function playVideo(v) {
    const p = v.play();
    if (p) {
      p.catch(() => {
        if (v.muted) return;
        v.muted = true; // the browser blocked sound: play silently
        v.play().catch(() => {});
      });
    }
  }

  function loadLayer(v, item) {
    v.classList.remove('on');
    v.loop = false;
    v.dataset.url = item.url;
    v.src = item.url;
    v.load();
  }

  // True when the layer can play; false when the clip fails or takes too long to load.
  function whenReady(v, ms) {
    if (v.readyState >= 3) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = 0;
      const done = (ok) => {
        clearTimeout(timer);
        v.removeEventListener('canplay', yes);
        v.removeEventListener('error', no);
        resolve(ok);
      };
      const yes = () => done(true);
      const no = () => done(false);
      timer = setTimeout(() => done(v.readyState >= 3), ms);
      v.addEventListener('canplay', yes);
      v.addEventListener('error', no);
    });
  }

  function preloadNext(gen) {
    if (gen !== mv.gen || mv.active < 0) return;
    const item = nextMontageItem();
    if (!item) return;
    const idx = 1 - mv.active;
    loadLayer(mv.layers[idx], item);
    mv.ready = { idx, item };
  }

  // Fades the next clip in over the one on screen.
  async function advanceMontage() {
    const gen = ++mv.gen;
    clearTimeout(mv.timer);
    if (state !== 'idle') return;
    if (!montageList.length) {
      showTitleCard(true);
      return;
    }
    showTitleCard(false);
    const idx = mv.active < 0 ? 0 : 1 - mv.active;
    const v = mv.layers[idx];
    let item = mv.ready && mv.ready.idx === idx ? mv.ready.item : null;
    mv.ready = null;
    mv.loading = true;
    for (let tries = 0; tries < Math.min(5, montageList.length + 1); tries++) {
      if (!item) {
        item = nextMontageItem();
        if (!item) break;
        loadLayer(v, item);
      }
      const ok = await whenReady(v, 4000);
      if (gen !== mv.gen) return;
      if (ok) break;
      console.warn('montage: could not play', item.url);
      item = null;
    }
    mv.loading = false;
    if (!item) {
      // nothing loads right now: keep what is on screen and try again shortly
      if (mv.active < 0) showTitleCard(true);
      mv.timer = setTimeout(() => {
        if (gen === mv.gen && state === 'idle') advanceMontage();
      }, 5000);
      return;
    }
    const single = montageList.length === 1;
    const old = mv.active >= 0 && mv.active !== idx ? mv.layers[mv.active] : null;
    v.loop = single;
    v.muted = !montageSound;
    try {
      v.currentTime = 0;
    } catch {
      /* not seekable yet */
    }
    playVideo(v);
    // start the fade from transparent, even if this layer was still showing a moment ago
    v.style.transition = 'none';
    v.classList.remove('on');
    void v.offsetWidth;
    v.style.transition = '';
    v.style.zIndex = '2';
    if (old) old.style.zIndex = '1';
    v.classList.add('on');
    mv.active = idx;
    mv.item = item;
    showClipCaption();
    setTimeout(
      () => {
        if (gen !== mv.gen) return;
        if (old) {
          old.classList.remove('on');
          old.pause();
        }
        if (!single) preloadNext(gen);
      },
      old ? xfadeMs() + 80 : 0,
    );
    armMontage(gen);
  }

  // Starts the next crossfade so that it ends just as the clip on screen ends.
  function armMontage(gen) {
    clearTimeout(mv.timer);
    if (gen !== mv.gen || mv.active < 0) return;
    const v = mv.layers[mv.active];
    if (v.loop) return;
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) {
      mv.timer = setTimeout(() => armMontage(gen), 250);
      return;
    }
    const left = (d - v.currentTime) * 1000 - xfadeMs();
    mv.timer = setTimeout(() => {
      if (gen === mv.gen && state === 'idle') advanceMontage();
    }, Math.max(0, left));
  }

  for (const v of mv.layers) {
    v.addEventListener('ended', () => {
      if (state === 'idle' && mv.layers[mv.active] === v && !v.loop && !mv.loading) advanceMontage();
    });
  }

  function clipFilmTitle(item) {
    const film = item && item.film ? films.find((f) => f.id === item.film) : null;
    return film ? `«${film.title}»` : '';
  }

  // The film of the clip on screen, bottom left; hidden while a guest's photo is shown.
  function showClipCaption() {
    const text = clipFilmTitle(mv.item);
    const cap = el.clipCaption;
    const visible = Boolean(text) && state === 'idle' && !el.idleStill.classList.contains('show');
    clearTimeout(mv.captionTimer);
    if (!visible) {
      cap.classList.remove('show');
      return;
    }
    if (cap.textContent === text) {
      cap.classList.add('show');
    } else if (cap.classList.contains('show')) {
      cap.classList.remove('show');
      mv.captionTimer = setTimeout(() => {
        cap.textContent = text;
        cap.classList.add('show');
      }, 600);
    } else {
      cap.textContent = text;
      cap.classList.add('show');
    }
  }

  // Asks the server for the clip list again (new trailers are cut while the booth runs).
  async function refreshMontage(force) {
    clearTimeout(mv.refreshTimer);
    if (!force && Date.now() - mv.fetchedAt < 60000) return;
    mv.fetchedAt = Date.now();
    try {
      const res = await fetch('/api/montage', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && Array.isArray(data.montage)) {
        montageList = normalizeMontage(data.montage);
        montageBuilding = Boolean(data.building);
      }
    } catch {
      /* keep the list we have */
    }
    if (state !== 'idle') return;
    if (!montageList.length) {
      mv.refreshTimer = setTimeout(() => refreshMontage(true), 30000);
    } else if (mv.active < 0 && !mv.loading) {
      playMontage();
    }
  }

  // X on the booth: this clip is never shown again.
  function hideClip(item) {
    fetch('/api/montage/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: item.file }),
    })
      .then((r) => r.json())
      .then((j) => toast(j && j.ok ? `clip hidden: ${item.file}` : 'could not hide this clip'))
      .catch(() => toast('could not hide this clip'));
    montageList = montageList.filter((m) => m.url !== item.url);
    if (mv.ready && mv.ready.item.url === item.url) mv.ready = null;
    advanceMontage();
  }

  function scheduleIdleStill(delay) {
    clearTimeout(timers.idleStill);
    if (!gallery.length) return;
    timers.idleStill = setTimeout(showIdleStill, delay);
  }

  async function showIdleStill() {
    const tk = token;
    if (state !== 'idle' || !gallery.length) return;
    const pool = gallery.slice(0, 40);
    const entry = pool[idleCursor % pool.length];
    idleCursor += 1;
    try {
      await loadImage(el.idleImg, entry.url);
    } catch {
      scheduleIdleStill(2000);
      return;
    }
    if (tk !== token) return;
    const film = films.find((f) => f.id === entry.filmId);
    el.idleStill.classList.add('show');
    showClipCaption();
    showTitle(film ? filmLabel(film) : [], 'film');
    render(el.subLine, lines('guestsStarring'));
    timers.idleHide = setTimeout(() => {
      if (tk !== token) return;
      el.idleStill.classList.remove('show');
      attractText();
      showClipCaption();
      scheduleIdleStill(idleGap() * 1000);
    }, cfg.idleStillSeconds * 1000);
  }

  // ------------------------------------------------------ visual helpers
  function buildGrain() {
    const W = 480;
    const H = 200;
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(W, H);
      const d = img.data;
      for (let p = 0; p < d.length; p += 4) {
        const v = 128 + (Math.random() - 0.5) * 230;
        d[p] = v;
        d[p + 1] = v;
        d[p + 2] = v;
        d[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      grainFrames.push(c);
    }
    for (const c of [el.grain, el.idleGrain]) {
      c.width = W;
      c.height = H;
    }
  }

  let grainI = 0;
  function grainTick() {
    grainI = (grainI + 1) % grainFrames.length;
    const f = grainFrames[grainI];
    for (const c of [el.grain, el.idleGrain]) c.getContext('2d').drawImage(f, 0, 0);
  }

  function sizeLeader() {
    const r = el.frame.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.leader.width = Math.max(1, Math.round(r.width * dpr));
    el.leader.height = Math.max(1, Math.round(r.height * dpr));
  }

  function clearLeader() {
    el.leader.getContext('2d').clearRect(0, 0, el.leader.width, el.leader.height);
  }

  // The countdown, drawn like an old film leader.
  function drawLeader(num, frac) {
    const c = el.leader;
    const ctx = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = h * 0.4;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, w, h);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, Math.hypot(w, h), -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = Math.max(1, h * 0.004);
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(2, h * 0.008);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `700 ${Math.round(h * 0.5)}px Cambria, Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), cx, cy + h * 0.02);
  }

  function flash() {
    el.flash.classList.remove('go');
    void el.flash.offsetWidth;
    el.flash.classList.add('go');
  }

  // ----------------------------------------------------- status and debug
  function updateStatusDot() {
    const d = el.statusDot;
    d.hidden = !cfg.showStatusDot;
    let cls = 'ok';
    let title = 'AI ready';
    if (!camReady) {
      cls = 'bad';
      title = `no camera: ${camError || 'starting'}`;
    } else if (aiOff || !ai.configured || cfg.ai.enabled === false) {
      cls = 'off';
      title = 'AI off: offline film look';
    } else if (ai.mock) {
      cls = 'mock';
      title = 'test mode';
    } else if (ai.lastOk === false) {
      cls = 'bad';
      title = `last AI photo failed: ${ai.lastError}`;
    }
    d.className = `status-dot ${cls}`;
    d.title = title;
  }

  function renderDebug() {
    if (el.debug.hidden) return;
    const film = films[filmIdx];
    const track = el.cam.srcObject && el.cam.srcObject.getVideoTracks()[0];
    const s = track ? track.getSettings() : {};
    let aiLine = 'on';
    if (aiOff) aiLine = 'OFF (press A to turn on)';
    else if (!ai.configured) aiLine = 'no GEMINI_API_KEY in .env (offline look)';
    else if (ai.mock) aiLine = 'TEST MODE (mock)';
    let last = '-';
    if (ai.lastOk === true) last = `ok in ${(ai.lastMs / 1000).toFixed(1)}s`;
    else if (ai.lastOk === false) last = `FAILED: ${ai.lastError}`;
    el.debug.textContent = [
      setupError ? `SETUP ERROR: ${setupError}\n` : '',
      `state:   ${state}`,
      `film:    ${film ? film.title : '-'} (${filmIdx + 1}/${films.length})`,
      `camera:  ${camReady && track ? `${track.label} ${s.width}x${s.height}` : `none, demo picture (${camError || 'starting'})`}`,
      `AI:      ${aiLine}   model: ${ai.model || '-'}`,
      `last AI: ${last}`,
      `photos:  ${gallery.length}`,
      `montage: ${montageList.length} clips from ${new Set(montageList.map(groupKey)).size} films` +
        `${montageBuilding ? ' (cutting new trailers...)' : ''}   sound: ${montageSound ? 'on' : 'off'}`,
      `clip:    ${mv.item ? `${clipFilmTitle(mv.item)}  ${mv.item.file || mv.item.url}` : '-'}`,
      '',
      'guest:   PageDown / → / Space / Enter = start, shoot    PageUp / ← = other film',
      'keys:    F full screen · A AI on/off · M sound · C next camera · R reload · Esc idle · D hide',
      '         N next clip · X hide this clip for good (montage/hidden.txt)',
    ]
      .filter((line, i) => i > 0 || line)
      .join('\n');
  }

  // ------------------------------------------------------------------ input
  const PRIMARY = new Set(['PageDown', 'ArrowRight', 'ArrowDown', 'Enter', ' ', 'Spacebar', 'F5', 'MediaPlayPause']);
  const SECONDARY = new Set(['PageUp', 'ArrowLeft', 'ArrowUp', 'Backspace']);

  function onPrimary() {
    if (state === 'idle') enterSelect();
    else if (state === 'select') startCountdown();
    else if (state === 'result' && performance.now() - resultAt > 2500) enterSelect();
  }

  function onSecondary() {
    if (state === 'idle') enterSelect();
    else if (state === 'select') nextFilm(1);
    else if (state === 'result' && performance.now() - resultAt > 2500) enterSelect();
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    if (PRIMARY.has(k) || SECONDARY.has(k)) {
      e.preventDefault();
      if (e.repeat) return;
      if (PRIMARY.has(k)) onPrimary();
      else onSecondary();
      return;
    }
    if (k === 'Escape') {
      if (state !== 'idle') enterIdle();
      return;
    }
    switch (k.toLowerCase()) {
      case 'f':
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen().catch(() => {});
        break;
      case 'a':
        aiOff = !aiOff;
        toast(aiOff ? 'AI off: offline look' : 'AI on');
        updateStatusDot();
        break;
      case 'm':
        montageSound = !montageSound;
        for (const v of mv.layers) v.muted = !montageSound;
        toast(montageSound ? 'montage sound on' : 'montage sound off');
        break;
      case 'c':
        nextCamera();
        break;
      case 'r':
        loadSetup().then(() => {
          mv.round = [];
          mv.pools.clear();
          mv.fetchedAt = Date.now();
          toast(setupError ? 'reload failed' : `reloaded: ${films.length} films, ${montageList.length} clips`);
          if (state === 'idle') playMontage();
          else if (state === 'select') applyFilm(false);
        });
        break;
      case 'n':
        if (state === 'idle' && montageList.length > 1) advanceMontage();
        break;
      case 'x':
        if (state === 'idle' && mv.item && mv.item.file) hideClip(mv.item);
        break;
      case 'd':
        el.debug.hidden = !el.debug.hidden;
        renderDebug();
        break;
      default:
        break;
    }
  });

  window.addEventListener('pointerdown', (e) => {
    if (e.button === 0) onPrimary();
    else if (e.button === 2) onSecondary();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keep the screen awake during the event.
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
    } catch {
      /* not critical */
    }
  }
  document.addEventListener('visibilitychange', keepAwake);

  window.addEventListener('resize', () => {
    if (state === 'countdown') sizeLeader();
  });

  // ------------------------------------------------------------------- boot
  async function boot() {
    buildGrain();
    setInterval(grainTick, 1000 / 24);
    await loadSetup();
    startCamera();
    keepAwake();
    enterIdle();
    setInterval(renderDebug, 500);
  }

  boot();
})();
