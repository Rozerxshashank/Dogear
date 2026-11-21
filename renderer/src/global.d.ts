import type { SecretName } from './store/settingsStore';

export interface PhoneDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}

export interface PhoneState {
  enabled: boolean;
  port: number;
  addresses: string[];
  devices: PhoneDevice[];
}

export interface PhonePairing {
  code?: string;
  expiresAt?: number;
  url?: string;
  address?: string;
  qrSvg?: string;
  error?: string;
}

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
      phone: {
        getState: () => Promise<PhoneState>;
        setEnabled: (enabled: boolean) => Promise<PhoneState>;
        pair: () => Promise<PhonePairing>;
        revoke: (id: string) => Promise<PhoneState>;
        onDevicesChanged: (callback: () => void) => void;
      };
      setDirty: (noteId: string, isDirty: boolean) => void;
      onFileConflict: (callback: (noteId: string) => void) => void;
      onSyncRefresh: (callback: () => void) => void;
      onBackendStatus: (callback: (status: string) => void) => void;
    };
  }
}
