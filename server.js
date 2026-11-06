// Annotato: a tiny local server that opens any HTML mock with an annotation overlay,
// keeps the draft notes next to the mock, takes screenshots through Chrome and exports a
// feedback bundle for Claude. Node only, no packages.
//
//   node server.js [file.html | folder]          open a mock (starts the server in the background if needed)
//   node server.js http://localhost:5173 [project] review a running app (dev server); feedback goes to project/feedback
//   node server.js --serve                       run the server in this window (for debugging)

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = 4321;
const CDP_PORT = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TOOL = __dirname;
const WORK = path.join(TOOL, 'work');
const RECENT = path.join(WORK, 'recent.json');
const APPS = path.join(WORK, 'apps.json');
const FIRST_APP_PORT = 4322;
const LOG = path.join(WORK, 'server.log');
const IDLE_MS = 30 * 60 * 1000; // quit when no mock page has checked in for this long

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

fs.mkdirSync(WORK, { recursive: true });
const log = (...a) => { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {} };

/* ---------- Launcher side ---------- */

async function ping() {
  try { const r = await fetch(`${ORIGIN}/__cf/api/ping`); return r.ok; } catch { return false; }
}

async function launch(arg, project) {
  if (!(await ping())) {
    spawn(process.execPath, [__filename, '--serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 50 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const isUrl = /^https?:\/\//i.test(arg || '');
  const body = JSON.stringify(isUrl ? { url: arg, project: project ? path.resolve(project) : '' } : { file: arg ? path.resolve(arg) : '' });
  const r = await fetch(`${ORIGIN}/__cf/api/open`, { method: 'POST', body });
  const j = await r.json();
  if (j.error) { console.error(j.error); process.exitCode = 1; }
}

/* ---------- Mocks: which folders may be served ---------- */

// Each opened mock gets a short id for its root folder (its git repo, else its own folder), so
// relative links like ../../brand/tokens.css keep working. Only registered roots are served.
const roots = new Map(); // id -> root folder

function rootFor(file) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return path.dirname(file);
  }
}

function register(file) {
  const root = rootFor(file);
  const id = crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 8);
  roots.set(id, root);
  return `/m/${id}/` + path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/');
}

function readRecent() { try { return JSON.parse(fs.readFileSync(RECENT, 'utf8')); } catch { return []; } }

// Recent entries are { file } for mocks on disk or { app, project } for running apps.
const recentKey = (r) => (r.file || `${r.app} ${r.project}`).toLowerCase();
function rememberRecent(entry) {
  const list = readRecent().filter((r) => recentKey(r) !== recentKey(entry));
  list.unshift({ ...entry, at: new Date().toISOString() });
  fs.writeFileSync(RECENT, JSON.stringify(list.slice(0, 20), null, 2));
}
for (const r of readRecent()) if (r.file && fs.existsSync(r.file)) register(r.file);

function resolveTarget(p) {
  if (!p) return null;
  p = p.trim().replace(/^"|"$/g, '');
  if (!fs.existsSync(p)) return null;
  if (fs.statSync(p).isDirectory()) {
    if (isAppProject(p)) return { project: p };
    const idx = ['index.html', 'index.htm'].map((n) => path.join(p, n)).find((f) => fs.existsSync(f));
    if (idx) return idx;
    const any = fs.readdirSync(p).find((n) => /\.html?$/i.test(n));
    return any ? path.join(p, any) : null;
  }
  return /\.html?$/i.test(p) ? p : null;
}

// A folder with a package.json "dev" script is an app that has to run, not a page to open.
function isAppProject(dir) {
  try { return !!JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.dev; } catch { return false; }
}

// URL path (/m/<id>/<rel>) -> file on disk, or null if outside a registered root.
function fileFor(urlPath) {
  const m = /^\/m\/([0-9a-f]{8})(\/.*)$/.exec(urlPath);
  if (!m || !roots.has(m[1])) return null;
  const root = roots.get(m[1]);
  let rel;
  try { rel = decodeURIComponent(m[2]); } catch { return null; }
  const f = path.resolve(root, '.' + rel);
  if (f !== root && !f.startsWith(root + path.sep)) return null;
  return f;
}

