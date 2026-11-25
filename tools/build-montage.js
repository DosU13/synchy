#!/usr/bin/env node
/*
 * SYNCHY: builds the idle montage from film trailers.
 *
 *   node tools/build-montage.js          cut new or changed trailers into clips
 *   node tools/build-montage.js --all    cut every trailer again
 *
 * Put the trailers (.mp4, .mov, .mkv, .webm) in trailers/. A file name must contain the
 * film's title or id from films.json, in Latin or Cyrillic letters ("MERGEN trailer.mp4",
 * "Мерген.mp4"); films.json can also list other names under "aliases".
 * Needs ffmpeg and ffprobe (https://ffmpeg.org, or: winget install Gyan.FFmpeg).
 *
 * For every trailer it finds the shots and skips black frames, title cards, logos and
 * shots with subtitles or other text. The best shots become short silent clips, cropped
 * to the booth's widescreen frame, in montage/clips/. montage/clips.json lists them; the
 * booth plays them in a mixed order with crossfades and shows each film's title.
 *
 * Debug options: --dry (analyse only), --only <part of a file name>, --sheets <folder>
 * (contact sheets of the frames it judged).
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = {
  trailers: path.join(ROOT, 'trailers'),
  montage: path.join(ROOT, 'montage'),
  clips: path.join(ROOT, 'montage', 'clips'),
};
const MANIFEST = path.join(DIR.montage, 'clips.json');
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']);
const PICKER_VERSION = 3; // raise when the shot picking changes, so every trailer is cut again

const SAMPLE_FPS = 4; // frames per second judged for text, darkness and brightness
const AW = 960; // analysis width
const BLOCKS = 8; // ridge counts are kept per row in this many column blocks
// Text strokes are looked for at 960, 480, 240 and 120 pixels wide, in the brightest of the
// red, green and blue channels (so red or yellow titles stand out as much as white ones).
const SCALES = [1, 2, 4, 8];
const RIDGE_T = [56, 50, 44, 40]; // brightness step that makes a thin line a "stroke"
const BAND_ROWS = [
  [5, 48],
  [3, 36],
  [3, 30],
  [3, 20],
]; // height range of a line of text, in rows at each scale
const SLIVER = 0.6; // a shot shorter than this at the start or end of a clip looks like a glitch
const MICRO = 0.45; // shots shorter than this are flashes and glitch effects: never inside a clip

// ---------------------------------------------------------------- tools

function findTools() {
  const local = (name) => path.join(ROOT, 'tools', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  const pick = (envName, name) => {
    const fromEnv = (process.env[envName] || '').trim();
    for (const cand of [fromEnv, local(name), name]) {
      if (!cand) continue;
      try {
        const r = spawnSync(cand, ['-version'], { windowsHide: true, timeout: 15000 });
        if (r.status === 0) return { exe: cand, version: String(r.stdout).split('\n')[0].trim() };
      } catch {
        /* try the next */
      }
    }
    return null;
  };
  const ffmpeg = pick('FFMPEG_PATH', 'ffmpeg');
  const ffprobe = pick('FFPROBE_PATH', 'ffprobe');
  return ffmpeg && ffprobe ? { ffmpeg: ffmpeg.exe, ffprobe: ffprobe.exe, version: ffmpeg.version } : null;
}

// ---------------------------------------------------------------- films

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ө: 'o', ү: 'u',
  ң: 'n', і: 'i', ә: 'a', ғ: 'g', қ: 'k', ұ: 'u', һ: 'h',
};
const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5' };

// Reduces a name to plain Latin words, so "Көлөкө", "KOLOKO" and "Kölökö" all compare equal.
function looseName(text) {
  let s = String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^\s]/g, (ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch));
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  s = s
    .split(' ')
    .map((w) => ROMAN[w] || w)
    .join(' ');
  s = s.replace(/zh/g, 'j').replace(/c(?!h)/g, 'k').replace(/y/g, 'i').replace(/([a-z])\1+/g, '$1');
  return ` ${s} `;
}

function filmKeys(film) {
  const keys = [film.id.replace(/-/g, ' '), film.title, ...(Array.isArray(film.aliases) ? film.aliases : [])];
  return [...new Set(keys.map(looseName).filter((k) => k.trim().length >= 2))];
}

function matchFilm(fileName, films) {
  const name = looseName(path.parse(fileName).name);
  let best = null;
  let bestLen = 0;
  for (const film of films) {
    for (const key of film.keys) {
      if (name.includes(key) && key.length > bestLen) {
        best = film;
        bestLen = key.length;
      }
    }
  }
  return best;
}

async function loadFilms() {
  const doc = JSON.parse((await fsp.readFile(path.join(ROOT, 'films.json'), 'utf8')).replace(/^﻿/, ''));
  return (doc.films || [])
    .filter((f) => f && /^[a-z0-9-]{1,60}$/.test(String(f.id)) && f.title)
    .map((f) => ({ ...f, keys: filmKeys(f) }));
}

async function loadSettings() {
  let config = {};
  try {
    config = JSON.parse((await fsp.readFile(path.join(ROOT, 'config.json'), 'utf8')).replace(/^﻿/, ''));
  } catch {
    /* defaults */
  }
  const m = config.montage || {};
  const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
  const S = {
    aspect: num(config.frameAspect, 1, 4, 2.39),
    perFilm: Math.round(num(m.clipsPerFilm, 1, 40, 8)),
    minLen: num(m.minClipSeconds, 1.5, 15, 2.8),
    maxLen: num(m.maxClipSeconds, 2, 30, 6),
    width: Math.round(num(m.width, 640, 3840, 1920)),
    crf: Math.round(num(m.quality, 14, 32, 21)),
  };
  S.maxLen = Math.max(S.maxLen, S.minLen);
  S.sig = [S.aspect, S.perFilm, S.minLen, S.maxLen, S.width, S.crf].join(',');
  return S;
}

// --------------------------------------------------------------- planning

async function readManifest() {
  try {
    const m = JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));
    if (m && typeof m.trailers === 'object') return m;
  } catch {
    /* none yet */
  }
  return { version: 1, trailers: {} };
}

