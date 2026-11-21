/**
 * One-time move from the app's old name (SmartNotes) to Dogear.
 *
 * - Notes folder: Documents/SmartNotes -> Documents/Dogear (a rename on the same
 *   disk, so it is instant and atomic). The backend then rewrites stored paths.
 * - App data (database, search index, paired phones, settings, chat history):
 *   copied, not moved, so the old folder stays as a backup.
 * - Encrypted secrets are NOT copied: macOS ties their key to the app name, so
 *   the renamed app cannot read them. The user is asked to re-enter keys once.
 *
 * Pure Node (no Electron imports) so it can be tested with temporary folders.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface MigrationPaths {
  oldNotesDir: string;
  newNotesDir: string;
  oldDataDir: string;
  newDataDir: string;
}

export interface MigrationResult {
  notesMovedFrom: string | null;
  dataCopied: string[];
  secretsNeedReentry: boolean;
}

// Things worth carrying over from the old data folder. Caches, locks and logs are not.
const DATA_ITEMS = [
  'smartnotes.db',
  'smartnotes.db-wal',
  'smartnotes.db-shm',
  'chromadb',
  'phone-devices.json',
  'phone-settings.json',
  'Local Storage', // renderer settings (AI provider, GitHub repo) and chat history
];

const MARKER = 'migrated-from-smartnotes.json';

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isEmptyOrMissing(dir: string) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).length === 0;
  } catch {
    return true;
  }
}

function sameLocation(a: string, b: string) {
  // On case-insensitive disks "SmartNotes" and "smartnotes" are one folder
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
}

export function migrateFromSmartNotes(p: MigrationPaths): MigrationResult {
  const result: MigrationResult = { notesMovedFrom: null, dataCopied: [], secretsNeedReentry: false };
  const marker = path.join(p.newDataDir, MARKER);
  if (fs.existsSync(marker)) return result; // already done

  // 1. Notes folder: only when the new one doesn't exist yet (never merge or overwrite)
  if (isDir(p.oldNotesDir) && !sameLocation(p.oldNotesDir, p.newNotesDir) && isEmptyOrMissing(p.newNotesDir)) {
    if (isDir(p.newNotesDir)) fs.rmdirSync(p.newNotesDir); // empty placeholder
    fs.mkdirSync(path.dirname(p.newNotesDir), { recursive: true });
    fs.renameSync(p.oldNotesDir, p.newNotesDir);
    result.notesMovedFrom = p.oldNotesDir;
  }

  // 2. App data: copy items the new folder doesn't already have
  if (isDir(p.oldDataDir) && !sameLocation(p.oldDataDir, p.newDataDir)) {
    fs.mkdirSync(p.newDataDir, { recursive: true });
    for (const item of DATA_ITEMS) {
      const from = path.join(p.oldDataDir, item);
      const to = path.join(p.newDataDir, item);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.cpSync(from, to, { recursive: true });
        result.dataCopied.push(item);
      }
    }
    result.secretsNeedReentry = fs.existsSync(path.join(p.oldDataDir, 'secrets.json'));
  }

  if (result.notesMovedFrom || result.dataCopied.length) {
    fs.mkdirSync(p.newDataDir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2));
  }
  return result;
}
