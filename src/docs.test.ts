import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';
import { hashPassword } from './http/password.js';
import { openStore } from './store/index.js';

// Growth guards: they check that every new surface answered the documentation
// question, not that the answer is true.

const DOCS = join(import.meta.dirname, '..', 'docs');
const running = readFileSync(join(DOCS, 'running.md'), 'utf8');
const httpApi = readFileSync(join(DOCS, 'http-api.md'), 'utf8');

interface Route {
  readonly method: string;
  readonly path: string;
}

function parseRouteTree(tree: string): Route[] {
  const routes: Route[] = [];
  const paths: string[] = [];
  for (const line of tree.split('\n')) {
    const m = /^((?:[│ ] {3})*)(?:├── |└── )(\S+)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!m) continue;
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
            source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
          } catch {
            problems.push(`${adr}: arm file ${file} does not exist`);
            continue;
          }
          sources.set(file, source);
        }
        if (!source.includes(test)) problems.push(`${adr}: no test named "${test}" in ${file}`);
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

  it('every registered route appears in http-api.md with its method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogpark-docs-'));
    const config = loadConfig({
      DOGPARK_PASSWORD_HASH: hashPassword('docs-guard'),
      DOGPARK_TRUST_PROXY: 'no',
      DOGPARK_DATA_DIR: dir,
    });
    const store = openStore({
      file: join(dir, 'dogpark.sqlite'),
      humanDisplayName: config.DOGPARK_DISPLAY_NAME,
    });
    const app = await buildApp({ store, config });
    try {
      const routes = parseRouteTree(app.printRoutes({ commonPrefix: false }));
      expect(routes.length).toBeGreaterThan(25);
      const docLines = httpApi.split('\n');
      const missing: string[] = [];
      for (const { method, path } of routes) {
        if (path === '/') continue; // the SPA, not API surface
        if (path === '/health') {
          if (!httpApi.includes('GET /health')) missing.push(`${method} ${path}`);
          continue;
        }
        const scoped = /^\/api\/(?:agent|admin)(\/.*)$/.exec(path);
        if (!scoped) {
          missing.push(`${method} ${path} (outside the documented prefixes)`);
          continue;
        }
        const suffix = scoped[1] ?? '';
        const documented = docLines.some(
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
