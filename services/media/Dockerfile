FROM node:20-slim AS builder

# Build dependencies for mediasoup native compilation (fallback if prebuilt unavailable)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip g++ make && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --production

FROM node:20-slim

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY server.js ./

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080
EXPOSE 40000-49999/udp
EXPOSE 40000-49999/tcp

CMD ["node", "server.js"]
