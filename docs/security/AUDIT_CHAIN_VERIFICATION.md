# Audit chain verification: install + operation

The audit log is an append-only, per-user hash chain (see
`src/repository/audit-log.ts`). Integrity is checked two ways:

- **On demand:** `demiurge verify-chain` (or `demiurge telemetry verify-audit-chain`).
  Verify-only, no side effects. Exit 0 = clean, 2 = integrity failure, 3 = crash.
- **Continuously:** a systemd timer runs the same code path hourly and, when
  `AUDIT_SNAPSHOT_KEY` is set, writes an HMAC-signed snapshot off-box.

Verification is epoch-aware (R29 WB-3): pre-epoch rows are checked as one global
chain, post-epoch rows per user, and the one-time epoch marker is validated
first. Dangling references left by intentional deletions are tolerated only when
covered by the deletion tombstone manifest (`audit_tombstones`).

## Ordering (important)

Install the timer ONLY after the WB-1..WB-4 migration has shipped and run on the
host (so `chain_head`, the epoch marker, and the tombstone manifest exist). The
migration runs automatically on the first engine boot after deploy. Reconciliation
item #23.

## Files

- `scripts/stone-verify-cron.service` (one-shot unit)
- `scripts/stone-verify-cron.timer` (hourly, 300s jitter, `Persistent=true`)
- `scripts/stone-verify-cron.sh` (wrapper: `node dist/cron/verify-audit-chain.js`)

The units assume `WorkingDirectory=/root/demiurge` and
`EnvironmentFile=/root/demiurge/.env`. Adjust paths per host if the checkout
differs (CAX21 dogfood lives at `/root/demiurge-dogfood`).

## Install (run on BOTH hosts: CAX11 prod, CAX21 dogfood)

```bash
# 1. Build is current (dist/cron/verify-audit-chain.js exists)
npm run build

# 2. Confirm AUDIT_SNAPSHOT_KEY is set in the host .env if you want snapshots
#    (a manual `demiurge verify-chain` does not need it; the timer uses it to
#    write signed snapshots to config.backupPath).
grep -q '^AUDIT_SNAPSHOT_KEY=' /root/demiurge/.env || echo 'WARN: no snapshot key; timer will verify-only'

# 3. Install the unit files (edit WorkingDirectory/EnvironmentFile first if the
#    checkout path differs on this host).
cp scripts/stone-verify-cron.service /etc/systemd/system/
cp scripts/stone-verify-cron.timer   /etc/systemd/system/

# 4. Enable + start the timer
systemctl daemon-reload
systemctl enable --now stone-verify-cron.timer

# 5. Verify it is scheduled and run once now
systemctl list-timers stone-verify-cron.timer --no-pager
systemctl start stone-verify-cron.service
journalctl -u stone-verify-cron.service --no-pager -n 30
```

A clean run logs `audit chain verified clean (epoch-aware)`. An integrity failure
logs `AUDIT CHAIN INTEGRITY FAILURE`, fires the `audit_chain_failure` webhook, and
exits 2 (the timer surfaces this in `systemctl status`).

## Manual check

```bash
demiurge verify-chain            # exit 0 clean, 2 on failure
# or, equivalently:
demiurge telemetry verify-audit-chain
```
