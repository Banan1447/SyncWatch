/**
 * useSFUVoice — голосовой чат через Mediasoup SFU.
 * Используется вместо useVoiceChat когда нужны комнаты без лимита участников.
 *
 * Flow:
 * 1. GET /api/v1/sfu/rooms/{roomId}/capabilities → Device.load(rtpCapabilities)
 * 2. POST transport (send) → Device.createSendTransport() → connect + produce audio
 * 3. POST transport (recv) → Device.createRecvTransport() → consume каждого producerId
 * 4. WS events: new_producer → consume; consumer_closed → remove track
 */

import { useState, useRef, useCallback, useEffect } from 'react';

const SFU_API = '/api/v1/sfu';

export default function useSFUVoice({ roomId, myId, token, sendMessage, onEvent }) {
  const [inVoice, setInVoice] = useState(false);
  const [voiceMembers, setVoiceMembers] = useState([]);   // [{id, name}]
  const [isMuted, setIsMuted] = useState(false);
  const [speaking, setSpeaking] = useState({});           // {peerId: bool}
  const [peerPings, setPeerPings] = useState({});         // SFU — no P2P RTT; placeholder
  const [isSystemAudio, setIsSystemAudio] = useState(false);
  const [systemAudioPeers, setSystemAudioPeers] = useState({});   // peerId → bool

  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producerRef = useRef(null);
  const consumersRef = useRef({});      // producerId → consumer
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const vadIntervalRef = useRef(null);
  const inVoiceRef = useRef(false);
  const sysAudioProducerRef = useRef(null);
  const sysAudioStreamRef = useRef(null);
  const sysAudioElsRef = useRef({});       // peerId → <audio> for system sound
  const isSystemAudioRef = useRef(false);

  const authHeaders = useCallback(() => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);

  const sfuFetch = useCallback(async (path, method = 'GET', body = undefined) => {
    const res = await fetch(`${SFU_API}${path}`, {
      method,
      headers: authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }, [authHeaders]);

  // ── VAD (voice activity detection) ─────────────────────────────────────────
  const startVAD = useCallback((stream) => {
    if (!stream) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    vadIntervalRef.current = setInterval(() => {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
      setSpeaking(p => ({ ...p, [myId]: avg > 10 }));
    }, 100);
  }, [myId]);

  const stopVAD = useCallback(() => {
    if (vadIntervalRef.current) { clearInterval(vadIntervalRef.current); vadIntervalRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null; }
    setSpeaking({});
  }, []);

  // ── Join SFU ────────────────────────────────────────────────────────────────
  const joinVoice = useCallback(async () => {
    if (inVoiceRef.current || !roomId || !myId) return;
    try {
      // 1. Load mediasoup-client Device
      const { Device } = await import('mediasoup-client');
      const caps = await sfuFetch(`/rooms/${roomId}/capabilities`);
      const device = new Device();
      await device.load({ routerRtpCapabilities: caps.rtpCapabilities });
      deviceRef.current = device;

      // 2. Create send transport
      const sendParams = await sfuFetch(`/rooms/${roomId}/peers/${myId}/transport`, 'POST', { direction: 'send' });
      const sendTransport = device.createSendTransport({
        id: sendParams.id,
        iceParameters: sendParams.iceParameters,
        iceCandidates: sendParams.iceCandidates,
        dtlsParameters: sendParams.dtlsParameters,
      });
      sendTransportRef.current = sendTransport;

      sendTransport.on('connect', async ({ dtlsParameters }, cb, errCb) => {
        try {
          await sfuFetch(`/rooms/${roomId}/peers/${myId}/transport/${sendTransport.id}/connect`, 'POST', { dtlsParameters });
          cb();
        } catch (e) { errCb(e); }
      });
      sendTransport.on('produce', async ({ kind, rtpParameters, appData }, cb, errCb) => {
        try {
          const { producerId } = await sfuFetch(
            `/rooms/${roomId}/peers/${myId}/transport/${sendTransport.id}/produce`, 'POST',
            { kind, rtpParameters, appData }
          );
          cb({ id: producerId });
        } catch (e) { errCb(e); }
      });

      // 3. Create recv transport
      const recvParams = await sfuFetch(`/rooms/${roomId}/peers/${myId}/transport`, 'POST', { direction: 'recv' });
      const recvTransport = device.createRecvTransport({
        id: recvParams.id,
        iceParameters: recvParams.iceParameters,
        iceCandidates: recvParams.iceCandidates,
        dtlsParameters: recvParams.dtlsParameters,
      });
      recvTransportRef.current = recvTransport;

      recvTransport.on('connect', async ({ dtlsParameters }, cb, errCb) => {
        try {
          await sfuFetch(`/rooms/${roomId}/peers/${myId}/transport/${recvTransport.id}/connect`, 'POST', { dtlsParameters });
          cb();
        } catch (e) { errCb(e); }
      });

      // 4. Get microphone + produce audio
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const [audioTrack] = stream.getAudioTracks();
      const producer = await sendTransport.produce({ track: audioTrack });
      producerRef.current = producer;

      // 5. Consume existing producers
      const producers = await sfuFetch(`/rooms/${roomId}/producers`);
      for (const { producerId, peerId, source } of producers) {
        if (peerId !== myId) await consumeProducer(producerId, peerId);
        if (source === 'system' && peerId !== myId) {
          setSystemAudioPeers(p => ({ ...p, [peerId]: true }));
        }
      }

      inVoiceRef.current = true;
      setInVoice(true);
      startVAD(stream);

      // Notify room via WS
      sendMessage?.({ type: 'voice_join', payload: { user_id: myId, sfu: true } });
    } catch (e) {
      console.error('[SFU] joinVoice error:', e);
    }
  }, [roomId, myId, sfuFetch, startVAD, sendMessage]);

  // ── Consume a producer ──────────────────────────────────────────────────────
  const consumeProducer = useCallback(async (producerId, peerId) => {
    const device = deviceRef.current;
    const recvTransport = recvTransportRef.current;
    if (!device || !recvTransport) return;
    try {
      const data = await sfuFetch(
        `/rooms/${roomId}/peers/${myId}/transport/${recvTransport.id}/consume`, 'POST',
        { producerId, rtpCapabilities: device.rtpCapabilities }
      );
      const consumer = await recvTransport.consume({
        id: data.consumerId,
        producerId: data.producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters,
      });
      consumersRef.current[producerId] = consumer;

      const isSystem = data.appData?.source === 'system';

      // Attach audio to DOM — system sound gets its own element so its volume can
      // be managed independently of microphone audio later.
      const audioEl = new Audio();
      audioEl.srcObject = new MediaStream([consumer.track]);
      audioEl.autoplay = true;
      if (isSystem) {
        audioEl.id = `sys-audio-${peerId}`;
        sysAudioElsRef.current[peerId] = audioEl;
      }
      audioEl.play().catch(() => {});
      consumer._audioEl = audioEl;

      consumer.on('transportclose', () => {
        delete consumersRef.current[producerId];
        if (isSystem) delete sysAudioElsRef.current[peerId];
        audioEl.srcObject = null;
      });
    } catch (e) {
      console.warn('[SFU] consumeProducer error:', e);
    }
  }, [roomId, myId, sfuFetch]);

  // ── Leave SFU ───────────────────────────────────────────────────────────────
  const leaveVoice = useCallback(async () => {
    inVoiceRef.current = false;
    setInVoice(false);
    stopVAD();

    producerRef.current?.close();
    producerRef.current = null;

    // Stop system audio (WASAPI loopback) producer + stream
    sysAudioProducerRef.current?.close();
    sysAudioProducerRef.current = null;
    sysAudioStreamRef.current?.getTracks().forEach(t => t.stop());
    sysAudioStreamRef.current = null;
    isSystemAudioRef.current = false;
    setIsSystemAudio(false);
    for (const el of Object.values(sysAudioElsRef.current)) { el.pause(); el.srcObject = null; }
    sysAudioElsRef.current = {};
    setSystemAudioPeers({});

    for (const c of Object.values(consumersRef.current)) {
      c._audioEl?.pause();
      c.close();
    }
    consumersRef.current = {};

    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    deviceRef.current = null;

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    await sfuFetch(`/rooms/${roomId}/peers/${myId}`, 'DELETE').catch(() => {});
    sendMessage?.({ type: 'voice_leave', payload: { user_id: myId } });
    setVoiceMembers([]);
  }, [roomId, myId, sfuFetch, stopVAD, sendMessage]);

  // ── Toggle mute ─────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const producer = producerRef.current;
    if (!producer) return;
    if (isMuted) {
      producer.resume();
    } else {
      producer.pause();
    }
    setIsMuted(m => !m);
  }, [isMuted]);

  // ── System audio (WASAPI loopback — Electron desktop only) ─────────────────
  const startSystemAudio = useCallback(async () => {
    if (isSystemAudioRef.current) return;
    try {
      if (!window.electronAPI?.getSystemAudioSourceId) {
        console.warn('[SFU] System audio requires the Electron desktop app');
        return;
      }
      // Ensure we're connected to the SFU (mic producer is set up alongside)
      if (!sendTransportRef.current) await joinVoice();
      if (!sendTransportRef.current) return;

      const sourceId = await window.electronAPI.getSystemAudioSourceId();
      if (!sourceId) throw new Error('No system audio source available');

      // Chromium requires a video track for desktop audio capture; stop it right away.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
      });
      stream.getVideoTracks().forEach(t => t.stop());
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error('No system audio track captured');

      const producer = await sendTransportRef.current.produce({
        track: audioTrack,
        appData: { source: 'system' },
      });
      sysAudioProducerRef.current = producer;
      sysAudioStreamRef.current = stream;

      isSystemAudioRef.current = true;
      setIsSystemAudio(true);
      sendMessage?.({ type: 'system_audio_start', payload: { user_id: myId }, timestamp: Date.now() });
    } catch (e) {
      console.error('[SFU] startSystemAudio error:', e);
    }
  }, [joinVoice, myId, sendMessage]);

  const stopSystemAudio = useCallback(() => {
    if (!isSystemAudioRef.current) return;
    sysAudioProducerRef.current?.close();
    sysAudioProducerRef.current = null;
    sysAudioStreamRef.current?.getTracks().forEach(t => t.stop());
    sysAudioStreamRef.current = null;
    isSystemAudioRef.current = false;
    setIsSystemAudio(false);
    sendMessage?.({ type: 'system_audio_stop', payload: { user_id: myId }, timestamp: Date.now() });
  }, [myId, sendMessage]);

  // ── Handle WS events ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!onEvent) return;
    const handler = (msg) => {
      if (!msg?.type) return;
      switch (msg.type) {
        case 'voice_join':
          if (msg.payload?.user_id !== myId) {
            setVoiceMembers(p => p.find(m => m.id === msg.payload.user_id) ? p : [...p, { id: msg.payload.user_id, name: msg.payload.name || msg.payload.user_id }]);
          }
          break;
        case 'voice_leave':
          setVoiceMembers(p => p.filter(m => m.id !== msg.payload?.user_id));
          setSpeaking(p => { const n = { ...p }; delete n[msg.payload?.user_id]; return n; });
          break;
        case 'new_producer':
          if (msg.payload?.source === 'system' && msg.payload.peerId !== myId) {
            setSystemAudioPeers(p => ({ ...p, [msg.payload.peerId]: true }));
          }
          if (inVoiceRef.current && msg.payload?.peerId !== myId) {
            consumeProducer(msg.payload.producerId, msg.payload.peerId);
          }
          break;
        case 'producer_closed':
          if (msg.payload?.source === 'system' && msg.payload.peerId) {
            setSystemAudioPeers(p => { const n = { ...p }; delete n[msg.payload.peerId]; return n; });
          }
          break;
        case 'system_audio_start':
          if (msg.payload?.user_id && msg.payload.user_id !== myId) {
            setSystemAudioPeers(p => ({ ...p, [msg.payload.user_id]: true }));
          }
          break;
        case 'system_audio_stop':
          if (msg.payload?.user_id) {
            setSystemAudioPeers(p => { const n = { ...p }; delete n[msg.payload.user_id]; return n; });
          }
          break;
        case 'consumer_closed': {
          const c = consumersRef.current[msg.payload?.consumerId];
          if (c) { c._audioEl?.pause(); c.close(); delete consumersRef.current[msg.payload.consumerId]; }
          break;
        }
      }
    };
    return onEvent(handler);
  }, [onEvent, myId, consumeProducer]);

  // Cleanup on unmount
  useEffect(() => () => { if (inVoiceRef.current) leaveVoice(); }, [leaveVoice]);

  return {
    inVoice,
    voiceMembers,
    isMuted,
    speaking,
    peerPings,
    isSystemAudio,
    systemAudioPeers,
    joinVoice,
    leaveVoice,
    toggleMute,
    startSystemAudio,
    stopSystemAudio,
  };
}
