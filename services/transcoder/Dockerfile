# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s" \
    -o transcoder-service \
    main.go

# Production stage — needs ffmpeg
FROM alpine:latest AS production

WORKDIR /app

RUN apk --no-cache add ca-certificates wget ffmpeg

COPY --from=builder /app/transcoder-service /app/

RUN adduser -D -g '' appuser && \
    mkdir -p /tmp/transcoder && \
    chown appuser:appuser /tmp/transcoder
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["./transcoder-service"]
