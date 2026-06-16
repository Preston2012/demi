# Dependency policy

This document describes how demiurge manages third-party dependencies.
It is enforced by CI gates and operator process; deviation requires
explicit review.

## Direct dependencies are pinned exactly

All entries in `dependencies` and `devDependencies` use exact versions
(`x.y.z`), not range specifiers (`^x.y.z`, `~x.y.z`, `>=x.y.z`).

Rationale: with caret ranges, a fresh `npm install` (no lockfile) can
resolve to any version satisfying the range. That can mask a shifted
direct dep version between local dev and CI, or between two developers.
Exact pins make "what version of `better-sqlite3` are we on" answerable
from `package.json` alone, useful for SBOM accuracy and for answering
"have we taken the patch for CVE-X yet?"

Transitive dependencies remain whatever the lockfile resolves. Pinning
transitives via `overrides` is a separate, more invasive exercise and
is out of scope for the default policy.

The Phase 5 sweep that established this policy lives in the same commit
as this document.

### Recorded `overrides` exceptions

`package.json` carries exactly one transitive override:

- `fast-uri: 3.1.2`: the URI parser used by `ajv`, `fastify`
  (`@fastify/ajv-compiler`, `fast-json-stringify`), and the SBOM
  generator's `ajv`. The override forces every consumer onto one exact,
  known-good version of a security-sensitive parser that sits on the
  request path, the same rationale as the exact-pin policy for direct
  deps. JSON cannot carry comments, so this section is the override's
  reason of record (cold-audit C-18).

Any new entry in `overrides` must land with a reason added to this
list in the same commit.

## `npm audit` is a CI gate

`.github/workflows/ci.yml` runs two audit steps after lint:

1. `npm audit --audit-level=high --omit=dev`, the production-only
   audit. The intent is to **block merge** on a new high or critical
   CVE in a runtime dependency. As of Phase 5 this step is temporarily
   `continue-on-error: true` while pre-existing CVEs in the
   `@xenova/transformers` → `onnxruntime-web` → `protobufjs` chain are
   triaged separately. The hard gate flips back on once that triage
   lands.
2. `npm audit --audit-level=high`, the full audit including devDeps.
   This is **warn-only** (`continue-on-error: true`) because a CVE in
   a build-time-only dep does not ship to operators.

Moderate and lower findings are not surfaced in CI. They generate too
much noise to be actionable and are reviewed during the periodic dep
sweep instead.

## SBOM is regenerated before each release

`scripts/generate-sbom.sh` produces a CycloneDX 1.5 JSON document under
`./sbom/` (gitignored). The output captures every direct and transitive
production dependency with name, version, and purl. Regenerate it:

- Before tagging a release.
- When answering an enterprise security questionnaire.
- Whenever `package-lock.json` changes in a way that affects production
  deps.

The generator is `@cyclonedx/cyclonedx-npm`, pinned in
`devDependencies`. CycloneDX 1.5 was chosen over SPDX because the
Node.js tooling is maintained by the CycloneDX project itself, which
gives a more accurate purl mapping for npm packages.

## Updates are reviewed individually

- Bumping a direct dep requires reading the upstream changelog for
  breaking changes, even on patch-level bumps. We have been bitten by
  patch-level bugs in dependencies of dependencies.
- Bulk "update everything" sweeps are not allowed. They obscure which
  bump caused which regression.
- A dep update PR touches one or a tightly related cluster of packages
  at a time. The PR description names the upstream changelog entries
  reviewed.
- The lockfile diff is part of the review. Reviewers check for new
  transitive deps and for deps that changed major version
  transitively.

## Dependabot or equivalent is enabled

The repository runs an automated dependency-update tool that opens PRs
for security advisories and minor/patch bumps. Configuration of that
tool is intentionally out of scope for the Phase 5 commit that
introduced this policy and will land in a follow-up PR. Until it does,
operators are expected to run `npm audit` manually on a weekly cadence.

## When the policy is broken

If a CI audit step fails on a new CVE:

1. Read the advisory. Determine if the vulnerable code path is reached
   by the engine.
2. If reachable: patch upstream or pin the transitive via `overrides`,
   open the PR with the audit gate re-armed.
3. If not reachable: document the exception in this file (or in a
   short `docs/security/exceptions.md` follow-up), and add the
   advisory ID to an allowlist. Do not silently disable the gate.

If `npm audit` reports a CVE that has no fix available, open an issue
to track upstream, and decide whether the risk justifies temporarily
flipping the gate to warn-only with an explicit time-bounded waiver.
