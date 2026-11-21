import React, { useCallback, useEffect, useState } from 'react';
import { Smartphone, Trash2, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { PhonePairing, PhoneState } from '../global';

/** Settings → Phone: turn phone access on, pair a phone with a QR code, remove phones. */
export const PhoneSection: React.FC = () => {
  const [state, setState] = useState<PhoneState | null>(null);
  const [pairing, setPairing] = useState<PhonePairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const phone = window.smartnotes?.phone;

  const refresh = useCallback(async () => {
    if (phone) setState(await phone.getState());
  }, [phone]);

  useEffect(() => {
    void refresh();
    phone?.onDevicesChanged(() => {
      // A phone just paired: hide the QR code and show it in the list
      setPairing(null);
      void refresh();
    });
  }, [phone, refresh]);

  // Countdown for the pairing code
  useEffect(() => {
    if (!pairing?.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  if (!phone) return null;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      setState(await phone.setEnabled(enabled));
      if (!enabled) setPairing(null);
    } catch (e) {
      setError(`Could not ${enabled ? 'turn on' : 'turn off'} phone access: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setError('');
    const result = await phone.pair();
    if (result.error) setError(result.error);
    else setPairing(result);
    void refresh();
  };

  const secondsLeft = pairing?.expiresAt ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;
  const expired = !!pairing && secondsLeft === 0;

  return (
    <section>
      <h3 style={{ fontSize: 'var(--font-size-body)', marginBottom: 'var(--spacing-sm)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Smartphone size={16} /> Phone
      </h3>
      <p style={hint}>Read, search and write your notes from your phone over your Wi-Fi. Nothing goes through the cloud.</p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 'var(--spacing-md) 0', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={!!state?.enabled}
          disabled={busy || !state}
          onChange={(e) => void toggle(e.target.checked)}
          style={{ width: 18, height: 18, accentColor: 'var(--color-accent)' }}
        />
        <span>Allow phone access</span>
        {busy && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
      </label>

      {state?.enabled && (
        <>
          {!pairing || expired ? (
            <button onClick={() => void connect()} style={button}>
              {expired ? 'Code expired. Show a new one' : 'Connect a phone'}
            </button>
          ) : (
            <div style={pairBox}>
              <img
                src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg || '')}`}
                width={168}
                height={168}
                alt="QR code for connecting your phone"
                style={{ background: '#fff', borderRadius: 8, padding: 6, flexShrink: 0 }}
              />
              <div style={{ minWidth: 0 }}>
                <ol style={{ margin: '0 0 10px', paddingLeft: 18, lineHeight: 1.6 }}>
                  <li>Point your phone's camera at the code and open the link.</li>
                  <li>
                    Or open <b style={{ userSelect: 'all' }}>{pairing.address}</b> on your phone and enter:
                  </li>
                </ol>
                <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 22, fontWeight: 600, letterSpacing: '0.14em', userSelect: 'all' }}>
                  {pairing.code}
                </div>
                <div style={{ ...hint, marginTop: 6 }}>
                  Works once. Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}.
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: 'var(--spacing-md)' }}>
            <div style={{ fontSize: 'var(--font-size-small)', fontWeight: 600, marginBottom: 6 }}>Connected phones</div>
            {state.devices.length === 0 ? (
              <div style={hint}>None yet.</div>
            ) : (
              state.devices.map((d) => (
                <div key={d.id} style={deviceRow}>
                  <div>
                    <div>{d.name}</div>
                    <div style={hint}>
                      Connected {formatDistanceToNow(d.createdAt, { addSuffix: true })} · last used {formatDistanceToNow(d.lastSeen, { addSuffix: true })}
                    </div>
                  </div>
                  <button
                    onClick={async () => setState(await phone.revoke(d.id))}
                    style={{ ...button, padding: '6px 10px', color: '#d9534f' }}
                    aria-label={`Remove ${d.name}`}
                  >
                    <Trash2 size={14} /> Remove
                  </button>
                </div>
              ))
            )}
          </div>

          <p style={{ ...hint, marginTop: 'var(--spacing-md)' }}>
            Works while this Mac is awake and on the same Wi-Fi. Phones can read, search and edit notes, but not delete them.
            Traffic on the Wi-Fi isn't encrypted, so use this on networks you trust, like home.
            The first time, macOS may ask whether Dogear can accept incoming connections: choose Allow.
          </p>
        </>
      )}

      {error && <p style={{ ...hint, color: '#d9534f' }} role="alert">{error}</p>}
    </section>
  );
};

const hint: React.CSSProperties = {
  fontSize: 'var(--font-size-small)',
  color: 'var(--color-text-secondary)',
  margin: 0,
};

const button: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 'var(--radius-button)',
  border: '1px solid var(--color-border)',
  background: 'var(--color-bg-panel)',
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 'var(--font-size-small)',
};

const pairBox: React.CSSProperties = {
  display: 'flex',
  gap: 'var(--spacing-md)',
  alignItems: 'center',
  padding: 'var(--spacing-md)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-panel)',
  fontSize: 'var(--font-size-small)',
};

const deviceRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  padding: '8px 0',
  borderBottom: '1px solid var(--color-border)',
  fontSize: 'var(--font-size-small)',
};
