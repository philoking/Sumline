import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDialog } from './useDialog';

interface NameQuestion {
  kind: 'name';
  /** The heading, which says what is being named rather than repeating "name". */
  title: string;
  /** Seeds the box, and is what Cancel returns to. */
  value: string;
  /** The verb on the button: `Create folder`, `Rename`, `Add space`. */
  confirm: string;
}

interface ConfirmQuestion {
  kind: 'confirm';
  title: string;
  /** What happens if they say yes, in the words the answer deserves. */
  body: string;
  /** The verb again: `Remove space`, `Delete permanently`, `Empty trash`. */
  confirm: string;
}

type Question = NameQuestion | ConfirmQuestion;

/** A question waiting for an answer, and the promise it will settle. */
type Pending = Question & { settle: (answer: string | null | boolean) => void };

export interface Ask {
  /**
   * Asks for a name. Resolves with the trimmed answer, or null if cancelled.
   *
   * An empty answer is a cancellation: every caller of this refuses one
   * anyway, and returning it as an answer would make each of them check.
   */
  name(question: Omit<NameQuestion, 'kind'>): Promise<string | null>;
  /** Asks a yes-or-no question whose yes is spelt out on the button. */
  confirm(question: Omit<ConfirmQuestion, 'kind'>): Promise<boolean>;
  /** Rendered once, near the root. Null while nothing is being asked. */
  dialog: ReactNode;
}

/**
 * The app asking a question in its own voice.
 *
 * Every naming and confirmation step used to be `window.prompt` or
 * `window.confirm` — which is to say that all of the app's most consequential
 * moments ran through the one control it has no say over. That cost more than
 * looks: a native dialog follows neither the light and dark themes this app is
 * careful about nor its typography, its buttons say OK and Cancel whatever the
 * question was, and it blocks the main thread, so the event stream and autosave
 * stall while one is open. Some mobile browsers offer to suppress further
 * dialogs after a couple in a row, which would silently break renaming.
 *
 * The shape is a promise per question, because that is what the call sites
 * already looked like: they were `async` functions that returned early when the
 * answer was a cancellation, and they still are.
 */
export function useAsk(): Ask {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback(
    (question: Question) =>
      new Promise<string | null | boolean>((resolve) => {
        setPending((current) => {
          // Two questions at once should not be possible from the interface,
          // but a promise nobody settles is a hung caller, so the older one is
          // answered as cancelled rather than dropped.
          current?.settle(current.kind === 'name' ? null : false);
          return { ...question, settle: resolve };
        });
      }),
    [],
  );

  const name = useCallback(
    (question: Omit<NameQuestion, 'kind'>) =>
      ask({ ...question, kind: 'name' }) as Promise<string | null>,
    [ask],
  );

  const confirm = useCallback(
    (question: Omit<ConfirmQuestion, 'kind'>) =>
      ask({ ...question, kind: 'confirm' }) as Promise<boolean>,
    [ask],
  );

  const settle = useCallback((answer: string | null | boolean) => {
    setPending((current) => {
      current?.settle(answer);
      return null;
    });
  }, []);

  return {
    name,
    confirm,
    dialog: pending ? <AskDialog question={pending} onSettle={settle} /> : null,
  };
}

function AskDialog(props: {
  question: Question;
  onSettle: (answer: string | null | boolean) => void;
}) {
  const { question, onSettle } = props;
  const cancel = useCallback(
    () => onSettle(question.kind === 'name' ? null : false),
    [onSettle, question.kind],
  );
  const panelRef = useDialog<HTMLDivElement>(true, cancel);

  const [value, setValue] = useState(question.kind === 'name' ? question.value : '');
  // A second question replacing the first reuses this component, so the box has
  // to be re-seeded rather than left showing the previous answer.
  const asked = useRef(question);
  useEffect(() => {
    if (asked.current === question) return;
    asked.current = question;
    setValue(question.kind === 'name' ? question.value : '');
  }, [question]);

  const submit = () => {
    if (question.kind !== 'name') {
      onSettle(true);
      return;
    }
    const trimmed = value.trim();
    onSettle(trimmed === '' ? null : trimmed);
  };

  return (
    <>
      {/* Answering by clicking away is a cancellation, which is what dismissing
          a question means everywhere else in this app. */}
      <div className="ask-backdrop" onClick={cancel} aria-hidden="true" />
      <div
        className="ask"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        ref={panelRef}
        tabIndex={-1}
      >
        <h2 id="ask-title">{question.title}</h2>
        {question.kind === 'confirm' && <p className="ask-body">{question.body}</p>}
        {question.kind === 'name' && (
          <input
            data-autofocus
            className="ask-input"
            value={value}
            aria-label={question.title}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
        )}
        <div className="ask-buttons">
          <button type="button" className="ghost" onClick={cancel}>
            Cancel
          </button>
          {/* The verb, not "OK". A button that says what it does is the whole
              reason for replacing the native dialogs. */}
          <button
            type="button"
            className="ask-confirm"
            onClick={submit}
            {...(question.kind === 'confirm' ? { 'data-autofocus': true } : {})}
          >
            {question.confirm}
          </button>
        </div>
      </div>
    </>
  );
}
