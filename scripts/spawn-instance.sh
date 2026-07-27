#!/bin/bash
# Spawn a new CC Gateway instance with its own OAuth account.
#
# Each instance shares the compiled code but gets its own:
#   - config.yaml (port, OAuth, auth tokens)
#   - systemd unit (cc-gateway-<name>.service)
#   - state files (usage, conversation history)
#   - client launcher script
#
# Usage:
#   bash scripts/spawn-instance.sh <instance-name> <refresh-token> [port] [client-name]
#
# Examples:
#   bash scripts/spawn-instance.sh backup sk-ant-ort01-xxxx
#   bash scripts/spawn-instance.sh backup sk-ant-ort01-xxxx 8444 espeto
#   bash scripts/spawn-instance.sh personal sk-ant-ort01-xxxx 8445 luis
#
# The refresh token comes from ~/.claude/.credentials.json on a machine
# logged into the account you want to use:
#   cat ~/.claude/.credentials.json | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['refreshToken'])"
#
# To tear down an instance:
#   bash scripts/spawn-instance.sh --destroy <instance-name>

set -euo pipefail

GATEWAY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATEWAY_ADDR="173.212.213.180"
INSTANCES_DIR="${GATEWAY_ROOT}/instances"

# ── Destroy mode ──

if [[ "${1:-}" == "--destroy" ]]; then
  NAME="${2:?Usage: spawn-instance.sh --destroy <instance-name>}"
  UNIT="cc-gateway-${NAME}"
  INST_DIR="${INSTANCES_DIR}/${NAME}"

  echo "Destroying instance '${NAME}'..."

  if systemctl is-active --quiet "${UNIT}" 2>/dev/null; then
    systemctl stop "${UNIT}"
    echo "  Stopped ${UNIT}"
  fi
  if [[ -f "/etc/systemd/system/${UNIT}.service" ]]; then
    systemctl disable "${UNIT}" 2>/dev/null || true
    rm -f "/etc/systemd/system/${UNIT}.service"
    rm -rf "/etc/systemd/system/${UNIT}.service.d"
    systemctl daemon-reload
    echo "  Removed systemd unit"
  fi
  if [[ -d "${INST_DIR}" ]]; then
    echo "  Instance dir: ${INST_DIR}"
    read -p "  Delete instance data (config + conversation history)? [y/N] " confirm
    if [[ "${confirm}" =~ ^[Yy] ]]; then
      rm -rf "${INST_DIR}"
      echo "  Deleted ${INST_DIR}"
    else
      echo "  Kept ${INST_DIR}"
    fi
  fi
  echo "Done."
  exit 0
fi

# ── Create mode ──

NAME="${1:?Usage: spawn-instance.sh <instance-name> <refresh-token> [port] [client-name]}"
REFRESH_TOKEN="${2:?Missing refresh token. Get it from ~/.claude/.credentials.json on the source machine.}"
PORT="${3:-$(( 8443 + $(ls -1d "${INSTANCES_DIR}"/*/ 2>/dev/null | wc -l) + 1 ))}"
CLIENT_NAME="${4:-${NAME}}"
CLIENT_TOKEN="$(openssl rand -hex 32)"

INST_DIR="${INSTANCES_DIR}/${NAME}"
UNIT="cc-gateway-${NAME}"

# Sanity checks
if [[ -d "${INST_DIR}" ]]; then
  echo "Error: Instance '${NAME}' already exists at ${INST_DIR}"
  echo "  To recreate: bash scripts/spawn-instance.sh --destroy ${NAME}"
  exit 1
fi

if ss -tlnp | grep -q ":${PORT} "; then
  echo "Error: Port ${PORT} is already in use"
  exit 1
fi

if [[ ! -f "${GATEWAY_ROOT}/dist/index.js" ]]; then
  echo "Error: Gateway not built. Run: cd ${GATEWAY_ROOT} && npm run build"
  exit 1
fi

echo "Creating CC Gateway instance '${NAME}'..."
echo "  Port:    ${PORT}"
echo "  Client:  ${CLIENT_NAME}"
echo "  Dir:     ${INST_DIR}"
echo ""

# ── Instance directory + config ──

mkdir -p "${INST_DIR}"

