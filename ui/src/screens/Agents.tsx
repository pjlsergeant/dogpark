/**
 * Agents: the roles, their keys, and the one moment a key is readable.
 *
 * Two things here are load-bearing.
 *
 * A key is shown exactly once, so the reveal is a modal that will not go away
 * by accident and carries the `DOGPARK_URL` / `DOGPARK_KEY` snippet beside
 * it -- moving a secret from a browser into a config file by hand is the step
 * most likely to go wrong.
 *
 * The failure count is *attempts claiming this id*, not the agent failing:
 * anyone who knows an id can send a bad key bearing it. It is shown loudly
 * only while `hasEverAuthenticated` is false, which is the window where it
 * diagnoses anything.
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { AdminAgent, AgentId, ApiKeySummary, IssuedKey } from '../api/index.js';
import { useApi } from '../app/api-context.js';
import { useAsync } from '../app/useAsync.js';
import { href, navigate } from '../app/router.js';
import {
  Copyable,
  Empty,
  Fact,
  Facts,
  Failure,
  Id,
  Loading,
  Pill,
  Time,
} from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { NameDialog } from '../components/NameDialog.js';
import { useNotify } from '../components/Toasts.js';

interface Revealed {
  readonly issued: IssuedKey;
  readonly agentName: string;
}

function activeCount(keys: readonly ApiKeySummary[]): number {
  return keys.filter((key) => key.revokedAt === null || key.revokedAt === undefined).length;
}

/** The once-only reveal. Deliberately hard to dismiss without reading. */
function KeyRevealed({
  revealed,
  onClose,
}: {
  revealed: Revealed;
  onClose: () => void;
}): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false);
  const snippet = `DOGPARK_URL=${window.location.origin}\nDOGPARK_KEY=${revealed.issued.key}`;

  const attemptClose = useCallback(() => {
    if (acknowledged || window.confirm('Close without saving the key? It cannot be shown again.')) {
      onClose();
    }
  }, [acknowledged, onClose]);

  return (
    <Dialog title={`Key for ${revealed.agentName}`} onClose={attemptClose} wide>
      <div className="key-reveal">
        <p className="key-warning">
          <strong>This is the only time this key is shown.</strong> Dogpark stores a hash of it and
          cannot show it again. If you lose it, revoke the key and issue another.
        </p>

        <h3>The key</h3>
        <Copyable value={revealed.issued.key} label="the key" multiline />

        <h3>For the agent&rsquo;s environment</h3>
        <Copyable value={snippet} label="the environment snippet" multiline />

        {revealed.issued.keyId !== undefined && (
          <p className="muted small">
            Key id <Id value={revealed.issued.keyId} />, revocable on its own, so rotation is
            add&#8209;deploy&#8209;revoke.
          </p>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I have saved this key somewhere it will survive.
        </label>

        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!acknowledged}
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function AgentsScreen({ selected }: { selected?: AgentId | undefined }): ReactNode {
  const api = useApi();
  const notify = useNotify();
  const agents = useAsync(() => api.listAgents(), [api]);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<AdminAgent | null>(null);
  const [issuing, setIssuing] = useState<AdminAgent | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const all = agents.state.data ?? [];
  const visible = showArchived ? all : all.filter((agent) => !agent.archived);
  const archivedCount = all.filter((agent) => agent.archived).length;
  const detail = selected === undefined ? null : (all.find((a) => a.id === selected) ?? null);

  const act = useCallback(
    async (what: string, run: () => Promise<unknown>) => {
      try {
        await run();
        notify('ok', what);
        agents.reload();
      } catch (cause) {
        notify('bad', cause instanceof Error ? cause.message : String(cause));
      }
    },
    [notify, agents],
  );

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h1>Agents</h1>
          <p className="muted">
            An agent is a role, not a process. Archiving revokes every key and keeps the history;
            unarchiving returns the role with a fresh one.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          New agent
        </button>
      </header>

      {agents.state.status === 'loading' && agents.state.data === null && <Loading what="agents" />}
      {agents.state.error !== null && (
        <Failure error={agents.state.error} onRetry={agents.reload} />
      )}

      {archivedCount > 0 && (
        <label className="check inline">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived ({archivedCount})
        </label>
      )}

      {agents.state.data !== null && visible.length === 0 && (
        <Empty>No agents yet. Create one and hand it the key.</Empty>
      )}

      <ul className="rows agent-rows">
        {visible.map((agent) => {
          const unproven = !agent.hasEverAuthenticated && agent.failedAttemptsClaimingId > 0;
          const isOpen = detail?.id === agent.id;
          const keys = agent.keys;
          return (
            <li
              key={agent.id}
              className={`row-item agent-row${isOpen ? ' open' : ''}${unproven ? ' warn' : ''}`}
            >
              <div className="agent-summary">
                <div>
                  <a
                    href={isOpen ? href.agents() : href.agents(agent.id)}
                    className="agent-name"
                    aria-expanded={isOpen}
                  >
                    {agent.displayName}
                  </a>
                  {agent.archived && <Pill tone="muted">archived</Pill>}
                  <div className="muted small">
                    {agent.lastSeenAt === null ? (
                      'never authenticated'
                    ) : (
                      <>
                        last seen <Time iso={agent.lastSeenAt} />
                      </>
                    )}
                    {
                      <>
                        {' - '}
                        {activeCount(keys)} active key{activeCount(keys) === 1 ? '' : 's'}
                      </>
                    }
                  </div>
                </div>
                <div className="row">
                  <a className="btn btn-quiet" href={href.reads(agent.id)}>
                    Reads
                  </a>
                  <a
                    href={isOpen ? href.agents() : href.agents(agent.id)}
                    className="btn btn-quiet"
                  >
                    {isOpen ? 'Close' : 'Manage'}
                  </a>
                </div>
              </div>

              {unproven && (
                <p className="unproven" role="note">
                  <strong>
                    {agent.failedAttemptsClaimingId} failed attempt
                    {agent.failedAttemptsClaimingId === 1 ? '' : 's'} claiming this id
                  </strong>{' '}
                  and this agent has never authenticated successfully. That is most likely a wrong
                  or stale key in its configuration -- though anyone who knows the id can produce
                  these, so it is not proof the agent itself tried.
                </p>
              )}

              {isOpen && (
                <div className="agent-detail">
                  <Facts>
                    <Fact name="Id">
                      <Id value={agent.id} />
                    </Fact>
                    {agent.createdAt !== undefined && (
                      <Fact name="Created">
                        <Time iso={agent.createdAt} />
                      </Fact>
                    )}
                    <Fact name="Last seen">
                      {agent.lastSeenAt === null ? (
                        <span className="muted">never</span>
                      ) : (
                        <Time iso={agent.lastSeenAt} />
                      )}
                    </Fact>
                    <Fact name="Attempts claiming this id">
                      {agent.failedAttemptsClaimingId}
                      <span className="muted small">
                        {' '}
                        -- rejected authentications bearing this id, from anywhere.
                        {agent.hasEverAuthenticated
                          ? ' This agent has authenticated successfully at least once.'
                          : ''}
                      </span>
                    </Fact>
                  </Facts>

                  <h3>Keys</h3>
                  {keys.length === 0 ? (
                    <Empty>No keys have ever been issued for this agent.</Empty>
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Key</th>
                          <th>Label</th>
                          <th>Created</th>
                          <th>State</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {keys.map((key) => {
                          const revoked = key.revokedAt !== null;
                          return (
                            <tr key={key.keyId} className={revoked ? 'muted' : ''}>
                              <td>
                                <Id value={key.keyId} />
                              </td>
                              <td>{key.label ?? <span className="muted">-</span>}</td>
                              <td>
                                <Time iso={key.createdAt} />
                              </td>
                              <td>
                                {revoked ? (
                                  <>
                                    <Pill tone="muted">revoked</Pill> <Time iso={key.revokedAt} />
                                  </>
                                ) : (
                                  <Pill tone="ok">active</Pill>
                                )}
                              </td>
                              <td>
                                {!revoked && (
                                  <button
                                    type="button"
                                    className="btn btn-quiet btn-danger"
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          'Revoke this key? Anything still using it stops authenticating immediately.',
                                        )
                                      ) {
                                        void act('Key revoked.', () =>
                                          api.revokeKey(agent.id, key.keyId),
                                        );
                                      }
                                    }}
                                  >
                                    Revoke
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}

                  <div className="row wrap agent-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setIssuing(agent)}
                      disabled={agent.archived}
                    >
                      Issue a key
                    </button>
                    <button type="button" className="btn" onClick={() => setRenaming(agent)}>
                      Rename
                    </button>
                    {agent.archived ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          void (async () => {
                            try {
                              const issued = await api.unarchiveAgent(agent.id);
                              setRevealed({ issued, agentName: agent.displayName });
                              agents.reload();
                            } catch (cause) {
                              notify('bad', cause instanceof Error ? cause.message : String(cause));
                            }
                          })();
                        }}
                      >
                        Unarchive (issues a fresh key)
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Archive ${agent.displayName}?\n\nEvery key is revoked and the role is hidden. Memberships and history survive, and unarchiving returns it with a new key.`,
                            )
                          ) {
                            void act('Archived, and every key revoked.', () =>
                              api.archiveAgent(agent.id),
                            );
                          }
                        }}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {creating && (
        <NameDialog
          title="New agent"
          label="Name"
          submitLabel="Create"
          hint="Names are unique and are how @mentions resolve. The key is shown once, on the next screen."
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            const issued = await api.createAgent(name);
            const id = issued.agent?.id;
            setRevealed({ issued, agentName: issued.agent?.displayName ?? name });
            agents.reload();
            if (id !== undefined) navigate(href.agents(id));
          }}
        />
      )}

      {renaming !== null && (
        <NameDialog
          title={`Rename "${renaming.displayName}"`}
          label="Name"
          initial={renaming.displayName}
          submitLabel="Rename"
          hint="Mentions of this agent re-render to the new name everywhere, including in messages already sent."
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            await api.renameAgent(renaming.id, name);
            notify('ok', 'Renamed.');
            agents.reload();
          }}
        />
      )}

      {issuing !== null && (
        <NameDialog
          title={`Issue a key for "${issuing.displayName}"`}
          label="Label (optional, e.g. where it will live)"
          submitLabel="Issue"
          allowEmpty
          hint="Existing keys keep working. Revoke the old one once the new one is deployed."
          onClose={() => setIssuing(null)}
          onSubmit={async (label) => {
            const issued = await api.issueKey(issuing.id, label === '' ? undefined : label);
            setRevealed({ issued, agentName: issuing.displayName });
            agents.reload();
          }}
        />
      )}

      {revealed !== null && <KeyRevealed revealed={revealed} onClose={() => setRevealed(null)} />}
    </section>
  );
}
