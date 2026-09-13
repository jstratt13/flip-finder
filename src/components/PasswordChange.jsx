import { useEffect, useState } from 'react';
import * as api from '../api.js';

const MIN = 10;

export default function PasswordChange({ onClose, onChanged }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Checked here only to avoid a pointless round trip; the worker enforces the
  // same rules and is the authority.
  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < MIN;
  const canSubmit = current && next.length >= MIN && next === confirm && !busy;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      onChanged();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label="Change password">
      <div className="scrim" onClick={onClose} />
      <div className="sheet">
        <header>
          <h2>Change Password</h2>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="sheet-body">
          <form className="act" onSubmit={submit}>
            <label>
              <span>Current Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
              />
            </label>

            <label>
              <span>New Password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </label>

            <label>
              <span>Confirm New Password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </label>

            {tooShort && <p className="hint">At least {MIN} characters.</p>}
            {mismatch && <p className="hint">The two new passwords don't match.</p>}
            {error && <p className="error">{error}</p>}

            <button type="submit" disabled={!canSubmit}>
              {busy ? 'Changing…' : 'Change Password'}
            </button>

            <p className="hint">
              This signs you out everywhere, on every device. Sign back in with the new password.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
