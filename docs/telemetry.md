# Telemetry operator guide (Wedge 1.5)

This guide is for operators running demiurge in production. It explains
what telemetry the engine captures, where it goes, how to inspect it,
and the security knobs that govern it.

Telemetry is **OFF by default**. Enabling it costs measurable but
bounded overhead and writes to a separate database file.

## Enabling

Set in `.env` (or your secrets manager / `systemd EnvironmentFile=`):

```
TELEMETRY_ENABLED=true
TELEMETRY_DB_PATH=./data/telemetry.db   # default
```

Restart the engine. Telemetry tables are created on first boot via
`src/telemetry/migrations.ts`.

If `TELEMETRY_ENABLED` is unset or false, all instrumentation hooks
no-op (the call sites still execute but the writer is a sink).

## What gets captured

Twelve tables, all in the sidecar `telemetry.db`. Schemas in
[`src/telemetry/migrations.ts`](../src/telemetry/migrations.ts).

| Table                 | What it records                                |
| --------------------- | ---------------------------------------------- |
| `traces`              | Root request envelopes (search, answer, write) |
| `spans`               | Nested timing spans per trace                  |
| `decisions`           | Engine decision points (routing, gating)       |
| `conflicts`           | Detected information conflicts (read & write)  |
| `refusals`            | Refusal events from both gates                 |
| `llm_calls`           | Per-call LLM cost, tokens, latency             |
| `cache_events`        | Hit/miss/evict across all four cache layers    |
| `auth_events`         | Auth attempts (success and failure)            |
| `rate_limit_events`   | Rate-limit hits and 429 responses              |
| `errors`              | Unhandled / handled-but-logged errors          |
| `deprecation_events`  | Use of deprecated APIs                         |
| `bodies`              | Redacted request/response bodies (sampled)     |

Bodies are redacted via [`src/security/redact.ts`](../src/security/redact.ts)
before persistence. See "Redaction" below.

## Storage layout

- Telemetry lives in a separate SQLite database from the engine state
  (the AMB). They never share a file.
- Default path: `./data/telemetry.db`, overridable via
  `TELEMETRY_DB_PATH`.
- The DB is **not** SQLCipher-encrypted by default. Treat it as
  sensitive (it can contain redacted-but-still-revealing
  request/response excerpts). Mount it on encrypted-at-rest storage,
  back it up separately from the AMB.
- WAL is enabled (`TELEMETRY_WAL_MODE=true`, default).

## CLI inspection

```
demiurge telemetry <subcommand> [flags]
```

Subcommands wired in
[`src/cli/telemetry-commands.ts`](../src/cli/telemetry-commands.ts):

- `show-traces`, recent root traces with timing and outcome
- `show-decisions`, recent decision events
- `show-refusals`, recent refusal events from read or write gates
- `show-cost`, LLM cost aggregation over a window
- `show-errors`, recent error events grouped by kind
- `show-cache-rates`, hit/miss ratios per cache layer
- `show-rate-limits`, recent 429s and rate-limited users
- `prune-old [--days N]`, drop telemetry older than N days (default
  30)
- `verify-encryption`, sanity-check that the AMB's encryption is
  active (read-only probe)
- `verify-audit-chain`, verify the AMB hash chain for tamper detection

`bin/demiurge` is the operator-facing wrapper; it execs the compiled
CLI from `dist/cli/index.js`. Build (`npm run build`) before invoking.

## REST admin surface

All admin routes require `Authorization: Bearer $ADMIN_TOKEN` and are
defined in [`src/rest/admin-routes.ts`](../src/rest/admin-routes.ts):

- `GET /admin/telemetry/traces`
- `GET /admin/telemetry/decisions`
- `GET /admin/telemetry/refusals`
- `GET /admin/telemetry/cost`
- `GET /admin/telemetry/errors`
- `GET /admin/telemetry/cache-rates`
- `GET /admin/security/rate-limits`
- `POST /admin/telemetry/prune` (body: `{ "days": N }`)

