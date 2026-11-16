#!/bin/bash
# Agent Outbox installer. Builds the dashboard and the executor, writes two per-user LaunchAgents and starts them.
# Safe to re-run (a re-run is an upgrade). Never uses sudo.
#
#   ./install.sh [--port N] [--no-mcp] [--dry-run] [--setup-link] [--help]
set -euo pipefail

LABEL="io.github.ay2609.agent-outbox"
EXEC_LABEL="$LABEL.exec"
EXEC_BUNDLE_ID="$EXEC_LABEL"
MCP_NAME="agent-outbox"
DEFAULT_PORT=7477
MIN_BUN="1.4.0"     # bun.lock is lockfileVersion 2
MIN_SWIFT="6.0"     # exec/Package.swift: swift-tools-version 6.0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${OUTBOX_HOME:-$HOME/Library/Application Support/agent-outbox}"
CONFIG="$STATE/config.json"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_N="$(id -u)"

DRY_RUN=0
NO_MCP=0
SETUP_LINK=0
PORT_ARG=""

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Builds Agent Outbox, installs two LaunchAgents in ~/Library/LaunchAgents and starts them.
Run it again later to upgrade. It never uses sudo.

Options:
  --port N     Dashboard port (default 7477). Saved to config.json in the state directory.
  --no-mcp     Do not register the MCP server with Claude Code.
  --dry-run    Print every step and change nothing (the checks still run).
  --setup-link Print the one-time first-run setup link (the dashboard address with a secret token) and exit.
               Changes nothing. If setup is already done it says so.
  --help       Show this help.

State directory: ~/Library/Application Support/agent-outbox (override with OUTBOX_HOME).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { echo "--port needs a number" >&2; exit 2; }
      PORT_ARG="$2"; shift 2 ;;
    --port=*) PORT_ARG="${1#--port=}"; shift ;;
    --no-mcp) NO_MCP=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --setup-link) SETUP_LINK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$PORT_ARG" ]; then
  case "$PORT_ARG" in
    ''|*[!0-9]*) echo "--port must be a number between 1024 and 65535" >&2; exit 2 ;;
  esac
  if [ "$PORT_ARG" -lt 1024 ] || [ "$PORT_ARG" -gt 65535 ]; then
    echo "--port must be between 1024 and 65535" >&2; exit 2
  fi
fi

# ---------- helpers ----------
step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# version_at_least <have> <need>: dotted numeric versions; a suffix like "-canary.1" is ignored. Fails on an empty <have>.
version_at_least() {
  local have="${1%%[-+]*}" need="$2" i h n
  [[ "$have" =~ ^[0-9]+(\.[0-9]+)*$ ]] || return 1
  local IFS=.
  local -a H=($have) N=($need)
  for i in 0 1 2; do
    h="${H[$i]:-0}"; n="${N[$i]:-0}"
    if [ "$((10#$h))" -gt "$((10#$n))" ]; then return 0; fi
    if [ "$((10#$h))" -lt "$((10#$n))" ]; then return 1; fi
  done
  return 0
}

# Run a command, or only print it under --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    [dry-run] '; printf '%q ' "$@"; printf '\n'
  else
    "$@"
  fi
}

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  printf '%s' "$s"
}

# replace_all <string> <pattern> <replacement>: literal, and safe when the replacement contains & or \.
replace_all() {
  local s="$1" out=""
  while [[ "$s" == *"$2"* ]]; do
    out+="${s%%"$2"*}$3"
    s="${s#*"$2"}"
  done
  printf '%s' "$out$s"
}

# render_plist <template> <output>
render_plist() {
  local c
  c="$(cat "$1")"
  c="$(replace_all "$c" __HOME__ "$(xml_escape "$HOME")")"
  c="$(replace_all "$c" __REPO__ "$(xml_escape "$REPO")")"
  c="$(replace_all "$c" __BUN__ "$(xml_escape "$BUN")")"
  c="$(replace_all "$c" __STATE__ "$(xml_escape "$STATE")")"
  c="$(replace_all "$c" __PATH__ "$(xml_escape "$SERVICE_PATH")")"
  printf '%s\n' "$c" > "$2"
  if grep -q '__[A-Z]*__' "$2"; then die "unresolved placeholder in $2"; fi
  plutil -lint "$2" >/dev/null || die "rendered plist is not valid: $2"
}

