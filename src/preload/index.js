import { contextBridge, ipcRenderer } from 'electron'

const api = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  launchProfile: (id) => ipcRenderer.invoke('profiles:launch', id),
  stopProfile: (id) => ipcRenderer.invoke('profiles:stop', id),
  getRunning: () => ipcRenderer.invoke('profiles:running'),
  onRunningChanged: (cb) => {
    const listener = (_e, ids) => cb(ids)
    ipcRenderer.on('profiles:running-changed', listener)
    return () => ipcRenderer.removeListener('profiles:running-changed', listener)
  },

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  randomFingerprint: () => ipcRenderer.invoke('fingerprint:random'),
  randomSeed: () => ipcRenderer.invoke('fingerprint:random-seed'),
  fingerprintOptions: () => ipcRenderer.invoke('fingerprint:options'),

  pickKernel: () => ipcRenderer.invoke('dialog:pick-kernel')
}

contextBridge.exposeInMainWorld('api', api)
