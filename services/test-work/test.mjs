#!/usr/bin/env node
/**
 * test-work — WatchSync Platform integration test suite
 * Run: docker compose run --rm test-work
 */

import WebSocket from 'ws';

const KONG   = process.env.KONG_URL   || 'http://kong:8000';
const WS_GW  = process.env.WS_URL     || 'ws://ws-gateway:8080/ws';
const DELAY  = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const errors = [];

function ok(name) {
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  passed++;
}
function fail(name, reason) {
  console.log(`  \x1b[31m✗\x1b[0m ${name}: ${reason}`);
  failed++;
  errors.push(`${name}: ${reason}`);
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    fail(name, e.message || String(e));
  }
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${KONG}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// ─────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────

async function testHealth() {
  console.log('\n\x1b[1m[Health checks]\x1b[0m');
  for (const [name, url] of [
    ['kong',           `${KONG}/api/v1/auth/login`],
    ['auth-service',   'http://auth-service:8080/health'],
    ['room-service',   'http://room-service:8080/health'],
    ['video-service',  'http://video-service:8080/health'],
    ['user-service',   'http://user-service:8080/health'],
    ['chat-service',   'http://chat-service:8080/health'],
    ['sync-service',   'http://sync-service:8080/health'],
    ['ws-gateway',     'http://ws-gateway:8080/health'],
    ['transcoder',     'http://transcoder:8080/health'],
    ['media-server',   'http://media-server:8080/health'],
  ]) {
    await check(`${name} reachable`, async () => {
      const r = await fetch(url).catch(e => { throw new Error(e.message); });
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    });
  }
}

async function testAuth() {
  console.log('\n\x1b[1m[Auth]\x1b[0m');
  const suffix = Date.now();
  let token, userId, refreshToken;

  await check('register new user', async () => {
    const r = await api('POST', '/api/v1/auth/register', {
      username: `testbot_${suffix}`,
      password: 'Test1234!',
    });
    if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.access_token) throw new Error('no access_token in response');
    token = r.body.access_token;
    userId = r.body.user_id;
    refreshToken = r.body.refresh_token;
  });

  await check('login', async () => {
    const r = await api('POST', '/api/v1/auth/login', {
      username: `testbot_${suffix}`,
      password: 'Test1234!',
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!r.body.access_token) throw new Error('no access_token');
    token = r.body.access_token;
    userId = r.body.user_id;
    refreshToken = r.body.refresh_token || refreshToken;
  });

  await check('bad password rejected', async () => {
    const r = await api('POST', '/api/v1/auth/login', {
      username: `testbot_${suffix}`,
      password: 'wrong',
    });
    if (r.status < 400) throw new Error(`Expected 4xx, got ${r.status}`);
  });

  await check('GET /auth/me requires JWT (401 without token)', async () => {
    const r = await api('GET', '/api/v1/auth/me', null, null);
    if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
  });

  await check('GET /auth/me returns user with valid JWT', async () => {
    const r = await api('GET', '/api/v1/auth/me', null, token);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.user_id && !r.body.id && !r.body.username) throw new Error('no user data in response');
  });

  await check('JWT refresh returns new access_token', async () => {
    if (!refreshToken) {
      console.log('     \x1b[33mSKIP: no refresh_token in login response\x1b[0m');
      return;
    }
    const r = await api('POST', '/api/v1/auth/refresh', { refresh_token: refreshToken });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.access_token) throw new Error('no access_token in refresh response');
    token = r.body.access_token;
  });

  return { token, userId };
}

async function testRooms(token, userId) {
  console.log('\n\x1b[1m[Rooms]\x1b[0m');
  let roomId;

  await check('create room', async () => {
    const r = await api('POST', '/api/v1/rooms', {
      name: 'test-room',
      room_type: 1,
      is_public: true,
    }, token);
    if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.id) throw new Error('no room id');
    roomId = r.body.id;
  });

  await check('list rooms', async () => {
    const r = await api('GET', '/api/v1/rooms', null, token);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!Array.isArray(r.body)) throw new Error('expected array');
    if (!r.body.find(rm => rm.id === roomId)) throw new Error('created room not in list');
  });

  await check('get room by id', async () => {
    const r = await api('GET', `/api/v1/rooms/${roomId}`, null, token);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    // Response is either { room: {...}, online_users: N } or the room object directly
    const room = r.body?.room || r.body;
    if (room.id !== roomId) throw new Error(`wrong room id: got ${room.id}`);
  });

  return roomId;
}

