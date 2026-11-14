// Annotato extension: the toolbar button (or Alt+Shift+A) shows or hides the overlay on a localhost
// tab. The overlay talks to the Annotato server (on this computer) through here, and screenshots are
// taken with Chrome's own capture and cropped here before they go to the server.
//
// Chrome lets an extension capture a tab only right after its button was clicked there ("activeTab"),
// until the page navigates or reloads. So after a reload the overlay comes back by itself, the badge
// turns amber, and the next click turns screenshots back on instead of hiding the overlay.

const SERVER = 'http://127.0.0.1:4321';
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|[\w.-]+\.localhost)(:\d+)?\//i;
const NOT_RUNNING = "Annotato isn't running. Double-click Annotato.cmd (or run \"Start with Windows.cmd\" once so it always runs).";

// Per tab: is the overlay on (so it comes back after a reload), and can we take screenshots?
const getState = async () => (await chrome.storage.session.get('tabs')).tabs || {};
async function setState(tabId, st) {
  const all = await getState();
  if (st) all[tabId] = st; else delete all[tabId];
  await chrome.storage.session.set({ tabs: all });
  badge(tabId, st);
}
function badge(tabId, st) {
  chrome.action.setBadgeText({ tabId, text: st ? 'ON' : '' }).catch(() => {});
  if (!st) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: st.shots ? '#8b5cf6' : '#e5a00d' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: st.shots ? 'Annotato is on: click to hide (Alt+Shift+A)' : 'Annotato: click to turn screenshots back on after the reload' }).catch(() => {});
}

async function show(tabId, on) {
  if (on) await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/modern-screenshot.js', 'overlay.js'] });
  await chrome.tabs.sendMessage(tabId, { type: 'annotato-show', on }).catch(() => {});
}

async function toggle(tab) {
  if (!LOCAL.test(tab.url || '')) {
    chrome.action.setBadgeText({ tabId: tab.id, text: 'n/a' });
    chrome.action.setTitle({ tabId: tab.id, title: 'Annotato only works on localhost pages (apps running on this computer).' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 2500);
    return;
  }
  const st = (await getState())[tab.id];
  if (st && !st.shots) { // already on after a reload: this click only brings screenshots back
    await setState(tab.id, { shots: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'annotato-shots' }).catch(() => {});
    return;
  }
  await setState(tab.id, st ? null : { shots: true });
  await show(tab.id, !st).catch((e) => console.warn('Annotato:', e.message));
}
chrome.action.onClicked.addListener(toggle);

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const st = (await getState())[tabId];
  if (!st) return;
  if (info.status === 'loading' && st.shots) return setState(tabId, { shots: false }); // navigation ends the screenshot permission
  if (info.status !== 'complete') return;
  if (!LOCAL.test(tab.url || '')) return setState(tabId, null);
  badge(tabId, st);
  show(tabId, true).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => setState(tabId, null));

// Base64 of a Blob, in chunks (btoa can't take a huge string at once).
async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function capture(tab, clip, vw) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const full = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(full);
  const k = bmp.width / vw; // device pixels per CSS pixel (screen scaling and page zoom)
  const c = new OffscreenCanvas(Math.round(clip.width * k), Math.round(clip.height * k));
  c.getContext('2d').drawImage(bmp, clip.x * k, clip.y * k, clip.width * k, clip.height * k, 0, 0, c.width, c.height);
  return { crop: await base64(await c.convertToBlob({ type: 'image/png' })), full: dataUrl.split(',')[1] };
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.type === 'annotato-api') {
    fetch(SERVER + m.url, { method: m.method, body: m.body === undefined ? undefined : JSON.stringify(m.body) })
      .then((r) => r.json()).then(reply, () => reply({ error: NOT_RUNNING }));
    return true;
  }
  if (m.type === 'annotato-capture') {
    capture(sender.tab, m.clip, m.vw).then(reply, (e) => reply({ error: /activeTab|all_urls/.test(e.message) ? 'paused' : e.message }));
    return true;
  }
});
