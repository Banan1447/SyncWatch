'use strict';

const os = require('os');
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const mediasoup = require('mediasoup');

const PORT = process.env.PORT || 8080;
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '127.0.0.1';
const MIN_PORT = parseInt(process.env.RTC_MIN_PORT || '40000');
const MAX_PORT = parseInt(process.env.RTC_MAX_PORT || '40099');

// ──────────────────────────────────────────────────────────────
// Mediasoup configuration
// ──────────────────────────────────────────────────────────────
const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
];

const transportOptions = {
  listenInfos: [
    {
      protocol: 'udp',
      ip: '0.0.0.0',
      announcedAddress: ANNOUNCED_IP,
      portRange: { min: MIN_PORT, max: MAX_PORT },
    },
    {
      protocol: 'tcp',
      ip: '0.0.0.0',
      announcedAddress: ANNOUNCED_IP,
      portRange: { min: MIN_PORT, max: MAX_PORT },
    },
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
};

// ──────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────
/** @type {Map<string, mediasoup.types.Router>} roomId → Router */
const routers = new Map();

/**
 * rooms[roomId][peerId] = {
 *   transports: Map<transportId, Transport>,
 *   producers:  Map<producerId, Producer>,
 *   consumers:  Map<consumerId, Consumer>,
 *   ws: WebSocket | null
 * }
 */
const rooms = new Map();

/** @type {mediasoup.types.Worker[]} */
let workers = [];
let workerIdx = 0;

// ──────────────────────────────────────────────────────────────
// Init workers
// ──────────────────────────────────────────────────────────────
async function createWorkers() {
  const numWorkers = Math.min(os.cpus().length, 4);
  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: MIN_PORT,
      rtcMaxPort: MAX_PORT,
    });
    worker.on('died', () => {
      console.error('mediasoup Worker died, exiting:', worker.pid);
      process.exit(1);
    });
    workers.push(worker);
  }
  console.log(`Created ${workers.length} mediasoup worker(s)`);
}

function getNextWorker() {
  const worker = workers[workerIdx % workers.length];
  workerIdx++;
  return worker;
}

async function getOrCreateRouter(roomId) {
  if (!routers.has(roomId)) {
    const worker = getNextWorker();
    const router = await worker.createRouter({ mediaCodecs });
    routers.set(roomId, router);
    console.log(`Router created for room ${roomId}`);
  }
  return routers.get(roomId);
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  return rooms.get(roomId);
}

function getOrCreatePeer(roomId, peerId) {
  const room = getOrCreateRoom(roomId);
  if (!room.has(peerId)) {
    room.set(peerId, {
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      ws: null,
    });
  }
  return room.get(peerId);
}

// ──────────────────────────────────────────────────────────────
// Express + HTTP server
// ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'media-server', workers: workers.length });
});

