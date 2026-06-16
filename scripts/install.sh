#!/usr/bin/env bash
set -euo pipefail

# Demiurge install script.
# Single-command setup for a fresh Linux host with systemd.
#
# Supported images (Hetzner's three common ones): Ubuntu 22.04, Ubuntu 24.04,
# Debian 12. Other systemd distros are likely fine but untested.
#
# Idempotent: safe to re-run on an existing install (won't overwrite keys
# unless FORCE_REINSTALL=1 is passed).

# ===== Defaults (override via env) =====
SERVICE_USER="${DEMIURGE_SERVICE_USER:-demiurge}"
KEY_DIR="${DEMIURGE_KEY_DIR:-/etc/demiurge/keys}"
DATA_DIR="${DEMIURGE_DATA_DIR:-/var/lib/demiurge}"
LOG_DIR="${DEMIURGE_LOG_DIR:-/var/log/demiurge}"
ENGINE_PORT="${DEMIURGE_PORT:-3100}"
RECOVERY_BUNDLE_PATH="${DEMIURGE_RECOVERY_BUNDLE_PATH:-}"  # operator-supplied destination

# ===== Pre-flight checks =====
echo "[1/8] Pre-flight checks..."

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: install.sh must be run as root (use sudo)." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: systemd not available. install.sh assumes systemd-managed host." >&2
  exit 1
fi

NODE_VERSION=$(node --version 2>/dev/null || echo "missing")
if [[ "$NODE_VERSION" == "missing" ]]; then
  echo "ERROR: Node.js not installed. Install Node 24.7+ first." >&2
  exit 1
fi
# Parse major.minor and verify >= 24.7
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f2)
if [[ "$NODE_MAJOR" -lt 24 ]] || { [[ "$NODE_MAJOR" -eq 24 ]] && [[ "$NODE_MINOR" -lt 7 ]]; }; then
  echo "ERROR: Node $NODE_VERSION is too old. Need 24.7+." >&2
  exit 1
fi

if ss -tlnp 2>/dev/null | grep -q ":$ENGINE_PORT "; then
  echo "ERROR: port $ENGINE_PORT already in use." >&2
  exit 1
fi

if [[ -d "$KEY_DIR" ]] && [[ -z "${FORCE_REINSTALL:-}" ]]; then
  echo "ERROR: $KEY_DIR already exists. Pass FORCE_REINSTALL=1 to overwrite (DESTRUCTIVE)." >&2
  exit 1
fi

DISK_FREE_MB=$(df -BM "${DATA_DIR%/*}" | awk 'NR==2 {gsub("M","",$4); print $4}')
if [[ "$DISK_FREE_MB" -lt 500 ]]; then
  echo "ERROR: less than 500MB free at ${DATA_DIR%/*}." >&2
  exit 1
fi

echo "  OK: Node $NODE_VERSION, systemd present, port $ENGINE_PORT free, disk OK."

# ===== Service user =====
echo "[2/8] Service user..."

if id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "  OK: user $SERVICE_USER already exists, reusing."
else
  useradd --system --shell /usr/sbin/nologin --home-dir "$DATA_DIR" --create-home "$SERVICE_USER"
  echo "  OK: created $SERVICE_USER."
fi

# ===== Directories =====
echo "[3/8] Directories..."

mkdir -p "$KEY_DIR" "$DATA_DIR" "$LOG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$KEY_DIR" "$DATA_DIR" "$LOG_DIR"
chmod 700 "$KEY_DIR"
chmod 750 "$DATA_DIR" "$LOG_DIR"

echo "  OK: $KEY_DIR (0700), $DATA_DIR (0750), $LOG_DIR (0750)."

# ===== Key generation (calls install-vault.sh from W4.5) =====
echo "[4/8] Generate master keys..."

if [[ -x "$(dirname "$0")/install-vault.sh" ]] || [[ -f "$(dirname "$0")/install-vault.sh" ]]; then
  DEMIURGE_KEY_DIR="$KEY_DIR" \
    bash "$(dirname "$0")/install-vault.sh"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$KEY_DIR"
