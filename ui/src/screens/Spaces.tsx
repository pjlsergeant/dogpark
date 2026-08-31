/**
 * Spaces: the visibility boundary, so this screen is where the fleet's shape
 * is decided. List, create, rename; and for one space, who is in it and what
 * is being said.
 */
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AdminAgent,
  AgentId,
  CurrentMembership,
  Space,
  SpaceId,
  SpaceSummary,
} from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useOnChange } from '../app/changes.js';
import { useAsync } from '../app/useAsync.js';
import { href } from '../app/router.js';
import { Empty, Facts, Fact, Failure, Id, Loading, Pill, Time } from '../components/bits.js';
import { NameDialog } from '../components/NameDialog.js';
import { DescriptionDialog } from '../components/DescriptionDialog.js';
import { useNotify } from '../components/Toasts.js';
import { ExportMenu } from '../components/ExportMenu.js';

export function SpacesScreen(): ReactNode {
  const api = useApi();
  const notify = useNotify();
  const spaces = useAsync(() => api.listSpaces(), [api]);
  // The counts move with every post.
  useOnChange(spaces.reload);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Space | null>(null);
  const [describing, setDescribing] = useState<SpaceSummary | null>(null);

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h1>Spaces</h1>
          <p className="muted">
            A space is the visibility boundary: its members see one another&rsquo;s messages, and
            nobody else does.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          New space
        </button>
      </header>

      {spaces.state.status === 'loading' && spaces.state.data === null && <Loading what="spaces" />}
      {spaces.state.error !== null && (
        <Failure error={spaces.state.error} onRetry={spaces.reload} />
      )}
      {spaces.state.data !== null &&
        (spaces.state.data.length === 0 ? (
          <Empty>No spaces yet. Create one, then add the agents that should see each other.</Empty>
        ) : (
          <ul className="cards">
            {spaces.state.data.map((space) => (
              <li key={space.id} className="card">
                <a className="card-title" href={href.space(space.id)}>
                  {space.name}
                </a>
                {space.unreadCount > 0 && <Pill tone="info">{space.unreadCount} unread</Pill>}
                {space.description !== undefined && space.description !== '' && (
                  <p className="description-text">{space.description}</p>
                )}
                <Id value={space.id} />
                <p className="muted small">
                  {space.conversationCount} thread{space.conversationCount === 1 ? '' : 's'}
                  {' · '}
                  {space.messageCount} message{space.messageCount === 1 ? '' : 's'}
                  {space.lastActivityAt !== null && (
                    <>
                      {' · last '}
                      <Time iso={space.lastActivityAt} />
                    </>
                  )}
                </p>
                <div className="card-actions">
                  <a className="btn btn-quiet" href={href.read(space.id)}>
                    Read
                  </a>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => setRenaming(space)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => setDescribing(space)}
                  >
                    ✎ Description
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}

      {creating && (
        <NameDialog
          title="New space"
          label="Name"
          submitLabel="Create"
          hint="Names are unique. Agents never see a space they are not in."
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            await api.createSpace(name);
            notify('ok', `Space “${name}” created.`);
            spaces.reload();
          }}
        />
      )}
      {renaming !== null && (
        <NameDialog
          title={`Rename “${renaming.name}”`}
          label="Name"
          initial={renaming.name}
          submitLabel="Rename"
          hint="The id does not change, and nothing stores a copy of the name."
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            await api.renameSpace(renaming.id, name);
            notify('ok', 'Renamed.');
            spaces.reload();
          }}
        />
      )}
      {describing !== null && (
        <DescriptionDialog
          kind="space"
          subjectName={describing.name}
          initial={describing.description}
          spaces={[describing]}
          onClose={() => setDescribing(null)}
          onSave={async (description) => {
            await api.setSpaceDescription(describing.id, description);
            notify('ok', description === '' ? 'Description cleared.' : 'Description saved.');
            spaces.reload();
          }}
        />
      )}
    </section>
  );
}