/** GET /api/v1/sfu/rooms/:roomId/capabilities */
app.get('/api/v1/sfu/rooms/:roomId/capabilities', async (req, res) => {
  try {
    const router = await getOrCreateRouter(req.params.roomId);
    res.json({ rtpCapabilities: router.rtpCapabilities });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/v1/sfu/rooms/:roomId/peers/:peerId/transport
 *  body: { direction: 'send' | 'recv' }
 */
app.post('/api/v1/sfu/rooms/:roomId/peers/:peerId/transport', async (req, res) => {
  const { roomId, peerId } = req.params;
  try {
    const router = await getOrCreateRouter(roomId);
    const peer = getOrCreatePeer(roomId, peerId);
    const transport = await router.createWebRtcTransport(transportOptions);

    peer.transports.set(transport.id, transport);

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') {
        peer.transports.delete(transport.id);
      }
    });

    res.json({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/v1/sfu/rooms/:roomId/peers/:peerId/transport/:transportId/connect
 *  body: { dtlsParameters }
 */
app.post('/api/v1/sfu/rooms/:roomId/peers/:peerId/transport/:transportId/connect', async (req, res) => {
  const { roomId, peerId, transportId } = req.params;
  const { dtlsParameters } = req.body;
  try {
    const peer = getOrCreatePeer(roomId, peerId);
    const transport = peer.transports.get(transportId);
    if (!transport) return res.status(404).json({ error: 'Transport not found' });
    await transport.connect({ dtlsParameters });
    res.json({ connected: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/v1/sfu/rooms/:roomId/peers/:peerId/transport/:transportId/produce
 *  body: { kind, rtpParameters }
 */
app.post('/api/v1/sfu/rooms/:roomId/peers/:peerId/transport/:transportId/produce', async (req, res) => {
  const { roomId, peerId, transportId } = req.params;
  const { kind, rtpParameters, appData } = req.body;
  try {
    const peer = getOrCreatePeer(roomId, peerId);
    const transport = peer.transports.get(transportId);
    if (!transport) return res.status(404).json({ error: 'Transport not found' });

    const producer = await transport.produce({ kind, rtpParameters, ...(appData ? { appData } : {}) });
    peer.producers.set(producer.id, producer);

    producer.on('transportclose', () => peer.producers.delete(producer.id));

    // Notify all peers in room about new producer (include source marker for system audio)
    notifyRoom(roomId, peerId, {
      type: 'new_producer',
      producerId: producer.id,
      kind,
      peerId,
      source: producer.appData?.source || null,
    });

    res.json({ producerId: producer.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/v1/sfu/rooms/:roomId/peers/:peerId/transport/:transportId/consume
 *  body: { producerId, rtpCapabilities }
 */
app.post('/api/v1/sfu/rooms/:roomId/peers/:peerId/transport/:transportId/consume', async (req, res) => {
  const { roomId, peerId, transportId } = req.params;
  const { producerId, rtpCapabilities } = req.body;
  try {
    const router = await getOrCreateRouter(roomId);
    const peer = getOrCreatePeer(roomId, peerId);
    const transport = peer.transports.get(transportId);
    if (!transport) return res.status(404).json({ error: 'Transport not found' });

    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return res.status(400).json({ error: 'Cannot consume this producer' });
    }

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });
    peer.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id);
      if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(JSON.stringify({ type: 'consumer_closed', consumerId: consumer.id }));
      }
    });

    res.json({
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      appData: consumer.appData || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/v1/sfu/rooms/:roomId/producers — list all producers in room */
app.get('/api/v1/sfu/rooms/:roomId/producers', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) return res.json([]);

  const producers = [];
  for (const [pid, peer] of room) {
    for (const [producerId, producer] of peer.producers) {
      producers.push({ producerId, peerId: pid, kind: producer.kind, source: producer.appData?.source || null });
    }
  }
  res.json(producers);
});

/** DELETE /api/v1/sfu/rooms/:roomId/peers/:peerId — cleanup peer */
app.delete('/api/v1/sfu/rooms/:roomId/peers/:peerId', (req, res) => {
  const { roomId, peerId } = req.params;
  cleanupPeer(roomId, peerId);
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────
// WebSocket notification channel (server → client)
// ──────────────────────────────────────────────────────────────
function notifyRoom(roomId, excludePeerId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const [pid, peer] of room) {
    if (pid === excludePeerId) continue;
    if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(data);
    }
  }
}

function cleanupPeer(roomId, peerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const peer = room.get(peerId);
  if (!peer) return;
  peer.consumers.forEach(c => c.close());
  peer.producers.forEach(p => { p.close(); notifyRoom(roomId, peerId, { type: 'producer_closed', producerId: p.id, peerId, source: p.appData?.source || null }); });
  peer.transports.forEach(t => t.close());
  room.delete(peerId);
  if (room.size === 0) {
    rooms.delete(roomId);
    const router = routers.get(roomId);
    if (router) { router.close(); routers.delete(roomId); }
  }
}

// ──────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/sfu-ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const roomId = url.searchParams.get('room');
  const peerId = url.searchParams.get('peer');
  if (!roomId || !peerId) { ws.close(); return; }

  const peer = getOrCreatePeer(roomId, peerId);
  peer.ws = ws;

  ws.on('close', () => cleanupPeer(roomId, peerId));
  ws.on('error', () => cleanupPeer(roomId, peerId));

  // Send list of existing producers on join
  const room = rooms.get(roomId);
  if (room) {
    const existing = [];
    for (const [pid, p] of room) {
      if (pid === peerId) continue;
      for (const [producerId, producer] of p.producers) {
        existing.push({ producerId, peerId: pid, kind: producer.kind, source: producer.appData?.source || null });
      }
    }
    if (existing.length > 0) {
      ws.send(JSON.stringify({ type: 'existing_producers', producers: existing }));
    }
  }

  console.log(`Peer ${peerId} connected to room ${roomId}`);
});

async function main() {
  await createWorkers();
  server.listen(PORT, () => {
    console.log(`Media server (Mediasoup SFU) listening on port ${PORT}`);
    console.log(`Announced IP: ${ANNOUNCED_IP}`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
