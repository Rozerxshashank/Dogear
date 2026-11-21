import type { SecretName } from './store/settingsStore';

export interface GitSyncResult {
  ok: boolean;
  message: string;
  log: string[];
}

declare global {
  interface Window {
    smartnotes?: {
      getIpcToken: () => Promise<string>;
      getBackendUrl: () => Promise<string>;
      getNotesDir: () => Promise<string>;
      getSecrets: () => Promise<Partial<Record<SecretName, string>>>;
      setSecret: (name: SecretName, value: string) => Promise<boolean>;
      chooseFolder: () => Promise<string | null>;
      gitSync: (action: 'push' | 'pull', repoUrl: string) => Promise<GitSyncResult>;
      setDirty: (noteId: string, isDirty: boolean) => void;
      onFileConflict: (callback: (noteId: string) => void) => void;
      onSyncRefresh: (callback: () => void) => void;
      onBackendStatus: (callback: (status: string) => void) => void;
    };
  }
}
