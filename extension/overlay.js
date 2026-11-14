// Annotato overlay: injected into mock pages by server.js, and into localhost apps by the Chrome
// extension (as a content script, talking to the server through the extension's background).
// Marks are attached to the DOM element under them (position relative to that element's box),
// so they follow any zoom, pan or scroll the mock does. Everything lives in a shadow root so
// the mock's CSS and ours never mix.
(() => {
  // Once per page: the server may have injected it already, and the extension's toggle re-runs this file.
  if (window.top !== window || window.__annotato || document.querySelector('annotato-overlay')) return;
  window.__annotato = true;

  const EXT = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  const SERVER = 'http://127.0.0.1:4321';
  const enc = encodeURIComponent;
  const params = () => `page=${enc(location.pathname)}` + (EXT ? `&origin=${enc(location.origin)}` : '');
  const call = async (method, p, body) => {
    const url = `/__cf/api/${p}` + (p === 'ping' ? '' : `?${params()}`);
    let j;
    if (EXT) j = await chrome.runtime.sendMessage({ type: 'annotato-api', method, url, body });
    else j = await (await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) })).json();
    if (!j) throw new Error('no answer from Annotato');
    if (j.error) throw new Error(j.error);
    return j;
  };
  const shotUrl = (f) => f && `${EXT ? SERVER : ''}/__cf/api/shot?${params()}&f=${enc(f)}`;

  const KIND = { pin: 'Pin', box: 'Box', arrow: 'Arrow', pen: 'Drawing', note: 'Sticky note' };
  const TOOLS = [
    ['browse', 'V', 'Browse: use the mock normally', '<path d="M4 4l7 17 2.5-7.5L21 11z"/>'],
    ['pin', 'C', 'Pin: click to comment on a spot', '<path d="M21 11.5a8.4 8.4 0 0 1-12.8 7.2L3 21l2.3-5.2A8.4 8.4 0 1 1 21 11.5z"/>'],
    ['box', 'B', 'Box: drag around an area', '<rect x="4" y="5" width="16" height="14" rx="2"/>'],
    ['arrow', 'A', 'Arrow: drag from where to where', '<path d="M5 19L19 5M10 5h9v9"/>'],
    ['pen', 'P', 'Pen: draw freehand (strokes join until you comment)', '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'],
    ['note', 'N', 'Sticky note: click to place a note', '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>'],
  ];
  const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const EYE = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
  const EYE_OFF = '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';
  const SEND = '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>';
  const LIST = '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>';

  const S = { notes: [], mode: 'browse', hidden: false, panel: false, edit: null, lastExport: null, shots: true, space: false, flash: null };

  /* ---------- Shadow root and styles ---------- */

  const host = document.createElement('annotato-overlay');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
:host { all: initial; }
* { box-sizing: border-box; }
.ui { --bg:#0a0a0a; --surface:#111; --raised:#171717; --faint:#1c1c1c; --line:#222; --line-strong:#333; --fg:#ededed; --muted:#8f8f8f; --subtle:#5f5f5f;
  --mark:#8b5cf6; --mark-ink:#fff; --sticky:#fde68a; --r1:6px; --r2:8px; --r3:12px; --ease:cubic-bezier(0.23,1,0.32,1);
  --shadow:0 8px 28px rgba(0,0,0,.45),0 0 0 1px #333;
  font: 400 14px/1.45 "Geist", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: var(--fg); font-variant-numeric: tabular-nums; }
.ui button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
svg.marks { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; overflow: visible; }
.catch { position: fixed; inset: 0; pointer-events: none; cursor: crosshair; }
.catch.on { pointer-events: auto; }
.badges { position: fixed; inset: 0; pointer-events: none; }
.ui .badge { position: absolute; pointer-events: auto; cursor: pointer; display: grid; place-items: center; min-width: 24px; height: 24px; padding: 0 6px;
  border-radius: 12px; background: var(--mark); color: var(--mark-ink); font: 600 12px/1 inherit; font-family: inherit; box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.35);
  transform: translate(-50%, -50%); }