// A link written from the site's top folder (/css/site.css) has no /m/<id>/ in it. Find the file by
// walking up from the page that asked for it (the Referer) to the mock's root.
function siteRootFile(urlPath, referer) {
  let ref;
  try { ref = new URL(referer); } catch { return null; }
  const page = fileFor(ref.pathname);
  if (!page) return null;
  const root = roots.get(ref.pathname.split('/')[2]);
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  for (let d = path.dirname(page); d === root || d.startsWith(root + path.sep); d = path.dirname(d)) {
    const f = path.resolve(d, '.' + rel);
    if (f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    if (d === root) break;
  }
  return null;
}

// Drafts and bundles live in a feedback/ folder: beside the mock's HTML file, or in a running app's project.
function feedbackPaths(pageUrl, ctx) {
  if (ctx && ctx.app) {
    const dir = path.join(ctx.app.project, 'feedback');
    return { label: `${ctx.app.url} (project ${ctx.app.project})`, dir, draft: path.join(dir, '_draft', 'app.json'), shots: path.join(dir, '_draft', 'app') };
  }
  const file = pageUrl && fileFor(new URL(pageUrl, ORIGIN).pathname);
  if (!file) return null;
  const dir = path.join(path.dirname(file), 'feedback');
  const base = path.basename(file).replace(/\.html?$/i, '');
  return { label: file, dir, draft: path.join(dir, '_draft', base + '.json'), shots: path.join(dir, '_draft', base) };
}

/* ---------- Chrome ---------- */

function findBrowser() {
  const L = process.env.LOCALAPPDATA || '', P = process.env.ProgramFiles || 'C:\\Program Files', X = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(P, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(X, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(L, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(X, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(P, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((f) => fs.existsSync(f));
}

function openWindow(url) {
  const exe = findBrowser();
  if (!exe) { execFile('cmd', ['/c', 'start', '', url]); return; }
  // Its own profile (no logins, no extensions) so the screenshot port is allowed and stays private.
  spawn(exe, [`--user-data-dir=${path.join(WORK, 'browser-profile')}`, `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000',
    // Keep drawing while the window is behind others, so screenshots never come back blank.
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--app=${url}`],
  { detached: true, stdio: 'ignore' }).unref();
}

// Screenshot of the visible page through the Chrome DevTools Protocol (built-in WebSocket).
async function screenshot(pageUrl, clip) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const t = targets.find((x) => x.type === 'page' && x.url === pageUrl) || targets.find((x) => x.type === 'page' && x.url.split('#')[0] === pageUrl.split('#')[0]);
  if (!t) throw new Error('page not found in the review browser');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  try {
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('could not connect to the browser')); });
    const reply = new Promise((ok, bad) => {
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) m.error ? bad(new Error(m.error.message)) : ok(m.result.data); };
      setTimeout(() => bad(new Error('screenshot timed out')), 8000);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 } } }));
    return Buffer.from(await reply, 'base64');
  } finally { ws.close(); }
}

/* ---------- Export ---------- */

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const clock = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const KIND = { pin: 'Pin', box: 'Box', arrow: 'Arrow', pen: 'Drawing', note: 'Sticky note' };

function describeMd(a) {
  const lines = [];
  const first = (a.comments[0] && a.comments[0].text.split('\n')[0]) || '(no comment, see the mark)';
  lines.push(`## ${a.num}. ${KIND[a.type] || a.type}: ${first.length > 90 ? first.slice(0, 87) + '...' : first}`, '');
  if (a.shot) lines.push(`![note ${a.num}](${a.shot})`, '');
  if (a.comments.length) {
    lines.push('Comments:');
    for (const c of a.comments) lines.push(`- (${clock(c.at)}) ${c.text.replace(/\n/g, '\n  ')}`);
    lines.push('');
  }
  const w = a.where || {};
  if (w.view) lines.push(`- View: ${w.view}`);
  if (w.anchor) lines.push(`- Element: \`${w.anchor}\`${w.nearOnly ? ' (the mark is on empty space near this element)' : ''}`);
  if (w.text) lines.push(`- Element text: "${w.text}"`);
  if (w.path) lines.push(`- Inside: ${w.path}`);
  if (w.under && w.under.length) lines.push(`- Also under the mark: ${w.under.map((u) => '`' + u + '`').join(', ')}`);
  if (w.selector) lines.push(`- Selector: \`${w.selector}\``);
  if (w.position) lines.push(`- Position: ${w.position}`);
  if (a.full) lines.push(`- Whole window when the note was made: [${a.full}](${a.full})`);
  lines.push('');
  return lines.join('\n');
}

