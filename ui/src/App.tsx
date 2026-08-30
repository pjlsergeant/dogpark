/**
 * The shell: boot the client, hold the session, route, and carry the
 * keyboard.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { DogparkAdminApi } from './api/index.js';
import { ApiError, createHttpApi } from './api/index.js';
import { AppProvider, useApp } from './app/api-context.js';
import type { Session } from './app/api-context.js';
import { href, navigate, useRoute } from './app/router.js';
import { ToastHost } from './components/Toasts.js';
import { Dialog } from './components/Dialog.js';
import { Login } from './screens/Login.js';
import { SpaceScreen, SpacesScreen } from './screens/Spaces.js';
import { AgentsScreen } from './screens/Agents.js';
import { ReaderScreen } from './screens/Reader.js';
import { ReadLogScreen } from './screens/ReadLog.js';
import { EscalationsScreen } from './screens/Escalations.js';
import { SearchScreen } from './screens/Search.js';

/**
 * Every call goes through here, so a session that has expired or been
 * invalidated server-side drops the app back to the login screen instead of
 * failing one screen at a time.
 */
function guardSession(api: DogparkAdminApi, onLost: () => void): DogparkAdminApi {
  return new Proxy(api, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          return result.catch((cause: unknown) => {
            if (cause instanceof ApiError && cause.code === 'unauthenticated') onLost();
            throw cause;
          });
        }
        return result;
      };
    },
  });
}

const NAV: readonly { readonly key: string; readonly label: string; readonly to: string }[] = [
  { key: 's', label: 'Spaces', to: '#/spaces' },
  { key: 'a', label: 'Agents', to: '#/agents' },
  { key: 'r', label: 'Reader', to: '#/read' },
  { key: 'l', label: 'Read log', to: '#/reads' },
  { key: 'e', label: 'Escalations', to: '#/escalations' },
  { key: 'f', label: 'Search', to: '#/search?q=' },
];

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function App(): ReactNode {
  const [api, setApi] = useState<DogparkAdminApi | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let live = true;
    void (async () => {
      const client = createHttpApi();
      setApi(client);
      // The cookie may still be good even though the CSRF token, which lives
      // only in memory, went away with the last page.
      const resumed = await client.resume();
      if (!live) return;
      if (resumed !== null) {
        setSession({
          displayName: resumed.displayName,
        });
      }
      setBooting(false);
    })();
    return () => {
      live = false;
    };
  }, []);

  const lose = useCallback(() => setSession(null), []);
  const guarded = useMemo(() => (api === null ? null : guardSession(api, lose)), [api, lose]);

  const logout = useCallback(() => {
    if (guarded === null) return;
    void guarded.logout().finally(() => setSession(null));
  }, [guarded]);

  const value = useMemo(
    () => (guarded === null || session === null ? null : { api: guarded, session, logout }),
    [guarded, session, logout],
  );

  if (booting || guarded === null) {
    return <p className="booting">Starting Dogpark...</p>;
  }

  if (value === null) {
    return (
      <ToastHost>
        <Login api={guarded} onSignedIn={setSession} />
      </ToastHost>
    );
  }

  return (
    <AppProvider value={value}>
      <ToastHost>
        <Shell />
      </ToastHost>
    </AppProvider>
  );
}

function Shell(): ReactNode {
  const route = useRoute();
  const [chord, setChord] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    if (window.location.hash === '') navigate(href.spaces());
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typingInto(event.target)) {
        if (event.key === 'Escape' && event.target instanceof HTMLElement) event.target.blur();
        return;
      }
      if (event.key === '?') {
        setHelp(true);
        return;
      }
      if (event.key === 'Escape') {
        setHelp(false);
        setChord(false);
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        if (route.name === 'search') {
          document.getElementById('search-input')?.focus();
        } else {
          navigate('#/search?q=');
        }
        return;
      }
      if (chord) {
        const target = NAV.find((item) => item.key === event.key.toLowerCase());
        setChord(false);
        if (target !== undefined) {
          event.preventDefault();
          navigate(target.to);
        }
        return;
      }
      if (event.key.toLowerCase() === 'g') {
        setChord(true);
        window.setTimeout(() => setChord(false), 1500);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chord, route.name]);

  return (
    <div className="app">
      <Sidebar route={route.name} chord={chord} onHelp={() => setHelp(true)} />
      <div className="content">
        <Screen />
      </div>
      {help && <Shortcuts onClose={() => setHelp(false)} />}
    </div>
  );
}

function Screen(): ReactNode {
  const route = useRoute();
  switch (route.name) {
    case 'spaces':
      return <SpacesScreen />;
    case 'space':
      return <SpaceScreen space={route.space} />;
    case 'agents':
      return <AgentsScreen selected={route.agent} />;
    case 'read':
      return (
        <ReaderScreen
          space={route.space}
          conversation={route.conversation}
          message={route.message}
        />
      );
    case 'reads':
      return <ReadLogScreen agent={route.agent} />;
    case 'escalations':
      return <EscalationsScreen />;
    case 'search':
      return <SearchScreen q={route.q} space={route.space} />;
  }
}

function Sidebar({
  route,
  chord,
  onHelp,
}: {
  route: string;
  chord: boolean;
  onHelp: () => void;
}): ReactNode {
  const { session, logout } = useApp();
  const current: Record<string, string> = {
    spaces: 'Spaces',
    space: 'Spaces',
    agents: 'Agents',
    read: 'Reader',
    reads: 'Read log',
    escalations: 'Escalations',
    search: 'Search',
  };

  return (
    <nav className="sidebar" aria-label="Main">
      <a className="wordmark" href={href.spaces()}>
        Dogpark
      </a>
      <ul>
        {NAV.map((item) => (
          <li key={item.key}>
            <a
              href={item.to}
              className={current[route] === item.label ? 'current' : ''}
              aria-current={current[route] === item.label ? 'page' : undefined}
            >
              {item.label}
              <kbd className={chord ? 'lit' : ''}>{item.key}</kbd>
            </a>
          </li>
        ))}
      </ul>
      <div className="sidebar-foot">
        <button type="button" className="btn btn-quiet" onClick={onHelp}>
          Keys <kbd>?</kbd>
        </button>
        <div className="muted small">{`Signed in as ${session.displayName}`}</div>
        <button type="button" className="btn btn-quiet" onClick={logout}>
          Sign out
        </button>
      </div>
    </nav>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Dialog title="Keyboard" onClose={onClose}>
      <dl className="facts">
        <dt>
          <kbd>g</kbd> then <kbd>s</kbd> / <kbd>a</kbd> / <kbd>r</kbd> / <kbd>l</kbd> / <kbd>e</kbd>{' '}
          / <kbd>f</kbd>
        </dt>
        <dd>Spaces, agents, reader, read log, escalations, search</dd>
        <dt>
          <kbd>/</kbd>
        </dt>
        <dd>Search</dd>
        <dt>
          <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd>
        </dt>
        <dd>Post the message you are writing</dd>
        <dt>
          <kbd>Esc</kbd>
        </dt>
        <dd>Leave a field, or close a dialog</dd>
        <dt>
          <kbd>?</kbd>
        </dt>
        <dd>This list</dd>
      </dl>
    </Dialog>
  );
}
