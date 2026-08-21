import type { Lock } from './api';

/**
 * The three messages that appear across the top of the app.
 *
 * Together rather than scattered through the root's render, because what
 * distinguishes them is a single decision — how loudly each interrupts — and
 * that decision is only legible when they are side by side.
 *
 * All three are live regions now. The only one in the app used to be the save
 * chip, so what got politely narrated was "Saved" and what went unsaid was
 * "somebody else is editing this sheet".
 */
export interface BannersProps {
  error: string | null;
  notice: string | null;
  lock: { granted: boolean; holder: Lock | null };
  activeId: string | null;
  viewingTrash: boolean;
  onDismissError(): void;
  onDismissNotice(): void;
  onTakeOver(): void;
}

export function Banners(props: BannersProps) {
  const { error, notice, lock, activeId, viewingTrash } = props;

  return (
    <>
      {/* `alert`, which is assertive: something went wrong and the reader needs
          to know now rather than after whatever they are typing. */}
      {error && (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      )}

      {/* Polite: a notice is the outcome of something the reader just did, so
          it can wait for a pause rather than interrupt. */}
      {notice && (
        <div className="banner" role="status">
          <span>{notice}</span>
          <button type="button" onClick={props.onDismissNotice}>
            Dismiss
          </button>
        </div>
      )}

      {/* The message most worth announcing in the whole app: it is the
          difference between typing and typing into something that will not
          save. Polite rather than assertive, because it arrives while the
          reader is looking at the sheet rather than in response to anything
          they did. */}
      {!lock.granted && activeId && !viewingTrash && (
        <div className="banner" role="status">
          <span>
            Read-only — {lock.holder?.clientName ?? 'another browser'} is editing this
            sheet.
          </span>
          <button type="button" onClick={props.onTakeOver}>
            Take over editing
          </button>
        </div>
      )}
    </>
  );
}