function exportBundle(fp, meta) {
  const draft = JSON.parse(fs.readFileSync(fp.draft, 'utf8'));
  const list = (draft.notes || []).slice().sort((a, b) => a.num - b.num);
  if (!list.length) throw new Error('there are no notes to export');
  let name = stamp(new Date()), out = path.join(fp.dir, name);
  for (let i = 2; fs.existsSync(out); i++) out = path.join(fp.dir, `${name}-${i}`);
  fs.mkdirSync(out, { recursive: true });
  for (const a of list) {
    for (const [key, suffix] of [['shotFile', ''], ['fullFile', '-window']]) {
      const src = a[key] && path.join(fp.shots, a[key]);
      if (src && fs.existsSync(src)) {
        const dst = `${pad(a.num)}${suffix}.png`;
        fs.copyFileSync(src, path.join(out, dst));
        a[suffix ? 'full' : 'shot'] = dst;
      }
    }
  }
  const md = [
    `# Design feedback: ${meta.title || path.basename(fp.label)}`, '',
    `- Mock: \`${fp.label}\``,
    `- Exported: ${new Date().toLocaleString('en-GB')} · ${list.length} note${list.length === 1 ? '' : 's'}`,
    `- Window: ${meta.viewport || '?'}`, '',
    '> For Claude: these are the reviewer\'s notes on this design, made with Annotato.',
    '> Each note has a screenshot cropped around it (the reviewer\'s mark is drawn on it in purple with its number) and,',
    '> where saved, a picture of the whole window for orientation. "Element" and "Selector" point at the DOM element',
    '> the mark is attached to, as it was rendered when the note was made. Look at every screenshot, read the mock\'s',
    '> source to find each element, then act on all notes. Reply with a short list: note number, what you changed,',
    '> and any note you skipped or need the reviewer to decide.', '',
    ...list.map(describeMd),
  ].join('\n');
  fs.writeFileSync(path.join(out, 'feedback.md'), md);
  fs.writeFileSync(path.join(out, 'notes.json'), JSON.stringify({ mock: fp.label, exported: new Date().toISOString(), ...meta, notes: list }, null, 2));
  return { dir: out, md: path.join(out, 'feedback.md') };
}

/* ---------- HTTP ---------- */

let lastSeen = Date.now();

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok, bad) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 20e6) { bad(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { bad(e); } });
  });
}

// Add the overlay to a page, just before its last </body>.
function injectOverlay(html) {
  const tag = '<script src="/__cf/overlay.js" defer></script>';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag + '</body>') : html + tag;
}

