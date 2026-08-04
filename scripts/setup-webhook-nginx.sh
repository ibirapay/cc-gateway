#!/usr/bin/env bash
set -euo pipefail

# setup-webhook-nginx.sh — nginx reverse proxy + Let's Encrypt for MP webhook
# Prereq: DNS A record ccg.pagcoin.com.br → 173.212.213.180 must exist
# Run on the gateway: bash /root/cc-gateway/scripts/setup-webhook-nginx.sh

DOMAIN="ccg.pagcoin.org"
UPSTREAM="http://127.0.0.1:8443"
NGINX_CONF="/etc/nginx/sites-available/$DOMAIN"
BILLING_TS="/root/cc-gateway/src/billing.ts"

echo "=== Webhook HTTPS setup: $DOMAIN ==="

# 1. Check DNS resolves to us
echo "--- Checking DNS..."
RESOLVED=$(dig +short "$DOMAIN" A 2>/dev/null || true)
MY_IP=$(curl -4 -s ifconfig.me)
if [[ "$RESOLVED" != "$MY_IP" ]]; then
  echo "ERROR: $DOMAIN resolves to '$RESOLVED', expected '$MY_IP'"
  echo "Create an A record: $DOMAIN → $MY_IP"
  exit 1
fi
echo "OK: $DOMAIN → $RESOLVED"

# 2. Install certbot if missing
if ! command -v certbot &>/dev/null; then
  echo "--- Installing certbot..."
  apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx
fi

# 3. Write nginx config
echo "--- Writing nginx config..."
cat > "$NGINX_CONF" << NGINX
server {
    listen 80;
    server_name $DOMAIN;

    # Only proxy the billing webhook path — everything else 404
    location /_billing/ {
        proxy_pass $UPSTREAM;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        return 404;
    }
}
NGINX

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
echo "OK: nginx configured"

# 4. Get Let's Encrypt cert
echo "--- Requesting certificate..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email luismolina@tec.dseclab.io --redirect
echo "OK: TLS certificate installed"

# 5. Update webhook URL in billing.ts
echo "--- Updating webhook URL in billing.ts..."
sed -i "s|http://173.212.213.180:8443/_billing/webhook|https://$DOMAIN/_billing/webhook|" "$BILLING_TS"

# 6. Rebuild + restart
echo "--- Building..."
cd /root/cc-gateway
npm run build
systemctl restart cc-gateway.service
sleep 2

if systemctl is-active --quiet cc-gateway.service; then
  echo
  echo "=== DONE ==="
  echo "Webhook URL: https://$DOMAIN/_billing/webhook"
  echo "Use this URL in the MP application panel."
  echo
  echo "Test: curl -s https://$DOMAIN/_billing/webhook"
else
  echo "ERROR: gateway failed to restart"
  journalctl -u cc-gateway.service -n 15 --no-pager
  exit 1
fi
