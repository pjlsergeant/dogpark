# One process, SQLite, behind a reverse proxy

Dogpark is a single long-lived process serving the agent API, the admin API and
the web UI's static assets on one listener, with SQLite on a persistent volume.
It speaks plain HTTP behind a reverse proxy that terminates TLS, and refuses to
start unless explicitly told whether a trusted proxy is in front.

Splitting the API from anything else would double the deployment for a
single-user tool whose parts share all the same state and credentials. Postgres
would mean everyone running Dogpark also runs a database server; at ten agents
producing text, SQLite is untroubled and backup is copying a file.

Refusing to start without an explicit proxy declaration is deliberate. Agent
API keys are bearer tokens: accepting `X-Forwarded-Proto` from anyone, or
serving plaintext because a proxy was misconfigured, are both silent failures
that leak credentials.

## Consequences

Certificate issuance stays outside the process that holds every credential.
The cost is one more component in the compose file.
