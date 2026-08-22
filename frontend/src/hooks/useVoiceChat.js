import { useRef, useState, useCallback, useEffect } from 'react';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * useVoiceChat — WebRTC mesh audio chat hook
 *
 * @param {object} opts
 * @param {string}   opts.roomId
 * @param {string}   opts.myId
 * @param {function} opts.sendMessage   — WS sendMessage
 * @param {boolean}  opts.wsConnected
 */
export function useVoiceChat({ roomId, myId, sendMessage, wsConnected }) {
  // ── State ─────────────────────────────────────────────────────────────────
  const [inVoice, setInVoice] = useState(false);          // joined voice chat
  const [micMuted, setMicMuted] = useState(false);        // local mic muted
  const [deafened, setDeafened] = useState(false);        // all remote audio muted
  const [speaking, setSpeaking] = useState({});           // userId → bool (VAD)
  const [voiceMembers, setVoiceMembers] = useState([]);   // userIds in voice
  const [audioDevices, setAudioDevices] = useState({ inputs: [], outputs: [] });
  const [selectedInput, setSelectedInput] = useState(() => localStorage.getItem('sw_voice_input') || '');
  const [selectedOutput, setSelectedOutput] = useState(() => localStorage.getItem('sw_voice_output') || '');
  const [inputLevel, setInputLevel] = useState(0);        // 0-100 mic level meter
  const [isSystemAudio, setIsSystemAudio] = useState(false);
  const [systemAudioPeers, setSystemAudioPeers] = useState({});   // peerId → bool

  // Audio processing settings — persisted in localStorage.sw_voice_settings
  const [audioSettings, setAudioSettings] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('sw_voice_settings') || 'null');
      if (saved && typeof saved === 'object') return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, gain: 1.0, vadThreshold: 15, ...saved };
    } catch {}
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, gain: 1.0, vadThreshold: 15 };
  });

  useEffect(() => { localStorage.setItem('sw_voice_settings', JSON.stringify(audioSettings)); }, [audioSettings]);
  useEffect(() => { if (selectedInput) localStorage.setItem('sw_voice_input', selectedInput); }, [selectedInput]);
  useEffect(() => { if (selectedOutput) localStorage.setItem('sw_voice_output', selectedOutput); }, [selectedOutput]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const inVoiceRef = useRef(false);
  useEffect(() => { inVoiceRef.current = inVoice; }, [inVoice]);
  const localStreamRef = useRef(null);
  const peerConnsRef = useRef({});          // peerId → RTCPeerConnection
  const remoteAudiosRef = useRef({});       // peerId → HTMLAudioElement
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);         // local mic analyser
  const gainNodeRef = useRef(null);         // local mic GainNode
  const vadTimerRef = useRef(null);
  const levelTimerRef = useRef(null);
  const pendingOffersRef = useRef({});      // peerId → queued ICE candidates
  const remoteVADRef = useRef({});          // peerId → { analyser, timer }
  const audioSettingsRef = useRef(audioSettings);
  useEffect(() => { audioSettingsRef.current = audioSettings; }, [audioSettings]);
  const sysAudioStreamRef = useRef(null);
  const sysAudioTrackRef = useRef(null);
  const isSystemAudioRef = useRef(false);

  // ── Enumerate devices ─────────────────────────────────────────────────────
  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');
      setAudioDevices({ inputs, outputs });
      if (inputs.length && !selectedInput) setSelectedInput(inputs[0].deviceId);
      if (outputs.length && !selectedOutput) setSelectedOutput(outputs[0].deviceId);
    } catch (e) {
      console.warn('enumerateDevices:', e);
    }
  }, [selectedInput, selectedOutput]);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  // ── Ensure AudioContext is ready ───────────────────────────────────────────
  const ensureAudioCtx = useCallback(() => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Chrome suspends AudioContext until user interaction; resume it so VAD works
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }, []);

  // ── Local VAD + level meter ────────────────────────────────────────────────
  const startVAD = useCallback((stream) => {
    try {
      const ctx = ensureAudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;

      // GainNode for mic amplification
      const gain = ctx.createGain();
      gain.gain.value = audioSettingsRef.current.gain;
      gainNodeRef.current = gain;

      source.connect(gain);
      gain.connect(analyser);
      analyserRef.current = analyser;

      const buf = new Uint8Array(analyser.frequencyBinCount);

      // Level meter — 60fps
      levelTimerRef.current = setInterval(() => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
        setInputLevel(Math.min(100, Math.round(avg * 2)));
      }, 16);

      // VAD — 100ms
      vadTimerRef.current = setInterval(() => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
        const isSpeaking = avg > audioSettingsRef.current.vadThreshold;
        setSpeaking(prev => {
          if (prev[myId] === isSpeaking) return prev;
          return { ...prev, [myId]: isSpeaking };
        });
      }, 100);
    } catch (e) {
      console.warn('VAD init error:', e);
    }
  }, [myId, ensureAudioCtx]);

  const stopVAD = useCallback(() => {
    clearInterval(levelTimerRef.current);
    clearInterval(vadTimerRef.current);
    setInputLevel(0);
    setSpeaking(prev => { const n = { ...prev }; delete n[myId]; return n; });
    gainNodeRef.current = null;
    analyserRef.current = null;
  }, [myId]);

  // ── Remote VAD — detect speaking from incoming audio streams ──────────────
  const startRemoteVAD = useCallback((peerId, stream) => {
    try {
      const ctx = ensureAudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      const timer = setInterval(() => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
        const isSpeaking = avg > audioSettingsRef.current.vadThreshold;
        setSpeaking(prev => {
          if (prev[peerId] === isSpeaking) return prev;
          return { ...prev, [peerId]: isSpeaking };
        });
      }, 120);

      remoteVADRef.current[peerId] = { analyser, timer, source };
    } catch (e) {
      console.warn('Remote VAD init error:', e);
    }
  }, [ensureAudioCtx]);

  const stopRemoteVAD = useCallback((peerId) => {
    const entry = remoteVADRef.current[peerId];
    if (!entry) return;
    clearInterval(entry.timer);
    try { entry.source.disconnect(); } catch {}
    delete remoteVADRef.current[peerId];
    setSpeaking(prev => { const n = { ...prev }; delete n[peerId]; return n; });
  }, []);

  // ── Create peer connection ─────────────────────────────────────────────────
  const createPeerConn = useCallback((peerId, isInitiator) => {
    if (peerConnsRef.current[peerId]) return peerConnsRef.current[peerId];

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnsRef.current[peerId] = pc;
    pendingOffersRef.current[peerId] = [];

    // Add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendMessage({
          type: 'voice_ice',
          payload: { candidate: e.candidate, from: myId, target: peerId },
          timestamp: Date.now(),
        });
      }
    };

    // Remote audio track
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;

      // Create or reuse audio element for playback
      let audio = remoteAudiosRef.current[peerId];
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        remoteAudiosRef.current[peerId] = audio;
      }
      audio.srcObject = stream;
      if (selectedOutput && audio.setSinkId) {
        audio.setSinkId(selectedOutput).catch(() => {});
      }
      // Explicit play() because Chrome may ignore autoplay on dynamically assigned srcObject
      audio.play().catch(() => {});

      // Run VAD on the incoming stream to detect remote speaking
      stopRemoteVAD(peerId);
      startRemoteVAD(peerId, stream);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        closePeerConn(peerId);
        if (inVoiceRef.current && localStreamRef.current) {
          // Deterministic initiator: lower ID restarts to avoid both sides reconnecting simultaneously
          const shouldInitiate = myId < peerId;
          setTimeout(() => createPeerConn(peerId, shouldInitiate), 1000);
        }
      } else if (pc.iceConnectionState === 'disconnected') {
        setTimeout(() => {
          const current = peerConnsRef.current[peerId];
          if (current && current.iceConnectionState === 'disconnected') {
            closePeerConn(peerId);
            if (inVoiceRef.current && localStreamRef.current) {
              const shouldInitiate = myId < peerId;
              createPeerConn(peerId, shouldInitiate);
            }
          }
        }, 5000);
      }
    };

    if (isInitiator) {
      pc.createOffer({ offerToReceiveAudio: true })
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
          sendMessage({
            type: 'voice_offer',
            payload: { sdp: pc.localDescription.sdp, from: myId, target: peerId },
            timestamp: Date.now(),
          });
        })
        .catch(console.error);
    }

    return pc;
  }, [myId, sendMessage, selectedOutput, startRemoteVAD, stopRemoteVAD]); // eslint-disable-line react-hooks/exhaustive-deps

  const closePeerConn = useCallback((peerId) => {
    const pc = peerConnsRef.current[peerId];
    if (pc) { try { pc.close(); } catch {} delete peerConnsRef.current[peerId]; }
    const audio = remoteAudiosRef.current[peerId];
    if (audio) { audio.srcObject = null; delete remoteAudiosRef.current[peerId]; }
    stopRemoteVAD(peerId);
    setSpeaking(prev => { const n = { ...prev }; delete n[peerId]; return n; });
    setPeerVolumes(prev => { const n = { ...prev }; delete n[peerId]; return n; });
    setVoiceMembers(prev => prev.filter(id => id !== peerId));
  }, [stopRemoteVAD]);

  // ── Build getUserMedia constraints from current settings ───────────────────
  const buildConstraints = useCallback((deviceId, settings) => ({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    },
    video: false,
  }), []);

  // ── Join voice ─────────────────────────────────────────────────────────────
  const joinVoice = useCallback(async (deviceId) => {
    if (inVoice) return;
    try {
      const settings = audioSettingsRef.current;
      const stream = await navigator.mediaDevices.getUserMedia(
        buildConstraints(deviceId || selectedInput, settings)
      );
      localStreamRef.current = stream;
      inVoiceRef.current = true; // set synchronously before sendMessage so voice_offer handler is ready immediately
      setInVoice(true);
      setMicMuted(false);
      startVAD(stream);

      sendMessage({
        type: 'voice_join',
        room_id: roomId,
        payload: { from: myId },
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('joinVoice error:', err);
      throw err;
    }
  }, [inVoice, roomId, myId, sendMessage, startVAD, buildConstraints, selectedInput]);

  // ── Leave voice ────────────────────────────────────────────────────────────
  const leaveVoice = useCallback(() => {
    if (!inVoice) return;

    // Stop local stream
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;

    // Close all peer connections + remote VADs
    Object.keys(peerConnsRef.current).forEach(closePeerConn);

    // Stop all remote VADs (cleanup any leftovers)
    Object.keys(remoteVADRef.current).forEach(stopRemoteVAD);

    stopVAD();
    inVoiceRef.current = false; // set synchronously before sendMessage
    setInVoice(false);
    setMicMuted(false);
    setVoiceMembers([]);

    sendMessage({
      type: 'voice_leave',
      room_id: roomId,
      payload: { from: myId },
      timestamp: Date.now(),
    });
  }, [inVoice, roomId, myId, sendMessage, closePeerConn, stopVAD, stopRemoteVAD]);

  // ── Toggle mic ─────────────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (!localStreamRef.current) return;
    const enabled = !micMuted;
    localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = enabled; });
    setMicMuted(!enabled);
  }, [micMuted]);

  // ── Toggle deafen ──────────────────────────────────────────────────────────
  const toggleDeafen = useCallback(() => {
    const next = !deafened;
    setDeafened(next);
    Object.values(remoteAudiosRef.current).forEach(audio => { audio.muted = next; });
  }, [deafened]);

  // ── Change input device ────────────────────────────────────────────────────
  const changeInputDevice = useCallback(async (deviceId) => {
    setSelectedInput(deviceId);
    if (!inVoice) return;
    try {
      const settings = audioSettingsRef.current;
      const newStream = await navigator.mediaDevices.getUserMedia(
        buildConstraints(deviceId, settings)
      );
      const newTrack = newStream.getAudioTracks()[0];

      // Replace track in all peer connections
      Object.values(peerConnsRef.current).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) sender.replaceTrack(newTrack).catch(console.error);
      });

      // Stop old stream, use new one
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      localStreamRef.current = newStream;

      stopVAD();
      startVAD(newStream);
    } catch (e) {
      console.error('changeInputDevice:', e);
    }
  }, [inVoice, buildConstraints, startVAD, stopVAD]);

  // ── Change output device ───────────────────────────────────────────────────
  const changeOutputDevice = useCallback((deviceId) => {
    setSelectedOutput(deviceId);
    Object.values(remoteAudiosRef.current).forEach(audio => {
      if (audio.setSinkId) audio.setSinkId(deviceId).catch(() => {});
    });
  }, []);

  // ── Change audio processing settings ──────────────────────────────────────
  const changeAudioSettings = useCallback(async (newSettings) => {
    setAudioSettings(prev => ({ ...prev, ...newSettings }));

    // Apply gain change immediately without re-capturing mic
    if (newSettings.gain !== undefined && gainNodeRef.current) {
      gainNodeRef.current.gain.value = newSettings.gain;
    }

    // If echo/noise/AGC settings changed and in voice, re-capture mic with new constraints
    const processingChanged = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
      .some(k => newSettings[k] !== undefined);

    if (processingChanged && inVoice) {
      try {
        const merged = { ...audioSettingsRef.current, ...newSettings };
        const newStream = await navigator.mediaDevices.getUserMedia(
          buildConstraints(selectedInput, merged)
        );
        const newTrack = newStream.getAudioTracks()[0];
        Object.values(peerConnsRef.current).forEach(pc => {
          const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
          if (sender) sender.replaceTrack(newTrack).catch(console.error);
        });
        localStreamRef.current?.getTracks().forEach(t => t.stop());
        localStreamRef.current = newStream;
        stopVAD();
        startVAD(newStream);
      } catch (e) {
        console.error('changeAudioSettings re-capture failed:', e);
      }
    }
  }, [inVoice, selectedInput, buildConstraints, startVAD, stopVAD]);

  // ── System audio (WASAPI loopback — Electron desktop only) ─────────────────
  const startSystemAudio = useCallback(async () => {
    if (isSystemAudioRef.current) return;
    try {
      if (!window.electronAPI?.getSystemAudioSourceId) {
        console.warn('[Voice] System audio requires the Electron desktop app');
        return;
      }
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

      sysAudioStreamRef.current = stream;
      sysAudioTrackRef.current = audioTrack;

      // Mix into the local mic stream so it flows to peers as a single audio source,
      // and add the track to any already-established peer connections.
      if (localStreamRef.current) localStreamRef.current.addTrack(audioTrack);
      for (const [peerId, pc] of Object.entries(peerConnsRef.current)) {
        try { pc.addTrack(audioTrack, localStreamRef.current || stream); } catch (e) { console.warn('[Voice] addTrack error:', e); }
        // Renegotiate on the deterministic-initiator side so the new track is sent.
        if (myId < peerId) {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendMessage({ type: 'voice_offer', payload: { sdp: pc.localDescription.sdp, from: myId, target: peerId }, timestamp: Date.now() });
          } catch (e) { console.warn('[Voice] renegotiate error:', e); }
        }
      }

      isSystemAudioRef.current = true;
      setIsSystemAudio(true);
      sendMessage({ type: 'system_audio_start', room_id: roomId, payload: { from: myId }, timestamp: Date.now() });
    } catch (e) {
      console.error('[Voice] startSystemAudio error:', e);
    }
  }, [roomId, myId, sendMessage]);

  const stopSystemAudio = useCallback(() => {
    if (!isSystemAudioRef.current) return;
    const track = sysAudioTrackRef.current;
    if (track) {
      track.stop();
      try { localStreamRef.current?.removeTrack(track); } catch {}
      for (const pc of Object.values(peerConnsRef.current)) {
        const sender = pc.getSenders().find(s => s.track === track);
        if (sender) { try { pc.removeTrack(sender); } catch {} }
      }
    }
    sysAudioStreamRef.current?.getTracks().forEach(t => t.stop());
    sysAudioStreamRef.current = null;
    sysAudioTrackRef.current = null;
    isSystemAudioRef.current = false;
    setIsSystemAudio(false);
    sendMessage({ type: 'system_audio_stop', room_id: roomId, payload: { from: myId }, timestamp: Date.now() });
  }, [roomId, myId, sendMessage]);

  // ── Per-peer volume ───────────────────────────────────────────────────────
  const [peerVolumes, setPeerVolumes] = useState({});  // peerId → 0-1

  const setPeerVolume = useCallback((peerId, vol) => {
    const v = Math.max(0, Math.min(1, vol));
    const audio = remoteAudiosRef.current[peerId];
    if (audio) audio.volume = v;
    setPeerVolumes(prev => ({ ...prev, [peerId]: v }));
  }, []);

  // ── Peer RTT ping measurement ─────────────────────────────────────────────
  const [peerPings, setPeerPings] = useState({});  // peerId → ms
  const pingTimerRef = useRef(null);

  const pollPings = useCallback(async () => {
    const newPings = {};
    for (const [peerId, pc] of Object.entries(peerConnsRef.current)) {
      try {
        const stats = await pc.getStats();
        let bestRtt = null;
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.nominated && report.currentRoundTripTime != null) {
            const rtt = Math.round(report.currentRoundTripTime * 1000);
            if (bestRtt === null || rtt < bestRtt) bestRtt = rtt;
          }
        });
        if (bestRtt !== null) newPings[peerId] = bestRtt;
      } catch {}
    }
    setPeerPings(newPings);
  }, []);

  useEffect(() => {
    if (!inVoice) {
      clearInterval(pingTimerRef.current);
      setPeerPings({});
      return;
    }
    pingTimerRef.current = setInterval(pollPings, 2000);
    return () => clearInterval(pingTimerRef.current);
  }, [inVoice, pollPings]);

  // ── Handle incoming WS messages ────────────────────────────────────────────
  const handleVoiceMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'voice_join': {
        const peerId = msg.payload?.from || msg.user_id;
        if (!peerId || peerId === myId) break;
        setVoiceMembers(prev => prev.includes(peerId) ? prev : [...prev, peerId]);
        if (inVoice) {
          // We are already in voice — initiate connection to new joiner
          createPeerConn(peerId, true);
        }
        break;
      }
      case 'voice_state': {
        // Received on join — contains list of members already in voice.
        // Do NOT initiate connections here: existing members will receive the
        // voice_join broadcast and initiate to us. Initiating from both sides
        // simultaneously causes WebRTC glare (setRemoteDescription in wrong state).
        const members = msg.payload?.members || [];
        members.forEach(({ user_id }) => {
          if (!user_id || user_id === myId) return;
          setVoiceMembers(prev => prev.includes(user_id) ? prev : [...prev, user_id]);
        });
        break;
      }
      case 'voice_leave': {
        const peerId = msg.payload?.from || msg.user_id;
        if (peerId) {
          setVoiceMembers(prev => prev.filter(id => id !== peerId));
          closePeerConn(peerId);
        }
        break;
      }
      case 'voice_offer': {
        const { sdp, from } = msg.payload || {};
        // Use ref instead of state to avoid stale-closure false-negatives on fast join
        if (!from || !sdp || !inVoiceRef.current) break;
        const pc = createPeerConn(from, false);
        pc.setRemoteDescription({ type: 'offer', sdp })
          .then(() => pc.createAnswer())
          .then(answer => pc.setLocalDescription(answer))
          .then(() => {
            sendMessage({
              type: 'voice_answer',
              payload: { sdp: pc.localDescription.sdp, from: myId, target: from },
              timestamp: Date.now(),
            });
            // Flush queued ICE candidates
            (pendingOffersRef.current[from] || []).forEach(c => pc.addIceCandidate(c).catch(() => {}));
            pendingOffersRef.current[from] = [];
          })
          .catch(console.error);
        break;
      }
      case 'voice_answer': {
        const { sdp, from } = msg.payload || {};
        if (!from || !sdp) break;
        const pc = peerConnsRef.current[from];
        if (pc) pc.setRemoteDescription({ type: 'answer', sdp }).catch(console.error);
        break;
      }
      case 'voice_ice': {
        const { candidate, from } = msg.payload || {};
        if (!from || !candidate) break;
        const pc = peerConnsRef.current[from];
        if (pc && pc.remoteDescription) {
          pc.addIceCandidate(candidate).catch(() => {});
        } else {
          // Queue until remote description is set
          if (!pendingOffersRef.current[from]) pendingOffersRef.current[from] = [];
          pendingOffersRef.current[from].push(candidate);
        }
        break;
      }
      case 'system_audio_start': {
        const peerId = msg.payload?.from || msg.user_id;
        if (peerId && peerId !== myId) setSystemAudioPeers(p => ({ ...p, [peerId]: true }));
        break;
      }
      case 'system_audio_stop': {
        const peerId = msg.payload?.from || msg.user_id;
        if (peerId) setSystemAudioPeers(p => { const n = { ...p }; delete n[peerId]; return n; });
        break;
      }
      default:
        break;
    }
  }, [myId, createPeerConn, closePeerConn, sendMessage]); // inVoice removed: voice_offer uses inVoiceRef.current to avoid stale closure

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      leaveVoice();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    // State
    inVoice,
    micMuted,
    deafened,
    speaking,
    voiceMembers,
    audioDevices,
    selectedInput,
    selectedOutput,
    inputLevel,
    audioSettings,
    peerPings,
    peerVolumes,
    isSystemAudio,
    systemAudioPeers,
    // Actions
    joinVoice,
    leaveVoice,
    toggleMic,
    toggleDeafen,
    changeInputDevice,
    changeOutputDevice,
    changeAudioSettings,
    refreshDevices,
    handleVoiceMessage,
    setPeerVolume,
    startSystemAudio,
    stopSystemAudio,
  };
}
