'use strict';
/**
 * Blitzload download engine.
 *
 * - Segmented downloads: a file is split into byte ranges fetched over several
 *   parallel connections (this is what makes downloads faster on servers that
 *   cap per-connection speed).
 * - Dynamic re-splitting: when a connection finishes early it steals half of
 *   the biggest remaining range, so all connections stay busy to the end.
 * - Pause / resume: progress is kept per segment and survives app restarts.
 * - Global speed limiter, retries with backoff, checksum verification.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MIN_SEGMENT = 512 * 1024;
const MAX_REDIRECTS = 10;
const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function sleep(ms, aborted) {
  if (!aborted) return new Promise((r) => setTimeout(r, ms));
  let left = ms;
  while (left > 0 && !aborted()) {
    const slice = Math.min(left, 100);
    await new Promise((r) => setTimeout(r, slice));
    left -= slice;
  }
}

/** Shared bandwidth limiter (bytes/second, 0 = unlimited). */
class Limiter {
  constructor() {
    this.rate = 0;
    this.nextFree = 0;
  }
  setRate(bytesPerSec) {
    this.rate = Math.max(0, Math.floor(bytesPerSec) || 0);
    this.nextFree = 0;
  }
  async consume(n, aborted) {
    if (!this.rate) return;
    const now = Date.now();
    const start = Math.max(now, this.nextFree);
    this.nextFree = start + (n / this.rate) * 1000;
    const wait = start - now;
    if (wait > 0) await sleep(wait, aborted || (() => false));
  }
}

function httpError(code) {
  const e = new Error(`Server responded with HTTP ${code}`);
  e.status = code;
  e.fatal = code >= 400 && code < 500 && code !== 408 && code !== 429;
  return e;
}

/** Open a GET request, following redirects. Resolves with the response stream. */
function openStream(urlStr, { headers, reqs, isAborted, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (u) => {
      if (isAborted()) return reject(new Error('Aborted'));
      let parsed;
      try {
        parsed = new URL(u);
      } catch {
        const e = new Error('Invalid URL');
        e.fatal = true;
        return reject(e);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        const e = new Error('Only http(s) links are supported');
        e.fatal = true;
        return reject(e);
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(parsed, { method: 'GET', headers, timeout }, (res) => {
        const code = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          reqs.delete(req);
          if (++redirects > MAX_REDIRECTS) {
            const e = new Error('Too many redirects');
            e.fatal = true;
            return reject(e);
          }
          return go(new URL(res.headers.location, parsed).toString());
        }
        resolve({ res, req, url: parsed.toString() });
      });
      reqs.add(req);
      req.on('timeout', () => req.destroy(new Error('Connection timed out')));
      req.on('error', (e) => {
        reqs.delete(req);
        reject(e);
      });
      req.on('close', () => reqs.delete(req));
      req.end();
    };
    go(urlStr);
  });
}

