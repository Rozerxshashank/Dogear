import React, { useMemo, useState } from 'react';
import { useNotesStore } from '../store/notesStore';
import { format } from 'date-fns';
import { Plus, Trash2, Settings, Github, Search, Loader2, Folder, FolderInput, ChevronDown, ChevronRight } from 'lucide-react';
import type { Note } from '../store/notesStore';
import { useBackendStore } from '../store/backendStore';

export const Sidebar: React.FC<{
  onOpenSettings?: () => void;
  onOpenGit?: () => void;
  onOpenSearch?: () => void;
}> = ({ onOpenSettings, onOpenGit, onOpenSearch }) => {
  const notes = useNotesStore((state) => state.notes);
  const activeNoteId = useNotesStore((state) => state.activeNoteId);
  const setActiveNote = useNotesStore((state) => state.setActiveNote);
  const createNote = useNotesStore((state) => state.createNote);
  const deleteNote = useNotesStore((state) => state.deleteNote);
  const isIndexing = useBackendStore((state) => state.isIndexing);
  const ollamaStatus = useBackendStore((state) => state.ollamaStatus);
  const chatModelReady = useBackendStore((state) => state.chatModelReady);
  const embedModelReady = useBackendStore((state) => state.embedModelReady);
  const moveNote = useNotesStore((state) => state.moveNote);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState('');

  // Top-level notes first, then folders alphabetically
  const groups = useMemo(() => {
    const byFolder = new Map<string, Note[]>();
    for (const note of notes) {
      const key = note.folder || '';
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key)!.push(note);
    }
    return Array.from(byFolder.entries()).sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [notes]);
  const folders = useMemo(() => groups.map(([f]) => f).filter(Boolean), [groups]);

  const toggleFolder = (folder: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  const statusText =
    ollamaStatus === 'running'
      ? chatModelReady && embedModelReady
        ? 'Ollama running'
        : `Ollama running, missing model: ${[!chatModelReady && 'llama3.2', !embedModelReady && 'nomic-embed-text'].filter(Boolean).join(', ')}`
      : ollamaStatus === 'stopped'
        ? 'Ollama not running: local chat unavailable, search uses the built-in fallback'
        : 'Checking Ollama…';

  return (
    <div style={{
      width: '260px',
      height: '100%',
      backgroundColor: 'var(--color-bg-panel)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderRight: '1px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 'var(--z-sidebar)'
    }}>
      <div style={{ 
        padding: 'var(--spacing-md)', 
        paddingTop: 'calc(var(--spacing-md) + 24px)', // macOS traffic light safe area
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid var(--color-border)'
      }}>
        <h2 style={{ fontSize: 'var(--font-size-h3)', margin: 0 }}>SmartNotes</h2>
        <button 
          onClick={() => { void createNote(); }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--color-accent)',
            display: 'flex',
            alignItems: 'center',
            padding: '4px'
          }}
          title="New Note (⌘N)"
        >
          <Plus size={18} />
        </button>
      </div>
      
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--spacing-sm)' }}>
        {notes.length === 0 ? (
          <div style={{ padding: 'var(--spacing-md)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-small)' }}>
            No notes yet. Create one with + or import a folder in Settings.
          </div>
        ) : (
          groups.map(([folder, folderNotes]) => (
            <div key={folder || '__root'} style={{ marginBottom: '4px' }}>
              {folder && (
                <button
                  onClick={() => toggleFolder(folder)}
                  style={folderHeaderStyle}
                  aria-expanded={!collapsed.has(folder)}
                >
                  {collapsed.has(folder) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <Folder size={14} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>{folder}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    title={`New note in ${folder}`}
                    onClick={(e) => { e.stopPropagation(); void createNote(folder); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void createNote(folder); } }}
                    style={{ display: 'flex', opacity: 0.7 }}
                  >
                    <Plus size={14} />
                  </span>
                </button>
              )}
              {!collapsed.has(folder) && folderNotes.map((note) => (
                <div
                  key={note.id}
                  className="note-row"
                  tabIndex={0}
                  onClick={() => setActiveNote(note.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      void setActiveNote(note.id);
                      e.preventDefault();
                    }
                  }}
                  style={{
                    padding: '8px 12px',
                    margin: folder ? '0 8px 4px 20px' : '0 8px 4px 8px',
                    borderRadius: '8px',
                    backgroundColor: activeNoteId === note.id ? 'var(--color-accent)' : 'transparent',
                    color: activeNoteId === note.id ? '#ffffff' : 'var(--color-text-primary)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    position: 'relative',
                    transition: 'var(--transition-fast)'
                  }}
                >
                  <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: '44px' }}>
                    {note.title || 'Untitled Note'}
                  </div>
                  <div style={{ fontSize: '11px', opacity: 0.8, marginTop: '4px' }}>
                    {format(new Date(note.updated_at * 1000), 'MMM d, h:mm a')}
                  </div>

                  {movingId === note.id ? (
                    <form
                      onClick={(e) => e.stopPropagation()}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void moveNote(note.id, moveTarget.trim());
                        setMovingId(null);
                      }}
                      style={{ marginTop: '6px', display: 'flex', gap: '4px' }}
                    >
                      <input
                        autoFocus
                        list="smartnotes-folders"
                        value={moveTarget}
                        onChange={(e) => setMoveTarget(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Escape') setMovingId(null); }}
                        placeholder="Folder (empty = top level)"
                        aria-label="Move to folder"
                        style={{ flex: 1, minWidth: 0, fontSize: '12px', padding: '3px 6px', borderRadius: '4px', border: '1px solid var(--color-border)', background: 'var(--color-bg-main)', color: 'var(--color-text-primary)' }}
                      />
                      <button type="submit" style={{ ...rowButtonStyle(false), opacity: 1, position: 'static', transform: 'none' }} title="Move">↵</button>
                    </form>
                  ) : (
                    <div className="row-actions" style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: '2px', opacity: 0 }}>
                      <button
                        title="Move to folder"
                        aria-label="Move to folder"
                        onClick={(e) => { e.stopPropagation(); setMoveTarget(note.folder || ''); setMovingId(note.id); }}
                        style={rowButtonStyle(activeNoteId === note.id)}
                      >
                        <FolderInput size={14} />
                      </button>
                      <button
                        title="Delete note"
                        aria-label="Delete note"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete "${note.title || 'Untitled Note'}"? This also deletes its file.`)) {
                            void deleteNote(note.id);
                          }
                        }}
                        style={rowButtonStyle(activeNoteId === note.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
        <datalist id="smartnotes-folders">
          {folders.map((f) => <option key={f} value={f} />)}
        </datalist>
      </div>
      <style>
        {`
          .note-row:hover .row-actions, .note-row:focus-within .row-actions { opacity: 1 !important; }
        `}
      </style>

      {/* Footer / Utility Bar */}
      <div style={{
        padding: 'var(--spacing-sm)',
        borderTop: '1px solid var(--color-border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--color-bg-panel)',
      }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button onClick={onOpenSearch} style={footerBtnStyle} title="Search (⌘K)">
            <Search size={16} />
          </button>
          <button onClick={onOpenGit} style={footerBtnStyle} title="GitHub Sync">
            <Github size={16} />
          </button>
          <button onClick={onOpenSettings} style={footerBtnStyle} title="Settings (⌘,)">
            <Settings size={16} />
          </button>
        </div>

        {/* Status Indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isIndexing && (
            <div title="Indexing..." style={{ color: 'var(--color-accent)' }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          )}
          <div 
            title={statusText}
            aria-label={statusText}
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: ollamaStatus === 'running'
                ? (chatModelReady && embedModelReady ? '#10b981' : '#f59e0b')
                : ollamaStatus === 'stopped' ? '#ef4444' : 'var(--color-text-secondary)',
            }}
          />
        </div>
      </div>
    </div>
  );
};

const footerBtnStyle = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-text-secondary)',
  padding: '6px',
  borderRadius: 'var(--radius-button)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'var(--transition-fast)',
};

const folderHeaderStyle: React.CSSProperties = {
  width: 'calc(100% - 16px)',
  margin: '6px 8px 4px 8px',
  padding: '4px 6px',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-text-secondary)',
  fontSize: 'var(--font-size-small)',
  fontWeight: 600,
};

const rowButtonStyle = (active: boolean): React.CSSProperties => ({
  background: 'none',
  border: 'none',
  color: active ? 'rgba(255,255,255,0.85)' : 'var(--color-text-secondary)',
  cursor: 'pointer',
  padding: '2px',
  display: 'flex',
});
