# Security policy

## Reporting a vulnerability

Email `preston@baseline.marketing` with the subject line `SECURITY: demiurge`.
PGP is welcome, request the key in your first mail.

If you do not get an acknowledgment within 7 days, open a private GitHub
Security Advisory through this repository's Security tab. Please do not open a
public issue for an unfixed vulnerability.

Acknowledgment target is 48 hours. Triage decision within 7 days. Fix windows
are severity-tiered: 7 days for critical, 30 for high, 90 for medium and low.

[`docs/security/disclosure.md`](docs/security/disclosure.md) is the full policy,
including the CVSS tiers, the advisory process, reporter credit, and embargo
handling. Read that one if you are filing a report.

## Scope

In scope, the engine itself:

- Authentication and authorization on the REST and MCP surfaces
- Encryption at rest, key handling, and the vault
- The audit chain and any way to tamper with it without detection
- Memory isolation between users
- Read-path injection defense and write-path adjudication
- Anything that lets stored memory be forged, poisoned, or silently altered

Out of scope:

- Third-party dependencies. Report those upstream. Once upstream patches,
  demiurge bumps and re-audits.
- Operator-controlled deployment choices: network ACLs, reverse proxy
  configuration, weak admin tokens, exposing port 3100 beyond localhost.
- Findings with no demonstrated impact. Hardening suggestions are welcome, they
  just go through normal issues and pull requests.

## Supported versions

`main` is the supported branch. Fixes land there first, and each one ships with
a GitHub release note tagged `security`.

## Operator responsibilities

A few things the engine cannot do for you:

- `DEMIURGE_DB_KEY` is the only way to decrypt the database. There is no
  recovery path. Back it up off the server.
- Keep the port bound to localhost. `docker-compose.yml` ships it that way for
  a reason: a Docker port bind can bypass a host firewall.
- Rotate `DEMIURGE_API_KEY` and `DEMIURGE_ADMIN_TOKEN` if either is exposed.
  See [`docs/security/key-rotation.md`](docs/security/key-rotation.md).

## No bug bounty

There is no paid bounty. Reporters get credit in the advisory and release note
unless they decline, a maintainer reference if useful, and coordinated
disclosure to downstream projects when a finding affects them.
