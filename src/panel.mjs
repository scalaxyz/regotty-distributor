// Local control panel for the distributor — no external deps. Serves a single
// glassmorphism dashboard that lets you fill the queue / artists / covers /
// config, log in to RouteNote, run one release or the daemon, and watch live
// logs.  node src/panel.mjs  ->  http://localhost:4599

import { createServer } from 'node:http';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTrackMeta } from './credits.mjs';
import { readCsv, songKey } from './csv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.resolve(ROOT, p);
const PORT = Number(process.env.PORT) || 4599;

// ---- live log ring buffer ----------------------------------------------------
const logs = [];
let seq = 0;
const pushLog = (line) => { for (const l of String(line).split(/\r?\n/)) if (l.trim()) { logs.push({ id: ++seq, line: l, t: Date.now() }); if (logs.length > 3000) logs.shift(); } };

// ---- child process (daemon / one-shot / login) -------------------------------
let child = null;
let childKind = null;
function runChild(kind, args) {
  if (child) return { error: 'Zaten çalışan bir işlem var. Önce durdur.' };
  childKind = kind;
  pushLog('▶ ' + kind + ' başladı — node ' + args.join(' '));
  const c = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: { ...process.env } });
  child = c;
  c.stdout.on('data', (d) => pushLog(d.toString()));
  c.stderr.on('data', (d) => pushLog(d.toString()));
  c.on('error', (e) => pushLog('HATA: ' + e.message));
  c.on('close', (code) => { pushLog('■ ' + childKind + ' bitti (kod ' + code + ')'); child = null; childKind = null; });
  return { ok: true };
}
function stopChild() { if (!child) return { error: 'Çalışan işlem yok' }; child.kill(); pushLog('⏹ durduruldu'); return { ok: true }; }

// Whisper availability (word-level lyrics check). Detected once via detectWhisper()
// — called after startup so `loadConfig` (a const below) is already initialized.
let whisperReady = null;
async function detectWhisper() {
  let cmd = 'whisper';
  try { const cfg = await loadConfig(); if (cfg.vocalCheck?.whisperCmd && cfg.vocalCheck.whisperCmd !== 'auto') cmd = cfg.vocalCheck.whisperCmd; } catch {}
  if (/[\\/]/.test(cmd)) { whisperReady = existsSync(cmd); return; } // full path -> just check it exists
  const look = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true });
  look.on('error', () => { whisperReady = false; });
  look.on('close', (code) => { whisperReady = code === 0; });
}

// ---- helpers -----------------------------------------------------------------
const loadConfig = async () => JSON.parse(await readFile(rel('config/config.json'), 'utf8'));
async function csvCount(file) { try { const t = await readFile(file, 'utf8'); return t.split(/\r?\n/).filter((l) => l.trim()).length - 1; } catch { return 0; } }
const FILES = { input: 'input/input.csv', artists: 'artists/artists.csv', config: 'config/config.json' };

async function status() {
  let cfg = null; try { cfg = await loadConfig(); } catch {}
  let rows = []; try { rows = await readCsv(rel('input/input.csv')); } catch {}
  const artists = Math.max(0, await csvCount(rel('artists/artists.csv')));
  const covers = (await readdir(rel('covers')).catch(() => [])).filter((f) => /\.(jpe?g|png)$/i.test(f));
  // done tracked by song identity (artist+song), not position — see csv.mjs
  let doneList = []; try { const st = JSON.parse(await readFile(rel('state/rotation.json'), 'utf8')); if (Array.isArray(st.done)) doneList = st.done; } catch {}
  const doneSet = new Set(doneList);
  const songsTotal = rows.length;
  const songsDone = rows.filter((r) => doneSet.has(songKey(r))).length;
  const isPlaceholder = (v) => !v || /[<>]|BURAYA|^\.{3}$/.test(String(v));
  const configReady = !!cfg && [cfg.regotty?.token, cfg.routenote?.login?.username, cfg.routenote?.login?.password, cfg.routenote?.captcha?.apiKey, cfg.routenote?.uid].every((v) => !isPlaceholder(v));
  return {
    configExists: !!cfg, configReady,
    songsTotal, songsPending: Math.max(0, songsTotal - songsDone), songsDone, doneKeys: [...doneSet],
    artists, covers: covers.length, coverNames: covers,
    loggedIn: existsSync(rel('state/routenote-session.json')),
    running: childKind, autoSubmit: cfg?.routenote?.autoSubmit === true,
    schedule: cfg?.schedule || null,
    vocalMode: cfg?.vocalCheck?.enabled === false ? 'off' : (whisperReady ? 'whisper' : 'muffle'),
  };
}