async function listTrailers() {
  let names = [];
  try {
    names = await fsp.readdir(DIR.trailers);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (!VIDEO_EXT.has(path.extname(name).toLowerCase())) continue;
    const file = path.join(DIR.trailers, name);
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && st.size > 0) out.push({ name, file, size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch {
      /* skip */
    }
  }
  return out;
}

function trailerKey(t, film, S) {
  return [PICKER_VERSION, t.size, t.mtime, film.id, S.sig].join('|');
}

// What has to be (re)cut: new or changed trailers, and entries whose trailer is gone.
async function planBuild({ all = false } = {}) {
  const [films, S, manifest, trailers] = await Promise.all([loadFilms(), loadSettings(), readManifest(), listTrailers()]);
  const todo = [];
  const unknown = [];
  const keep = new Set();
  for (const t of trailers) {
    const film = matchFilm(t.name, films);
    if (!film) {
      unknown.push(t.name);
      continue;
    }
    t.film = film;
    t.key = trailerKey(t, film, S);
    keep.add(t.name);
    const old = manifest.trailers[t.name];
    const complete =
      old && old.key === t.key && (old.clips || []).every((c) => fs.existsSync(path.join(DIR.clips, c.file)));
    if (all || !complete) todo.push(t);
  }
  const removed = Object.keys(manifest.trailers).filter((n) => !keep.has(n));
  return { films, S, manifest, trailers, todo, unknown, removed };
}

// ------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const opt = {
    all: args.includes('--all'),
    dry: args.includes('--dry'),
    background: args.includes('--background'),
    only: valueOf(args, '--only'),
    sheets: valueOf(args, '--sheets'),
  };
  const tools = findTools();
  if (!tools) {
    console.log('ffmpeg/ffprobe not found. Install ffmpeg (https://ffmpeg.org, or "winget install Gyan.FFmpeg")');
    console.log('or put ffmpeg.exe and ffprobe.exe in the tools folder, then run this again.');
    process.exitCode = 2;
    return;
  }
  if (opt.background) lowerPriority(process.pid);

  const plan = await planBuild({ all: opt.all });
  const { films, S, manifest, removed, unknown } = plan;
  let todo = plan.todo;
  if (opt.only) todo = plan.trailers.filter((t) => t.film && t.name.toLowerCase().includes(opt.only.toLowerCase()));

  console.log(`Trailers: ${plan.trailers.length}, to cut: ${todo.length}   (${tools.version})`);
  for (const n of unknown) {
    console.log(`  ? "${n}": no film from films.json in this name. Rename it, e.g. "Мерген трейлер.mp4".`);
  }

  if (!opt.dry) {
    await fsp.mkdir(DIR.clips, { recursive: true });
    for (const name of removed) {
      await deleteClips(manifest.trailers[name]);
      delete manifest.trailers[name];
      console.log(`  - "${name}" is gone; its clips were removed.`);
    }
  }

  // Trailers of the same film share that film's clip count.
  const perTrailer = new Map();
  for (const t of plan.trailers.filter((x) => x.film)) perTrailer.set(t.film.id, (perTrailer.get(t.film.id) || 0) + 1);

  let i = 0;
  for (const t of todo) {
    i += 1;
    const t0 = Date.now();
    console.log(`[${i}/${todo.length}] ${t.name}  ->  «${t.film.title}»`);
    try {
      const quota = Math.max(2, Math.ceil(S.perFilm / (perTrailer.get(t.film.id) || 1)));
      const result = await processTrailer(t, S, tools, { ...opt, quota });
      if (!opt.dry) {
        await deleteClips(manifest.trailers[t.name], new Set(result.clips.map((c) => c.file)));
        manifest.trailers[t.name] = {
          key: t.key,
          film: t.film.id,
          clips: result.clips,
          note: result.note,
        };
        manifest.updated = new Date().toISOString();
        await writeManifest(manifest);
      }
      console.log(`       ${result.note}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.log(`       FAILED: ${err.message}`);
    }
  }
  if (!opt.dry) await writeManifest(manifest);

  const all = Object.values(manifest.trailers);
  const clipCount = all.reduce((n, e) => n + (e.clips || []).length, 0);
  const filmIds = new Set(all.filter((e) => (e.clips || []).length).map((e) => e.film));
  console.log(`Montage: ${clipCount} clips from ${filmIds.size} films.`);
  const missing = films.filter((f) => !filmIds.has(f.id)).map((f) => f.title);
  if (missing.length) console.log(`No trailer yet: ${missing.join(', ')}`);
}

// --------------------------------------------------------------- trailers

async function processTrailer(t, S, tools, opt) {
  const info = await probe(tools, t.file);
  const [cuts, scan] = await Promise.all([findCuts(tools, t.file, info, opt), scanContent(tools, t.file, info, opt)]);
  const layout = planFrame(scan, S);
  layout.src = toSource(layout.crop, info.width / AW, info.height / scan.AH, info);
  const shots = cutsToShots(cuts, info);
  const ctx = { minLen: S.minLen, cutTimes: shots.slice(1).map((s) => s.start), frame: 1 / cuts.fps, sliver: SLIVER };
  // If a trailer gives few clips, try shorter clips, then (for dark, fast-cut trailers)
  // allow darker frames and flash cuts inside a clip.
  const shortLen = Math.min(S.maxLen, S.minLen + 1.2);
  const attempts = [
    { maxLen: S.maxLen, darkMax: 0.72, micro: MICRO, enough: opt.quota },
    { maxLen: shortLen, darkMax: 0.72, micro: MICRO, enough: Math.min(opt.quota, 4) },
    { maxLen: shortLen, darkMax: 0.86, micro: 0.2, enough: 0 },
  ];
  let best = null;
  for (const at of attempts) {
    const f = judgeSamples(scan, layout, at.darkMax);
    const c = findCandidates(shots, f, cuts, scan, layout, S, info, at);
    const p = pickClips(c, opt.quota, ctx);
    if (!best || p.length > best.picks.length) best = { flags: f, cands: c, picks: p };
    if (best.picks.length >= at.enough) break;
  }
  const { flags, cands, picks } = best;

  const cropDesc = `${layout.src.w}x${layout.src.h}${layout.zoom > 1.01 ? ` (zoom ${layout.zoom.toFixed(2)})` : ''}`;
  const extra = [layout.logoNote, layout.slideNote].filter(Boolean).join(', ');
  const note =
    `${info.duration.toFixed(0)}s, ${shots.length} shots, ${cands.length} possible clips -> ${picks.length} clips, ` +
    `frame ${cropDesc}${extra ? `, ${extra}` : ''}`;

  if (opt.sheets) {
    await writeSheets(tools, opt.sheets, t, scan, layout, flags, picks);
    const why = {};
    for (const f of flags) why[f.why || 'ok'] = (why[f.why || 'ok'] || 0) + 1;
    const lens = shots.map((s) => s.end - s.start);
    await fsp.writeFile(
      path.join(opt.sheets, `${t.film.id}-info.json`),
      JSON.stringify(
        {
          why,
          samples: flags.map((f) => (f.why ? f.why[0] : '.')).join(''),
          shotsOver: [1, 2, 2.8, 4].map((l) => [l, lens.filter((x) => x >= l).length]),
          layout: { act: layout.act, crop: layout.crop, logos: layout.logos, delogo: layout.delogo },
          shots: shots.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(' '),
          cands: cands.map((c) => `${c.start.toFixed(2)}+${c.len.toFixed(2)} s=${c.score.toFixed(2)}`),
        },
        null,
        1,
      ),
    );
  }
  if (opt.dry) return { clips: [], note };

  const tag = crypto.createHash('sha1').update(t.name).digest('hex').slice(0, 4);
  const clips = [];
  await forEachLimit(picks, 3, async (p) => {
    const file = `${t.film.id}__${tag}__${p.start.toFixed(2)}.mp4`;
    await renderClip(tools, t.file, info, layout, p, S, path.join(DIR.clips, file), opt.background);
    clips.push({ file, dur: Number(p.len.toFixed(2)), t: Number(p.start.toFixed(2)) });
  });
  clips.sort((a, b) => a.t - b.t);
  return { clips, note };
}

async function probe(tools, file) {
  const out = await runText(tools.ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio,duration:format=duration',
    '-of', 'json',
    file,
  ]);
  const j = JSON.parse(out);
  const s = j.streams && j.streams[0];
  if (!s || !s.width || !s.height) throw new Error('no video picture in this file');
  const fps = rate(s.avg_frame_rate) || rate(s.r_frame_rate) || 25;
  const duration = Number(s.duration) || Number(j.format && j.format.duration) || 0;
  if (!duration) throw new Error('could not read the length of the video');
  return { width: s.width, height: s.height, fps: Math.min(120, fps), sar: rate(s.sample_aspect_ratio) || 1, duration };
}

// Pass 1: every frame, tiny, to find the cuts between shots.
async function findCuts(tools, file, info, opt) {
  const W = 128;
  const H = 72;
  const N = W * H;
  const score = [];
  const motion = [];
  const hist = new Uint32Array(32);
  const prevHist = new Uint32Array(32);
  const prev = new Uint8Array(N);
  let first = true;
  await runFrames(
    tools.ffmpeg,
    [
      '-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `scale=${W}:${H}:flags=area,format=gray`,
      '-fps_mode', 'cfr', '-r', String(info.fps),
      '-f', 'rawvideo', 'pipe:1',
    ],
    N,
    (buf) => {
      hist.fill(0);
      for (let i = 0; i < N; i++) hist[buf[i] >> 3]++;
      if (first) {
        score.push(0);
        motion.push(0);
        first = false;
      } else {
        let sad = 0;
        for (let i = 0; i < N; i++) {
          const d = buf[i] - prev[i];
          sad += d < 0 ? -d : d;
        }
        let hd = 0;
        for (let b = 0; b < 32; b++) {
          const d = hist[b] - prevHist[b];
          hd += d < 0 ? -d : d;
        }
        const mad = sad / N;
        motion.push(mad);
        score.push(0.6 * Math.min(1, mad / 50) + 0.4 * (hd / (2 * N)));
      }
      prev.set(buf.subarray(0, N));
      prevHist.set(hist);
    },
    opt.background,
  );
  const cutAt = [0];
  for (let i = 1; i < score.length; i++) {
    const s = score[i];
    if (s < 0.15) continue;
    const near = [];
    for (let j = Math.max(1, i - 8); j <= Math.min(score.length - 1, i + 8); j++) if (j !== i) near.push(score[j]);
    if (s >= 2 * median(near) + 0.05) cutAt.push(i);
  }
  return { cutAt, motion, frames: score.length, fps: info.fps };
}

function cutsToShots(cuts, info) {
  const shots = [];
  const marks = [...cuts.cutAt, cuts.frames];
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i] / cuts.fps;
    const b = Math.min(info.duration, marks[i + 1] / cuts.fps);
    if (b > a) shots.push({ index: shots.length, start: a, end: b });
  }
  return shots;
}

// Pass 2: four frames a second at 960 pixels wide, for text, logos, darkness, brightness.
async function scanContent(tools, file, info, opt) {
  const dispW = info.width * (info.sar || 1);
  const AH = Math.max(16, even((AW * info.height) / dispW));
  const dims = SCALES.map((s) => ({ w: Math.floor(AW / s), h: Math.floor(AH / s) }));
  const N = AW * AH;
  const luma = new Uint8Array(N);
  const vals = SCALES.map((s, i) => new Uint8Array(dims[i].w * dims[i].h)); // brightest channel, per scale
  const luma2 = new Uint8Array(dims[1].w * dims[1].h);
  const luma4 = new Uint8Array(dims[2].w * dims[2].h);
  const scan = {
    AH,
    dims,
    n: 0,
    rows: [], // per sample: per row [sum, sum of squares, dark pixels] of the brightness
    ridges: SCALES.map(() => []), // per scale, per sample: stroke pixels per row and column block
    thumbs: [], // per sample: the 240-pixel picture
    big: [], // with --sheets: the 480-pixel picture
    staticAcc: new Uint16Array(dims[1].w * dims[1].h), // how often each pixel was a stroke (logo finder)
    staticN: 0,
  };
  await runFrames(
    tools.ffmpeg,
    [
      '-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `fps=${SAMPLE_FPS},scale=${AW}:${AH}:flags=area,setsar=1,format=rgb24`,
      '-f', 'rawvideo', 'pipe:1',
    ],
    N * 3,
    (rgb) => {
      const v1 = vals[0];
      for (let i = 0, p = 0; i < N; i++, p += 3) {
        const r = rgb[p];
        const g = rgb[p + 1];
        const b = rgb[p + 2];
        luma[i] = (r * 77 + g * 150 + b * 29) >> 8;
        v1[i] = r > g ? (r > b ? r : b) : g > b ? g : b;
      }
      const rows = new Float32Array(AH * 3);
      let tot = 0;
      let totDark = 0;
      for (let y = 0; y < AH; y++) {
        let s = 0;
        let q = 0;
        let d = 0;
        const o = y * AW;
        for (let x = 0; x < AW; x++) {
          const v = luma[o + x];
          s += v;
          q += v * v;
          if (v < 28) d++;
        }
        rows[y * 3] = s;
        rows[y * 3 + 1] = q;
        rows[y * 3 + 2] = d;
        tot += s;
        totDark += d;
      }
      scan.rows.push(rows);
      for (let si = 1; si < SCALES.length; si++) {
        down2(vals[si - 1], dims[si - 1].w, dims[si - 1].h, vals[si], dims[si].w, dims[si].h);
      }
      down2(luma, AW, AH, luma2, dims[1].w, dims[1].h);
      down2(luma2, dims[1].w, dims[1].h, luma4, dims[2].w, dims[2].h);
      const content = tot / N > 22 && totDark / N < 0.7;
      if (content) scan.staticN++;
      for (let si = 0; si < SCALES.length; si++) {
        const acc = si === 1 && content ? scan.staticAcc : null;
        scan.ridges[si].push(ridgeRows(vals[si], dims[si].w, dims[si].h, RIDGE_T[si], acc));
      }
      scan.thumbs.push(Uint8Array.from(luma4));
      if (opt.sheets) scan.big.push(Uint8Array.from(luma2));
      scan.n++;
    },
    opt.background,
  );
  if (!scan.n) throw new Error('no frames could be read');
  return scan;
}

function down2(src, sw, sh, dst, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const o0 = 2 * y * sw;
    const o1 = o0 + sw;
    const od = y * dw;
    for (let x = 0; x < dw; x++) {
      const i = o0 + 2 * x;
      const j = o1 + 2 * x;
      dst[od + x] = (src[i] + src[i + 1] + src[j] + src[j + 1] + 2) >> 2;
    }
  }
}

// Counts thin bright or dark vertical lines (letter strokes) per row and column block.
function ridgeRows(img, w, h, T, acc) {
  const out = new Uint16Array(h * BLOCKS);
  const R = 2;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const ob = y * BLOCKS;
    for (let x = R; x < w - R; x++) {
      const c = img[o + x];
      const a = img[o + x - R];
      const b = img[o + x + R];
      if (c - (a > b ? a : b) >= T || (a < b ? a : b) - c >= T) {
        out[ob + ((x * BLOCKS) / w) | 0]++;
        if (acc) acc[o + x]++;
      }
    }
  }
  return out;
}

// Where the picture is (without black bars), where the logos are, and which part
// of it becomes the widescreen clip.
function planFrame(scan, S) {
  const { w: w4, h: h4 } = scan.dims[2];
  const n = scan.n;
  const rowHits = new Uint32Array(h4);
  const colHits = new Uint32Array(w4);
  const colSum = new Float64Array(w4);
  for (const th of scan.thumbs) {
    colSum.fill(0);
    for (let y = 0; y < h4; y++) {
      let s = 0;
      for (let x = 0; x < w4; x++) {
        const v = th[y * w4 + x];
        s += v;
        colSum[x] += v;
      }
      if (s / w4 > 24) rowHits[y]++;
    }
    for (let x = 0; x < w4; x++) if (colSum[x] / h4 > 24) colHits[x]++;
  }
  const need = Math.max(2, n * 0.06);
  let top = 0;
  while (top < h4 - 1 && rowHits[top] < need) top++;
  let bottom = h4;
  while (bottom > top + 1 && rowHits[bottom - 1] < need) bottom--;
  let left = 0;
  while (left < w4 - 1 && colHits[left] < need) left++;
  let right = w4;
  while (right > left + 1 && colHits[right - 1] < need) right--;
  // back to 960-wide coordinates, a little inside the bars so no dark edge shows
  const act = {
    x0: left * 4 + (left > 0 ? 4 : 0),
    x1: right * 4 - (right < w4 ? 4 : 0),
    y0: top * 4 + (top > 0 ? 4 : 0),
    y1: Math.min(scan.AH, bottom * 4) - (bottom < h4 ? 4 : 0),
  };
  const base = fitAspect(act, S.aspect);
  const baseW = base.x1 - base.x0;
  const center = { x: (base.x0 + base.x1) / 2, y: (base.y0 + base.y1) / 2 };

  // Things to keep out of the frame: logos that stay on screen, and the band where
  // burned-in subtitles keep appearing. The frame may zoom in up to 22% to leave them
  // out; subtitles it cannot leave out are handled shot by shot, logos are blurred.
  const logos = findStaticOverlays(scan, act);
  const zone = textZone(scan, act, logos);
  const bands = [];
  if (zone.bottom) bands.push({ x0: act.x0 - 9, x1: act.x1 + 9, y0: zone.bottom.y0, y1: act.y1 + 9, kind: 'subtitles' });
  if (zone.top) bands.push({ x0: act.x0 - 9, x1: act.x1 + 9, y0: act.y0 - 9, y1: zone.top.y1, kind: 'captions' });
  let crop = base;
  let avoided = [];
  for (const keepOut of [[...logos, ...bands], logos, []]) {
    const win = keepOut.length ? bestWindow(act, keepOut, S.aspect, center) : base;
    if (win && baseW / (win.x1 - win.x0) <= 1.22) {
      crop = win;
      avoided = keepOut;
      break;
    }
  }
  const delogo = logos.filter((b) => overlaps(b, crop));
  const notes = [];
  if (logos.length) notes.push(delogo.length ? 'logo blurred' : 'logo cropped out');
  for (const b of bands) if (avoided.includes(b)) notes.push(`${b.kind} cropped out`);

  const zoom = baseW / (crop.x1 - crop.x0);
  return { act, crop, delogo, logos, zoom, logoNote: notes.join(', '), slideNote: '', scanH: scan.AH };
}

// The biggest widescreen window inside the picture that leaves every box out, as close to
// the middle as possible. Each box can be left out by going above, below, left or right of it.
function bestWindow(act, boxes, A, center) {
  let best = null;
  const combos = 4 ** boxes.length;
  for (let c = 0; c < combos; c++) {
    const r = { ...act };
    let code = c;
    for (const b of boxes) {
      const side = code % 4;
      code = Math.floor(code / 4);
      if (side === 0) r.y0 = Math.max(r.y0, b.y1 + 2);
      else if (side === 1) r.y1 = Math.min(r.y1, b.y0 - 2);
      else if (side === 2) r.x0 = Math.max(r.x0, b.x1 + 2);
      else r.x1 = Math.min(r.x1, b.x0 - 2);
    }
    const rw = r.x1 - r.x0;
    const rh = r.y1 - r.y0;
    if (rw < 40 || rh < 20) continue;
    const w = Math.min(rw, rh * A);
    const h = w / A;
    const x0 = Math.min(r.x1 - w, Math.max(r.x0, center.x - w / 2));
    const y0 = Math.min(r.y1 - h, Math.max(r.y0, center.y - h / 2));
    if (!best || w > best.x1 - best.x0 + 0.5) best = { x0, x1: x0 + w, y0, y1: y0 + h };
  }
  return best;
}

function fitAspect(box, A) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (w / h > A) {
    const nw = h * A;
    const x0 = box.x0 + (w - nw) / 2;
    return { x0, x1: x0 + nw, y0: box.y0, y1: box.y1 };
  }
  const nh = w / A;
  const y0 = box.y0 + (h - nh) / 2;
  return { x0: box.x0, x1: box.x1, y0, y1: y0 + nh };
}

function overlaps(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function findStaticOverlays(scan, act) {
  const { w, h } = scan.dims[1];
  if (scan.staticN < 12) return [];
  const thr = Math.max(6, scan.staticN * 0.45);
  const ax0 = Math.ceil(act.x0 / 2) + 3;
  const ax1 = Math.floor(act.x1 / 2) - 3;
  const ay0 = Math.ceil(act.y0 / 2) + 3;
  const ay1 = Math.floor(act.y1 / 2) - 3;
  const mark = new Uint8Array(w * h);
  for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) if (scan.staticAcc[y * w + x] >= thr) mark[y * w + x] = 1;
  // group marked pixels that are close together (letters of one logo)
  const seen = new Uint8Array(w * h);
  const boxes = [];
  const GAP = 6;
  for (let i = 0; i < mark.length; i++) {
    if (!mark[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let n = 0;
    let x0 = w;
    let x1 = 0;
    let y0 = h;
    let y1 = 0;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w;
      const py = (p - px) / w;
      n++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let dy = -GAP; dy <= GAP; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -GAP; dx <= GAP; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mark[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (n < 6) continue;
    // back to 960-wide coordinates, with a margin
    boxes.push({ x0: x0 * 2 - 8, x1: x1 * 2 + 10, y0: y0 * 2 - 8, y1: y1 * 2 + 10, n });
  }
  // a logo is small; something huge is part of the picture (a static shot), not an overlay
  return boxes.filter((b) => b.x1 - b.x0 < (act.x1 - act.x0) * 0.4 && b.y1 - b.y0 < (act.y1 - act.y0) * 0.3);
}

// Rows near the bottom (or top) of the picture where text keeps coming back all through
// the trailer: burned-in subtitles. Text that shows up only in a few places (a title card,
// a sign in one scene) does not count.
function textZone(scan, act, logos) {
  const BUCKET = 3 * SAMPLE_FPS; // samples per 3 seconds
  const nb = Math.ceil(scan.n / BUCKET);
  const seen = new Uint8Array(scan.AH * nb);
  const buckets = new Set();
  for (let k = 0; k < scan.n; k++) {
    const st = frameStats(scan, k, act.y0, act.y1);
    if (st.mean < 16 || st.dark > 0.72) continue;
    const bk = Math.floor(k / BUCKET);
    buckets.add(bk);
    // subtitles are small text: look at the two finest scales only
    for (const b of textBands(scan, k, act, logos, 2)) for (let y = b.y0; y < b.y1; y++) seen[y * nb + bk] = 1;
  }
  const need = Math.max(4, buckets.size * 0.2);
  const hot = (y) => {
    let c = 0;
    for (let bk = 0; bk < nb; bk++) c += seen[y * nb + bk];
    return c >= need;
  };
  const actH = act.y1 - act.y0;
  const span = (from, to) => {
    let y0 = -1;
    let y1 = -1;
    for (let y = Math.max(0, Math.round(from)); y < Math.min(scan.AH, Math.round(to)); y++) {
      if (hot(y)) {
        if (y0 < 0) y0 = y;
        y1 = y + 1;
      }
    }
    return y0 < 0 ? null : { y0, y1 };
  };
  return { bottom: span(act.y0 + actH * 0.6, act.y1), top: span(act.y0, act.y0 + actH * 0.3) };
}

function frameStats(scan, k, from, to) {
  const rows = scan.rows[k];
  const ry0 = Math.max(0, Math.round(from));
  const ry1 = Math.min(scan.AH, Math.round(to));
  let s = 0;
  let q = 0;
  let d = 0;
  for (let y = ry0; y < ry1; y++) {
    s += rows[y * 3];
    q += rows[y * 3 + 1];
    d += rows[y * 3 + 2];
  }
  const N = Math.max(1, (ry1 - ry0) * AW);
  const mean = s / N;
  return { mean, sd: Math.sqrt(Math.max(0, q / N - mean * mean)), dark: d / N };
}

// Lines of text in sample k inside the box, as [{y0, y1}] in 960-wide rows. Rows covered
// by the skip boxes (logos) are ignored. maxScale limits the search to smaller text.
function textBands(scan, k, box, delogo, maxScale = SCALES.length) {
  const B = BLOCKS;
  const bands = [];
  const b0 = Math.max(0, Math.floor((box.x0 / AW) * B));
  const b1 = Math.min(B, Math.ceil((box.x1 / AW) * B));
  for (let si = 0; si < maxScale; si++) {
    const s = SCALES[si];
    const { w, h } = scan.dims[si];
    const counts = scan.ridges[si][k];
    const y0 = Math.max(0, Math.ceil(box.y0 / s));
    const y1 = Math.min(h, Math.floor(box.y1 / s));
    if (y1 - y0 < 6) continue;
    const rc = new Float64Array(y1 - y0);
    for (let y = y0; y < y1; y++) {
      let skip = false;
      for (const d of delogo) if (y * s + s > d.y0 && y * s < d.y1) skip = true;
      if (skip) continue;
      let c = 0;
      for (let b = b0; b < b1; b++) c += counts[y * B + b];
      rc[y - y0] = c;
    }
    const width = (w * (b1 - b0)) / B;
    const hotMin = Math.max(si === 3 ? 4 : 8, 0.02 * width);
    const sorted = Array.from(rc).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const [minRows, maxRows] = BAND_ROWS[si];
    let y = 0;
    while (y < rc.length) {
      if (rc[y] < hotMin) {
        y++;
        continue;
      }
      let e = y;
      let sum = 0;
      while (e < rc.length && rc[e] >= hotMin) sum += rc[e++];
      const len = e - y;
      const mean = sum / len;
      if (len >= minRows && len <= maxRows && mean >= 1.6 * hotMin) {
        const m = Math.max(3, Math.round(len / 2));
        const around = (from, to) => {
          let a = 0;
          let c = 0;
          for (let i = from; i < to; i++) {
            if (i < 0 || i >= rc.length) continue;
            a += rc[i];
            c++;
          }
          return c ? a / c : 0;
        };
        const above = around(y - 1 - m, y - 1);
        const below = around(e + 1, e + 1 + m);
        const isolated = above <= 0.4 * mean && below <= 0.4 * mean;
        const standsOut = mean >= 3.5 * Math.max(med, 1) && mean >= 2.5 * hotMin;
        // big letters sit in the middle part of the picture; a band of strokes across the
        // whole width at the coarse scales is a fence, a lattice or a crowd
        let wall = false;
        if (si >= 2 && b1 - b0 >= 7) {
          const per = [];
          for (let b = b0; b < b1; b++) {
            let c = 0;
            for (let r = y; r < e; r++) c += counts[(y0 + r) * B + b];
            per.push(c);
          }
          const avgB = per.reduce((p, q) => p + q, 0) / per.length;
          wall = per.filter((c) => c >= 0.25 * avgB).length >= per.length;
        }
        if ((isolated || standsOut) && !wall) bands.push({ y0: (y0 + y) * s, y1: (y0 + e) * s, scale: s, mean });
      }
      y = e;
    }
  }
  return bands;
}

// Decides for every sample whether it may be part of a clip.
function judgeSamples(scan, layout, darkMax = 0.72) {
  const { crop, delogo } = layout;
  const flags = [];
  const y0 = Math.max(0, Math.round(crop.y0));
  const y1 = Math.min(scan.AH, Math.round(crop.y1));
  const barMax = Math.max(3, (y1 - y0) * 0.025);
  for (let k = 0; k < scan.n; k++) {
    const { mean, sd, dark } = frameStats(scan, k, crop.y0, crop.y1);
    const bands = textBands(scan, k, crop, delogo);
    // a shot framed narrower than the rest of the trailer leaves black bars inside the frame
    const rows = scan.rows[k];
    const isBar = (y) => {
      const m = rows[y * 3] / AW;
      return m < 10 && rows[y * 3 + 1] / AW - m * m < 16;
    };
    let top = 0;
    while (y0 + top < y1 && isBar(y0 + top)) top++;
    let bottom = 0;
    while (y1 - 1 - bottom > y0 && isBar(y1 - 1 - bottom)) bottom++;
    const bars = top >= barMax || bottom >= barMax;
    const why =
      mean < 16 ? 'black' : dark > darkMax ? 'dark' : sd < 9 ? 'flat' : bars ? 'bars' : bands.length ? 'text' : '';
    flags.push({ ok: !why, why, mean, sd, dark, bands });
  }
  return flags;
}

// Possible clips: stretches of the trailer (one long shot, or a few shots in a row, cut
// as in the trailer) with no text, darkness or flash frames, that do not begin or end
// with a sliver of a shot.
function findCandidates(shots, flags, cuts, scan, layout, S, info, { maxLen, micro: MICRO_LEN }) {
  const frame = 1 / cuts.fps;
  const head = Math.max(1, info.duration * 0.02);
  const tail = info.duration - Math.max(1.5, info.duration * 0.06); // trailers end with the title and credits
  const cutTimes = shots.slice(1).map((s) => s.start);
  const micro = shots.filter((s) => s.end - s.start < MICRO_LEN);
  const bad = [];
  for (let k = 0; k < flags.length; k++) if (!flags[k].ok) bad.push(k / SAMPLE_FPS);

  const starts = new Set();
  for (const sh of shots) {
    const len = sh.end - sh.start;
    if (len < MICRO_LEN) continue;
    starts.add(sh.start + frame);
    if (len > maxLen + 1) starts.add(sh.start + (len - maxLen) / 2); // the middle of a long shot
  }
  // a title fades in and out: keep a third of a second away from frames with text
  for (let k = 1; k < flags.length; k++) if (flags[k].ok && !flags[k - 1].ok) starts.add(k / SAMPLE_FPS + 0.3);

  const out = [];
  for (const a of [...starts].sort((x, y) => x - y)) {
    if (a < head) continue;
    const nextCut = cutTimes.find((c) => c > a + 1e-6);
    if (nextCut !== undefined && nextCut - a < SLIVER) continue;
    let b = Math.min(a + maxLen, tail);
    const nextBad = bad.find((t) => t > a - 0.3);
    if (nextBad !== undefined) b = Math.min(b, nextBad - 0.3);
    const nextMicro = micro.find((m) => m.end > a);
    if (nextMicro) b = Math.min(b, nextMicro.start - frame);
    let lastCut;
    for (const c of cutTimes) if (c > a + 1e-6 && c < b) lastCut = c;
    if (lastCut !== undefined && b - lastCut < SLIVER) b = lastCut - frame;
    if (b - a >= S.minLen) out.push(candidate(a, b, shots, flags, cuts, scan, layout, S));
  }
  return out;
}

function candidate(start, end, shots, flags, cuts, scan, layout, S) {
  const len = end - start;
  const ks = [];
  for (let k = Math.ceil(start * SAMPLE_FPS); k <= Math.floor(end * SAMPLE_FPS); k++) if (flags[k]) ks.push(k);
  const mean = avg(ks.map((k) => flags[k].mean)) / 255;
  const sd = avg(ks.map((k) => flags[k].sd)) / 255;
  const inside = shots.filter((s) => s.end > start + 1e-6 && s.start < end - 1e-6);
  const cutFrames = new Set(inside.map((s) => Math.round(s.start * cuts.fps)));
  const f0 = Math.floor(start * cuts.fps) + 1;
  const f1 = Math.min(cuts.motion.length, Math.ceil(end * cuts.fps));
  const mots = [];
  for (let f = f0; f < f1; f++) if (!cutFrames.has(f)) mots.push(cuts.motion[f]);
  const mot = avg(mots);
  const sLen = Math.min(1, (len - S.minLen) / Math.max(0.1, S.maxLen - S.minLen));
  const sBright = mean < 0.1 ? 0 : mean < 0.25 ? (mean - 0.1) / 0.15 : mean > 0.75 ? 0.5 : 1;
  const sCon = Math.min(1, sd / 0.24);
  const sMot = 1 - Math.min(1, Math.max(0, mot - 8) / 20);
  const sCalm = [1, 1, 0.8, 0.6][inside.length] ?? 0.4; // one long shot is calmest
  const score = 0.3 * sLen + 0.25 * sBright + 0.1 * sCon + 0.15 * sMot + 0.2 * sCalm;
  const mid = ks.length ? ks[ks.length >> 1] : Math.round((start + len / 2) * SAMPLE_FPS);
  return {
    start,
    len,
    score,
    mean,
    shots: inside.length,
    sig: signature(scan, Math.min(scan.n - 1, mid), layout.crop),
  };
}

// A 12x5 brightness grid of the frame, to spot the same shot used twice.
function signature(scan, k, crop) {
  const { w } = scan.dims[2];
  const th = scan.thumbs[k];
  const GX = 12;
  const GY = 5;
  const sig = new Float32Array(GX * GY);
  const x0 = crop.x0 / 4;
  const y0 = crop.y0 / 4;
  const cw = (crop.x1 - crop.x0) / 4 / GX;
  const ch = (crop.y1 - crop.y0) / 4 / GY;
  for (let gy = 0; gy < GY; gy++) {
    for (let gx = 0; gx < GX; gx++) {
      let s = 0;
      let c = 0;
      for (let y = Math.floor(y0 + gy * ch); y < Math.floor(y0 + (gy + 1) * ch); y++) {
        for (let x = Math.floor(x0 + gx * cw); x < Math.floor(x0 + (gx + 1) * cw); x++) {
          s += th[y * w + x];
          c++;
        }
      }
      sig[gy * GX + gx] = c ? s / c : 0;
    }
  }
  return sig;
}

// The best clips, never showing the same footage twice: a clip that overlaps one already
// picked is shortened to its free part (if that is still long enough).
function pickClips(cands, quota, ctx) {
  const GAP = 0.5;
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const picked = [];
  for (const cand of sorted) {
    if (picked.length >= quota) break;
    let a = cand.start;
    let b = cand.start + cand.len;
    for (const p of picked) {
      const pa = p.start - GAP;
      const pb = p.start + p.len + GAP;
      if (b <= pa || a >= pb) continue;
      if (pa - a >= b - pb) b = pa;
      else a = pb;
    }
    if (b - a < ctx.minLen) continue;
    if (a !== cand.start || b !== cand.start + cand.len) {
      [a, b] = noSlivers(a, b, ctx);
      if (b - a < ctx.minLen) continue;
    }
    const c = { ...cand, start: a, len: b - a };
    if (picked.some((p) => sigDiff(p.sig, c.sig) < 11)) continue; // the same shot used twice in the trailer
    picked.push(c);
  }
  return picked.sort((a, b) => a.start - b.start);
}

// Moves the ends of a clip so it does not begin or end with a sliver of a shot.
function noSlivers(a, b, ctx) {
  const first = ctx.cutTimes.find((t) => t > a + 1e-6);
  if (first !== undefined && first < b && first - a < ctx.sliver) a = first + ctx.frame;
  let last;
  for (const t of ctx.cutTimes) if (t > a + 1e-6 && t < b) last = t;
  if (last !== undefined && b - last < ctx.sliver) b = last - ctx.frame;
  return [a, b];
}

function sigDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

// ------------------------------------------------------------------ render

async function renderClip(tools, file, info, layout, p, S, out, background) {
  const sx = info.width / AW;
  const sy = info.height / (layout.scanH || info.height);
  const crop = toSource(layout.crop, sx, sy, info);
  const filters = [];
  for (const d of layout.delogo) {
    const b = toSource(d, sx, sy, info);
    const x = Math.max(1, b.x);
    const y = Math.max(1, b.y);
    const w = Math.min(info.width - x - 1, b.w);
    const h = Math.min(info.height - y - 1, b.h);
    if (w > 4 && h > 4) filters.push(`delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
  }
  filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  const outW = even(Math.min(S.width, crop.w * (info.sar || 1)));
  const outH = even(outW / S.aspect);
  filters.push(`scale=${outW}:${outH}:flags=lanczos`, 'setsar=1', 'format=yuv420p');
  const tmp = `${out}.part.mp4`;
  await runText(
    tools.ffmpeg,
    [
      '-v', 'error', '-nostdin', '-y',
      '-ss', p.start.toFixed(3), '-i', file, '-t', p.len.toFixed(3),
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'medium', '-tune', 'film', '-crf', String(S.crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      ...(background ? ['-threads', '4'] : []),
      tmp,
    ],
    background,
  );
  await fsp.rename(tmp, out);
}

function toSource(box, sx, sy, info) {
  let x = Math.max(0, Math.round(box.x0 * sx));
  let y = Math.max(0, Math.round(box.y0 * sy));
  let w = even(Math.min(info.width - x, Math.round((box.x1 - box.x0) * sx)), true);
  let h = even(Math.min(info.height - y, Math.round((box.y1 - box.y0) * sy)), true);
  x = Math.min(x, info.width - w);
  y = Math.min(y, info.height - h);
  return { x, y, w, h };
}

// ------------------------------------------------------------------ files

async function deleteClips(entry, keep = new Set()) {
  for (const c of (entry && entry.clips) || []) {
    if (keep.has(c.file)) continue;
    await fsp.unlink(path.join(DIR.clips, c.file)).catch(() => {});
  }
}

async function writeManifest(m) {
  await fsp.mkdir(DIR.montage, { recursive: true });
  const tmp = `${MANIFEST}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(m, null, 1)}\n`);
  await fsp.rename(tmp, MANIFEST);
}

// Debug: contact sheets of what was judged (gray, 480 px tiles).
async function writeSheets(tools, dir, t, scan, layout, flags, picks) {
  await fsp.mkdir(dir, { recursive: true });
  const base = path.join(dir, t.film.id);
  const crop = layout.crop;
  const { w: w2 } = scan.dims[1];
  const tx0 = Math.round(crop.x0 / 2);
  const ty0 = Math.round(crop.y0 / 2);
  const tw = Math.round((crop.x1 - crop.x0) / 2);
  const th = Math.round((crop.y1 - crop.y0) / 2);
  const tile = (k) => {
    const out = new Uint8Array(tw * th);
    const src = scan.big[k];
    for (let y = 0; y < th; y++) out.set(src.subarray((ty0 + y) * w2 + tx0, (ty0 + y) * w2 + tx0 + tw), y * tw);
    return out;
  };
  const sheet = async (name, ks) => {
    if (!ks.length) return;
    const cols = 4;
    const rowsN = Math.ceil(ks.length / cols);
    const W = cols * (tw + 4);
    const H = rowsN * (th + 4);
    const img = new Uint8Array(W * H).fill(90);
    ks.forEach((k, i) => {
      const t0 = tile(k);
      const ox = (i % cols) * (tw + 4);
      const oy = Math.floor(i / cols) * (th + 4);
      for (let y = 0; y < th; y++) img.set(t0.subarray(y * tw, (y + 1) * tw), (oy + y) * W + ox);
    });
    const pgm = `${base}-${name}.pgm`;
    await fsp.writeFile(pgm, Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), Buffer.from(img)]));
    await runText(tools.ffmpeg, ['-v', 'error', '-y', '-i', pgm, '-q:v', '4', `${base}-${name}.jpg`]);
    await fsp.unlink(pgm).catch(() => {});
    await fsp.writeFile(`${base}-${name}.txt`, ks.map((k, i) => `${i}: t=${(k / SAMPLE_FPS).toFixed(2)} ${flags[k].why}`).join('\n'));
  };
  const textKs = flags.map((f, k) => (f.why === 'text' ? k : -1)).filter((k) => k >= 0);
  const okKs = flags.map((f, k) => (f.ok ? k : -1)).filter((k) => k >= 0);
  const every = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.ceil(arr.length / n)) === 0);
  await sheet('text', every(textKs, 48));
  await sheet('ok', every(okKs, 48));
  const pickKs = [];
  for (const p of picks) {
    for (const f of [0.05, 0.5, 0.95]) pickKs.push(Math.min(scan.n - 1, Math.round((p.start + p.len * f) * SAMPLE_FPS)));
    pickKs.push(pickKs[pickKs.length - 1]);
  }
  await sheet('picked', pickKs);
}

