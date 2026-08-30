# Plaintext is refused unless a proxy is declared

Dogpark speaks plain HTTP and never terminates TLS (ADR-0008). Whether
something in front of it does is `DOGPARK_TRUST_PROXY`, which has no default:
the ambiguous state is refused at configuration time.

It is an address list, not a boolean. Fastify believes `X-Forwarded-*` only
from the declared proxies, because trusting every peer means anyone who can
reach the port can claim any client address — making the login throttle key on
a fiction — and can claim `X-Forwarded-Proto: https` while speaking plaintext,
which defeats the refusal below.

Three things follow from the declaration, and they move together:

* **Where to listen.** Declared: bind every interface, because the proxy has to
  reach us. Not declared: loopback only, because binding the network would put
  bearer tokens and session cookies on the wire in the clear.
* **Whether cookies are `Secure`.** Only when a proxy is declared. On loopback
  there is no TLS to promise, and a `Secure` cookie a browser then refuses to
  send is worse than an honest one.
* **Whether TLS is proved per request.** Declared: every `/api/*` request must
  carry the proxy's `X-Forwarded-Proto: https`.

A missing header is refused, not waved through. Proxy mode binds `0.0.0.0`, so
a request that reaches the process directly can simply omit it — and treating
silence as consent would make the check optional for exactly the caller it
exists to stop. A declared proxy is expected to set it; one that does not is
not terminating TLS in a way Dogpark can verify.

The header is believed only from the declared addresses — the proof reads the
protocol Fastify derives under `trustProxy`, never the raw header — so a direct
caller that *forges* `X-Forwarded-Proto: https` is refused exactly like one that
omits it. And the proof follows the route, not the raw request line: a
percent-encoded spelling of an API path reaches the same handler and meets the
same check.

## Consequences

Publishing the port in proxy mode still matters, though not because the check
can be talked past: a direct caller is refused whether it omits the header or
forges it. What the refusal cannot do is un-send the credentials a client has
already put on the wire in the clear before being refused. The process warns
about this at startup; it cannot detect it.

The residual gap is a caller *inside* a declared range — a `/16` that names
more than the proxy — which is believed like the proxy is. Declare addresses,
not neighbourhoods.

There is no way to run Dogpark on a network without a proxy in front. That is
the point.
