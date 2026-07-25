#!/usr/bin/env bash
# cc-health.sh — check & auto-fix cc-gateway OAuth + egress proxy health.
#
# Run by cc-health.timer (~every 2 min). Logs to journald: journalctl -t cc-health
#
# Egress tiers (highest priority first), defined in cc-health.conf:
#   1) PRIMARY    = nodge       (residential, reverse SSH tunnel 127.0.0.1:8889) — self-heals
#   2) FALLBACK   = home gateway(residential, Tailscale 100.123.198.75:8888)     — repair: recreate container
#   3) LAST_RESORT= VPS-local   (datacenter, 127.0.0.1:8888)                      — always-local safety net
#
# Each run converges to the highest-priority HEALTHY tier. An unhealthy tier gets
# one repair attempt before falling through. Switching UP to a recovered higher
# tier is rate-limited by COOLDOWN; switching AWAY from a dead active tier is
# immediate (cooldown ignored). Dead refresh token (invalid_grant): notify only.
#
# Tier switches are applied by writing PROXY_FILE + sending SIGHUP to the
# running gateway process, which hot-reloads its proxy agent in place —
# no systemctl restart, so a tier flap doesn't drop in-flight client requests
# or force a full OAuth re-init. Falls back to a full restart only if the
# gateway isn't running or its PID can't be found.
set -uo pipefail

CONF="/root/cc-gateway/cc-health.conf"
[ -f "$CONF" ] && . "$CONF"

: "${PRIMARY_PROXY:=http://127.0.0.1:8889}"
: "${FALLBACK_PROXY:=http://100.123.198.75:8888}"
: "${LAST_RESORT_PROXY:=http://127.0.0.1:8888}"
: "${HOME_SSH:=pagcoin@100.123.198.75}"
: "${HOME_TS_IP:=100.123.198.75}"
: "${PROXY_PORT:=8888}"
: "${CONTAINER:=cc-home-proxy}"
: "${VPS_IP:=173.212.213.180}"
: "${DROPIN:=/etc/systemd/system/cc-gateway.service.d/proxy.conf}"
: "${PROXY_FILE:=/root/cc-gateway/active-proxy.txt}"
: "${HEALTH_URL:=http://127.0.0.1:8443/_health}"
: "${PROBE_URL:=https://api.anthropic.com/v1/me}"
: "${EGRESS_URL:=https://api.ipify.org}"
: "${EXPECTED_HOME_PREFIX:=201.159.30.}"
: "${STATE:=/run/cc-health.state}"
: "${LOCK:=/run/cc-health.lock}"
: "${COOLDOWN:=600}"
: "${NOTIFY_CMD:=}"

log(){ logger -t cc-health -- "$*"; }
notify(){ log "NOTIFY: $*"; [ -n "$NOTIFY_CMD" ] && printf '%s\n' "$*" | bash -c "$NOTIFY_CMD" >/dev/null 2>&1 || true; }

exec 9>"$LOCK" || exit 0
flock -n 9 || { log "another run in progress; skipping"; exit 0; }

active_proxy(){ cat "$PROXY_FILE" 2>/dev/null || grep -oP 'HTTPS_PROXY=\K\S+' "$DROPIN" 2>/dev/null | head -1; }

proxy_ok(){  # $1 = proxy url ; 0 if any HTTP response comes back through it
  local code
  code=$(curl -x "$1" -s -o /dev/null -m 15 -w '%{http_code}' "$PROBE_URL" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

gateway_oauth(){ curl -s -m 8 "$HEALTH_URL" 2>/dev/null | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("oauth",""))
except Exception: print("")' 2>/dev/null; }

home_reachable(){ ssh -n -o ConnectTimeout=8 -o BatchMode=yes "$HOME_SSH" true 2>/dev/null; }

recreate_home_proxy(){
  ssh -n -o ConnectTimeout=8 -o BatchMode=yes "$HOME_SSH" \
    "docker rm -f $CONTAINER >/dev/null 2>&1 || true; docker run -d --name $CONTAINER --restart unless-stopped -p $HOME_TS_IP:$PROXY_PORT:$PROXY_PORT $CONTAINER >/dev/null 2>&1; sleep 2; ss -ltn | grep -q '$HOME_TS_IP:$PROXY_PORT'"
}

set_proxy(){  # $1 = proxy url ; hot-reload gateway onto the new egress
  mkdir -p "$(dirname "$DROPIN")"
  cat > "$DROPIN" <<EOF
[Service]
Environment=HTTPS_PROXY=$1
Environment=HTTP_PROXY=$1
Environment=ALL_PROXY=$1
EOF
  systemctl daemon-reload
  echo "$1" > "$PROXY_FILE"

  local pid
  pid=$(systemctl show -p MainPID --value cc-gateway 2>/dev/null)
  if [ -n "$pid" ] && [ "$pid" != "0" ] && kill -HUP "$pid" 2>/dev/null; then
    log "hot-reloaded proxy agent on pid $pid (no restart)"
    sleep 1
  else
    log "no running gateway pid found; falling back to full restart"
    systemctl restart cc-gateway
    sleep 6
  fi
}

wait_oauth(){ local i; for i in 1 2 3 4 5; do [ "$(gateway_oauth)" = "valid" ] && return 0; sleep 5; done; return 1; }

recently(){  # $1 = action ; 0 if same action recorded within COOLDOWN
  [ -f "$STATE" ] || return 1
  local a t now; a=$(sed -n 's/^action=//p' "$STATE"); t=$(sed -n 's/^ts=//p' "$STATE"); now=$(date +%s)
  [ "$a" = "$1" ] && [ -n "$t" ] && [ $((now - t)) -lt "$COOLDOWN" ]
}
record(){ printf 'action=%s\nts=%s\n' "$1" "$(date +%s)" > "$STATE"; }

# ---------- Tier table (highest priority first) ----------
TIER_NAMES=(nodge home datacenter)
TIER_URLS=("$PRIMARY_PROXY" "$FALLBACK_PROXY" "$LAST_RESORT_PROXY")

repair_tier(){  # $1 = index ; attempt to bring that tier back. 0 if repair ran ok.
  case "$1" in
    1) home_reachable && recreate_home_proxy ;;   # home gateway: recreate container
    *) return 1 ;;                                 # nodge & datacenter: no remote repair
  esac
}

