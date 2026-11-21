// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PhoneServer, isPrivateAddress, PAIRING_TTL_MS } from './phoneServer';

// A fake backend standing in for the Python API
type Note = { id: string; title: string; content: string; folder: string; updated_at: number };
const ID = '11111111-1111-1111-1111-111111111111';

let backend: http.Server;
let backendUrl = '';
let notes: Note[];
let backendCalls: string[];

let tmp: string;
let server: PhoneServer;
let base = '';
let dirty: Set<string>;
let changed = 0;
let clock = 1_000_000;

function startBackend() {
  return new Promise<void>((resolve) => {
    backend = http.createServer((req, res) => {
      backendCalls.push(`${req.method} ${req.url} token=${req.headers['x-ipc-token']}`);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        const m = req.url!.match(/^\/api\/notes\/([^/?]+)$/);
        if (req.method === 'GET' && req.url === '/api/notes/') return send(200, notes);
        if (req.method === 'GET' && req.url!.startsWith('/api/search/')) return send(200, [{ note_id: ID, title: 'Sourdough', text: 'Bake at 250' }]);
        if (req.method === 'GET' && m) return send(notes.find((n) => n.id === m[1]) ? 200 : 404, notes.find((n) => n.id === m[1]) ?? { detail: 'Note not found' });
        if (req.method === 'POST' && req.url === '/api/notes/') {
          const n = { id: '22222222-2222-2222-2222-222222222222', folder: '', updated_at: 5, ...JSON.parse(body) };
          notes.push(n);
          return send(200, n);
        }
        if (req.method === 'PUT' && m) {
          const n = notes.find((x) => x.id === m[1])!;
          Object.assign(n, JSON.parse(body), { updated_at: n.updated_at + 1 });
          return send(200, n);
        }
        send(404, { detail: 'nope' });
      });
    });
    backend.listen(0, '127.0.0.1', () => {
      backendUrl = `http://127.0.0.1:${(backend.address() as any).port}`;
      resolve();
    });
  });
}

