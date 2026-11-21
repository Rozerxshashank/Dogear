import { create } from 'zustand';
import { apiUrl } from '../api';

interface BackendState {
  ollamaStatus: 'unknown' | 'running' | 'stopped';
  chatModelReady: boolean;
  embedModelReady: boolean;
  isIndexing: boolean;
  indexingNoteId: string | null;
  checkOllamaStatus: (ipcToken: string) => Promise<void>;
  pollIndexingStatus: (ipcToken: string) => Promise<void>;
}

export const useBackendStore = create<BackendState>((set) => ({
  ollamaStatus: 'unknown',
  chatModelReady: false,
  embedModelReady: false,
  isIndexing: false,
  indexingNoteId: null,

  checkOllamaStatus: async (ipcToken: string) => {
    try {
      const res = await fetch(apiUrl('/system/status'), { headers: { 'X-IPC-Token': ipcToken } });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      set({
        ollamaStatus: data.ollama === 'running' ? 'running' : 'stopped',
        chatModelReady: !!data.chat_model_ready,
        embedModelReady: !!data.embed_model_ready,
      });
    } catch {
      set({ ollamaStatus: 'unknown' });
    }
  },

  pollIndexingStatus: async (ipcToken: string) => {
    try {
      const res = await fetch(apiUrl('/indexing/status'), { headers: { 'X-IPC-Token': ipcToken } });
      if (res.ok) {
        const data = await res.json();
        set({ isIndexing: data.is_indexing, indexingNoteId: data.current_note_id });
      }
    } catch {
      // backend restarting; the next poll will catch up
    }
  },
}));
