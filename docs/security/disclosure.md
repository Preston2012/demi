# Vulnerability disclosure policy

This document expands [`SECURITY.md`](../../SECURITY.md). It is the
operator-facing source of truth for how demiurge handles reports.

## Reporting channel

Email `preston@baseline.marketing` with the subject line
`SECURITY: demiurge`. Encrypted mail is welcomed if you want to use
PGP, request the key in your initial mail.

If email does not get an acknowledgment within 7 days, open a private
GitHub Security Advisory through the repository's Security tab as a
fallback. Do not open a public issue.

## Response timeline

| Step                          | Target SLA                |
| ----------------------------- | ------------------------- |
| Acknowledgment of receipt     | 48 hours                  |
| Triage decision (accept /     | 7 days                    |
| decline / request more info)  |                           |
| Fix and patched build         | severity-tiered, see next |
| Public advisory               | within 7 days of patch    |
| CVE request (if applicable)   | within 14 days of patch   |

Triage outcomes:

- **Accept**, the report is in scope and exploitable. Fix work
  begins; reporter is given a contact for coordination.
- **Decline**, the report is out of scope (see
  [`SECURITY.md`](../../SECURITY.md) "Scope") or not exploitable. The
  reporter receives the rationale.
- **Request more info**, the reporter is asked for a minimum
  reproducer or additional context. The triage clock resets when a
  response arrives.

## Severity tiers and fix windows

Severity follows [CVSS 3.1](https://www.first.org/cvss/v3-1/) base
scores, with environmental adjustment for the typical demiurge
deployment (single-tenant, behind an authenticated API gateway).

| Severity | CVSS  | Examples                                         | Fix window |
| -------- | ----- | ------------------------------------------------ | ---------- |
| Critical | 9.0+  | Pre-auth RCE, AMB cross-tenant data exfiltration | 7 days     |
| High     | 7.0-8.9 | Auth bypass, privilege escalation,             | 30 days    |
|          |       | encryption-at-rest bypass, persistent XSS        |            |
| Medium   | 4.0-6.9 | DoS amplification, sensitive log leakage,       | 90 days    |
|          |       | rate-limit bypass                                |            |
| Low      | <4.0  | Information disclosure of non-sensitive metadata | 90 days    |

If a fix would require breaking changes that operators need to
schedule, the timeline extends with a published mitigation in the
interim. Mitigations are noted in the advisory.

## Public advisory

When the fix ships, demiurge publishes a [GitHub Security
Advisory](https://docs.github.com/en/code-security/security-advisories)
on the repository. The advisory includes:

- A description of the vulnerability and the impact.
- Affected versions and the patched version.
- A mitigation for operators who cannot upgrade immediately.
- Credit to the reporter (unless declined).
- A CVE identifier when applicable (we request CVEs for any High or
  Critical severity finding, and for Medium findings on the engine
  itself rather than on operator-controlled surfaces).

The advisory is announced via:

- A GitHub release note tagged `security`.
- The CHANGELOG entry for the patched version.

## Reporter credit

By default, the reporter is credited by name in the advisory and the
release note. To opt out, indicate so in your initial report or at any
time before publication.

We do not currently offer a paid bug bounty. We do offer:

- Credit in the advisory.
- A maintainer reference for your CV / portfolio.
- Coordinated disclosure to other downstream projects if your finding
  affects them.

## Embargo and coordination

If the report affects other projects (e.g. an upstream library), we
coordinate disclosure with those maintainers and honor reasonable
embargoes (typically 14–30 days beyond our own fix window) so that
patches can ship in parallel.

If you intend to publish your own write-up, please share a draft with
us before publication so we can confirm the timeline and avoid the
"surprise advisory" failure mode.

## What this policy does **not** cover

- Vulnerabilities in third-party dependencies. Please report those to
  the upstream maintainers. Once upstream has patched, demiurge will
  bump and re-audit.
- Findings against operator-controlled deployments (network ACLs,
  reverse proxy misconfiguration, weak admin tokens) that are not
  caused by the engine itself.
- Speculative concerns without a demonstrated impact. We are happy to
  receive hardening suggestions, but they go through normal issues /
  PR review rather than the disclosure track.