function filenameFromDisposition(h) {
  if (!h) return null;
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(h);
  if (m) {
    try {
      return decodeURIComponent(m[2].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  m = /filename\s*=\s*"([^"]+)"/i.exec(h) || /filename\s*=\s*([^;]+)/i.exec(h);
  return m ? m[1].trim() : null;
}

function filenameFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    return decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

function sanitizeFilename(name) {
  let n = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n || 'download';
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function splitName(name) {
  const ext = path.extname(name);
  return [name.slice(0, name.length - ext.length), ext];
}

/** Pick a free file name and atomically reserve it by creating its .part file. */
async function reserveName(dir, name) {
  const [base, ext] = splitName(name);
  for (let i = 0; ; i++) {
    const cand = i ? `${base} (${i})${ext}` : name;
    if (await exists(path.join(dir, cand))) continue;
    try {
      const fh = await fsp.open(path.join(dir, cand + '.part'), 'wx');
      await fh.close();
      return cand;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

function parseChecksum(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  let m = /^(md5|sha1|sha256|sha512)\s*[:=]\s*([a-f0-9]+)$/i.exec(s);
  if (m) return { algo: m[1].toLowerCase(), value: m[2].toLowerCase() };
  if (/^[a-f0-9]+$/i.test(s)) {
    const algo = { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' }[s.length];
    if (algo) return { algo, value: s.toLowerCase() };
  }
  throw new Error('Checksum not recognised. Use e.g. sha256:<hex> or a plain MD5/SHA-1/SHA-256 hash.');
}

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

class DownloadTask extends EventEmitter {
  constructor(o) {
    super();
    this.id = o.id || crypto.randomUUID();
    this.url = o.url;
    this.dir = o.dir;
    this.preferredName = o.preferredName || null;
    this.filename = o.filename || null;
    this.size = o.size ?? null;
    this.resumable = !!o.resumable;
    this.status = o.status || 'queued'; // queued | downloading | verifying | paused | completed | error
    this.error = o.error || null;
    this.etag = o.etag || null;
    this.lastModified = o.lastModified || null;
    this.checksum = o.checksum || null;
    this.checksumOk = o.checksumOk ?? null;
    this.createdAt = o.createdAt || Date.now();
    this.completedAt = o.completedAt || null;
    this.autoResume = !!o.autoResume;
    this.segments = (o.segments || []).map(([start, end, done]) => ({
      start,
      end,
      downloaded: done,
      flushed: done,
      active: false,
    }));

    this.connections = o.connections || 8;
    this.maxRetries = o.maxRetries ?? 6;
    this.userAgent = o.userAgent || DEFAULT_UA;
    this.limiter = o.limiter || new Limiter();

    this.running = false;
    this.speed = 0;
    this._abort = false;
    this._reason = null;
    this._reqs = new Set();
    this._fh = null;
    this._bytesWindow = 0;
    this._streamBytes = 0;
    this._resolved = null;
    this._liveWorkers = 0;
  }

  get partPath() {
    return this.filename ? path.join(this.dir, this.filename + '.part') : null;
  }
  get finalPath() {
    return this.filename ? path.join(this.dir, this.filename) : null;
  }
  get downloaded() {
    if (this.status === 'completed') return this.size ?? this._streamBytes;
    if (!this.resumable) return this._streamBytes;
    let t = 0;
    for (const s of this.segments) t += s.downloaded;
    return t;
  }

  toJSON() {
    return {
      id: this.id,
      url: this.url,
      dir: this.dir,
      preferredName: this.preferredName,
      filename: this.filename,
      size: this.size,
      resumable: this.resumable,
      status: this.status,
      error: this.error,
      etag: this.etag,
      lastModified: this.lastModified,
      checksum: this.checksum,
      checksumOk: this.checksumOk,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      autoResume: this.autoResume,
      segments: this.segments.map((s) => [s.start, s.end, s.flushed]),
    };
  }

  snapshot() {
    const downloaded = this.downloaded;
    const eta =
      this.speed > 0 && this.size != null && this.status === 'downloading'
        ? Math.max(0, (this.size - downloaded) / this.speed)
        : null;
    let connections = 0;
    if (this.running && this.status === 'downloading') {
      connections = this.resumable ? this.segments.filter((s) => s.active).length : 1;
    }
    return {
      id: this.id,
      url: this.url,
      filename: this.filename || this.preferredName || filenameFromUrl(this.url) || this.url,
      dir: this.dir,
      path: this.finalPath,
      size: this.size,
      downloaded,
      resumable: this.resumable,
      status: this.status,
      error: this.error,
      speed: this.speed,
      eta,
      connections,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
      checksum: this.checksum,
      checksumOk: this.checksumOk,
      segments:
        this.resumable && this.status !== 'completed' && this.size
          ? this.segments.map((s) => [s.start, s.end, s.downloaded])
          : null,
    };
  }

  _emit() {
    this.emit('update', this.snapshot());
  }

  /** Stop the transfer. Status becomes "paused" right away. */
  pause(reason = 'pause') {
    if (this.status === 'verifying') return;
    this._reason = reason;
    this._abort = true;
    this._destroyRequests();
    if (this.status === 'downloading') {
      this.status = 'paused';
      this.speed = 0;
      this._emit();
    }
  }

  _destroyRequests() {
    for (const r of this._reqs) r.destroy();
    this._reqs.clear();
  }

  _open(url, headers) {
    return openStream(url, {
      headers,
      reqs: this._reqs,
      isAborted: () => this._abort,
    });
  }

  _baseHeaders() {
    return { 'User-Agent': this.userAgent, 'Accept-Encoding': 'identity', Accept: '*/*' };
  }

  async _retry(fn, attempts) {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (this._abort || e.fatal || i >= attempts) throw e;
        await sleep(Math.min(1000 * 2 ** i, 10000), () => this._abort);
        if (this._abort) throw e;
      }
    }
  }

  /** Ask the server for size, range support and name. */
  async _probe() {
    let { res, url } = await this._open(this.url, { ...this._baseHeaders(), Range: 'bytes=0-0' });
    let code = res.statusCode;
    if (code >= 400 && code !== 416) {
      res.destroy();
      ({ res, url } = await this._open(this.url, this._baseHeaders()));
      code = res.statusCode;
      if (code >= 400) {
        res.destroy();
        throw httpError(code);
      }
    }
    const h = res.headers;
    res.destroy();
    let size = null;
    let resumable = false;
    if (code === 206) {
      const m = /\/(\d+)\s*$/.exec(h['content-range'] || '');
      if (m) {
        size = Number(m[1]);
        resumable = size > 0;
      }
    } else if (code === 416) {
      const m = /\*\/(\d+)/.exec(h['content-range'] || '');
      size = m ? Number(m[1]) : 0;
    } else if (h['content-length'] != null && Number.isFinite(Number(h['content-length']))) {
      size = Number(h['content-length']);
    }
    return {
      size,
      resumable,
      url,
      etag: h.etag || null,
      lastModified: h['last-modified'] || null,
      disposition: h['content-disposition'] || null,
    };
  }

  _plan() {
    const n = Math.max(1, Math.min(this.connections, Math.floor(this.size / MIN_SEGMENT)));
    const part = Math.floor(this.size / n);
    this.segments = [];
    for (let i = 0; i < n; i++) {
      const start = i * part;
      const end = i === n - 1 ? this.size - 1 : start + part - 1;
      this.segments.push({ start, end, downloaded: 0, flushed: 0, active: false });
    }
  }

  async _prepare() {
    await fsp.mkdir(this.dir, { recursive: true });
    const info = await this._retry(() => this._probe(), Math.min(this.maxRetries, 3));
    if (this._abort) return false;

    const changed =
      this.segments.length > 0 &&
      (info.size !== this.size ||
        !info.resumable ||
        (this.etag && info.etag && this.etag !== info.etag));
    if (changed) this.segments = [];

    this.size = info.size;
    this.resumable = info.resumable;
    this.etag = info.etag;
    this.lastModified = info.lastModified;
    this._resolved = info.url;

    if (!this.filename) {
      const raw =
        this.preferredName ||
        filenameFromDisposition(info.disposition) ||
        filenameFromUrl(info.url) ||
        filenameFromUrl(this.url) ||
        'download';
      this.filename = await reserveName(this.dir, sanitizeFilename(raw));
    }

    if (this.segments.length && !(await exists(this.partPath))) this.segments = [];
    if (this.resumable && !this.segments.length) this._plan();
    if (!this.resumable) this.segments = [];
    this._streamBytes = 0;

    try {
      this._fh = await fsp.open(this.partPath, 'r+');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this._fh = await fsp.open(this.partPath, 'w+');
    }
    await this._fh.truncate(this.resumable ? this.size : 0);
    this._emit();
    return true;
  }

  _nextSegment() {
    const idle = this.segments.find((s) => !s.active && s.start + s.downloaded <= s.end);
    if (idle) return idle;
    let best = null;
    let bestRem = 0;
    for (const s of this.segments) {
      if (!s.active) continue;
      const rem = s.end - (s.start + s.downloaded) + 1;
      if (rem > bestRem) {
        best = s;
        bestRem = rem;
      }
    }
    if (best && bestRem >= 2 * MIN_SEGMENT) {
      const mid = best.start + best.downloaded + Math.floor(bestRem / 2);
      const ns = { start: mid, end: best.end, downloaded: 0, flushed: 0, active: false };
      best.end = mid - 1;
      this.segments.push(ns);
      return ns;
    }
    return null;
  }

  _complete() {
    return this.segments.every((s) => s.start + s.flushed > s.end);
  }

  async _downloadSegment(seg) {
    let attempts = 0;
    while (!this._abort) {
      if (seg.start + seg.downloaded > seg.end) return;
      const before = seg.downloaded;
      try {
        const from = seg.start + seg.downloaded;
        const { res } = await this._open(this._resolved, {
          ...this._baseHeaders(),
          Range: `bytes=${from}-${seg.end}`,
        });
        if (res.statusCode !== 206) {
          res.destroy();
          throw httpError(res.statusCode === 200 ? 502 : res.statusCode);
        }
        try {
          for await (const chunk of res) {
            if (this._abort) break;
            let remaining = seg.end - (seg.start + seg.downloaded) + 1;
            if (remaining <= 0) break;
            await this.limiter.consume(Math.min(chunk.length, remaining), () => this._abort);
            if (this._abort) break;
            // The range may have been shortened by a split while we waited.
            remaining = seg.end - (seg.start + seg.downloaded) + 1;
            if (remaining <= 0) break;
            const buf = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            const pos = seg.start + seg.downloaded;
            seg.downloaded += buf.length;
            await this._fh.write(buf, 0, buf.length, pos);
            seg.flushed += buf.length;
            this._bytesWindow += buf.length;
            if (seg.start + seg.downloaded > seg.end) break;
          }
        } finally {
          res.destroy();
        }
        if (this._abort) return;
        if (seg.start + seg.downloaded <= seg.end) throw new Error('Connection closed early');
        return;
      } catch (e) {
        if (this._abort) return;
        if (e.fatal) throw e;
        if (seg.downloaded > before) attempts = 0;
        if (++attempts > this.maxRetries) throw e;
        await sleep(Math.min(1000 * 2 ** (attempts - 1), 15000), () => this._abort);
      }
    }
  }

  async _worker() {
    try {
      while (!this._abort) {
        const seg = this._nextSegment();
        if (!seg) return;
        seg.active = true;
        try {
          await this._downloadSegment(seg);
        } catch (e) {
          // Server is refusing extra connections: retire this one, others carry on.
          if ((e.status === 429 || e.status === 503) && this._liveWorkers > 1) return;
          throw e;
        } finally {
          seg.active = false;
        }
      }
    } finally {
      this._liveWorkers--;
    }
  }

  async _transferSegments() {
    let failure = null;
    const fail = (e) => {
      if (failure || this._abort) return;
      failure = e;
      this._reason = 'error';
      this._abort = true;
      this._destroyRequests();
    };
    for (let round = 0; round < 5 && !this._abort && !this._complete(); round++) {
      const n = round === 0 ? Math.max(1, this.connections) : 1;
      this._liveWorkers = n;
      await Promise.all(Array.from({ length: n }, () => this._worker().catch(fail)));
      if (failure) throw failure;
    }
    if (!this._abort && !this._complete()) throw new Error('Download incomplete');
  }

  async _transferStream() {
    await this._retry(async () => {
      this._streamBytes = 0;
      await this._fh.truncate(0);
      const { res } = await this._open(this._resolved, this._baseHeaders());
      if (res.statusCode !== 200) {
        res.destroy();
        throw httpError(res.statusCode);
      }
      try {
        for await (const chunk of res) {
          if (this._abort) break;
          await this.limiter.consume(chunk.length, () => this._abort);
          if (this._abort) break;
          await this._fh.write(chunk, 0, chunk.length, this._streamBytes);
          this._streamBytes += chunk.length;
          this._bytesWindow += chunk.length;
        }
      } finally {
        res.destroy();
      }
      if (this._abort) return;
      if (this.size != null && this._streamBytes !== this.size) throw new Error('Connection closed early');
    }, this.maxRetries);
    if (!this._abort && this.size == null) this.size = this._streamBytes;
  }

  async _closeFile() {
    if (!this._fh) return;
    const fh = this._fh;
    this._fh = null;
    await fh.close().catch(() => {});
  }

  async _finish() {
    await this._closeFile();
    let name = this.filename;
    if (await exists(path.join(this.dir, name))) {
      name = await reserveName(this.dir, name);
      await fsp.unlink(path.join(this.dir, name + '.part')).catch(() => {});
    }
    await fsp.rename(this.partPath, path.join(this.dir, name));
    this.filename = name;
    this.segments = [];
    if (this.checksum) {
      this.status = 'verifying';
      this._emit();
      try {
        const got = await hashFile(this.finalPath, this.checksum.algo);
        this.checksumOk = got === this.checksum.value;
      } catch {
        this.checksumOk = null;
      }
    }
    this.status = 'completed';
    this.completedAt = Date.now();
  }

  _tick() {
    const now = Date.now();
    const dt = Math.max(0.001, (now - this._lastTick) / 1000);
    this._lastTick = now;
    const inst = this._bytesWindow / dt;
    this._bytesWindow = 0;
    this.speed = this._hasSample ? this.speed * 0.5 + inst * 0.5 : inst;
    this._hasSample = true;
    if (this.status === 'downloading') this._emit();
  }

  /** Run (or resume) the download. Never throws; inspect `status` afterwards. */
  async run() {
    this.running = true;
    this._abort = false;
    this._reason = null;
    this.error = null;
    this.status = 'downloading';
    this.speed = 0;
    this._bytesWindow = 0;
    this._hasSample = false;
    this._lastTick = Date.now();
    this._emit();
    const timer = setInterval(() => this._tick(), 500);
    try {
      if (await this._prepare()) {
        if (this.size === 0) {
          /* empty file, nothing to transfer */
        } else if (this.resumable) {
          await this._transferSegments();
        } else {
          await this._transferStream();
        }
        if (!this._abort) {
          await this._finish();
          this.emit('completed', this.snapshot());
        }
      }
    } catch (e) {
      if (!this._abort || this._reason === 'error') {
        this.status = 'error';
        this.error = e.message || String(e);
      }
    } finally {
      clearInterval(timer);
      this.speed = 0;
      await this._closeFile();
      this.running = false;
      this._emit();
    }
  }

  /** Remove the partial file (used when a download is deleted). */
  async discardPartial() {
    if (this.partPath) await fsp.unlink(this.partPath).catch(() => {});
  }
}

module.exports = {
  DownloadTask,
  Limiter,
  parseChecksum,
  filenameFromUrl,
  MIN_SEGMENT,
  DEFAULT_UA,
};