# The port: --port wins, then config.json, then the default.
read_config_port() {
  [ -f "$CONFIG" ] || return 0
  bun -e '
    try {
      const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port;
      if (Number.isInteger(p)) console.log(p);
    } catch {}' "$CONFIG"
}

write_config_port() {
  bun -e '
    const fs = require("fs");
    const [file, port] = process.argv.slice(1);
    let cfg = {};
    if (fs.existsSync(file)) {
      try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { fs.copyFileSync(file, file + ".bak"); }
    }
    cfg.port = Number(port);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' "$CONFIG" "$1"
}

# The one-time setup link: the dashboard writes <state>/setup-token until the first sign-in key exists (then deletes it).
# Prints the URL and succeeds only if that file is a plain file holding a well-formed token (43 base64url characters).
setup_url() {
  local f="$STATE/setup-token" t
  [ -f "$f" ] && [ ! -L "$f" ] || return 1
  t="$(tr -d '[:space:]' < "$f" 2>/dev/null)" || return 1
  [[ "$t" =~ ^[A-Za-z0-9_-]{43}$ ]] || return 1
  printf 'http://localhost:%s/#/setup?token=%s\n' "$PORT" "$t"
}

bootstrap_agent() { # <label>: bootout (errors ignored), then bootstrap, retrying while launchd tears down
  local label="$1" plist="$AGENTS_DIR/$1.plist" i
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] launchctl bootout gui/$UID_N/$label   (errors ignored)"
    info "[dry-run] launchctl bootstrap gui/$UID_N $plist"
    return 0
  fi
  launchctl bootout "gui/$UID_N/$label" >/dev/null 2>&1 || true
  for i in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID_N" "$plist" 2>/dev/null; then
      info "started $label"
      return 0
    fi
    sleep 1
  done
  launchctl bootstrap "gui/$UID_N" "$plist"   # last try, shows the real error
}

# ---------- --setup-link: print the link and stop (reads only; needs no bun, Xcode or network) ----------
if [ "$SETUP_LINK" = 1 ]; then
  if [ -n "$PORT_ARG" ]; then
    PORT="$PORT_ARG"
  elif [ -n "${OUTBOX_PORT:-}" ] && [[ "$OUTBOX_PORT" =~ ^[0-9]+$ ]] && [ "$OUTBOX_PORT" -ge 1 ] && [ "$OUTBOX_PORT" -le 65535 ]; then
    PORT="$OUTBOX_PORT"
  else
    PORT=""
    if [ -f "$CONFIG" ]; then
      if command -v bun >/dev/null 2>&1; then PORT="$(read_config_port)"; else PORT="$(plutil -extract port raw -o - "$CONFIG" 2>/dev/null || true)"; fi
    fi
    [[ "$PORT" =~ ^[0-9]+$ ]] || PORT="$DEFAULT_PORT"
  fi
  if ! setup_url; then echo "Setup is already done: open http://localhost:$PORT"; fi
  exit 0
fi

# ---------- 1. checks ----------
step "Checking this Mac"
[ "$(uname -s)" = "Darwin" ] || die "Agent Outbox needs macOS (it sends through Messages.app)."
ARCH="$(uname -m)"
case "$ARCH" in arm64|x86_64) ;; *) die "unsupported CPU architecture: $ARCH" ;; esac
MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS_VERSION%%.*}"
[ "$MACOS_MAJOR" -ge 14 ] 2>/dev/null || die "macOS 14 or newer is required (this Mac has $MACOS_VERSION)."
info "macOS $MACOS_VERSION ($ARCH)"

BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  cat >&2 <<'EOF'
ERROR: Bun is not installed. Install it, open a new terminal, and run this again:
    brew install oven-sh/bun/bun
  or
    curl -fsSL https://bun.sh/install | bash
EOF
  exit 1
fi
BUN_VERSION="$("$BUN" --version 2>/dev/null || true)"
# bun.lock uses lockfileVersion 2, which Bun reads and writes from 1.4 on. Older Bun fails with a cryptic
# "Unknown lockfile version" at the install step, so check first.
if ! version_at_least "$BUN_VERSION" "$MIN_BUN"; then
  cat >&2 <<EOF
