import { useState } from 'react';
import { api, TooManyAttemptsError, UnauthorizedError } from './api';

export interface LoginProps {
  /** Called once the password has been accepted. */
  onSignedIn(): void;
}

/**
 * The password form, shown in place of the app when a password is required.
 *
 * In place of, rather than over: there is nothing useful behind it, and a modal
 * over an empty sheet would suggest there were. It says plainly that this is one
 * shared password rather than an account, because the app has no accounts and a
 * form that looks like a login invites someone to hunt for their username.
 */
export function Login({ onSignedIn }: LoginProps) {
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<
    'idle' | 'checking' | 'wrong' | 'throttled' | 'error'
  >('idle');
  const [retryAfter, setRetryAfter] = useState(0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password === '') return;
    setStatus('checking');
    try {
      await api.signIn(password);
      onSignedIn();
    } catch (cause) {
      if (cause instanceof TooManyAttemptsError) {
        setRetryAfter(cause.retryAfterSeconds);
        setStatus('throttled');
      } else {
        setStatus(cause instanceof UnauthorizedError ? 'wrong' : 'error');
      }
      setPassword('');
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <h1>Sumline</h1>
        <p className="login-blurb">This instance is password protected.</p>
        <input
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          aria-label="Password"
          placeholder="Password"
          onChange={(event) => {
            setPassword(event.target.value);
            if (status !== 'idle') setStatus('idle');
          }}
        />
        <button type="submit" disabled={password === '' || status === 'checking'}>
          {status === 'checking' ? 'Checking…' : 'Open'}
        </button>
        {/* aria-live so the failure is announced, not only shown: this is the
            one screen where a user may be typing with their eyes elsewhere. */}
        <p className="login-problem" role="status" aria-live="polite">
          {status === 'wrong' && 'That password does not match.'}
          {/* Not "wrong": this attempt was refused before the password was
              looked at, and saying otherwise would report a verdict nobody
              reached. */}
          {status === 'throttled' &&
            `Too many attempts. Try again in ${waitInWords(retryAfter)}.`}
          {status === 'error' && 'Could not reach the server.'}
        </p>
      </form>
    </div>
  );
}

/** A wait in the units someone would say it in, rather than always in seconds. */
function waitInWords(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 1)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}
