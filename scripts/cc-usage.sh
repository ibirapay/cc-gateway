#!/usr/bin/env bash
# Show CC Gateway shared-account usage, live from Anthropic's rate-limit headers.
# Sends a minimal (1-token) request through the local gateway and parses the
# anthropic-ratelimit-unified-* headers. Cost: ~1 output token per call.
set -uo pipefail

CFG=/root/cc-gateway/config.yaml
STATE=/root/cc-gateway/usage-notify-state.json
METER=/root/cc-gateway/usage-meter-state.json
GW=http://localhost:8443/v1/messages

# First client token from config.yaml (any authorized token works).
TOKEN=$(grep -m1 -E '^\s*token:' "$CFG" | awk '{print $2}')
if [ -z "${TOKEN:-}" ]; then
  echo "cc-usage: no client token found in $CFG" >&2
  exit 1
fi

HDRS=$(curl -s -m 30 -D - -o /dev/null "$GW" \
  -H "x-api-key: $TOKEN" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"."}]}') || {
    echo "cc-usage: request to gateway failed (is cc-gateway.service up?)" >&2
    exit 1
  }

HDRS="$HDRS" STATE="$STATE" METER="$METER" python3 - <<'PY'
import os, re, time, json

hdrs = os.environ["HDRS"]

def g(name):
    m = re.search(rf'^{re.escape(name)}:\s*(.+?)\s*$', hdrs, re.I | re.M)
    return m.group(1) if m else None

def pct(v):
    try:
        return f"{float(v)*100:.1f}%"
    except (TypeError, ValueError):
        return "n/a"

def when(v):
    try:
        return time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(int(v)))
    except (TypeError, ValueError):
        return "n/a"

def eta(v):
    try:
        secs = int(v) - time.time()
        if secs <= 0:
            return "due"
        h, m = divmod(int(secs // 60), 60)
        return f"in {h}h{m:02d}m"
    except (TypeError, ValueError):
        return ""

http = re.search(r'HTTP/\S+\s+(\d+)', hdrs)
overall = g('anthropic-ratelimit-unified-status')
r5 = g('anthropic-ratelimit-unified-5h-reset')
r7 = g('anthropic-ratelimit-unified-7d-reset')

print("CC Gateway — shared account usage")
print(f"  gateway response : HTTP {http.group(1) if http else '?'}")
print(f"  overall status   : {overall or 'n/a'}")
print(f"  5-hour usage     : {pct(g('anthropic-ratelimit-unified-5h-utilization'))}"
      f"   status={g('anthropic-ratelimit-unified-5h-status') or 'n/a'}"
      f"   resets {when(r5)} ({eta(r5)})")
print(f"  7-day  usage     : {pct(g('anthropic-ratelimit-unified-7d-utilization'))}"
      f"   status={g('anthropic-ratelimit-unified-7d-status') or 'n/a'}"
      f"   resets {when(r7)} ({eta(r7)})")

try:
    st = json.load(open(os.environ["STATE"]))
    print(f"  last Discord ping: {st.get('band')}% band  (seen {st.get('ts')})")
except Exception:
    print("  last Discord ping: (no alerts sent yet)")

def kfmt(n):
    n = int(n)
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000:     return f"{n/1_000:.1f}k"
    return str(n)

try:
    m = json.load(open(os.environ["METER"]))
    cl = m.get("clients", {})
    print(f"\nPer-user (since {str(m.get('since',''))[:16].replace('T',' ')} UTC):")
    rows = sorted(cl.items(),
                  key=lambda kv: -(kv[1].get("inputTokens",0)+kv[1].get("outputTokens",0)))
    if not rows:
        print("  (no requests recorded yet)")
    for name, c in rows:
        tot = c.get("inputTokens",0)+c.get("outputTokens",0)
        err = f", {c['errors']} err" if c.get("errors") else ""
        print(f"  {name:<12} {c.get('requests',0):>4} req{err}   "
              f"{kfmt(tot):>6} tok (in {kfmt(c.get('inputTokens',0))}/out {kfmt(c.get('outputTokens',0))})")
except Exception:
    print("\nPer-user: (meter state not available yet)")
PY
