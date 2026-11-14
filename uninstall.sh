#!/bin/bash
# Agent Outbox uninstaller. Stops and removes the LaunchAgents and the MCP registration, resets the executor's
# macOS permissions, and keeps your data unless you pass --purge. Never uses sudo.
#
#   ./uninstall.sh [--purge [--yes]] [--dry-run] [--help]
set -euo pipefail

LABEL="io.github.ay2609.agent-outbox"
EXEC_LABEL="$LABEL.exec"
EXEC_BUNDLE_ID="$EXEC_LABEL"
MCP_NAME="agent-outbox"
ROOT_PIN_DIR="/usr/local/etc/agent-outbox"

STATE="${OUTBOX_HOME:-$HOME/Library/Application Support/agent-outbox}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_N="$(id -u)"

DRY_RUN=0
PURGE=0
YES=0

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [options]

Stops both LaunchAgents, removes their plists, removes the Claude Code MCP registration, and resets the
executor's Messages and Contacts permissions. The state directory (drafts, passkeys, logs) is kept.

Options:
  --purge    Also delete the state directory (asks first).
  --yes      With --purge, skip the confirmation question.
  --dry-run  Print what would happen and change nothing.
  --help     Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

# Run a command (output hidden, failure ignored), or only print it under --dry-run.
try() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    [dry-run] '; printf '%q ' "$@"; printf '\n'
  else
    "$@" >/dev/null 2>&1 || true
  fi
}

step "Stopping the services"
for l in "$EXEC_LABEL" "$LABEL"; do
  try launchctl bootout "gui/$UID_N/$l"
done

step "Removing the LaunchAgent plists"
for l in "$LABEL" "$EXEC_LABEL"; do
  if [ -e "$AGENTS_DIR/$l.plist" ]; then
    if [ "$DRY_RUN" = 1 ]; then info "[dry-run] rm $AGENTS_DIR/$l.plist"; else rm -f "$AGENTS_DIR/$l.plist"; info "removed $AGENTS_DIR/$l.plist"; fi
  else
    info "no $AGENTS_DIR/$l.plist"
  fi
done

step "Removing the MCP registration"
if command -v claude >/dev/null 2>&1; then
  if claude mcp get "$MCP_NAME" >/dev/null 2>&1; then
    try claude mcp remove --scope user "$MCP_NAME"
    [ "$DRY_RUN" = 1 ] || info "removed $MCP_NAME"
  else
    info "$MCP_NAME is not registered"
  fi
else
  info "'claude' is not on PATH; nothing to remove"
fi

step "Resetting the executor's macOS permissions (best effort)"
try tccutil reset AppleEvents "$EXEC_BUNDLE_ID"
try tccutil reset AddressBook "$EXEC_BUNDLE_ID"

step "State directory"
if [ "$PURGE" = 1 ]; then
  case "$STATE" in
    ""|/|"$HOME"|"$HOME/"|"$HOME/Library"|"$HOME/Library/Application Support") echo "refusing to delete '$STATE' (check OUTBOX_HOME)" >&2; exit 1 ;;
  esac
  if [ ! -d "$STATE" ]; then
    info "no $STATE"
  elif [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would ask, then delete $STATE (drafts, passkeys, imports, logs)"
  else
    DELETE=0
    if [ "$YES" = 1 ]; then
      DELETE=1
    else
      printf '    Delete %s (drafts, passkeys, imports, logs)? This cannot be undone. [y/N] ' "$STATE"
      read -r answer || answer=""
      case "$answer" in y|Y|yes|YES) DELETE=1 ;; esac
    fi
    if [ "$DELETE" = 1 ]; then rm -rf "$STATE"; info "deleted $STATE"; else info "kept $STATE"; fi
  fi
else
  info "kept $STATE (add --purge to delete it)"
fi

if [ -e "$ROOT_PIN_DIR" ]; then
  step "Hardened-mode pin file"
  info "$ROOT_PIN_DIR exists (it needs root, so this script leaves it). To remove it, run:"
  info "  sudo rm -rf $ROOT_PIN_DIR"
fi

echo
if [ "$DRY_RUN" = 1 ]; then echo "Dry run: nothing was changed."; else echo "Uninstalled. The source folder is untouched; delete it yourself if you no longer want it."; fi
