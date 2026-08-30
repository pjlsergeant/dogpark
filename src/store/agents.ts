/** Agents — roles, not processes (ADR-0013) — and their keys. */
import { randomBytes } from 'node:crypto';
import type { AgentId, Timestamp } from '../types.js';
import type { StoreContext } from './context.js';
import { invalid, notFound, uniqueOr } from './errors.js';
import { sha256 } from './hash.js';
import { KEY_PREFIX, newId, splitKey } from './ids.js';
import type { AgentRecord, Store } from './records.js';
import type { AgentRow } from './statements.js';
import { assertNoReservedSequence, assertValidName } from './text.js';

export function agentStore(
  ctx: StoreContext,
): Pick<
  Store,
  | 'createAgent'
  | 'renameAgent'
  | 'archiveAgent'
  | 'unarchiveAgent'
  | 'listAgents'
  | 'getAgent'
  | 'listAgentsSharingSpaceWith'
  | 'issueKey'
  | 'verifyKey'
  | 'revokeKey'
  | 'listKeys'
> {
  const { db, st, now, requireAgentRow, requireSpaceRow, isCurrentMember } = ctx;

  function toAgentRecord(row: AgentRow): AgentRecord {
    return {
      id: row.id as AgentId,
      displayName: row.display_name,
      archived: row.archived === 1,
      createdAt: row.created_at as Timestamp,
      lastSeenAt: row.last_seen_at as Timestamp | null,
      failedAuthAttempts: row.failed_auth_attempts,
    };
  }

  /**
   * A rename journals the label it replaces, in the same transaction, so the
   * label in force at any past instant stays answerable (migration 0002).
   * Renaming to the same label is a no-op: nothing changed, so no history.
   */
  const renameAgentTx = db.transaction((agent: AgentId, displayName: string): AgentRecord => {
    const before = requireAgentRow(agent);
    if (before.display_name !== displayName) {
      try {
        st.renameAgent.run({ id: agent, name: displayName });
      } catch (error) {
        throw uniqueOr(error, 'an agent with that name already exists');
      }
      st.insertLabelHistory.run({
        kind: 'agent',
        subject: agent,
        label: before.display_name,
        until: now(),
      });
    }
    return toAgentRecord(requireAgentRow(agent));
  });

  const archiveTx = db.transaction((agent: AgentId): AgentRecord => {
    requireAgentRow(agent);
    // Archiving revokes credentials and hides the role. It does not touch
    // membership, which is history (ADR-0013).
    st.revokeAgentKeys.run({ agent, at: now() });
    st.setArchived.run({ id: agent, archived: 1 });
    return toAgentRecord(requireAgentRow(agent));
  });

  const verifyKeyTx = db.transaction(
    (presented: string, countFailure: boolean): AgentRecord | undefined => {
      const parsed = splitKey(presented);
      const at = now();

      const fail = (): undefined => {
        // Counted against the id the key claimed, which is what it is: anyone
        // who knows an agent's id can send a bad key bearing it. Skipped once
        // the caller judges the attempts a flood, so a public counter cannot be
        // driven — and a write cannot be forced — without limit.
        if (
          countFailure &&
          parsed !== undefined &&
          st.getAgent.get({ id: parsed.agent }) !== undefined
        ) {
          st.countFailedAuth.run({ id: parsed.agent });
        }
        return undefined;
      };

      if (parsed === undefined) return fail();
      const row = st.keyByHash.get({ hash: sha256(presented) });
      if (row === undefined) return fail();
      if (row.revoked_at !== null) return fail();
      // The hash matched, so the id in the token is the id on the row; check it
      // anyway rather than trusting the caller's half of the string.
      if (row.agent_id !== parsed.agent) return fail();

      const agentRow = st.getAgent.get({ id: row.agent_id });
      if (agentRow === undefined || agentRow.archived === 1) return fail();

      st.touchAgent.run({ id: row.agent_id, at });
      const refreshed = st.getAgent.get({ id: row.agent_id });
      /* c8 ignore next */
      if (refreshed === undefined) throw new Error('agent vanished');
      return toAgentRecord(refreshed);
    },
  );

  return {
    createAgent(displayName) {
      assertValidName('displayName', displayName);
      const id = newId();
      try {
        st.insertAgent.run({ id, name: displayName, at: now() });
      } catch (error) {
        throw uniqueOr(error, 'an agent with that name already exists');
      }
      return toAgentRecord(requireAgentRow(id as AgentId));
    },

    renameAgent(agent, displayName) {
      assertValidName('displayName', displayName);
      return renameAgentTx(agent, displayName);
    },

    archiveAgent(agent) {
      return archiveTx(agent);
    },

    unarchiveAgent(agent) {
      requireAgentRow(agent);
      // No key is issued here: Dogpark cannot re-show a hashed one, so the
      // caller issues a fresh key as a separate, visible step.
      st.setArchived.run({ id: agent, archived: 0 });
      return toAgentRecord(requireAgentRow(agent));
    },

    listAgents(opts) {
      return st.listAgents
        .all({ includeArchived: opts?.includeArchived === true ? 1 : 0 })
        .map(toAgentRecord);
    },

    getAgent(agent) {
      const row = st.getAgent.get({ id: agent });
      return row === undefined ? undefined : toAgentRecord(row);
    },

    listAgentsSharingSpaceWith(agent, space) {
      requireAgentRow(agent);
      if (space !== undefined) {
        requireSpaceRow(space);
        // Naming a space you are not in is a probe; answer it like any other.
        if (!isCurrentMember(agent, space)) throw notFound('space');
      }
      return st.peers
        .all({ agent, space: space ?? null })
        .map((row) => ({ id: row.id as AgentId, displayName: row.display_name }));
    },

    issueKey(agent, label) {
      const row = requireAgentRow(agent);
      if (row.archived === 1) {
        throw invalid('cannot issue a key to an archived agent; unarchive it first');
      }
      if (label !== undefined) assertNoReservedSequence('label', label);
      const id = newId();
      // Hex, not base64url: the key is split on '_' and base64url uses it.
      const secret = randomBytes(32).toString('hex');
      const key = `${KEY_PREFIX}_${agent}_${secret}`;
      const at = now();
      st.insertKey.run({ id, agent, hash: sha256(key), label: label ?? null, at });
      return { id, agent, key, createdAt: at };
    },

    verifyKey(presented, options) {
      return verifyKeyTx(presented, options?.countFailure ?? true);
    },

    revokeKey(keyId) {
      st.revokeKey.run({ id: keyId, at: now() });
    },

    listKeys(agent) {
      requireAgentRow(agent);
      return st.listKeys.all({ agent }).map((row) => ({
        id: row.id,
        agent: row.agent_id as AgentId,
        label: row.label,
        createdAt: row.created_at as Timestamp,
        revokedAt: row.revoked_at as Timestamp | null,
      }));
    },
  };
}