ERROR: Bun $MIN_BUN or newer is required (found ${BUN_VERSION:-an unknown version} at $BUN).
  Upgrade it, then run this again:
    bun upgrade                        (if you installed Bun with the curl script)
    brew upgrade oven-sh/bun/bun       (if you installed it with Homebrew)
EOF
  exit 1
fi
info "bun $BUN_VERSION at $BUN"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "ERROR: the Xcode Command Line Tools are not installed (needed to build the executor). Run: xcode-select --install" >&2
  exit 1
fi
if ! swift --version >/dev/null 2>&1; then
  echo "ERROR: 'swift --version' fails. Reinstall the Command Line Tools: xcode-select --install" >&2
  exit 1
fi
SWIFT_VERSION="$(swift --version 2>&1 | sed -n 's/.*Swift version \([0-9][0-9.]*\).*/\1/p' | head -n 1)"
if ! version_at_least "$SWIFT_VERSION" "$MIN_SWIFT"; then
  echo "ERROR: Swift $MIN_SWIFT or newer is required to build the executor (found ${SWIFT_VERSION:-an unknown version})." >&2
  echo "  Update Xcode or the Command Line Tools (Software Update, or: xcode-select --install)." >&2
  exit 1
fi
info "Swift $SWIFT_VERSION"
info "Xcode Command Line Tools: $(xcode-select -p)"

if [ -n "$PORT_ARG" ]; then
  PORT="$PORT_ARG"
else
  PORT="$(read_config_port)"
  PORT="${PORT:-$DEFAULT_PORT}"
fi
BUN_DIR="$(dirname "$BUN")"
SERVICE_PATH="$BUN_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
UPGRADE=0
[ -f "$AGENTS_DIR/$EXEC_LABEL.plist" ] && UPGRADE=1

step "Plan"
info "repo:       $REPO"
info "state dir:  $STATE"
info "port:       $PORT (dashboard on 127.0.0.1 only)"
info "LaunchAgents: $AGENTS_DIR/$LABEL.plist, $AGENTS_DIR/$EXEC_LABEL.plist"
if [ "$UPGRADE" = 1 ]; then info "mode:       upgrade (already installed)"; else info "mode:       fresh install"; fi
[ "$DRY_RUN" = 1 ] && info "DRY RUN: nothing will be changed."

# ---------- 2. build ----------
cd "$REPO"
step "Installing dependencies"
run "$BUN" install --frozen-lockfile
step "Building the dashboard"
run "$BUN" run web:build
step "Building the executor (Swift, ad-hoc signed)"
run "$REPO/exec/build.sh"

# ---------- 3. state dir and config ----------
step "Creating the state directory"
run mkdir -p "$STATE" "$STATE/logs"
run chmod 700 "$STATE"
if [ -n "$PORT_ARG" ] || [ ! -f "$CONFIG" ]; then
  info "writing $CONFIG (port $PORT)"
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] write_config_port $PORT"
  else
    write_config_port "$PORT"
  fi
else
  info "keeping existing $CONFIG"
fi

# ---------- 4. LaunchAgents ----------
step "Writing the LaunchAgents"
if [ "$DRY_RUN" = 1 ]; then
  RENDER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-outbox-plists.XXXXXX")"
  [ -n "${KEEP_DRY_RUN_FILES:-}" ] || trap 'rm -rf "$RENDER_DIR"' EXIT
  info "dry run: rendering to $RENDER_DIR instead of $AGENTS_DIR"
else
  RENDER_DIR="$AGENTS_DIR"
  mkdir -p "$AGENTS_DIR"
fi
for l in "$LABEL" "$EXEC_LABEL"; do
  render_plist "$REPO/deploy/$l.plist" "$RENDER_DIR/$l.plist"
  info "wrote $RENDER_DIR/$l.plist (plutil: ok)"
done

step "Starting the services"
bootstrap_agent "$LABEL"
bootstrap_agent "$EXEC_LABEL"

