'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DownloadManager } = require('../src/manager');

function server(size) {
  const data = crypto.randomBytes(size);
  const s = http.createServer((req, res) => {
    let a = 0, b = size - 1, st = 200;
    const h = { 'Accept-Ranges': 'bytes' };
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) { a = +m[1]; b = m[2] ? Math.min(+m[2], size - 1) : size - 1; st = 206; h['Content-Range'] = `bytes ${a}-${b}/${size}`; }
    h['Content-Length'] = b - a + 1;
    res.writeHead(st, h);
    let pos = a;
    const pump = () => { if (res.destroyed) return; if (pos > b) return res.end(); const n = Math.min(65536, b - pos + 1); res.write(data.subarray(pos, pos + n)); pos += n; setTimeout(pump, 40); };
    pump();
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ data, url: `http://127.0.0.1:${s.address().port}/f.bin`, close: () => { s.closeAllConnections(); s.close(); } })));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('queue respects maxConcurrent, state survives restart', async () => {
  const srv = await server(2 * 1024 * 1024);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-data-'));
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-dl-'));
  const m = new DownloadManager({ dataDir, defaultDownloadDir: dl });
  m.load();
  m.setSettings({ maxConcurrent: 1, connections: 2 });
  m.add({ url: srv.url }); m.add({ url: srv.url });
  await wait(400);
  let st = m.list().map((t) => t.status).sort();
  assert.deepEqual(st, ['downloading', 'queued']);
  await m.shutdown();

  const m2 = new DownloadManager({ dataDir, defaultDownloadDir: dl });
  m2.load();
  m2.setSettings({ maxConcurrent: 2 });
  for (let i = 0; i < 100 && m2.list().some((t) => t.status !== 'completed'); i++) await wait(200);
  const done = m2.list();
  assert.ok(done.every((t) => t.status === 'completed'), JSON.stringify(done.map((t) => [t.status, t.error])));
  for (const t of done) assert.equal(fs.readFileSync(t.path).length, srv.data.length);
  assert.equal(new Set(done.map((t) => t.filename)).size, 2);
  await m2.shutdown();
  srv.close();
});

test('rejects non-http links and clamps settings', () => {
  const m = new DownloadManager({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), defaultDownloadDir: os.tmpdir() });
  assert.throws(() => m.add({ url: 'ftp://x/y' }));
  assert.throws(() => m.add({ url: 'nonsense' }));
  const s = m.setSettings({ connections: 999, maxConcurrent: 0, speedLimitKBps: -5 });
  assert.equal(s.connections, 32); assert.equal(s.maxConcurrent, 1); assert.equal(s.speedLimitKBps, 0);
});
