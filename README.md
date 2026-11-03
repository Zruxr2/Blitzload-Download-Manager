# Blitzload

A fast desktop download manager (Electron, Node.js) with multi-connection downloads, pause and resume, and a queue.

![Blitzload main window](docs/screenshot.png)

## Run it

```bash
npm install
npm start
```

Needs Node 18 or newer. `npm install` downloads Electron (about 100 MB).

## Build an installer

```bash
npm run dist
```

Produces an installer for the OS you run it on (Windows NSIS, macOS DMG, Linux AppImage and deb) in `dist/`.
Pushing a tag such as `v1.0.0` builds all three on GitHub and attaches them to a release (see `.github/workflows/release.yml`). Builds are unsigned, so Windows and macOS will show a warning on first launch.

## Tests

```bash
npm test
```

## How you add downloads

Paste or drop a link anywhere in the window, or choose **Add download** and paste one or more links. Blitzload does not yet capture downloads from your browser.

## What it does

- **Faster downloads.** Each file is split into parts fetched over several connections at once (default 8, up to 32). When a connection finishes early, it takes half of the biggest remaining part, so every connection stays busy until the end.
- **Pause and resume.** Progress is saved per part. You can pause, close the app, reboot, and carry on later. If the server's file has changed since, Blitzload starts that download again instead of corrupting it.
- **Queue.** Choose how many downloads run at once. The rest wait their turn.
- **Speed limit** across all downloads, in KB/s or MB/s.
- **Retries** with backoff when a connection drops.
- **Checksum check** (MD5, SHA-1, SHA-256, SHA-512) when you supply a hash.
- **File names** come from the server (Content-Disposition) or the link. Existing files are never overwritten.
- Paste or drop a link anywhere in the window to add it. Desktop notification when a download finishes.

Servers that do not support byte ranges are downloaded on a single connection and restart from zero if paused. Blitzload tells you when that applies.

## Layout

```
main.js, preload.js   Electron shell and safe bridge to the UI
src/engine.js         Download engine (segments, resume, limiter, checksums)
src/manager.js        Queue, settings, saving state to disk
renderer/             The window (HTML, CSS, JS)
test/                 npm test: runs the engine against a local test server
```

Settings and the download list are stored in the Electron user-data folder.

## Only download what you have the right to

Blitzload sends a normal browser user agent by default. Respect the terms of the sites you download from.

## License

MIT. See [LICENSE](LICENSE).