// ---- tiny HTTP plumbing ------------------------------------------------------
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    if (p === '/api/status') return json(res, await status());

    if (p === '/covers-preview') {
      const fp = rel(path.join('covers', path.basename(url.searchParams.get('n') || '')));
      if (!existsSync(fp)) { res.writeHead(404); return res.end(); }
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg' });
      return res.end(await readFile(fp));
    }

    if (p === '/api/file') {
      const name = url.searchParams.get('name');
      const file = FILES[name]; if (!file) return json(res, { error: 'bad file' }, 400);
      if (req.method === 'GET') { const text = existsSync(rel(file)) ? await readFile(rel(file), 'utf8') : ''; return json(res, { text }); }
      if (req.method === 'PUT') {
        const { text } = JSON.parse(await body(req));
        if (name === 'config') { try { JSON.parse(text); } catch (e) { return json(res, { error: 'Geçersiz JSON — kaydedilmedi: ' + e.message }, 400); } }
        await mkdir(path.dirname(rel(file)), { recursive: true }); await writeFile(rel(file), text ?? ''); pushLog('✎ ' + file + ' kaydedildi'); return json(res, { ok: true });
      }
    }

    if (p === '/api/cover' && req.method === 'POST') {
      const { name, data } = JSON.parse(await body(req));
      if (!name || !data) return json(res, { error: 'name/data gerekli' }, 400);
      const clean = path.basename(name).replace(/[^A-Za-z0-9._ ()-]/g, '_');
      await mkdir(rel('covers'), { recursive: true });
      await writeFile(rel(path.join('covers', clean)), Buffer.from(String(data).split(',').pop(), 'base64'));
      pushLog('🖼 kapak eklendi: ' + clean); return json(res, { ok: true });
    }
    if (p === '/api/cover' && req.method === 'DELETE') {
      const name = path.basename(url.searchParams.get('name') || '');
      await unlink(rel(path.join('covers', name))).catch(() => {}); pushLog('🗑 kapak silindi: ' + name); return json(res, { ok: true });
    }

    if (p === '/api/autosubmit' && req.method === 'POST') {
      const { value } = JSON.parse(await body(req));
      const cfg = await loadConfig(); cfg.routenote.autoSubmit = !!value;
      await writeFile(rel('config/config.json'), JSON.stringify(cfg, null, 2));
      pushLog('⚙ autoSubmit = ' + !!value); return json(res, { ok: true, value: !!value });
    }

    if (p === '/api/schedule' && req.method === 'POST') {
      const { releasesPerDay } = JSON.parse(await body(req));
      const n = Math.max(1, Math.min(999, parseInt(releasesPerDay, 10) || 1));
      const cfg = await loadConfig(); cfg.schedule = cfg.schedule || {}; cfg.schedule.releasesPerDay = n;
      await writeFile(rel('config/config.json'), JSON.stringify(cfg, null, 2));
      pushLog('⚙ günlük hedef = ' + n); return json(res, { ok: true, releasesPerDay: n });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const { kind } = JSON.parse(await body(req));
      const map = {
        login: ['src/routenote.mjs', 'login'],
        once: ['src/index.mjs'],
        'once-publish': ['src/index.mjs', '--publish'],
        daemon: ['src/index.mjs', '--daemon'],
        'daemon-publish': ['src/index.mjs', '--daemon', '--publish'],
      };
      if (!map[kind]) return json(res, { error: 'bad kind' }, 400);
      return json(res, runChild(kind, map[kind]));
    }
    if (p === '/api/stop' && req.method === 'POST') return json(res, stopChild());

    if (p === '/api/lookup') {
      const link = url.searchParams.get('url') || '';
      if (!link) return json(res, { error: 'Spotify linki gerekli' }, 400);
      try {
        const cfg = await loadConfig();
        const m = await getTrackMeta(link, cfg.spotifyCredits);
        return json(res, {
          ok: true, artist: m.artist, song: m.name, url: 'https://open.spotify.com/track/' + m.trackId,
          explicit: m.explicit, composer: [m.first, m.last].filter(Boolean).join(' '),
          writers: m.writers, isrc: m.isrc, album: m.album, hasLyrics: m.hasLyrics, coverUrl: m.coverUrl,
        });
      } catch (e) { return json(res, { error: e.message }, 502); }
    }

    if (p === '/api/logs') { const since = Number(url.searchParams.get('since') || 0); return json(res, { logs: logs.filter((l) => l.id > since), last: seq }); }

    res.writeHead(404); res.end('not found');
  } catch (e) { json(res, { error: e.message }, 500); }
});

server.listen(PORT, () => { pushLog('panel hazır: http://localhost:' + PORT); console.log('\n  regotty-distributor paneli → http://localhost:' + PORT + '\n'); });
detectWhisper(); // loadConfig is defined by now

// ---- the page (glassmorphism dashboard) --------------------------------------
const PAGE = '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>regotty distributor</title>' + STYLE() + '</head><body>' + SVGDEFS() + BODY() + SCRIPT() + '</body></html>';

