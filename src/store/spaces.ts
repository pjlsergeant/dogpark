/** Spaces, and membership as append-only intervals (ADR-0011). */
import type { AgentId, SpaceId, Timestamp } from '../types.js';
import type { StoreContext } from './context.js';
import { uniqueOr } from './context.js';
import { newId } from './ids.js';
import type { Store } from './index.js';
import { assertNonEmpty } from './text.js';

export function spaceStore(
  ctx: StoreContext,
): Pick<
  Store,
  | 'createSpace'
  | 'renameSpace'
  | 'listSpaces'
  | 'getSpace'
  | 'grantMembership'
  | 'revokeMembership'
  | 'isCurrentMember'
  | 'listSpacesForAgent'
  | 'listMembershipIntervals'
> {
  const { db, st, now, nextSeq, toSpace, requireAgentRow, requireSpaceRow, isCurrentMember } = ctx;

  const grantTx = db.transaction((agent: AgentId, space: SpaceId): boolean => {
    requireAgentRow(agent);
    requireSpaceRow(space);
    // Already current is a no-op, not a second open interval (ADR-0011). No
    // event either: nothing changed, and an event says something did.
    if (isCurrentMember(agent, space)) return false;
    const seq = nextSeq();
    const at = now();
    st.insertEvent.run({
      seq,
      id: newId(),
      agent,
      kind: 'space_access_granted',
      space,
      at,
    });
    // granted_seq is the event's seq, so the interval opens exactly where the
    // announcement lands and nothing written before it is delivered.
    st.insertMembership.run({ id: newId(), agent, space, at, seq });
    return true;
  });

  const revokeTx = db.transaction((agent: AgentId, space: SpaceId): boolean => {
    requireAgentRow(agent);
    requireSpaceRow(space);
    const open = st.openMembership.get({ agent, space });
    if (open === undefined) return false;
    const seq = nextSeq();
    const at = now();
    st.insertEvent.run({ seq, id: newId(), agent, kind: 'space_access_revoked', space, at });
    // The interval is closed, never cleared: the row stays as history.
    st.closeMembership.run({ id: open.id, at, seq });
    return true;
  });

  return {
    createSpace(name) {
      assertNonEmpty('name', name);
      const id = newId();
      try {
        st.insertSpace.run({ id, name, at: now() });
      } catch (error) {
        throw uniqueOr(error, 'a space with that name already exists');
      }
      return toSpace(requireSpaceRow(id as SpaceId));
    },

    renameSpace(space, name) {
      assertNonEmpty('name', name);
      requireSpaceRow(space);
      try {
        st.renameSpace.run({ id: space, name });
      } catch (error) {
        throw uniqueOr(error, 'a space with that name already exists');
      }
      return toSpace(requireSpaceRow(space));
    },

    listSpaces() {
      return st.listSpaces.all().map(toSpace);
    },

    getSpace(space) {
      const row = st.getSpace.get({ id: space });
      return row === undefined ? undefined : toSpace(row);
    },

    grantMembership(agent, space) {
      return grantTx(agent, space);
    },

    revokeMembership(agent, space) {
      return revokeTx(agent, space);
    },

    isCurrentMember,

    listSpacesForAgent(agent) {
      requireAgentRow(agent);
      return st.spacesForAgent.all({ agent }).map(toSpace);
    },

    listMembershipIntervals(filter) {
      return st.membershipIntervals
        .all({ agent: filter?.agent ?? null, space: filter?.space ?? null })
        .map((row) => ({
          id: row.id,
          agent: row.agent_id as AgentId,
          space: row.space_id as SpaceId,
          grantedAt: row.granted_at as Timestamp,
          revokedAt: row.revoked_at as Timestamp | null,
        }));
    },
  };
}