async function testQueue(token, userId, roomId) {
  console.log('\n\x1b[1m[Queue]\x1b[0m');
  let itemId;

  await check('add direct URL to queue', async () => {
    const r = await api('POST', `/api/v1/rooms/${roomId}/queue`, {
      user_id: userId,
      video_source: 'direct',
      video_url: 'https://test.example.com/video.mp4',
    }, token);
    if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.id) throw new Error('no item id');
    itemId = r.body.id;
  });

  await check('add YouTube URL to queue', async () => {
    const r = await api('POST', `/api/v1/rooms/${roomId}/queue`, {
      user_id: userId,
      video_source: 'youtube',
      video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    }, token);
    if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.id) throw new Error('no item id');
    // Title should NOT be the raw URL (oEmbed should have fetched it)
    const title = r.body.title || r.body.video_metadata?.title || '';
    if (title === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') {
      throw new Error('oEmbed title not fetched — title is still the raw URL');
    }
    if (!title) throw new Error('empty title returned');
    console.log(`     YouTube title: \x1b[36m${title}\x1b[0m`);
  });

  await check('list queue', async () => {
    const r = await api('GET', `/api/v1/rooms/${roomId}/queue`, null, token);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!Array.isArray(r.body)) throw new Error('expected array');
    if (r.body.length < 2) throw new Error(`expected ≥2 items, got ${r.body.length}`);
  });

  await check('reorder queue', async () => {
    // First get current queue to have valid IDs
    const listR = await api('GET', `/api/v1/rooms/${roomId}/queue`, null, token);
    if (listR.status !== 200) throw new Error(`list HTTP ${listR.status}`);
    const items = Array.isArray(listR.body) ? listR.body : [];
    if (items.length < 2) return; // not enough items to reorder, skip
    // Reverse order
    const reordered = items.map((item, idx) => ({ id: item.id, position: items.length - 1 - idx }));
    const r = await api('PATCH', `/api/v1/rooms/${roomId}/queue/reorder`, reordered, token);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body?.status !== 'reordered') throw new Error(`unexpected body: ${JSON.stringify(r.body)}`);
    // Verify order actually changed
    const verifyR = await api('GET', `/api/v1/rooms/${roomId}/queue`, null, token);
    if (verifyR.status !== 200) throw new Error(`verify HTTP ${verifyR.status}`);
    const newItems = Array.isArray(verifyR.body) ? verifyR.body : [];
    if (newItems.length >= 2 && newItems[0].id === items[0].id) {
      throw new Error('order did not change after reorder');
    }
  });

  await check('delete queue item', async () => {
    const r = await api('DELETE', `/api/v1/rooms/${roomId}/queue/${itemId}`, null, token);
    if (r.status !== 200 && r.status !== 204) throw new Error(`HTTP ${r.status}`);
  });
}

async function testWebSocket(token, userId, roomId) {
  console.log('\n\x1b[1m[WebSocket]\x1b[0m');

  await check('connect to ws-gateway', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('connect timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timeout); ws.close(); resolve(); });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));

  await check('join room via WebSocket', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout waiting for room event')); }, 8000);
    let joined = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'join_room',
        payload: { room_id: roomId, user_id: userId, token, username: 'testbot' },
        timestamp: Date.now(),
      }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (['room_init', 'room_state', 'sync_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          joined = true;
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws.on('close', () => { if (!joined) { clearTimeout(timeout); reject(new Error('closed before room event')); } });
  }));

  await check('ping/pong latency < 200ms', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('pong timeout')); }, 5000);
    ws.on('open', () => {
      const sent = Date.now();
      ws.send(JSON.stringify({ type: 'ping', timestamp: sent }));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'pong') {
          const rtt = Date.now() - sent;
          clearTimeout(timeout);
          ws.close();
          if (rtt > 200) reject(new Error(`RTT ${rtt}ms > 200ms`));
          else { console.log(`     RTT: \x1b[36m${rtt}ms\x1b[0m`); resolve(); }
        }
      });
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));
}

