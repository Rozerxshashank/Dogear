import { create } from 'zustand';
import { apiUrl } from '../api';

export interface Note {
  id: string;
  title: string;
  content: string;
  folder: string;
  created_at: number;
  updated_at: number;
}

interface Draft {
  noteId: string;
  title: string;
  content: string;
}

interface NotesState {
  notes: Note[];
  activeNoteId: string | null;
  isLoading: boolean;
  isDirty: boolean;
  isSaving: boolean;
  saveError: string | null;
  ipcToken: string | null;
  /** Unsaved editor state for the active note */
  draft: Draft | null;
  /** Bumped when the editor must reload the active note from the store */
  reloadToken: number;
  fetchNotes: () => Promise<void>;
  createNote: (folder?: string) => Promise<void>;
  setActiveNote: (id: string | null) => Promise<void>;
  setDraft: (title: string, content: string) => void;
  saveDraft: () => Promise<boolean>;
  moveNote: (id: string, folder: string) => Promise<void>;
  reloadFromFile: (id: string) => Promise<void>;
  setIpcToken: (token: string) => void;
  deleteNote: (id: string) => Promise<void>;
}

function markDirty(noteId: string | null, dirty: boolean) {
  if (noteId) window.smartnotes?.setDirty?.(noteId, dirty);
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export const useNotesStore = create<NotesState>((set, get) => {
  const headers = (json = false): Record<string, string> => ({
    'X-IPC-Token': get().ipcToken || '',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  const replaceNote = (note: Note) =>
    set((s) => ({ notes: [note, ...s.notes.filter((n) => n.id !== note.id)].sort((a, b) => b.updated_at - a.updated_at) }));

  return {
    notes: [],
    activeNoteId: null,
    isLoading: false,
    isDirty: false,
    isSaving: false,
    saveError: null,
    ipcToken: null,
    draft: null,
    reloadToken: 0,

    setIpcToken: (token) => set({ ipcToken: token }),

    fetchNotes: async () => {
      if (!get().ipcToken) return;
      set({ isLoading: true });
      try {
        const res = await fetch(apiUrl('/notes/'), { headers: headers() });
        if (!res.ok) throw new Error(await errorText(res));
        const notes: Note[] = await res.json();
        const { activeNoteId } = get();
        set({
          notes,
          isLoading: false,
          // The active note may have been deleted outside the app
          ...(activeNoteId && !notes.some((n) => n.id === activeNoteId) ? { activeNoteId: null, draft: null, isDirty: false } : {}),
        });
      } catch (e) {
        console.error('Failed to fetch notes', e);
        set({ isLoading: false });
      }
    },

    createNote: async (folder = '') => {
      if (!get().ipcToken) return;
      await get().saveDraft();
      try {
        const res = await fetch(apiUrl('/notes/'), {
          method: 'POST',
          headers: headers(true),
          body: JSON.stringify({ title: 'Untitled Note', content: '', folder }),
        });
        if (!res.ok) throw new Error(await errorText(res));
        const note: Note = await res.json();
        replaceNote(note);
        set({ activeNoteId: note.id, draft: null, isDirty: false, saveError: null });
      } catch (e) {
        set({ saveError: `Could not create note: ${(e as Error).message}` });
      }
    },

    setActiveNote: async (id) => {
      const { activeNoteId } = get();
      if (id === activeNoteId) return;
      // Never drop unsaved edits when switching notes
      await get().saveDraft();
      markDirty(activeNoteId, false);
      set({ activeNoteId: id, draft: null, isDirty: false, saveError: null });
    },

    setDraft: (title, content) => {
      const { activeNoteId } = get();
      if (!activeNoteId) return;
      set({ draft: { noteId: activeNoteId, title, content }, isDirty: true });
      markDirty(activeNoteId, true);
    },

    saveDraft: async () => {
      const { draft, ipcToken } = get();
      if (!draft || !ipcToken) return true;
      set({ isSaving: true });
      try {
        const res = await fetch(apiUrl(`/notes/${draft.noteId}`), {
          method: 'PUT',
          headers: headers(true),
          body: JSON.stringify({ title: draft.title, content: draft.content }),
        });
        if (!res.ok) throw new Error(await errorText(res));
        const saved: Note = await res.json();
        replaceNote(saved);
        // Only clear the draft if nothing was typed while the request was in flight
        if (get().draft === draft) {
          set({ draft: null, isDirty: false });
          markDirty(draft.noteId, false);
        }
        set({ isSaving: false, saveError: null });
        return true;
      } catch (e) {
        set({ isSaving: false, saveError: `Not saved: ${(e as Error).message}` });
        return false;
      }
    },

    moveNote: async (id, folder) => {
      if (id === get().activeNoteId) await get().saveDraft();
      try {
        const res = await fetch(apiUrl(`/notes/${id}`), {
          method: 'PUT',
          headers: headers(true),
          body: JSON.stringify({ folder }),
        });
        if (!res.ok) throw new Error(await errorText(res));
        replaceNote(await res.json());
      } catch (e) {
        set({ saveError: `Could not move note: ${(e as Error).message}` });
      }
    },

    reloadFromFile: async (id) => {
      try {
        const res = await fetch(apiUrl(`/notes/${id}/reload-from-file`), { method: 'POST', headers: headers() });
        if (!res.ok) throw new Error(await errorText(res));
        replaceNote(await res.json());
        if (get().activeNoteId === id) {
          markDirty(id, false);
          set((s) => ({ draft: null, isDirty: false, reloadToken: s.reloadToken + 1 }));
        }
      } catch (e) {
        set({ saveError: `Could not load the file version: ${(e as Error).message}` });
      }
    },

    deleteNote: async (id) => {
      try {
        const res = await fetch(apiUrl(`/notes/${id}`), { method: 'DELETE', headers: headers() });
        if (!res.ok && res.status !== 404) throw new Error(await errorText(res));
        markDirty(id, false);
        set((s) => ({
          notes: s.notes.filter((n) => n.id !== id),
          ...(s.activeNoteId === id ? { activeNoteId: null, draft: null, isDirty: false } : {}),
        }));
      } catch (e) {
        set({ saveError: `Could not delete note: ${(e as Error).message}` });
      }
    },
  };
});
