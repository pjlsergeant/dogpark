import type { AgentId, SpaceId } from '../types.js';
import type { StoreContext } from './context.js';
import { invalid } from './errors.js';
import { MAX_DESCRIPTION_CHARS } from './limits.js';
import type { Store } from './records.js';
import { assertNoReservedSequence } from './text.js';

type Kind = 'space' | 'agent' | 'membership';

const membershipSubject = (agent: AgentId, space: SpaceId): string => `${agent}:${space}`;

export function descriptionStore(
  ctx: StoreContext,
): Pick<
  Store,
  | 'setSpaceDescription'
  | 'getSpaceDescription'
  | 'setAgentDescription'
  | 'getAgentDescription'
  | 'setMembershipNote'
  | 'getMembershipNote'
> {
  const { db, nextSeq, now, requireAgentRow, requireSpaceRow, isCurrentMember } = ctx;
  const insert = db.prepare(
    'INSERT INTO description (seq, kind, subject_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const current = db.prepare<[Kind, string], { body: string }>(
    'SELECT body FROM description WHERE kind = ? AND subject_id = ? ORDER BY seq DESC LIMIT 1',
  );

  const normalize = (body: string): string => {
    assertNoReservedSequence('description', body);
    const normalized = body.trim().replace(/\s+/g, ' ');
    if ([...normalized].length > MAX_DESCRIPTION_CHARS) {
      throw invalid(`description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
    }
    return normalized;
  };

  const append = db.transaction((kind: Kind, subject: string, body: string): void => {
    insert.run(nextSeq(), kind, subject, normalize(body), now());
  });
  const get = (kind: Kind, subject: string): string | undefined => {
    const body = current.get(kind, subject)?.body;
    return body === undefined || body === '' ? undefined : body;
  };

  return {
    setSpaceDescription(space, body) {
      requireSpaceRow(space);
      append('space', space, body);
    },
    getSpaceDescription(space) {
      requireSpaceRow(space);
      return get('space', space);
    },
    setAgentDescription(agent, body) {
      requireAgentRow(agent);
      append('agent', agent, body);
    },
    getAgentDescription(agent) {
      requireAgentRow(agent);
      return get('agent', agent);
    },
    setMembershipNote(agent, space, body) {
      requireAgentRow(agent);
      requireSpaceRow(space);
      if (!isCurrentMember(agent, space)) {
        throw invalid('membership note requires an open membership');
      }
      append('membership', membershipSubject(agent, space), body);
    },
    getMembershipNote(agent, space) {
      requireAgentRow(agent);
      requireSpaceRow(space);
      return get('membership', membershipSubject(agent, space));
    },
  };
}