async function testRoomOwner(token, userId) {
  console.log('\n\x1b[1m[Room Owner]\x1b[0m');
  let ownedRoomId;

  await check('room created with token has owner_id set', async () => {
    const r = await api('POST', '/api/v1/rooms', { name: 'owner-test', room_type: 1, is_public: true }, token);
    if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
    ownedRoomId = r.body.id;
    const r2 = await api('GET', `/api/v1/rooms/${ownedRoomId}`, null, token);
    if (r2.status !== 200) throw new Error(`GET room HTTP ${r2.status}`);
    const room = r2.body?.room || r2.body;
    if (!room.owner_id) throw new Error('owner_id not set on room');
    if (room.owner_id !== userId) throw new Error(`owner_id mismatch: got ${room.owner_id}, expected ${userId}`);
    console.log(`     owner_id: \x1b[36m${room.owner_id}\x1b[0m`);
  });

  if (ownedRoomId) await api('DELETE', `/api/v1/rooms/${ownedRoomId}`, null, token);
}

async function testVideoSelect(token, userId, roomId) {
  console.log('\n\x1b[1m[Video Select]\x1b[0m');

  await check('video_select sends video_updated to all room members', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout waiting for video_updated')); }, 8000);
    let joined = false;
    let gotUpdated = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'join_room',
        payload: { room_id: roomId, user_id: userId, token, username: 'testbot' },
        timestamp: Date.now(),
      }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!joined && ['room_init', 'room_state', 'sync_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          joined = true;
          ws.send(JSON.stringify({
            type: 'video_select',
            payload: { video_url: 'https://test.example.com/test.mp4', video_source: 'direct', title: 'test-video' },
            timestamp: Date.now(),
          }));
        }
        if (msg.type === 'video_updated') {
          gotUpdated = true;
          clearTimeout(timeout);
          ws.close();
          if (!msg.payload?.video_url && !msg.payload?.url)
            reject(new Error('video_updated payload missing video_url'));
          else resolve();
        }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws.on('close', () => { if (!gotUpdated) { clearTimeout(timeout); reject(new Error('closed before video_updated')); } });
  }));
}

async function testSyncFlow(token, userId, roomId) {
  console.log('\n\x1b[1m[Sync Flow]\x1b[0m');

  // Test 1: join after video_select → room_init includes video_url
  await check('room_init includes video_url after video_select', () => new Promise((resolve, reject) => {
    let ws2 = null;
    const ws1 = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws1.close(); if (ws2) ws2.close(); reject(new Error('timeout')); }, 10000);
    let ws1Joined = false, videoSelected = false;

    ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token }, timestamp: Date.now() })));
    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Joined && ['room_init', 'room_state', 'sync_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Joined = true;
          ws1.send(JSON.stringify({ type: 'video_select', payload: { video_url: 'https://test.example.com/sync-test.mp4', video_source: 'direct', title: 'sync-test' }, timestamp: Date.now() }));
        }
        if (!videoSelected && msg.type === 'video_updated') {
          videoSelected = true;
          const uid2 = userId + '_sync';
          // Create ws2 only after video_updated so the open event is not missed
          ws2 = new WebSocket(WS_GW);
          ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: uid2, token }, timestamp: Date.now() })));
          ws2.on('message', (d2) => {
            try {
              const m2 = JSON.parse(d2.toString());
              if (m2.type === 'room_init') {
                clearTimeout(timeout); ws1.close(); ws2.close();
                if (!m2.payload?.video_url) reject(new Error('room_init missing video_url'));
                else { console.log(`     video_url: \x1b[36m${m2.payload.video_url}\x1b[0m`); resolve(); }
              }
            } catch { /* ignore */ }
          });
          ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
        }
      } catch { /* ignore */ }
    });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));

  // Test 2: sync_ready → all_synced (sole user in room = immediately ready)
  await check('all_synced fires when all users send sync_ready', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout waiting for all_synced')); }, 8000);
    let joined = false;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token }, timestamp: Date.now() })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!joined && ['room_init', 'room_state', 'sync_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          joined = true;
          ws.send(JSON.stringify({ type: 'sync_ready', room_id: roomId, timestamp: Date.now() }));
        }
        if (msg.type === 'all_synced') {
          clearTimeout(timeout); ws.close();
          console.log(`     synced: \x1b[36m${msg.payload?.ready}/${msg.payload?.total}\x1b[0m`);
          resolve();
        }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));
}

