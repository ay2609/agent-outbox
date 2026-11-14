#!/bin/bash
# Cross-language check: an approval signed in the real dashboard (virtual authenticator) must verify in the
# Swift executor and produce dry sends. Dry transport only; the executor reads the USER pin (<state>/passkeys.json, simple mode),
# and OUTBOX_IGNORE_ROOT_PIN=1 keeps it from looking at a real root pin. No launchd and no sudo involved.
set -euo pipefail
cd "$(dirname "$0")/../.."
KEEP="${TMPDIR:-/tmp}/outbox-roundtrip-$$"
EXEC=exec/build/OutboxExec.app/Contents/MacOS/outbox-exec
E2E_PORT="${E2E_PORT:-7578}" E2E_KEEP_DIR="$KEEP" bun tests/e2e/approve.e2e.ts | tail -1
export OUTBOX_HOME="$KEEP" OUTBOX_IGNORE_ROOT_PIN=1
mkdir -p "$KEEP/logs"
DB="$KEEP/outbox.db"
sqlite3 "$DB" "UPDATE settings SET value='dry' WHERE key='transport';"
AP=$(sqlite3 "$DB" "SELECT id FROM approvals LIMIT 1")
echo "== verify $AP"; "$EXEC" verify "$AP"
for i in 1 2 3; do "$EXEC" run --once; sleep 2.2; done   # sends are 2 s apart by design
echo "== dry sends"; cat "$KEEP/logs/dry-sends.jsonl" 2>/dev/null || echo "(none)"
echo "== draft statuses"; sqlite3 "$DB" "SELECT status, count(*) FROM drafts GROUP BY status"
N=$(wc -l < "$KEEP/logs/dry-sends.jsonl" | tr -d ' ')
echo "N=$N"
rm -rf "$KEEP"
[ "$N" = "2" ] && echo "ROUNDTRIP PASSED" || { echo "ROUNDTRIP FAILED"; exit 1; }