function STYLE() { return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#080b12; --bg2:#0b1120; --card:rgba(255,255,255,.045); --card2:rgba(255,255,255,.07);
  --line:rgba(255,255,255,.09); --line2:rgba(255,255,255,.16);
  --fg:#f4f7fb; --mut:#9aa7bd; --dim:#6b788f;
  --i:#6366f1; --v:#a855f7; --c:#22d3ee; --grad:linear-gradient(120deg,#6366f1,#a855f7 55%,#22d3ee);
  --ok:#34d399; --warn:#fbbf24; --bad:#fb7185;
  --r:16px; --r2:12px;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:15px/1.55 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
h1,h2,h3,.brand{font-family:'Space Grotesk',Inter,sans-serif}
.num{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums}
a{color:var(--c)}
::selection{background:rgba(168,85,247,.35)}
/* aurora background */
.aurora{position:fixed;inset:-20% -10% auto;height:120vh;z-index:-2;filter:blur(70px);opacity:.55;pointer-events:none}
.aurora i{position:absolute;border-radius:50%;mix-blend-mode:screen;animation:drift 26s ease-in-out infinite}
.aurora i:nth-child(1){width:46vw;height:46vw;left:-6vw;top:2vh;background:radial-gradient(circle,#6366f1,transparent 62%)}
.aurora i:nth-child(2){width:42vw;height:42vw;right:-4vw;top:-6vh;background:radial-gradient(circle,#a855f7,transparent 62%);animation-delay:-8s}
.aurora i:nth-child(3){width:38vw;height:38vw;left:32vw;top:34vh;background:radial-gradient(circle,#22d3ee,transparent 64%);animation-delay:-15s}
.grid-fade{position:fixed;inset:0;z-index:-1;background:radial-gradient(120% 80% at 50% -10%,transparent,var(--bg) 72%),linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px);background-size:auto,44px 44px,44px 44px;pointer-events:none}
@keyframes drift{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(4vw,3vh) scale(1.08)}66%{transform:translate(-3vw,2vh) scale(.96)}}
/* glass */
.glass{background:var(--card);backdrop-filter:blur(16px) saturate(140%);-webkit-backdrop-filter:blur(16px) saturate(140%);border:1px solid var(--line);border-radius:var(--r);box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 20px 50px -30px rgba(0,0,0,.9)}
/* topbar */
.topbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:16px;padding:14px 22px;margin:14px 22px 0;border-radius:var(--r)}
.brand{font-weight:700;font-size:17px;letter-spacing:.2px;display:flex;align-items:center;gap:10px}
.brand .logo{width:30px;height:30px;border-radius:9px;background:var(--grad);display:grid;place-items:center;box-shadow:0 6px 18px -6px rgba(99,102,241,.8)}
.brand .logo svg{width:16px;height:16px;color:#0a0e17}
.brand b{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.pill{display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;font-size:12.5px;color:var(--mut);border:1px solid var(--line);background:rgba(255,255,255,.03)}
.pill .d{width:7px;height:7px;border-radius:50%;background:var(--dim);box-shadow:0 0 0 0 currentColor}
.pill.on{color:var(--ok);border-color:rgba(52,211,153,.4)}.pill.on .d{background:var(--ok);animation:pulse 2s infinite}
.pill.off{color:var(--bad);border-color:rgba(251,113,133,.35)}.pill.off .d{background:var(--bad)}
.pill.run{color:var(--warn);border-color:rgba(251,191,36,.4)}.pill.run .d{background:var(--warn);animation:pulse 1.1s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 currentColor}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
/* layout */
.wrap{max-width:1180px;margin:0 auto;padding:22px}
.hero{margin:6px 0 22px}
.hero h1{font-size:30px;line-height:1.15;margin:0 0 6px;letter-spacing:-.5px}
.hero h1 span{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{color:var(--mut);margin:0;max-width:60ch}
/* cards */
.cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));margin-bottom:18px}
.stat{padding:18px 20px;position:relative;overflow:hidden}
.stat::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:var(--grad);opacity:.7}
.stat .ico{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:rgba(255,255,255,.05);border:1px solid var(--line);margin-bottom:14px;color:var(--c)}
.stat .ico svg{width:19px;height:19px}
.stat .n{font-size:32px;font-weight:600;letter-spacing:-.5px}
.stat .n small{font-size:16px;color:var(--dim);font-weight:500}
.stat .l{color:var(--mut);font-size:12.5px;margin-top:2px;text-transform:uppercase;letter-spacing:.6px}
.stepper{display:flex;align-items:center;gap:14px}
.statedit{width:2.4ch;background:transparent;border:0;color:var(--fg);font:600 32px/1.05 'JetBrains Mono',monospace;letter-spacing:-.5px;padding:0;text-align:left;transition:transform .15s cubic-bezier(.2,.8,.3,1.4),color .2s}
.statedit:focus{outline:none}
.statedit::-webkit-outer-spin-button,.statedit::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.statedit[type=number]{-moz-appearance:textfield}
.statedit.ok{color:var(--ok)}
.statedit.bump{transform:scale(1.16)}
.steps{display:flex;flex-direction:column;gap:5px}
.step{width:36px;height:22px;min-height:0;padding:0;display:grid;place-items:center;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--mut);cursor:pointer;transition:transform .12s,background .18s,color .18s,border-color .18s,box-shadow .18s}
.step:hover{color:#0a0e17;background:var(--grad);border-color:transparent;box-shadow:0 7px 16px -8px rgba(124,92,246,.85)}
.step:active{transform:scale(.86)}
.step:focus-visible{outline:2px solid var(--v);outline-offset:2px}
.step svg{width:14px;height:14px}
.stat .l .hint{margin-left:7px;font-size:9.5px;color:var(--v);border:1px solid rgba(168,85,247,.35);padding:1px 6px;border-radius:6px;text-transform:none;letter-spacing:0;vertical-align:1px}
.stat.warn{border-color:rgba(251,191,36,.4)}
.stat.warn::before{background:linear-gradient(90deg,var(--warn),transparent);opacity:1}
.stat.warn .n,.stat.warn .num{color:var(--warn)}
.stat.crit{border-color:rgba(251,113,133,.45)}
.stat.crit::before{background:linear-gradient(90deg,var(--bad),transparent);opacity:1}
.stat.crit .n,.stat.crit .num{color:var(--bad)}
.cardnote{display:block;margin-top:5px;font-size:11px;letter-spacing:0;text-transform:none;font-weight:600}
.stat.warn .cardnote{color:var(--warn)}.stat.crit .cardnote{color:var(--bad)}
.reveal{opacity:0;transform:translateY(14px)}
.reveal.in{opacity:1;transform:none;transition:opacity .6s cubic-bezier(.2,.7,.2,1),transform .6s cubic-bezier(.2,.7,.2,1)}
/* actions */
.actions{padding:16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
button,.btn{font:inherit;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:8px;padding:10px 15px;border-radius:var(--r2);border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--fg);transition:transform .15s,border-color .2s,background .2s,box-shadow .2s;min-height:42px}
button svg{width:17px;height:17px}
button:hover{border-color:var(--line2);background:rgba(255,255,255,.07);transform:translateY(-1px)}
button:active{transform:translateY(0)}
button:focus-visible{outline:2px solid var(--v);outline-offset:2px}
button.p{background:var(--grad);border:0;color:#0a0e17;font-weight:600;box-shadow:0 8px 22px -10px rgba(124,92,246,.9)}
button.p:hover{box-shadow:0 12px 26px -8px rgba(124,92,246,1);filter:brightness(1.06)}
button.g{color:var(--ok);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
button.g:hover{background:rgba(52,211,153,.15)}
button.r{color:var(--bad);border-color:rgba(251,113,133,.32);background:rgba(251,113,133,.08)}
button.r:hover{background:rgba(251,113,133,.15)}
button:disabled{opacity:.4;cursor:not-allowed;transform:none}
.sep{width:1px;height:26px;background:var(--line);margin:0 2px}
/* tooltip */
[data-tip]{position:relative}
[data-tip]::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 12px);transform:translate(-50%,6px);width:max-content;max-width:260px;white-space:normal;text-align:left;font:400 12.5px/1.5 Inter,sans-serif;color:var(--fg);background:rgba(17,23,37,.94);backdrop-filter:blur(14px);border:1px solid var(--line2);border-radius:12px;padding:10px 13px;box-shadow:0 20px 44px -18px #000,0 1px 0 rgba(255,255,255,.07) inset;opacity:0;pointer-events:none;transition:opacity .18s cubic-bezier(.2,.7,.2,1),transform .18s cubic-bezier(.2,.7,.2,1);z-index:70}
[data-tip]::before{content:"";position:absolute;left:50%;bottom:calc(100% + 6px);transform:translateX(-50%);border:6px solid transparent;border-top-color:rgba(17,23,37,.94);opacity:0;transition:opacity .18s;z-index:70}
[data-tip]:hover::after,[data-tip]:focus-visible::after{opacity:1;transform:translate(-50%,0)}
[data-tip]:hover::before,[data-tip]:focus-visible::before{opacity:1}
@media (prefers-reduced-motion:reduce){[data-tip]::after{transition:opacity .1s}}
@media (max-width:640px){[data-tip]::after{max-width:210px}}
/* switch */
.switch{margin-left:auto;display:inline-flex;align-items:center;gap:10px;color:var(--mut);font-size:13px;cursor:pointer;user-select:none}
.switch input{display:none}
.track{width:44px;height:25px;border-radius:999px;background:rgba(255,255,255,.09);border:1px solid var(--line);position:relative;transition:.25s}
.track::after{content:"";position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:var(--mut);transition:.25s}
.switch input:checked+.track{background:linear-gradient(120deg,#a855f7,#22d3ee)}
.switch input:checked+.track::after{left:21px;background:#0a0e17}
/* workspace */
.workspace{overflow:hidden;margin-bottom:18px}
.tabs{display:flex;gap:2px;padding:8px 8px 0;border-bottom:1px solid var(--line);overflow-x:auto}
.tab{padding:11px 16px;color:var(--mut);cursor:pointer;border-radius:10px 10px 0 0;position:relative;white-space:nowrap;transition:color .2s;font-size:13.5px}
.tab:hover{color:var(--fg)}
.tab.sel{color:var(--fg)}
.tab.sel::after{content:"";position:absolute;left:12px;right:12px;bottom:-1px;height:2px;border-radius:2px;background:var(--grad)}
.tab svg,.saved svg{width:16px;height:16px;vertical-align:-3px;margin-right:5px}
.dropzone svg{width:26px;height:26px;color:var(--v)}
.panel{padding:20px}
.panel-in{animation:fadeUp .35s cubic-bezier(.2,.7,.2,1)}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.hint{color:var(--mut);font-size:13px;margin:0 0 12px}.hint b{color:var(--fg);font-weight:600}
textarea{width:100%;min-height:250px;background:rgba(0,0,0,.28);color:var(--fg);border:1px solid var(--line);border-radius:var(--r2);padding:14px;font:13px/1.6 'JetBrains Mono',monospace;resize:vertical}
textarea:focus{outline:none;border-color:var(--line2);box-shadow:0 0 0 3px rgba(99,102,241,.15)}
.saverow{display:flex;align-items:center;gap:12px;margin-top:14px}
.saved{color:var(--ok);font-size:13px;opacity:0;transform:translateY(3px);transition:.25s;display:inline-flex;gap:6px;align-items:center}
.saved.show{opacity:1;transform:none}
/* spotify link lookup */
.lookup{display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:9px 11px;border:1px solid var(--line);border-radius:var(--r2);background:linear-gradient(180deg,rgba(29,185,84,.07),rgba(255,255,255,.02))}
.lookup .lki{display:inline-flex;color:#1db954}.lookup .lki svg{width:18px;height:18px}
.lookup input{flex:1;min-width:0;background:rgba(0,0,0,.28);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:9px 12px;font-size:13px}
.lookup input::placeholder{color:var(--dim)}
.lookup input:focus{outline:none;border-color:#1db954;box-shadow:0 0 0 3px rgba(29,185,84,.15)}
.lookup #lkb{white-space:nowrap}
.lookup #lkb.busy{opacity:.6;pointer-events:none}
.lookup #lkb.busy svg{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.tbl tr.flash{animation:rowflash 1.1s ease}
@keyframes rowflash{0%{background:rgba(29,185,84,.22)}100%{background:transparent}}
/* table */
.tblwrap{border:1px solid var(--line);border-radius:var(--r2);overflow:hidden;overflow-x:auto}
.tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px;min-width:520px}
.tbl th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.7px;padding:11px 12px;background:rgba(255,255,255,.025);border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{border-bottom:1px solid var(--line);vertical-align:middle}
.tbl tr:last-child td{border-bottom:0}
.tbl tbody tr{transition:background .15s}
.tbl tbody tr:hover td{background:rgba(255,255,255,.022)}
.tbl .idx{color:var(--dim);width:40px;text-align:right;padding:0 12px 0 6px;font-family:'JetBrains Mono';font-size:12px}
.tbl .cell input{width:100%;background:transparent;border:1px solid transparent;border-radius:8px;color:var(--fg);padding:9px 11px;font:inherit;transition:.15s}
.tbl .cell input::placeholder{color:var(--dim)}
.tbl .cell input:hover{border-color:var(--line)}
.tbl .cell input:focus{outline:none;border-color:var(--v);background:rgba(0,0,0,.28)}
.tbl .cell.mono input{font-family:'JetBrains Mono';font-size:12px}
.tbl th.chk,.tbl td.chk{width:74px;text-align:center;padding-left:0;padding-right:8px}
.tbl .cell.chk input[type=checkbox]{width:19px;height:19px;accent-color:#1db954;cursor:pointer;margin:0;vertical-align:middle}
.tbl .st{width:96px;padding-right:10px}
.tbl .act{width:40px}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut);white-space:nowrap}
.badge.done{color:var(--ok);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
.badge.wait{color:var(--warn);border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.07)}
.badge .d{width:6px;height:6px;border-radius:50%;background:currentColor}
.del{opacity:0;color:var(--mut);cursor:pointer;background:none;border:0;min-height:0;padding:8px;border-radius:8px;transition:.15s;font-size:15px;line-height:1}
tr:hover .del{opacity:.7}
.del:hover{opacity:1;color:var(--bad);background:rgba(251,113,133,.1)}
.emptyrow td{padding:26px;text-align:center;color:var(--dim)}
/* covers */
.dropzone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:1.5px dashed var(--line2);border-radius:var(--r2);padding:26px;text-align:center;color:var(--mut);transition:.2s;cursor:pointer}
.dropzone:hover,.dropzone.drag{border-color:var(--v);background:rgba(168,85,247,.06);color:var(--fg)}
.covers{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:12px;margin-top:16px}
.cov{position:relative;border-radius:var(--r2);overflow:hidden;aspect-ratio:1;border:1px solid var(--line);animation:pop .3s cubic-bezier(.2,.9,.3,1)}
@keyframes pop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
.cov img{width:100%;height:100%;object-fit:cover;transition:.3s}
.cov:hover img{transform:scale(1.06)}
.cov b{position:absolute;top:6px;right:6px;width:24px;height:24px;display:grid;place-items:center;background:rgba(8,11,18,.72);backdrop-filter:blur(6px);border:1px solid var(--line);color:#fff;border-radius:8px;cursor:pointer;font-size:13px;opacity:0;transition:.2s}
.cov:hover b{opacity:1}
/* console */
.console{overflow:hidden;margin-bottom:22px}
.console-head{display:flex;align-items:center;gap:9px;padding:13px 18px;border-bottom:1px solid var(--line);font-size:13px;color:var(--mut);font-weight:500}
.console-head .d{width:8px;height:8px;border-radius:50%;background:var(--ok);animation:pulse 2s infinite;flex:none}
.lgcount{margin-left:auto;color:var(--dim);font-size:11.5px;font-family:'JetBrains Mono',monospace}
.lgclear{padding:5px 11px;min-height:0;font-size:12px;border-radius:8px}
.log{height:300px;overflow:auto;padding:10px 12px;font:12.5px/1.5 'JetBrains Mono',monospace}
.lg{display:flex;gap:10px;align-items:baseline;padding:4px 9px;border-radius:8px;border-left:2px solid transparent;animation:logIn .28s ease}
.lg+.lg{margin-top:1px}
.lg:hover{background:rgba(255,255,255,.025)}
.lt{color:var(--dim);font-size:11px;min-width:60px;flex:none;font-variant-numeric:tabular-nums}
.lgi{width:14px;flex:none;text-align:center;font-size:11px}
.lx{flex:1;overflow-wrap:anywhere;color:#aeb9cc}
.lg.info .lgi::before{content:"·";color:var(--dim)}
.lg.rn{border-color:rgba(34,211,238,.3)}.lg.rn .lgi::before{content:"♪";color:var(--c)}.lg.rn .lx{color:#cdd8e8}
.lg.sys{border-color:rgba(99,102,241,.4)}.lg.sys .lgi::before{content:"▸";color:var(--i)}.lg.sys .lx{color:#c6cdf6}
.lg.ok{border-color:rgba(52,211,153,.45)}.lg.ok .lgi::before{content:"✓";color:var(--ok)}.lg.ok .lx{color:#bdefd6}
.lg.err{border-color:rgba(251,113,133,.5);background:rgba(251,113,133,.06)}.lg.err .lgi::before{content:"✕";color:var(--bad)}.lg.err .lx{color:#ffc4cb}
.lg.warn{border-color:rgba(251,191,36,.55);background:rgba(251,191,36,.08)}.lg.warn .lgi::before{content:"⚠";color:var(--warn)}.lg.warn .lx{color:#ffe6ad}
.logempty{color:var(--dim);padding:22px 10px;text-align:center;font-family:Inter,sans-serif}
@keyframes logIn{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:none}}
.log::-webkit-scrollbar,textarea::-webkit-scrollbar{width:9px;height:9px}
.log::-webkit-scrollbar-thumb,textarea::-webkit-scrollbar-thumb{background:var(--line2);border-radius:9px}
@media (max-width:640px){.topbar{margin:10px;padding:12px 14px}.wrap{padding:14px}.hero h1{font-size:24px}.pills{width:100%;margin:8px 0 0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.reveal{opacity:1;transform:none}}
</style>`; }

function SVGDEFS() { return `<svg width="0" height="0" style="position:absolute"><defs>
<g id="i-disc"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></g>
<g id="i-key" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="8" cy="8" r="4"/><path d="M11 11l7 7M15 15l2-2M17 17l2-2"/></g>
<g id="i-play" fill="currentColor"><path d="M7 5l12 7-12 7z"/></g>
<g id="i-rocket" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 15c-1 2-1 4-1 4s2 0 4-1M14 4c3-1 6 0 6 0s1 3 0 6c-1 3-6 8-8 9l-4-4c1-2 6-7 6-11z"/><circle cx="14.5" cy="9.5" r="1.4" fill="currentColor" stroke="none"/></g>
<g id="i-loop" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 12a8 8 0 0113-6l2 2M20 12a8 8 0 01-13 6l-2-2"/><path d="M19 4v4h-4M5 20v-4h4"/></g>
<g id="i-stop" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></g>
<g id="i-list" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></g>
<g id="i-mic" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0012 0M12 17v4"/></g>
<g id="i-img" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M4 16l4-4 4 4 3-3 5 5"/><circle cx="8.5" cy="9" r="1.4"/></g>
<g id="i-gear" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.5M12 18.5V21M4.2 7l2.1 1.3M17.7 15.7l2.1 1.3M4.2 17l2.1-1.3M17.7 8.3l2.1-1.3" stroke-linecap="round"/></g>
<g id="i-save" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></g>
<g id="i-check" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></g>
<g id="i-up" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7 10l5-5 5 5M5 19h14"/></g>
<g id="i-link" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 006 .5l3-3a4 4 0 00-5.7-5.7L11.5 7"/><path d="M14 10a4 4 0 00-6-.5l-3 3a4 4 0 005.7 5.7L12.5 17"/></g>
</defs></svg>`; }
function ic(id) { return '<svg viewBox="0 0 24 24"><use href="#i-' + id + '"/></svg>'; }

function BODY() { return `<div class="aurora"><i></i><i></i><i></i></div><div class="grid-fade"></div>
<header class="topbar glass"><div class="brand"><span class="logo">` + ic('disc') + `</span>regotty <b>distributor</b></div><div class="pills" id="pills"></div></header>
<main class="wrap">
<section class="hero"><h1>Dağıtım <span>Kontrol Merkezi</span></h1><p>CSV + kapaklar → cover üret → risk/kalite geçidi → 6 versiyon → RouteNote (9 mağaza). Aşağıdan yönet, canlı takip et.</p></section>
<section class="cards" id="cards"></section>
<section class="actions glass">
<button class="p" onclick="run('login')" data-tip="Chrome açılır, captcha otomatik çözülür ve RouteNote oturumu açılır. Oturum kaydedilir; her seferinde gerekmez.">` + ic('key') + `RouteNote Giriş</button>
<span class="sep"></span>
<button onclick="run('once')" data-tip="Bir kez çalışır: 1 release üretir ve RouteNote'ta TASLAK bırakır. Yayınlanmaz — sen kontrol edip elle yayınlarsın.">` + ic('play') + `1 Release · taslak</button>
<button class="g" onclick="run('once-publish')" data-tip="Bir kez çalışır: 1 release üretir ve doğrudan YAYINA gönderir (9 mağazaya dağıtılır).">` + ic('rocket') + `1 Release · yayınla</button>
<span class="sep"></span>
<button id="btnDaemon" onclick="run('daemon')" data-tip="Arka planda sürekli çalışır: günlük hedef kadar release üretir, hepsini taslak bırakır.">` + ic('loop') + `Daemon · taslak</button>
<button class="g" id="btnDaemonPub" onclick="run('daemon-publish')" data-tip="Arka planda sürekli çalışır: günlük hedef kadar release üretir ve otomatik yayınlar.">` + ic('loop') + `Daemon · yayınla</button>
<button class="r" onclick="stop()" data-tip="Çalışan işlemi (tek release ya da daemon) durdurur.">` + ic('stop') + `Durdur</button>
<label class="switch" data-tip="Açıkken üretilen release'ler otomatik YAYINLANIR; kapalıyken TASLAK kalır. --yayınla butonlarıyla aynı etkiyi kalıcı yapar."><input type="checkbox" id="auto" onchange="setAuto(this.checked)"><span class="track"></span>otomatik yayınla</label>
</section>
<section class="workspace glass"><nav class="tabs" id="tabs"></nav><div class="panel" id="panel"></div></section>
<section class="console glass"><div class="console-head"><span class="d"></span>Canlı Log<span class="lgcount"><span id="logcount">0</span> satır</span><button class="lgclear" onclick="clearLog()">Temizle</button></div><div class="log" id="log"><div class="logempty" id="logempty">Henüz log yok — bir işlem başlat.</div></div></section>
</main>`; }

function SCRIPT() { return `<script>
var $=function(s){return document.querySelector(s)};
var sinceLog=0, tab='queue';
var TABS={queue:['list','Kuyruk'],artists:['mic','Sanatçılar'],covers:['img','Kapaklar'],config:['gear','Ayar']};
var IC={disc:` + JSON.stringify(ic('disc')) + `,list:` + JSON.stringify(ic('list')) + `,mic:` + JSON.stringify(ic('mic')) + `,img:` + JSON.stringify(ic('img')) + `,gear:` + JSON.stringify(ic('gear')) + `,save:` + JSON.stringify(ic('save')) + `,check:` + JSON.stringify(ic('check')) + `,up:` + JSON.stringify(ic('up')) + `,loop:` + JSON.stringify(ic('loop')) + `,link:` + JSON.stringify(ic('link')) + `};
function api(u,o){return fetch(u,o).then(function(r){return r.json()})}
function esc(s){return String(s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function countUp(el,to){var from=+el.dataset.v||0;if(from===to){el.textContent=to;return}el.dataset.v=to;var t0=performance.now(),d=650;function step(t){var k=Math.min(1,(t-t0)/d);var e=1-Math.pow(1-k,3);el.textContent=Math.round(from+(to-from)*e);if(k<1)requestAnimationFrame(step)}requestAnimationFrame(step)}

var STAT=[['disc','songsPending','Bekleyen şarkı','songsTotal'],['mic','artists','Sanatçı profili',null],['img','covers','Hazır kapak',null],['loop','_daily','Günlük hedef',null,1]];
var built=false;
function refresh(){api('/api/status').then(function(s){
  var pills=[['RouteNote',s.loggedIn?'giriş yapıldı':'giriş yok',s.loggedIn?'on':'off'],['Ayar',s.configReady?'hazır':'eksik',s.configReady?'on':'off'],['Durum',s.running?('çalışıyor · '+s.running):'boşta',s.running?'run':''],['autoSubmit',s.autoSubmit?'AÇIK':'kapalı',s.autoSubmit?'run':''],['Vokal',s.vocalMode==='whisper'?'kelime kontrolü':(s.vocalMode==='off'?'kapalı':'muffle'),s.vocalMode==='whisper'?'on':'']];
  $('#pills').innerHTML=pills.map(function(p){return '<span class="pill '+p[2]+'"><span class="d"></span><b style="color:inherit;font-weight:600">'+p[0]+'</b> '+p[1]+'</span>'}).join('');
  s._daily=s.schedule?s.schedule.releasesPerDay:0;
  var _per=s._daily, _ih=s.schedule?s.schedule.intervalHours:24;
  var _td=$('#btnDaemon'); if(_td)_td.setAttribute('data-tip','Arka planda SÜREKLİ çalışır: günde '+_per+' release\\'i '+_ih+' saate yayarak üretir, hepsini TASLAK bırakır. Durdurana kadar devam eder.');
  var _tdp=$('#btnDaemonPub'); if(_tdp)_tdp.setAttribute('data-tip','Arka planda SÜREKLİ çalışır: günde '+_per+' release üretir ve her birini otomatik YAYINA gönderir. Durdurana kadar devam eder.');
  if(!built){built=true;$('#cards').innerHTML=STAT.map(function(a,i){
    var body=a[4]
      ? '<div class="stepper"><input class="statedit num" id="daily" type="number" min="1" max="999" value="'+(s._daily||30)+'" oninput="sizeDaily()" onchange="saveDaily(this.value)" onkeydown="if(event.key===\\'Enter\\')this.blur()"><div class="steps"><button type="button" class="step" aria-label="artır" onclick="stepDaily(1)"><svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="step" aria-label="azalt" onclick="stepDaily(-1)"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div>'
      : '<span class="num" id="st'+i+'">0</span>'+(a[3]?' <small class="num">/ <span id="st'+i+'t">0</span></small>':'');
    return '<div class="stat glass reveal" id="card'+i+'" style="transition-delay:'+(i*70)+'ms"><div class="ico">'+(IC[a[0]]||'')+'</div><div class="n">'+body+'</div><div class="l">'+a[2]+(a[4]?' <span class="hint">düzenle</span>':'')+'<span class="cardnote" id="note'+i+'"></span></div></div>';
  }).join('');
    requestAnimationFrame(function(){document.querySelectorAll('.reveal').forEach(function(el){el.classList.add('in')})});}
  STAT.forEach(function(a,i){if(a[4])return;countUp($('#st'+i),s[a[1]]||0);if(a[3])$('#st'+i+'t').textContent=s[a[3]]||0});
  var de=$('#daily');if(de&&document.activeElement!==de){de.value=s._daily;sizeDaily();}
  // #8 kuyruk/kapak azaldi uyarilari
  setCard(0, s.songsPending===0?'crit':'', s.songsPending===0?'kuyruk boş — şarkı ekle':'');
  setCard(2, s.covers===0?'crit':(s.covers<s.songsPending?'warn':''), s.covers===0?'kapak yok — ekle!':(s.covers<s.songsPending?'kapak az ('+s.covers+'<'+s.songsPending+')':''));
  $('#auto').checked=!!s.autoSubmit;
  if(tab==='covers')loadCovers(s.coverNames);
})}

$('#tabs').innerHTML=Object.keys(TABS).map(function(k){return '<div class="tab" data-k="'+k+'">'+(IC[TABS[k][0]]||'')+' '+TABS[k][1]+'</div>'}).join('');
$('#tabs').onclick=function(e){var t=e.target.closest('.tab');if(t){tab=t.dataset.k;renderTab()}};
var FNAME={queue:'input',artists:'artists',config:'config'};
var TABLES={queue:{cols:[{k:'artist',ph:'Orijinal sanatçı (© C-line)'},{k:'song',ph:'Şarkı adı'},{k:'url',ph:'Spotify link (opsiyonel)',mono:true},{k:'instrumental',type:'check',label:'🎹 Enst.',title:'İşaretliyse bu şarkının INSTRUMENTAL versiyonu üretilir (vokal ayrılıp çıkarılır), "... - Instrumental" diye isimlenir.'}],status:true,header:['artist','song','url','instrumental']},artists:{cols:[{k:'artist_name',ph:'Profil adı'},{k:'spotify_url',ph:'https://open.spotify.com/artist/…',mono:true}],status:false,header:['artist_name','spotify_url']}};
var doneCount=0;var doneKeys={};
function qkey(a,s){return String(a==null?'':a).trim().toLowerCase()+'|'+String(s==null?'':s).trim().toLowerCase()}
function csvSplit(line){var o=[],c='',q=false;for(var i=0;i<line.length;i++){var ch=line[i];if(q){if(ch==='"'&&line[i+1]==='"'){c+='"';i++}else if(ch==='"'){q=false}else c+=ch}else if(ch==='"')q=true;else if(ch===','){o.push(c);c=''}else c+=ch}o.push(c);return o.map(function(s){return s.trim()})}
function parseCsv(text,header){var lines=String(text||'').split(/\\r?\\n/).filter(function(l){return l.trim()!==''});if(!lines.length)return [];var start=(lines[0]&&csvSplit(lines[0])[0].toLowerCase()===header[0].toLowerCase())?1:0;return lines.slice(start).map(csvSplit)}
function csvCell(v){v=String(v==null?'':v);return /[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}
function serializeCsv(header,rows){return [header].concat(rows).map(function(r){return r.map(csvCell).join(',')}).join('\\n')+'\\n'}
function flashSaved(){var sv=$('#sv');if(sv){sv.classList.add('show');setTimeout(function(){sv.classList.remove('show')},1400)}}

function renderTab(){
  document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('sel',t.dataset.k===tab)});
  var pn=$('#panel');pn.classList.remove('panel-in');void pn.offsetWidth;pn.classList.add('panel-in');
  if(tab==='covers'){pn.innerHTML='<div class="hint">3000×3000 JPG/PNG · her release <b>bir</b> kapak kullanır (kullanınca silinir).</div><label class="dropzone" id="dz">'+IC.up+' <div style="margin-top:8px">Sürükle-bırak ya da <b>seç</b></div><input type="file" accept="image/*" multiple hidden onchange="upload(this.files)"></label><div class="covers" id="covs"></div>';
    var dz=$('#dz');dz.ondragover=function(e){e.preventDefault();dz.classList.add('drag')};dz.ondragleave=function(){dz.classList.remove('drag')};dz.ondrop=function(e){e.preventDefault();dz.classList.remove('drag');upload(e.dataTransfer.files)};
    refresh();return;}
  if(tab==='config'){pn.innerHTML='<div class="hint">Gizli alanlar: <b>routenote.login</b> · <b>captcha.apiKey</b> · <b>regotty.token</b> · <b>spotifyCredits.tokenCachePath</b></div><textarea id="ta" spellcheck="false"></textarea><div class="saverow"><button class="p" onclick="saveText()">'+IC.save+'Kaydet</button><span class="saved" id="sv">'+IC.check+'kaydedildi</span></div>';
    api('/api/file?name=config').then(function(r){$('#ta').value=r.text||''});return;}
  renderTableTab(tab);
}
function renderTableTab(name){
  var pn=$('#panel');var t=TABLES[name];
  var hints={queue:'Cover\\'lanacak kaynak şarkılar. <b>Orijinal sanatçı</b> © C-line\\'a girer; mashup ise iki isim virgülle. Link yapıştırırsan besteci+explicit tam o şarkıdan çekilir. <b>🎹 Enst.</b> tikliyse INSTRUMENTAL sürüm üretilir.',artists:'Senin dağıtım profillerin — sırayla döner. Her satır bir profil.'};
  var ths='<th class="idx">#</th>'+t.cols.map(function(c){return '<th'+(c.type==='check'?' class="chk"':'')+(c.title?' title="'+esc(c.title)+'"':'')+'>'+(c.label||c.k.replace(/_/g,' '))+'</th>'}).join('')+(t.status?'<th class="st">Durum</th>':'')+'<th class="act"></th>';
  var lk=name==='queue'?'<div class="lookup"><span class="lki">'+IC.link+'</span><input id="lk" placeholder="Spotify şarkı linki yapıştır → sanatçı + şarkı otomatik dolar" onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();lookupAdd()}"><button id="lkb" class="p" onclick="lookupAdd()">'+IC.link+'Çek</button></div>':'';
  pn.innerHTML='<div class="hint">'+hints[name]+'</div>'+lk+'<div class="tblwrap"><table class="tbl"><thead><tr>'+ths+'</tr></thead><tbody id="tb"></tbody></table></div><div class="saverow"><button onclick="addRow()">+ Satır ekle</button><button class="p" onclick="saveTable()">'+IC.save+'Kaydet</button><span class="saved" id="sv">'+IC.check+'kaydedildi</span></div>';
  Promise.all([api('/api/file?name='+FNAME[name]),api('/api/status')]).then(function(a){
    doneCount=a[1].songsDone||0;doneKeys={};(a[1].doneKeys||[]).forEach(function(k){doneKeys[k]=1});var rows=parseCsv(a[0].text,t.header);var tb=$('#tb');tb.innerHTML='';
    if(!rows.length){addRow();return;}
    rows.forEach(function(r,i){tb.appendChild(rowEl(name,r,i))});
  });
}
function rowEl(name,vals,i){
  var t=TABLES[name];var tr=document.createElement('tr');
  var cells='<td class="idx">'+(i+1)+'</td>';
  cells+=t.cols.map(function(c,ci){
    if(c.type==='check'){var on=/^(1|yes|true|evet|x|on)$/i.test(String(vals[ci]||'').trim());return '<td class="cell chk"'+(c.title?' title="'+esc(c.title)+'"':'')+'><input type="checkbox" data-k="'+esc(c.k)+'"'+(on?' checked':'')+'></td>'}
    return '<td class="cell'+(c.mono?' mono':'')+'"><input value="'+esc(vals[ci]||'').replace(/"/g,'&quot;')+'" placeholder="'+esc(c.ph)+'"></td>'}).join('');
  if(t.status){var done=(name==='queue'&&!!doneKeys[qkey(vals[0],vals[1])]);cells+='<td class="st"><span class="badge '+(done?'done':'wait')+'"><span class="d"></span>'+(done?'işlendi':'sırada')+'</span></td>'}
  cells+='<td class="act"><button class="del" title="sil" onclick="this.closest(\\'tr\\').remove()">✕</button></td>';
  tr.innerHTML=cells;return tr;
}
function addRow(){var tb=$('#tb');if(!tb)return;var tr=rowEl(tab,[],tb.querySelectorAll('tr').length);tb.appendChild(tr);var inp=tr.querySelector('input');if(inp)inp.focus()}
function lookupAdd(){var el=$('#lk');if(!el)return;var v=(el.value||'').trim();if(!v){el.focus();return}var btn=$('#lkb');if(btn){btn.disabled=true;btn.classList.add('busy')}
  api('/api/lookup?url='+encodeURIComponent(v)).then(function(r){if(btn){btn.disabled=false;btn.classList.remove('busy')}
    if(!r||r.error){toast(r&&r.error?r.error:'çekilemedi');return}
    var tb=$('#tb');if(tb){var tr=rowEl('queue',[r.artist,r.song,r.url],tb.querySelectorAll('tr').length);tb.appendChild(tr);tr.classList.add('flash')}
    el.value='';el.focus();
    toast(r.song+' — '+r.artist+(r.explicit?' · 🅴 explicit':'')+(r.composer?' · '+r.composer:'')+'  (Kaydet\\'e basmayı unutma)');
  }).catch(function(){if(btn){btn.disabled=false;btn.classList.remove('busy')}toast('çekilemedi')})}
function saveTable(){var t=TABLES[tab];var rows=[];$('#tb').querySelectorAll('tr').forEach(function(tr){var r=[],any=false;tr.querySelectorAll('input').forEach(function(inp){if(inp.type==='checkbox'){r.push(inp.checked?'yes':'')}else{var v=inp.value.trim();r.push(v);if(v)any=true}});if(any)rows.push(r)});api('/api/file?name='+FNAME[tab],{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:serializeCsv(t.header,rows)})}).then(function(){flashSaved();refresh()})}
function saveText(){api('/api/file?name=config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:$('#ta').value})}).then(function(r){if(r&&r.error){toast(r.error);return}flashSaved();refresh()})}
function setCard(i,cls,note){var c=$('#card'+i);if(c){c.classList.remove('warn','crit');if(cls)c.classList.add(cls)}var n=$('#note'+i);if(n)n.textContent=note||''}
function loadCovers(names){var c=$('#covs');if(!c)return;c.innerHTML=(names||[]).map(function(n){return '<div class="cov"><img src="/covers-preview?n='+encodeURIComponent(n)+'"><b onclick="delCover(\\''+n.replace(/\\\\/g,'').replace(/'/g,'')+'\\')">✕</b></div>'}).join('')||'<div class="hint" style="grid-column:1/-1">Henüz kapak yok — yukarıdan ekle.</div>';}
function upload(files){var q=[];for(var i=0;i<files.length;i++)(function(f){q.push(new Promise(function(res){var fr=new FileReader();fr.onload=function(){api('/api/cover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.name,data:fr.result})}).then(res)};fr.readAsDataURL(f)}))})(files[i]);Promise.all(q).then(refresh)}
function delCover(n){api('/api/cover?name='+encodeURIComponent(n),{method:'DELETE'}).then(refresh)}
function run(kind){api('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:kind})}).then(function(r){if(r.error)toast(r.error);refresh()})}
function stop(){api('/api/stop',{method:'POST'}).then(refresh)}
function setAuto(v){if(v&&!confirm('autoSubmit AÇILIYOR — üretilen release\\'ler otomatik YAYINA gönderilir. Emin misin?')){$('#auto').checked=false;return}api('/api/autosubmit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:v})}).then(refresh)}
function sizeDaily(){var de=$('#daily');if(de)de.style.width=(((''+de.value).length||1)+0.3)+'ch'}
var _dailyT=null;
function stepDaily(d){var de=$('#daily');if(!de)return;var n=Math.max(1,Math.min(999,(parseInt(de.value,10)||30)+d));de.value=n;sizeDaily();de.classList.remove('bump');void de.offsetWidth;de.classList.add('bump');setTimeout(function(){de.classList.remove('bump')},170);clearTimeout(_dailyT);_dailyT=setTimeout(function(){saveDaily(n)},350)}
function saveDaily(v){var n=Math.max(1,Math.min(999,parseInt(v,10)||1));api('/api/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({releasesPerDay:n})}).then(function(){var de=$('#daily');if(de){de.value=n;sizeDaily();de.classList.add('ok');setTimeout(function(){de.classList.remove('ok')},1200)}})}
function toast(m){var d=document.createElement('div');d.textContent=m;d.style.cssText='position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#1b2336;border:1px solid var(--line2);padding:11px 18px;border-radius:12px;z-index:99;box-shadow:0 20px 40px -20px #000';document.body.appendChild(d);setTimeout(function(){d.remove()},3200)}
function logType(s){
  if(/oturum düş|yeniden giriş|uyar|⚠/i.test(s))return 'warn';
  if(/hata|error|fail|başarısız|FATAL|çözülemedi/i.test(s))return 'err';
  if(/✔|✓|başarı|success|yüklendi|kaydedildi|hazır|tamam|paket hazır|yayına gönder|oturum kuruldu|mağazalar seçildi|onayland/i.test(s))return 'ok';
  if(/^\s*[▶■⏹✎⚙🖼🗑]/.test(s))return 'sys';
  if(/^\s*\[rn\]|album olu|cloud_upload|mağaza|kapak|parça|besteci|risk=/i.test(s))return 'rn';
  return 'info';
}
function pollLogs(){api('/api/logs?since='+sinceLog).then(function(r){
  if(!r.logs||!r.logs.length)return;var el=$('#log');var emp=$('#logempty');if(emp)emp.remove();
  var atBottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  r.logs.forEach(function(l){
    var ty=logType(l.line);var tm=new Date(l.t||Date.now()).toTimeString().slice(0,8);
    var txt=l.line.replace(/^\s*[✔✓✕⚠▶■⏹🖼🗑✎⚙]\s*/,'').trim();
    var d=document.createElement('div');d.className='lg '+ty;
    d.innerHTML='<span class="lt">'+tm+'</span><span class="lgi"></span><span class="lx">'+esc(txt)+'</span>';
    el.appendChild(d);
  });
  sinceLog=r.last;$('#logcount').textContent=el.querySelectorAll('.lg').length;
  if(atBottom)el.scrollTop=el.scrollHeight;
})}
function clearLog(){var el=$('#log');if(el){el.innerHTML='<div class="logempty" id="logempty">Temizlendi — yeni loglar burada görünecek.</div>';$('#logcount').textContent=0}}
renderTab();refresh();setInterval(refresh,3000);setInterval(pollLogs,1100);pollLogs();
</script>`; }