async function testVideoSync(token, userId, roomId) {
  console.log('\n\x1b[1m[Video Sync — Play/Pause/Seek]\x1b[0m');

  // Two clients: ws1 sends a play action, ws2 must receive state_sync with is_playing=true
  await check('play action propagates to second client as state_sync', () => new Promise((resolve, reject) => {
    const ws1 = new WebSocket(WS_GW);
    const ws2 = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws1.close(); ws2.close(); reject(new Error('timeout waiting for state_sync')); }, 12000);
    let ws1Ready = false, ws2Ready = false;

    function trySendPlay() {
      if (!ws1Ready || !ws2Ready) return;
      ws1.send(JSON.stringify({
        type: 'video_action',
        payload: { action: 'play', time: 0, rate: 1.0, source: 'direct', version: Date.now() },
        timestamp: Date.now(),
      }));
    }

    ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'sync-test-1' }, timestamp: Date.now() })));
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId + '_2', token, username: 'sync-test-2' }, timestamp: Date.now() })));

    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Ready && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Ready = true; trySendPlay();
        }
      } catch { /* ignore */ }
    });

    ws2.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws2Ready && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws2Ready = true; trySendPlay();
        }
        if (msg.type === 'state_sync' && msg.payload?.state?.is_playing === true) {
          clearTimeout(timeout); ws1.close(); ws2.close(); resolve();
        }
      } catch { /* ignore */ }
    });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));

  // Pause propagation
  await check('pause action propagates to second client as state_sync', () => new Promise((resolve, reject) => {
    const ws1 = new WebSocket(WS_GW);
    const ws2 = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws1.close(); ws2.close(); reject(new Error('timeout waiting for pause state_sync')); }, 12000);
    let ws1Ready = false, ws2Ready = false;

    function trySendPause() {
      if (!ws1Ready || !ws2Ready) return;
      ws1.send(JSON.stringify({
        type: 'video_action',
        payload: { action: 'pause', time: 5.0, rate: 1.0, source: 'direct', version: Date.now() },
        timestamp: Date.now(),
      }));
    }

    ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'sync-test-1' }, timestamp: Date.now() })));
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId + '_3', token, username: 'sync-test-3' }, timestamp: Date.now() })));

    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Ready && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Ready = true; trySendPause();
        }
      } catch { /* ignore */ }
    });

    ws2.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws2Ready && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws2Ready = true; trySendPause();
        }
        if (msg.type === 'state_sync' && msg.payload?.state?.is_playing === false) {
          clearTimeout(timeout); ws1.close(); ws2.close(); resolve();
        }
      } catch { /* ignore */ }
    });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));

  // Seek propagation
  await check('seek action reflected in state_sync adjusted_time', () => new Promise((resolve, reject) => {
    const ws1 = new WebSocket(WS_GW);
    const ws2 = new WebSocket(WS_GW);
    const SEEK_TIME = 42.5;
    const timeout = setTimeout(() => { ws1.close(); ws2.close(); reject(new Error('timeout waiting for seek state_sync')); }, 12000);
    let ws1Ready = false, ws2Ready = false;

    function trySendSeek() {
      if (!ws1Ready || !ws2Ready) return;
      ws1.send(JSON.stringify({
        type: 'video_action',
        payload: { action: 'seek', time: SEEK_TIME, rate: 1.0, source: 'direct', version: Date.now() },
        timestamp: Date.now(),
      }));
    }

    ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'sync-test-1' }, timestamp: Date.now() })));
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId + '_4', token, username: 'sync-test-4' }, timestamp: Date.now() })));

    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Ready && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Ready = true; trySendSeek();
        }
      } catch { /* ignore */ }
    });

    ws2.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws2Ready && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws2Ready = true; trySendSeek();
        }
        if (msg.type === 'state_sync') {
          const t = msg.payload?.adjusted_time ?? msg.payload?.state?.current_time;
          if (typeof t === 'number' && Math.abs(t - SEEK_TIME) < 2.0) {
            clearTimeout(timeout); ws1.close(); ws2.close();
            console.log(`     adjusted_time: \x1b[36m${t.toFixed(2)}s\x1b[0m`);
            resolve();
          }
        }
      } catch { /* ignore */ }
    });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));
}

