import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useNotesStore, type Note } from '../store/notesStore';

const note = (id: string, content = ''): Note => ({
  id, title: id, content, folder: '', created_at: 1, updated_at: 1,
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(handler);
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  useNotesStore.setState({
    notes: [note('a', 'old a'), note('b', 'old b')],
    activeNoteId: 'a',
    draft: null,
    isDirty: false,
    isSaving: false,
    saveError: null,
    ipcToken: 'token',
  });
});

describe('notes store', () => {
  test('switching notes saves the pending draft first', async () => {
    const fetchMock = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ...note('a'), ...body, updated_at: 2 }), { status: 200 });
    });
    useNotesStore.getState().setDraft('a', 'typed just now');
    await useNotesStore.getState().setActiveNote('b');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/notes/a');
    const state = useNotesStore.getState();
    expect(state.activeNoteId).toBe('b');
    expect(state.notes.find((n) => n.id === 'a')?.content).toBe('typed just now');
  });

  test('a failed save keeps the note dirty and reports the error', async () => {
    mockFetch(() => new Response(JSON.stringify({ detail: 'disk full' }), { status: 500 }));
    useNotesStore.getState().setDraft('a', 'precious text');
    const ok = await useNotesStore.getState().saveDraft();

    const state = useNotesStore.getState();
    expect(ok).toBe(false);
    expect(state.isDirty).toBe(true);
    expect(state.draft?.content).toBe('precious text');
    expect(state.saveError).toContain('disk full');
  });

  test('edits typed during a save are not lost', async () => {
    let resolve!: (r: Response) => void;
    mockFetch(() => new Promise<Response>((r) => { resolve = r; }));
    useNotesStore.getState().setDraft('a', 'first');
    const saving = useNotesStore.getState().saveDraft();
    useNotesStore.getState().setDraft('a', 'first and more');
    resolve(new Response(JSON.stringify({ ...note('a'), content: 'first', updated_at: 2 }), { status: 200 }));
    await saving;

    const state = useNotesStore.getState();
    expect(state.isDirty).toBe(true);
    expect(state.draft?.content).toBe('first and more');
  });

  test('a note deleted elsewhere is deselected on refresh', async () => {
    mockFetch(() => new Response(JSON.stringify([note('b')]), { status: 200 }));
    await useNotesStore.getState().fetchNotes();
    expect(useNotesStore.getState().activeNoteId).toBeNull();
  });
});