async function call(method: string, p: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function pairPhone() {
  const { code } = server.createPairingCode();
  const r = await call('POST', '/api/pair', { body: { code } });
  return r.data.token as string;
}

beforeEach(async () => {
  notes = [{ id: ID, title: 'Sourdough', content: '# Sourdough\n\nBake at **250°C**.', folder: 'Home', updated_at: 3 }];
  backendCalls = [];
  dirty = new Set();
  changed = 0;
  clock = 1_000_000;
  await startBackend();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-test-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>SmartNotes</title>');
  server = new PhoneServer({
    dataDir: tmp,
    phoneDir: tmp,
    backendUrl: () => backendUrl,
    ipcToken: 'ipc-secret',
    isNoteDirty: (id) => dirty.has(id),
    onNotesChanged: () => { changed++; },
    now: () => clock,
  });
  const port = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await server.stop();
  await new Promise((r) => backend.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('network rules', () => {
  test('only private-network addresses are allowed', () => {
    for (const a of ['192.168.1.20', '10.0.0.4', '172.16.5.1', '172.31.0.9', '::ffff:192.168.0.2', 'fe80::1', 'fd12::3', '127.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2a00:1450::1', '::ffff:1.2.3.4']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  test('the mobile page is served, other files are not', async () => {
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect((await fetch(base + '/../phone-devices.json')).status).toBe(404);
  });

  test('requests with an unexpected Host header are refused (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve) => {
      http.get(base + '/', { headers: { Host: 'evil.example.com' } }, (res) => resolve(res.statusCode!));
    });
    expect(status).toBe(421);
  });
});

describe('pairing', () => {
  test('API needs a paired key', async () => {
    expect((await call('GET', '/api/notes')).status).toBe(401);
    expect((await call('GET', '/api/notes', { token: 'made-up' })).status).toBe(401);
  });

  test('a code pairs exactly one phone, and only the hash of its key is stored', async () => {
    const { code } = server.createPairingCode();
    const first = await call('POST', '/api/pair', { body: { code } });
    expect(first.status).toBe(200);
    expect(first.data.name).toBe('iPhone');
    expect((await call('POST', '/api/pair', { body: { code } })).status).toBe(410);

    const stored = fs.readFileSync(path.join(tmp, 'phone-devices.json'), 'utf-8');
    expect(stored).not.toContain(first.data.token);
    expect((await call('GET', '/api/session', { token: first.data.token })).status).toBe(200);
  });

  test('codes expire after five minutes', async () => {
    const { code } = server.createPairingCode();
    clock += PAIRING_TTL_MS + 1;
    expect((await call('POST', '/api/pair', { body: { code } })).status).toBe(410);
  });

  test('repeated wrong guesses burn the code', async () => {
    const { code } = server.createPairingCode();
    for (let i = 0; i < 8; i++) {
      expect((await call('POST', '/api/pair', { body: { code: 'WRONG123' } })).status).toBe(403);
    }
    expect((await call('POST', '/api/pair', { body: { code } })).status).toBe(410);
  });

  test('a removed phone loses access immediately', async () => {
    const token = await pairPhone();
    const [device] = server.listDevices();
    expect(server.revokeDevice(device.id)).toBe(true);
    expect((await call('GET', '/api/notes', { token })).status).toBe(401);
  });

  test('paired phones survive an app restart', async () => {
    const token = await pairPhone();
    await server.stop();
    server = new PhoneServer({
      dataDir: tmp, phoneDir: tmp, backendUrl: () => backendUrl, ipcToken: 'ipc-secret',
      isNoteDirty: () => false, onNotesChanged: () => {},
    });
    base = `http://127.0.0.1:${await server.start()}`;
    expect((await call('GET', '/api/notes', { token })).status).toBe(200);
  });
});

describe('notes from the phone', () => {
  test('list, open and search go through the backend with the app token', async () => {
    const token = await pairPhone();
    const list = await call('GET', '/api/notes', { token });
    expect(list.data).toEqual([{ id: ID, title: 'Sourdough', folder: 'Home', updated_at: 3, preview: 'Bake at 250°C.' }]);
    expect((await call('GET', `/api/notes/${ID}`, { token })).data.content).toContain('250°C');
    expect((await call('GET', '/api/search?q=bread', { token })).data[0].title).toBe('Sourdough');
    expect(backendCalls.every((c) => c.endsWith('token=ipc-secret'))).toBe(true);
  });

  test('creating and editing notes refreshes the Mac', async () => {
    const token = await pairPhone();
    const created = await call('POST', '/api/notes', { token, body: { title: 'From phone', content: 'Hi' } });
    expect(created.status).toBe(200);
    const edited = await call('PUT', `/api/notes/${ID}`, { token, body: { content: 'New text', base_updated_at: 3 } });
    expect(edited.status).toBe(200);
    expect(edited.data.content).toBe('New text');
    expect(changed).toBe(2);
  });

  test('an edit is refused while the Mac has unsaved changes to that note', async () => {
    const token = await pairPhone();
    dirty.add(ID);
    const r = await call('PUT', `/api/notes/${ID}`, { token, body: { content: 'x', base_updated_at: 3 } });
    expect(r.status).toBe(409);
    expect(r.data.reason).toBe('mac_editing');
    expect(notes[0].content).not.toBe('x');
  });

  test('an edit is refused if the note changed since the phone opened it', async () => {
    const token = await pairPhone();
    const r = await call('PUT', `/api/notes/${ID}`, { token, body: { content: 'stale', base_updated_at: 2 } });
    expect(r.status).toBe(409);
    expect(r.data.reason).toBe('changed');
    expect(r.data.current.updated_at).toBe(3);
  });

  test('phones cannot delete notes, and bad ids are rejected', async () => {
    const token = await pairPhone();
    expect((await call('DELETE', `/api/notes/${ID}`, { token })).status).toBe(405);
    expect((await call('GET', '/api/notes/..%2F..%2Fsecrets', { token })).status).toBe(404);
  });
});
