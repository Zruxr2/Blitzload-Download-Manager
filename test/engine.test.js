'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DownloadTask, Limiter } = require('../src/engine');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blitzload-'));

/** Local test server with optional range support and a per-connection speed cap. */
function serve({ size, ranges = true, perConnBps = 0, redirect = false, disposition = null }) {
  const data = crypto.randomBytes(size);
  const stats = { maxConcurrent: 0, current: 0, requests: 0 };
  const server = http.createServer((req, res) => {
    if (redirect && req.url === '/start') {
      res.writeHead(302, { Location: '/real/file.bin' });
      return res.end();
    }
    stats.requests++;
    let start = 0;
    let end = size - 1;
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (ranges) headers['Accept-Ranges'] = 'bytes';
    if (disposition) headers['Content-Disposition'] = disposition;
    let status = 200;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m && ranges) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    stats.current++;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.current);
    let pos = start;
    const CH = 64 * 1024;
    let closed = false;
    res.on('close', () => {
      if (!closed) stats.current--;
      closed = true;
    });
    const pump = () => {
      if (closed) return;
      if (pos > end) return res.end();
      const n = Math.min(CH, end - pos + 1);
      res.write(data.subarray(pos, pos + n));
      pos += n;
      if (perConnBps) setTimeout(pump, (n / perConnBps) * 1000);
      else setImmediate(pump);
    };
    pump();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        data,
        stats,
        url: `http://127.0.0.1:${server.address().port}/start`,
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      }),
    ),
  );
}

test('segmented download is byte-exact and uses parallel connections', async () => {
  const s = await serve({ size: 8 * 1024 * 1024 });
  const dir = tmp();
  const t = new DownloadTask({ url: s.url, dir, connections: 8, preferredName: 'a.bin' });
  await t.run();
  assert.equal(t.status, 'completed', t.error);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'a.bin'))), sha(s.data));
  assert.ok(s.stats.maxConcurrent > 1, `expected parallel connections, saw ${s.stats.maxConcurrent}`);
  assert.ok(!fs.existsSync(path.join(dir, 'a.bin.part')));
  s.close();
});

test('multiple connections beat one when the server caps each connection', async () => {
  const size = 4 * 1024 * 1024;
  const s = await serve({ size, perConnBps: 1024 * 1024 });
  const time = async (connections) => {
    const t = new DownloadTask({ url: s.url, dir: tmp(), connections, preferredName: 'x.bin' });
    const t0 = Date.now();
    await t.run();
    assert.equal(t.status, 'completed', t.error);
    return Date.now() - t0;
  };
  const one = await time(1);
  const eight = await time(8);
  console.log(`  1 connection: ${one} ms, 8 connections: ${eight} ms (${(one / eight).toFixed(1)}x faster)`);
  assert.ok(eight < one / 2, 'segmented download should be at least 2x faster');
  s.close();
});

test('pause, then resume after a simulated restart, finishes correctly', async () => {
  const s = await serve({ size: 6 * 1024 * 1024, perConnBps: 1024 * 1024 });
  const dir = tmp();
  const t = new DownloadTask({ url: s.url, dir, connections: 4, preferredName: 'p.bin' });
  const run1 = t.run();
  await new Promise((r) => setTimeout(r, 900));
  t.pause();
  assert.equal(t.status, 'paused');
  await run1;
  assert.equal(t.status, 'paused');
  const partial = t.downloaded;
  assert.ok(partial > 0 && partial < t.size, `partial progress expected, got ${partial}`);

  // "Restart the app": rebuild the task from its saved JSON.
  const revived = new DownloadTask(JSON.parse(JSON.stringify(t.toJSON())));
  assert.equal(revived.downloaded, partial);
  revived.status = 'queued';
  await revived.run();
  assert.equal(revived.status, 'completed', revived.error);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'p.bin'))), sha(s.data));
  s.close();
});

test('falls back to a single stream when the server has no range support', async () => {
  const s = await serve({ size: 3 * 1024 * 1024, ranges: false });
  const dir = tmp();
  const t = new DownloadTask({ url: s.url, dir, connections: 8, preferredName: 'n.bin' });
  await t.run();
  assert.equal(t.status, 'completed', t.error);
  assert.equal(t.resumable, false);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'n.bin'))), sha(s.data));
  s.close();
});

test('follows redirects and uses Content-Disposition for the file name', async () => {
  const s = await serve({ size: 1024 * 1024, redirect: true, disposition: 'attachment; filename="report final.pdf"' });
  const dir = tmp();
  const t = new DownloadTask({ url: s.url, dir });
  await t.run();
  assert.equal(t.status, 'completed', t.error);
  assert.equal(t.filename, 'report final.pdf');
  s.close();
});

test('never overwrites an existing file', async () => {
  const s = await serve({ size: 200 * 1024 });
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'same.bin'), 'old');
  const t = new DownloadTask({ url: s.url, dir, preferredName: 'same.bin' });
  await t.run();
  assert.equal(t.filename, 'same (1).bin');
  assert.equal(fs.readFileSync(path.join(dir, 'same.bin'), 'utf8'), 'old');
  s.close();
});

test('speed limiter caps throughput', async () => {
  const s = await serve({ size: 2 * 1024 * 1024 });
  const limiter = new Limiter();
  limiter.setRate(1024 * 1024); // 1 MB/s
  const t = new DownloadTask({ url: s.url, dir: tmp(), limiter, connections: 4, preferredName: 'l.bin' });
  const t0 = Date.now();
  await t.run();
  const ms = Date.now() - t0;
  assert.equal(t.status, 'completed', t.error);
  assert.ok(ms > 1500, `2 MB at 1 MB/s should take ~2 s, took ${ms} ms`);
  s.close();
});

test('checksum verification flags matches and mismatches', async () => {
  const s = await serve({ size: 300 * 1024 });
  const good = new DownloadTask({
    url: s.url,
    dir: tmp(),
    checksum: { algo: 'sha256', value: sha(s.data) },
  });
  await good.run();
  assert.equal(good.checksumOk, true);
  const bad = new DownloadTask({ url: s.url, dir: tmp(), checksum: { algo: 'sha256', value: '0'.repeat(64) } });
  await bad.run();
  assert.equal(bad.status, 'completed');
  assert.equal(bad.checksumOk, false);
  s.close();
});

test('reports a clear error for a missing file', async () => {
  const s = await serve({ size: 10 });
  const t = new DownloadTask({ url: s.url.replace('/start', '/start'), dir: tmp() });
  t.url = t.url.replace('/start', '/start');
  s.close();
  await new Promise((r) => setTimeout(r, 100));
  t.maxRetries = 0;
  await t.run();
  assert.equal(t.status, 'error');
  assert.ok(t.error);
});
