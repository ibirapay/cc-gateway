#!/usr/bin/env bash
set -euo pipefail

# setup-billing.sh — configure Mercado Pago billing on cc-gateway
# Run on the gateway: bash /root/cc-gateway/scripts/setup-billing.sh

CONFIG="/root/cc-gateway/config.yaml"
SERVICE="cc-gateway.service"

echo "=== CC Gateway — Mercado Pago billing setup ==="
echo

# 1. Collect credentials
read -rp "MP Access Token (APP_USR-...): " MP_TOKEN
if [[ ! "$MP_TOKEN" =~ ^APP_USR- ]]; then
  echo "ERROR: token must start with APP_USR-"
  exit 1
fi

read -rp "MP Webhook Secret (optional, Enter to skip): " MP_SECRET

read -rp "Monthly amount in BRL [250]: " AMOUNT
AMOUNT="${AMOUNT:-250}"

read -rp "Grace days before blocking [3]: " GRACE
GRACE="${GRACE:-3}"

read -rp "Exempt clients (comma-separated, e.g. criptobro) [criptobro]: " EXEMPT
EXEMPT="${EXEMPT:-criptobro}"

echo
echo "--- Validating token against MP API..."

HTTP_CODE=$(curl -s -o /tmp/mp-me.json -w '%{http_code}' \
  -H "Authorization: Bearer $MP_TOKEN" \
  https://api.mercadopago.com/users/me)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: MP returned $HTTP_CODE — token is invalid or expired"
  cat /tmp/mp-me.json 2>/dev/null
  rm -f /tmp/mp-me.json
  exit 1
fi

MP_USER=$(python3 -c "import json; d=json.load(open('/tmp/mp-me.json')); print(f\"{d.get('id')} / {d.get('nickname', '?')} / {d.get('email', '?')}\")")
rm -f /tmp/mp-me.json
echo "OK: authenticated as $MP_USER"

# 2. Backup config
BACKUP="${CONFIG}.bak.$(date +%Y%m%d_%H%M%S)"
cp "$CONFIG" "$BACKUP"
echo "Backup: $BACKUP"

# 3. Patch config.yaml
python3 - "$CONFIG" "$MP_TOKEN" "$MP_SECRET" "$AMOUNT" "$GRACE" "$EXEMPT" << 'PYEOF'
import sys, yaml

config_path, token, secret, amount, grace, exempt_raw = sys.argv[1:7]

with open(config_path, 'r') as f:
    config = yaml.safe_load(f)

exempt_list = [e.strip() for e in exempt_raw.split(',') if e.strip()]

config['billing'] = {
    'enabled': True,
    'mp_access_token': token,
    'amount_brl': int(amount),
    'grace_days': int(grace),
    'exempt': exempt_list,
}
if secret:
    config['billing']['mp_webhook_secret'] = secret

with open(config_path, 'w') as f:
    yaml.dump(config, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

print(f"config.yaml updated: billing enabled, R${amount}/mo, {grace}d grace, exempt={exempt_list}")
PYEOF

# 4. Validate config loads
echo "--- Validating config..."
cd /root/cc-gateway
node -e "
  const { loadConfig } = await import('./dist/config.js');
  const c = loadConfig('$CONFIG');
  if (!c.billing?.enabled) throw new Error('billing not enabled after patch');
  console.log('Config valid: billing.enabled=true, amount=' + c.billing.amount_brl);
" 2>&1 || {
  echo "ERROR: config validation failed — restoring backup"
  cp "$BACKUP" "$CONFIG"
  exit 1
}

# 5. Build (billing.ts needs to be compiled)
echo "--- Building..."
npm run build --prefix /root/cc-gateway

# 6. Restart
echo "--- Restarting $SERVICE..."
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  echo
  echo "=== DONE ==="
  echo "Gateway restarted with billing enabled."
  echo "Test: kill -USR2 \$(pidof node)  # generate invoices manually"
  echo "Logs: journalctl -u $SERVICE -f --no-pager"
else
  echo "ERROR: service failed to start — check journalctl"
  journalctl -u "$SERVICE" -n 15 --no-pager
  echo
  echo "Restoring backup..."
  cp "$BACKUP" "$CONFIG"
  systemctl restart "$SERVICE"
  exit 1
fi
