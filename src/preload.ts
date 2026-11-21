import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('smartnotes', {
  getIpcToken: () => ipcRenderer.invoke('get-ipc-token'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  getNotesDir: () => ipcRenderer.invoke('get-notes-dir'),
  getSecrets: () => ipcRenderer.invoke('secrets:get-all'),
  setSecret: (name: string, value: string) => ipcRenderer.invoke('secrets:set', name, value),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  gitSync: (action: 'push' | 'pull', repoUrl: string) => ipcRenderer.invoke('git:sync', action, repoUrl),
  phone: {
    getState: () => ipcRenderer.invoke('phone:get-state'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('phone:set-enabled', enabled),
    pair: () => ipcRenderer.invoke('phone:pair'),
    revoke: (id: string) => ipcRenderer.invoke('phone:revoke', id),
    onDevicesChanged: (callback: () => void) => {
      ipcRenderer.removeAllListeners('phone-devices-changed');
      ipcRenderer.on('phone-devices-changed', () => callback());
    },
  },
  setDirty: (noteId: string, isDirty: boolean) => ipcRenderer.send('set-dirty', { noteId, isDirty }),
  onFileConflict: (callback: (noteId: string) => void) => {
    ipcRenderer.on('file-conflict', (_event, noteId) => callback(noteId));
  },
  onSyncRefresh: (callback: () => void) => {
    ipcRenderer.on('sync-refresh', () => callback());
  },
  onBackendStatus: (callback: (status: string) => void) => {
    ipcRenderer.on('backend-status', (_event, status) => callback(status));
  },
});
