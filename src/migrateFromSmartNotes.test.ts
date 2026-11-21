// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateFromSmartNotes, MigrationPaths } from './migrateFromSmartNotes';

let root: string;
let p: MigrationPaths;
const write = (file: string, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-test-'));
  p = {
    oldNotesDir: path.join(root, 'Documents', 'SmartNotes'),
    newNotesDir: path.join(root, 'Documents', 'Dogear'),
    oldDataDir: path.join(root, 'Support', 'SmartNotes'),
    newDataDir: path.join(root, 'Support', 'Dogear'),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('moving from SmartNotes to Dogear', () => {
  test('moves the notes folder and copies the app data', () => {
    write(path.join(p.oldNotesDir, 'Work', 'Plan.md'), '# Plan');
    write(path.join(p.oldNotesDir, '.git', 'HEAD'), 'ref');
    write(path.join(p.oldDataDir, 'smartnotes.db'), 'db');
    write(path.join(p.oldDataDir, 'chromadb', 'index.bin'), 'vectors');
    write(path.join(p.oldDataDir, 'phone-devices.json'), '{}');
    write(path.join(p.oldDataDir, 'Local Storage', 'leveldb', '000.log'), 'settings');
    write(path.join(p.oldDataDir, 'secrets.json'), '{"geminiKey":"encrypted"}');
    write(path.join(p.oldDataDir, 'logs', 'main.log'), 'old logs');

    const r = migrateFromSmartNotes(p);

    expect(r.notesMovedFrom).toBe(p.oldNotesDir);
    expect(fs.readFileSync(path.join(p.newNotesDir, 'Work', 'Plan.md'), 'utf-8')).toBe('# Plan');
    expect(fs.existsSync(path.join(p.newNotesDir, '.git', 'HEAD'))).toBe(true); // GitHub backup history comes along
    expect(fs.existsSync(p.oldNotesDir)).toBe(false);

    expect(r.dataCopied.sort()).toEqual(['Local Storage', 'chromadb', 'phone-devices.json', 'smartnotes.db']);
    expect(fs.existsSync(path.join(p.oldDataDir, 'smartnotes.db'))).toBe(true); // copied, old kept as backup
    expect(fs.existsSync(path.join(p.newDataDir, 'secrets.json'))).toBe(false); // can't be decrypted by the new app
    expect(fs.existsSync(path.join(p.newDataDir, 'logs'))).toBe(false);
    expect(r.secretsNeedReentry).toBe(true);
  });

  test('never overwrites or merges into an existing Dogear notes folder', () => {
    write(path.join(p.oldNotesDir, 'Old.md'), 'old');
    write(path.join(p.newNotesDir, 'New.md'), 'new');
    const r = migrateFromSmartNotes(p);
    expect(r.notesMovedFrom).toBeNull();
    expect(fs.readdirSync(p.newNotesDir)).toEqual(['New.md']);
    expect(fs.existsSync(path.join(p.oldNotesDir, 'Old.md'))).toBe(true);
  });

  test('moves into an empty placeholder folder', () => {
    write(path.join(p.oldNotesDir, 'Old.md'), 'old');
    fs.mkdirSync(p.newNotesDir, { recursive: true });
    expect(migrateFromSmartNotes(p).notesMovedFrom).toBe(p.oldNotesDir);
    expect(fs.existsSync(path.join(p.newNotesDir, 'Old.md'))).toBe(true);
  });

  test('does not replace data the new app already has', () => {
    write(path.join(p.oldDataDir, 'smartnotes.db'), 'old db');
    write(path.join(p.newDataDir, 'smartnotes.db'), 'new db');
    migrateFromSmartNotes(p);
    expect(fs.readFileSync(path.join(p.newDataDir, 'smartnotes.db'), 'utf-8')).toBe('new db');
  });

  test('runs only once', () => {
    write(path.join(p.oldNotesDir, 'A.md'));
    migrateFromSmartNotes(p);
    write(path.join(p.oldNotesDir, 'B.md')); // old app used again afterwards
    const second = migrateFromSmartNotes(p);
    expect(second.notesMovedFrom).toBeNull();
    expect(fs.existsSync(path.join(p.newNotesDir, 'B.md'))).toBe(false);
  });

  test('fresh installs do nothing', () => {
    const r = migrateFromSmartNotes(p);
    expect(r).toEqual({ notesMovedFrom: null, dataCopied: [], secretsNeedReentry: false });
    expect(fs.existsSync(p.newDataDir)).toBe(false);
  });
});
