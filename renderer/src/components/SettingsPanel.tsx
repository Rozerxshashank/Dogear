import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { Settings, Check, X, FolderInput, Loader2 } from 'lucide-react';
import { useNotesStore } from '../store/notesStore';
import { apiUrl } from '../api';
import { PhoneSection } from './PhoneSection';

export const SettingsPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const settings = useSettingsStore();
  const ipcToken = useNotesStore((s) => s.ipcToken);
  const [notesDir, setNotesDir] = useState('');
  const [importState, setImportState] = useState<{ busy: boolean; message: string }>({ busy: false, message: '' });

  useEffect(() => {
    window.smartnotes?.getNotesDir?.().then(setNotesDir).catch(() => undefined);
  }, []);

  const close = () => {
    if (ipcToken) void settings.pushBackendSettings(ipcToken);
    onClose();
  };

  const importFolder = async () => {
    const folder = await window.smartnotes?.chooseFolder?.();
    if (!folder || !ipcToken) return;
    setImportState({ busy: true, message: 'Importing…' });
    try {
      const res = await fetch(apiUrl('/import/folder'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-IPC-Token': ipcToken },
        body: JSON.stringify({ folder_path: folder }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      const skipped = data.skipped?.length ? ` (${data.skipped.length} skipped)` : '';
      setImportState({ busy: false, message: `Imported ${data.count} notes${skipped}. Indexing continues in the background.` });
      await useNotesStore.getState().fetchNotes();
    } catch (e) {
      setImportState({ busy: false, message: `Import failed: ${(e as Error).message}` });
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 'var(--z-modal)',
    }}>
      <div style={{
        width: '600px',
        maxHeight: '90vh',
        backgroundColor: 'var(--color-bg-main)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: 'var(--shadow-popover)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: 'var(--spacing-md) var(--spacing-lg)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Settings size={20} style={{ color: 'var(--color-accent)' }} />
            <h2 style={{ margin: 0, fontSize: 'var(--font-size-h3)' }}>Settings</h2>
          </div>
          <button onClick={close} aria-label="Close settings" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: 'var(--spacing-lg)', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xl)' }}>
          
          {/* AI Provider */}
          <section>
            <h3 style={{ fontSize: 'var(--font-size-body)', marginBottom: 'var(--spacing-md)' }}>AI Provider</h3>
            <select
              value={settings.aiProvider}
              onChange={(e) => settings.setAiProvider(e.target.value as any)}
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: 'var(--radius-button)',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg-panel)',
                color: 'var(--color-text-primary)',
                marginBottom: 'var(--spacing-sm)',
              }}
            >
              <option value="ollama">Ollama (Local - Requires installation)</option>
              <option value="gemini">Google Gemini (Cloud - Requires API Key)</option>
              <option value="mistral">Mistral AI (Cloud - Requires API Key)</option>
              <option value="openai">OpenAI (Cloud - Requires API Key)</option>
            </select>
            
            {settings.aiProvider === 'openai' && (
              <input
                type="password"
                placeholder="OpenAI API Key"
                value={settings.openaiKey}
                onChange={(e) => settings.setOpenaiKey(e.target.value)}
                style={inputStyle}
              />
            )}
            
            {settings.aiProvider === 'mistral' && (
              <input
                type="password"
                placeholder="Mistral API Key"
                value={settings.mistralKey}
                onChange={(e) => settings.setMistralKey(e.target.value)}
                style={inputStyle}
              />
            )}
            
            {settings.aiProvider === 'gemini' && (
              <input
                type="password"
                placeholder="Gemini API Key"
                value={settings.geminiKey}
                onChange={(e) => settings.setGeminiKey(e.target.value)}
                style={inputStyle}
              />
            )}
          </section>

          <PhoneSection />

          {/* GitHub */}
          <section>
            <h3 style={{ fontSize: 'var(--font-size-body)', marginBottom: 'var(--spacing-md)' }}>GitHub Backup</h3>
            <input
              type="text"
              placeholder="Repository (owner/repo or https URL)"
              value={settings.githubRepo}
              onChange={(e) => settings.setGithubRepo(e.target.value)}
              style={{ ...inputStyle, marginBottom: 'var(--spacing-sm)' }}
            />
            <input
              type="password"
              placeholder="Personal access token (Contents: read and write)"
              value={settings.githubPat}
              onChange={(e) => settings.setGithubPat(e.target.value)}
              style={inputStyle}
            />
            <p style={hintStyle}>Use a private repository. The token is stored encrypted by your operating system.</p>
          </section>

          {/* Notes folder and import */}
          <section>
            <h3 style={{ fontSize: 'var(--font-size-body)', marginBottom: 'var(--spacing-md)' }}>Notes Folder</h3>
            <p style={{ ...hintStyle, marginTop: 0, wordBreak: 'break-all' }}>{notesDir || '—'}</p>
            <button onClick={importFolder} disabled={importState.busy} style={secondaryButton}>
              {importState.busy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <FolderInput size={16} />}
              Import Markdown / Obsidian folder…
            </button>
            {importState.message && <p style={hintStyle}>{importState.message}</p>}
          </section>

          {/* Auto-Linking */}
          <section>
            <h3 style={{ fontSize: 'var(--font-size-body)', marginBottom: 'var(--spacing-md)' }}>Auto-Linking Threshold</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
              <input
                type="range"
                min="0.5"
                max="0.95"
                step="0.01"
                value={settings.autoLinkThreshold}
                onChange={(e) => settings.setAutoLinkThreshold(parseFloat(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ minWidth: '40px', fontWeight: 'bold' }}>{settings.autoLinkThreshold.toFixed(2)}</span>
            </div>
            <p style={{ fontSize: 'var(--font-size-small)', color: 'var(--color-text-secondary)', marginTop: 'var(--spacing-sm)' }}>
              Lower values create more links, higher values create fewer but more precise links.
            </p>
          </section>

        </div>

        <div style={{
          padding: 'var(--spacing-md) var(--spacing-lg)',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          justifyContent: 'flex-end',
          background: 'var(--color-bg-panel)'
        }}>
          <button
            onClick={close}
            style={{
              padding: '8px 24px',
              borderRadius: 'var(--radius-button)',
              border: 'none',
              background: 'var(--color-accent)',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: 'var(--font-size-small)'
            }}
          >
            <Check size={16} /> Done
          </button>
        </div>
      </div>
    </div>
  );
};

const inputStyle = {
  width: '100%',
  padding: '10px',
  borderRadius: 'var(--radius-button)',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-panel)',
  color: 'var(--color-text-primary)',
  boxSizing: 'border-box' as const,
};

const hintStyle = {
  fontSize: 'var(--font-size-small)',
  color: 'var(--color-text-secondary)',
  marginTop: 'var(--spacing-sm)',
};

const secondaryButton = {
  padding: '8px 14px',
  borderRadius: 'var(--radius-button)',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-panel)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: 'var(--font-size-small)',
};
