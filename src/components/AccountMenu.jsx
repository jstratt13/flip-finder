import { useEffect, useId, useRef, useState } from 'react';

// The signed-in name opens a small menu of account actions. A disclosure — a
// button that shows and hides a list of buttons — rather than a full ARIA
// menu: two items don't need arrow-key roving, and plain buttons stay
// reachable with Tab on a phone's keyboard or a screen reader.
export default function AccountMenu({ name, onChangePassword, onSignOut }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;

    // pointerdown rather than click, so a tap that starts outside closes the
    // menu before whatever it lands on reacts.
    const outside = (e) => {
      if (!wrap.current?.contains(e.target)) setOpen(false);
    };
    const escape = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const choose = (action) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="account" ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className="account-trigger"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="account-name">{name}</span>
        <span className="caret" aria-hidden="true" />
      </button>

      <ul id={listId} className="account-menu" hidden={!open}>
        <li>
          <button type="button" onClick={choose(onChangePassword)}>
            Change Password
          </button>
        </li>
        <li>
          <button type="button" onClick={choose(onSignOut)}>
            Sign Out
          </button>
        </li>
      </ul>
    </div>
  );
}
