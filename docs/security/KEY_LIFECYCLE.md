# Key lifecycle

Demiurge is encrypted at rest and sovereign by design: keys are held by the
operator, never by Anthropic or any third party. That choice has a blunt
consequence, stated here so no one is surprised by it later.

> **Key loss is total data loss.** There is no recovery path, no backdoor, and
> no vendor who can decrypt the store for you. Treat the keys with the same care
> as the data itself, because they ARE the data.

This document is the lifecycle reference required by reconciliation D11 (WB-7).
The step-by-step DB rekey lives in `docs/security/key-rotation.md`; this file
covers the full set of keys, the escrow decision, and the rotation drill record.

## The keys

| Key | Purpose | Loss consequence |
| --- | --- | --- |
| `DEMIURGE_DB_KEY` | 32-byte SQLCipher key for the main store | The encrypted DB is **unrecoverable**: total loss of all memories and audit history. |
| `DEMIURGE_VAULT_KEY` | Encrypts vault secrets (W4.5) | All stored vault secrets become **unrecoverable**. The rest of the store is unaffected. |
| `AUDIT_SNAPSHOT_KEY` | HMAC key signing audit-chain snapshots | No data loss. You lose the ability to verify the signature of snapshots taken under the old key; rotate forward and new snapshots verify normally. Keep the old key as long as you keep snapshots signed with it. |

All three are 32-byte values; generate with `openssl rand -hex 32`. They are
supplied via the environment / `EnvironmentFile=` and never written to the repo.

## Escrow decision

**Decision (sovereignty posture): no third-party key escrow.** Keys are held only
by the operator. The mitigation for loss is operator-controlled redundancy, not
escrow:

- Keep a **sealed offline backup of each key** (e.g. a printed/paper copy or an
  offline encrypted vault) stored separately from the encrypted DB backups.
- Back up the encrypted DB on its own cadence (nightly, per the go-live gate).
  The DB backup plus the key backup, kept apart, is the recovery kit.
- Never store a key in the same location as a backup it can decrypt.

Rationale: this is a personal/sovereign brain. Third-party escrow would
reintroduce exactly the trust dependency the product exists to avoid. The cost
is that operator discipline is the only thing standing between a lost key and
lost data, which the warning above makes explicit.

> This posture is the recommended decision for the WB ops session; Preston
> ratifies it there. If he wants an escrow mechanism, it becomes a follow-up.

## Rotation

- **`DEMIURGE_DB_KEY`:** follow `docs/security/key-rotation.md` (stop engine,
  back up, `PRAGMA rekey`, verify, update the secret store, restart). The rekey
  is also audited as a `vault-db-rekey` event.
- **`DEMIURGE_VAULT_KEY`:** rotate by re-encrypting vault records under the new
  key during a maintenance window; see the vault key-source notes
  (`src/security/vault/`). Audited as `vault-db-rekey` for the vault store.
- **`AUDIT_SNAPSHOT_KEY`:** set the new value and restart; future snapshots use
  it. Retain the prior key while older snapshots signed with it are still kept.

Rotate after any suspected exposure, on a recurring cadence (recommended every
12 months), and when an operator with access leaves.

## Rotation drill record

A rotation path that has never been exercised is a path you cannot trust. The
WB ops session must run one real `DEMIURGE_DB_KEY` rotation end to end on the
`demiurge-test` instance and record it below.

| Date | Key | Instance | Result | Operator |
| --- | --- | --- | --- | --- |
| _pending_ | `DEMIURGE_DB_KEY` | demiurge-test | _owed: WB ops session_ | _pending_ |

After the drill, replace the pending row with the real outcome (verified row
count read under the new key, engine restarted clean). Until that row is filled
in, the rotation procedure is documented but unproven.
