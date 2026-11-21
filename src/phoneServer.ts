/**
 * Phone access: serves a small mobile web app on the local network and lets
 * paired phones read, search, create and edit notes through the backend.
 *
 * Security model
 * - Off unless the user turns it on; listens only while running.
 * - Only private-network clients (home Wi-Fi ranges) are accepted.
 * - Pairing uses a one-time code (from a QR code) that expires after 5 minutes,
 *   works once, and is burned after repeated wrong guesses.
 * - Each phone gets its own random key; only a hash is stored. Keys can be revoked.
 * - Phones can't delete notes, can't edit a note that has unsaved changes on the
 *   Mac, and can't overwrite a note that changed since they opened it.
 * - Plain HTTP: traffic on the Wi-Fi is not encrypted. The UI says so.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface PhoneDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
}

export interface PhoneServerOptions {
  /** Folder for phone-devices.json */
  dataDir: string;
  /** Folder with the mobile web app (index.html, icon.png, manifest.webmanifest) */
  phoneDir: string;
  backendUrl: () => string;
  ipcToken: string;
  /** True while the Mac has unsaved edits for this note */
  isNoteDirty: (noteId: string) => boolean;
  /** Called after a phone creates or edits a note */
  onNotesChanged: () => void;
  /** Called when a phone pairs or is removed */
  onDevicesChanged?: () => void;
  preferredPort?: number;
  /** Which client addresses may connect (default: private networks only) */
  allowAddress?: (address: string) => boolean;
  now?: () => number;
}

export const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_FAILURES = 8;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const NOTE_ID = /^[0-9a-f-]{36}$/i;
const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/icon.png': 'icon.png',
  '/manifest.webmanifest': 'manifest.webmanifest',
};
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** RFC 1918 / link-local / unique-local addresses, plus loopback. */
export function isPrivateAddress(address: string): boolean {
  const addr = address.replace(/^::ffff:/i, '');
  if (addr === '127.0.0.1' || addr === '::1') return true;
  const v4 = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const lower = addr.toLowerCase();
  return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

/** IPv4 addresses this Mac has on private networks, Wi-Fi/Ethernet first. */
export function lanAddresses(): string[] {
  const result: { name: string; address: string }[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateAddress(info.address)) {
        result.push({ name, address: info.address });
      }
    }
  }
  const rank = (n: string) => (n.startsWith('en') ? 0 : n.startsWith('eth') || n.startsWith('wl') ? 1 : 2);
  return result.sort((x, y) => rank(x.name) - rank(y.name)).map((r) => r.address);
}

/** Reject Host headers that aren't an IP or a .local name (blocks DNS rebinding). */
function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return /^[\d.]+$/.test(name) || name.includes(':') || name === 'localhost' || name.endsWith('.local');
}

