#!/usr/bin/env bash
#
# W4.5 Vault installer.
#
# One-shot key generator. Run once at deploy time. Generates three 32-byte
# random keys, writes them to /etc/demiurge/keys/ with 0600 perms, and
# prints a backup version to stdout for the operator to capture into a
# password manager.
#
# After this runs, subsequent engine starts read the existing keys without
# any human interaction. This is the zero-friction workflow doctrine from
# WEDGE_4_5_VAULT_DESIGN.md section 3.
#
# Usage:
#   sudo bash scripts/install-vault.sh
#   sudo DEMIURGE_KEY_DIR=/etc/demiurge/keys bash scripts/install-vault.sh
#
# IMPORTANT: if BOTH the on-disk key files AND the printed backup are lost,
# the encrypted Demiurge data is unrecoverable. This is by design.

set -euo pipefail

KEY_DIR="${DEMIURGE_KEY_DIR:-/etc/demiurge/keys}"

if [ ! -d "$KEY_DIR" ]; then
  mkdir -p "$KEY_DIR"
fi
chmod 700 "$KEY_DIR"

for keyId in db vault audit; do
  path="$KEY_DIR/$keyId.key"
  if [ -f "$path" ]; then
    echo "Existing $path detected; refusing to overwrite. Move it aside first if you want to rotate." >&2
    exit 1
  fi
  openssl rand 32 > "$path"
  chmod 600 "$path"
done

echo "==========================================="
echo "Demiurge Vault keys generated at $KEY_DIR"
echo "==========================================="
echo ""
echo "BACK THESE UP TO A PASSWORD MANAGER NOW."
echo ""
for keyId in db vault audit; do
  hex="$(xxd -p -c 64 "$KEY_DIR/$keyId.key")"
  printf "%-10s %s\n" "$keyId.key:" "$hex"
done
echo ""
echo "==========================================="
echo "If you lose BOTH the on-disk key files AND"
echo "the backup above, your encrypted Demiurge"
echo "data is unrecoverable. This is by design."
echo "==========================================="
