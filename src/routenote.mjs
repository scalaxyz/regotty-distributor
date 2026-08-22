// RouteNote automation — auto-login (CapSolver-solved reCAPTCHA) + session
// management. The upload flow (create_album -> editalbum -> uploads) builds on
// this and lands next. See docs/routenote-flow.md.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- minimal cookie jar ------------------------------------------------------
class CookieJar {
  constructor() { this.jar = new Map(); }
  ingest(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const parts = c.split(';');
      const idx = parts[0].indexOf('=');
      if (idx <= 0) continue;
      const name = parts[0].slice(0, idx).trim();
      const value = parts[0].slice(idx + 1).trim();
      // Honor deletions (RouteNote wipes cookies on the login page load, then
      // re-sets them via JS): Max-Age<=0 or an expiry in the past removes the key.
      let deleted = /^deleted$/i.test(value);
      for (const attr of parts.slice(1)) {
        const a = attr.trim().toLowerCase();
        if (/^max-age=(0|-\d+)$/.test(a)) deleted = true;
        else if (a.startsWith('expires=')) { const t = Date.parse(attr.trim().slice(8)); if (!Number.isNaN(t) && t <= Date.now()) deleted = true; }
      }
      if (deleted) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  header() { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  get size() { return this.jar.size; }
  toJSON() { return Object.fromEntries(this.jar); }
  static from(obj) { const j = new CookieJar(); for (const [k, v] of Object.entries(obj || {})) j.jar.set(k, v); return j; }
}

async function jarFetch(jar, url, opts = {}) {
  const headers = { 'User-Agent': UA, ...(opts.headers || {}) };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  jar.ingest(res);
  return res;
}

// ---- CapSolver ---------------------------------------------------------------
async function solveRecaptcha(captcha) {
  const clientKey = captcha.apiKey;
  const create = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey,
      task: {
        type: captcha.type || 'ReCaptchaV2TaskProxyLess',
        websiteURL: captcha.pageUrl,
        websiteKey: captcha.siteKey,
        isInvisible: captcha.isInvisible !== false,
      },
    }),
  }).then((r) => r.json());
  if (create.errorId) throw new Error(`CapSolver createTask: ${create.errorDescription || create.errorCode}`);
  const taskId = create.taskId;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, taskId }),
    }).then((x) => x.json());
    if (r.errorId) throw new Error(`CapSolver getTaskResult: ${r.errorDescription || r.errorCode}`);
    if (r.status === 'ready') return r.solution.gRecaptchaResponse;
  }
  throw new Error('CapSolver zaman aşımı');
}

// ---- login + session ---------------------------------------------------------
function sessionFile(cfg) { return path.resolve(cfg.paths?.state || 'state', 'routenote-session.json'); }
const base = (cfg) => (cfg.routenote.baseUrl || 'https://www.routenote.com').replace(/\/$/, '');

/** True if the jar's session can reach a logged-in page (create_album form). */
async function isLoggedIn(cfg, jar) {
  // Every RouteNote page gates on the two browser-check cookies; assert them
  // (the page JS would) so we get the real page, not the browser-check stub.
  jar.jar.set('FgPJ_PZbv_nMA', 'true');
  jar.jar.set('okLj_8Sopq_07KmP', 'true');
  const res = await jarFetch(jar, `${base(cfg)}/rn/create_album`);
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/login/i.test(loc)) return false;
  }
  const html = await res.text().catch(() => '');
  return /create_album_form|edit_album_info_release/.test(html);
}

// NOTE: A raw-HTTP login is not viable. The RouteNote login form's action is a
// javascript: placeholder; the real submit is the page's #in_signin_button
// handler, which sets ~9 anti-bot cookies (ty8_YytK_Hge_MO0, Tki_iOk0_ytjs,
// Qelps_24h_83MU, EsIJ_Usls_NmMs, checkuser=1, usercockval=00, ...) and only
// then rewrites the action to /rn/?q=user/login. We run that in a real browser
// (browserLogin) and export the resulting cookies for the fetch-based flow.

/**
 * Log in through a real Chrome (Playwright). RouteNote gates its login form
 * behind a browser/JS check that a raw-HTTP POST can't satisfy (it needs the
 * browser's HTTP/2 + TLS profile and the client-side cookie script). We drive
 * the actual browser to pass the gate, solve the visible reCAPTCHA with
 * CapSolver, submit, and export the authenticated cookies for the fetch-based
 * uploader (the post-login endpoints are only cookie-gated, not JS-gated).
 */
