# Canvas feedback

Local tool for annotating HTML design mocks and running dev-server apps, and exporting the notes for Claude. Read README.md first; its "For Claude" section explains how to act on a feedback bundle.

- Keep it simple to maintain: plain Node (no npm packages, no build step) and plain browser JS. Windows only.
- `server.js` (server + launcher; file mocks on port 4321, each running dev-server app proxied on its own port from 4322), `overlay.js` (injected annotation UI), `home.html` (start page), `Review a mock.cmd` (launcher), `Add to Send-to menu.cmd`.
- Runtime data goes in `work/` (git-ignored). Feedback is written into the reviewed project's own `feedback/` folder, never here.
- Test by launching on a real mock or a running app and driving the review window over the Chrome DevTools Protocol on port 9333. Don't use `scale` in `Page.captureScreenshot`: it resizes the page and the mock re-lays itself out.