cat > "${INST_DIR}/config.yaml" <<EOF
auth:
  tokens:
  - name: ${CLIENT_NAME}
    token: ${CLIENT_TOKEN}

history:
  enabled: true
  dir: ${INST_DIR}/conversation-history
  retention_days: 365

logging:
  audit: true
  level: info

oauth:
  refresh_token: ${REFRESH_TOKEN}

server:
  port: ${PORT}

upstream:
  url: https://api.anthropic.com
EOF

chmod 600 "${INST_DIR}/config.yaml"
echo "  Config written"

# ── Systemd unit ──

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=CC Gateway - ${NAME} (port ${PORT})
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${GATEWAY_ROOT}
ExecStart=/usr/bin/node dist/index.js ${INST_DIR}/config.yaml
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Copy the same egress proxy env from the main instance
if [[ -f /etc/systemd/system/cc-gateway.service.d/proxy.conf ]]; then
  mkdir -p "/etc/systemd/system/${UNIT}.service.d"
  cp /etc/systemd/system/cc-gateway.service.d/proxy.conf \
     "/etc/systemd/system/${UNIT}.service.d/proxy.conf"
  echo "  Egress proxy config copied"
fi

systemctl daemon-reload
systemctl enable "${UNIT}" --now
echo "  Service started: ${UNIT}"

# Wait for OAuth bootstrap
echo -n "  Waiting for OAuth..."
for i in $(seq 1 15); do
  HEALTH=$(curl -s --max-time 2 "http://127.0.0.1:${PORT}/_health" 2>/dev/null)
  if echo "${HEALTH}" | grep -q '"ok"'; then
    echo " ready"
    break
  fi
  if [[ $i -eq 15 ]]; then
    echo " timeout (check: journalctl -u ${UNIT} -n 30)"
  fi
  sleep 1
done

# ── Client launcher ──

LAUNCHER="${GATEWAY_ROOT}/clients/cc-${CLIENT_NAME}-${NAME}"
cat > "${LAUNCHER}" <<SCRIPT_HEAD
#!/bin/bash
# CC Gateway Client Launcher — instance: ${NAME}
#
# Usage:
#   ./$(basename "${LAUNCHER}")                    Start Claude Code through gateway
#   ./$(basename "${LAUNCHER}") --print "hello"    Single-shot mode
#   ./$(basename "${LAUNCHER}") install            Install as 'ccg-${NAME}' command
#   ./$(basename "${LAUNCHER}") native             Run native claude (bypass gateway)
#   ./$(basename "${LAUNCHER}") status             Check gateway health
GATEWAY_URL="http://${GATEWAY_ADDR}:${PORT}"
CLIENT_TOKEN="${CLIENT_TOKEN}"
INSTALL_CMD="ccg-${NAME}"
SCRIPT_HEAD

cat >> "${LAUNCHER}" <<'SCRIPT_BODY'

INSTALL_PATH="/usr/local/bin/${INSTALL_CMD}"
case "$SHELL" in
  */zsh)  RC_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
  */bash) RC_FILE="$HOME/.bashrc" ;;
  */fish) RC_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
  *)      RC_FILE="$HOME/.profile" ;;
esac

