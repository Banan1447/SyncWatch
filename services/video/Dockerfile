# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s" \
    -o video-service \
    main.go

# Production stage
FROM alpine:latest AS production

WORKDIR /app

RUN apk --no-cache add ca-certificates wget ffmpeg python3 py3-pip aria2 && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp && \
    mkdir -p /tmp/sw-cache

COPY --from=builder /app/video-service /app/

RUN adduser -D -g '' appuser && \
    chown appuser:appuser /tmp/sw-cache
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["./video-service"]