else
  # Inline fallback if install-vault.sh not adjacent.
  for keyname in db vault audit; do
    openssl rand 32 > "$KEY_DIR/$keyname.key"
    chown "$SERVICE_USER:$SERVICE_USER" "$KEY_DIR/$keyname.key"
    chmod 600 "$KEY_DIR/$keyname.key"
  done
fi

echo "  OK: db.key, vault.key, audit.key generated and owned by $SERVICE_USER."

# ===== Recovery bundle (the one prompt) =====
echo "[5/8] Recovery bundle..."

if [[ -z "$RECOVERY_BUNDLE_PATH" ]]; then
  echo ""
  echo "  You will now be prompted for a recovery passphrase."
  echo "  This passphrase encrypts a bundle containing your master keys."
  echo "  If you lose both your server AND this passphrase, your data is unrecoverable."
  echo "  Recommended: use a password manager. 4+ random words from EFF wordlist is strong enough."
  echo ""
  read -rp "  Where should the recovery bundle be written? (e.g. /mnt/usb/host.demiurge-recovery): " RECOVERY_BUNDLE_PATH
fi

# Call the Node CLI to write the bundle (TS impl in src/cli/rebundle.ts handles
# scrypt + AES-GCM + bundle format).
sudo -u "$SERVICE_USER" node /usr/local/lib/demiurge/cli/rebundle.js \
  --bundle-path "$RECOVERY_BUNDLE_PATH" \
  --key-dir "$KEY_DIR" \
  --mode initial-install

echo "  OK: recovery bundle written to $RECOVERY_BUNDLE_PATH."

# ===== Engine binary install =====
echo "[6/8] Engine binary..."

# npm-install path (vs a prebuilt binary release). The package ships the engine
# plus the compiled CLI commands the shims above invoke.
npm install -g demiurge@latest 2>&1 | tail -3
echo "  OK: demiurge installed via npm -g."

# ===== Initialize DBs =====
echo "[7/8] Initialize encrypted databases..."

sudo -u "$SERVICE_USER" \
  DEMIURGE_KEY_DIR="$KEY_DIR" \
  DEMIURGE_DATA_DIR="$DATA_DIR" \
  VAULT_ENABLED=true \
  VAULT_DB_ENCRYPTION_ENABLED=true \
  demiurge --init

echo "  OK: encrypted DBs initialized at $DATA_DIR."

# ===== systemd unit =====
echo "[8/8] systemd unit..."

cat > /etc/systemd/system/demiurge.service <<EOF
[Unit]
Description=Demiurge memory engine
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
Environment=DEMIURGE_KEY_DIR=$KEY_DIR
Environment=DEMIURGE_DATA_DIR=$DATA_DIR
Environment=DEMIURGE_LOG_DIR=$LOG_DIR
Environment=VAULT_ENABLED=true
Environment=VAULT_DB_ENCRYPTION_ENABLED=true
Environment=VAULT_EXTRACTION_DETECTION_ENABLED=true
Environment=VAULT_INJECTION_DETECTION_ENABLED=true
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/demiurge
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG_DIR/engine.log
StandardError=append:$LOG_DIR/engine.err.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable demiurge.service
systemctl start demiurge.service

sleep 3
if systemctl is-active --quiet demiurge.service; then
  echo "  OK: demiurge.service active."
else
  echo "  ERROR: demiurge.service failed to start. Check journalctl -u demiurge." >&2
  exit 1
fi

echo ""
echo "==========================================="
echo "  Demiurge install complete."
echo "==========================================="
echo ""
echo "  Service user:          $SERVICE_USER"
echo "  Keys:                  $KEY_DIR (root-readable, $SERVICE_USER-owned, 0600)"
echo "  Data:                  $DATA_DIR"
echo "  Logs:                  $LOG_DIR"
echo "  Recovery bundle:       $RECOVERY_BUNDLE_PATH"
echo "  systemd unit:          demiurge.service (enabled, started)"
echo ""
echo "  WRITE DOWN THE RECOVERY PASSPHRASE NOW IF YOU HAVEN'T."
echo "  Lost passphrase + lost keys = lost data. By design."
echo ""
echo "  Next steps:"
echo "    - Verify the engine is healthy:  curl http://localhost:$ENGINE_PORT/health"
echo "    - Configure backups:             demiurge-restore --help"
echo "    - Generate handover document:    demiurge-handover --help"
echo ""