.ui .badge.pin { border-radius: 12px 12px 12px 2px; transform: translate(0, -100%); min-width: 28px; height: 28px; font-size: 13px; }
.ui .badge.sel, .sticky.sel { box-shadow: 0 0 0 2px #fff, 0 0 0 5px var(--mark); }
.ui .badge.flash, .sticky.flash { animation: flash 900ms var(--ease); }
@keyframes flash { 0%,60% { box-shadow: 0 0 0 2px #fff, 0 0 0 14px rgba(139,92,246,.45); } }
.sticky { position: absolute; transform-origin: 0 0; pointer-events: auto; cursor: pointer; width: 220px; padding: 10px 12px; border-radius: 4px; background: var(--sticky); color: #1c1917;
  font-size: 13px; line-height: 1.4; box-shadow: 0 0 0 2px #fff, 0 6px 16px rgba(0,0,0,.25); white-space: pre-wrap; overflow-wrap: anywhere; }
.sticky b { display: inline-grid; place-items: center; min-width: 20px; height: 20px; margin-right: 6px; border-radius: 10px; background: var(--mark); color: #fff; font-size: 11px; }
.sticky i { color: #78716c; }
.bar { position: fixed; left: 16px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px; pointer-events: auto;
  background: var(--raised); border-radius: var(--r3); box-shadow: var(--shadow); }
.bar .t { position: relative; display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--r2); color: var(--muted); }
.bar .t:hover { background: var(--faint); color: var(--fg); }
.bar .t.on { background: var(--mark); color: #fff; }
.bar .t svg { width: 18px; height: 18px; }
.bar .sep { width: 24px; height: 1px; background: var(--line-strong); margin: 4px 0; }
.bar .count { position: relative; display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--r2); color: var(--muted); }
.bar .count .cn { position: absolute; top: 1px; right: 0; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--mark); color: #fff; font-size: 10px; font-weight: 600; line-height: 16px; text-align: center; }
.bar .count .cn:empty { display: none; }
.bar .export { width: 36px; padding: 0; display: grid; place-items: center; }
.bar .export svg { width: 18px; height: 18px; }
.bar .count:hover, .bar .count.on { background: var(--faint); color: var(--fg); }
.bar .count svg { width: 18px; height: 18px; }
.primary { height: 36px; padding: 0 14px; border-radius: var(--r2); background: #ededed !important; color: #0a0a0a !important; font-weight: 500 !important; white-space: nowrap; }
.primary:hover { background: #fff !important; }
.primary:disabled { opacity: .4; cursor: default; }
.ghost { height: 32px; padding: 0 10px; border-radius: var(--r2); color: var(--muted) !important; font-weight: 500; white-space: nowrap; }
.ghost:hover { background: var(--faint) !important; color: var(--fg) !important; }
.ghost.danger:hover { color: #f87171 !important; }
.tip { position: fixed; pointer-events: none; padding: 6px 10px; border-radius: var(--r1); background: var(--raised); box-shadow: var(--shadow); font-size: 13px; white-space: nowrap; opacity: 0; transition: opacity 120ms; }
.tip.show { opacity: 1; }
.tip kbd { margin-left: 8px; font: 12px "Geist Mono", Consolas, monospace; color: var(--muted); }
.panel { position: fixed; top: 16px; right: 16px; bottom: 16px; width: 340px; display: flex; flex-direction: column; pointer-events: auto;
  background: var(--surface); border-radius: var(--r3); box-shadow: var(--shadow); }
.panel[hidden] { display: none; }
.ph { display: flex; align-items: center; gap: 8px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--line); }
.ph h2 { margin: 0; flex: 1; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.ph span { color: var(--subtle); font-weight: 400; }
.list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.empty { padding: 16px 8px; color: var(--muted); }
.empty p { margin: 0 0 8px; }
.item { display: grid; grid-template-columns: 24px 1fr; gap: 4px 10px; width: 100%; padding: 10px 8px; border-radius: var(--r2); text-align: left; }
.item:hover { background: var(--raised) !important; }
.item.sel { background: var(--faint) !important; }
.item .n { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 12px; background: var(--mark); color: #fff; font-size: 12px; font-weight: 600; }
.item .txt { min-width: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.item .meta { grid-column: 2; color: var(--subtle); font-size: 12px; }
.item .meta.off { color: var(--muted); }
.item .meta.noshot, .item .meta.noshot.off { color: #f5b544; }
.warn { padding: 8px 10px; border-radius: var(--r2); background: rgba(245,181,68,.12); color: #f5b544; font-size: 13px; }
.warn[hidden] { display: none; }
.item img { grid-column: 2; max-width: 100%; max-height: 90px; justify-self: start; border-radius: var(--r1); box-shadow: 0 0 0 1px var(--line-strong); }
.pf { padding: 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
.pf:empty { display: none; }
.pf .row { display: flex; align-items: center; gap: 8px; }
.pf .hint { flex: 1; color: var(--subtle); font-size: 12px; }
.done { padding: 12px; border-radius: var(--r2); background: var(--raised); font-size: 13px; }
.done b { font-weight: 600; }
.done code { font: 12px "Geist Mono", Consolas, monospace; color: var(--muted); overflow-wrap: anywhere; }
.done .row { margin-top: 8px; flex-wrap: wrap; gap: 4px; }
.editor { position: fixed; width: 320px; pointer-events: auto; background: var(--raised); border-radius: var(--r3); box-shadow: var(--shadow); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.editor[hidden] { display: none; }
.eh { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.eh .n { display: grid; place-items: center; min-width: 22px; height: 22px; border-radius: 11px; background: var(--mark); color: #fff; font-size: 12px; font-weight: 600; }
.eh .grow { flex: 1; }
.eh .x { width: 28px; height: 28px; border-radius: var(--r1); color: var(--muted); font-size: 18px; line-height: 1; }
.eh .x:hover { background: var(--faint); color: var(--fg); }
.thread { display: flex; flex-direction: column; gap: 6px; max-height: 40vh; overflow-y: auto; }
.c { padding: 8px 10px; border-radius: var(--r2); background: var(--faint); white-space: pre-wrap; overflow-wrap: anywhere; outline: none; }
.c:focus { box-shadow: 0 0 0 1px var(--line-strong); }
.c small { display: block; color: var(--subtle); font-size: 11px; margin-top: 2px; user-select: none; }
textarea { width: 100%; min-height: 64px; max-height: 40vh; resize: vertical; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: var(--r2);
  background: var(--surface); color: var(--fg); font: inherit; outline: none; field-sizing: content; }
textarea:focus { border-color: #555; }
.ea { display: flex; align-items: center; gap: 4px; }
.ea .grow { flex: 1; }
.ea .primary { height: 32px; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: min(560px, calc(100vw - 32px)); padding: 10px 14px; border-radius: var(--r2);
  background: var(--raised); box-shadow: var(--shadow); pointer-events: none; opacity: 0; transition: opacity 160ms; }
.toast.show { opacity: 1; }
.shooting .bar, .shooting .panel, .shooting .editor, .shooting .toast, .shooting .tip { opacity: 0 !important; transition: none !important; }
.nomarks svg.marks, .nomarks .badges { display: none; }
</style>
<div class="ui">
  <svg class="marks"></svg>
  <div class="catch"></div>
  <div class="badges"></div>
  <div class="panel" hidden>
    <div class="ph"><h2>Notes <span class="pc"></span></h2><button class="ghost close-panel" title="Close (L)">Close</button></div>
    <div class="list"></div>
    <div class="pf"></div>
  </div>
  <div class="editor" hidden></div>
  <div class="bar">
    ${TOOLS.map(([m, k, label, d]) => `<button class="t" data-mode="${m}" data-tip="${label}" data-key="${k}">${ICON(d)}</button>`).join('')}
    <span class="sep"></span>
    <button class="t hide" data-tip="Hide or show marks" data-key="H">${ICON(EYE)}</button>
    <button class="count" data-tip="List of notes" data-key="L">${ICON(LIST)}<span class="cn">0</span></button>
    <span class="sep"></span>
    <button class="primary export" data-tip="Export for Claude: writes every note and screenshot to the mock's feedback folder">${ICON(SEND)}</button>
  </div>
  <div class="tip"></div>
  <div class="toast"></div>
</div>`;
  const $ = (s) => root.querySelector(s);
  const ui = $('.ui'), svg = $('svg.marks'), catchEl = $('.catch'), badges = $('.badges'), panel = $('.panel'), editor = $('.editor'), tip = $('.tip'), toastEl = $('.toast');

  /* ---------- Small helpers ---------- */

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  let toastT;
  function toast(msg, ms = 3500) {
    toastEl.innerHTML = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
  const vpArea = () => innerWidth * innerHeight;

  // Hit testing that ignores our own layer.
  const hits = (x, y) => document.elementsFromPoint(x, y).filter((e) => e !== host && e !== document.documentElement);

  // Deepest element whose box contains the point, even inside inert or pointer-events:none areas.
  function deepest(el, x, y) {
    for (let guard = 0; guard < 60; guard++) {
      let next = null;
      for (const c of el.children) {
        if (c === host || /^(SCRIPT|STYLE|TEMPLATE)$/.test(c.tagName)) continue;
        const r = c.getBoundingClientRect();
        const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        if ((inside && r.width * r.height > 0) || (r.width === 0 && r.height === 0 && c.children.length && getComputedStyle(c).display === 'contents')) {
          if (getComputedStyle(c).visibility !== 'hidden') next = c;
        }
      }
      if (!next) return el;
      el = next;
    }
    return el;
  }
  const elementAt = (x, y) => { const h = hits(x, y)[0]; return h ? deepest(h, x, y) : document.body; };

  // Zoomable canvases move their content with a CSS transform. A mark on the canvas background
  // (outside the transformed layer) would not follow zoom and pan, so it is attached to the nearest
  // element inside that layer instead. Ordinary pages need none of this: their elements scroll as one.
  const transformed = (e) => getComputedStyle(e).transform !== 'none';
  function insideTransform(el) {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) if (transformed(e)) return true;
    return false;
  }
  function nearest(container, x, y) {
    const all = [...container.querySelectorAll('*')].slice(0, 6000);
    const layers = all.filter((e) => e !== host && transformed(e));
    const pool = layers.length ? layers.flatMap((l) => [...l.querySelectorAll('*')]) : all;
    let best = null, bd = Infinity;
    for (const e of pool) {
      if (e === host) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue;
      const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = dx * dx + dy * dy - Math.min(r.width * r.height, 1e6) * 1e-9; // ties: prefer the bigger box
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function anchorFor(box) { // box: {x, y, w, h} in screen px; returns { el, near }
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    let el = elementAt(cx, cy);
    while (el.parentElement && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.left <= box.x + 4 && r.top <= box.y + 4 && r.right >= box.x + box.w - 4 && r.bottom >= box.y + box.h - 4) break;
      el = el.parentElement;
    }
    const r = el.getBoundingClientRect();
    const background = !insideTransform(el) && [...el.querySelectorAll('*')].slice(0, 6000).some(transformed);
    if (background || r.width < 2 || r.height < 2) {
      const n = nearest(el, cx, cy);
      if (n) { const nr = n.getBoundingClientRect(); return { el: n, near: !(nr.left <= cx && nr.right >= cx && nr.top <= cy && nr.bottom >= cy) }; }
    }
    return { el, near: false };
  }

  const fingerprint = (el) => el.tagName + '|' + squash(el.textContent).slice(0, 80) + '|' + (el.getAttribute('src') || el.getAttribute('href') || '') + '|' + el.childElementCount;
  const cssStr = (v) => '"' + v.replace(/["\\]/g, '\\$&') + '"';
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };

  function selectorFor(el) {
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const tag = e.tagName.toLowerCase();
      if (e === document.body) { parts.unshift('body'); break; }
      if (e.id && unique('#' + CSS.escape(e.id))) { parts.unshift('#' + CSS.escape(e.id)); break; }
      const da = [...e.attributes].find((a) => a.name.startsWith('data-') && a.value && a.value.length < 60 && unique(`${tag}[${a.name}=${cssStr(a.value)}]`));
      if (da) { parts.unshift(`${tag}[${da.name}=${cssStr(da.value)}]`); break; }
      parts.unshift(`${tag}:nth-child(${[...e.parentElement.children].indexOf(e) + 1})`);
    }
    return parts.join(' > ');
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = [...el.classList].slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    for (const a of [...el.attributes].filter((a) => a.name.startsWith('data-')).slice(0, 2)) s += `[${a.name}="${a.value.slice(0, 40)}"]`;
    const src = el.getAttribute('src'); if (src) s += ` src=${src.split('/').pop().slice(0, 50)}`;
    const al = el.getAttribute('aria-label') || el.getAttribute('alt'); if (al) s += ` "${al.slice(0, 40)}"`;
    return s;
  }
  function pathOf(el) {
    const out = [];
    for (let e = el.parentElement; e && e !== document.body && out.length < 6; e = e.parentElement) {
      if (e.id || e.classList.length || [...e.attributes].some((a) => a.name.startsWith('data-'))) out.unshift(describe(e));
    }
    return out.join(' › ');
  }
  function viewInfo() {
    const bits = [document.title];
    if (!location.pathname.startsWith('/m/')) bits.push('page ' + location.pathname + location.search); // a running app: which route
    if (location.hash) bits.push(location.hash);
    try { if (typeof window.cfContext === 'function') bits.push(String(window.cfContext())); } catch {}
    bits.push(`window ${innerWidth}×${innerHeight}`);
    return bits.filter(Boolean).join(' · ');
  }

  /* ---------- Geometry: notes store points relative to their anchor's box ---------- */

  function resolve(a, now) {
    if (!a._el || !a._el.isConnected) {
      let el = null;
      try { el = document.querySelector(a.anchor.selector); } catch {}
      a._el = el; a._fpAt = 0;
    }
    if (a._el && now - (a._fpAt || 0) > 600) { a._ok = fingerprint(a._el) === a.anchor.fp; a._fpAt = now; }
    return a._el && a._ok ? a._el : null;
  }
  const toScreen = (r, p) => [r.left + p[0] * r.width, r.top + p[1] * r.height];
  const toLocal = (r, p) => [(p[0] - r.left) / r.width, (p[1] - r.top) / r.height];

  function bboxOf(strokes) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of strokes) for (const [x, y] of s) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // Screen geometry for every note this frame (null when its element is gone, hidden or covered).
  let frame = 0;
  function layoutNote(a, now) {
    const el = resolve(a, now);
    if (!el) return (a._vis = false, null);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return (a._vis = false, null);
    const strokes = a.strokes.map((s) => s.map((p) => toScreen(r, p)));
    const b = bboxOf(strokes);
    const px = b.x + b.w / 2, py = b.y + b.h / 2;
    const onScreen = px >= -50 && py >= -50 && px <= innerWidth + 50 && py <= innerHeight + 50;
    if (!onScreen) return (a._vis = false, null);
    if (a._vis === undefined || (frame + a.num) % 6 === 0) {
      const top = px >= 0 && py >= 0 && px < innerWidth && py < innerHeight ? hits(px, py)[0] : null;
      a._vis = !top || top === el || el.contains(top) || top.contains(el);
    }
    return a._vis ? { strokes, b, zoom: a.anchor.w0 ? r.width / a.anchor.w0 : 1 } : null;
  }

  /* ---------- Drawing ---------- */

  const line = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  function shapeSvg(type, strokes, sel) {
    const w = sel ? 4 : 3;
    const paint = (d, extra = '') => `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w + 3}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>` +
      `<path d="${d}" fill="none" stroke="#8b5cf6" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
    if (type === 'box') {
      const [[x1, y1], [x2, y2]] = strokes[0];
      const x = Math.min(x1, x2), y = Math.min(y1, y2), bw = Math.abs(x2 - x1), bh = Math.abs(y2 - y1);
      return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="4" fill="rgba(139,92,246,.08)"/>` + paint(`M${x} ${y}h${bw}v${bh}h${-bw}z`);
    }
    if (type === 'arrow') {
      const [[x1, y1], [x2, y2]] = strokes[0];
      const ang = Math.atan2(y2 - y1, x2 - x1), L = 16;
      const h1 = [x2 - L * Math.cos(ang - 0.45), y2 - L * Math.sin(ang - 0.45)], h2 = [x2 - L * Math.cos(ang + 0.45), y2 - L * Math.sin(ang + 0.45)];
      return paint(`M${x1} ${y1}L${x2} ${y2}M${h1[0]} ${h1[1]}L${x2} ${y2}L${h2[0]} ${h2[1]}`);
    }
    if (type === 'pen') return strokes.map((s) => paint(s.length > 1 ? line(s) : `M${s[0][0]} ${s[0][1]}h0.1`)).join('');
    return '';
  }

  let lastSvg = '', lastBadges = '';
  function render() {
    frame++;
    const now = performance.now();
    let svgOut = '', badgeOut = '';
    for (const a of S.notes) {
      const g = layoutNote(a, now);
      a._g = g;
      if (!g) continue;
      const sel = S.edit && S.edit.id === a.id, fl = S.flash === a.id ? ' flash' : '';
      svgOut += shapeSvg(a.type, g.strokes, sel);
      const [x, y] = g.strokes[0][0];
      if (a.type === 'note') {
        const t = a.comments.length ? esc(a.comments.map((c) => c.text).join('\n')) : '<i>Empty note</i>';
        const z = Math.max(0.3, Math.min(1, g.zoom)).toFixed(3); // shrink with the canvas, never grow
        badgeOut += `<div class="sticky${sel ? ' sel' : ''}${fl}" data-id="${a.id}" style="left:${x}px;top:${y}px;transform:scale(${z})"><b>${a.num}</b>${t}</div>`;
      } else {
        let bx = x, by = y;
        if (a.type === 'box') { bx = Math.min(g.strokes[0][0][0], g.strokes[0][1][0]); by = Math.min(g.strokes[0][0][1], g.strokes[0][1][1]); }
        badgeOut += `<button class="badge ${a.type}${sel ? ' sel' : ''}${fl}" data-id="${a.id}" style="left:${bx}px;top:${by}px" title="${esc(KIND[a.type])} ${a.num}">${a.num}</button>`;
      }
    }
    if (draft) svgOut += shapeSvg(draft.type, draft.strokes, true);
    if (svgOut !== lastSvg) { svg.innerHTML = svgOut; lastSvg = svgOut; }
    if (badgeOut !== lastBadges) { badges.innerHTML = badgeOut; lastBadges = badgeOut; }
    if (frame % 15 === 0) updateVisibilityLabels();
    requestAnimationFrame(render);
  }

  /* ---------- Saving ---------- */

  let saveT, saving = Promise.resolve();
  const clean = (a) => Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('_')));
  function save(now) {
    clearTimeout(saveT);
    const run = () => (saving = saving.then(() => call('PUT', 'draft', { version: 1, notes: S.notes.map(clean), lastExport: S.lastExport })
      .catch((e) => toast('Could not save notes: ' + esc(e.message), 6000))));
    if (now) return run();
    saveT = setTimeout(run, 400);
  }

  /* ---------- Screenshots ---------- */

  // Screenshot for a note, best source first:
  //  1. the extension: Chrome's own capture of the tab;
  //  2. Annotato's own Chrome window (the server asks it over its debugging port);
  //  3. otherwise the page draws the area itself (modern-screenshot), so any browser works.
  // If all fail, the note keeps the reason and says so in the list, the note and feedback.md.
  async function capture(a) {
    await raf(); await raf();
    const g = a._g || layoutNote(a, performance.now());
    if (!g) return;
    let { x, y, w, h } = g.b;
    if (a.type === 'note') { w = Math.max(w, 230); h = Math.max(h, 120); }
    if (a.type === 'pin') { y -= 30; h += 30; w += 30; }
    const cw = Math.min(innerWidth, Math.max(w + 320, 720)), ch = Math.min(innerHeight, Math.max(h + 320, 450));
    const cx = Math.min(Math.max(x + w / 2 - cw / 2, 0), innerWidth - cw), cy = Math.min(Math.max(y + h / 2 - ch / 2, 0), innerHeight - ch);
    const clip = { x: Math.round(cx), y: Math.round(cy), width: Math.round(cw), height: Math.round(ch) };
    const why = [];
    let r = null;
    ui.classList.add('shooting');
    await raf(); await raf();
    try {
      if (EXT) {
        const shot = await chrome.runtime.sendMessage({ type: 'annotato-capture', clip, vw: innerWidth });
        if (shot && !shot.error) r = await call('POST', 'capture-data', { id: a.id, crop: shot.crop, full: shot.full });
        else why.push(shot && shot.error === 'paused' ? 'Chrome only lets the extension take screenshots after a click on its button, and the page had reloaded' : (shot && shot.error) || 'no answer from the extension');
      } else if (!S.noBrowserShots) {
        try { r = await call('POST', 'capture', { id: a.id, href: location.href, clip, full: { x: 0, y: 0, width: innerWidth, height: innerHeight } }); }
        catch (e) { S.noBrowserShots = true; why.push(e.message); } // not in Annotato's own window: don't ask again on this page
      }
    } catch (e) { why.push(e.message); }
    finally { ui.classList.remove('shooting'); }
    if (r) a.shotMethod = 'browser';
    else {
      try { r = await drawShot(a.id, clip); a.shotMethod = 'drawn'; } catch (e) { why.push('drawing it in the page failed: ' + e.message); }
    }
    if (r) {
      a.shotFile = r.shotFile; a.fullFile = r.fullFile; a.shotAt = new Date().toISOString(); delete a.shotError;
    } else {
      a.shotError = why.join('; ');
      toast(`<b>No screenshot for note ${a.num}.</b> ${esc(a.shotError)}. The note is saved; Retake shot on the note tries again.`, 10000);
    }
    save(); renderPanel();
    if (S.edit && S.edit.id === a.id) refreshEditorWarning(a);
  }

  // Page-drawn screenshot: modern-screenshot redraws the page's elements into an image. Only
  // elements inside the area are drawn (a big canvas has far more off screen), our own layer is
  // left out, and the marks are painted on top afterwards.
  async function loadRenderer() {
    if (window.modernScreenshot) return window.modernScreenshot;
    if (EXT) throw new Error('the drawing library did not load');
    await new Promise((ok, bad) => {
      const el = document.createElement('script');
      el.src = '/__cf/vendor/modern-screenshot.js';
      el.onload = ok; el.onerror = () => bad(new Error('could not load the drawing library'));
      document.head.appendChild(el);
    });
    return window.modernScreenshot;
  }

  async function fetchAsset(url) {
    if (/^(data|blob):/.test(url)) return false;
    let u;
    try { u = new URL(url, location.href); } catch { return false; }
    if (u.origin === location.origin) return false; // same site: the library fetches it itself
    const r = await call('POST', 'fetch', { url: u.href }).catch(() => null);
    return r ? `data:${r.type};base64,${r.data}` : false;
  }

  function marksImage(vw, vh) {
    let out = svg.innerHTML;
    for (const b of badges.children) {
      const r = b.getBoundingClientRect();
      if (b.classList.contains('sticky')) {
        const z = r.width / 220;
        out += `<foreignObject x="0" y="0" width="220" height="${r.height / z}" transform="translate(${r.left} ${r.top}) scale(${z})"><div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:220px;padding:10px 12px;border-radius:4px;background:#fde68a;color:#1c1917;font:13px/1.4 'Segoe UI',system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 0 0 2px #fff">${b.innerHTML.replace(/<b>/, '<b style="display:inline-block;min-width:20px;height:20px;line-height:20px;text-align:center;margin-right:6px;border-radius:10px;background:#8b5cf6;color:#fff;font-size:11px">').replace(/<i>/g, '<i style="color:#78716c">')}</div></foreignObject>`;
      } else {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.height / 2;
        out += `<rect x="${r.left}" y="${r.top}" width="${r.width}" height="${r.height}" rx="${rad}" fill="#8b5cf6" stroke="#fff" stroke-width="2"/>` +
          `<text x="${cx}" y="${cy}" fill="#fff" font-family="Segoe UI, system-ui, sans-serif" font-size="12" font-weight="600" text-anchor="middle" dominant-baseline="central">${esc(b.textContent)}</text>`;
      }
    }
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}">${out}</svg>`);
    return img.decode().then(() => img);
  }

  // SVG backgrounds that use filters (paper grain, noise) come out black when redrawn, so for the
  // moment of drawing they are swapped for plain pictures of themselves. Returns the undo.
  async function flattenSvgBackgrounds(els) {
    const cache = new Map(), undo = [];
    for (const el of els) {
      const bi = getComputedStyle(el).backgroundImage;
      if (!bi.includes('data:image/svg+xml') || !/<filter|%3Cfilter/i.test(bi)) continue;
      let out = bi;
      for (const m of bi.matchAll(/url\("(data:image\/svg\+xml[^"]*)"\)/g)) {
        const src = m[1];
        if (!cache.has(src)) {
          const img = new Image(); img.src = src;
          try { await img.decode(); } catch { continue; }
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || 160; c.height = img.naturalHeight || 160;
          c.getContext('2d').drawImage(img, 0, 0);
          cache.set(src, c.toDataURL('image/png'));
        }
        out = out.replace(src, cache.get(src));
      }
      undo.push([el, el.style.getPropertyValue('background-image'), el.style.getPropertyPriority('background-image')]);
      el.style.setProperty('background-image', out, 'important');
    }
    return () => { for (const [el, v, p] of undo) v ? el.style.setProperty('background-image', v, p) : el.style.removeProperty('background-image'); };
  }

  async function drawShot(id, clip) {
    const ms = await loadRenderer();
    const vw = innerWidth, vh = innerHeight, k = Math.min(devicePixelRatio || 1, 2);
    const area = { l: clip.x - 40, t: clip.y - 40, r: clip.x + clip.width + 40, b: clip.y + clip.height + 40 };
    const keep = new Set();
    // Leaving an element out only saves time if it doesn't move the others: so only elements that
    // float free of the layout (absolute or fixed, like the screens on a zoomable canvas) are skipped.
    const visit = (el) => {
      let any = false;
      for (const c of el.children) if (visit(c)) any = true;
      if (!any) { const b = el.getBoundingClientRect(); any = (b.width > 0 || b.height > 0) && b.right > area.l && b.bottom > area.t && b.left < area.r && b.top < area.b; }
      if (any || !/^(absolute|fixed)$/.test(getComputedStyle(el).position)) keep.add(el);
      return any;
    };
    visit(document.documentElement);
    const KEEP_ALWAYS = /^(HEAD|STYLE|LINK|META|TITLE|BASE)$/;
    const root = document.documentElement;
    const restore = await flattenSvgBackgrounds(keep);
    const canvas = await ms.domToCanvas(root, {
      scale: k, timeout: 20000, fetchFn: fetchAsset,
      backgroundColor: getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)' ? (getComputedStyle(root).backgroundColor === 'rgba(0, 0, 0, 0)' ? '#ffffff' : getComputedStyle(root).backgroundColor) : getComputedStyle(document.body).backgroundColor,
      filter: (n) => n.nodeType !== 1 || (n !== host && (keep.has(n) || KEEP_ALWAYS.test(n.tagName) || (n.ownerSVGElement && keep.has(n.ownerSVGElement)))),
    }).finally(restore);
    // The drawing covers the whole page; the window starts at the scroll position.
    const ox = scrollX + clip.x, oy = scrollY + clip.y;
    const out = document.createElement('canvas');
    out.width = Math.round(clip.width * k); out.height = Math.round(clip.height * k);
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, ox * k, oy * k, clip.width * k, clip.height * k, 0, 0, out.width, out.height);
    const marks = await marksImage(vw, vh);
    ctx.drawImage(marks, clip.x, clip.y, clip.width, clip.height, 0, 0, out.width, out.height);
    return call('POST', 'capture-data', { id, crop: out.toDataURL('image/png').split(',')[1] });
  }

  /* ---------- Creating notes ---------- */

  let draft = null; // shape being drawn: { type, strokes } in screen px
  let ptr = null;

  function whereInfo(type, strokes, el, near) {
    const r = el.getBoundingClientRect(), b = bboxOf(strokes);
    const pct = (v) => Math.round(v * 100) + '%';
    const [lx, ly] = toLocal(r, [b.x, b.y]);
    let position = type === 'pin' || type === 'note'
      ? `${pct(lx)} across, ${pct(ly)} down the element`
      : `from ${pct(lx)}, ${pct(ly)} of the element, ${pct(b.w / r.width)} wide and ${pct(b.h / r.height)} tall`;
    if (type === 'arrow') {
      const [s, e] = strokes[0];
      position = `arrow from ${pct(toLocal(r, s)[0])}, ${pct(toLocal(r, s)[1])} to ${pct(toLocal(r, e)[0])}, ${pct(toLocal(r, e)[1])} of the element` +
        `; it points at \`${describe(elementAt(e[0], e[1]))}\``;
    }
    const under = [];
    if (type !== 'pin' && type !== 'note') {
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const d = describe(elementAt(b.x + fx * b.w, b.y + fy * b.h));
        if (!under.includes(d) && d !== describe(el)) under.push(d);
      }
    }
    return {
      view: viewInfo(), anchor: describe(el), nearOnly: near, text: squash(el.innerText || el.textContent).slice(0, 140),
      path: pathOf(el), under: under.slice(0, 4), selector: selectorFor(el), position,
      screen: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) },
    };
  }

  function makeNote(type, strokes) {
    const b = bboxOf(strokes);
    const { el, near } = anchorFor(b);
    const r = el.getBoundingClientRect();
    const a = {
      id: uid(), num: S.notes.reduce((m, x) => Math.max(m, x.num), 0) + 1, type, created: new Date().toISOString(),
      anchor: { selector: selectorFor(el), fp: fingerprint(el), w0: r.width }, strokes: strokes.map((s) => s.map((p) => toLocal(r, p))),
      comments: [], where: whereInfo(type, strokes, el, near),
    };
    a._el = el; a._ok = true; a._fpAt = performance.now();
    S.notes.push(a);
    save(); renderPanel();
    return a;
  }

  // Extra pen strokes join the open drawing until it gets a comment.
  function addStroke(a, stroke) {
    const el = resolve(a, performance.now());
    if (!el) return false;
    const r = el.getBoundingClientRect();
    a.strokes.push(stroke.map((p) => toLocal(r, p)));
    const all = a.strokes.map((s) => s.map((p) => toScreen(r, p)));
    a.where = whereInfo('pen', all, el, a.where.nearOnly);
    save();
    return true;
  }

  catchEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const open = S.edit && S.notes.find((x) => x.id === S.edit.id);
    if (!(S.mode === 'pen' && open && open.type === 'pen' && !open.comments.length && !editorText())) commitEditor();
    catchEl.setPointerCapture(e.pointerId);
    ptr = { x: e.clientX, y: e.clientY };
    const p = [e.clientX, e.clientY];
    if (S.mode === 'box' || S.mode === 'arrow') draft = { type: S.mode, strokes: [[p, p]] };
    if (S.mode === 'pen') draft = { type: 'pen', strokes: [[p]] };
  });
  catchEl.addEventListener('pointermove', (e) => {
    if (!ptr || !draft) return;
    const p = [e.clientX, e.clientY], s = draft.strokes[0];
    if (draft.type === 'pen') { const l = s[s.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 2) s.push(p); }
    else s[1] = p;
  });
  catchEl.addEventListener('pointerup', async (e) => {
    if (!ptr) return;
    const start = ptr; ptr = null;
    const d = draft; draft = null;
    const p = [e.clientX, e.clientY];
    let a = null;
    if (S.mode === 'pin' || S.mode === 'note') {
      if (Math.hypot(p[0] - start.x, p[1] - start.y) > 8) return;
      a = makeNote(S.mode, [[p]]);
    } else if (d) {
      const b = bboxOf(d.strokes);
      if (d.type !== 'pen' && Math.max(b.w, b.h) < 8) return toast('Drag to draw a ' + (d.type === 'box' ? 'box' : 'arrow') + '.');
      const open = S.edit && S.notes.find((x) => x.id === S.edit.id);
      if (d.type === 'pen' && open && open.type === 'pen' && !open.comments.length && !editorText() && addStroke(open, d.strokes[0])) {
        editor.querySelector('textarea').focus();
        capture(open); return;
      }
      a = makeNote(d.type, d.strokes);
    }
    if (!a) return;
    openEditor(a, true);
    capture(a);
  });

  // Keep zooming and scrolling the mock while a drawing tool is on.
  catchEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const t = hits(e.clientX, e.clientY)[0];
    if (!t) return;
    const ev = new WheelEvent('wheel', { deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY,
      screenX: e.screenX, screenY: e.screenY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true, composed: true });
    if (t.dispatchEvent(ev)) { // nobody handled it: scroll the nearest scrollable thing ourselves
      for (let el = t; el; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) { el.scrollBy(e.deltaX, e.deltaY); return; }
      }
      scrollBy(e.deltaX, e.deltaY);
    }
  }, { passive: false });

  /* ---------- Editor ---------- */

  const editorText = () => { const t = editor.querySelector('textarea'); return t ? t.value.trim() : ''; };

  function refreshEditorWarning(a) {
    const w = editor.querySelector('.warn');
    if (w) w.outerHTML = warnHtml(a);
  }
  const warnHtml = (a) => `<div class="warn"${a.shotError ? '' : ' hidden'}>No screenshot: ${esc(a.shotError || '')}. Retake shot tries again.</div>`;

  function openEditor(a, isNew) {
    S.edit = { id: a.id, isNew };
    const when = (c) => new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    editor.innerHTML = `
      <div class="eh"><span class="n">${a.num}</span><span class="grow">${KIND[a.type]}</span><button class="x" data-act="close" title="Close (Esc)">×</button></div>
      ${a.comments.length ? `<div class="thread">${a.comments.map((c, i) => `<div class="c" contenteditable="plaintext-only" data-i="${i}" spellcheck="true">${esc(c.text)}</div>`).join('')}</div>` : ''}
      ${warnHtml(a)}
      <textarea placeholder="${a.comments.length ? 'Add to this note…' : 'What should change here?'} Win+H to dictate" spellcheck="true"></textarea>
      <div class="ea"><button class="ghost danger" data-act="delete">Delete</button><button class="ghost" data-act="retake" title="Take this note's screenshot again with the page as it is now">Retake shot</button><span class="grow"></span><button class="primary" data-act="save">Save <span style="opacity:.5">↵</span></button></div>`;
    editor.hidden = false;
    placeEditor(a);
    editor.querySelector('textarea').focus();
    renderPanel();
  }

  function placeEditor(a) {
    const g = a._g || layoutNote(a, performance.now());
    const w = 320, h = editor.offsetHeight || 200;
    let x = innerWidth / 2 - w / 2, y = innerHeight / 3;
    if (g) {
      const b = g.b;
      x = b.x + b.w + 24; y = b.y;
      if (x + w > innerWidth - (S.panel ? 372 : 16)) x = b.x - w - 24;
      if (x < 72) x = Math.min(innerWidth - w - 16, b.x + b.w / 2 - w / 2), y = b.y + b.h + 24;
    }
    editor.style.left = Math.max(72, Math.min(x, innerWidth - w - 16)) + 'px';
    editor.style.top = Math.max(16, Math.min(y, innerHeight - h - 16)) + 'px';
  }

  function commitEditor() {
    if (!S.edit) return;
    const a = S.notes.find((x) => x.id === S.edit.id);
    if (a) {
      editor.querySelectorAll('.c').forEach((c) => {
        const i = +c.dataset.i, t = c.innerText.trim();
        if (a.comments[i]) { if (t) a.comments[i].text = t; else a.comments[i].removed = true; }
      });
      a.comments = a.comments.filter((c) => !c.removed);
      const t = editorText();
      if (t) a.comments.push({ text: t, at: new Date().toISOString() });
      if (!a.comments.length && (a.type === 'pin' || a.type === 'note')) S.notes = S.notes.filter((x) => x !== a);
      save();
    }
    S.edit = null; editor.hidden = true; editor.innerHTML = '';
    renderPanel();
  }

  function deleteNote(a) {
    S.notes = S.notes.filter((x) => x !== a);
    if (S.edit && S.edit.id === a.id) { S.edit = null; editor.hidden = true; editor.innerHTML = ''; }
    save(); renderPanel();
    toast(`Deleted note ${a.num}. Press Ctrl+Z to bring it back.`);
    undoStack.push(a);
  }
  const undoStack = [];

  editor.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = S.edit && S.notes.find((x) => x.id === S.edit.id);
    if (b.dataset.act === 'close' || b.dataset.act === 'save') commitEditor();
    if (b.dataset.act === 'delete' && a) deleteNote(a);
    if (b.dataset.act === 'retake' && a) { S.shots = true; capture(a).then(() => S.shots && toast(`Screenshot for note ${a.num} retaken.`)); }
  });
  editor.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'TEXTAREA') { e.preventDefault(); commitEditor(); }
    if (e.key === 'Escape') { e.preventDefault(); commitEditor(); }
  });
  editor.addEventListener('keyup', (e) => e.stopPropagation());
  editor.addEventListener('keypress', (e) => e.stopPropagation());

  /* ---------- Badges and stickies ---------- */

  badges.addEventListener('pointerdown', (e) => e.stopPropagation());
  badges.addEventListener('click', (e) => {
    const t = e.target.closest('[data-id]');
    if (!t) return;
    e.stopPropagation();
    const a = S.notes.find((x) => x.id === t.dataset.id);
    if (!a) return;
    if (S.edit && S.edit.id === a.id) return commitEditor();
    commitEditor();
    if (S.notes.includes(a)) openEditor(a, false);
  });

  /* ---------- Panel ---------- */

  function visLabel(a) {
    if (a._g) return '';
    if (!a._el) return 'Not on the page right now';
    if (!a._ok) return 'In another view of the mock';
    return 'Off screen or covered';
  }
  function updateVisibilityLabels() {
    if (!S.panel) return;
    for (const m of panel.querySelectorAll('.meta[data-id]')) {
      const a = S.notes.find((x) => x.id === m.dataset.id);
      if (!a) continue;
      const v = visLabel(a), base = m.dataset.base;
      const txt = v ? `${base} · ${v}` : base;
      if (m.textContent !== txt) { m.textContent = txt; m.classList.toggle('off', !!v); }
    }
  }

  function renderPanel() {
    const live = S.notes.slice().sort((a, b) => a.num - b.num);
    $('.cn').textContent = live.length || '';
    $('.export').disabled = !live.length;
    panel.hidden = !S.panel;
    $('.count').classList.toggle('on', S.panel);
    if (!S.panel) return;
    $('.pc').textContent = live.length ? `· ${live.length}` : '';
    if (S.needProject) {
      $('.list').innerHTML = `<div class="empty"><p>Annotato couldn't tell which project this app belongs to, so it doesn't know where to save feedback yet.</p><p><button class="primary" data-act="project">Choose project folder…</button></p></div>`;
      $('.pf').innerHTML = '';
      return;
    }
    $('.list').innerHTML = live.length ? live.map((a) => {
      const t = a.comments.length ? esc(a.comments[0].text) + (a.comments.length > 1 ? ` <span style="color:var(--subtle)">+${a.comments.length - 1}</span>` : '') : '<span style="color:var(--subtle)">No comment yet</span>';
      const base = KIND[a.type] + (a.where && a.where.anchor ? ' on ' + a.where.anchor.split(/[.#[ ]/)[0] : '') + (a.shotError ? ' · No screenshot' : '');
      return `<button class="item${S.edit && S.edit.id === a.id ? ' sel' : ''}" data-id="${a.id}"><span class="n">${a.num}</span><span class="txt">${t}</span>` +
        `<span class="meta${a.shotError ? ' noshot' : ''}" data-id="${a.id}" data-base="${esc(base)}">${esc(base)}</span>${a.shotFile ? `<img src="${shotUrl(a.shotFile)}&t=${encodeURIComponent(a.shotAt || '')}" alt="" loading="lazy">` : ''}</button>`;
    }).join('') : `<div class="empty"><p>No notes yet.</p><p>Pick a tool in the bar on the left (Pin, Box, Arrow, Pen or Sticky note), mark the mock, and type what should change. Everything saves as you go.</p><p>When you're done, press Export for Claude.</p></div>`;
    const ex = S.lastExport;
    $('.pf').innerHTML = (ex ? `<div class="done"><b>Exported ${ex.count} note${ex.count === 1 ? '' : 's'}</b> at ${new Date(ex.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to<br><code>${esc(ex.dir)}</code>
      <div class="row"><button class="ghost" data-act="copy">Copy message for Claude</button><button class="ghost" data-act="reveal">Open folder</button>${live.length ? '<button class="ghost danger" data-act="fresh">Clear notes for the next round</button>' : ''}</div></div>` : '') +
      (S.project ? `<div class="row"><span class="hint">Saves to <b style="color:var(--muted);font-weight:500;white-space:nowrap">${esc(S.project.split(/[\\/]/).pop())}</b></span><button class="ghost" data-act="project" title="Feedback folder: ${esc(S.project)}\\feedback">Change</button></div>` : '') +
      `<div class="row"><span class="hint">Notes save automatically into the project's feedback folder.</span><button class="primary" data-act="export" ${live.length ? '' : 'disabled'}>Export for Claude</button></div>`;
    updateVisibilityLabels();
  }

  panel.addEventListener('click', async (e) => {
    const it = e.target.closest('.item');
    if (it) {
      const a = S.notes.find((x) => x.id === it.dataset.id);
      if (!a) return;
      commitEditor();
      S.flash = a.id; setTimeout(() => { if (S.flash === a.id) S.flash = null; }, 900);
      if (!a._g) toast(`Note ${a.num} isn't visible here (${visLabel(a).toLowerCase()}). Its thumbnail shows where it is.`);
      openEditor(a, false);
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'export') doExport();
    if (b.dataset.act === 'copy') copyMessage();
    if (b.dataset.act === 'reveal') call('POST', 'reveal', { dir: S.lastExport.dir });
    if (b.dataset.act === 'project') {
      toast('A folder window opened. It may be behind Chrome.', 5000);
      const r = await call('POST', 'set-project', {}).catch((err) => toast(esc(err.message)));
      if (r && r.ok) { await load(); toast(`Feedback for this app now goes to ${esc(r.project)}.`); }
    }
    if (b.dataset.act === 'fresh') {
      if (!confirm('Clear all notes from this mock? They are already saved in the exported bundle.')) return;
      await call('POST', 'clear', {});
      S.notes = []; commitEditor(); save(true); renderPanel();
    }
  });
  panel.querySelector('.close-panel').onclick = () => togglePanel(false);
  function togglePanel(on) { S.panel = on === undefined ? !S.panel : on; renderPanel(); }

  async function doExport() {
    commitEditor();
    if (!S.notes.length) return;
    await save(true); await saving;
    try {
      const r = await call('POST', 'export', { title: document.title, viewport: `${innerWidth}×${innerHeight} at ${devicePixelRatio}x` });
      S.lastExport = { dir: r.dir, md: r.md, at: new Date().toISOString(), count: S.notes.length };
      save(true);
      togglePanel(true);
      copyMessage(true);
    } catch (e) { toast('Export failed: ' + esc(e.message), 7000); }
  }
  async function copyMessage(auto) {
    const text = `Read my design feedback in "${S.lastExport.md}" (look at every screenshot) and work through all the notes.`;
    try { await navigator.clipboard.writeText(text); } catch { await call('POST', 'copy', { text }); }
    toast((auto ? 'Exported. ' : '') + 'A message for Claude is on your clipboard: paste it into a Claude session.', 5000);
  }

  /* ---------- Toolbar, modes and keys ---------- */

  function setMode(m) {
    if (m !== 'browse' && S.needProject) { togglePanel(true); return toast('Choose the project folder first, so Annotato knows where to save.'); }
    if (m !== S.mode) commitEditor();
    S.mode = m;
    root.querySelectorAll('.bar .t[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    catchEl.classList.toggle('on', m !== 'browse' && !S.space);
    catchEl.style.cursor = m === 'pen' ? 'crosshair' : m === 'pin' || m === 'note' ? 'copy' : 'crosshair';
  }
  function toggleHidden() {
    S.hidden = !S.hidden;
    ui.classList.toggle('nomarks', S.hidden);
    $('.hide').innerHTML = ICON(S.hidden ? EYE_OFF : EYE);
    $('.hide').classList.toggle('on', S.hidden);
  }

  $('.bar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) setMode(b.dataset.mode);
    else if (b.classList.contains('hide')) toggleHidden();
    else if (b.classList.contains('count')) togglePanel();
    else if (b.classList.contains('export')) doExport();
  });
  $('.bar').addEventListener('pointerover', (e) => {
    const b = e.target.closest('[data-tip]');
    if (!b) return tip.classList.remove('show');
    tip.innerHTML = esc(b.dataset.tip) + (b.dataset.key ? `<kbd>${b.dataset.key}</kbd>` : '');
    const r = b.getBoundingClientRect();
    tip.classList.add('show');
    tip.style.left = r.right + 10 + 'px';
    tip.style.top = r.top + r.height / 2 - tip.offsetHeight / 2 + 'px';
  });
  $('.bar').addEventListener('pointerleave', () => tip.classList.remove('show'));

  const typing = (e) => {
    const t = e.composedPath()[0];
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  };
  const KEYS = { v: 'browse', c: 'pin', b: 'box', a: 'arrow', p: 'pen', n: 'note' };
  addEventListener('keydown', (e) => {
    if (S.off || typing(e)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) {
      const a = undoStack.pop();
      if (a) { S.notes.push(a); save(); renderPanel(); toast(`Brought back note ${a.num}.`); }
      else {
        const last = S.notes.slice().sort((x, y) => (x.created < y.created ? 1 : -1))[0];
        if (!last) return;
        if (last.type === 'pen' && last.strokes.length > 1 && !last.comments.length) { last.strokes.pop(); save(); toast('Removed the last stroke.'); }
        else { deleteNote(last); undoStack.length = 0; toast(`Removed note ${last.num}.`); }
      }
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (S.edit) commitEditor();
      else if (S.mode !== 'browse') setMode('browse');
      else return; // let the mock have its own Esc
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (e.key === ' ' && S.mode !== 'browse') {
      if (!S.space) { S.space = true; catchEl.classList.remove('on'); }
      e.preventDefault(); return;
    }
    if (KEYS[k]) setMode(KEYS[k]);
    else if (k === 'h') toggleHidden();
    else if (k === 'l') togglePanel();
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  addEventListener('keyup', (e) => {
    if (e.key === ' ' && S.space) { S.space = false; catchEl.classList.toggle('on', S.mode !== 'browse'); }
  }, true);
  addEventListener('resize', () => { if (S.edit) { const a = S.notes.find((x) => x.id === S.edit.id); if (a) placeEditor(a); } });

  /* ---------- Start ---------- */

  async function load() {
    try {
      const d = await call('GET', 'draft');
      S.notes = d.notes || []; S.lastExport = d.lastExport || null; S.project = d.project || null; S.needProject = !!d.needProject;
      if (S.needProject) togglePanel(true);
    } catch (e) { toast('Could not load saved notes: ' + esc(e.message), 8000); }
    renderPanel();
  }

  // The extension's button shows and hides the whole overlay.
  function setVisible(on) {
    S.off = !on;
    if (!on) { commitEditor(); setMode('browse'); }
    host.style.display = on ? 'block' : 'none';
  }
  if (EXT) chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'annotato-show') setVisible(m.on);
    if (m && m.type === 'annotato-shots') toast('Screenshots are back on.');
  });

  async function start() {
    document.documentElement.appendChild(host);
    await load();
    setMode('browse');
    requestAnimationFrame(render);
    setInterval(() => call('GET', 'ping').catch(() => {}), 60000);
    if (!S.notes.length) toast('Feedback mode: pick a tool on the left, or press C to drop a pin.', 5000);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
})();
