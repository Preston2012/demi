# Key rotation: `DEMIURGE_DB_KEY`

The on-disk store is encrypted with SQLCipher v4 using the 32-byte hex
value in `DEMIURGE_DB_KEY`. This document describes how to rotate that
key without data loss.

## When to rotate

- After any known or suspected exposure of the existing key.
- On a recurring cadence (recommended: every 12 months).
- When an operator with access leaves the team.
- After a hardware migration where the source host may have retained
  the key in memory dumps or swap files.

## Prerequisites

- Maintenance window long enough to stop the container, run the
  rekey, verify, and restart.
- A **recent backup** of the encrypted DB (`scripts/backup.sh` or
  whatever your deployment uses). PRAGMA rekey rewrites every page; a
  power loss mid-rewrite can corrupt the file.
- `sqlite3` CLI with `pragma_key` support (the SQLCipher-aware build -
  on most distros, install `sqlcipher` rather than plain `sqlite3`).
- The current `DEMIURGE_DB_KEY` value.
- A freshly generated replacement key:
  ```bash
  openssl rand -hex 32
  ```

## Procedure

1. **Stop the engine.** No writes during rekey, or you will rewrite
   pages out from under an active transaction.
   ```bash
   systemctl stop demiurge       # or `docker stop demiurge`
   ```

2. **Back up the encrypted DB.**
   ```bash
   cp /path/to/demiurge.db /path/to/demiurge.db.before-rekey
   ```

3. **Open the DB with the current key and rekey.**
   ```bash
   sqlcipher /path/to/demiurge.db
   ```
   At the SQLCipher prompt:
   ```sql
   PRAGMA key = "x'<CURRENT_64_HEX>'";
   PRAGMA rekey = "x'<NEW_64_HEX>'";
   SELECT count(*) FROM sqlite_master;
   .quit
   ```
   The `SELECT count(*)` verifies the rekey succeeded (it reads a page
   under the new key). A non-zero count and no error means the file is
   now encrypted with the new key.

4. **Update the secret store.** Replace the value in your `.env`,
   secrets manager, or systemd `EnvironmentFile=`:
   ```ini
   DEMIURGE_DB_KEY=<NEW_64_HEX>
   ```

5. **Restart the engine.**
   ```bash
   systemctl start demiurge
   ```

6. **Verify boot succeeded.** Boot validation lives in
   [`src/config.ts`](../../src/config.ts) (line 19, key format regex;
   line 183, production fatal check). A wrong key produces an
   `SQLITE_NOTADB` open error immediately at startup.

7. **Smoke test.** A trivial read via the CLI or REST admin endpoint
   confirms decryption works end-to-end.

8. **Retire the old key.** Wipe it from any place it was stored
   (operator notes, scratch files, terminal history). Keep the
   pre-rekey backup until the next backup cycle confirms the rotated
   DB is healthy, then destroy the backup as well, it still holds
   the old key.

## Notes and caveats

- `:memory:` databases ignore `PRAGMA key`. They never persist to
  disk, so there is nothing to rotate.
- If the engine refuses to start with `[FATAL] DEMIURGE_DB_KEY is
  required when NODE_ENV=production`, the env variable is missing or
  empty. See `src/config.ts:183`.
- If the engine reports `file is not a database`, the key value is
  wrong for the file on disk. Restore from the pre-rekey backup.
- A failed PRAGMA rekey (e.g. disk full mid-rewrite) leaves the file
  in an inconsistent state. Restore from the pre-rekey backup, fix
  the underlying issue, and retry.
- Do not store the key in the repository, in a Git commit, in a
  Dockerfile `ENV`, or in any image layer. Use a runtime secret
  source (`.env`, secrets manager, systemd `EnvironmentFile=`).

## Rotating webhook and admin secrets

The same maintenance window is a good time to rotate the other
runtime secrets:

- `WEBHOOK_SECRET`, used by `src/security/alert-webhook.ts` to sign
  outgoing alerts. Rotate by updating the env var and the receiving
  service's verification key in lockstep.
- `ADMIN_TOKEN`, used by `src/security/auth.ts` to gate the REST
  admin endpoints. Rotate by updating the env var; any CLI or script
  using the old value will start getting `401`.

These do not require a DB rewrite. A process restart picks up the
new values.