case "${1:-}" in
  install)
    cp "$0" "$INSTALL_PATH" 2>/dev/null || sudo cp "$0" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"
    echo "Installed as '${INSTALL_CMD}'."
    exit 0
    ;;
  uninstall)
    rm -f "$INSTALL_PATH" 2>/dev/null || sudo rm -f "$INSTALL_PATH"
    echo "Removed '${INSTALL_CMD}'."
    exit 0
    ;;
  native)
    shift; exec command claude "$@"
    ;;
  swap-oauth)
    # Extract refresh token from local Claude credentials or accept as argument
    if [[ -n "${2:-}" ]]; then
      NEW_TOKEN="$2"
    else
      CRED_FILE="$HOME/.claude/.credentials.json"
      if [[ ! -f "$CRED_FILE" ]]; then
        echo "No credentials file at $CRED_FILE"
        echo "Usage: $(basename "$0") swap-oauth [refresh-token]"
        echo ""
        echo "Either pass the token directly, or log into Claude Code first:"
        echo "  claude --login"
        exit 1
      fi
      NEW_TOKEN=$(python3 -c "import json; print(json.load(open('$CRED_FILE'))['claudeAiOauth']['refreshToken'])" 2>/dev/null)
      if [[ -z "$NEW_TOKEN" || "$NEW_TOKEN" == "$CLIENT_TOKEN" ]]; then
        echo "Could not extract a valid refresh token from $CRED_FILE"
        echo "Log into Claude Code first: claude --login"
        exit 1
      fi
      echo "Extracted refresh token from $CRED_FILE"
    fi
    echo "Sending to gateway..."
    RESP=$(curl -sk --max-time 30 \
      -X POST "${GATEWAY_URL}/_oauth" \
      -H "x-api-key: ${CLIENT_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"refresh_token\": \"${NEW_TOKEN}\"}" 2>/dev/null)
    if echo "$RESP" | grep -q '"ok"'; then
      echo "OAuth swapped successfully."
      echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
    else
      echo "OAuth swap failed:"
      echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
      exit 1
    fi
    exit 0
    ;;
  status)
    echo "Gateway:  $GATEWAY_URL"
    HEALTH=$(curl -sk --max-time 3 "${GATEWAY_URL}/_health" 2>/dev/null)
    if [[ -n "$HEALTH" ]]; then
      echo "Health:   OK"
      echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
    else
      echo "Health:   UNREACHABLE"
    fi
    exit 0
    ;;
  help|--help|-h)
    echo "$(basename "$0") — Claude Code via gateway (${INSTALL_CMD})"
    echo ""
    echo "  $(basename "$0")              Start Claude Code"
    echo "  $(basename "$0") install      Install as '${INSTALL_CMD}'"
    echo "  $(basename "$0") uninstall    Remove '${INSTALL_CMD}'"
    echo "  $(basename "$0") swap-oauth   Replace gateway OAuth token"
    echo "  $(basename "$0") native       Bypass gateway once"
    echo "  $(basename "$0") status       Check gateway"
    exit 0
    ;;
esac

# Ensure credentials are seeded
if ! grep -q "$CLIENT_TOKEN" "$HOME/.claude/.credentials.json" 2>/dev/null; then
  mkdir -p "$HOME/.claude"
  cat > "$HOME/.claude/.credentials.json" <<CREDS
{"claudeAiOauth":{"accessToken":"$CLIENT_TOKEN","refreshToken":"$CLIENT_TOKEN","expiresAt":9999999999999,"scopes":["user:inference"],"subscriptionType":"claude_pro"}}
CREDS
fi

if ! command -v claude &>/dev/null; then
  echo "Error: 'claude' not found. Install: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

export ANTHROPIC_API_KEY="$CLIENT_TOKEN"
export ANTHROPIC_BASE_URL="$GATEWAY_URL"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_ATTRIBUTION_HEADER=false

HEALTH=$(curl -sk --max-time 3 "${GATEWAY_URL}/_health" 2>/dev/null)
if [[ -z "$HEALTH" ]]; then
  echo "Warning: Gateway at ${GATEWAY_URL} is not reachable."
  echo ""
fi

exec claude "$@"
SCRIPT_BODY

chmod +x "${LAUNCHER}"
echo "  Client launcher: ${LAUNCHER}"

# ── Summary ──

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Instance '${NAME}' is live"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  Gateway:    http://${GATEWAY_ADDR}:${PORT}"
echo "  Service:    systemctl status ${UNIT}"
echo "  Logs:       journalctl -u ${UNIT} -f"
echo "  Config:     ${INST_DIR}/config.yaml"
echo "  History:    ${INST_DIR}/conversation-history/"
echo "  Launcher:   ${LAUNCHER}"
echo ""
echo "  Send the launcher to the client machine:"
echo "    scp ${LAUNCHER} user@machine:~/"
echo "    # then on client: chmod +x $(basename "${LAUNCHER}") && ./$(basename "${LAUNCHER}")"
echo ""
echo "  Add more clients to this instance:"
echo "    bash scripts/add-client.sh <name> '' ${GATEWAY_ADDR}:${PORT}"
echo "    (then add the token to ${INST_DIR}/config.yaml and restart)"
echo ""
echo "  Tear down:"
echo "    bash scripts/spawn-instance.sh --destroy ${NAME}"
echo ""
