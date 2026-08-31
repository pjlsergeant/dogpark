/**
 * The one bar that is not dismissible: while the server runs on the README's
 * example password, anyone who has read the README can sign in, so it stays up
 * until the hash changes. The server reports the state on every session
 * response; this only renders it.
 */
import type { ReactNode } from 'react';

export function ExamplePasswordBanner(): ReactNode {
  return (
    <div className="example-password-banner" role="alert">
      This Dogpark is using the example password from the README. Anyone who has read it can sign
      in. Set <code>DOGPARK_PASSWORD_HASH</code> to your own hash (
      <code>node dist/server.js hash-password</code>) and restart.
    </div>
  );
}
