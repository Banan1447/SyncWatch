#!/bin/sh
set -e

SSL_DIR=/etc/nginx/ssl

# ── Self-signed fallback ──
# A manually-issued Let's Encrypt cert lives in the same volume (cert.pem/key.pem);
# this only generates a placeholder if none exists yet.
if [ ! -f "$SSL_DIR/cert.pem" ] || [ ! -f "$SSL_DIR/key.pem" ]; then
  mkdir -p "$SSL_DIR"
  if ! command -v openssl > /dev/null 2>&1; then
    apk add --no-cache openssl 2>/dev/null || true
  fi
  EXT_IP="${EXTERNAL_IP:-127.0.0.1}"
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$SSL_DIR/key.pem" \
    -out "$SSL_DIR/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=${EXT_IP}/O=WatchSync/C=RU" \
    -addext "subjectAltName=IP:${EXT_IP},IP:127.0.0.1,DNS:localhost" \
    2>/dev/null || \
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$SSL_DIR/key.pem" \
    -out "$SSL_DIR/cert.pem" \
    -days 3650 -nodes \
    -subj "/CN=${EXT_IP}/O=WatchSync/C=RU" \
    2>/dev/null
  echo "[nginx] Generated self-signed SSL certificate for ${EXT_IP}"
fi

exec nginx -g "daemon off;"