`ADMIN_TOKEN` is validated by
[`src/security/auth.ts`](../src/security/auth.ts) with constant-time
comparison. A missing token returns 401; a present-but-wrong token
returns 403.

## Prometheus metrics

`GET /metrics` exposes counters and histograms in Prometheus
exposition format. By default the endpoint is open (it is meant to be
scraped by an internal Prometheus). To require auth (recommended if
the metrics endpoint is reachable from anywhere untrusted):

```
PROMETHEUS_REQUIRE_AUTH=true
```

When auth is required, the endpoint enforces the same
`ADMIN_TOKEN` gate as the rest of `/admin/*`.

## Rate limiting

Per-user token bucket implemented in
[`src/security/rate-limit.ts`](../src/security/rate-limit.ts). Defaults:

| Limit kind | Default | Env override               |
| ---------- | ------- | -------------------------- |
| Reads      | 60/min  | `RATE_LIMIT_READ_PER_MIN`  |
| Writes     | 30/min  | `RATE_LIMIT_WRITE_PER_MIN` |
| Ingest     | 5/min   | `RATE_LIMIT_INGEST_PER_MIN`|

Burst capacity is 2x the per-minute rate. Excess requests get HTTP 429
with `Retry-After` set to the seconds until next available token.

Rate-limit events are written to the `rate_limit_events` table; query
via `demiurge telemetry show-rate-limits` or
`GET /admin/security/rate-limits`.

## Audit chain integrity

The AMB writes form a hash chain (each write's hash includes the prior
write's hash). Tampering breaks the chain and is detectable.

A systemd timer runs the chain verifier hourly:

- `scripts/stone-verify-cron.sh`, the verifier itself
- `scripts/stone-verify-cron.service`, systemd unit
- `scripts/stone-verify-cron.timer`, systemd timer

On verification failure the unit calls
[`src/cron/verify-audit-chain.ts`](../src/cron/verify-audit-chain.ts),
which dispatches a webhook alert (see below).

Manual run: `demiurge telemetry verify-audit-chain`.

## Webhook alerting

Five alert kinds are dispatched via
[`src/security/alert-webhook.ts`](../src/security/alert-webhook.ts):

- `audit_chain_broken`
- `encryption_disabled`
- `rate_limit_spike`
- `auth_failure_burst`
- `refusal_spike`

Configure with:

```
WEBHOOK_URL=https://your-incident-channel.example.com/hook
WEBHOOK_SECRET=<random hex, used for HMAC-SHA256 signing>
```

Every dispatch is signed with `X-Demiurge-Signature: sha256=<hex>`
over the request body using `WEBHOOK_SECRET`. The receiver must verify
the signature before acting on the payload.

If `WEBHOOK_URL` is unset, alerts are logged via pino at `warn` level
instead of dispatched.

## Retention

Default 30 days. Override via the CLI for ad-hoc cleanup
(`demiurge telemetry prune-old --days 14`) or the REST endpoint
(`POST /admin/telemetry/prune` with `{ "days": 14 }`).

For automatic pruning, schedule the CLI via cron / systemd timer with
your operator's preferred retention.

## Overhead

The Phase 2 lock gate measured telemetry overhead at well under the
3.5% budget on LOCOMO mini. If you observe higher overhead in your
deployment, the most common cause is unsampled body capture on
high-throughput endpoints. Adjust `TELEMETRY_BODY_SAMPLE_RATE` (0.0 to
1.0, default 0.1).

## Redaction

[`src/security/redact.ts`](../src/security/redact.ts) strips known
secret-shaped substrings (API keys, bearer tokens, JWTs, email
addresses with adjacent context) from any body before it lands in
`bodies`. Redaction is applied at write time; no raw bodies are
persisted.

Operators should still treat `telemetry.db` as containing sensitive
data, redaction is best-effort, not a guarantee against information
disclosure to anyone with read access to the file.

## Disabling

Set `TELEMETRY_ENABLED=false` (or unset) and restart. Existing
`telemetry.db` is left alone (the engine simply stops writing to it).
Delete the file manually if you want to reclaim disk.
