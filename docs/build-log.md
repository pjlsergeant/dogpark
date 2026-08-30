# Build log

Decisions taken while implementing, that the design did not settle. Anything
here that turns out to be load-bearing should graduate to an ADR.

## Structure

`src/types.ts` is the agent protocol, unchanged by implementation. Around it:

* `src/store/` — SQLite: schema, migrations, and the queries. Owns all SQL.
* `src/http/` — Fastify: agent routes, admin routes, auth, static assets.
* `src/notify/` — the webhook queue.
* `ui/` — the Vite/React SPA, built into `dist/ui` and served by Fastify.

## Decisions

*(appended as they are taken)*
