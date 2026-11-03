'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { DownloadTask, Limiter, parseChecksum, DEFAULT_UA } = require('./engine');

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

class DownloadManager extends EventEmitter {
  constructor({ dataDir, defaultDownloadDir }) {
    super();
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.downloadsFile = path.join(dataDir, 'downloads.json');
    this.settings = {
      downloadDir: defaultDownloadDir,
      maxConcurrent: 3,
      connections: 8,
      speedLimitKBps: 0,
      maxRetries: 6,
      resumeOnStartup: true,
      userAgent: '',
    };
    this.tasks = new Map();
    this.limiter = new Limiter();
    this._saveTimer = null;
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    try {
      Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')));
    } catch {
      /* first run */
    }
    this.limiter.setRate(this.settings.speedLimitKBps * 1024);

    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(this.downloadsFile, 'utf8'));
    } catch {
      /* first run */
    }
    for (const o of saved) {
      try {
        const t = new DownloadTask({ ...o, limiter: this.limiter });
        if (t.status === 'downloading' || t.status === 'queued' || (t.autoResume && t.status === 'paused')) {
          t.status = this.settings.resumeOnStartup ? 'queued' : 'paused';
        } else if (t.status === 'verifying') {
          t.status = 'completed';
        }
        t.autoResume = false;
        this._register(t);
      } catch {
        /* skip corrupt entry */
      }
    }
    this._schedule();
  }

  _register(task) {
    this.tasks.set(task.id, task);
    task.on('update', (snap) => {
      this.emit('update', snap);
      this._saveSoon();
    });
    task.on('completed', (snap) => this.emit('completed', snap));
  }

  list() {
    return [...this.tasks.values()].map((t) => t.snapshot());
  }

  add({ url, dir, filename, checksum }) {
    url = String(url || '').trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('That is not a valid link.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http and https links are supported.');
    }
    const task = new DownloadTask({
      url,
      dir: dir || this.settings.downloadDir,
      preferredName: filename || null,
      checksum: parseChecksum(checksum),
      limiter: this.limiter,
    });
    this._register(task);
    this.emit('update', task.snapshot());
    this._saveSoon(true);
    this._schedule();
    return task.snapshot();
  }

  _start(t) {
    t.connections = this.settings.connections;
    t.maxRetries = this.settings.maxRetries;
    t.userAgent = this.settings.userAgent || DEFAULT_UA;
    t._runPromise = t.run().finally(() => {
      this._saveSoon(true);
      this._schedule();
    });
  }

  _schedule() {
    const running = [...this.tasks.values()].filter((t) => t.running).length;
    let free = this.settings.maxConcurrent - running;
    for (const t of this.tasks.values()) {
      if (free <= 0) break;
      if (t.status === 'queued' && !t.running) {
        this._start(t);
        free--;
      }
    }
  }

  pause(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.autoResume = false;
    if (t.status === 'queued') {
      t.status = 'paused';
      t._emit();
    } else if (t.status === 'downloading') {
      t.pause();
    }
    this._saveSoon(true);
  }

  resume(id) {
    const t = this.tasks.get(id);
    if (!t || (t.status !== 'paused' && t.status !== 'error')) return;
    t.error = null;
    t.status = 'queued';
    t._emit();
    this._schedule();
  }

  pauseAll() {
    for (const id of this.tasks.keys()) this.pause(id);
  }

  resumeAll() {
    for (const id of this.tasks.keys()) this.resume(id);
  }

  async remove(id, { deleteFile = false } = {}) {
    const t = this.tasks.get(id);
    if (!t) return;
    if (t.running) {
      t.pause('remove');
      await t._runPromise;
    }
    if (t.status === 'completed') {
      if (deleteFile && t.finalPath) await fsp.unlink(t.finalPath).catch(() => {});
    } else {
      await t.discardPartial();
    }
    this.tasks.delete(id);
    this.emit('removed', id);
    this._saveSoon(true);
    this._schedule();
  }

  clearCompleted() {
    for (const t of [...this.tasks.values()]) {
      if (t.status === 'completed') {
        this.tasks.delete(t.id);
        this.emit('removed', t.id);
      }
    }
    this._saveSoon(true);
  }

  setSettings(patch) {
    const s = this.settings;
    if (typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) s.downloadDir = patch.downloadDir.trim();
    if ('maxConcurrent' in patch) s.maxConcurrent = clamp(patch.maxConcurrent, 1, 10, s.maxConcurrent);
    if ('connections' in patch) s.connections = clamp(patch.connections, 1, 32, s.connections);
    if ('speedLimitKBps' in patch) s.speedLimitKBps = clamp(patch.speedLimitKBps, 0, 10_000_000, s.speedLimitKBps);
    if ('maxRetries' in patch) s.maxRetries = clamp(patch.maxRetries, 0, 20, s.maxRetries);
    if ('resumeOnStartup' in patch) s.resumeOnStartup = !!patch.resumeOnStartup;
    if (typeof patch.userAgent === 'string') s.userAgent = patch.userAgent.trim();
    this.limiter.setRate(s.speedLimitKBps * 1024);
    this._writeSettings();
    this.emit('settings', { ...s });
    this._schedule();
    return { ...s };
  }

  _writeSettings() {
    this._atomicWrite(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  _atomicWrite(file, text) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('Could not save', file, e.message);
    }
  }

  _saveSoon(now = false) {
    if (now) return this.saveNow();
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.saveNow(), 2000);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this._atomicWrite(this.downloadsFile, JSON.stringify([...this.tasks.values()].map((t) => t.toJSON())));
  }

  /** Stop everything, remember what was active, and write state to disk. */
  async shutdown() {
    const runs = [];
    for (const t of this.tasks.values()) {
      if (t.running || t.status === 'queued') t.autoResume = true;
      if (t.running) {
        t.pause();
        runs.push(t._runPromise);
      } else if (t.status === 'queued') {
        t.status = 'paused';
      }
    }
    await Promise.race([Promise.allSettled(runs), new Promise((r) => setTimeout(r, 5000))]);
    this.saveNow();
  }
}

module.exports = { DownloadManager };
