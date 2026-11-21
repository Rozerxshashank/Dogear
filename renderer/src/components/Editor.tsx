import React, { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { useNotesStore } from '../store/notesStore';
import { WikilinkExtension } from './WikilinkExtension';
import { SlashCommand } from './SlashCommand';
import { EditorToolbar } from './EditorToolbar';
import { getNoteContent, setNoteContent } from '../markdown';

const AUTOSAVE_MS = 1000;

export const Editor: React.FC = () => {
  const activeNoteId = useNotesStore((state) => state.activeNoteId);
  const activeNote = useNotesStore((state) => state.notes.find((n) => n.id === state.activeNoteId));
  const isDirty = useNotesStore((state) => state.isDirty);
  const isSaving = useNotesStore((state) => state.isSaving);
  const saveError = useNotesStore((state) => state.saveError);
  const reloadToken = useNotesStore((state) => state.reloadToken);
  const setDraft = useNotesStore((state) => state.setDraft);
  const saveDraft = useNotesStore((state) => state.saveDraft);

  const [localTitle, setLocalTitle] = useState('');
  const titleRef = useRef('');
  const loadingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveDraft(); }, AUTOSAVE_MS);
  };

  const editor = useEditor({
    extensions: [StarterKit, Markdown, WikilinkExtension, SlashCommand],
    content: '',
    onUpdate: ({ editor }) => {
      if (loadingRef.current) return;
      setDraft(titleRef.current, getNoteContent(editor as any));
      scheduleSave();
    },
  });

  // Load the note into the editor when switching notes or after "Use file version"
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!editor) return;
    const note = useNotesStore.getState().notes.find((n) => n.id === activeNoteId);
    loadingRef.current = true;
    setNoteContent(editor as any, note?.content ?? '');
    loadingRef.current = false;
    setLocalTitle(note?.title ?? '');
    titleRef.current = note?.title ?? '';
    loadedFor.current = note ? `${note.id}:${note.updated_at}` : null;
  }, [activeNoteId, reloadToken, editor]);

  // Apply edits made outside the app (file watcher) when there are no local edits
  useEffect(() => {
    if (!editor || !activeNote || isDirty) return;
    const key = `${activeNote.id}:${activeNote.updated_at}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    if (getNoteContent(editor as any) !== activeNote.content) {
      loadingRef.current = true;
      setNoteContent(editor as any, activeNote.content);
      loadingRef.current = false;
    }
    if (activeNote.title !== titleRef.current) {
      setLocalTitle(activeNote.title);
      titleRef.current = activeNote.title;
    }
  }, [activeNote?.updated_at, editor, isDirty]);

  // Save pending edits on unmount and before the window closes
  useEffect(() => {
    const flush = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void useNotesStore.getState().saveDraft();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, []);

  if (!activeNote) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--color-text-secondary)',
        fontFamily: 'inherit'
      }}>
        No notes yet — press ⌘N to create one
      </div>
    );
  }

  return (
    <div style={{ padding: 'var(--spacing-lg) var(--spacing-xl)', maxWidth: '800px', margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-md)' }}>
        <input
          type="text"
          value={localTitle}
          onChange={(e) => {
            setLocalTitle(e.target.value);
            titleRef.current = e.target.value;
            if (editor) {
              setDraft(e.target.value, getNoteContent(editor as any));
              scheduleSave();
            }
          }}
          style={{
            fontSize: 'var(--font-size-h1)',
            fontWeight: 'bold',
            color: 'var(--color-text-primary)',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            flex: 1
          }}
          placeholder="Note Title"
          aria-label="Note title"
        />
        <div style={{
          fontSize: 'var(--font-size-small)',
          color: 'var(--color-text-secondary)',
          opacity: 0.8,
          marginTop: 'var(--spacing-sm)'
        }}>
          {saveError ? (
            <span style={{ color: '#ef4444' }} title={saveError}>Not saved — retrying on next edit</span>
          ) : isSaving ? 'Saving…' : isDirty ? 'Editing…' : 'Saved'}
        </div>
      </div>
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
};