function deviceNameFrom(userAgent = ''): string {
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/Android/.test(userAgent)) return 'Android phone';
  return 'Phone';
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export class PhoneServer {
  private server: http.Server | null = null;
  private devices: PhoneDevice[] = [];
  private pairing: { code: string; expiresAt: number; failures: number } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  port = 0;

  constructor(private opts: PhoneServerOptions) {
    this.devices = this.loadDevices();
  }

  private get now() {
    return (this.opts.now || Date.now)();
  }

  private get devicesFile() {
    return path.join(this.opts.dataDir, 'phone-devices.json');
  }

  // ---------- lifecycle ----------

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    try {
      this.port = await listen(this.opts.preferredPort ?? 0);
    } catch {
      this.port = await listen(0); // preferred port busy: take any free one
    }
    this.server = server;
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.pairing = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }

  // ---------- pairing and devices ----------

  /** A new one-time code; any previous code stops working. */
  createPairingCode(): { code: string; expiresAt: number } {
    // 8 characters from an unambiguous alphabet (~40 bits), single use, 5 minutes
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    this.pairing = { code, expiresAt: this.now + PAIRING_TTL_MS, failures: 0 };
    return { code, expiresAt: this.pairing.expiresAt };
  }

  listDevices(): Omit<PhoneDevice, 'tokenHash'>[] {
    return this.devices.map(({ tokenHash: _hash, ...rest }) => rest);
  }

  revokeDevice(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.saveDevices(true);
    this.opts.onDevicesChanged?.();
    return true;
  }

  private pair(code: unknown, userAgent: string | undefined) {
    const pairing = this.pairing;
    if (!pairing || this.now > pairing.expiresAt) {
      this.pairing = null;
      throw new HttpError(410, 'This pairing code has expired. Show a new QR code on your Mac.');
    }
    const given = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const ok = given.length === pairing.code.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pairing.code));
    if (!ok) {
      pairing.failures += 1;
      if (pairing.failures >= MAX_PAIRING_FAILURES) this.pairing = null;
      throw new HttpError(403, 'That pairing code is not valid.');
    }
    this.pairing = null; // single use
    const token = crypto.randomBytes(32).toString('base64url');
    const device: PhoneDevice = {
      id: crypto.randomUUID(),
      name: deviceNameFrom(userAgent),
      tokenHash: sha256(token),
      createdAt: this.now,
      lastSeen: this.now,
    };
    this.devices.push(device);
    this.saveDevices(true);
    this.opts.onDevicesChanged?.();
    return { token, deviceId: device.id, name: device.name };
  }

  private authenticate(req: http.IncomingMessage): PhoneDevice {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'Not paired.');
    const hash = sha256(token);
    const device = this.devices.find((d) => d.tokenHash.length === hash.length &&
      crypto.timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(hash)));
    if (!device) throw new HttpError(401, 'This phone was removed or never paired.');
    device.lastSeen = this.now;
    this.saveDevices(false);
    return device;
  }

  private loadDevices(): PhoneDevice[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.devicesFile, 'utf-8'));
      return Array.isArray(data.devices) ? data.devices : [];
    } catch {
      return [];
    }
  }

  private saveDevices(immediate: boolean) {
    const write = () => {
      this.saveTimer = null;
      fs.mkdirSync(this.opts.dataDir, { recursive: true });
      fs.writeFileSync(this.devicesFile, JSON.stringify({ devices: this.devices }, null, 2), { mode: 0o600 });
    };
    if (immediate) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      write();
    } else if (!this.saveTimer) {
      this.saveTimer = setTimeout(write, 5000); // lastSeen updates are batched
      this.saveTimer.unref?.();
    }
  }

  // ---------- HTTP ----------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const security = {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    };
    try {
      const remote = req.socket.remoteAddress || '';
      const allow = this.opts.allowAddress || isPrivateAddress;
      if (!allow(remote)) throw new HttpError(403, 'Only devices on your local network can connect.');
      if (!isAllowedHost(req.headers.host)) throw new HttpError(421, 'Unexpected host.');

      const url = new URL(req.url || '/', 'http://phone.local');

      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        return this.serveStatic(STATIC_FILES[url.pathname], res, security);
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');

      let result: unknown;
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const body = await readJson(req);
        result = this.pair(body.code, req.headers['user-agent']);
      } else {
        const device = this.authenticate(req);
        result = await this.api(req, url, device);
      }
      sendJson(res, 200, result, security);
    } catch (err) {
      const e = err instanceof HttpError ? err : new HttpError(500, 'Something went wrong on your Mac.');
      if (!(err instanceof HttpError)) console.error('[Phone]', err);
      sendJson(res, e.status, { error: e.message, ...e.extra }, security);
    }
  }

  private serveStatic(file: string, res: http.ServerResponse, security: Record<string, string>) {
    const full = path.join(this.opts.phoneDir, file);
    let data: Buffer;
    try {
      data = fs.readFileSync(full);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    res.writeHead(200, {
      ...security,
      'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...(file.endsWith('.html')
        ? {
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          }
        : {}),
    });
    res.end(data);
  }

  private async backend(method: string, apiPath: string, body?: unknown) {
    const res = await fetch(`${this.opts.backendUrl()}/api${apiPath}`, {
      method,
      headers: { 'X-IPC-Token': this.opts.ipcToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : 'Your Mac could not do that.';
      throw new HttpError(res.status === 404 ? 404 : 502, detail);
    }
    return data;
  }

  private async api(req: http.IncomingMessage, url: URL, device: PhoneDevice): Promise<unknown> {
    const method = req.method || 'GET';
    const match = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
    const noteId = match?.[1];
    if (noteId && !NOTE_ID.test(noteId)) throw new HttpError(404, 'Note not found.');

    if (method === 'GET' && url.pathname === '/api/session') {
      return { ok: true, device: device.name };
    }

    if (method === 'GET' && url.pathname === '/api/notes') {
      const notes: any[] = await this.backend('GET', '/notes/');
      return notes.map((n) => ({
        id: n.id,
        title: n.title,
        folder: n.folder || '',
        updated_at: n.updated_at,
        preview: preview(n.content || '', n.title),
      }));
    }

    if (method === 'GET' && url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').slice(0, 300);
      if (!q.trim()) return [];
      const results: any[] = await this.backend('GET', `/search/?q=${encodeURIComponent(q)}&k=20`);
      return results.map((r) => ({ id: r.note_id, title: r.title, preview: r.text || '' }));
    }

    if (method === 'GET' && noteId) {
      const n = await this.backend('GET', `/notes/${noteId}`);
      return { id: n.id, title: n.title, folder: n.folder || '', content: n.content || '', updated_at: n.updated_at };
    }

    if (method === 'POST' && url.pathname === '/api/notes') {
      const body = await readJson(req);
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'Untitled Note';
      const content = typeof body.content === 'string' ? body.content : '';
      const folder = typeof body.folder === 'string' ? body.folder : '';
      const n = await this.backend('POST', '/notes/', { title, content, folder });
      this.opts.onNotesChanged();
      return { id: n.id, title: n.title, folder: n.folder || '', content: n.content || '', updated_at: n.updated_at };
    }

    if (method === 'PUT' && noteId) {
      const body = await readJson(req);
      if (this.opts.isNoteDirty(noteId)) {
        throw new HttpError(409, 'This note is open with unsaved changes on your Mac. Try again in a moment.', { reason: 'mac_editing' });
      }
      const current = await this.backend('GET', `/notes/${noteId}`);
      if (typeof body.base_updated_at !== 'number' || body.base_updated_at !== current.updated_at) {
        throw new HttpError(409, 'This note changed since you opened it.', {
          reason: 'changed',
          current: { id: current.id, title: current.title, content: current.content || '', updated_at: current.updated_at },
        });
      }
      const patch: Record<string, string> = {};
      if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 200);
      if (typeof body.content === 'string') patch.content = body.content;
      const n = await this.backend('PUT', `/notes/${noteId}`, patch);
      this.opts.onNotesChanged();
      return { id: n.id, title: n.title, folder: n.folder || '', content: n.content || '', updated_at: n.updated_at };
    }

    if (method === 'DELETE') throw new HttpError(405, 'Notes can only be deleted on your Mac.');
    throw new HttpError(404, 'Not found.');
  }
}

function preview(content: string, title: string): string {
  const lines = content.split('\n').filter((l) => l.trim());
  // Skip a first heading that repeats the title ("# Deep Work" or "# Deep Work — Cal Newport")
  if (/^#/.test(lines[0] || '') && lines[0].replace(/^#+\s*/, '').trim().toLowerCase().startsWith(title.trim().toLowerCase())) {
    lines.shift();
  }
  return lines.join(' ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t, alias) => alias || t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*|[*_`~>]|^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string>) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'That note is too large to send from a phone.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid request.'));
      }
    });
    req.on('error', reject);
  });
}
