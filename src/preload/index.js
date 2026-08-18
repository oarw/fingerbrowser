import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  launchProfile: (id) => ipcRenderer.invoke('profiles:launch', id),
  launchBatch: (ids, tile) => ipcRenderer.invoke('profiles:launch-batch', ids, tile),
  stopProfile: (id) => ipcRenderer.invoke('profiles:stop', id),
  getRunning: () => ipcRenderer.invoke('profiles:running'),
  onRunningChanged: (cb) => {
    const listener = (_e, ids) => cb(ids)
    ipcRenderer.on('profiles:running-changed', listener)
    return () => ipcRenderer.removeListener('profiles:running-changed', listener)
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  getKernelStatus: () => ipcRenderer.invoke('kernel:status'),
  installKernel: () => ipcRenderer.invoke('kernel:install'),
  cancelKernelInstall: () => ipcRenderer.invoke('kernel:cancel'),
  openKernelDirectory: () => ipcRenderer.invoke('kernel:open-directory'),
  openKernelSource: () => ipcRenderer.invoke('kernel:open-source'),
  getKernelLog: () => ipcRenderer.invoke('kernel:get-log'),
  clearKernelLog: () => ipcRenderer.invoke('kernel:clear-log'),
  copyKernelLog: () => ipcRenderer.invoke('kernel:copy-log'),
  openKernelLog: () => ipcRenderer.invoke('kernel:open-log'),
  onKernelProgress: (cb) => {
    const listener = (_e, progress) => cb(progress)
    ipcRenderer.on('kernel:progress', listener)
    return () => ipcRenderer.removeListener('kernel:progress', listener)
  },

  randomFingerprint: () => ipcRenderer.invoke('fingerprint:random'),
  randomSeed: () => ipcRenderer.invoke('fingerprint:random-seed'),
  fingerprintOptions: () => ipcRenderer.invoke('fingerprint:options'),
  detectGeo: (proxy) => ipcRenderer.invoke('geo:detect', proxy),

  pickKernel: () => ipcRenderer.invoke('dialog:pick-kernel'),
  pickKernelDirectory: () => ipcRenderer.invoke('dialog:pick-kernel-directory')
}

contextBridge.exposeInMainWorld('api', api)
