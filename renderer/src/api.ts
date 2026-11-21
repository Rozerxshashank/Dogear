// Backend location. Electron picks a free port at launch and tells us via preload.
let backendBase = 'http://127.0.0.1:8765';

export async function initApi(): Promise<void> {
  if (window.smartnotes?.getBackendUrl) {
    backendBase = await window.smartnotes.getBackendUrl();
  }
}

/** URL for an API path, e.g. apiUrl('/notes/') */
export const apiUrl = (path: string) => `${backendBase}/api${path}`;
