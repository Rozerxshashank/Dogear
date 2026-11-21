import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// --- Secrets (API keys, GitHub token) ---
// Encrypted with the OS keychain via safeStorage and kept out of renderer localStorage.
const SECRET_NAMES = new Set(['openaiKey', 'mistralKey', 'geminiKey', 'githubPat']);
const secretsPath = () => path.join(app.getPath('userData'), 'secrets.json');
// Used only when OS encryption is unavailable: secrets then last for this session only.
const sessionOnlySecrets: Record<string, string> = {};

export function readEncryptedSecrets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(secretsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

export function getAllSecrets(): Record<string, string> {
  const result: Record<string, string> = { ...sessionOnlySecrets };
  if (!safeStorage.isEncryptionAvailable()) return result;
  for (const [name, encoded] of Object.entries(readEncryptedSecrets())) {
    if (!SECRET_NAMES.has(name)) continue;
    try {
      result[name] = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch (e) {
      console.error(`Failed to decrypt secret ${name}`, e);
    }
  }
  return result;
}

export function setSecret(name: string, value: string): boolean {
  if (!SECRET_NAMES.has(name) || typeof value !== 'string') return false;
  if (!safeStorage.isEncryptionAvailable()) {
    if (value) sessionOnlySecrets[name] = value;
    else delete sessionOnlySecrets[name];
    return false; // not persisted
  }
  const stored = readEncryptedSecrets();
  if (value) {
    stored[name] = safeStorage.encryptString(value).toString('base64');
  } else {
    delete stored[name];
  }
  fs.mkdirSync(path.dirname(secretsPath()), { recursive: true });
  fs.writeFileSync(secretsPath(), JSON.stringify(stored), { encoding: 'utf-8', mode: 0o600 });
  return true;
}

export function getSecret(name: string): string {
  return getAllSecrets()[name] || '';
}