egress_sanity(){  # $1 = tier name ; $2 = proxy url — informational warnings only
  local eip; eip=$(curl -x "$2" -s -m 8 "$EGRESS_URL" 2>/dev/null)
  [ -z "$eip" ] && return 0
  case "$1" in
    nodge) [ "$eip" = "$VPS_IP" ] && log "WARN: nodge tier egress shows datacenter IP $eip — tunnel/proxy misrouted" || true ;;
    home)
      local prefix ok=0
      for prefix in $EXPECTED_HOME_PREFIX; do
        case "$eip" in "${prefix}"*) ok=1; break ;; esac
      done
      [ "$ok" = 1 ] || log "WARN: home egress IP $eip not in any expected prefix ($EXPECTED_HOME_PREFIX)"
      ;;
  esac
}

# ---------- Choose the highest-priority healthy tier ----------
CHOSEN=-1
for i in "${!TIER_URLS[@]}"; do
  url="${TIER_URLS[$i]}"; [ -z "$url" ] && continue
  if proxy_ok "$url"; then CHOSEN=$i; break; fi
  log "tier ${TIER_NAMES[$i]} ($url) unreachable; attempting repair"
  if repair_tier "$i" && proxy_ok "$url"; then CHOSEN=$i; log "tier ${TIER_NAMES[$i]} repaired"; break; fi
done

if [ "$CHOSEN" -lt 0 ]; then
  notify "ALL egress tiers down (nodge/home/datacenter) — cc-gateway has no working egress."
  exit 1
fi

CHOSEN_URL="${TIER_URLS[$CHOSEN]}"; CHOSEN_NAME="${TIER_NAMES[$CHOSEN]}"
ACTIVE="$(active_proxy)"; [ -z "$ACTIVE" ] && ACTIVE="${TIER_URLS[0]}"

# ---------- Switch if needed ----------
if [ "$CHOSEN_URL" != "$ACTIVE" ]; then
  ACTIVE_OK=0; proxy_ok "$ACTIVE" && ACTIVE_OK=1
  if [ "$ACTIVE_OK" = 1 ] && recently switch; then
    log "higher tier $CHOSEN_NAME ($CHOSEN_URL) available, but active ($ACTIVE) still ok and within cooldown — staying"
  else
    log "switching egress -> $CHOSEN_NAME ($CHOSEN_URL) (was $ACTIVE, active_ok=$ACTIVE_OK)"
    set_proxy "$CHOSEN_URL"; record switch
    if wait_oauth; then
      notify "cc-gateway egress switched to $CHOSEN_NAME ($CHOSEN_URL)."
    else
      notify "cc-gateway switched to $CHOSEN_NAME but oauth not valid yet — check journalctl -u cc-gateway."
    fi
    ACTIVE="$CHOSEN_URL"
  fi
fi

# ---------- Verify OAuth on the active egress ----------
OAUTH="$(gateway_oauth)"
if [ "$OAUTH" = "valid" ]; then
  log "OK: egress=$CHOSEN_NAME ($ACTIVE), oauth valid"
  egress_sanity "$CHOSEN_NAME" "$ACTIVE"
  exit 0
fi
if ! systemctl is-active --quiet cc-gateway; then
  log "gateway inactive but egress ok; starting"; systemctl start cc-gateway; exit 0
fi
if journalctl -u cc-gateway -n 40 --no-pager 2>/dev/null | grep -q invalid_grant; then
  notify "cc-gateway refresh token is dead (invalid_grant). Run scripts/update-oauth.sh on the VPS to re-login."
  exit 1
fi
log "oauth=$OAUTH but no invalid_grant; gateway should self-heal — leaving alone"
exit 0
