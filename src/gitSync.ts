/**
 * GitHub backup/sync for the notes folder, using isomorphic-git (pure JS, no
 * system git needed). Runs in the main process so the token never reaches the
 * renderer.
 */
import * as fs from 'fs';
import * as path from 'path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

const BRANCH = 'main';
const REMOTE = 'origin';
const AUTHOR = { name: 'SmartNotes', email: 'smartnotes@users.noreply.local' };
const DEFAULT_GITIGNORE = '.DS_Store\nThumbs.db\n*.tmp\n.smartnotes-*\n.obsidian/\n.trash/\n';

export interface SyncResult {
  ok: boolean;
  message: string;
  log: string[];
}

/** Accept "owner/repo", a github.com URL, or any https git URL. */
export function normalizeRepoUrl(input: string): string | null {
  const value = (input || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return `https://github.com/${value.replace(/\.git$/, '')}.git`;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function auth(token: string) {
  return {
    onAuth: () => ({ username: 'x-access-token', password: token }),
    onAuthFailure: () => ({ cancel: true as const }),
  };
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await git.resolveRef({ fs, dir, ref });
    return true;
  } catch {
    return false;
  }
}

async function ensureRepo(dir: string, url: string, log: string[]) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    await git.init({ fs, dir, defaultBranch: BRANCH });
    log.push('Initialised a git repository in the notes folder.');
  }
  const gitignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, DEFAULT_GITIGNORE);

  const remotes = await git.listRemotes({ fs, dir });
  const origin = remotes.find((r) => r.remote === REMOTE);
  if (origin && origin.url !== url) {
    await git.deleteRemote({ fs, dir, remote: REMOTE });
  }
  if (!origin || origin.url !== url) {
    await git.addRemote({ fs, dir, remote: REMOTE, url });
  }
}

/** Stage every change (including deletions) and commit if anything changed. */
async function commitAll(dir: string, message: string, log: string[]): Promise<boolean> {
  const matrix = await git.statusMatrix({ fs, dir });
  let changed = 0;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue; // unchanged
    if (workdir === 0) {
      await git.remove({ fs, dir, filepath });
    } else {
      await git.add({ fs, dir, filepath });
    }
    changed++;
  }
  if (changed === 0) return false;
  await git.commit({ fs, dir, message, author: AUTHOR });
  log.push(`Committed ${changed} changed file${changed === 1 ? '' : 's'}.`);
  return true;
}

function describe(err: unknown): string {
  const e = err as { code?: string; message?: string; data?: { statusCode?: number; filepaths?: string[] } };
  if (e?.code === 'HttpError' && (e.data?.statusCode === 401 || e.data?.statusCode === 403)) {
    return 'GitHub rejected the token. Check that it is valid and has Contents read/write access to this repository.';
  }
  if (e?.code === 'UserCanceledError') {
    return 'GitHub rejected the token. Check that it is valid and has access to this repository.';
  }
  if (e?.code === 'HttpError' && e.data?.statusCode === 404) {
    return 'Repository not found. Check the repository URL and that the token can access it.';
  }
  if (e?.code === 'PushRejectedError') {
    return 'GitHub has changes you do not have yet. Pull first, then push.';
  }
  if (e?.code === 'MergeConflictError') {
    const files = e.data?.filepaths?.join(', ');
    return `Pull stopped: the same notes changed both here and on GitHub${files ? ` (${files})` : ''}. Nothing was changed locally.`;
  }
  return e?.message || String(err);
}

export async function push(dir: string, repoUrl: string, token: string): Promise<SyncResult> {
  const log: string[] = [];
  const url = normalizeRepoUrl(repoUrl);
  if (!url) return { ok: false, message: 'Enter the repository as owner/repo or an https URL.', log };
  if (!token) return { ok: false, message: 'Add a GitHub token in Settings first.', log };
  try {
    await ensureRepo(dir, url, log);
    await commitAll(dir, `SmartNotes backup ${new Date().toISOString()}`, log);
    if (!(await refExists(dir, BRANCH))) {
      return { ok: true, message: 'Nothing to push yet: the notes folder is empty.', log };
    }
    const result = await git.push({ fs, http, dir, remote: REMOTE, ref: BRANCH, ...auth(token) });
    if (!result.ok) {
      return { ok: false, message: result.error || 'Push failed.', log };
    }
    log.push(`Pushed to ${url}`);
    return { ok: true, message: 'Pushed your notes to GitHub.', log };
  } catch (err) {
    return { ok: false, message: describe(err), log };
  }
}

export async function pull(dir: string, repoUrl: string, token: string): Promise<SyncResult> {
  const log: string[] = [];
  const url = normalizeRepoUrl(repoUrl);
  if (!url) return { ok: false, message: 'Enter the repository as owner/repo or an https URL.', log };
  if (!token) return { ok: false, message: 'Add a GitHub token in Settings first.', log };
  try {
    await ensureRepo(dir, url, log);
    // Commit local edits first so a pull can never overwrite them silently
    await commitAll(dir, `SmartNotes local changes ${new Date().toISOString()}`, log);

    const fetched = await git.fetch({ fs, http, dir, remote: REMOTE, ref: BRANCH, singleBranch: true, ...auth(token) });
    const remoteRef = `refs/remotes/${REMOTE}/${BRANCH}`;
    if (!fetched.fetchHead || !(await refExists(dir, remoteRef))) {
      return { ok: true, message: 'GitHub repository is empty: nothing to pull.', log };
    }

    if (!(await refExists(dir, BRANCH))) {
      // Fresh local folder: adopt the remote history
      const oid = await git.resolveRef({ fs, dir, ref: remoteRef });
      await git.writeRef({ fs, dir, ref: `refs/heads/${BRANCH}`, value: oid, force: true });
      await git.checkout({ fs, dir, ref: BRANCH, force: true });
      log.push('Downloaded notes from GitHub.');
      return { ok: true, message: 'Pulled your notes from GitHub.', log };
    }

    const merge = await git.merge({
      fs, dir, ours: BRANCH, theirs: remoteRef, author: AUTHOR, abortOnConflict: true,
      message: `SmartNotes merge ${new Date().toISOString()}`,
    });
    if (merge.alreadyMerged) {
      return { ok: true, message: 'Already up to date.', log };
    }
    await git.checkout({ fs, dir, ref: BRANCH });
    log.push(merge.fastForward ? 'Fast-forwarded to GitHub.' : 'Merged changes from GitHub.');
    return { ok: true, message: 'Pulled the latest notes from GitHub.', log };
  } catch (err) {
    return { ok: false, message: describe(err), log };
  }
}