export async function browserLogin(cfg, { manual = false } = {}) {
  const { username, password } = cfg.routenote.login || {};
  if (!username || !password) throw new Error('routenote.login.username/password eksik');
  const b = cfg.routenote.browser || {};
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('playwright kurulu değil — `npm install playwright` çalıştır.'); }

  const launchWith = async (channel) => chromium.launch({
    channel, headless: manual ? false : b.headless === true, // manual needs a visible window
    args: ['--disable-blink-features=AutomationControlled'],
  });
  let browser;
  for (const ch of [b.channel || 'chrome', 'msedge', undefined]) {
    try { browser = await launchWith(ch); break; } catch { /* try next channel */ }
  }
  if (!browser) throw new Error('Chrome/Edge başlatılamadı — sistemde Chrome yüklü olmalı (veya `npx playwright install chromium`).');

  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await context.newPage();
    const B = base(cfg);

    await page.goto(`${B}/rn/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The browser-check stub + a /login<->/rn/login redirect bounce resolve into
    // the real form; wait for the password field, reloading once if needed.
    try { await page.waitForSelector('input[name="pass"]', { timeout: 30_000 }); }
    catch { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('input[name="pass"]', { timeout: 30_000 }); }

    await page.fill('input[name="name"]', username);
    await page.fill('input[name="pass"]', password);

    // The real submit is the page's own #in_signin_button handler: it checks
    // grecaptcha.getResponse(), sets a batch of anti-bot cookies, rewrites the
    // form action from its javascript: placeholder to /rn/?q=user/login, then
    // lets the form post. We must let that run — a native form.submit() hits the
    // dead placeholder action and skips the cookies. So we make getResponse()
    // return our token (and fill the textarea the POST reads) and CLICK Sign in.
    if (manual) {
      console.log('  >> Açılan pencerede reCAPTCHA’yı işaretle. Token gelince otomatik giriş yapılır (3 dk).');
      const deadline = Date.now() + 180_000;
      let clicked = false;
      while (Date.now() < deadline && !/\/rn\/users\//.test(page.url())) {
        const resp = await page.evaluate(() => { const t = document.getElementById('g-recaptcha-response'); return t ? t.value : ''; }).catch(() => '');
        if (!clicked && resp && resp.length > 30) { clicked = true; await page.click('#in_signin_button').catch(() => {}); }
        await page.waitForTimeout(1000);
      }
    } else {
      const token = await solveRecaptcha(cfg.routenote.captcha);
      await page.evaluate((tok) => {
        window.grecaptcha = window.grecaptcha || {};
        grecaptcha.getResponse = () => tok; // satisfy the handler's validation
        let ta = document.getElementById('g-recaptcha-response');
        if (!ta) { ta = document.createElement('textarea'); ta.id = 'g-recaptcha-response'; ta.name = 'g-recaptcha-response'; ta.style.display = 'none'; (document.getElementById('user-login') || document.body).appendChild(ta); }
        ta.value = tok; // the field the POST actually carries
      }, token);
      await page.click('#in_signin_button');
    }

    try {
      await page.waitForURL(/\/rn\/users\//, { timeout: manual ? 5_000 : 30_000 });
    } catch {
      // Surface the actual on-page reason (wrong password vs. captcha vs. bot).
      const url = page.url();
      const msg = await page.evaluate(() => {
        const pick = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 300) : ''; };
        return pick('.messages.error') || pick('.error') || pick('.alert') || pick('.messages') || (document.body ? document.body.innerText.trim().replace(/\s+/g, ' ').slice(0, 300) : '');
      }).catch(() => '');
      throw new Error(`login başarısız — sayfa: ${url} | mesaj: ${msg || '(yok)'}`);
    }

    const cookies = await context.cookies();
    const obj = {};
    for (const c of cookies) if (/routenote\.com$/.test(c.domain.replace(/^\./, ''))) obj[c.name] = c.value;
    obj.FgPJ_PZbv_nMA ||= 'true';
    obj.okLj_8Sopq_07KmP ||= 'true';
    return CookieJar.from(obj);
  } finally {
    await browser.close();
  }
}

/** Load a saved session, verify it, and re-login (via the browser) if needed. */
export async function ensureSession(cfg) {
  const file = sessionFile(cfg);
  if (existsSync(file)) {
    try {
      const jar = CookieJar.from(JSON.parse(await readFile(file, 'utf8')));
      if (jar.size && (await isLoggedIn(cfg, jar))) return jar;
    } catch { /* fall through to login */ }
  }
  const jar = await browserLogin(cfg);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(jar.toJSON(), null, 2));
  return jar;
}

/**
 * Force a fresh browser login and update `jar` IN PLACE (so any in-flight caller
 * holding the same CookieJar instance sees the new cookies), persisting the new
 * session. Used to auto-recover when RouteNote drops the session mid-run.
 */
export async function refreshSession(cfg, jar) {
  const fresh = await browserLogin(cfg);
  jar.jar.clear();
  for (const [k, v] of fresh.jar) jar.jar.set(k, v);
  const file = sessionFile(cfg);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(jar.toJSON(), null, 2));
  return jar;
}

export { CookieJar, jarFetch };

// CLI:
//   node src/routenote.mjs login          -> otomatik (CapSolver) login
//   node src/routenote.mjs login-manual    -> reCAPTCHA'yı sen çöz (teşhis/yedek)
if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const cmd = process.argv[2] || 'login';
  const cfgPath = path.resolve(path.dirname(process.argv[1]), '../config/config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  cfg.paths = cfg.paths || {};
  if (cmd === 'login' || cmd === 'login-manual') {
    const manual = cmd === 'login-manual';
    if (manual) {
      // Bypass the saved-session/CapSolver path; do a fresh manual login.
      const jar = await browserLogin(cfg, { manual: true });
      const file = sessionFile(cfg);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(jar.toJSON(), null, 2));
      console.log('oturum kuruldu (manuel), cookie sayısı:', jar.size, '| logged-in:', await isLoggedIn(cfg, jar));
    } else {
      const jar = await ensureSession(cfg);
      console.log('oturum kuruldu, cookie sayısı:', jar.size, '| logged-in:', await isLoggedIn(cfg, jar));
    }
  }
}