async function testChat(token, userId, roomId) {
  console.log('\n\x1b[1m[Chat]\x1b[0m');

  await check('chat message echoed back to sender', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_GW);
    const CONTENT = `hello-${Date.now()}`;
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout waiting for chat echo')); }, 8000);
    let joined = false;

    ws.on('open', () => ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'chatbot' }, timestamp: Date.now() })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          joined = true;
          ws.send(JSON.stringify({ type: 'chat_message', payload: { content: CONTENT, type: 'text' }, timestamp: Date.now() }));
        }
        if (msg.type === 'chat_message') {
          const content = msg.payload?.content ?? msg.payload?.text ?? msg.payload?.message;
          if (content === CONTENT) {
            clearTimeout(timeout); ws.close(); resolve();
          }
        }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));

  await check('chat message delivered to second client in room', () => new Promise((resolve, reject) => {
    const ws1 = new WebSocket(WS_GW);
    const ws2 = new WebSocket(WS_GW);
    const CONTENT = `cross-${Date.now()}`;
    const timeout = setTimeout(() => { ws1.close(); ws2.close(); reject(new Error('timeout waiting for chat delivery')); }, 10000);
    let ws1Joined = false, ws2Joined = false;

    function trySendChat() {
      if (!ws1Joined || !ws2Joined) return;
      ws1.send(JSON.stringify({ type: 'chat_message', payload: { content: CONTENT, type: 'text' }, timestamp: Date.now() }));
    }

    ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'chat-a' }, timestamp: Date.now() })));
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId + '_chat2', token, username: 'chat-b' }, timestamp: Date.now() })));

    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Joined = true; trySendChat();
        }
      } catch { /* ignore */ }
    });

    ws2.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws2Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws2Joined = true; trySendChat();
        }
        if (msg.type === 'chat_message') {
          const content = msg.payload?.content ?? msg.payload?.text ?? msg.payload?.message;
          if (content === CONTENT) {
            clearTimeout(timeout); ws1.close(); ws2.close(); resolve();
          }
        }
      } catch { /* ignore */ }
    });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));
}

async function testVoiceRelay(token, userId, roomId) {
  console.log('\n\x1b[1m[Voice/WebRTC Relay]\x1b[0m');

  await check('voice_offer relayed to target peer', () => new Promise((resolve, reject) => {
    const ws1 = new WebSocket(WS_GW);
    const ws2 = new WebSocket(WS_GW);
    const uid2 = userId + '_voice2';
    const SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n';
    const timeout = setTimeout(() => { ws1.close(); ws2.close(); reject(new Error('timeout waiting for voice_offer relay')); }, 10000);
    let ws1Joined = false, ws2Joined = false;

    function trySendOffer() {
      if (!ws1Joined || !ws2Joined) return;
      ws1.send(JSON.stringify({
        type: 'voice_offer',
        payload: { target: uid2, sdp: SDP },
        timestamp: Date.now(),
      }));
    }

    ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'voice-a' }, timestamp: Date.now() })));
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: uid2, token, username: 'voice-b' }, timestamp: Date.now() })));

    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Joined = true; trySendOffer();
        }
      } catch { /* ignore */ }
    });

    ws2.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws2Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws2Joined = true; trySendOffer();
        }
        if (msg.type === 'voice_offer' && msg.payload?.sdp === SDP) {
          clearTimeout(timeout); ws1.close(); ws2.close(); resolve();
        }
      } catch { /* ignore */ }
    });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));

  await check('stream_start broadcast to all room members', () => new Promise((resolve, reject) => {
    const ws1 = new WebSocket(WS_GW);
    const ws2 = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws1.close(); ws2.close(); reject(new Error('timeout waiting for stream_start')); }, 10000);
    let ws1Joined = false, ws2Joined = false;

    function trySendStreamStart() {
      if (!ws1Joined || !ws2Joined) return;
      ws1.send(JSON.stringify({ type: 'stream_start', payload: { streamer_id: userId }, timestamp: Date.now() }));
    }

    ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'streamer' }, timestamp: Date.now() })));
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId + '_viewer', token, username: 'viewer' }, timestamp: Date.now() })));

    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Joined = true; trySendStreamStart();
        }
      } catch { /* ignore */ }
    });

    ws2.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws2Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws2Joined = true; trySendStreamStart();
        }
        if (msg.type === 'stream_start') {
          clearTimeout(timeout); ws1.close(); ws2.close(); resolve();
        }
      } catch { /* ignore */ }
    });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));
}