function serveStatic(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html' || ext === '.htm') return send(res, 200, injectOverlay(fs.readFileSync(file, 'utf8')), TYPES[ext]);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

// Open a Windows file or folder picker in front of everything; resolves to a path or ''.
function pick(kind) {
  const dialog = kind === 'folder'
    ? `$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the app''s project folder (feedback is saved there)'; $d.UseDescriptionForTitle = $true; if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`
    : `$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = 'Choose a mock to review'; $d.Filter = 'Web pages (*.html)|*.html;*.htm'; if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.FileName) }`;
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; ${dialog}`;
  return new Promise((ok) => execFile('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true }, (e, out) => ok((out || '').trim())));
}

/* ---------- Running apps: a proxy in front of the dev server ---------- */

// Dev servers load everything from the site root (/src/main.tsx, /@vite/client), so each app gets
// its own port where it sits at the root. Requests go through to the dev server unchanged, HTML
// pages get the overlay added, and the dev server's live-reload connection is passed through.
const apps = new Map(); // port -> { url, project, port }
const appOrigin = (a) => `http://127.0.0.1:${a.port}`;
function readApps() { try { return JSON.parse(fs.readFileSync(APPS, 'utf8')); } catch { return []; } }

function localUrl(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && /^(localhost|127\.0\.0\.1|\[::1\]|[\w.-]+\.localhost)$/i.test(x.hostname) ? x : null; } catch { return null; }
}

function registerApp(url, project) {
  const target = localUrl(url);
  const saved = readApps();
  let a = saved.find((x) => x.url === target.origin && x.project.toLowerCase() === project.toLowerCase());
  if (!a) {
    a = { url: target.origin, project, port: Math.max(FIRST_APP_PORT - 1, ...saved.map((x) => x.port)) + 1 };
    fs.writeFileSync(APPS, JSON.stringify([...saved, a], null, 2));
  }
  if (!apps.has(a.port)) startProxy(a);
  return appOrigin(a) + target.pathname + target.search;
}

function notRunning(a) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Waiting for the app</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0a0a0a;color:#ededed;font:15px/1.5 'Segoe UI',system-ui,sans-serif">
<div style="max-width:520px;padding:24px"><h1 style="font-size:20px;margin:0 0 8px">The app isn't running yet</h1>
<p style="color:#8f8f8f;margin:0">Nothing answers at <b style="color:#ededed">${a.url}</b>. Start it (usually <code>npm run dev</code> in ${a.project.replace(/&/g, '&amp;').replace(/</g, '&lt;')}, or ask Claude to start it). This page retries every few seconds.</p></div>`;
}

function startProxy(a) {
  const target = new URL(a.url), mine = appOrigin(a);
  const lib = target.protocol === 'https:' ? https : http;
  const fixHeaders = (h) => {
    const out = { ...h, host: target.host };
    if (out.origin) out.origin = target.origin;
    if (out.referer) out.referer = out.referer.replace(mine, target.origin);
    return out;
  };
  const srv = http.createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${a.port}` && req.headers.host !== `localhost:${a.port}`) return send(res, 403, 'Forbidden', 'text/plain');
    const url = new URL(req.url, mine);
    if (url.pathname.startsWith('/__cf/')) return handleTool(req, res, url, { app: a, origin: mine });
    lastSeen = Date.now();
    const headers = fixHeaders(req.headers);
    delete headers['accept-encoding']; // plain text back, so the overlay can be added to HTML
    const preq = lib.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers, rejectUnauthorized: false }, (pres) => {
      const h = { ...pres.headers };
      if (h.location) h.location = h.location.replace(target.origin, mine);
      if (!String(h['content-type'] || '').includes('text/html')) { res.writeHead(pres.statusCode, h); return pres.pipe(res); }
      const parts = [];
      pres.on('data', (c) => parts.push(c));
      pres.on('end', () => {
        delete h['content-length']; delete h['transfer-encoding']; delete h['content-security-policy'];
        res.writeHead(pres.statusCode, h);
        res.end(injectOverlay(Buffer.concat(parts).toString('utf8')));
      });
    });
    preq.on('error', () => { if (!res.headersSent) send(res, 502, notRunning(a), TYPES['.html']); });
    req.pipe(preq);
  });
  srv.on('upgrade', (req, sock, head) => { // live reload (WebSocket): pass it straight through
    const up = net.connect(+target.port || (target.protocol === 'https:' ? 443 : 80), target.hostname, () => {
      const h = fixHeaders(req.headers);
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  srv.on('error', (e) => log('proxy error', a.port, e.message));
  srv.listen(a.port, '127.0.0.1', () => log('app', a.url, 'on', mine));
  apps.set(a.port, a);
}

/* ---------- Tool API (on the main port and on every app port) ---------- */

function recentRows() {
  return readRecent().filter((r) => (r.file ? fs.existsSync(r.file) : r.project && fs.existsSync(r.project))).map((r) => {
    const fp = r.file ? feedbackPaths(register(r.file)) : feedbackPaths(null, { app: { url: r.app, project: r.project } });
    let notes = 0, bundles = [];
    try { notes = (JSON.parse(fs.readFileSync(fp.draft, 'utf8')).notes || []).length; } catch {}
    try { bundles = fs.readdirSync(fp.dir).filter((n) => /^\d{4}-\d\d-\d\d-\d{4}/.test(n)).sort(); } catch {}
    return { ...r, url: r.file ? register(r.file) : null, notes, lastExport: bundles.pop() || null };
  });
}

async function openTarget(b) {
  if (b.url) {
    if (!localUrl(b.url)) return { error: 'Only apps running on this computer (localhost) can be reviewed.' };
    if (!b.project || !fs.existsSync(b.project) || !fs.statSync(b.project).isDirectory()) return { needProject: true, url: b.url };
    rememberRecent({ app: localUrl(b.url).origin, project: b.project });
    return { ok: true, url: registerApp(b.url, b.project) };
  }
  const t = resolveTarget(b.file);
  if (!t) return { error: `Not an HTML file or a folder with one: ${b.file}` };
  if (t.project) return { needUrl: true, project: t.project };
  rememberRecent({ file: t });
  return { ok: true, url: ORIGIN + register(t) };
}

const api = {
  'GET /__cf/api/ping': () => ({ ok: true }),
  // From the launcher: open a window on the mock, the app, or the home page when something is missing.
  'POST /__cf/api/open': async (b) => {
    if (!b.file && !b.url) { openWindow(ORIGIN + '/'); return { ok: true }; }
    const r = await openTarget(b);
    if (r.ok) openWindow(r.url);
    else if (r.needUrl) openWindow(`${ORIGIN}/?project=${encodeURIComponent(r.project)}`);
    else if (r.needProject) openWindow(`${ORIGIN}/?url=${encodeURIComponent(r.url)}`);
    return r;
  },
  // From the home page: same, but it navigates itself.
  'POST /__cf/api/go': (b) => openTarget(b),
  'POST /__cf/api/pick': async (b) => ({ path: await pick(b.kind) }),
  'GET /__cf/api/recent': () => recentRows(),
  'GET /__cf/api/draft': (b, q, fp) => { try { return JSON.parse(fs.readFileSync(fp.draft, 'utf8')); } catch { return { notes: [] }; } },
  'PUT /__cf/api/draft': (b, q, fp) => {
    fs.mkdirSync(path.dirname(fp.draft), { recursive: true });
    fs.writeFileSync(fp.draft + '.tmp', JSON.stringify(b, null, 1));
    fs.renameSync(fp.draft + '.tmp', fp.draft);
    return { ok: true };
  },
  'POST /__cf/api/capture': async (b, q, fp) => {
    fs.mkdirSync(fp.shots, { recursive: true });
    const id = String(b.id).replace(/[^\w-]/g, '');
    fs.writeFileSync(path.join(fp.shots, id + '.png'), await screenshot(b.href, b.clip));
    let full = null;
    if (b.full) { fs.writeFileSync(path.join(fp.shots, id + '-window.png'), await screenshot(b.href, b.full)); full = id + '-window.png'; }
    return { ok: true, shotFile: id + '.png', fullFile: full };
  },
  'POST /__cf/api/export': (b, q, fp) => exportBundle(fp, b),
  'POST /__cf/api/clear': (b, q, fp) => {
    // Only after an export: the notes and screenshots are already copied into the bundle.
    fs.rmSync(fp.draft, { force: true });
    fs.rmSync(fp.shots, { recursive: true, force: true });
    return { ok: true };
  },
  'POST /__cf/api/copy': (b) => {
    const p = execFile('clip', { windowsHide: true });
    p.stdin.end(Buffer.from('﻿' + String(b.text || ''), 'utf16le'));
    return { ok: true };
  },
  'POST /__cf/api/reveal': (b, q, fp) => {
    const dir = b.dir && path.resolve(b.dir);
    if (dir && dir.startsWith(fp.dir)) execFile('explorer', [dir]);
    return { ok: true };
  },
};
const NEEDS_PAGE = /\/(draft|capture|export|clear|reveal|shot)$/;
const MAIN_ONLY = /\/(open|go|pick|recent)$/;

async function handleTool(req, res, url, ctx) {
  // Only our own pages may change things (blocks posts from other websites).
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== ctx.origin) return send(res, 403, 'Forbidden', 'text/plain');
  lastSeen = Date.now();
  try {
    if (url.pathname === '/__cf/overlay.js') return send(res, 200, fs.readFileSync(path.join(TOOL, 'overlay.js')), TYPES['.js']);
    if (MAIN_ONLY.test(url.pathname) && ctx.app) return send(res, 404, 'Not found', 'text/plain');
    const fp = NEEDS_PAGE.test(url.pathname) ? feedbackPaths(url.searchParams.get('page'), ctx) : null;
    if (NEEDS_PAGE.test(url.pathname) && !fp) return send(res, 404, { error: 'unknown page' });
    if (url.pathname === '/__cf/api/shot') { // thumbnails for the notes list
      const f = path.join(fp.shots, path.basename(url.searchParams.get('f') || ''));
      return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), 'image/png') : send(res, 404, 'Not found', 'text/plain');
    }
    const fn = api[`${req.method} ${url.pathname}`];
    if (!fn) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, await fn(req.method === 'GET' ? {} : await readBody(req), url.searchParams, fp));
  } catch (e) {
    log('error', req.method, url.pathname, e.stack || e);
    send(res, 500, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  // Only answer to ourselves: blocks other websites reaching in through DNS tricks.
  if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) return send(res, 403, 'Forbidden', 'text/plain');
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.startsWith('/__cf/')) return handleTool(req, res, url, { origin: ORIGIN });
  lastSeen = Date.now();
  if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(TOOL, 'home.html')), TYPES['.html']);
  const file = fileFor(url.pathname) || siteRootFile(url.pathname, req.headers.referer);
  if (!file) return send(res, 404, 'Not found', 'text/plain');
  serveStatic(res, file);
});

if (process.argv[2] === '--serve') {
  server.listen(PORT, '127.0.0.1', () => log('listening on', ORIGIN));
  server.on('error', (e) => { log('server error', e.message); process.exit(1); });
  for (const a of readApps()) if (fs.existsSync(a.project)) startProxy(a);
  setInterval(() => { if (Date.now() - lastSeen > IDLE_MS) { log('idle, quitting'); process.exit(0); } }, 60000);
} else {
  launch(process.argv[2], process.argv[3]).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
