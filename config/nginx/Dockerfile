FROM nginx:alpine

# openssl (self-signed fallback) + curl (download) + ca-certificates + crond (busybox)
RUN apk add --no-cache openssl curl ca-certificates && \
    mkdir -p /usr/local/bin && \
    ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64)  LARCH="linux_amd64" ;; \
      aarch64) LARCH="linux_arm64" ;; \
      *)       LARCH="linux_amd64" ;; \
    esac && \
    LEGO_VER="v5.3.1" && \
    curl -fsSL "https://github.com/go-acme/lego/releases/download/${LEGO_VER}/lego_${LEGO_VER}_${LARCH}.tar.gz" \
      | tar xz -C /usr/local/bin lego && \
    chmod +x /usr/local/bin/lego && \
    lego --version

COPY entrypoint.sh /etc/nginx/entrypoint.sh
COPY renew-letsencrypt.sh /etc/nginx/renew-letsencrypt.sh
RUN chmod +x /etc/nginx/entrypoint.sh /etc/nginx/renew-letsencrypt.sh

ENTRYPOINT ["/bin/sh", "/etc/nginx/entrypoint.sh"]