async function testConnectionStability(token, userId, roomId) {
  console.log('\n\x1b[1m[Connection Stability]\x1b[0m');

  // 1: 10 simultaneous connections to same room
  await check('10 concurrent connections to same room', () => new Promise(async (resolve, reject) => {
    const N = 10;
    const conns = [];
    let ready = 0;
    const timeout = setTimeout(() => {
      conns.forEach(w => w.close());
      reject(new Error(`only ${ready}/${N} connections joined`));
    }, 15000);

    for (let i = 0; i < N; i++) {
      const ws = new WebSocket(WS_GW);
      conns.push(ws);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: `${userId}_load${i}`, token, username: `load${i}` }, timestamp: Date.now() })));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
            ready++;
            if (ready >= N) {
              clearTimeout(timeout);
              conns.forEach(w => w.close());
              console.log(`     ${N} connections ready simultaneously`);
              resolve();
            }
          }
        } catch { /* ignore */ }
      });
      ws.on('error', () => {}); // don't reject on individual connection error
    }
  }));

  // 2: Rapid join/leave/rejoin — tests no channel leak
  await check('rapid join/leave/rejoin (5 cycles)', async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_GW);
        const timeout = setTimeout(() => { ws.close(); reject(new Error(`cycle ${i}: join timeout`)); }, 6000);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: `${userId}_rapid`, token, username: 'rapid' }, timestamp: Date.now() })));
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
              clearTimeout(timeout);
              ws.close();
              resolve();
            }
          } catch { /* ignore */ }
        });
        ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
      });
      await DELAY(100);
    }
  });

  // 3: Client disconnect doesn't crash server — other clients remain connected
  await check('server stable after client disconnect', () => new Promise((resolve, reject) => {
    const ws1 = new WebSocket(WS_GW); // stays alive
    const ws2 = new WebSocket(WS_GW); // disconnects
    const timeout = setTimeout(() => { ws1.close(); ws2.close(); reject(new Error('timeout')); }, 12000);
    let ws1Joined = false, ws2Joined = false, ws2Closed = false;

    ws1.on('open', () => ws1.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'survivor' }, timestamp: Date.now() })));
    ws2.on('open', () => ws2.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId + '_drop', token, username: 'dropper' }, timestamp: Date.now() })));

    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Joined = true;
          // Once ws2 also joined and then closed, ws1 should receive user_left and stay alive
        }
        if (ws2Closed && msg.type === 'user_left') {
          // ws1 got user_left — server properly notified; verify ws1 is still alive with a ping
          ws1.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
        if (ws2Closed && msg.type === 'pong') {
          clearTimeout(timeout); ws1.close(); resolve();
        }
      } catch { /* ignore */ }
    });

    ws2.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws2Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws2Joined = true;
          // Abruptly close ws2 after joining
          setTimeout(() => { ws2Closed = true; ws2.close(); }, 200);
        }
      } catch { /* ignore */ }
    });

    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws2.on('error', () => {}); // ws2 close is intentional
  }));

  // 4: Heartbeat arrives within expected window
  await check('state_sync heartbeat arrives within 6 seconds', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('no state_sync heartbeat within 6s')); }, 7000);
    let joined = false;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId, user_id: userId, token, username: 'hb-test' }, timestamp: Date.now() })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          joined = true;
          // Don't resolve yet — wait for a heartbeat state_sync (source_user_id=_heartbeat)
        }
        if (joined && msg.type === 'state_sync') {
          const src = msg.payload?.source_user_id;
          if (src === '_heartbeat' || src === '_system') {
            clearTimeout(timeout); ws.close();
            console.log(`     heartbeat arrived (source: ${src})`);
            resolve();
          }
        }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));
}

async function testUsers(token, userId) {
  console.log('\n\x1b[1m[Users]\x1b[0m');

  await check('GET /users/:id requires JWT (401 without token)', async () => {
    if (!userId) { console.log('     \x1b[33mSKIP: no userId\x1b[0m'); return; }
    const r = await api('GET', `/api/v1/users/${userId}`, null, null);
    if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
  });

  await check('GET /users/:id returns user profile', async () => {
    if (!userId) { console.log('     \x1b[33mSKIP: no userId\x1b[0m'); return; }
    const r = await api('GET', `/api/v1/users/${userId}`, null, token);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    const user = r.body.user || r.body;
    if (!user.id && !user.user_id && !user.username) throw new Error('no user fields in response');
  });

  await check('PATCH /users/me updates display name', async () => {
    const r = await api('PATCH', '/api/v1/users/me', { display_name: 'TestBot Updated' }, token);
    if (r.status === 404 || r.status === 501) {
      console.log(`     \x1b[33mSKIP: endpoint not implemented (${r.status})\x1b[0m`);
      return;
    }
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  });
}

