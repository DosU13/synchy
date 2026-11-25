#!/usr/bin/env node
/*
 * SYNCHY: cinematic photo booth server.
 * Needs only Node.js 18 or newer (no "npm install").
 *
 *   node server.js           start on http://localhost:8080
 *   node server.js --open    start and open the booth in Chrome
 *   node server.js --kiosk   start and open it full screen (kiosk mode)
 *   node server.js --mock    test mode: no AI calls, the photo comes back unchanged
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, '.env'));

const ARGS = new Set(process.argv.slice(2));
const PORT = parseInt(process.env.PORT, 10) || 8080;
const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const MOCK = ARGS.has('--mock') || process.env.MOCK_AI === '1';
const KIOSK = ARGS.has('--kiosk');
const OPEN = KIOSK || ARGS.has('--open');

// Tried in this order until one answers; the one that works is remembered.
const MODEL_CHAIN = unique([
  (process.env.GEMINI_MODEL || '').trim(),
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-2.5-flash-image',
]);
const API_BASES = (process.env.GEMINI_API_BASE || '').trim()
  ? unique(process.env.GEMINI_API_BASE.split(',').map((s) => s.trim().replace(/\/+$/, '')))
  : ['https://generativelanguage.googleapis.com/v1', 'https://generativelanguage.googleapis.com/v1beta'];

const CONFIG_FILE = path.join(ROOT, 'config.json');
const FILMS_FILE = path.join(ROOT, 'films.json');
const DIR = {
  public: path.join(ROOT, 'public'),
  montage: path.join(ROOT, 'montage'),
  clips: path.join(ROOT, 'montage', 'clips'),
  trailers: path.join(ROOT, 'trailers'),
  captures: path.join(ROOT, 'captures'),
};
for (const d of [DIR.montage, DIR.trailers, DIR.captures]) fs.mkdirSync(d, { recursive: true });
// Montage clips are cut from the trailers by tools/build-montage.js (see README).
const CLIPS_MANIFEST = path.join(DIR.montage, 'clips.json');
const HIDDEN_FILE = path.join(DIR.montage, 'hidden.txt');
const BUILD_SCRIPT = path.join(ROOT, 'tools', 'build-montage.js');
const CLIP_RE = /^[a-z0-9-]+__[0-9a-f]{4}__\d+(?:\.\d+)?\.mp4$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov']);
const PHOTO_RE = /^(\d{8}-\d{6}-\d{3})__([a-z0-9-]+)__(ai|local)\.(jpe?g|png|webp)$/i;
const ID_RE = /^[a-z0-9-]{1,60}$/;
const BODY_LIMIT = 30 * 1024 * 1024;

// Fallback prompts; config.json (ai.promptTemplate, ai.referencePromptTemplate) normally replaces them.
const DEFAULT_PROMPT = [
  'Create a widescreen movie poster artwork (key art) for the film "{title}", with the people in this photo as its stars.',
  'About the film and its look: {look}',
  "Keep every person's face, identity, age, gender, skin tone and expression exactly as in the photo.",
  'Photorealistic, dramatic poster lighting and color grading. No lettering, logos or borders.',
];
// Used when the film has promotional pictures in refs/<film-id>/ (they are sent after the photo).
const REFERENCE_PROMPT = [
  'Create a widescreen movie poster artwork (key art) for the film "{title}", with the people in the first image as its stars.',
  "The other images are the film's official poster and stills: follow their idea, composition, colors, light, wardrobe and setting, but make a new picture.",
  'Never copy the faces or identities of the actors in them.',
  'About the film: {look}',
  "Keep every person's face, identity, age, gender, skin tone and expression exactly as in the first image, and keep the same number of people.",
  'Photorealistic. No lettering, logos, borders or black bars. No blood, wounds or weapons.',
];
const REFS_DIR = path.join(ROOT, 'refs');
const REF_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const REF_MAX_BYTES = 4 * 1024 * 1024;

let workingModel = '';
let workingBase = '';
const modelLevel = new Map(); // model -> how many optional settings had to be dropped
let lastAi = { ok: null, ms: 0, error: '', model: '' };

// ---------------------------------------------------------------- HTTP

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);

    if (p === '/api/setup' && req.method === 'GET') return sendJson(res, 200, await getSetup());
    if (p === '/api/stylize' && req.method === 'POST') return await handleStylize(req, res);
    if (p === '/api/save' && req.method === 'POST') return await handleSave(req, res);
    if (p === '/api/montage' && req.method === 'GET') {
      return sendJson(res, 200, { montage: await listMontage(), building: Boolean(montageBuild) });
    }
    if (p === '/api/montage/hide' && req.method === 'POST') return await handleHideClip(req, res);
    if (p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p.startsWith('/montage/')) return await serveFile(req, res, DIR.montage, p.slice('/montage/'.length));
      if (p.startsWith('/captures/')) return await serveFile(req, res, DIR.captures, p.slice('/captures/'.length));
      return await serveFile(req, res, DIR.public, p === '/' ? 'index.html' : p.slice(1));
    }
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[server]', err.message || err);
    if (!res.headersSent) sendJson(res, err.status || 500, { ok: false, error: String(err.message || err) });
    else res.end();
  }
}

async function getSetup() {
  maybeBuildMontage(); // new trailers are cut into clips in the background
  const [config, filmsDoc, montage, gallery] = await Promise.all([
    readJson(CONFIG_FILE),
    readJson(FILMS_FILE),
    listMontage(),
    listGallery(),
  ]);
  const films = (filmsDoc.films || [])
    .filter((f) => f && ID_RE.test(String(f.id)) && f.title)
    .map((f) => ({ id: f.id, title: f.title, grade: f.grade || 'natural' }));
  return {
    config,
    films,
    montage,
    montageBuilding: Boolean(montageBuild),
    gallery,
    ai: {
      configured: Boolean(API_KEY) || MOCK,
      mock: MOCK,
      model: MOCK ? 'mock' : workingModel || MODEL_CHAIN[0],
      last: lastAi,
    },
  };
}

async function handleStylize(req, res) {
  const { filmId, image } = JSON.parse(await readBody(req, BODY_LIMIT));
  const [config, filmsDoc] = await Promise.all([readJson(CONFIG_FILE), readJson(FILMS_FILE)]);
  const film = (filmsDoc.films || []).find((f) => f && f.id === filmId);
  if (!film || !ID_RE.test(film.id)) return sendJson(res, 400, { ok: false, error: 'Unknown film' });
  const img = parseDataUrl(image);
  if (!img) return sendJson(res, 400, { ok: false, error: 'No photo in the request' });

  const stamp = timestamp();
  if (config.keepOriginals) {
    await fsp.writeFile(path.join(DIR.captures, `${stamp}__${film.id}__orig.jpg`), img.buffer).catch(() => {});
  }
  if (!API_KEY && !MOCK) return sendJson(res, 503, { ok: false, error: 'No GEMINI_API_KEY in .env' });

  const ai = config.ai || {};
  const t0 = Date.now();
  try {
    const refs = await loadReferences(film.id, ai);
    const out = MOCK ? await mockEdit(img) : await geminiEdit(buildParts(ai, film, img, refs), ai);
    const ms = Date.now() - t0;
    const ext = { 'image/png': 'png', 'image/webp': 'webp' }[out.mime] || 'jpg';
    const name = `${stamp}__${film.id}__ai.${ext}`;
    await fsp.writeFile(path.join(DIR.captures, name), out.buffer);
    lastAi = { ok: true, ms, error: '', model: out.model };
    const refNote = refs.length ? `  (${refs.length} promo picture${refs.length > 1 ? 's' : ''})` : '';
    console.log(`[ai] ok    ${(ms / 1000).toFixed(1)}s  ${out.model}  «${film.title}»${refNote}`);
    const entry = { url: `/captures/${encodeURIComponent(name)}`, time: stamp, filmId: film.id, kind: 'ai' };
    return sendJson(res, 200, { ok: true, url: entry.url, entry, model: out.model, ms });
  } catch (err) {
    const ms = Date.now() - t0;
    lastAi = { ok: false, ms, error: err.message, model: '' };
    console.warn(`[ai] FAIL  ${(ms / 1000).toFixed(1)}s  ${err.message}`);
    return sendJson(res, 502, { ok: false, error: err.message });
  }
}

// Saves the offline (no-AI) version of a photo so it can join the gallery.
async function handleSave(req, res) {
  const { filmId, image } = JSON.parse(await readBody(req, BODY_LIMIT));
  if (!ID_RE.test(String(filmId || ''))) return sendJson(res, 400, { ok: false, error: 'Bad film id' });
  const img = parseDataUrl(image);
  if (!img) return sendJson(res, 400, { ok: false, error: 'No photo in the request' });
  const stamp = timestamp();
  const ext = { 'image/png': 'png', 'image/webp': 'webp' }[img.mime] || 'jpg';
  const name = `${stamp}__${filmId}__local.${ext}`;
  await fsp.writeFile(path.join(DIR.captures, name), img.buffer);
  const entry = { url: `/captures/${encodeURIComponent(name)}`, time: stamp, filmId, kind: 'local' };
  sendJson(res, 200, { ok: true, url: entry.url, entry });
}

// ------------------------------------------------------------------ AI

function fillTemplate(tpl, film) {
  const text = Array.isArray(tpl) ? tpl.join('\n') : String(tpl);
  return text.split('{title}').join(film.title).split('{look}').join(film.look || '');
}

// What goes to the AI: the instructions, the guest photo, then the film's promotional pictures.
function buildParts(ai, film, img, refs) {
  const photo = { inline_data: { mime_type: img.mime, data: img.base64 } };
  if (!refs.length) return [{ text: fillTemplate(ai.promptTemplate || DEFAULT_PROMPT, film) }, photo];
  return [
    { text: fillTemplate(ai.referencePromptTemplate || REFERENCE_PROMPT, film) },
    { text: 'First image: the photo of the guests.' },
    photo,
    { text: `Then: official promotional pictures of "${film.title}" (${refs.length}).` },
    ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.base64 } })),
  ];
}

// The film's promotional pictures: images directly inside refs/<film-id>/, in name order
// (at most ai.references.max, default 2). Subfolders such as originals/ are not sent.
async function loadReferences(filmId, ai) {
  const opt = ai.references === false ? { max: 0 } : ai.references || {};
  const max = Math.max(0, Math.min(4, Math.round(Number(opt.max ?? 2) || 0)));
  if (!max || !ID_RE.test(filmId)) return [];
  let names = [];
  try {
    names = await fsp.readdir(path.join(REFS_DIR, filmId));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const mime = REF_MIME[path.extname(n).toLowerCase()];
    if (!mime || out.length >= max) continue;
    const file = path.join(REFS_DIR, filmId, n);
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (st.size > REF_MAX_BYTES) {
      console.warn(`[ai] refs/${filmId}/${n} is over 4 MB, so it is not sent. Make it smaller (1280 px is plenty).`);
      continue;
    }
    out.push({ mime, base64: (await fsp.readFile(file)).toString('base64') });
  }
  return out;
}

async function mockEdit(img) {
  await sleep(2500 + Math.random() * 2500);
  return { model: 'mock', mime: img.mime, buffer: img.buffer };
}

// Tries the models in order. On a 404 it tries the other API version; on a 400 it
// drops optional settings (thinking level, then image size and 21:9) and tries again.
async function geminiEdit(parts, ai) {
  const deadline = Date.now() + (Number(ai.timeoutSeconds) || 45) * 1000;
  let lastError = new Error('AI did not answer');
  for (const model of unique([workingModel, ...MODEL_CHAIN])) {
    const bases = unique([workingBase, ...API_BASES]);
    let b = 0;
    let level = modelLevel.get(model) || 0;
    for (let attempt = 0; attempt < 6 && b < bases.length; attempt++) {
      if (deadline - Date.now() < 2500) throw lastError;
      const r = await callGemini(bases[b], model, parts, ai, level, deadline);
      if (r.ok) {
        if (workingModel !== model) console.log(`[ai] using model ${model} (${bases[b]})`);
        workingModel = model;
        workingBase = bases[b];
        modelLevel.set(model, level);
        return r;
      }
      lastError = r.error;
      if (/api key/i.test(r.error.message)) throw r.error; // wrong or missing key: other models won't help
      if (r.status === 404) { b += 1; continue; } // not on this API version: try the other one
      if (r.status === 400 && level < 2) { level += 1; continue; } // retry with fewer settings
      if (r.status === 401 || r.status === 403) throw r.error; // key problem: other models won't help
      if (r.status >= 500 && attempt === 0) continue; // one quick retry on a server hiccup
      break; // anything else: next model
    }
  }
  throw lastError;
}

async function callGemini(base, model, parts, ai, level, deadline) {
  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  const imageConfig = {};
  if (ai.aspectRatio) imageConfig.aspectRatio = level >= 2 ? '16:9' : String(ai.aspectRatio);
  if (ai.imageSize && level < 2) imageConfig.imageSize = String(ai.imageSize);
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  if (ai.thinkingLevel && level < 1) generationConfig.thinkingConfig = { thinkingLevel: String(ai.thinkingLevel) };

  const body = { contents: [{ role: 'user', parts }], generationConfig };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
  try {
    const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || text.slice(0, 200) || res.statusText;
      return { ok: false, status: res.status, error: new Error(`${model}: HTTP ${res.status} ${msg}`) };
    }
    const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
    const parts = (cand && cand.content && cand.content.parts) || [];
    const images = parts
      .filter((part) => !part.thought)
      .map((part) => part.inlineData || part.inline_data)
      .filter((d) => d && d.data);
    const out = images[images.length - 1];
    if (!out) {
      const reason =
        (json && json.promptFeedback && json.promptFeedback.blockReason) ||
        (cand && cand.finishReason) ||
        'no image returned';
      const said = parts
        .filter((part) => part.text && !part.thought)
        .map((part) => part.text)
        .join(' ')
        .slice(0, 160);
      return { ok: false, status: 200, error: new Error(`${model}: ${reason}${said ? ` (${said})` : ''}`) };
    }
    return {
      ok: true,
      model,
      mime: out.mimeType || out.mime_type || 'image/png',
      buffer: Buffer.from(out.data, 'base64'),
    };
  } catch (err) {
    const why = err.name === 'AbortError' ? 'timed out' : err.message;
    return { ok: false, status: 0, error: new Error(`${model}: ${why}`) };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- files

async function serveFile(req, res, baseDir, rel) {
  const file = path.resolve(baseDir, rel);
  if (file !== baseDir && !file.startsWith(baseDir + path.sep)) return notFound(res);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };
  const range = req.headers.range;
  if (range) {
    // Videos are streamed in pieces (needed for smooth looping and seeking).
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m && !m[1] && m[2]) {
      start = Math.max(0, stat.size - parseInt(m[2], 10));
      end = stat.size - 1;
    }
    end = Math.min(end, stat.size - 1);
    if (!m || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// The montage: clips cut from the trailers (each knows its film), then any video put
// straight into montage/ (played without a title). Clips hidden with the X key are left out.
async function listMontage() {
  const hidden = await readHidden();
  const items = [];
  let manifest = null;
  try {
    manifest = JSON.parse(await fsp.readFile(CLIPS_MANIFEST, 'utf8'));
  } catch {
    /* no clips yet */
  }
  const present = new Set(await fsp.readdir(DIR.clips).catch(() => []));
  for (const entry of Object.values((manifest && manifest.trailers) || {})) {
    if (!entry || !ID_RE.test(String(entry.film))) continue;
    for (const c of entry.clips || []) {
      if (!c || !CLIP_RE.test(String(c.file)) || hidden.has(c.file) || !present.has(c.file)) continue;
      items.push({ url: `/montage/clips/${encodeURIComponent(c.file)}`, film: entry.film, file: c.file });
    }
  }
  const names = await fsp.readdir(DIR.montage).catch(() => []);
  for (const n of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (!VIDEO_EXT.has(path.extname(n).toLowerCase()) || hidden.has(n)) continue;
    items.push({ url: `/montage/${encodeURIComponent(n)}`, film: '', file: n });
  }
  return items;
}