step "Waiting for the dashboard on http://127.0.0.1:$PORT"
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] poll http://127.0.0.1:$PORT/api/auth/state for up to 30 s"
  info "[dry-run] then show the one-time setup link: http://localhost:$PORT/#/setup?token=<token from $STATE/setup-token>"
else
  UP=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/auth/state" >/dev/null 2>&1; then UP=1; break; fi
    sleep 1
  done
  if [ "$UP" = 1 ]; then
    info "up"
  else
    echo "ERROR: the dashboard did not answer within 30 s. Look at the log:" >&2
    echo "    tail -n 30 '$STATE/logs/outboxd.err.log'" >&2
    exit 1
  fi
fi

# ---------- 5. MCP ----------
step "Registering the MCP server with Claude Code"
if [ "$NO_MCP" = 1 ]; then
  info "skipped (--no-mcp)"
elif ! command -v claude >/dev/null 2>&1; then
  info "'claude' is not on PATH. To register later (or for another MCP client, run this command as the server):"
  if [ -n "${OUTBOX_HOME:-}" ]; then
    info "  claude mcp add --scope user $MCP_NAME -e 'OUTBOX_HOME=$STATE' -- '$BUN' run '$REPO/src/mcp/index.ts'"
  else
    info "  claude mcp add --scope user $MCP_NAME -- '$BUN' run '$REPO/src/mcp/index.ts'"
  fi
elif claude mcp get "$MCP_NAME" >/dev/null 2>&1; then
  info "$MCP_NAME is already registered"
elif [ -n "${OUTBOX_HOME:-}" ]; then
  # A custom state directory: the MCP server must find the same agent socket.
  run claude mcp add --scope user "$MCP_NAME" -e "OUTBOX_HOME=$STATE" -- "$BUN" run "$REPO/src/mcp/index.ts"
else
  run claude mcp add --scope user "$MCP_NAME" -- "$BUN" run "$REPO/src/mcp/index.ts"
fi

# ---------- 6. next steps ----------
step "Done"
if [ "$UPGRADE" = 1 ]; then
  cat <<EOF
Upgrade note: rebuilding the executor changes its code hash, so macOS treats it as a new app and will ask again
for permission to control Messages and to access Contacts the next time it needs them. If a send then fails with
error -1743, clear the old entries and let the prompts reappear:
    tccutil reset AppleEvents $EXEC_BUNDLE_ID
    tccutil reset AddressBook $EXEC_BUNDLE_ID
    launchctl kickstart -k gui/$UID_N/$EXEC_LABEL

EOF
fi
SETUP_URL=""
[ "$DRY_RUN" = 1 ] || SETUP_URL="$(setup_url || true)"
if [ -n "$SETUP_URL" ]; then
  STEP1="Open this setup link (use it in your own browser; it holds a one-time secret that lets you create the first
     passkey, and it stops working once you have). To show it again: $REPO/install.sh --setup-link
       $SETUP_URL"
else
  STEP1="Open http://localhost:$PORT (use \"localhost\", not 127.0.0.1: passkeys are tied to that name)."
fi
cat <<EOF
Next steps
  1. $STEP1
  2. Create your two passkeys with Touch ID: one to sign in, one to approve sending. Macs without Touch ID
     use the Mac password or a phone passkey.
  3. You are in DRY mode in SIMPLE mode: approved messages are only written to a log
     ($STATE/logs/dry-sends.jsonl), nothing is sent and Contacts is not touched.
     Try it: ask Claude to draft a text, approve it in the dashboard and check that log.
  4. To go live: Settings > "Allow live sending", then switch the transport to live (Touch ID).
     On the first live send macOS asks you to let "Agent Outbox" control Messages, and on the first
     contacts sync or contact change it asks for Contacts access. Click Allow, only for "Agent Outbox".
  5. To harden (recommended before you rely on it): Settings > "Harden your install" shows one sudo command.
     Run it in Terminal yourself. It copies your approval key to a root-owned file so nothing running as your
     user can swap it. See the README.

Logs:       $STATE/logs/
Stop:       launchctl bootout gui/$UID_N/$EXEC_LABEL ; launchctl bootout gui/$UID_N/$LABEL
Uninstall:  $REPO/uninstall.sh
EOF
