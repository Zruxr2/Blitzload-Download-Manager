'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { items: new Map(), rows: new Map(), filter: 'all', query: '', settings: null };

  // ---------- formatting ----------
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return '?';
    let i = 0;
    while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${UNITS[i]}`;
  }
  const fmtSpeed = (n) => `${fmtBytes(n)}/s`;
  function fmtEta(s) {
    if (s == null) return '';
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  }
  const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  function extOf(name) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
    return m ? m[1].toUpperCase() : 'FILE';
  }
  const HUES = [
    [/^(ZIP|RAR|7Z|TAR|GZ|BZ2|XZ|ZST)$/, 35],
    [/^(MP4|MKV|AVI|MOV|WEBM|WMV)$/, 285],
    [/^(MP3|FLAC|WAV|AAC|OGG|M4A)$/, 330],
    [/^(JPG|JPEG|PNG|GIF|WEBP|SVG|BMP)$/, 160],
    [/^(PDF|DOC|DOCX|TXT|EPUB|XLS|XLSX|PPT|PPTX)$/, 5],
    [/^(EXE|MSI|DMG|DEB|RPM|APK|APPIMAGE|ISO|PKG)$/, 200],
  ];
  const hueFor = (ext) => (HUES.find(([re]) => re.test(ext)) || [0, 215])[1];

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids) el.append(kid);
    return el;
  }

  const ICONS = {
    pause: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.5-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z"/></svg>',
    open: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  };
  function actionBtn(cls, icon, label, onclick) {
    const b = h('button', { class: `act ${cls}`, title: label, 'aria-label': label, onclick });
    b.innerHTML = icon;
    return b;
  }

  // ---------- rows ----------
  function createRow(id) {
    const q = {};
    const row = h('article', { class: 'row' },
      (q.badge = h('div', { class: 'badge' })),
      h('div', { class: 'body' },
        h('div', { class: 'top' }, (q.name = h('div', { class: 'name' })), (q.chip = h('span', { class: 'chip' }))),
        (q.bar = h('div', { class: 'bar' }, (q.fill = h('div', { class: 'fill' })), (q.segs = h('div', { class: 'segs' })))),
        h('div', { class: 'meta' }, (q.progress = h('span')), (q.extra = h('span', { class: 'm-extra' }))),
      ),
      h('div', { class: 'actions' },
        (q.toggle = actionBtn('go', ICONS.pause, 'Pause', () => {
          const it = state.items.get(id);
          if (!it) return;
          (it.status === 'paused' || it.status === 'error' ? window.api.resume : window.api.pause)(id);
        })),
        (q.open = actionBtn('', ICONS.open, 'Open file', async () => {
          const err = await window.api.openFile(id);
          if (err) toast(err);
        })),
        (q.folder = actionBtn('', ICONS.folder, 'Show in folder', () => window.api.showInFolder(id))),
        actionBtn('', ICONS.trash, 'Remove', () => askRemove(id)),
      ),
    );
    row.dataset.id = id;
    row._q = q;
    return row;
  }

  const CHIP = { downloading: 'Downloading', verifying: 'Verifying', paused: 'Paused', queued: 'Queued', completed: 'Done', error: 'Failed' };

  function patchRow(row, it) {
    const q = row._q;
    const ext = extOf(it.filename);
    q.badge.textContent = ext;
    q.badge.style.setProperty('--hue', hueFor(ext));
    q.name.textContent = it.filename;
    q.name.title = it.url;
    q.chip.textContent = CHIP[it.status] || it.status;
    row.className = `row status-${it.status}${it.size == null ? ' unknown' : ''}`;

    const pct = it.size ? Math.min(100, (it.downloaded / it.size) * 100) : it.status === 'completed' ? 100 : 0;
    const segmented = it.segments && it.segments.length > 0 && it.status !== 'completed';
    q.bar.classList.toggle('segmented', !!segmented);
    if (segmented) {
      const live = it.status === 'downloading';
      while (q.segs.children.length < it.segments.length) q.segs.append(h('div', { class: 'seg' }));
      while (q.segs.children.length > it.segments.length) q.segs.lastChild.remove();
      it.segments.forEach(([start, , done], i) => {
        const el = q.segs.children[i];
        el.style.left = `${(start / it.size) * 100}%`;
        el.style.width = `${(done / it.size) * 100}%`;
        el.classList.toggle('live', live);
      });
    } else {
      q.segs.textContent = '';
      q.fill.style.width = it.status === 'downloading' && it.size == null ? '' : `${pct}%`;
    }

    let progress = '';
    let extra = '';
    let extraCls = 'm-extra';
    switch (it.status) {
      case 'downloading':
        progress = `${fmtBytes(it.downloaded)} of ${it.size != null ? fmtBytes(it.size) : 'unknown size'}` + (it.size ? ` (${pct.toFixed(0)}%)` : '');
        extra = it.speed > 0 ? `${fmtSpeed(it.speed)}${it.eta != null ? ` · ${fmtEta(it.eta)} left` : ''} · ${it.connections} connection${it.connections === 1 ? '' : 's'}` : 'Connecting…';
        break;
      case 'verifying':
        progress = 'Checking file integrity…';
        break;
      case 'paused':
        progress = it.size ? `${fmtBytes(it.downloaded)} of ${fmtBytes(it.size)} (${pct.toFixed(0)}%)` : 'Paused';
        if (!it.resumable && it.downloaded > 0) { extra = 'This server cannot resume, so it will restart'; extraCls += ' warn'; }
        break;
      case 'queued':
        progress = 'Waiting for a free slot';
        break;
      case 'error':
        progress = it.size ? `${fmtBytes(it.downloaded)} of ${fmtBytes(it.size)}` : 'Download failed';
        extra = it.error || 'Something went wrong';
        extraCls += ' bad';
        break;
      case 'completed':
        progress = `${fmtBytes(it.size)} · ${it.completedAt ? fmtDate(it.completedAt) : ''}`;
        if (it.checksumOk === true) extra = 'Checksum matches';
        else if (it.checksumOk === false) { extra = 'Checksum does not match. Download it again.'; extraCls += ' bad'; }
        break;
    }
    q.progress.textContent = progress;
    q.extra.textContent = extra;
    q.extra.className = extraCls;

    const done = it.status === 'completed';
    q.toggle.hidden = done || it.status === 'verifying';
    q.open.hidden = !done;
    const resumeIt = it.status === 'paused' || it.status === 'error';
    q.toggle.innerHTML = resumeIt ? ICONS.play : ICONS.pause;
    const label = it.status === 'error' ? 'Retry' : resumeIt ? 'Resume' : 'Pause';
    q.toggle.title = label;
    q.toggle.setAttribute('aria-label', label);
  }

  // ---------- list state ----------
  const matches = (it) => {
    const f = state.filter;
    const ok =
      f === 'all' ||
      (f === 'active' && (it.status === 'downloading' || it.status === 'verifying')) ||
      (f === 'paused' && (it.status === 'paused' || it.status === 'queued')) ||
      (f === 'completed' && it.status === 'completed') ||
      (f === 'error' && it.status === 'error');
    return ok && (!state.query || it.filename.toLowerCase().includes(state.query) || it.url.toLowerCase().includes(state.query));
  };

  function refresh() {
    let visible = 0;
    const counts = { all: 0, active: 0, paused: 0, completed: 0, error: 0 };
    let speed = 0;
    let active = 0;
    for (const it of state.items.values()) {
      counts.all++;
      if (it.status === 'downloading' || it.status === 'verifying') { counts.active++; speed += it.speed || 0; active++; }
      else if (it.status === 'paused' || it.status === 'queued') counts.paused++;
      else if (it.status === 'completed') counts.completed++;
      else if (it.status === 'error') counts.error++;
      const row = state.rows.get(it.id);
      if (row) {
        const show = matches(it);
        row.hidden = !show;
        if (show) visible++;
      }
    }
    for (const [k, v] of Object.entries(counts)) document.querySelector(`[data-count="${k}"]`).textContent = v;
    $('totalSpeed').textContent = fmtSpeed(speed);
    const waiting = counts.paused;
    $('statusText').textContent = active ? `${active} downloading` : counts.all ? 'Nothing downloading' : 'Idle';
    $('statusRight').textContent = waiting ? `${waiting} paused or queued` : '';
    const s = state.settings;
    if (s) {
      $('limitInfo').textContent = s.speedLimitKBps ? `Limit ${fmtSpeed(s.speedLimitKBps * 1024)}` : 'No speed limit';
    }

    const empty = $('empty');
    empty.hidden = visible > 0;
    if (visible === 0) {
      const filtered = counts.all > 0;
      $('emptyTitle').textContent = filtered ? 'Nothing matches' : 'No downloads yet';
      $('emptyText').textContent = filtered ? 'Try another filter or clear the search.' : 'Paste a link anywhere in this window, drop one here, or choose Add download.';
    }
  }

  function upsert(it) {
    const prev = state.items.get(it.id);
    state.items.set(it.id, it);
    let row = state.rows.get(it.id);
    if (!row) {
      row = createRow(it.id);
      state.rows.set(it.id, row);
      $('list').prepend(row);
    }
    patchRow(row, it);
    if (!prev || prev.status !== it.status || it.status === 'downloading') refresh();
    else refresh();
  }

  function drop(id) {
    state.items.delete(id);
    const row = state.rows.get(id);
    if (row) row.remove();
    state.rows.delete(id);
    refresh();
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 4000);
  }

  // ---------- dialogs ----------
  const extractUrls = (text) => (String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || []).map((u) => u.replace(/[),.;]+$/, ''));
  const anyDialogOpen = () => document.querySelector('dialog[open]');

  async function openAdd(prefill) {
    let text = prefill || '';
    if (!text) {
      const urls = extractUrls(await window.api.readClipboard());
      text = urls.join('\n');
    }
    $('addUrls').value = text;
    $('addDir').value = state.settings.downloadDir;
    $('addChecksum').value = '';
    $('addErr').textContent = '';
    $('addDlg').showModal();
    $('addUrls').focus();
    $('addUrls').select();
  }

  $('addBtn').addEventListener('click', () => openAdd());
  $('addCancel').addEventListener('click', () => $('addDlg').close());
  $('addBrowse').addEventListener('click', async () => {
    const dir = await window.api.chooseDir();
    if (dir) $('addDir').value = dir;
  });
  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const urls = extractUrls($('addUrls').value);
    if (!urls.length) {
      $('addErr').textContent = 'Enter at least one link that starts with http:// or https://.';
      return;
    }
    const results = await window.api.add({ urls, dir: $('addDir').value, checksum: $('addChecksum').value });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      $('addUrls').value = failed.map((r) => r.url).join('\n');
      $('addErr').textContent = failed.map((r) => `${r.url}\n${r.error}`).join('\n');
      return;
    }
    $('addDlg').close();
    if (state.filter !== 'all' && state.filter !== 'active') setFilter('all');
  });

  function openSettings() {
    const s = state.settings;
    $('setDir').value = s.downloadDir;
    $('setConn').value = s.connections;
    $('setConnOut').textContent = s.connections;
    $('setConcurrent').value = s.maxConcurrent;
    const mb = s.speedLimitKBps >= 1024 && s.speedLimitKBps % 1024 === 0;
    $('setUnit').value = mb ? '1024' : '1';
    $('setLimit').value = mb ? s.speedLimitKBps / 1024 : s.speedLimitKBps;
    $('setRetries').value = s.maxRetries;
    $('setResume').checked = s.resumeOnStartup;
    $('setUA').value = s.userAgent;
    $('settingsDlg').showModal();
  }
  $('settingsBtn').addEventListener('click', openSettings);
  $('setCancel').addEventListener('click', () => $('settingsDlg').close());
  $('setConn').addEventListener('input', () => ($('setConnOut').textContent = $('setConn').value));
  $('setBrowse').addEventListener('click', async () => {
    const dir = await window.api.chooseDir();
    if (dir) $('setDir').value = dir;
  });
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.settings = await window.api.setSettings({
      downloadDir: $('setDir').value,
      connections: Number($('setConn').value),
      maxConcurrent: Number($('setConcurrent').value),
      speedLimitKBps: Number($('setLimit').value || 0) * Number($('setUnit').value),
      maxRetries: Number($('setRetries').value),
      resumeOnStartup: $('setResume').checked,
      userAgent: $('setUA').value,
    });
    $('settingsDlg').close();
    refresh();
    toast('Settings saved');
  });

  let removeId = null;
  function askRemove(id) {
    const it = state.items.get(id);
    if (!it) return;
    removeId = id;
    const done = it.status === 'completed';
    $('removeTitle').textContent = done ? 'Remove from list' : 'Cancel and remove';
    $('removeText').textContent = done
      ? `Remove ${it.filename} from the list?`
      : `Stop ${it.filename} and delete the partly downloaded data?`;
    $('removeFileRow').hidden = !done;
    $('removeFile').checked = false;
    $('removeDlg').showModal();
  }
  $('removeCancel').addEventListener('click', () => $('removeDlg').close());
  $('removeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = removeId;
    $('removeDlg').close();
    if (id) await window.api.remove(id, { deleteFile: $('removeFile').checked });
  });

  // ---------- toolbar, filters, search ----------
  function setFilter(f) {
    state.filter = f;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.filter === f));
    refresh();
  }
  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) setFilter(b.dataset.filter);
  });
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    refresh();
  });
  $('pauseAllBtn').addEventListener('click', () => window.api.pauseAll());
  $('resumeAllBtn').addEventListener('click', () => window.api.resumeAll());
  $('clearBtn').addEventListener('click', () => window.api.clearCompleted());

  // Paste a link anywhere to start adding it.
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (anyDialogOpen() || (t && /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
    const urls = extractUrls(e.clipboardData.getData('text'));
    if (urls.length) openAdd(urls.join('\n'));
  });
  // Drop a link onto the window.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const urls = extractUrls(text);
    if (urls.length && !anyDialogOpen()) openAdd(urls.join('\n'));
  });

  // ---------- boot ----------
  (async () => {
    state.settings = await window.api.getSettings();
    const items = await window.api.list();
    items.sort((a, b) => a.createdAt - b.createdAt).forEach(upsert);
    refresh();
    window.api.onUpdate(upsert);
    window.api.onRemoved(drop);
    window.api.onSettings((s) => {
      state.settings = s;
      refresh();
    });
  })();
})();
