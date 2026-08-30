/** The human's sessions: rows, so a logout invalidates server-side. */
import { randomBytes } from 'node:crypto';
import type { Timestamp } from '../types.js';
import type { StoreContext } from './context.js';
import { invalid } from './errors.js';
import { sha256 } from './hash.js';
import { newId } from './ids.js';
import type { Store } from './records.js';

/** The meta key holding the hash of the configured password hash. */
const PASSWORD_FINGERPRINT = 'password-fingerprint';

export function sessionStore(
  ctx: StoreContext,
): Pick<
  Store,
  | 'createSession'
  | 'verifySession'
  | 'deleteSession'
  | 'deleteExpiredSessions'
  | 'syncPasswordFingerprint'
> {
  const { db, st, now } = ctx;

  // One transaction: a fingerprint recorded without the revocation would leave
  // the old cookies valid and nothing left to notice it.
  const syncFingerprintTx = db.transaction((passwordHash: string): number => {
    const fingerprint = sha256(passwordHash);
    const recorded = st.getMeta.get({ key: PASSWORD_FINGERPRINT });
    if (recorded?.value === fingerprint) return 0;
    // Either the hash changed, or this is the first start to record one. The
    // first sighting cannot tell an upgrade from an upgrade that also rotated
    // the password, so it trusts nothing: a session minted before any
    // fingerprint existed has nothing vouching for the verifier behind it. A
    // fresh database has no sessions, so a first start still revokes nothing.
    const revoked = st.deleteAllSessions.run().changes;
    st.setMeta.run({ key: PASSWORD_FINGERPRINT, value: fingerprint });
    return revoked;
  });

  return {
    createSession(ttlSeconds) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw invalid('ttlSeconds must be a positive integer');
      }
      const id = newId();
      const token = randomBytes(32).toString('base64url');
      const createdAt = now();
      const expiresAt = new Date(
        Date.parse(createdAt) + ttlSeconds * 1000,
      ).toISOString() as Timestamp;
      st.insertSession.run({ id, hash: sha256(token), at: createdAt, expires: expiresAt });
      return { id, token, createdAt, expiresAt };
    },

    verifySession(token) {
      const row = st.sessionByHash.get({ hash: sha256(token) });
      if (row === undefined) return undefined;
      // Expiry is checked here rather than left to a sweep, so a stale row is
      // never a valid session even if nothing has swept.
      if (row.expires_at <= now()) return undefined;
      return {
        id: row.id,
        createdAt: row.created_at as Timestamp,
        expiresAt: row.expires_at as Timestamp,
      };
    },

    deleteSession(token) {
      return st.deleteSession.run({ hash: sha256(token) }).changes > 0;
    },

    deleteExpiredSessions() {
      return st.deleteExpiredSessions.run({ at: now() }).changes;
    },

    syncPasswordFingerprint(passwordHash) {
      return syncFingerprintTx(passwordHash);
    },
  };
}