async function readHidden() {
  try {
    const text = await fsp.readFile(HIDDEN_FILE, 'utf8');
    return new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  } catch {
    return new Set();
  }
}

// X on the booth: this clip never plays again (it is listed in montage/hidden.txt).
async function handleHideClip(req, res) {
  const { file } = JSON.parse(await readBody(req, 10000));
  const name = String(file || '');
  const known = (await listMontage()).some((m) => m.file === name);
  if (!known || name.includes('/') || name.includes('\\')) return sendJson(res, 400, { ok: false, error: 'Unknown clip' });
  let text = '';
  try {
    text = await fsp.readFile(HIDDEN_FILE, 'utf8');
  } catch {
    text = '# Montage clips that are not played (one file name per line). Delete a line to bring a clip back.\n';
  }
  if (text && !text.endsWith('\n')) text += '\n';
  await fsp.writeFile(HIDDEN_FILE, `${text}${name}\n`);
  console.log(`[montage] hidden: ${name}`);
  sendJson(res, 200, { ok: true });
}

// Cuts new trailers into montage clips in a background process, if ffmpeg is installed.
let montageBuild = null;
let lastBuildCheck = 0;
async function maybeBuildMontage() {
  if (montageBuild || Date.now() - lastBuildCheck < 20000) return;
  lastBuildCheck = Date.now();
  let builder;
  let plan;
  try {
    builder = require(BUILD_SCRIPT);
    plan = await builder.planBuild();
  } catch (err) {
    console.warn(`[montage] ${err.message}`);
    return;
  }
  for (const n of plan.unknown) {
    if (!warnedUnknown.has(n)) console.log(`[montage] "${n}": no film from films.json in this name, so it is skipped.`);
    warnedUnknown.add(n);
  }
  if (!plan.todo.length && !plan.removed.length) return;
  if (!builder.findTools()) {
    console.log(`[montage] ${plan.todo.length} trailer(s) are not cut yet, and ffmpeg is not installed on this computer.`);
    return;
  }
  console.log(
    plan.todo.length
      ? `[montage] cutting ${plan.todo.length} trailer(s) into clips in the background...`
      : `[montage] removing the clips of ${plan.removed.length} deleted trailer(s)...`,
  );
  const child = spawn(process.execPath, [BUILD_SCRIPT, '--background'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  montageBuild = child;
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* not critical */
  }
  const relay = (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.log(`[montage] ${line.trim()}`);
  };
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  child.on('error', (err) => console.warn(`[montage] ${err.message}`));
  child.on('close', () => {
    montageBuild = null;
  });
}
const warnedUnknown = new Set();

async function listGallery() {
  let names = [];
  try {
    names = await fsp.readdir(DIR.captures);
  } catch {
    return [];
  }
  return names
    .map((n) => {
      const m = PHOTO_RE.exec(n);
      return m && { url: `/captures/${encodeURIComponent(n)}`, time: m[1], filmId: m[2], kind: m[3].toLowerCase() };
    })
    .filter(Boolean)
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

// ------------------------------------------------------------- helpers

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function readJson(file) {
  const text = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path.basename(file)} has a typo: ${err.message}`);
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseDataUrl(value) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(value || ''));
  if (!m) return null;
  const base64 = m[2].replace(/\s+/g, '');
  return { mime: m[1], base64, buffer: Buffer.from(base64, 'base64') };
}

function timestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url, kiosk) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  const exe = candidates.find((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
  if (!exe) {
    console.log(`  Open ${url} in Chrome.`);
    return;
  }
  // A separate browser profile, so kiosk mode works even if Chrome is already open.
  const args = [
    `--user-data-dir=${path.join(ROOT, '.browser-profile')}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    kiosk ? '--kiosk' : '--new-window',
    url,
  ];
  try {
    spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    console.log(`  Could not open the browser (${err.message}). Open ${url} in Chrome.`);
  }
}

