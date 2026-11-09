# Annotato

Local tool for annotating HTML design mocks and running dev-server apps, and exporting the notes for Claude. Read README.md first; its "For Claude" section explains how to act on a feedback bundle.

- Keep it simple to maintain: plain Node (no npm packages, no build step) and plain browser JS. Windows only.
- `server.js` (server + launcher; file mocks on port 4321, each running dev-server app proxied on its own port from 4322, and the API the Chrome extension uses), `extension/` (MV3 extension: `background.js`, and `overlay.js`, the injected annotation UI that the server also serves), `home.html` (start page), `Annotato.cmd` (launcher), `Add to Send-to menu.cmd`, `Start with Windows.cmd`.
- Runtime data goes in `work/` (git-ignored). Feedback is written into the reviewed project's own `feedback/` folder, never here.
- Test by launching on a real mock or a running app and driving the review window over the Chrome DevTools Protocol on port 9333. Test the extension in a separate Chrome with its own `--user-data-dir`, `--remote-debugging-port` and `--enable-unsafe-extension-debugging`: CDP `Extensions.loadUnpacked` loads it and `Extensions.triggerAction` (on a tab target) acts as a click, which grants the screenshot permission. Don't use `scale` in `Page.captureScreenshot`: it resizes the page and the mock re-lays itself out.
