'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  list: () => call('dm:list'),
  add: (payload) => call('dm:add', payload),
  pause: (id) => call('dm:pause', id),
  resume: (id) => call('dm:resume', id),
  pauseAll: () => call('dm:pauseAll'),
  resumeAll: () => call('dm:resumeAll'),
  clearCompleted: () => call('dm:clearCompleted'),
  remove: (id, opts) => call('dm:remove', id, opts),
  openFile: (id) => call('dm:openFile', id),
  showInFolder: (id) => call('dm:showInFolder', id),
  chooseDir: () => call('dm:chooseDir'),
  readClipboard: () => call('dm:clipboard'),
  getSettings: () => call('dm:getSettings'),
  setSettings: (patch) => call('dm:setSettings', patch),
  onUpdate: listen('dm:update'),
  onRemoved: listen('dm:removed'),
  onSettings: listen('dm:settings'),
});