async function announce() {
  const url = `http://localhost:${PORT}`;
  const [montage, gallery, filmsDoc] = await Promise.all([
    listMontage(),
    listGallery(),
    readJson(FILMS_FILE).catch(() => ({ films: [] })),
  ]);
  const aiLine = MOCK
    ? 'TEST MODE (--mock): no AI calls, photos come back unchanged'
    : API_KEY
      ? `Gemini. Models to try: ${MODEL_CHAIN.join(' > ')}`
      : 'no GEMINI_API_KEY in .env, so the booth uses its offline film look';
  const clipFilms = new Set(montage.filter((m) => m.film).map((m) => m.film));
  const others = montage.filter((m) => !m.film).length;
  const missing = (filmsDoc.films || []).filter((f) => f && f.title && !clipFilms.has(f.id)).map((f) => f.title);
  console.log('');
  console.log(`  SYNCHY booth is running: ${url}`);
  console.log(`  AI: ${aiLine}`);
  console.log(
    `  Montage: ${montage.length - others} clips from ${clipFilms.size} films` +
      `${others ? ` + ${others} other video(s)` : ''}   Photos so far: ${gallery.length}`,
  );
  if (missing.length) console.log(`  No trailer yet: ${missing.join(', ')}`);
  console.log('  Stop it with Ctrl+C.');
  console.log('');
  if (OPEN) openBrowser(url, KIOSK);
  maybeBuildMontage(); // trailers added since the last start are cut into clips in the background
}

// ---------------------------------------------------------------- start

// Listen only on this computer (IPv4 and IPv6 loopback), never on the venue network.
for (const host of ['127.0.0.1', '::1']) {
  const srv = http.createServer(handle);
  srv.on('error', (err) => {
    if (host === '::1') return; // no IPv6 on this machine: fine
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is busy, so the booth may already be running.`);
      console.error('  Close the other window, or put PORT=8081 in .env.\n');
    } else {
      console.error(err);
    }
    process.exit(1);
  });
  srv.listen(PORT, host, () => {
    if (host === '127.0.0.1') announce();
  });
}
process.on('SIGINT', () => process.exit(0));