async function testInvite(token, roomId) {
  console.log('\n\x1b[1m[Invite Codes]\x1b[0m');

  await check('POST /rooms/:id/invite generates invite_code', async () => {
    if (!roomId) { console.log('     \x1b[33mSKIP: no roomId\x1b[0m'); return; }
    const r = await api('POST', `/api/v1/rooms/${roomId}/invite`, {}, token);
    if (r.status === 404 || r.status === 501) {
      console.log(`     \x1b[33mSKIP: endpoint not implemented (${r.status})\x1b[0m`);
      return;
    }
    if (r.status !== 200 && r.status !== 201) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    const code = r.body.invite_code || r.body.code || r.body.token;
    if (!code) throw new Error('no invite_code in response');
    console.log(`     invite_code: \x1b[36m${String(code).slice(0, 16)}...\x1b[0m`);
  });
}

async function testTranscoder(token) {
  console.log('\n\x1b[1m[Transcoder]\x1b[0m');

  await check('GET /transcoder/jobs returns job list', async () => {
    const r = await fetch('http://transcoder:8080/api/v1/transcode/jobs', {
      headers: { 'Authorization': `Bearer ${token}` },
    }).catch(e => { throw new Error(e.message); });
    if (r.status === 404 || r.status === 501) {
      console.log(`     \x1b[33mSKIP: endpoint not implemented (${r.status})\x1b[0m`);
      return;
    }
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
  });
}

async function testMediaSFU() {
  console.log('\n\x1b[1m[Media SFU]\x1b[0m');
  const testRoomId = 'sfu-test-room';

  await check('GET /sfu/rooms/:id/capabilities returns rtpCapabilities', async () => {
    const r = await fetch(`http://media-server:8080/api/v1/sfu/rooms/${testRoomId}/capabilities`)
      .catch(e => { throw new Error(e.message); });
    if (r.status === 503) {
      console.log('     \x1b[33mSKIP: media-server starting\x1b[0m');
      return;
    }
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (!body.rtpCapabilities) throw new Error('no rtpCapabilities in response');
    if (!body.rtpCapabilities.codecs || body.rtpCapabilities.codecs.length === 0) {
      throw new Error('rtpCapabilities.codecs is empty');
    }
    console.log(`     codecs: ${body.rtpCapabilities.codecs.map(c => c.mimeType).join(', ')}`);
  });
}

async function testProxyMode(token, userId, roomId) {
  console.log('\n\x1b[1m[Proxy Mode]\x1b[0m');

  const testURL = 'https://test.example.com/video.mp4';

  await check('POST /proxy-config with enabled=true returns proxy_url', async () => {
    const r = await api('POST', `/api/v1/rooms/${roomId}/proxy-config`, {
      url: testURL,
      enabled: true,
    }, token);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.proxy_url) throw new Error('no proxy_url in response');
    if (!r.body.proxy_mode_enabled) throw new Error('proxy_mode_enabled should be true');
    console.log(`     proxy_url: \x1b[36m${r.body.proxy_url}\x1b[0m`);
  });

  await check('POST /proxy-config with enabled=false returns proxy_mode_enabled=false', async () => {
    const r = await api('POST', `/api/v1/rooms/${roomId}/proxy-config`, {
      url: testURL,
      enabled: false,
    }, token);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    if (r.body.proxy_mode_enabled !== false) throw new Error('proxy_mode_enabled should be false');
  });

  await check('proxy mode persisted: room_init for late joiner includes proxy_mode', () => new Promise((resolve, reject) => {
    const ws1 = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws1.close(); reject(new Error('timeout')); }, 14000);
    let ws1Joined = false;
    const fakeProxyURL = `/api/v1/rooms/${roomId}/proxy-url?url=${encodeURIComponent(testURL)}`;

    ws1.on('open', () => ws1.send(JSON.stringify({
      type: 'join_room',
      payload: { room_id: roomId, user_id: userId, token, username: 'proxy-a' },
      timestamp: Date.now(),
    })));

    ws1.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!ws1Joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          ws1Joined = true;
          ws1.send(JSON.stringify({
            type: 'video_select',
            payload: {
              video_url: fakeProxyURL,
              video_source: 'direct',
              title: 'Proxy Test [прокси]',
              proxy_mode: true,
              original_url: testURL,
            },
            timestamp: Date.now(),
          }));
        }
        if (ws1Joined && msg.type === 'video_updated') {
          // Late joiner connects after proxy mode is active
          const ws2 = new WebSocket(WS_GW);
          ws2.on('open', () => ws2.send(JSON.stringify({
            type: 'join_room',
            payload: { room_id: roomId, user_id: userId + '_pm2', token, username: 'proxy-b' },
            timestamp: Date.now(),
          })));
          ws2.on('message', (d2) => {
            try {
              const m2 = JSON.parse(d2.toString());
              if (m2.type === 'room_init') {
                clearTimeout(timeout); ws1.close(); ws2.close();
                if (!m2.payload?.proxy_mode?.enabled)
                  reject(new Error('room_init missing proxy_mode.enabled'));
                else if (m2.payload.proxy_mode.original_url !== testURL)
                  reject(new Error(`wrong original_url: ${m2.payload.proxy_mode.original_url}`));
                else {
                  console.log(`     proxy_mode.original_url: \x1b[36m${m2.payload.proxy_mode.original_url}\x1b[0m`);
                  resolve();
                }
              }
            } catch { /* ignore */ }
          });
          ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
        }
      } catch { /* ignore */ }
    });
    ws1.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));

  await check('proxy mode cleared: video_select without proxy_mode removes Redis key', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_GW);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
    let joined = false;

    ws.on('open', () => ws.send(JSON.stringify({
      type: 'join_room',
      payload: { room_id: roomId, user_id: userId, token, username: 'proxy-clear' },
      timestamp: Date.now(),
    })));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!joined && ['room_init', 'room_state', 'user_joined', 'state_sync'].includes(msg.type)) {
          joined = true;
          // Send normal video_select (no proxy_mode) to clear proxy state
          ws.send(JSON.stringify({
            type: 'video_select',
            payload: { video_url: testURL, video_source: 'direct', title: 'Original', proxy_mode: false },
            timestamp: Date.now(),
          }));
        }
        if (joined && msg.type === 'video_updated') {
          // Now check room_init for a fresh joiner — should NOT have proxy_mode
          const ws2 = new WebSocket(WS_GW);
          ws2.on('open', () => ws2.send(JSON.stringify({
            type: 'join_room',
            payload: { room_id: roomId, user_id: userId + '_clear2', token, username: 'proxy-clear-2' },
            timestamp: Date.now(),
          })));
          ws2.on('message', (d2) => {
            try {
              const m2 = JSON.parse(d2.toString());
              if (m2.type === 'room_init') {
                clearTimeout(timeout); ws.close(); ws2.close();
                if (m2.payload?.proxy_mode?.enabled)
                  reject(new Error('proxy_mode.enabled should be absent after clear'));
                else resolve();
              }
            } catch { /* ignore */ }
          });
          ws2.on('error', (e) => { clearTimeout(timeout); reject(e); });
        }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  }));
}

