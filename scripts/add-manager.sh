#!/usr/bin/env bash
#
# add-manager.sh
#
# Idempotently registers the better-auth `manager` user (role=admin) in an
# already-deployed chess-gateway / intermezzo system.
#
# This mirrors the seeding the development init script does, but only the
# pieces that are safe to apply to a live deployment:
#   1. Adds the better-auth `admin` plugin columns to `user` / `session`
#      if they don't already exist (no-op when they do).
#   2. Inserts a `manager` user with role=admin (or upgrades an existing
#      `manager` row to role=admin).
#
# It does NOT touch Vault, AppRole credentials, transit keys, or DID
# anchoring — those are assumed to already exist in a deployed system.
#
# Usage:
#   ./add-manager.sh [path/to/database.sqlite]
#
# Environment overrides:
#   GATEWAY_DB     Path to the gateway's SQLite database
#                  (default: ./database.sqlite, then ../database.sqlite)
#   MANAGER_ID     better-auth user id      (default: manager)
#   MANAGER_NAME   display name             (default: Manager)
#   MANAGER_EMAIL  email used for OTP login (default: manager@example.com)
#
# Remote deployments:
#   If the gateway is on another host, copy its `database.sqlite` locally,
#   run this script against the copy, then ship it back — or ssh in and
#   run the script there. SQLite has no network protocol.

set -euo pipefail

MANAGER_ID="${MANAGER_ID:-manager}"
MANAGER_NAME="${MANAGER_NAME:-Manager}"
MANAGER_EMAIL="${MANAGER_EMAIL:-manager@example.com}"

# Resolve DB path: CLI arg > $GATEWAY_DB > ./database.sqlite > ../database.sqlite
DB="${1:-${GATEWAY_DB:-}}"
if [[ -z "${DB}" ]]; then
  if [[ -f "./database.sqlite" ]]; then
    DB="./database.sqlite"
  elif [[ -f "../database.sqlite" ]]; then
    DB="../database.sqlite"
  else
    echo "ERROR: could not locate database.sqlite." >&2
    echo "       Pass it as the first argument or set GATEWAY_DB." >&2
    exit 1
  fi
fi

if [[ ! -f "${DB}" ]]; then
  echo "ERROR: database file not found: ${DB}" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 CLI not found in PATH." >&2
  echo "       Install it (e.g. apt-get install sqlite3) and retry." >&2
  exit 1
fi

echo "Using database: ${DB}"
echo "Backing up to:  ${DB}.bak.$(date +%Y%m%d%H%M%S)"
cp -- "${DB}" "${DB}.bak.$(date +%Y%m%d%H%M%S)"

# Confirm the better-auth tables exist before trying to seed them.
if ! sqlite3 "${DB}" "SELECT name FROM sqlite_master WHERE type='table' AND name='user';" | grep -q '^user$'; then
  echo "ERROR: 'user' table not found in ${DB}." >&2
  echo "       Has the gateway been started against this database at least once?" >&2
  exit 1
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

# Run everything in a single transaction. `safe_alter` swallows the
# "duplicate column" error so re-runs are idempotent.
sqlite3 "${DB}" <<SQL
.bail off

-- better-auth admin plugin columns (no-op if already present)
ALTER TABLE user    ADD COLUMN role        TEXT    DEFAULT 'user';
ALTER TABLE user    ADD COLUMN banned      INTEGER DEFAULT 0;
ALTER TABLE user    ADD COLUMN banReason   TEXT;
ALTER TABLE user    ADD COLUMN banExpires  INTEGER;
ALTER TABLE session ADD COLUMN impersonatedBy TEXT;

.bail on
BEGIN;

INSERT OR IGNORE INTO user (id, name, email, emailVerified, role, createdAt, updatedAt)
VALUES ('${MANAGER_ID}', '${MANAGER_NAME}', '${MANAGER_EMAIL}', 1, 'admin', '${NOW}', '${NOW}');

UPDATE user
   SET role          = 'admin',
       emailVerified = 1,
       email         = '${MANAGER_EMAIL}',
       name          = COALESCE(NULLIF(name, ''), '${MANAGER_NAME}'),
       updatedAt     = '${NOW}'
 WHERE id = '${MANAGER_ID}';

COMMIT;
SQL

# NOTE: the previous `intermezzo_identity` plugin table is gone. The
# manager's email -> vault userId binding is now established at NestJS
# startup by IntermezzoProvisionerService, which writes a row into the
# TypeORM-managed `link_verification` table the first time the API
# boots after this script runs (provided INTERMEZZO_MANAGER_TOKEN is
# set). No manual SQL is required here.

echo
echo "Manager row after seed:"
sqlite3 -header -column "${DB}" \
  "SELECT id, name, email, role, emailVerified FROM user WHERE id = '${MANAGER_ID}';"

echo
echo "Done. The UI can now sign in via email OTP as ${MANAGER_EMAIL}"
echo "and will be routed to the manager dashboard with impersonation rights."