export function SpaceScreen({ space }: { space: SpaceId }): ReactNode {
  const api = useApi();
  const notify = useNotify();
  const members = useAsync(() => api.listMembers(space), [api, space]);
  const agents = useAsync(() => api.listAgents(), [api]);
  // The members response does not carry the space, so its name comes from here.
  const spaces = useAsync(() => api.listSpaces(), [api]);
  const conversations = useAsync(() => api.listConversations(space), [api, space]);
  // Membership and threads both move on writes the long poll reports.
  useOnChange(() => {
    members.reload();
    conversations.reload();
  });
  const [renaming, setRenaming] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [noting, setNoting] = useState<CurrentMembership | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [adding, setAdding] = useState<AgentId | ''>('');

  const currentIds = useMemo(
    () => new Set((members.state.data?.current ?? []).map((entry) => entry.agent.id)),
    [members.state.data],
  );

  const candidates: readonly AdminAgent[] = useMemo(
    () => (agents.state.data ?? []).filter((agent) => !currentIds.has(agent.id)),
    [agents.state.data, currentIds],
  );

  const add = useCallback(
    async (agent: AgentId) => {
      try {
        await api.addMember(space, agent);
        notify('ok', 'Added. The agent gets a space_access_granted event on its next read.');
        setAdding('');
        members.reload();
      } catch (cause) {
        notify('bad', cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, space, notify, members],
  );

  const remove = useCallback(
    async (agent: AgentId, name: string) => {
      if (
        !window.confirm(
          `Remove ${name} from this space?\n\nIt stops reading immediately, including any backlog it never reached. What it has already read is outside Dogpark and is not unwound.`,
        )
      ) {
        return;
      }
      try {
        await api.removeMember(space, agent);
        notify('ok', `${name} removed.`);
        members.reload();
      } catch (cause) {
        notify('bad', cause instanceof Error ? cause.message : String(cause));
      }
    },
    [api, space, notify, members],
  );

  const detail = members.state.data;
  const past = detail?.history ?? [];
  const named = (spaces.state.data ?? []).find((each) => each.id === space) ?? null;

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <p className="crumb">
            <a href={href.spaces()}>Spaces</a>
          </p>
          <h1>{named?.name ?? 'Space'}</h1>
          <Id value={space} />
        </div>
        <div className="row">
          <a className="btn" href={href.read(space)}>
            Open reader
          </a>
          <ExportMenu kind="space" id={space} />
          <button
            type="button"
            className="btn"
            onClick={() => setRenaming(true)}
            disabled={named === null}
          >
            Rename
          </button>
        </div>
      </header>

      {named !== null && (
        <div className="description-block">
          <div>
            {named.description !== undefined && named.description !== '' ? (
              <p>{named.description}</p>
            ) : (
              <p className="muted">No description.</p>
            )}
          </div>
          <button type="button" className="btn btn-quiet" onClick={() => setDescribing(true)}>
            ✎ Description
          </button>
        </div>
      )}

      {members.state.error !== null && (
        <Failure error={members.state.error} onRetry={members.reload} />
      )}

      <div className="split">
        <div className="panel">
          <h2>Members</h2>
          {members.state.status === 'loading' && detail === null && <Loading what="members" />}
          {detail !== null && detail.current.length === 0 && (
            <Empty>Nobody is in this space, so nothing in it is visible to any agent.</Empty>
          )}
          {detail !== null && detail.current.length > 0 && (
            <ul className="rows">
              {detail.current.map((entry) => {
                const full = (agents.state.data ?? []).find((a) => a.id === entry.agent.id);
                return (
                  <li key={entry.agent.id} className="row-item">
                    <div>
                      <a href={href.agents(entry.agent.id)}>{entry.agent.displayName}</a>
                      {full?.archived === true && <Pill tone="muted">archived</Pill>}
                      <div className="muted small">
                        member since <Time iso={entry.grantedAt} />
                        {full?.lastSeenAt !== null && full?.lastSeenAt !== undefined && (
                          <>
                            {' '}
                            · last seen <Time iso={full.lastSeenAt} />
                          </>
                        )}
                      </div>
                      {entry.note !== undefined && entry.note !== '' && (
                        <p className="description-text">{entry.note}</p>
                      )}
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={() => setNoting(entry)}
                      >
                        ✎ Note
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet btn-danger"
                        onClick={() => void remove(entry.agent.id, entry.agent.displayName)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="add-member">
            <label htmlFor="add-member">Add an agent</label>
            <div className="row">
              <select
                id="add-member"
                value={adding}
                onChange={(event) => setAdding(event.target.value as AgentId | '')}
              >
                <option value="">Choose…</option>
                {candidates.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName}
                    {agent.archived ? ' (archived)' : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary"
                disabled={adding === ''}
                onClick={() => {
                  if (adding !== '') void add(adding);
                }}
              >
                Add
              </button>
            </div>
            <p className="muted small">
              Joining grants access to the history but does not replay it: the agent is told the
              space exists and backfills what it wants.
            </p>
          </div>

          {past.length > 0 && (
            <div className="history">
              <button
                type="button"
                className="btn btn-quiet"
                aria-expanded={showHistory}
                onClick={() => setShowHistory((value) => !value)}
              >
                {showHistory ? 'Hide' : 'Show'} past membership ({past.length})
              </button>
              {showHistory && (
                <Facts>
                  {past.map((interval, index) => (
                    <Fact key={index} name={interval.agent.displayName}>
                      <Time iso={interval.grantedAt} /> → <Time iso={interval.revokedAt} />
                    </Fact>
                  ))}
                </Facts>
              )}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Threads</h2>
          {conversations.state.status === 'loading' && conversations.state.data === null && (
            <Loading what="threads" />
          )}
          {conversations.state.error !== null && (
            <Failure error={conversations.state.error} onRetry={conversations.reload} />
          )}
          {conversations.state.data?.length === 0 && (
            <Empty>Nothing has been said in this space yet.</Empty>
          )}
          <ul className="rows">
            {(conversations.state.data ?? []).map((conversation) => (
              <li key={conversation.id} className="row-item">
                <div>
                  <a href={href.read(space, conversation.id)}>{conversation.title}</a>
                  <div className="muted small">
                    opened by{' '}
                    {conversation.openedBy.kind === 'agent'
                      ? conversation.openedBy.displayName
                      : 'you'}
                    {' · '}
                    {conversation.messageCount} message
                    {conversation.messageCount === 1 ? '' : 's'}
                    {conversation.lastActivityAt !== null && (
                      <>
                        {' · '}
                        <Time iso={conversation.lastActivityAt} />
                        {conversation.lastSender !== null &&
                          ` · ${conversation.lastSender.displayName}`}
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {renaming && named !== null && (
        <NameDialog
          title={`Rename “${named.name}”`}
          label="Name"
          initial={named.name}
          submitLabel="Rename"
          onClose={() => setRenaming(false)}
          onSubmit={async (name) => {
            await api.renameSpace(space, name);
            notify('ok', 'Renamed.');
            spaces.reload();
          }}
        />
      )}
      {describing && named !== null && (
        <DescriptionDialog
          kind="space"
          subjectName={named.name}
          initial={named.description}
          spaces={[named]}
          onClose={() => setDescribing(false)}
          onSave={async (description) => {
            await api.setSpaceDescription(space, description);
            notify('ok', description === '' ? 'Description cleared.' : 'Description saved.');
            spaces.reload();
          }}
        />
      )}
      {noting !== null && named !== null && (
        <DescriptionDialog
          kind="membership"
          subjectName={`${noting.agent.displayName} in ${named.name}`}
          initial={noting.note}
          spaces={[named]}
          onClose={() => setNoting(null)}
          onSave={async (description) => {
            await api.setMembershipNote(space, noting.agent.id, description);
            notify(
              'ok',
              description === '' ? 'Membership note cleared.' : 'Membership note saved.',
            );
            members.reload();
          }}
        />
      )}
    </section>
  );
}
