import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiUrl } from '../api';

// Secrets live in the Electron main process, encrypted with the OS keychain
// (safeStorage). They are held in memory here but never written to localStorage.
export const SECRET_NAMES = ['openaiKey', 'mistralKey', 'geminiKey', 'githubPat'] as const;
export type SecretName = typeof SECRET_NAMES[number];

interface SettingsState {
  aiProvider: 'ollama' | 'openai' | 'mistral' | 'gemini';
  autoLinkThreshold: number;
  notesDir: string;
  openaiKey: string;
  mistralKey: string;
  geminiKey: string;
  githubPat: string;
  githubRepo: string;
  setAiProvider: (provider: SettingsState['aiProvider']) => void;
  setAutoLinkThreshold: (threshold: number) => void;
  setNotesDir: (dir: string) => void;
  setOpenaiKey: (key: string) => void;
  setMistralKey: (key: string) => void;
  setGeminiKey: (key: string) => void;
  setGithubPat: (pat: string) => void;
  setGithubRepo: (repo: string) => void;
  loadSecrets: () => Promise<void>;
  pushBackendSettings: (ipcToken: string) => Promise<void>;
}

function saveSecret(name: SecretName, value: string) {
  window.smartnotes?.setSecret(name, value).catch((e) => console.error(`Failed to save ${name}`, e));
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => {
      const secretSetter = (name: SecretName) => (value: string) => {
        set({ [name]: value } as Pick<SettingsState, SecretName>);
        saveSecret(name, value);
      };

      return {
        aiProvider: 'ollama',
        autoLinkThreshold: 0.75,
        notesDir: '',
        openaiKey: '',
        mistralKey: '',
        geminiKey: '',
        githubPat: '',
        githubRepo: '',

        setAiProvider: (provider) => set({ aiProvider: provider }),
        setAutoLinkThreshold: (threshold) => set({ autoLinkThreshold: threshold }),

        // Backend-side settings (the auto-link threshold is applied by the indexer)
        pushBackendSettings: async (ipcToken) => {
          try {
            await fetch(apiUrl('/system/settings'), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'X-IPC-Token': ipcToken },
              body: JSON.stringify({ autolink_threshold: get().autoLinkThreshold }),
            });
          } catch (e) {
            console.error('Failed to save settings to backend', e);
          }
        },
        setNotesDir: (dir) => set({ notesDir: dir }),
        setOpenaiKey: secretSetter('openaiKey'),
        setMistralKey: secretSetter('mistralKey'),
        setGeminiKey: secretSetter('geminiKey'),
        setGithubPat: secretSetter('githubPat'),
        setGithubRepo: (repo) => set({ githubRepo: repo }),

        loadSecrets: async () => {
          if (!window.smartnotes?.getSecrets) return;
          const stored = await window.smartnotes.getSecrets();
          // Keep any in-memory value (e.g. one just migrated) the main process hasn't stored yet
          set((state) => {
            const next: Partial<Pick<SettingsState, SecretName>> = {};
            for (const name of SECRET_NAMES) next[name] = stored[name] || state[name];
            return next;
          });
        },
      };
    },
    {
      name: 'smartnotes-settings',
      version: 2,
      // Never persist secrets to localStorage
      partialize: (state) => ({
        aiProvider: state.aiProvider,
        autoLinkThreshold: state.autoLinkThreshold,
        notesDir: state.notesDir,
        githubRepo: state.githubRepo,
      }),
      // v0 stored secrets in plain text: move them to encrypted storage
      migrate: (persisted, version) => {
        const state = { ...(persisted as Record<string, unknown>) };
        if (version < 1) {
          for (const name of SECRET_NAMES) {
            const value = state[name];
            if (typeof value === 'string' && value) saveSecret(name, value);
          }
        }
        if (version < 2 && state.aiProvider === 'sbert') {
          // "SBERT" was never a chat provider; it is the automatic embedding fallback
          state.aiProvider = 'ollama';
        }
        return state as unknown as SettingsState;
      },
    }
  )
);