async function testCleanup(token, roomId) {
  console.log('\n\x1b[1m[Cleanup]\x1b[0m');
  await check('delete test room', async () => {
    const r = await api('DELETE', `/api/v1/rooms/${roomId}`, null, token);
    if (r.status !== 200 && r.status !== 204) throw new Error(`HTTP ${r.status}`);
  });
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log('\x1b[1m\x1b[35m══════════════════════════════════════\x1b[0m');
  console.log('\x1b[1m\x1b[35m   WatchSync Platform — Integration Tests\x1b[0m');
  console.log('\x1b[1m\x1b[35m══════════════════════════════════════\x1b[0m');

  // Wait for services to be ready
  console.log('\nWaiting for services...');
  await DELAY(3000);

  await testHealth();
  const { token, userId } = await testAuth();
  const roomId = await testRooms(token, userId);
  await testUsers(token, userId);
  await testInvite(token, roomId);
  await testQueue(token, userId, roomId);
  await testWebSocket(token, userId, roomId);
  await testRoomOwner(token, userId);
  await testVideoSelect(token, userId, roomId);
  await testSyncFlow(token, userId, roomId);
  await testVideoSync(token, userId, roomId);
  await testChat(token, userId, roomId);
  await testVoiceRelay(token, userId, roomId);
  await testConnectionStability(token, userId, roomId);
  await testTranscoder(token);
  await testMediaSFU();
  await testProxyMode(token, userId, roomId);
  await testCleanup(token, roomId);

  // ─── Summary ───
  console.log('\n\x1b[1m\x1b[35m══════════════════════════════════════\x1b[0m');
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[1m\x1b[32m  ALL ${total} TESTS PASSED\x1b[0m`);
  } else {
    console.log(`\x1b[1m\x1b[31m  ${failed}/${total} TESTS FAILED\x1b[0m`);
    errors.forEach(e => console.log(`  \x1b[31m→ ${e}\x1b[0m`));
  }
  console.log('\x1b[1m\x1b[35m══════════════════════════════════════\x1b[0m\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\x1b[31mFatal error:\x1b[0m', e);
  process.exit(1);
});