// ---------------------------------------------------------------- helpers

function runFrames(exe, args, frameSize, onFrame, background) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (background) lowerPriority(p.pid);
    const buf = Buffer.alloc(frameSize);
    let fill = 0;
    let n = 0;
    let err = '';
    p.stdout.on('data', (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const take = Math.min(frameSize - fill, chunk.length - off);
        chunk.copy(buf, fill, off, off + take);
        fill += take;
        off += take;
        if (fill === frameSize) {
          onFrame(buf, n++);
          fill = 0;
        }
      }
    });
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(n);
      else reject(new Error(`ffmpeg stopped (${code}): ${err.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

function runText(exe, args, background) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    if (background) lowerPriority(p.pid);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(exe)} stopped (${code}): ${err.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

async function forEachLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function lowerPriority(pid) {
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* not critical */
  }
}

function rate(text) {
  const m = /^(\d+(?:\.\d+)?)[/:](\d+(?:\.\d+)?)$/.exec(String(text || ''));
  if (!m) return Number(text) || 0;
  const d = Number(m[2]);
  return d ? Number(m[1]) / d : 0;
}

function even(v, down = false) {
  const n = down ? Math.floor(v / 2) * 2 : Math.round(v / 2) * 2;
  return Math.max(2, n);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function valueOf(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
}

module.exports = { findTools, planBuild, looseName, MANIFEST, DIR, _test: { probe, scanContent, textBands, SCALES } };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  });
}
