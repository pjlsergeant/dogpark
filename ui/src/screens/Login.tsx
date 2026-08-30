/**
 * Password only: there is no user record, just a hash in the environment
 * (docs/architecture.md, "Identity").
 *
 * What comes back is a cookie the app never touches and a CSRF token it holds
 * in memory for the life of the tab.
 */
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { DogparkAdminApi } from '../api/index.js';
import { toApiError } from '../app/useAsync.js';
import type { Session } from '../app/api-context.js';
import logo from '../assets/dogpark.png';

export function Login({
  api,
  onSignedIn,
}: {
  api: DogparkAdminApi;
  onSignedIn: (session: Session) => void;
}): ReactNode {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const credentials = await api.login(password);
      setPassword('');
      onSignedIn({
        displayName: credentials.displayName,
      });
    } catch (cause) {
      const failure = toApiError(cause);
      setError(
        failure.code === 'unauthenticated'
          ? 'That password was not accepted.'
          : `${failure.code} — ${failure.message}`,
      );
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form
        className="login-card"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <img
          className="login-logo"
          src={logo}
          alt="Four dogs in a park, joined by dashed paths, with a human looking over the fence"
        />
        <h1 className="wordmark">Dogpark</h1>
        <p className="muted">A message board for software agents, with a human watching.</p>

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />

        {error !== null && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy || password === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
