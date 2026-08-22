#!/bin/sh
set -e

SSL_DIR=/etc/nginx/ssl
LEGO_DIR="${SSL_DIR}/lego"
DOMAIN="${LE_DOMAIN:-}"

[ -n "$DOMAIN" ] || { echo "[lego] LE_DOMAIN not set"; exit 0; }

export REGRU_USERNAME="${REGRU_USERNAME:-}" REGRU_PASSWORD="${REGRU_PASSWORD:-}"
EMAIL="${LE_EMAIL:-admin@example.com}"

# lego v5: `run` issues the cert on first invocation and renews automatically
# once fewer than --renew-days of validity remain. Safe to call daily.
# --dns.resolvers 1.1.1.1 bypasses the ISP recursive DNS, which negative-caches
# NXDOMAIN for the _acme-challenge TXT (SOA TTL up to 3h) and breaks propagation.
lego run --dns regru --email "$EMAIL" --domains "$DOMAIN" \
     --path "$LEGO_DIR" --accept-tos --renew-days 30 \
     --dns.resolvers 1.1.1.1:53

CERT="$LEGO_DIR/certificates/${DOMAIN}.crt"
KEY="$LEGO_DIR/certificates/${DOMAIN}.key"
ISSUER="$LEGO_DIR/certificates/${DOMAIN}.issuer.crt"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  # Build fullchain (leaf + issuer) and install over the self-signed fallback.
  cat "$CERT" > "$SSL_DIR/cert.pem"
  [ -f "$ISSUER" ] && cat "$ISSUER" >> "$SSL_DIR/cert.pem"
  cp "$KEY" "$SSL_DIR/key.pem"
  echo "[lego] Installed Let's Encrypt cert for ${DOMAIN}, reloading nginx"
  nginx -s reload 2>/dev/null || true
fi
