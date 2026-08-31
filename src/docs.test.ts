import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { EXAMPLE_PASSWORD, EXAMPLE_PASSWORD_HASH, hashPassword } from './http/password.js';
import { CLIENT_PATH, GUIDE_PATH } from './http/static.js';
import { openStore } from './store/index.js';

// Growth guards: they check that every new surface answered the documentation
// question, not that the answer is true.

const ROOT = join(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');
const running = readFileSync(join(DOCS, 'running.md'), 'utf8');
const httpApi = readFileSync(join(DOCS, 'http-api.md'), 'utf8');

interface Route {
  readonly method: string;
  readonly path: string;
}

// printRoutes is a debug rendering, not a stable interface, so the parser
// fails loudly: a line that looks like a tree row but does not parse is an
// error, and the caller asserts sentinel routes to catch a format change
// that stops lines looking like tree rows at all.
function parseRouteTree(tree: string): Route[] {
  const routes: Route[] = [];
  const paths: string[] = [];
  for (const line of tree.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^((?:[│ ] {3})*)(?:├── |└── )(\S+)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!m) throw new Error(`unparseable printRoutes line: ${JSON.stringify(line)}`);
    const depth = (m[1] ?? '').length / 4;
    const segment = m[2] ?? '';
    const parent = depth === 0 ? '' : (paths[depth - 1] ?? '');
    const path =
      depth === 0
        ? segment
        : (parent === '/' ? '' : parent) + (segment.startsWith('/') ? segment : `/${segment}`);
    paths[depth] = path;
    for (const method of (m[3] ?? '').split(', ')) {
      if (method === '' || method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push({ method, path });
    }
  }
  return routes;
}

describe('ADR index', () => {
  const ADR_DIR = join(DOCS, 'adr');
  const index = readFileSync(join(ADR_DIR, 'README.md'), 'utf8');
  const rows = index.split('\n').filter((line) => /^\| \[\d{4}\]\(/.test(line));

  it('has one row per decision file, and no row without a file', () => {
    const files = readdirSync(ADR_DIR)
      .filter((name) => /^\d{4}-.*\.md$/.test(name))
      .sort();
    const linked = rows.map((row) => /^\| \[\d{4}\]\(([^)]+)\)/.exec(row)?.[1] ?? row).sort();
    expect(linked).toEqual(files);
  });

  it('arms every decision, or says no arm with a reason, and every named arm exists', () => {
    const sources = new Map<string, string>();
    const problems: string[] = [];
    for (const row of rows) {
      const adr = row.slice(3, 7);
      const arm = (row.split('|')[3] ?? '').trim();
      const named = [...arm.matchAll(/`([^`]+)` :: "([^"]+)"/g)];
      if (named.length === 0) {
        if (!/^no arm — \S/.test(arm))
          problems.push(`${adr}: neither an arm nor a reasoned no arm`);
        continue;
      }
      for (const [, file, test] of named) {
        if (file === undefined || test === undefined) continue;
        let source = sources.get(file);
        if (source === undefined) {
          try {
            // Comments are stripped so a commented-out test cannot satisfy
            // the guard. Over-stripping (a /* inside a string) can only make
            // the guard stricter, and loudly.
            source = readFileSync(join(ROOT, file), 'utf8')
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/^\s*\/\/.*$/gm, '');
          } catch {
            problems.push(`${adr}: arm file ${file} does not exist`);
            continue;
          }
          sources.set(file, source);
        }
        // A registered test, not a name that merely survives in a comment or
        // a skipped `it.skip(`.
        if (!source.includes(`it('${test}'`) && !source.includes(`test('${test}'`))
          problems.push(`${adr}: no registered test named "${test}" in ${file}`);
      }
    }
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(problems).toEqual([]);
  });
});

describe('docs drift guards', () => {
  it('every DOGPARK_* variable config.ts reads appears in running.md', () => {
    const source = readFileSync(join(import.meta.dirname, 'config.ts'), 'utf8');
    const vars = [...new Set(source.match(/DOGPARK_[A-Z_]+/g) ?? [])];
    expect(vars.length).toBeGreaterThan(5);
    expect(vars.filter((name) => !running.includes(name))).toEqual([]);
  });

  it('every registered route appears in http-api.md with its method, in its own section', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogpark-docs-'));
    writeFileSync(join(dir, 'guide.md'), 'guard fixture');
    writeFileSync(join(dir, 'client.sh'), 'guard fixture');
    const config = loadConfig({
      DOGPARK_PASSWORD_HASH: hashPassword('docs-guard'),
      DOGPARK_TRUST_PROXY: 'no',
      DOGPARK_DATA_DIR: dir,
    });
    const store = openStore({
      file: join(dir, 'dogpark.sqlite'),
      humanDisplayName: config.DOGPARK_DISPLAY_NAME,
    });
    // guidePath and clientPath make their conditional routes real; uiRoot is
    // left off (CI runs tests before build:ui), so the SPA's static serving
    // is the one surface this guard does not see.
    const app = await buildApp({
      store,
      config,
      guidePath: join(dir, 'guide.md'),
      clientPath: join(dir, 'client.sh'),
    });
    try {
      const routes = parseRouteTree(app.printRoutes({ commonPrefix: false }));
      const parsed = new Set(routes.map(({ method, path }) => `${method} ${path}`));
      // Sentinels: one shallow, one deeply nested. If printRoutes changes
      // format enough that routes stop parsing, these vanish first.
      expect(parsed).toContain('GET /api/agent/stream');
      expect(parsed).toContain('GET /api/admin/reads/:id/conversations/:conversationId/messages');

      const adminAt = httpApi.indexOf('## Admin API');
      expect(adminAt).toBeGreaterThan(0);
      const sections = {
        agent: httpApi.slice(0, adminAt).split('\n'),
        admin: httpApi.slice(adminAt).split('\n'),
      };
      const served = readFileSync(join(DOCS, 'agent-guide.md'), 'utf8');
      const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

      const missing: string[] = [];
      for (const { method, path } of routes) {
        if (path === '/') continue; // the SPA, not API surface
        if (path === '/health') {
          if (!httpApi.includes('GET /health')) missing.push(`${method} ${path}`);
          continue;
        }
        if (path === GUIDE_PATH || path === CLIENT_PATH) {
          if (!served.includes(path) || !readme.includes(path))
            missing.push(`${method} ${path} (must appear in agent-guide.md and README.md)`);
          continue;
        }
        const scoped = /^\/api\/(agent|admin)(\/.*)$/.exec(path);
        if (!scoped) {
          missing.push(`${method} ${path} (outside the documented prefixes)`);
          continue;
        }
        const lines = sections[scoped[1] as 'agent' | 'admin'];
        const suffix = scoped[2] ?? '';
        const documented = lines.some(
          (line) => line.includes(`\`${suffix}\``) && line.includes(`| ${method} |`),
        );
        if (!documented) missing.push(`${method} ${path}`);
      }
      expect(missing).toEqual([]);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the example password', () => {
  // README.md's quick-start `docker run` sets the hash the server treats as
  // the example, and the prose after that block names the password. Anchored
  // to that fenced block and what follows it, not to the strings appearing
  // somewhere in the file: a README whose quick start drifted to another hash
  // while the constant survived elsewhere would otherwise still pass.
  it('is what README.md ships in its quick start, and names the password it unlocks', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```sh\n([\s\S]*?)```\n+([^\n]*)/g)];
    const quickStart = blocks.find(([, code]) => code?.includes('docker run -d'));
    expect(quickStart, 'a ```sh block containing `docker run -d`').toBeDefined();
    const [, code = '', after = ''] = quickStart ?? [];
    expect(code).toContain(`-e DOGPARK_PASSWORD_HASH='${EXAMPLE_PASSWORD_HASH}'`);
    expect(after).toContain(`The password is \`${EXAMPLE_PASSWORD}\`.`);
  });
});
