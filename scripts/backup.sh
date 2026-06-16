#!/bin/bash
# Demiurge brain backup script.
# Copies SQLite database + Thompson shadow log to timestamped backup.
# Run via cron or manually.

set -euo pipefail

BACKUP_DIR="${BACKUP_PATH:-./backups}"
DB_PATH="${DB_PATH:-./data/demiurge.db}"
SHADOW_LOG="${BACKUP_DIR}/thompson-shadow.jsonl"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="demiurge_backup_${TIMESTAMP}"

mkdir -p "${BACKUP_DIR}"

echo "Backing up Demiurge..."

# SQLite online backup (safe with WAL mode)
if [ -f "${DB_PATH}" ]; then
  sqlite3 "${DB_PATH}" ".backup '${BACKUP_DIR}/${BACKUP_NAME}.db'"
  echo "Database backed up: ${BACKUP_DIR}/${BACKUP_NAME}.db"
else
  echo "Warning: Database not found at ${DB_PATH}"
fi

# Thompson shadow log
if [ -f "${SHADOW_LOG}" ]; then
  cp "${SHADOW_LOG}" "${BACKUP_DIR}/${BACKUP_NAME}_thompson.jsonl"
  echo "Shadow log backed up: ${BACKUP_DIR}/${BACKUP_NAME}_thompson.jsonl"
fi

# Compress
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" \
  -C "${BACKUP_DIR}" \
  "${BACKUP_NAME}.db" \
  "${BACKUP_NAME}_thompson.jsonl" 2>/dev/null || \
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}.tar.gz" \
  -C "${BACKUP_DIR}" \
  "${BACKUP_NAME}.db"

# Cleanup uncompressed
rm -f "${BACKUP_DIR}/${BACKUP_NAME}.db" "${BACKUP_DIR}/${BACKUP_NAME}_thompson.jsonl"

echo "Backup complete: ${BACKUP_DIR}/${BACKUP_NAME}.tar.gz"

# Retention: keep last 30 backups
ls -t "${BACKUP_DIR}"/demiurge_backup_*.tar.gz | tail -n +31 | xargs -r rm -f
echo "Retention applied (keeping last 30)."
