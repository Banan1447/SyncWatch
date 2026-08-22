import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useTheme } from '../contexts/ThemeContext.jsx';
import { useWebSocket } from '../hooks/useWebSocket.js';
import VideoPlayer from '../components/VideoPlayer.jsx';
import { useVoiceChat } from '../hooks/useVoiceChat.js';
import useSFUVoice from '../hooks/useSFUVoice.js';
import { useTranslation } from 'react-i18next';
const PlayerTabs = lazy(() => import('./PlayerTabs.jsx'));

const API = '/api/v1';
const WS_BASE = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
})();

const TABS = ['video', 'queue', 'chat', 'voice', 'doomscroll'];

// WebRTC ICE servers for screen-share P2P (same pattern as Discord Go Live)
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const STREAM_QUALITY_MAP = {
  '480p30':  { width: 854,  height: 480,  frameRate: 30, maxBitrate: 1_500_000 },
  '480p60':  { width: 854,  height: 480,  frameRate: 60, maxBitrate: 2_500_000 },
  '720p30':  { width: 1280, height: 720,  frameRate: 30, maxBitrate: 2_500_000 },
  '720p60':  { width: 1280, height: 720,  frameRate: 60, maxBitrate: 4_000_000 },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, maxBitrate: 5_000_000 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
  '1440p30': { width: 2560, height: 1440, frameRate: 30, maxBitrate: 10_000_000 },
  '1440p60': { width: 2560, height: 1440, frameRate: 60, maxBitrate: 16_000_000 },
  '4k30':    { width: 3840, height: 2160, frameRate: 30, maxBitrate: 20_000_000 },
  '4k60':    { width: 3840, height: 2160, frameRate: 60, maxBitrate: 35_000_000 },
};

// base64 helpers for server-relayed broadcast chunks
const b64ToUint8 = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const uint8ToB64 = (bytes) => {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
};
const concatU8 = (a, b) => {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
};
// webm Cluster element ID is 0x1F43B675 — the init segment (EBML header +
// Segment + Info + Tracks) ends right before the first Cluster. MediaRecorder
// writes that header lazily and may split it across the first few dataavailable
// events, so we must accumulate until the first Cluster to send a complete init.
const findClusterIndex = (bytes) => {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x1F && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xB6 && bytes[i + 3] === 0x75) return i;
  }
  return -1;
};
const blobToB64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onloadend = () => res(r.result?.split(',')[1] || '');
  r.onerror = rej;
  r.readAsDataURL(blob);
});
// Pick a MediaRecorder mime based on whether the stream actually has audio
// (screen share without "share audio" yields a video-only stream; a vp8+opus
// mime on a video-only stream breaks MSE playback on the viewer).
const pickRecorderMime = (stream) => {
  const hasAudio = stream.getAudioTracks().length > 0;
  const candidates = hasAudio
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8', 'video/webm']
    : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  return candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
};

// MediaRecorder timeslice for the server-relayed broadcast. Smaller = lower
// end-to-end latency (a chunk is emitted this often). 120ms ≈ 8 chunks/s —
// low latency without excessive WS message overhead.
const STREAM_CHUNK_MS = 120;

// Low-latency playback: if the viewer's buffer grows beyond this (seconds), we
// briefly speed up playback to drain it and stay near the live edge.
const STREAM_MAX_BUFFER_S = 1.5;
const STREAM_CATCHUP_RATE = 1.12;

// Sites that need server-side embed extraction
const EMBED_SITES = /animego\.me|animestars\.|animevost\.|anilibria\.tv|shikimori\.|myanimelist\.net|jut\.su|anime365\.|smotret-anime\.|aniwave\.|gogoanime\.|rezka\.|filmix\.|kinopub\.|serials\.online/i;

// Direct embed hosts (can be iframed directly)
const EMBED_HOSTS = /kodik\.(biz|info)|alloha\.tv|ashdi\.vip|moonwalk\.|sibnet\.ru\/video/i;

function getYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function getItemThumbnail(item) {
  if (item.thumbnail_url) return item.thumbnail_url;
  if (item.video_metadata?.thumbnail_url) return item.video_metadata.thumbnail_url;
  if (item.video_source === 'youtube' || item.type === 'youtube') {
    const ytId = getYouTubeId(item.video_url || item.src);
    if (ytId) return `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`;
  }
  return null;
}

function detectVideoType(url) {
  if (!url) return 'direct';
  if (/twitch\.tv\//.test(url)) return 'twitch';
  if (/youtu\.be\/|youtube\.com\/(watch|embed|shorts|live)/.test(url)) return 'youtube';
  if (/\.m3u8(\?|$)/.test(url)) return 'hls';
  if (EMBED_HOSTS.test(url)) return 'embed';
  if (EMBED_SITES.test(url)) return 'embed_extract'; // needs backend extraction
  // Direct media files → native player (no extraction)
  if (/\.(mp4|webm|ogv|mov|m4v|mkv|avi|flv|mp3|flac|wav|ogg)(\?|#|$)/i.test(url)) return 'direct';
  // Any other http(s) page → backend extraction (oEmbed / og:video / iframe, w2g-style)
  if (/^https?:\/\//i.test(url)) return 'embed_extract';
  return 'direct';
}

// Extract a Twitch channel name from a twitch.tv URL (live) or a VOD id.
function getTwitchChannel(url) {
  if (!url) return null;
  const m = url.match(/twitch\.tv\/(?:videos\/)?([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

export default function Player() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user, token, loading: authLoading } = useAuth();
  const { theme, themes, setTheme } = useTheme();
  const { t, i18n } = useTranslation(['common', 'player']);

  const [room, setRoom] = useState(null);
  const [members, setMembers] = useState([]);
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('sw_tab') || 'video');
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [achievementToast, setAchievementToast] = useState(null); // {id, name, icon}
  const achievementToastTimerRef = useRef(null);
  const [isFavorite, setIsFavorite] = useState(false);
  const [favLoading, setFavLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('sw_sidebar') !== 'false');
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const h = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  const [needsInteraction, setNeedsInteraction] = useState(false);
  const [syncState, setSyncState] = useState(null);
  const [allSynced, setAllSynced] = useState(false);
  const [syncCount, setSyncCount] = useState({ ready: 0, total: 0 });
  const [joinSyncBlocked, setJoinSyncBlocked] = useState(false);
  const [joiningUsername, setJoiningUsername] = useState('');
  const joinSyncTimeoutRef = useRef(null);
  const [initialState, setInitialState] = useState(null);

  // Queue
  const [queue, setQueue] = useState([]);
  const [currentVideo, setCurrentVideo] = useState(null);
  const [addVideoUrl, setAddVideoUrl] = useState('');
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueSearch, setQueueSearch] = useState('');
  const dragItemRef = useRef(null);
  const dragOverItemRef = useRef(null);

  // Stream cache
  const [cacheJobs, setCacheJobs] = useState({}); // id → job

  // Upload
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const pendingHlsVideoIdRef = useRef(null);
  const [hostUploadNotif, setHostUploadNotif] = useState(null);
  const [prebufferState, setPrebufferState] = useState(null); // {pct,loaded,total,done,error}
  const prebufferEsRef = useRef(null);

  // Transcoder notifications
  const [transcodeToast, setTranscodeToast] = useState(null); // {msg, type}

  // Voice settings modal
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  // Probe refs — track current playback position and playing state without re-renders
  const currentTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const syncStateRef = useRef(null);
  const [driftUs, setDriftUs] = useState(null); // signed drift vs server adjusted_time, in microseconds

  // Chat
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatUploading, setChatUploading] = useState(false);
  const [typingUsers, setTypingUsers] = useState({}); // username → timestamp ms
  const typingDebounceRef = useRef(null);
  const chatEndRef = useRef(null);
  const chatFileRef = useRef(null);

  // Direct messages
  const [dmOpen, setDmOpen] = useState(false);
  const [dmWith, setDmWith] = useState(null); // { user_id, username }
  const [dmMessages, setDmMessages] = useState([]);
  const [dmInput, setDmInput] = useState('');
  const [dmLoading, setDmLoading] = useState(false);
  const dmEndRef = useRef(null);
  const dmWithRef = useRef(null);
  useEffect(() => { dmWithRef.current = dmWith; }, [dmWith]);
  useEffect(() => { if (dmOpen && dmEndRef.current) dmEndRef.current.scrollIntoView(); }, [dmMessages, dmOpen]);

  // Username
  const username = user?.username || localStorage.getItem('ws_username') || 'Зритель';

  // Invite copy
  const [copied, setCopied] = useState(false);

  // Per-room sync thresholds (owner can adjust; applied to VideoPlayer)
  const [syncSettings, setSyncSettings] = useState({ soft_threshold: 0.5, hard_threshold: 4 });

  // Sidebar resizable width
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const w = parseInt(localStorage.getItem('sw_sidebar_w'));
    return (w >= 240 && w <= 480) ? w : 300;
  });
  const sidebarResizing = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartW = useRef(0);

  const onSidebarMouseDown = useCallback((e) => {
    sidebarResizing.current = true;
    sidebarStartX.current = e.clientX;
    sidebarStartW.current = sidebarWidth;
    e.preventDefault();
  }, [sidebarWidth]);

  useEffect(() => {
    const onMove = (e) => {
      if (!sidebarResizing.current) return;
      const delta = sidebarStartX.current - e.clientX; // drag left = wider
      const newW = Math.max(240, Math.min(480, sidebarStartW.current + delta));
      setSidebarWidth(newW);
    };
    const onUp = () => {
      if (sidebarResizing.current) {
        sidebarResizing.current = false;
        localStorage.setItem('sw_sidebar_w', String(sidebarWidth));
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [sidebarWidth]);

  // Accordion sections state
  const [openSections, setOpenSections] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sw_sections') || '{"add":true,"current":true,"stream":false,"sync":false,"members":false}'); }
    catch { return { add: true, current: true, stream: false, sync: false, members: false }; }
  });
  const toggleSection = useCallback((key) => {
    setOpenSections(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('sw_sections', JSON.stringify(next));
      return next;
    });
  }, []);

  // Proxy mode
  const [proxyMode, setProxyMode] = useState(false);
  const [proxyLoading, setProxyLoading] = useState(false);
  const originalVideoRef = useRef(null);
  const autoPlayingRef = useRef(false); // survives WS-initiated initialState clear

  // Anime parser modal
  const [animeOpen, setAnimeOpen] = useState(false);
  const [animeQuery, setAnimeQuery] = useState('');
  const [animeSource, setAnimeSource] = useState(() => localStorage.getItem('sw_anime_source') || 'animego');
  const [animeCookies, setAnimeCookies] = useState(() => localStorage.getItem('sw_animego_cookies') || '');
  const [animeResults, setAnimeResults] = useState([]);
  const [animeSearching, setAnimeSearching] = useState(false);
  const [animeSelected, setAnimeSelected] = useState(null); // {title, url, poster, seasons, episodes, players}
  const [animeParsing, setAnimeParsing] = useState(false);
  const [animeSeason, setAnimeSeason] = useState(null);
  const [animeEpisode, setAnimeEpisode] = useState(null);
  const [animePlayers, setAnimePlayers] = useState([]); // available iframes for selected episode
  const [animePlayer, setAnimePlayer] = useState(null); // selected player iframe
  const [animeStreams, setAnimeStreams] = useState([]);
  const [animeExtracting, setAnimeExtracting] = useState(false);
  const [animeError, setAnimeError] = useState('');

  // Subtitle extraction
  const [subExtractOpen, setSubExtractOpen] = useState(false);
  const [subStreamIndex, setSubStreamIndex] = useState(0);
  const [subFormat, setSubFormat] = useState('srt');
  const [transcodeOpen, setTranscodeOpen] = useState(false);
  const [transcodeQuality, setTranscodeQuality] = useState(50); // 0=best(HLS adaptive) 50=1080p 100=720p fastest
  const [transcodeLoading, setTranscodeLoading] = useState(false);
  const [subLoading, setSubLoading] = useState(false);
  const [subResult, setSubResult] = useState(null); // { url, filename, format }

  // Broadcast — WebRTC P2P (broadcaster creates one RTCPeerConnection per viewer)
  const [localStream, setLocalStream] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [streamType, setStreamType] = useState(null); // 'screen' | 'camera'
  const [activeBroadcaster, setActiveBroadcaster] = useState(null); // { user_id, username, stream_type } | null
  const [viewerStream, setViewerStream] = useState(null); // received MediaStream (viewer side, P2P fallback)
  const [viewerMseUrl, setViewerMseUrl] = useState(null); // MSE object URL (server-relayed broadcast)
  const [streamMuted, setStreamMuted] = useState(true);   // viewer-side stream audio (starts muted per autoplay policy)
  const [streamVolume, setStreamVolume] = useState(1);    // viewer-side stream volume 0-1
  const streamVideoRef = useRef(null);
  // Sync muted/volume to DOM element whenever state changes (ref callback only fires on mount)
  useEffect(() => {
    const vid = streamVideoRef.current;
    if (!vid) return;
    vid.muted = streamMuted;
    vid.volume = streamVolume;
  }, [streamMuted, streamVolume]);
  const [previewVisible, setPreviewVisible] = useState(() => localStorage.getItem('sw_preview_show') === '1');
  const [previewPos, setPreviewPos] = useState(() => { try { return JSON.parse(localStorage.getItem('sw_preview_pos')); } catch { return null; } });
  const previewElRef = useRef(null);
  const previewDragRef = useRef(null);
  const [streamQuality, setStreamQuality] = useState(() => localStorage.getItem('sw_stream_quality') || '1080p30');
  const streamQualityRef = useRef(streamQuality);
  useEffect(() => {
    streamQualityRef.current = streamQuality;
    localStorage.setItem('sw_stream_quality', streamQuality);
    // Dynamic quality change without reoffer when actively streaming
    if (!screenStreamRef.current) return;
    const q = STREAM_QUALITY_MAP[streamQuality] || STREAM_QUALITY_MAP['1080p30'];
    const videoTrack = screenStreamRef.current.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } }).catch(() => {});
    }
    broadcastVideoSendersRef.current.forEach(sender => {
      const params = sender.getParameters();
      if (params.encodings?.length) {
        params.encodings[0].maxBitrate = q.maxBitrate;
        params.encodings[0].maxFramerate = q.frameRate;
        sender.setParameters(params).catch(() => {});
      }
    });
  }, [streamQuality]);

  // ── Broadcast settings: bitrate, screen/app source, audio device ─────────────
  const [broadcastBitrate, setBroadcastBitrate] = useState(() => parseInt(localStorage.getItem('sw_broadcast_bitrate') || '2000000', 10));
  const broadcastBitrateRef = useRef(broadcastBitrate);
  useEffect(() => { broadcastBitrateRef.current = broadcastBitrate; localStorage.setItem('sw_broadcast_bitrate', String(broadcastBitrate)); }, [broadcastBitrate]);

  const [screenSources, setScreenSources] = useState([]);        // Electron: screens + windows
  const [broadcastSourceId, setBroadcastSourceId] = useState(() => localStorage.getItem('sw_broadcast_source') || '');
  const broadcastSourceIdRef = useRef(broadcastSourceId);
  useEffect(() => { broadcastSourceIdRef.current = broadcastSourceId; localStorage.setItem('sw_broadcast_source', broadcastSourceId); }, [broadcastSourceId]);

  const [broadcastAudioDevices, setBroadcastAudioDevices] = useState([]);          // microphones (input devices)
  const [broadcastAudioDevice, setBroadcastAudioDevice] = useState(() => localStorage.getItem('sw_broadcast_audio') || 'system');
  const broadcastAudioDeviceRef = useRef(broadcastAudioDevice);
  useEffect(() => { broadcastAudioDeviceRef.current = broadcastAudioDevice; localStorage.setItem('sw_broadcast_audio', broadcastAudioDevice); }, [broadcastAudioDevice]);

  useEffect(() => {
    // Electron: list screens + windows for the source picker
    if (window.electronAPI?.getScreenSources) {
      window.electronAPI.getScreenSources().then(list => setScreenSources(list || [])).catch(() => {});
    }
    // Audio input devices (microphones)
    if (navigator.mediaDevices?.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(devs => {
        setBroadcastAudioDevices(devs.filter(d => d.kind === 'audioinput' && d.deviceId).map(d => ({ id: d.deviceId, name: d.label || `Микрофон (${d.deviceId.slice(0, 6)})` })));
      }).catch(() => {});
    }
  }, []);

  const captureStreamRef = useRef(null);  // set by VideoPlayer — returns captureStream() of <video>
  const screenStreamRef = useRef(null);   // broadcaster: outgoing MediaStream
  const broadcastPCsRef = useRef({});     // broadcaster: { viewerId → RTCPeerConnection }
  const broadcastVideoSendersRef = useRef([]); // broadcaster: all active RTCRtpSenders for video track
  const viewerPCRef = useRef(null);       // viewer: connection to broadcaster
  const viewerICEQueueRef = useRef([]);   // viewer: ICE queue before remote desc is set
  const broadcastRecorderRef = useRef(null); // broadcaster: MediaRecorder for server-relayed chunks
  const broadcastMseRef = useRef(null);      // viewer: MediaSource for server-relayed broadcast
  const broadcastSourceBufferRef = useRef(null); // viewer: SourceBuffer
  const broadcastQueueRef = useRef([]);      // viewer: chunks queued while sourcebuffer busy
  const viewerMseUrlRef = useRef(null);      // viewer: MSE object URL (for revokeObjectURL cleanup)
  const broadcastMimeRef = useRef('video/webm;codecs=vp8,opus'); // codec advertised by broadcaster
  const streamingRef = useRef(false);     // mirrors `streaming` for stale closures
  const membersRef = useRef([]);          // mirrors `members` for stale closures
  useEffect(() => { streamingRef.current = streaming; }, [streaming]);
  useEffect(() => { membersRef.current = members; }, [members]);
  const activeBroadcasterRef = useRef(null); // mirrors activeBroadcaster for stale closures
  useEffect(() => { activeBroadcasterRef.current = activeBroadcaster; }, [activeBroadcaster]);

  // ── Stream latency diagnostics (server-relayed broadcast) ─────────────────
  const [streamLatency, setStreamLatency] = useState(null); // { delivery: ms, buffer: ms } | null
  const streamDeliveryRef = useRef(0);    // viewer: Date.now() - broadcaster chunk ts (ms)
  const streamSeqRef = useRef(0);         // viewer: last received chunk seq (gap detection)

  // Local recording (MediaRecorder API)
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const recordChunksRef = useRef([]);

  // Use real user UUID if authenticated; guests (is_guest=true) get a stable localStorage UUID
  const myId = (user?.id && !user?.is_guest) ? user.id : (() => {
    let gid = localStorage.getItem('ws_guest_id');
    if (!gid) {
      gid = crypto.randomUUID();
      localStorage.setItem('ws_guest_id', gid);
    }
    return gid;
  })();
  const isOwner = room?.owner_id === user?.id || room?.owner_id === myId;

  // ── Voice chat ────────────────────────────────────────────────────────────
  // useVoiceChat needs sendMessage which is defined later; use a ref to break the cycle
  const sendMessageRef = useRef(null);
  const sendMsgProxy = useCallback((msg) => sendMessageRef.current?.(msg), []);

  const [voiceMode, setVoiceMode] = useState(() => localStorage.getItem('sw_voice_mode') || 'p2p');
  const sfuListenersRef = useRef(new Set());
  const sfuOnEvent = useCallback((handler) => {
    sfuListenersRef.current.add(handler);
    return () => sfuListenersRef.current.delete(handler);
  }, []);

  const {
    inVoice, micMuted, deafened, speaking, voiceMembers, peerPings,
    peerVolumes, setPeerVolume,
    audioDevices, selectedInput, selectedOutput, inputLevel, audioSettings,
    joinVoice, leaveVoice, toggleMic, toggleDeafen,
    changeInputDevice, changeOutputDevice, changeAudioSettings, refreshDevices,
    handleVoiceMessage,
    isSystemAudio: p2pIsSystemAudio, systemAudioPeers: p2pSystemAudioPeers,
    startSystemAudio: p2pStartSystemAudio, stopSystemAudio: p2pStopSystemAudio,
  } = useVoiceChat({ roomId, myId, sendMessage: sendMsgProxy, wsConnected: false });

  const sfuVoice = useSFUVoice({ roomId, myId, token, sendMessage: sendMsgProxy, onEvent: sfuOnEvent });

  // Unified active voice interface (normalises P2P/SFU differences)
  const activeVoice = useMemo(() => {
    if (voiceMode === 'sfu') {
      return {
        inVoice: sfuVoice.inVoice,
        muted: sfuVoice.isMuted,
        deafened: false,
        speaking: sfuVoice.speaking,
        voiceMemberIds: sfuVoice.voiceMembers.map(m => m.id),
        peerPings: sfuVoice.peerPings,
        peerVolumes: {},
        setPeerVolume: () => {},
        join: sfuVoice.joinVoice,
        leave: sfuVoice.leaveVoice,
        toggleMic: sfuVoice.toggleMute,
        toggleDeafen: () => {},
        isSystemAudio: sfuVoice.isSystemAudio,
        systemAudioPeers: sfuVoice.systemAudioPeers,
        startSystemAudio: sfuVoice.startSystemAudio,
        stopSystemAudio: sfuVoice.stopSystemAudio,
      };
    }
    return {
      inVoice,
      muted: micMuted,
      deafened,
      speaking,
      voiceMemberIds: voiceMembers,
      peerPings,
      peerVolumes,
      setPeerVolume,
      join: () => joinVoice(selectedInput || undefined),
      leave: leaveVoice,
      toggleMic,
      toggleDeafen,
      isSystemAudio: p2pIsSystemAudio,
      systemAudioPeers: p2pSystemAudioPeers,
      startSystemAudio: p2pStartSystemAudio,
      stopSystemAudio: p2pStopSystemAudio,
    };
  }, [voiceMode, sfuVoice, inVoice, micMuted, deafened, speaking, voiceMembers, peerPings,
      peerVolumes, setPeerVolume, joinVoice, leaveVoice, toggleMic, toggleDeafen, selectedInput,
      p2pIsSystemAudio, p2pSystemAudioPeers, p2pStartSystemAudio, p2pStopSystemAudio]);

  const authHeaders = useCallback(() => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  const openDM = useCallback(async (targetId, targetUsername) => {
    if (!token || !targetId || targetId === myId) return;
    setDmWith({ user_id: targetId, username: targetUsername });
    setDmMessages([]);
    setDmOpen(true);
    setDmLoading(true);
    try {
      const res = await fetch(`/api/v1/dm/history?with=${encodeURIComponent(targetId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setDmMessages(Array.isArray(data) ? data : []);
      }
    } catch { /* ignore */ }
    setDmLoading(false);
  }, [token, myId]);

  const sendDM = useCallback((e) => {
    e.preventDefault();
    const cur = dmWithRef.current;
    if (!dmInput.trim() || !cur) return;
    sendMsgProxy({ type: 'dm_send', payload: { target_user_id: cur.user_id, content: dmInput.trim() }, timestamp: Date.now() });
    setDmInput('');
  }, [dmInput, sendMsgProxy]);

  const refreshQueue = useCallback(async () => {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`${API}/rooms/${roomId}/queue`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setQueue(data);
      else if (data?.items) setQueue(data.items);
      if (data?.current) setCurrentVideo(data.current);
    } catch { /* ignore */ }
  }, [roomId, token]);

  // ── Favorites (⭐) ──────────────────────────────────────────────────────────
  const toggleFavorite = useCallback(async () => {
    if (!token || favLoading) return;
    setFavLoading(true);
    try {
      const method = isFavorite ? 'DELETE' : 'POST';
      const res = await fetch(`${API}/users/me/favorites/${roomId}`, { method, headers: authHeaders() });
      if (res.ok) setIsFavorite(!isFavorite);
    } catch { /* ignore */ }
    setFavLoading(false);
  }, [token, roomId, isFavorite, favLoading, authHeaders]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch(`${API}/users/me/favorites`, { headers: authHeaders() })
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (cancelled || !data) return;
        const favs = Array.isArray(data) ? data : (data?.items || data?.favorites || []);
        setIsFavorite(favs.some(f => (f.room_id || f.id) === roomId));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token, roomId, authHeaders]);

  // Shorts mode
  const [shortsChannel, setShortsChannel] = useState('');
  const [shortsLoading, setShortsLoading] = useState(false);
  const fetchShorts = useCallback(async (maxResults = 30) => {
    const ch = shortsChannel.trim() || 'shorts';
    setShortsLoading(true);
    try {
      const res = await fetch(`${API}/videos/shorts?channel=${encodeURIComponent(ch)}&max=${maxResults}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.shorts?.length) throw new Error('No shorts found');
      const items = data.shorts.map((s, i) => ({
        id: `short-${s.id}-${Date.now()}`,
        video_url: s.url,
        src: s.url,
        video_source: 'youtube',
        type: 'youtube',
        title: s.title,
        thumbnail_url: s.thumbnail,
        duration: s.duration,
        _sort: Date.now() + i,
      }));
      const headers = token ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
      for (const item of items) {
        await fetch(`${API}/rooms/${roomId}/queue`, { method: 'POST', headers, body: JSON.stringify({ video_url: item.video_url, video_source: item.video_source, title: item.title, thumbnail_url: item.thumbnail_url }) });
      }
      refreshQueue();
      setTranscodeToast({ msg: `✓ Загружено ${items.length} шортс`, type: 'success' });
      setTimeout(() => setTranscodeToast(null), 4000);
    } catch (err) {
      setTranscodeToast({ msg: `Ошибка: ${err.message}`, type: 'error' });
      setTimeout(() => setTranscodeToast(null), 5000);
    } finally {
      setShortsLoading(false);
    }
  }, [shortsChannel, API, roomId, token, refreshQueue]);

  const prevCacheJobsRef = useRef({});
  const refreshCacheJobs = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API}/cache`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = await res.json();
      const map = {};
      (data.jobs || []).forEach(j => { map[j.id] = j; });
      prevCacheJobsRef.current = map;
      setCacheJobs(map);
    } catch { /* ignore */ }
  }, [token]);

  const startCaching = useCallback(async (item) => {
    if (!token) { setTranscodeToast({ msg: 'Нужна авторизация для кеширования', type: 'error' }); setTimeout(() => setTranscodeToast(null), 4000); return; }
    const url = item.video_url || item.src;
    if (!url) return;
    try {
      setTranscodeToast({ msg: '⚡ Кеширую...', type: 'info' });
      const res = await fetch(`${API}/cache`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: item.title || url }),
      });
      if (res.ok) {
        refreshCacheJobs();
        setTranscodeToast({ msg: '✓ Отправлено в кеш', type: 'success' });
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      setTranscodeToast({ msg: `Ошибка кеша: ${err.message}`, type: 'error' });
    }
    setTimeout(() => setTranscodeToast(null), 4000);
  }, [token, refreshCacheJobs]);

  const deleteCacheJob = useCallback(async (id) => {
    if (!token) return;
    try {
      await fetch(`${API}/cache?id=${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      refreshCacheJobs();
    } catch { /* ignore */ }
  }, [token, refreshCacheJobs]);

  // Helper: find cache job for a queue item
  const getCacheJobForItem = useCallback((item) => {
    const url = item.video_url || item.src;
    return Object.values(cacheJobs).find(j => j.url === url) || null;
  }, [cacheJobs]);

  const cacheAllQueue = useCallback(async () => {
    if (!token || queue.length === 0) return;
    setTranscodeToast({ msg: '⚡ Кеширую очередь...', type: 'info' });
    for (const item of queue) {
      const url = item.video_url || item.src;
      if (!url || getCacheJobForItem(item)) continue;
      try {
        await fetch(`${API}/cache`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, title: item.title || url }),
        });
      } catch { /* continue to next */ }
    }
    refreshCacheJobs();
    setTranscodeToast({ msg: '✓ Очередь отправлена в кеш', type: 'success' });
    setTimeout(() => setTranscodeToast(null), 4000);
  }, [token, queue, refreshCacheJobs, getCacheJobForItem]);

  const clearQueue = useCallback(async () => {
    if (queue.length === 0) return;
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    for (const item of queue) {
      try { await fetch(`${API}/rooms/${roomId}/queue/${item.id}`, { method: 'DELETE', headers }); } catch {}
    }
    refreshQueue();
    setTranscodeToast({ msg: '✓ Очередь очищена', type: 'success' });
    setTimeout(() => setTranscodeToast(null), 3000);
  }, [queue, token, roomId, refreshQueue]);

  // Auto-switch to cached URL when host's current video finishes caching
  const autoSwitchCacheRef = useRef({});

  // Poll cache jobs progress while any active
  useEffect(() => {
    const hasActive = Object.values(cacheJobs).some(j => j.status === 'downloading' || j.status === 'pending');
    if (!hasActive) return;
    const id = setInterval(refreshCacheJobs, 2000);
    return () => clearInterval(id);
  }, [cacheJobs, refreshCacheJobs]);

  useEffect(() => {
    if (!isOwner) return;
    Object.values(cacheJobs).forEach(job => {
      if (job.status === 'done' && job.cached_url && !autoSwitchCacheRef.current[job.id]) {
        autoSwitchCacheRef.current[job.id] = true;
        const curUrl = currentVideo?.video_url || currentVideo?.src;
        if (curUrl && job.url === curUrl) {
          const switched = { ...currentVideo, video_url: job.cached_url, src: job.cached_url, video_source: 'direct', type: 'direct' };
          setCurrentVideo(switched);
          sendMsgProxy({ type: 'video_select', payload: { ...switched, proxy_mode: false }, timestamp: Date.now() });
          setTranscodeToast({ msg: '✓ Видео закэшировано — переключено на локальную версию', type: 'success' });
          setTimeout(() => setTranscodeToast(null), 6000);
        }
      }
    });
  }, [cacheJobs, isOwner, currentVideo, sendMsgProxy]);

  // ── Anime bookmarklet ─────────────────────────────────────────────────────
  const animeBookmarklet = useMemo(() => {
    if (!token) return '';
    const wsUrl = window.location.origin;
    return `javascript:(function(){var title=(document.querySelector('h1.anime-title,.anime-title,h1')?.textContent||'').trim();var eps=[...document.querySelectorAll('[data-episode-id]')].map(function(e){return{id:e.dataset.episodeId||'',number:e.dataset.episode||e.dataset.number||e.textContent.trim()||'',season:e.dataset.season||e.dataset.seasonId||'1',title:e.title||e.dataset.title||''};}).filter(function(e){return e.id;});if(!eps.length){eps=[...document.querySelectorAll('.video-player-episodes-list li[data-id],[data-id][data-episode],[data-episode-id]')].map(function(e){return{id:e.dataset.id||e.dataset.episodeId||'',number:e.dataset.episode||e.dataset.number||e.textContent.trim()||'',season:e.dataset.season||'1',title:e.title||e.dataset.title||''};}).filter(function(e){return e.id;});}var url=location.href.split('?')[0];fetch('${wsUrl}/api/v1/anime/inject',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer ${token}'},body:JSON.stringify({url:url,title:title,episodes:eps})}).then(function(r){return r.json();}).then(function(d){alert('WatchSync: загружено '+d.episodes_count+' эп. Теперь вставь ссылку этой страницы в поиск WatchSync.');}).catch(function(e){alert('Ошибка WatchSync: '+e);});})()`;
  }, [token]);

  // ── Anime parser helpers ───────────────────────────────────────────────────
  const animeHeaders = useCallback(() => {
    const h = authHeaders();
    if (animeCookies) h['X-Anime-Cookies'] = animeCookies;
    return h;
  }, [authHeaders, animeCookies]);

  const animeSearch = useCallback(async () => {
    if (!animeQuery.trim()) return;
    setAnimeSearching(true);
    setAnimeError('');
    setAnimeResults([]);
    setAnimeSelected(null);
    try {
      const res = await fetch(
        `${API}/anime/search?q=${encodeURIComponent(animeQuery)}&source=${encodeURIComponent(animeSource)}`,
        { headers: animeHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAnimeResults(data.results || []);
    } catch (e) {
      setAnimeError('Ошибка поиска: ' + e.message);
    } finally {
      setAnimeSearching(false);
    }
  }, [animeQuery, animeSource, animeHeaders]);

  const animeSelectTitle = useCallback(async (item) => {
    setAnimeParsing(true);
    setAnimeError('');
    setAnimeSelected(null);
    setAnimeSeason(null);
    setAnimeEpisode(null);
    setAnimePlayers([]);
    setAnimePlayer(null);
    setAnimeStreams([]);
    try {
      // AniLibria: use dedicated episodes API
      if (animeSource === 'anilibria' && item.id) {
        const res = await fetch(`${API}/anime/anilibria/episodes?id=${encodeURIComponent(item.id)}`, {
          headers: animeHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const episodes = (data.episodes || []).map(ep => ({
          id: ep.id,
          number: ep.episode,
          title: ep.title,
          season_id: '1',
          // store release_id for extraction
          _release_id: item.id,
        }));
        setAnimeSelected({
          title: item.title,
          url: item.url,
          poster: item.poster || '',
          seasons: [{ id: '1', title: 'Сезон 1' }],
          episodes,
          players: [],
          _source: 'anilibria',
          _release_id: item.id,
        });
        setAnimeSeason({ id: '1', title: 'Сезон 1' });
        return;
      }
      // Default: animego parse
      const res = await fetch(`${API}/anime/parse`, {
        method: 'POST',
        headers: animeHeaders(),
        body: JSON.stringify({ url: item.url, cookies: animeCookies }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAnimeSelected(data);
      if (data.seasons?.length) setAnimeSeason(data.seasons[0]);
    } catch (e) {
      setAnimeError('Ошибка загрузки: ' + e.message);
    } finally {
      setAnimeParsing(false);
    }
  }, [animeSource, animeHeaders, animeCookies]);

  const animeFetchPlayers = useCallback(async (episode) => {
    if (!animeSelected || !episode) return;
    setAnimePlayer(null);
    setAnimeStreams([]);
    setAnimeExtracting(false);
    setAnimeError('');
    setAnimePlayers([]);

    // AniLibria: skip players step, extract directly from release_id + episode number
    if (animeSelected._source === 'anilibria') {
      const releaseId = animeSelected._release_id || episode._release_id;
      const epNum = episode.number || episode.id;
      const embedUrl = `https://player.anilibria.tv/index.html#release_id=${releaseId}&episode=${epNum}`;
      setAnimeExtracting(true);
      try {
        const res = await fetch(`${API}/anime/extract`, {
          method: 'POST',
          headers: animeHeaders(),
          body: JSON.stringify({
            url: animeSelected.url,
            episode_id: String(epNum),
            iframe_url: embedUrl,
            player_type: 'anilibria',
            cookies: '',
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setAnimeStreams(data.streams || []);
      } catch (e) {
        setAnimeError('Ошибка извлечения: ' + e.message);
      } finally {
        setAnimeExtracting(false);
      }
      return;
    }

    try {
      const episodeUrl = `${animeSelected.url}?episode=${episode.id}`;
      const res = await fetch(`${API}/anime/players`, {
        method: 'POST',
        headers: animeHeaders(),
        body: JSON.stringify({ url: episodeUrl, cookies: animeCookies }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAnimePlayers(data.players || []);
      if (data.players?.length) setAnimePlayer(data.players[0]);
    } catch (e) {
      setAnimeError('Ошибка загрузки плееров: ' + e.message);
    }
  }, [animeSelected, animeHeaders, animeCookies]);

  const animeExtractStream = useCallback(async (player) => {
    if (!player || !animeSelected) return;
    setAnimeExtracting(true);
    setAnimeError('');
    setAnimeStreams([]);
    try {
      const res = await fetch(`${API}/anime/extract`, {
        method: 'POST',
        headers: animeHeaders(),
        body: JSON.stringify({
          url: animeSelected.url,
          episode_id: animeEpisode?.id || '',
          iframe_url: player.iframe_url,
          player_type: player.type || 'auto',
          cookies: animeCookies,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAnimeStreams(data.streams || []);
    } catch (e) {
      setAnimeError('Ошибка извлечения: ' + e.message);
    } finally {
      setAnimeExtracting(false);
    }
  }, [animeSelected, animeEpisode, animeHeaders, animeCookies]);

  const animeAddToQueue = useCallback(async (stream) => {
    if (!stream?.url) return;
    const title = [
      animeSelected?.title,
      animeSeason ? `Сезон ${animeSeason.id}` : '',
      animeEpisode ? `Эп. ${animeEpisode.number}` : '',
      animePlayer?.player_name ? `[${animePlayer.player_name}]` : '',
    ].filter(Boolean).join(' — ');
    try {
      const res = await fetch(`${API}/rooms/${roomId}/queue`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          video_url: stream.url,
          video_source: 'hls',
          title,
          stream_headers: stream.headers || {},
        }),
      });
      if (res.ok) {
        refreshQueue();
        setAnimeOpen(false);
      } else {
        const err = await res.json();
        setAnimeError(err.error || 'Ошибка добавления в очередь');
      }
    } catch (e) {
      setAnimeError('Ошибка: ' + e.message);
    }
  }, [animeSelected, animeSeason, animeEpisode, animePlayer, roomId, authHeaders, refreshQueue]);

  const handleMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'room_init': {
        if (Array.isArray(msg.payload?.users)) {
          // users can be [{user_id, username}] objects (new) or string IDs (legacy)
          setMembers(msg.payload.users.map(u =>
            typeof u === 'string' ? { user_id: u } : u
          ));
        }
        if (msg.payload?.video_url) {
          setCurrentVideo({
            video_url: msg.payload.video_url,
            src: msg.payload.video_url,
            video_source: msg.payload.video_source || 'direct',
            type: msg.payload.video_source || 'direct',
            title: msg.payload.title || '',
          });
          setInitialState(msg.payload.state || null);
        }
        // Restore per-room sync settings
        if (msg.payload?.sync_settings) {
          setSyncSettings(s => ({ ...s, ...msg.payload.sync_settings }));
        }
        // Restore proxy mode state for late joiners
        if (msg.payload?.proxy_mode?.enabled) {
          setProxyMode(true);
          originalVideoRef.current = {
            url: msg.payload.proxy_mode.original_url || msg.payload.video_url,
            type: msg.payload.video_source || 'direct',
          };
        } else {
          setProxyMode(false);
          originalVideoRef.current = null;
        }
        // If a broadcast is already running in this room, remember the broadcaster.
        // The broadcaster will detect our user_joined and send us a WebRTC offer.
        if (msg.payload?.broadcaster && msg.payload.broadcaster.user_id !== myId) {
          setActiveBroadcaster(msg.payload.broadcaster);
          if (msg.payload.broadcaster.mime_type) broadcastMimeRef.current = msg.payload.broadcaster.mime_type;
        } else {
          setActiveBroadcaster(null);
        }
        setAllSynced(false);
        break;
      }
      case 'all_synced':
        setAllSynced(true);
        setSyncCount(msg.payload || { ready: 0, total: 0 });
        clearTimeout(joinSyncTimeoutRef.current);
        setJoinSyncBlocked(false);
        setJoiningUsername('');
        break;
      case 'sync_pending':
        setAllSynced(false);
        setSyncCount(msg.payload || { ready: 0, total: 0 });
        // Do NOT touch joinSyncBlocked here — overlay is controlled by user_joined/all_synced only.
        // Triggering it on every sync_pending caused a race: all_synced could arrive before
        // sync_pending (fast buffering), then sync_pending would re-enable the overlay with no
        // subsequent all_synced to clear it.
        break;
      case 'state_sync':
        if (Array.isArray(msg.payload?.users)) {
          setMembers(msg.payload.users.map(uid => ({ user_id: uid })));
        }
        if (msg.payload?.state) {
          setSyncState(msg.payload);
          // Capture drift at heartbeat receive time — stays constant until next heartbeat.
          // Reject if diff > 10s: client hasn't seeked yet (just joined) or is badly out of sync.
          const rawDiff = msg.payload?.adjusted_time != null
            ? currentTimeRef.current - msg.payload.adjusted_time : null;
          const baselineDrift = (rawDiff != null && Math.abs(rawDiff) < 10)
            ? Math.round(rawDiff * 1_000_000) : null;
          syncStateRef.current = { ...msg.payload, receivedAt: Date.now(), baselineDrift };
        }
        break;
      case 'room_state':
        if (msg.payload?.room) setRoom(msg.payload.room);
        if (msg.payload?.members) setMembers(msg.payload.members);
        break;
      case 'user_joined': {
        const uid = msg.payload?.user_id || msg.user_id;
        const uname = msg.payload?.username || '';
        if (uid) setMembers(prev =>
          prev.find(m => m.user_id === uid)
            ? prev.map(m => m.user_id === uid ? { ...m, username: uname || m.username } : m)
            : [...prev, { user_id: uid, username: uname }]
        );
        // Trigger join-sync overlay: pause until all_synced (or 5s timeout as safety net)
        if (uid && uid !== myId) {
          setJoiningUsername(uname || uid);
          setJoinSyncBlocked(true);
          clearTimeout(joinSyncTimeoutRef.current);
          joinSyncTimeoutRef.current = setTimeout(() => {
            setJoinSyncBlocked(false);
            setJoiningUsername('');
            setAllSynced(true);
            setSyncCount({ ready: 0, total: 0 });
          }, 5000);
        }
        // If we are broadcasting, send a WebRTC offer to the new viewer
        if (streamingRef.current && uid && uid !== myId) {
          createScreenOfferRef.current?.(uid);
        }
        break;
      }
      case 'user_left': {
        const uid = msg.payload?.user_id || msg.user_id;
        if (uid) setMembers(prev => prev.filter(m => m.user_id !== uid));
        break;
      }
      case 'queue_update':
        setQueue(msg.payload?.items || []);
        if (msg.payload?.current) setCurrentVideo(msg.payload.current);
        break;
      case 'video_action': {
        const action = msg.payload?.action;
        if (action === 'uploading' && !uploading) {
          setHostUploadNotif({ title: msg.payload.title || 'файл', progress: msg.payload.progress ?? 0, mode: 'uploading' });
        } else if (action === 'host_watching_locally' && !uploading) {
          setHostUploadNotif({ title: msg.payload.title || 'файл', progress: 0, mode: 'local' });
        } else if (action === 'upload_cancelled') {
          setHostUploadNotif(null);
        }
        break;
      }
      case 'video_select': {
        const p = msg.payload;
        if (p) {
          setCurrentVideo({ src: p.video_url || p.src, video_url: p.video_url || p.src, video_source: p.video_source || 'direct', type: p.video_source || p.type || 'direct', title: p.title || '' });
          if (!autoPlayingRef.current) setInitialState(null);
          setHostUploadNotif(null);
        }
        break;
      }
      case 'chat_message': {
        const newMsg = msg.payload;
        if (!newMsg) break;
        const hasAttachment = newMsg.attachment_url || newMsg.metadata?.attachment_url;
        if (newMsg.content == null && !hasAttachment) break;
        setMessages((prev) => [...prev.slice(-199), { ...newMsg, content: newMsg.content ?? '' }]);
        // Clear typing indicator for this user when their message arrives
        if (newMsg.username) setTypingUsers(prev => { const n = { ...prev }; delete n[newMsg.username]; return n; });
        if (activeTab !== 'chat') setUnreadCount((c) => c + 1);
        break;
      }
      case 'chat_typing': {
        const uname = msg.payload?.username;
        if (!uname || uname === username) break;
        setTypingUsers(prev => ({ ...prev, [uname]: Date.now() }));
        break;
      }
      case 'message_deleted': {
        const deletedId = msg.payload?.message_id;
        if (deletedId) setMessages((prev) => prev.filter(m => m && m.message_id !== deletedId));
        break;
      }
      case 'message_edited': {
        const { message_id, content } = msg.payload || {};
        if (message_id && content) {
          setMessages((prev) => prev.map(m => m && m.message_id === message_id ? { ...m, content, edited: true } : m));
        }
        break;
      }
      case 'video_updated':
        setCurrentVideo(msg.payload);
        if (!autoPlayingRef.current) setInitialState(null);
        setAllSynced(false);
        if (!msg.payload?.proxy_mode) {
          setProxyMode(false);
          originalVideoRef.current = null;
        }
        setHostUploadNotif(null);
        break;
      case 'transcode_completed': {
        const p = msg.payload;
        if (p?.status === 'done' && p?.stream_url) {
          // Switch current video to HLS if it matches the pending upload
          if (pendingHlsVideoIdRef.current && p.video_id === pendingHlsVideoIdRef.current) {
            pendingHlsVideoIdRef.current = null;
            setCurrentVideo(prev => prev ? {
              ...prev,
              src: p.stream_url,
              video_url: p.stream_url,
              video_source: 'hls',
              type: 'hls',
            } : prev);
          }
          setTranscodeToast({ msg: 'HLS готов — переключено на адаптивный поток ✓', type: 'success' });
        } else if (p?.status !== 'done') {
          setTranscodeToast({ msg: `Ошибка транскодирования: ${p?.error || 'неизвестная ошибка'}`, type: 'error' });
        }
        setTimeout(() => setTranscodeToast(null), 6000);
        break;
      }
      case 'transcode_progress':
        // could show progress if desired — no-op for now
        break;
      case 'sync_settings': {
        const ss = msg.payload;
        if (ss?.soft_threshold != null || ss?.hard_threshold != null) {
          setSyncSettings(s => ({ ...s, ...ss }));
        }
        break;
      }
      case 'stream_start': {
        // Broadcaster started — remember them and prepare server-relayed MSE playback.
        const peerId = msg.payload?.from || msg.user_id;
        if (peerId && peerId !== myId) {
          const uname = members.find(m => m.user_id === peerId)?.username || '';
          setActiveBroadcaster({ user_id: peerId, username: uname, stream_type: msg.payload?.stream_type || 'screen' });
          broadcastMimeRef.current = msg.payload?.mime_type || 'video/webm;codecs=vp8,opus';
          // Reset any previous MSE stream
          if (broadcastMseRef.current) {
            try { if (broadcastMseRef.current.readyState === 'open') broadcastMseRef.current.endOfStream(); } catch {}
            broadcastMseRef.current = null;
          }
          broadcastSourceBufferRef.current = null;
          broadcastQueueRef.current = [];
          if (viewerMseUrlRef.current) { try { URL.revokeObjectURL(viewerMseUrlRef.current); } catch {} viewerMseUrlRef.current = null; }
          setViewerMseUrl(null);
          setViewerStream(null);
        }
        break;
      }
      case 'stream_stop': {
        const peerId = msg.payload?.from || msg.user_id;
        // Only clear the broadcast if the stopping peer is the current broadcaster
        // (a denied/non-broadcaster must not tear down someone else's stream).
        if (activeBroadcasterRef.current?.user_id === peerId) {
          closeBroadcast();
          setActiveBroadcaster(null);
        }
        break;
      }
      case 'error': {
        // Permission denied — revert local streaming state and inform the user.
        if (msg.code === 'PERMISSION_DENIED' && msg.action === 'stream_start') {
          try { broadcastRecorderRef.current?.stop(); } catch {}
          broadcastRecorderRef.current = null;
          localStream?.getTracks().forEach(t => t.stop());
          setLocalStream(null);
          setStreaming(false);
          streamingRef.current = false;
          setStreamType(null);
          setTranscodeToast({ type: 'error', msg: 'Нет прав на трансляцию (can_stream)' });
          setTimeout(() => setTranscodeToast(null), 5000);
        } else if (msg.code === 'PERMISSION_DENIED' && msg.action === 'voice_join') {
          setTranscodeToast({ type: 'error', msg: 'Нет прав на голосовой чат (can_use_mic)' });
          setTimeout(() => setTranscodeToast(null), 5000);
        }
        break;
      }
      // Server-relayed broadcast chunk (MSE playback)
      case 'stream_chunk': {
        const { data, ts, seq } = msg.payload || {};
        if (!data) break;
        if (ts) streamDeliveryRef.current = Date.now() - ts;
        if (typeof seq === 'number') streamSeqRef.current = seq;
        const bytes = b64ToUint8(data);
        if (!broadcastMseRef.current) {
          try {
            const ms = new MediaSource();
            broadcastMseRef.current = ms;
            const url = URL.createObjectURL(ms);
            viewerMseUrlRef.current = url;
            setViewerMseUrl(url);
            ms.addEventListener('sourceopen', () => {
              try {
                let sb = null;
                for (const mime of [broadcastMimeRef.current, 'video/webm;codecs=vp8,opus', 'video/webm']) {
                  if (MediaSource.isTypeSupported(mime)) {
                    try { sb = ms.addSourceBuffer(mime); break; } catch {}
                  }
                }
                if (!sb) return;
                broadcastSourceBufferRef.current = sb;
                sb.addEventListener('updateend', () => {
                  if (broadcastQueueRef.current.length && !sb.updating) {
                    const next = broadcastQueueRef.current.shift();
                    try { sb.appendBuffer(next); } catch {}
                  }
                });
                while (broadcastQueueRef.current.length && !sb.updating) {
                  const next = broadcastQueueRef.current.shift();
                  try { sb.appendBuffer(next); } catch { break; }
                }
              } catch (e) { console.error('[stream_chunk] addSourceBuffer error:', e); }
            });
          } catch (e) { console.error('[stream_chunk] MediaSource error:', e); }
        }
        const sb = broadcastSourceBufferRef.current;
        if (sb && !sb.updating) {
          try { sb.appendBuffer(bytes); } catch {}
        } else {
          broadcastQueueRef.current.push(bytes);
        }
        break;
      }
      // WebRTC screen-share signaling (stream_type:'screen' distinguishes from voice)
      case 'webrtc_offer': {
        const { sdp, from, stream_type } = msg.payload || {};
        if (stream_type !== 'screen' || !sdp || !from || from === myId) break;
        viewerPCRef.current?.close();
        viewerICEQueueRef.current = [];
        setViewerStream(null);
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        viewerPCRef.current = pc;
        pc.ontrack = (e) => setViewerStream(e.streams[0] || new MediaStream([e.track]));
        pc.onicecandidate = (e) => {
          if (e.candidate) sendMessage({ type: 'webrtc_ice', payload: { candidate: e.candidate, from: myId, target: from, stream_type: 'screen' }, timestamp: Date.now() });
        };
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') setViewerStream(null);
        };
        pc.setRemoteDescription({ type: 'offer', sdp })
          .then(() => { viewerICEQueueRef.current.forEach(c => pc.addIceCandidate(c).catch(() => {})); viewerICEQueueRef.current = []; return pc.createAnswer(); })
          .then(a => pc.setLocalDescription(a))
          .then(() => sendMessage({ type: 'webrtc_answer', payload: { sdp: pc.localDescription.sdp, from: myId, target: from, stream_type: 'screen' }, timestamp: Date.now() }))
          .catch(e => console.error('[screen] answer error:', e));
        break;
      }
      case 'webrtc_answer': {
        const { sdp, from, stream_type } = msg.payload || {};
        if (stream_type !== 'screen' || !sdp || !from) break;
        broadcastPCsRef.current[from]?.setRemoteDescription({ type: 'answer', sdp }).catch(console.error);
        break;
      }
      case 'webrtc_ice': {
        const { candidate, from, stream_type } = msg.payload || {};
        if (stream_type !== 'screen' || !candidate || !from) break;
        const bpc = broadcastPCsRef.current[from];
        if (bpc) { bpc.addIceCandidate(candidate).catch(() => {}); }
        else if (viewerPCRef.current?.remoteDescription) { viewerPCRef.current.addIceCandidate(candidate).catch(() => {}); }
        else { viewerICEQueueRef.current.push(candidate); }
        break;
      }
      case 'dm_receive': {
        const dm = msg.payload;
        const cur = dmWithRef.current;
        if (cur && (dm.from_user_id === cur.user_id || (dm.to_user_id === cur.user_id && dm.from_user_id === myId))) {
          setDmMessages(prev => [...prev.slice(-199), dm]);
        }
        break;
      }
      // Voice signaling
      case 'voice_offer':
      case 'voice_answer':
      case 'voice_ice':
        handleVoiceMessage(msg);
        break;
      case 'voice_join':
      case 'voice_leave':
      case 'voice_state':
      case 'new_producer':
      case 'consumer_closed':
      case 'producer_closed':
      case 'system_audio_start':
      case 'system_audio_stop':
        // Route to both P2P and SFU handlers; each ignores irrelevant events
        handleVoiceMessage(msg);
        sfuListenersRef.current.forEach(h => h(msg));
        break;
      case 'achievement_unlocked': {
        const a = msg.payload;
        if (a?.name) {
          setAchievementToast({ id: a.id, name: a.name, icon: a.icon || '🏆' });
          clearTimeout(achievementToastTimerRef.current);
          achievementToastTimerRef.current = setTimeout(() => setAchievementToast(null), 5000);
        }
        break;
      }
      default:
        break;
    }
  }, [activeTab, myId, handleVoiceMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Include token in WS URL for handshake-level auth — server verifies before any join_room
  const wsUrl = useMemo(() => {
    const t = token || localStorage.getItem('sw_token');
    return t ? `${WS_BASE}?token=${encodeURIComponent(t)}` : WS_BASE;
  }, [token]);

  const { isConnected, latency, sendMessage } = useWebSocket(wsUrl, {
    onMessage: handleMessage,
  });

  // Wire sendMessage into the proxy ref so useVoiceChat can call it
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  // Send join_room once when WS connects (or reconnects)
  const joinedRef = useRef(false);
  useEffect(() => {
    if (!isConnected || authLoading) { joinedRef.current = false; return; }
    if (joinedRef.current) return;
    joinedRef.current = true;
    sendMessage({
      type: 'join_room',
      payload: { room_id: roomId, user_id: myId, token: token || null, username },
      timestamp: Date.now(),
    });
  }, [isConnected, authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic status probe — every 5s while playing, send current time to sync-service
  // Server responds with authoritative state_sync unicast, correcting per-client drift
  useEffect(() => {
    if (!isConnected || !roomId) return;
    const timer = setInterval(() => {
      if (!isPlayingRef.current) return;
      sendMessage({
        type: 'status_probe',
        room_id: roomId,
        user_id: myId,
        payload: { current_time: currentTimeRef.current, is_playing: true },
        timestamp: Date.now(),
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [isConnected, roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke blob URL on unmount to avoid memory leaks
  useEffect(() => {
    return () => {
      if (localBlobRef.current) { URL.revokeObjectURL(localBlobRef.current); localBlobRef.current = null; }
    };
  }, []);

  // Load initial data
  useEffect(() => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    fetch(`${API}/rooms/${roomId}`, { headers })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.room) setRoom(data.room); else if (data) setRoom(data); })
      .catch(() => {});

    fetch(`${API}/rooms/${roomId}/messages?limit=50`)
      .then((r) => r.ok ? r.json() : [])
      .then((msgs) => setMessages((Array.isArray(msgs) ? msgs : []).filter(m => m && (m.content != null || m.attachment_url || m.metadata?.attachment_url)).map(m => ({ ...m, content: m.content ?? '' }))))
      .catch(() => {});

    refreshQueue();
  }, [roomId, token, refreshQueue]);

  // Remove stale typing indicators after 3s
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setTypingUsers(prev => {
        const next = {};
        let changed = false;
        Object.entries(prev).forEach(([u, ts]) => {
          if (now - ts < 3000) next[u] = ts;
          else changed = true;
        });
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Poll cache jobs every 3s — only when authenticated
  useEffect(() => {
    if (!token) return;
    refreshCacheJobs();
    const id = setInterval(refreshCacheJobs, 3000);
    return () => clearInterval(id);
  }, [refreshCacheJobs, token]);

  // Scroll chat to bottom
  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setUnreadCount(0);
    }
  }, [messages, activeTab]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopStreamingRef.current?.();
      viewerPCRef.current?.close();
      viewerPCRef.current = null;
      viewerICEQueueRef.current = [];
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-buffer local MinIO videos into server memory cache
  useEffect(() => {
    const src = currentVideo?.src || currentVideo?.video_url || '';
    const match = src.match(/\/api\/v1\/videos\/stream\/(.+)/);
    if (!match) {
      // Not a MinIO video — kill any existing prebuffer stream
      if (prebufferEsRef.current) {
        prebufferEsRef.current.close();
        prebufferEsRef.current = null;
      }
      setPrebufferState(null);
      return;
    }
    const key = match[1];
    // Close previous stream if switching videos
    if (prebufferEsRef.current) {
      prebufferEsRef.current.close();
      prebufferEsRef.current = null;
    }
    setPrebufferState({ pct: 0, loaded: 0, total: 0, done: false });

    const es = new EventSource(`/api/v1/videos/prebuffer/${key}`);
    prebufferEsRef.current = es;

    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        setPrebufferState(d);
        if (d.done || d.error) {
          es.close();
          prebufferEsRef.current = null;
        }
      } catch {}
    };
    es.onerror = () => {
      es.close();
      prebufferEsRef.current = null;
      setPrebufferState(prev => prev ? { ...prev, done: true } : null);
    };

    return () => {
      es.close();
      prebufferEsRef.current = null;
    };
  }, [currentVideo?.src, currentVideo?.video_url]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Live drift indicator — update at most once per second, only on change ---
  const lastDriftRef = useRef(undefined);
  useEffect(() => {
    const id = setInterval(() => {
      const ss = syncStateRef.current;
      let next = null;
      if (ss?.baselineDrift != null && isPlayingRef.current && (Date.now() - (ss.receivedAt ?? 0)) <= 5000) {
        next = ss.baselineDrift;
      }
      if (next !== lastDriftRef.current) {
        lastDriftRef.current = next;
        setDriftUs(next);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // --- Sync ready ---
  const sendSyncReady = useCallback(() => {
    sendMessage({ type: 'sync_ready', room_id: roomId, timestamp: Date.now() });
  }, [sendMessage, roomId]);

  // --- Chat ---
  const queueChatOffline = useCallback(async (content) => {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return false;
    try {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('watchsync-offline', 1);
        req.onupgradeneeded = (e) => {
          const d = e.target.result;
          if (!d.objectStoreNames.contains('pending_chat')) {
            d.createObjectStore('pending_chat', { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('pending_chat', 'readwrite');
        tx.objectStore('pending_chat').add({ roomId, content, username, token, timestamp: Date.now() });
        tx.oncomplete = res;
        tx.onerror = rej;
      });
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('chat-sync');
      return true;
    } catch { return false; }
  }, [roomId, username, token]);

  const sendChat = useCallback(async (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const content = chatInput.trim();
    setChatInput('');
    if (!isConnected) {
      const queued = await queueChatOffline(content);
      if (queued) {
        setMessages(prev => [...prev.slice(-199), {
          username, content, timestamp: Date.now(),
          _pending: true,
        }]);
      }
      return;
    }
    sendMessage({
      type: 'chat_message',
      room_id: roomId,
      payload: { content, type: 'text', username },
      timestamp: Date.now(),
    });
  }, [chatInput, roomId, username, sendMessage, isConnected, queueChatOffline]);

  const handleChatFileAttach = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setChatUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/v1/files/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      sendMessage({
        type: 'chat_message',
        room_id: roomId,
        payload: {
          content: '',
          type: 'attachment',
          username,
          attachment_url: data.url,
          attachment_name: data.filename,
          attachment_type: data.content_type,
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('Chat file upload error:', err);
    } finally {
      setChatUploading(false);
    }
  }, [token, roomId, username, sendMessage]);

  // --- Queue (HTTP REST) ---
  const addToQueue = useCallback(async (e) => {
    e.preventDefault();
    const url = addVideoUrl.trim();
    if (!url) return;
    setQueueLoading(true);
    try {
      let finalUrl = url;
      let finalType = detectVideoType(url);
      let title = '';
      let thumbnailUrl = '';

      // Twitch: use channel name as title. Resolution to HLS happens at play time
      // (jumpToVideo) so the m3u8 token is always fresh — the iframe embed is blocked
      // by Twitch's frame-ancestors policy.
      if (finalType === 'twitch') {
        title = getTwitchChannel(url) || url;
      }

      // Anime/video sites: try server-side extraction, fall back to direct iframe
      if (finalType === 'embed_extract') {
        try {
          const extRes = await fetch(`${API}/embed/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          });
          if (extRes.ok) {
            const extracted = await extRes.json();
            if (extracted.host_dead) {
              alert(`Видеохостинг ${extracted.host || ''} недоступен — домен больше не существует. Источник сменил домен или временно лежит, попробуй позже.`);
              return;
            }
            finalUrl = extracted.embed_url;
            finalType = { hls: 'hls', direct: 'direct' }[extracted.source] || 'embed';
            title = extracted.title || '';
            thumbnailUrl = extracted.thumbnail_url || '';
          } else {
            // Extraction failed (e.g. Cloudflare) — embed original page as iframe.
            // The user's browser has cookies/session so it can load the page directly.
            finalUrl = url.split('#')[0]; // strip fragment — server ignores it anyway
            finalType = 'embed';
            title = url;
          }
        } catch {
          finalUrl = url.split('#')[0];
          finalType = 'embed';
          title = url;
        }
      }

      const res = await fetch(`${API}/rooms/${roomId}/queue`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          user_id: myId,
          video_source: finalType,
          video_url: finalUrl,
          title,
          ...(thumbnailUrl && { thumbnail_url: thumbnailUrl }),
        }),
      });
      if (!res.ok) throw new Error('Failed to add');
      setAddVideoUrl('');
      await refreshQueue();
    } catch (err) {
      console.error('addToQueue:', err);
      alert(err.message || 'Ошибка добавления видео');
    } finally {
      setQueueLoading(false);
    }
  }, [addVideoUrl, roomId, myId, authHeaders, refreshQueue]);

  const [editingMsg, setEditingMsg] = useState(null); // { message_id, content }

  const submitEditMessage = useCallback(async (messageId, newContent) => {
    if (!myId || !newContent.trim()) return;
    try {
      await fetch(`${API}/rooms/${roomId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ user_id: myId, content: newContent.trim() }),
      });
      setMessages(prev => prev.map(m => m && m.message_id === messageId ? { ...m, content: newContent.trim(), edited: true } : m));
      setEditingMsg(null);
    } catch { /* ignore */ }
  }, [roomId, myId, token]);

  const deleteMessage = useCallback(async (messageId) => {
    if (!myId) return;
    try {
      await fetch(`${API}/rooms/${roomId}/messages/${messageId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ user_id: myId }),
      });
      // Optimistic: remove locally (server will also broadcast message_deleted)
      setMessages(prev => prev.filter(m => m && m.message_id !== messageId));
    } catch { /* ignore */ }
  }, [roomId, myId, token]);

  const removeFromQueue = useCallback(async (itemId) => {
    try {
      await fetch(`${API}/rooms/${roomId}/queue/${itemId}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      setQueue(prev => prev.filter(q => q.id !== itemId));
    } catch { /* ignore */ }
  }, [roomId, token]);

  const reorderQueue = useCallback(async (newQueue) => {
    setQueue(newQueue);
    const items = newQueue.map((item, idx) => ({ id: item.id, position: idx }));
    try {
      await fetch(`${API}/rooms/${roomId}/queue/reorder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(items),
      });
    } catch { /* ignore, optimistic update already applied */ }
  }, [roomId, token]);

  const jumpToVideo = useCallback(async (item, autoPlay = false) => {
    let resolved = item;
    const itemType = item?.type || item?.video_source;
    // Twitch: resolve the channel to a fresh HLS m3u8 right before playing.
    // The player.twitch.tv iframe embed is blocked by frame-ancestors, so we
    // never embed it — we swap the twitch URL for an HLS stream.
    if (itemType === 'twitch') {
      const src = item?.video_url || item?.src || '';
      try {
        const rRes = await fetch(`${API}/videos/resolve-stream?url=${encodeURIComponent(src)}`);
        if (!rRes.ok) {
          let msg = `resolve failed (${rRes.status})`;
          try { const errJson = await rRes.json(); if (errJson?.message) msg = errJson.message; } catch {}
          if (rRes.status === 422) msg = 'канал не в эфире (не стримит)';
          throw new Error(msg);
        }
        const data = await rRes.json();
        if (!data.stream_url) throw new Error('no stream_url');
        resolved = { ...item, video_url: data.stream_url, src: data.stream_url, video_source: 'hls', type: 'hls' };
      } catch (e) {
        setTranscodeToast({ type: 'error', msg: 'Не удалось получить поток Twitch: ' + e.message });
        setTimeout(() => setTranscodeToast(null), 6000);
        return;
      }
    }
    // YouTube auto-proxy: resolve server-side (yt-dlp via the proxy tunnel) and
    // play through the server proxy — works on DPI-blocked networks with no
    // client-side proxy config. The stream URL is ip-pinned to the resolving
    // egress, so it MUST be fetched via /proxy-url (routes through the same
    // upstream), not directly by the browser.
    if (itemType === 'youtube') {
      const src = item?.video_url || item?.src || '';
      try {
        const rRes = await fetch(`${API}/videos/resolve-stream?url=${encodeURIComponent(src)}&cookies=1`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!rRes.ok) {
          let msg = `resolve failed (${rRes.status})`;
          try { const errJson = await rRes.json(); if (errJson?.message) msg = errJson.message; } catch {}
          if (rRes.status === 422) msg = 'видео недоступно';
          if (/age|подтвердит|18\+/i.test(msg)) msg = 'Ролик 18+: добавьте YouTube cookies в профиле (возрастное ограничение)';
          throw new Error(msg);
        }
        const data = await rRes.json();
        if (!data.stream_url) throw new Error('no stream_url');
        const proxied = `${API}/rooms/${roomId}/proxy-url?url=${encodeURIComponent(data.stream_url)}`;
        resolved = { ...item, video_url: proxied, src: proxied, video_source: data.type === 'hls' ? 'hls' : 'direct', type: data.type === 'hls' ? 'hls' : 'direct' };
      } catch (e) {
        setTranscodeToast({ type: 'error', msg: 'Не удалось получить поток YouTube: ' + e.message });
        setTimeout(() => setTranscodeToast(null), 6000);
        return;
      }
    }
    sendMessage({ type: 'video_select', payload: resolved, timestamp: Date.now() });
    setCurrentVideo(resolved);
    if (autoPlay) {
      autoPlayingRef.current = true;
      setTimeout(() => { autoPlayingRef.current = false; }, 2000);
      setInitialState({ current_time: 0, is_playing: true });
      sendMessage({
        type: 'video_action',
        room_id: roomId,
        user_id: myId,
        payload: { action: 'play', time: 0, rate: 1, version: Date.now() },
        timestamp: Date.now(),
      });
    }
  }, [sendMessage, roomId, myId]);

  const playNext = useCallback(() => {
    const curIdx = currentVideo ? queue.findIndex(i => i.id === currentVideo.id) : -1;
    // Next item strictly AFTER the current one. If the current video isn't in the
    // queue (played directly / uploaded), fall back to the head of the queue.
    const next = curIdx >= 0 ? queue[curIdx + 1] : queue[0];
    if (next) {
      jumpToVideo(next, true);
      return;
    }
    // No next video — clear the finished video so it doesn't linger/loop.
    setCurrentVideo(null);
    setInitialState(null);
    sendMessage({ type: 'video_select', payload: null, timestamp: Date.now() });
  }, [queue, currentVideo, jumpToVideo, sendMessage]);

  // --- Proxy Mode ---
  const enableProxyMode = useCallback(async () => {
    const videoUrl = currentVideo?.video_url || currentVideo?.src;
    if (!videoUrl || proxyLoading) return;
    // Guard: don't proxy an already-proxied URL or a blob URL
    if (videoUrl.startsWith('/api/v1/rooms') || videoUrl.startsWith('blob:')) return;
    // Guard: proxy only works for direct/HLS sources — YouTube/embed/twitch return HTML pages
    const origType = currentVideo.type || currentVideo.video_source || 'direct';
    if (origType === 'youtube' || origType === 'embed' || origType === 'twitch' || origType === 'kodik') {
      setTranscodeToast({ msg: '🛡 Прокси недоступен для YouTube, Twitch и встроенных плееров. Работает только с прямыми ссылками (MP4, HLS).', type: 'error' });
      setTimeout(() => setTranscodeToast(null), 6000);
      return;
    }
    setProxyLoading(true);
    try {
      const streamHeaders = currentVideo?.video_metadata?.stream_headers || currentVideo?.stream_headers || undefined;
      const res = await fetch(`${API}/rooms/${roomId}/proxy-config`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ url: videoUrl, enabled: true, ...(streamHeaders ? { stream_headers: streamHeaders } : {}) }),
      });
      if (!res.ok) throw new Error('proxy-config failed');
      const data = await res.json();
      if (!data.proxy_url) throw new Error('No proxy URL returned');
      originalVideoRef.current = {
        url: videoUrl,
        type: origType,
      };
      // Preserve HLS type so hls.js handles the rewritten m3u8; everything else → direct stream
      const proxyVideoType = origType === 'hls' ? 'hls' : 'direct';
      const proxyItem = {
        ...currentVideo,
        video_url: data.proxy_url,
        src: data.proxy_url,
        video_source: proxyVideoType,
        type: proxyVideoType,
        title: (currentVideo.title || '') + ' [прокси]',
      };
      sendMessage({ type: 'video_select', payload: { ...proxyItem, proxy_mode: true, original_url: videoUrl }, timestamp: Date.now() });
      setCurrentVideo(proxyItem);
      setProxyMode(true);
      // Auto-play after proxy switch — send play action so sync service sets is_playing=true
      setTimeout(() => {
        sendMessage({
          type: 'video_action',
          room_id: roomId,
          user_id: myId,
          payload: { action: 'play', time: 0, rate: 1, version: Date.now() },
          timestamp: Date.now(),
        });
      }, 800);
    } catch (err) {
      console.error('enableProxyMode:', err);
      setTranscodeToast({ msg: `Ошибка прокси: ${err.message || 'не удалось подключиться'}`, type: 'error' });
      setTimeout(() => setTranscodeToast(null), 6000);
    } finally {
      setProxyLoading(false);
    }
  }, [currentVideo, roomId, authHeaders, proxyLoading, sendMessage, myId]);

  const disableProxyMode = useCallback(() => {
    if (!originalVideoRef.current) return;
    const orig = originalVideoRef.current;
    const origItem = {
      ...currentVideo,
      video_url: orig.url,
      src: orig.url,
      video_source: orig.type,
      type: orig.type,
      title: (currentVideo.title || '').replace(' [прокси]', ''),
    };
    sendMessage({ type: 'video_select', payload: { ...origItem, proxy_mode: false }, timestamp: Date.now() });
    setCurrentVideo(origItem);
    setProxyMode(false);
    originalVideoRef.current = null;
  }, [currentVideo, sendMessage]);

  // --- Video Upload ---
  // Blob URL for host's local file preview during upload
  const localBlobRef = useRef(null);
  const uploadXhrRef = useRef(null);

  const cancelUpload = useCallback(() => {
    uploadXhrRef.current?.abort();
    uploadXhrRef.current = null;
    if (localBlobRef.current) { URL.revokeObjectURL(localBlobRef.current); localBlobRef.current = null; }
    setUploading(false);
    setUploadProgress(0);
    setUploadFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    sendMessage({ type: 'video_action', payload: { action: 'upload_cancelled' }, timestamp: Date.now() });
  }, [sendMessage]);

  const handleUpload = useCallback(() => {
    if (!uploadFile) return;
    setUploading(true);
    setUploadProgress(0);

    // Immediately play the file locally for the host via blob URL
    if (localBlobRef.current) URL.revokeObjectURL(localBlobRef.current);
    const blobUrl = URL.createObjectURL(uploadFile);
    const fileName = uploadFile.name;
    localBlobRef.current = blobUrl;
    setCurrentVideo({ src: blobUrl, video_url: blobUrl, video_source: 'direct', type: 'direct', title: fileName });
    setInitialState(null);

    // Notify other participants that upload is in progress
    sendMessage({ type: 'video_action', payload: { action: 'uploading', title: fileName, progress: 0 }, timestamp: Date.now() });

    // Upload via XHR for real progress tracking
    const xhr = new XMLHttpRequest();
    uploadXhrRef.current = xhr;
    const formData = new FormData();
    formData.append('file', uploadFile);
    if (roomId) formData.append('room_id', roomId);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setUploadProgress(pct);
        sendMessage({ type: 'video_action', payload: { action: 'uploading', title: fileName, progress: pct }, timestamp: Date.now() });
      }
    };

    xhr.onload = async () => {
      uploadXhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.url) {
            if (data.video_id) {
              pendingHlsVideoIdRef.current = data.video_id;
            }
            // Add remote URL to queue — all viewers (including late-joiners) get the real URL
            await fetch(`${API}/rooms/${roomId}/queue`, {
              method: 'POST',
              headers: authHeaders(),
              body: JSON.stringify({
                user_id: myId,
                video_source: 'direct',
                video_url: data.url,
                title: fileName,
              }),
            });
            // Switch host to remote URL immediately (don't wait for HLS transcode)
            const remoteVideo = { src: data.url, video_url: data.url, video_source: 'direct', type: 'direct', title: fileName };
            setCurrentVideo(remoteVideo);
            // Broadcast to all participants so everyone switches to the uploaded video
            sendMessage({ type: 'video_select', payload: remoteVideo, timestamp: Date.now() });
            if (data.video_id) {
              setTranscodeToast({ msg: 'HLS-транскодирование запущено...', type: 'info' });
            }
            URL.revokeObjectURL(localBlobRef.current);
            localBlobRef.current = null;
            await refreshQueue();
          }
        } catch (e) {
          console.error('Upload parse error:', e);
          setTranscodeToast({ msg: 'Ошибка при обработке ответа сервера', type: 'error' });
          setTimeout(() => setTranscodeToast(null), 5000);
        }
      } else {
        setTranscodeToast({ msg: `Ошибка загрузки: ${xhr.status} ${xhr.statusText}`, type: 'error' });
        setTimeout(() => setTranscodeToast(null), 5000);
      }
      setUploadFile(null);
      setUploadProgress(100);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setUploading(false);
      setTimeout(() => setUploadProgress(0), 2000);
    };

    xhr.onerror = () => {
      uploadXhrRef.current = null;
      setTranscodeToast({ msg: 'Ошибка загрузки файла. Проверьте соединение.', type: 'error' });
      setTimeout(() => setTranscodeToast(null), 5000);
      setUploading(false);
      setUploadProgress(0);
    };

    xhr.onabort = () => { uploadXhrRef.current = null; };

    xhr.open('POST', `${API}/videos/upload`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(formData);
  }, [uploadFile, roomId, myId, token, authHeaders, refreshQueue, sendMessage]);

  // ── WebRTC-based broadcast (P2P, one RTCPeerConnection per viewer) ──────────

  // Close viewer-side WebRTC connection (called on stream_stop or component unmount)
  const closeBroadcast = useCallback(() => {
    viewerPCRef.current?.close();
    viewerPCRef.current = null;
    viewerICEQueueRef.current = [];
    setViewerStream(null);
    // Close server-relayed MSE playback
    broadcastSourceBufferRef.current = null;
    broadcastQueueRef.current = [];
    if (broadcastMseRef.current) {
      try { if (broadcastMseRef.current.readyState === 'open') broadcastMseRef.current.endOfStream(); } catch {}
      broadcastMseRef.current = null;
    }
    if (viewerMseUrlRef.current) {
      try { URL.revokeObjectURL(viewerMseUrlRef.current); } catch {}
      viewerMseUrlRef.current = null;
    }
    setViewerMseUrl(null);
    setStreamMuted(true); // reset for next stream session
    setStreamLatency(null);
    streamDeliveryRef.current = 0;
    streamSeqRef.current = 0;
  }, []);

  // Measure stream latency: delivery (broadcaster→viewer, from chunk ts) + playback
  // buffer depth (buffered.end − currentTime). Also applies low-latency catch-up:
  // if the buffer grows past the target, briefly speed up playback to stay near the
  // live edge, then settle back to 1×.
  useEffect(() => {
    if (!activeBroadcaster) { setStreamLatency(null); return; }
    const measure = () => {
      const vid = streamVideoRef.current;
      let bufferMs = 0;
      if (vid && vid.buffered && vid.buffered.length) {
        const depth = vid.buffered.end(vid.buffered.length - 1) - vid.currentTime;
        bufferMs = Math.max(0, Math.round(depth * 1000));
        if (depth > STREAM_MAX_BUFFER_S) {
          if (vid.playbackRate !== STREAM_CATCHUP_RATE) vid.playbackRate = STREAM_CATCHUP_RATE;
        } else if (vid.playbackRate !== 1) {
          vid.playbackRate = 1;
        }
      }
      setStreamLatency({ delivery: streamDeliveryRef.current, buffer: bufferMs });
    };
    measure();
    const id = setInterval(measure, 1000);
    return () => clearInterval(id);
  }, [activeBroadcaster]);

  // Broadcaster: create and send a WebRTC offer to one specific viewer
  const createScreenOffer = useCallback(async (viewerId) => {
    if (!screenStreamRef.current) return;
    broadcastPCsRef.current[viewerId]?.close();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    broadcastPCsRef.current[viewerId] = pc;
    const q = STREAM_QUALITY_MAP[streamQualityRef.current] || STREAM_QUALITY_MAP['1080p30'];
    screenStreamRef.current.getTracks().forEach(t => {
      const sender = pc.addTrack(t, screenStreamRef.current);
      if (t.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = q.maxBitrate;
        params.encodings[0].maxFramerate = q.frameRate;
        sender.setParameters(params).catch(() => {});
        broadcastVideoSendersRef.current.push(sender);
      }
    });
    pc.onicecandidate = (e) => {
      if (e.candidate) sendMessage({ type: 'webrtc_ice', payload: { candidate: e.candidate, from: myId, target: viewerId, stream_type: 'screen' }, timestamp: Date.now() });
    };
    pc.oniceconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
        if (broadcastPCsRef.current[viewerId] === pc) delete broadcastPCsRef.current[viewerId];
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendMessage({ type: 'webrtc_offer', payload: { sdp: pc.localDescription.sdp, from: myId, target: viewerId, stream_type: 'screen' }, timestamp: Date.now() });
    } catch (e) { console.error('[screen] offer error:', e); }
  }, [myId, sendMessage]);

  const createScreenOfferRef = useRef(createScreenOffer);
  useEffect(() => { createScreenOfferRef.current = createScreenOffer; }, [createScreenOffer]);

  const handlePreviewMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = previewElRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    previewDragRef.current = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
    const onMove = (mv) => {
      const d = previewDragRef.current;
      if (!d) return;
      const newLeft = Math.max(0, Math.min(window.innerWidth - 202, d.startLeft + mv.clientX - d.startX));
      const newTop = Math.max(0, Math.min(window.innerHeight - 114, d.startTop + mv.clientY - d.startY));
      const pos = { left: newLeft, top: newTop };
      setPreviewPos(pos);
      localStorage.setItem('sw_preview_pos', JSON.stringify(pos));
    };
    const onUp = () => {
      previewDragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const startStreaming = useCallback(async (type) => {
    try {
      const q = STREAM_QUALITY_MAP[streamQualityRef.current] || STREAM_QUALITY_MAP['1080p30'];
      const videoConstraints = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } };
      // Apply chosen screen/window source (Electron) before requesting display media
      if (type === 'screen' && window.electronAPI?.setPreferredSource) {
        await window.electronAPI.setPreferredSource(broadcastSourceIdRef.current).catch(() => {});
      }
      // Audio: 'system' = loopback/system audio; a specific id = capture that microphone.
      // Screen: request loopback/system audio WITHOUT explicit constraints — WASAPI
      // loopback returns the device's native format; an explicit sampleRate/channelCount
      // (or mic flags) makes the audio track fail to appear.
      const useMic = type === 'screen' && broadcastAudioDeviceRef.current && broadcastAudioDeviceRef.current !== 'system';
      let stream = type === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: useMic ? false : true })
        : await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
      if (useMic) {
        // Drop any loopback audio the handler may have attached, then mix in the chosen mic
        stream.getAudioTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: broadcastAudioDeviceRef.current } } });
          micStream.getAudioTracks().forEach(t => stream.addTrack(t));
        } catch (e) { console.error('[broadcast] mic capture failed:', e); }
      }

      screenStreamRef.current = stream;
      setLocalStream(stream);
      setStreaming(true);
      streamingRef.current = true;
      setStreamType(type);
      setActiveBroadcaster(null);
      if (type === 'screen' && stream.getAudioTracks().length === 0) {
        setTranscodeToast({ type: 'error', msg: 'Аудио недоступно — выберите «Вкладку» (не «Окно»/«Экран») в диалоге трансляции' });
        setTimeout(() => setTranscodeToast(null), 6000);
      }
      // Server-relayed broadcast: MediaRecorder → stream_chunk (reliable across NAT, rides the existing WS connection)
      const mimeType = pickRecorderMime(stream);
      sendMessage({ type: 'stream_start', payload: { stream_type: type, from: myId, mime_type: mimeType }, timestamp: Date.now() });
      try {
        const mr = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: broadcastBitrateRef.current } : {});
        let initBuffer = null;
        let initSent = false;
        let chunkSeq = 0;
        const sendChunk = (bytes, init) => {
          const b64 = uint8ToB64(bytes);
          if (b64) sendMessage({ type: 'stream_chunk', payload: { data: b64, init, ts: Date.now(), seq: chunkSeq++ }, timestamp: Date.now() });
        };
        mr.ondataavailable = async (e) => {
          if (!e.data || e.data.size === 0) return;
          const chunk = new Uint8Array(await e.data.arrayBuffer());
          if (!initSent) {
            initBuffer = initBuffer ? concatU8(initBuffer, chunk) : chunk;
            const idx = findClusterIndex(initBuffer);
            if (idx >= 0) {
              const initBytes = initBuffer.slice(0, idx);
              const mediaBytes = initBuffer.slice(idx);
              if (initBytes.length) sendChunk(initBytes, true);
              if (mediaBytes.length) sendChunk(mediaBytes, false);
              initSent = true;
              initBuffer = null;
            } else if (initBuffer.length > 2_000_000) {
              sendChunk(initBuffer, true);
              initSent = true;
              initBuffer = null;
            }
          } else {
            sendChunk(chunk, false);
          }
        };
        mr.onerror = (e) => console.error('[broadcast] recorder error:', e);
        mr.start(STREAM_CHUNK_MS);
        broadcastRecorderRef.current = mr;
      } catch (e) { console.error('[broadcast] MediaRecorder unavailable:', e); }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.onended = () => stopStreamingRef.current?.();
    } catch (err) {
      if (err.name !== 'NotAllowedError') console.error('[broadcast] start error:', err);
    }
  }, [myId, sendMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopStreaming = useCallback(() => {
    Object.values(broadcastPCsRef.current).forEach(pc => pc.close());
    broadcastPCsRef.current = {};
    broadcastVideoSendersRef.current = [];
    // Stop server-relayed recorder
    try { broadcastRecorderRef.current?.stop(); } catch {}
    broadcastRecorderRef.current = null;
    screenStreamRef.current = null;
    localStream?.getTracks().forEach(t => t.stop());
    setLocalStream(null);
    setStreaming(false);
    streamingRef.current = false;
    setStreamType(null);
    sendMessage({ type: 'stream_stop', payload: { from: myId }, timestamp: Date.now() });
  }, [myId, sendMessage, localStream]);

  const stopStreamingRef = useRef(stopStreaming);
  useEffect(() => { stopStreamingRef.current = stopStreaming; }, [stopStreaming]);

  // Start player-capture broadcast: capture video element stream via captureStream() API
  const startStreamingPlayer = useCallback(async () => {
    const stream = captureStreamRef.current?.();
    if (!stream) {
      setTranscodeToast({ type: 'error', msg: 'captureStream() недоступен — воспроизведите видео (не YouTube/embed)' });
      setTimeout(() => setTranscodeToast(null), 5000);
      return;
    }
    if (!stream.getVideoTracks().length) {
      setTranscodeToast({ type: 'error', msg: 'Нет видеопотока — убедитесь что видео воспроизводится' });
      setTimeout(() => setTranscodeToast(null), 5000);
      return;
    }
    screenStreamRef.current = stream;
    setLocalStream(stream);
    setStreaming(true);
    streamingRef.current = true;
    setStreamType('player');
    setActiveBroadcaster(null);
    const mimeType = pickRecorderMime(stream);
    sendMessage({ type: 'stream_start', payload: { stream_type: 'player', from: myId, mime_type: mimeType }, timestamp: Date.now() });
    try {
      const mr = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: broadcastBitrateRef.current } : {});
      let initBuffer = null;
      let initSent = false;
      let chunkSeq = 0;
      const sendChunk = (bytes, init) => {
        const b64 = uint8ToB64(bytes);
        if (b64) sendMessage({ type: 'stream_chunk', payload: { data: b64, init, ts: Date.now(), seq: chunkSeq++ }, timestamp: Date.now() });
      };
      mr.ondataavailable = async (e) => {
        if (!e.data || e.data.size === 0) return;
        const chunk = new Uint8Array(await e.data.arrayBuffer());
        if (!initSent) {
          initBuffer = initBuffer ? concatU8(initBuffer, chunk) : chunk;
          const idx = findClusterIndex(initBuffer);
          if (idx >= 0) {
            const initBytes = initBuffer.slice(0, idx);
            const mediaBytes = initBuffer.slice(idx);
            if (initBytes.length) sendChunk(initBytes, true);
            if (mediaBytes.length) sendChunk(mediaBytes, false);
            initSent = true;
            initBuffer = null;
          } else if (initBuffer.length > 2_000_000) {
            sendChunk(initBuffer, true);
            initSent = true;
            initBuffer = null;
          }
        } else {
          sendChunk(chunk, false);
        }
      };
      mr.start(STREAM_CHUNK_MS);
      broadcastRecorderRef.current = mr;
    } catch (e) { console.error('[broadcast] MediaRecorder unavailable:', e); }
    // Stop when video track ends (e.g. video finishes)
    stream.getVideoTracks()[0].onended = () => stopStreamingRef.current?.();
  }, [myId, sendMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRecording = useCallback(() => {
    const stream = screenStreamRef.current;
    if (!stream || recording) return;
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
    try {
      recordChunksRef.current = [];
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mr.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(recordChunksRef.current, { type: mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `watchsync-${Date.now()}.webm`;
        a.click();
        URL.revokeObjectURL(url);
        setRecording(false);
      };
      mr.start(1000);
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch (e) { console.error('[record]', e); }
  }, [recording]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state !== 'inactive') {
      mediaRecorderRef.current?.stop();
    }
  }, []);

  const copyInvite = useCallback(() => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const connColor = isConnected ? '#4ade80' : '#f87171';
  const isMobile = windowWidth < 768;

  // Shared tab content renderer — used in both desktop sidebar and mobile bottom sheet
  // eslint-disable-next-line react/display-name
  const renderTabContent = () => (
    <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '0.8rem' }}>Загрузка…</div>}>
      <PlayerTabs p={{
        activeTab,
        activeBroadcaster,
        activeVoice,
        broadcastAudioDevice,
        broadcastAudioDevices,
        broadcastBitrate,
        broadcastSourceId,
        addToQueue,
        addVideoUrl,
        audioDevices,
        audioSettings,
        cacheAllQueue,
        cancelUpload,
        changeAudioSettings,
        changeInputDevice,
        changeOutputDevice,
        chatEndRef,
        chatFileRef,
        chatInput,
        chatUploading,
        clearQueue,
        currentVideo,
        deleteCacheJob,
        deleteMessage,
        disableProxyMode,
        dragItemRef,
        dragOverItemRef,
        editingMsg,
        enableProxyMode,
        fetchShorts,
        fileInputRef,
        getCacheJobForItem,
        getItemThumbnail,
        handleChatFileAttach,
        handleUpload,
        inputLevel,
        isOwner,
        jumpToVideo,
        localBlobRef,
        members,
        messages,
        myId,
        openDM,
        openSections,
        playNext,
        previewVisible,
        proxyLoading,
        proxyMode,
        queue,
        queueLoading,
        queueSearch,
        recording,
        refreshDevices,
        removeFromQueue,
        reorderQueue,
        room,
        roomId,
        screenSources,
        selectedInput,
        selectedOutput,
        sendChat,
        sendMessage,
        setAddVideoUrl,
        setBroadcastAudioDevice,
        setBroadcastBitrate,
        setBroadcastSourceId,
        setChatInput,
        setCurrentVideo,
        setEditingMsg,
        setInitialState,
        setPreviewVisible,
        setQueueSearch,
        setShortsChannel,
        setStreamQuality,
        setSubExtractOpen,
        setSubFormat,
        setSubLoading,
        setSubResult,
        setSubStreamIndex,
        setSyncSettings,
        setTranscodeLoading,
        setTranscodeOpen,
        setTranscodeQuality,
        setTranscodeToast,
        setUploadFile,
        setVoiceMode,
        setVoiceSettingsOpen,
        shortsChannel,
        shortsLoading,
        startCaching,
        startRecording,
        startStreaming,
        startStreamingPlayer,
        stopRecording,
        stopStreaming,
        streaming,
        streamQuality,
        subExtractOpen,
        subFormat,
        subLoading,
        subResult,
        subStreamIndex,
        submitEditMessage,
        syncSettings,
        t,
        token,
        toggleSection,
        transcodeLoading,
        transcodeOpen,
        transcodeQuality,
        transcodeToast,
        typingDebounceRef,
        typingUsers,
        uploadFile,
        uploading,
        uploadProgress,
        username,
        voiceMode,
      }} />
    </Suspense>
  );


  return (
    <div style={{ height: 'calc(100dvh - var(--titlebar-height, 0px))', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#09090f' }}>
      {/* Autoplay interaction banner — shown when browser blocks audio/video */}
      {needsInteraction && (
        <div
          onClick={() => {
            setNeedsInteraction(false);
            setStreamMuted(false); // unmute stream video if it was blocked
            // Attempt to resume any suspended AudioContext and paused video
            document.querySelectorAll('video, audio').forEach(el => {
              if (el.paused) el.play().catch(() => {});
              el.muted = false;
            });
          }}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '1rem', cursor: 'pointer',
          }}
        >
          <div style={{ fontSize: '3rem' }}>🔊</div>
          <div style={{ color: '#fff', fontWeight: 700, fontSize: '1.2rem' }}>Нажмите чтобы включить звук</div>
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }}>Браузер требует взаимодействия для воспроизведения аудио</div>
          <div style={{ background: '#7c6ff7', color: '#fff', borderRadius: '8px', padding: '0.6rem 2rem', fontSize: '0.95rem', fontWeight: 600 }}>
            Продолжить
          </div>
        </div>
      )}

      {/* Transcode toast */}
      {transcodeToast && (
        <div style={{
          position: 'fixed', bottom: '1.5rem', right: '1.5rem', zIndex: 9999,
          background: transcodeToast.type === 'success' ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)',
          border: `1px solid ${transcodeToast.type === 'success' ? 'rgba(74,222,128,0.4)' : 'rgba(248,113,113,0.4)'}`,
          borderRadius: '10px', padding: '0.75rem 1.25rem', maxWidth: '320px',
          color: transcodeToast.type === 'success' ? '#4ade80' : '#f87171',
          fontSize: '0.85rem', backdropFilter: 'blur(8px)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        }}>
          {transcodeToast.type === 'success' ? '✓ ' : '✕ '}{transcodeToast.msg}
        </div>
      )}

      {/* Achievement toast */}
      {achievementToast && (
        <div style={{
          position: 'fixed', top: '3.5rem', right: '1.5rem', zIndex: 9999,
          display: 'flex', alignItems: 'center', gap: '0.6rem',
          background: 'rgba(20,20,32,0.96)', border: '1px solid rgba(251,191,36,0.4)',
          borderRadius: '12px', padding: '0.7rem 1.1rem', maxWidth: '340px',
          color: '#fde68a', fontSize: '0.9rem', backdropFilter: 'blur(8px)',
          boxShadow: '0 6px 32px rgba(0,0,0,0.5)',
        }}>
          <span style={{ fontSize: '1.6rem' }}>{achievementToast.icon}</span>
          <div>
            <div style={{ fontSize: '0.7rem', color: 'rgba(253,230,138,0.6)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Достижение</div>
            <div style={{ fontWeight: 700 }}>{achievementToast.name}</div>
          </div>
        </div>
      )}
      {/* Header — compact cinema bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0 1rem', height: isMobile ? 'calc(44px + env(safe-area-inset-top, 0px))' : 44, paddingTop: isMobile ? 'env(safe-area-inset-top, 0px)' : 0, flexShrink: 0, background: 'rgba(9,9,15,0.98)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,0.06)', zIndex: 10 }}>
        {/* Logo */}
        <button
          onClick={() => navigate('/')}
          style={{ fontWeight: 800, fontSize: '0.9rem', background: 'linear-gradient(135deg, #7c6ff7, #ff6b9d)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0, letterSpacing: '-0.02em' }}
        >
          WatchSync
        </button>

        {/* Divider */}
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.12)', flexShrink: 0 }} />

        {/* Room name */}
        <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180, flexShrink: 1 }}>
          {room?.name || roomId}
        </div>

        {/* Broadcast: viewer can switch to the active stream from any tab */}
        {activeBroadcaster?.user_id && activeBroadcaster.user_id !== myId && (
          <button
            onClick={() => { localStorage.setItem('sw_tab', 'video'); setActiveTab('video'); }}
            title={`Смотреть трансляцию ${activeBroadcaster.username || activeBroadcaster.user_id.slice(0, 8)}`}
            style={{ background: 'rgba(255,107,157,0.16)', border: '1px solid rgba(255,107,157,0.45)', borderRadius: '6px', padding: '0.22rem 0.6rem', color: '#ff6b9d', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap', animation: 'pulse 1.6s ease-in-out infinite' }}
          >
            ▶ Трансляция
          </button>
        )}

        {/* Favorite toggle */}
        {token && (
          <button onClick={toggleFavorite} disabled={favLoading}
            title={isFavorite ? 'Убрать из избранного' : 'В избранное'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: isFavorite ? '#fbbf24' : 'rgba(255,255,255,0.35)', fontSize: '0.9rem', padding: '0.1rem 0.2rem', lineHeight: 1, flexShrink: 0 }}>
            {isFavorite ? '⭐' : '☆'}
          </button>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Live drift badge */}
        {(() => {
          if (driftUs === null) return null;
          const absUs = Math.abs(driftUs);
          const sign = driftUs >= 0 ? '+' : '−';
          let color, bg, border;
          if (absUs < 100_000)       { color = '#4ade80'; bg = 'rgba(74,222,128,0.10)';  border = 'rgba(74,222,128,0.28)'; }
          else if (absUs < 500_000)  { color = '#fbbf24'; bg = 'rgba(251,191,36,0.10)'; border = 'rgba(251,191,36,0.28)'; }
          else                       { color = '#f87171'; bg = 'rgba(248,113,113,0.10)'; border = 'rgba(248,113,113,0.28)'; }
          const label = absUs < 1000 ? `${sign}${absUs}μs`
                      : absUs < 1_000_000 ? `${sign}${Math.round(absUs/1000)}ms`
                      : `${sign}${(absUs/1_000_000).toFixed(2)}s`;
          return (
            <span style={{ background: bg, border: `1px solid ${border}`, borderRadius: '20px', padding: '0.15rem 0.6rem', color, fontSize: '0.7rem', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              ⏱ {label}
            </span>
          );
        })()}

        {/* Connection dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', flexShrink: 0 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: connColor, boxShadow: `0 0 4px ${connColor}` }} />
          {isConnected && <span>{latency}ms</span>}
        </div>

        {/* Members count */}
        <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)', flexShrink: 0 }}>
          👥 {members.length}
        </div>

        {/* Desktop-only controls */}
        {!isMobile && (
          <>
            {/* Voice compact controls */}
            {!activeVoice.inVoice ? (
              <button onClick={activeVoice.join} title="Голосовой чат"
                style={{ background: 'rgba(124,111,247,0.1)', border: '1px solid rgba(124,111,247,0.25)', borderRadius: '6px', padding: '0.25rem 0.5rem', cursor: 'pointer', color: 'rgba(180,170,255,0.8)', fontSize: '0.82rem' }}>
                🎤
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                <button onClick={activeVoice.toggleMic} title={activeVoice.muted ? 'Включить микрофон' : 'Выключить микрофон'}
                  style={{ background: activeVoice.muted ? 'rgba(248,113,113,0.18)' : 'rgba(74,222,128,0.12)', border: `1px solid ${activeVoice.muted ? 'rgba(248,113,113,0.35)' : 'rgba(74,222,128,0.25)'}`, borderRadius: '6px', padding: '0.25rem 0.45rem', cursor: 'pointer', color: activeVoice.muted ? '#f87171' : '#4ade80', fontSize: '0.82rem' }}>
                  {activeVoice.muted ? '🔇' : '🎙️'}
                </button>
                {voiceMode === 'p2p' && (
                  <button onClick={activeVoice.toggleDeafen} title={activeVoice.deafened ? 'Включить звук' : 'Заглушить'}
                    style={{ background: activeVoice.deafened ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.06)', border: `1px solid ${activeVoice.deafened ? 'rgba(248,113,113,0.35)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', padding: '0.25rem 0.45rem', cursor: 'pointer', color: activeVoice.deafened ? '#f87171' : 'rgba(255,255,255,0.5)', fontSize: '0.82rem' }}>
                    {activeVoice.deafened ? '🔕' : '🔊'}
                  </button>
                )}
                <button onClick={activeVoice.leave} title="Покинуть голос"
                  style={{ background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '6px', padding: '0.25rem 0.4rem', cursor: 'pointer', color: '#f87171', fontSize: '0.72rem' }}>
                  ✕
                </button>
              </div>
            )}

            {/* System audio (Electron desktop only) */}
            {window.electronAPI?.isElectron && (
              <button
                onClick={() => (activeVoice.isSystemAudio ? activeVoice.stopSystemAudio() : activeVoice.startSystemAudio())}
                title={activeVoice.isSystemAudio ? 'Выключить системный звук' : 'Транслировать системный звук'}
                style={{ background: activeVoice.isSystemAudio ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.06)', border: `1px solid ${activeVoice.isSystemAudio ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', padding: '0.25rem 0.5rem', cursor: 'pointer', color: activeVoice.isSystemAudio ? '#4ade80' : 'rgba(255,255,255,0.5)', fontSize: '0.82rem', animation: activeVoice.isSystemAudio ? 'pulse 1.5s ease-in-out infinite' : 'none' }}
              >
                🔊
              </button>
            )}

            {/* Stream badge */}
            {streaming && (
              <span style={{ background: 'rgba(255,107,157,0.15)', border: '1px solid rgba(255,107,157,0.35)', borderRadius: '20px', padding: '0.15rem 0.55rem', color: '#ff6b9d', fontSize: '0.68rem', fontWeight: 700 }}>
                ● LIVE
              </span>
            )}

            {/* Theme switcher */}
            <div style={{ position: 'relative' }}>
              <button onClick={() => setThemeMenuOpen(v => !v)} title="Тема"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', padding: '0.25rem 0.3rem' }}>
                {themes.find(x => x.id === theme)?.icon || '🎨'}
              </button>
              {themeMenuOpen && (
                <>
                  <div onClick={() => setThemeMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 500 }} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 501, background: '#13131c', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px', padding: '0.35rem', display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                    {themes.map((th) => (
                      <button key={th.id} onClick={() => { setTheme(th.id); setThemeMenuOpen(false); }}
                        style={{ background: theme === th.id ? 'rgba(124,111,247,0.2)' : 'none', border: 'none', borderRadius: '6px', padding: '0.4rem 0.6rem', cursor: 'pointer', color: theme === th.id ? '#a78bfa' : 'rgba(255,255,255,0.7)', fontSize: '0.8rem', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span>{th.icon}</span> {th.label}
                        {theme === th.id && <span style={{ marginLeft: 'auto', color: '#a78bfa' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Invite */}
            <button onClick={copyInvite}
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '0.25rem 0.55rem', cursor: 'pointer', color: copied ? '#4ade80' : 'rgba(255,255,255,0.45)', fontSize: '0.75rem' }}>
              {copied ? '✓' : '🔗'}
            </button>

            {/* Exit */}
            <button
              onClick={() => { sendMessage({ type: 'leave_room', room_id: roomId, timestamp: Date.now() }); navigate('/'); }}
              style={{ background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '6px', padding: '0.25rem 0.55rem', cursor: 'pointer', color: '#f87171', fontSize: '0.75rem' }}>
              Выйти
            </button>

            {/* Chat toggle when sidebar closed */}
            {!sidebarOpen && (
              <button
                onClick={() => setActiveTab(t => t === 'chat' ? 'video' : 'chat')}
                title="Чат поверх видео"
                style={{ position: 'relative', background: activeTab === 'chat' ? 'rgba(124,111,247,0.15)' : 'rgba(255,255,255,0.06)', border: `1px solid ${activeTab === 'chat' ? 'rgba(124,111,247,0.3)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', padding: '0.25rem 0.45rem', cursor: 'pointer', color: activeTab === 'chat' ? '#a78bfa' : 'rgba(255,255,255,0.45)', fontSize: '0.82rem' }}>
                💬
                {unreadCount > 0 && activeTab !== 'chat' && (
                  <span style={{ position: 'absolute', top: '-4px', right: '-4px', background: '#ff6b9d', color: '#fff', fontSize: '0.55rem', borderRadius: '8px', padding: '0 3px', minWidth: '13px', textAlign: 'center', lineHeight: '13px' }}>{unreadCount}</span>
                )}
              </button>
            )}

            {/* Sidebar toggle */}
            <button
              onClick={() => setSidebarOpen(v => { const next = !v; localStorage.setItem('sw_sidebar', next); return next; })}
              title={sidebarOpen ? 'Свернуть панель' : 'Развернуть панель'}
              style={{ background: sidebarOpen ? 'rgba(124,111,247,0.12)' : 'rgba(255,255,255,0.06)', border: `1px solid ${sidebarOpen ? 'rgba(124,111,247,0.25)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', padding: '0.25rem 0.45rem', cursor: 'pointer', color: sidebarOpen ? '#a78bfa' : 'rgba(255,255,255,0.4)', fontSize: '0.82rem' }}>
              {sidebarOpen ? '⇥' : '⇤'}
            </button>
          </>
        )}

        {/* Mobile-only: streaming badge + overflow menu */}
        {isMobile && (
          <>
            {streaming && (
              <span style={{ background: 'rgba(255,107,157,0.15)', border: '1px solid rgba(255,107,157,0.35)', borderRadius: '20px', padding: '0.15rem 0.4rem', color: '#ff6b9d', fontSize: '0.62rem', fontWeight: 700, flexShrink: 0 }}>
                ● LIVE
              </span>
            )}
            <button
              onClick={() => setMobileMenuOpen(v => !v)}
              style={{ background: mobileMenuOpen ? 'rgba(124,111,247,0.15)' : 'none', border: `1px solid ${mobileMenuOpen ? 'rgba(124,111,247,0.3)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', padding: '0.25rem 0.45rem', cursor: 'pointer', color: mobileMenuOpen ? '#a78bfa' : 'rgba(255,255,255,0.5)', fontSize: '1rem', position: 'relative' }}
              title="Меню"
            >⋮</button>
            {mobileMenuOpen && (
              <div
                onClick={() => setMobileMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 400 }}
              >
                <div
                  onClick={e => e.stopPropagation()}
                  style={{ position: 'absolute', top: 44, right: 8, background: '#13131c', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: 160, zIndex: 401, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
                >
                  <button onClick={() => { copyInvite(); setMobileMenuOpen(false); }}
                    style={{ background: 'none', border: 'none', borderRadius: '6px', padding: '0.45rem 0.75rem', cursor: 'pointer', color: copied ? '#4ade80' : 'rgba(255,255,255,0.7)', fontSize: '0.82rem', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {copied ? '✓' : '🔗'} Скопировать ссылку
                  </button>
                  <button onClick={() => { const idx = themes.findIndex(x => x.id === theme); const next = themes[(idx + 1) % themes.length]; setTheme(next.id); }}
                    style={{ background: 'none', border: 'none', borderRadius: '6px', padding: '0.45rem 0.75rem', cursor: 'pointer', color: 'rgba(255,255,255,0.7)', fontSize: '0.82rem', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {themes.find(x => x.id === theme)?.icon || '🎨'} Тема: {themes.find(x => x.id === theme)?.label}
                  </button>
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '0.2rem 0' }} />
                  <button
                    onClick={() => { sendMessage({ type: 'leave_room', room_id: roomId, timestamp: Date.now() }); navigate('/'); }}
                    style={{ background: 'none', border: 'none', borderRadius: '6px', padding: '0.45rem 0.75rem', cursor: 'pointer', color: '#f87171', fontSize: '0.82rem', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    ✕ Выйти из комнаты
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Main content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative', paddingBottom: isMobile ? 'calc(56px + env(safe-area-inset-bottom, 0px))' : 0 }}>
        {/* Video + streams area */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', background: '#000' }}>
          {/* ── Normal video player ── */}
          {!activeBroadcaster && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'relative', minHeight: 0 }}>
              <VideoPlayer
                src={currentVideo?.src || currentVideo?.video_url || ''}
                srcType={currentVideo?.type || currentVideo?.video_source || 'direct'}
                roomId={roomId}
                userId={myId}
                isOwner={isOwner}
                wsConnected={isConnected}
                sendMessage={sendMessage}
                syncState={syncState}
                initialState={initialState}
                onSyncReady={sendSyncReady}
                onTimeUpdate={(t) => { currentTimeRef.current = t; }}
                onPlayStateChange={(playing) => { isPlayingRef.current = playing; }}
                onAutoplayBlocked={() => setNeedsInteraction(true)}
                onEnded={isOwner ? playNext : null}
                captureStreamRef={captureStreamRef}
                softThreshold={syncSettings.soft_threshold}
                hardThreshold={syncSettings.hard_threshold}
                token={token}
                syncBlocked={joinSyncBlocked}
                videoKey={(() => {
                  const url = currentVideo?.src || currentVideo?.video_url || '';
                  return url.includes('/api/v1/videos/stream/') ? url.replace('/api/v1/videos/stream/', '') : null;
                })()}
              />
              {/* Join-sync overlay: pause until new participant is buffered */}
              {joinSyncBlocked && currentVideo && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)', pointerEvents: 'none' }}>
                  <div style={{ background: 'rgba(15,15,30,0.92)', border: '1px solid rgba(124,111,247,0.35)', borderRadius: '14px', padding: '1.4rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.65rem', maxWidth: 320, textAlign: 'center' }}>
                    <svg style={{ width: 32, height: 32, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="rgba(124,111,247,0.25)" strokeWidth="3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="#7c6ff7" strokeWidth="3" strokeLinecap="round"/></svg>
                    <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '0.95rem' }}>
                      {joiningUsername ? `${joiningUsername} подключается` : 'Подключается участник'}
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.78rem' }}>
                      Синхронизация... {syncCount.ready}/{syncCount.total} готовы
                    </div>
                    <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${syncCount.total > 0 ? (syncCount.ready / syncCount.total) * 100 : 0}%`, background: 'linear-gradient(90deg,#7c6ff7,#ff6b9d)', borderRadius: 2, transition: 'width 0.3s ease' }} />
                    </div>
                  </div>
                </div>
              )}
              {hostUploadNotif && !uploading && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', pointerEvents: 'none' }}>
                  <div style={{ background: 'rgba(15,15,30,0.92)', border: '1px solid rgba(124,111,247,0.35)', borderRadius: '14px', padding: '1.4rem 2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.65rem', maxWidth: 340, textAlign: 'center' }}>
                    <div style={{ color: hostUploadNotif.mode === 'local' ? '#4ade80' : '#a78bfa', fontSize: '1.5rem' }}>
                      {hostUploadNotif.mode === 'local' ? '👁' : '⬆'}
                    </div>
                    <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '0.95rem' }}>
                      {hostUploadNotif.mode === 'local' ? 'Хост смотрит локально' : 'Хост загружает файл'}
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.78rem', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hostUploadNotif.title}</div>
                    {hostUploadNotif.mode === 'local'
                      ? <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: '0.72rem' }}>Файл не загружен на сервер — другие участники не видят видео</div>
                      : <>
                          <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${hostUploadNotif.progress}%`, background: 'linear-gradient(90deg,#7c6ff7,#ff6b9d)', borderRadius: 2, transition: 'width 0.3s ease' }} />
                          </div>
                          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem' }}>{hostUploadNotif.progress}%</div>
                        </>
                    }
                  </div>
                </div>
              )}
              {/* Server cache prebuffer progress bar — shown until file is fully cached */}
              {prebufferState && !prebufferState.done && prebufferState.pct < 100 && (
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 15, pointerEvents: 'none' }}>
                  <div style={{ background: 'linear-gradient(0deg, rgba(0,0,0,0.7) 0%, transparent 100%)', padding: '1rem 1rem 0.6rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.72rem', fontWeight: 500 }}>
                        Кеширование видео на сервере…
                      </span>
                      <span style={{ color: '#a78bfa', fontSize: '0.72rem', fontWeight: 700 }}>
                        {prebufferState.pct}%
                        {prebufferState.total > 0 && (
                          <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 400 }}>
                            {' '}({(prebufferState.loaded / 1024 / 1024).toFixed(0)} / {(prebufferState.total / 1024 / 1024).toFixed(0)} MB)
                          </span>
                        )}
                      </span>
                    </div>
                    <div style={{ height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${prebufferState.pct}%`, background: 'linear-gradient(90deg,#7c6ff7,#ff6b9d)', borderRadius: 2, transition: 'width 0.2s ease' }} />
                    </div>
                  </div>
                </div>
              )}
              {!currentVideo && !hostUploadNotif && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '0.75rem', color: 'rgba(255,255,255,0.2)', userSelect: 'none' }}>
                  <div style={{ fontSize: '3rem', opacity: 0.3 }}>▶</div>
                  <div style={{ fontSize: '0.85rem' }}>Видео не выбрано</div>
                  <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>Добавьте в очередь или выберите файл</div>
                </div>
              )}
              {/* Floating stop-stream button when streaming with sidebar closed */}
              {streaming && !sidebarOpen && (
                <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: '0.35rem', zIndex: 10 }}>
                  <span style={{ background: 'rgba(255,107,157,0.85)', color: '#fff', fontSize: '0.65rem', fontWeight: 700, padding: '3px 8px', borderRadius: 4, display: 'flex', alignItems: 'center' }}>● LIVE</span>
                  <button onClick={stopStreaming} style={{ background: 'rgba(248,113,113,0.85)', border: 'none', color: '#fff', borderRadius: '5px', padding: '3px 10px', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600, backdropFilter: 'blur(4px)' }}>⏹ Стоп</button>
                </div>
              )}
            </div>
          )}

          {/* ── Broadcast primary area: replaces VideoPlayer when someone is streaming ── */}
          {activeBroadcaster && (
            <div
              style={{
                position: 'relative', flex: 1, minHeight: '300px',
                background: '#000', borderRadius: '10px', overflow: 'hidden',
                border: '2px solid rgba(255,107,157,0.5)',
                boxShadow: '0 0 0 3px rgba(255,107,157,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: viewerStream ? 'default' : 'wait',
              }}
              onClick={() => {
                const vid = document.querySelector('#viewer-stream-video');
                if (vid?.paused) { vid.muted = true; vid.play().catch(() => {}); }
              }}
            >
              {(viewerStream || viewerMseUrl) ? (
                <video
                  id="viewer-stream-video"
                  key="viewer-stream"
                  playsInline autoPlay controls={false}
                  src={viewerMseUrl || undefined}
                  style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                  ref={el => {
                    streamVideoRef.current = el;
                    if (el) {
                      el.muted = streamMuted; // sync muted state (not via JSX attr — React doesn't update it dynamically)
                      el.volume = streamVolume;
                      if (!viewerMseUrl && el.srcObject !== viewerStream) {
                        el.srcObject = viewerStream;
                        el.play().catch(err => { if (err.name === 'NotAllowedError') setNeedsInteraction(true); });
                      }
                    }
                  }}
                  onCanPlay={e => { e.target.muted = streamMuted; e.target.play().catch(() => {}); }}
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '2rem', color: 'rgba(255,255,255,0.5)' }}>
                  <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#ff6b9d', boxShadow: '0 0 10px #ff6b9d', animation: 'pulse 1.4s ease-in-out infinite' }} />
                  <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '1rem' }}>📺 Трансляция активна</div>
                  <div style={{ fontSize: '0.82rem' }}>
                    {activeBroadcaster.username || activeBroadcaster.user_id.slice(0, 8)} транслирует {activeBroadcaster.stream_type === 'camera' ? 'камеру' : activeBroadcaster.stream_type === 'player' ? 'плеер' : 'экран'} — подключение...
                  </div>
                </div>
              )}

              {/* LIVE badge + broadcaster name + latency */}
              <div style={{ position: 'absolute', top: 10, left: 12, display: 'flex', alignItems: 'center', gap: '0.4rem', pointerEvents: 'none', flexWrap: 'wrap' }}>
                <span style={{ background: '#ff6b9d', color: '#fff', fontSize: '0.6rem', fontWeight: 700, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.06em' }}>LIVE</span>
                <span style={{ background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: '0.74rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>
                  📺 {activeBroadcaster.username || activeBroadcaster.user_id.slice(0, 8)}
                </span>
                {streamLatency && (
                  <span
                    title="Задержка доставки (транслятор → вы) и буфер воспроизведения"
                    style={{
                      background: 'rgba(0,0,0,0.7)',
                      color: streamLatency.buffer < 1000 ? '#4ade80' : streamLatency.buffer < 3000 ? '#fbbf24' : '#f87171',
                      fontSize: '0.66rem', padding: '2px 8px', borderRadius: 4, fontWeight: 600, fontFamily: 'monospace',
                    }}
                  >
                    📡 {streamLatency.delivery > 0 ? `${streamLatency.delivery}мс` : '…'} · буф {streamLatency.buffer > 0 ? `${(streamLatency.buffer / 1000).toFixed(1)}с` : '—'}
                  </span>
                )}
              </div>

              {/* Stream controls overlay */}
              {(viewerStream || viewerMseUrl) && (
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: '8px', background: 'linear-gradient(to top, rgba(0,0,0,0.75), transparent)' }}>
                  {/* Mute toggle */}
                  <button
                    onClick={() => {
                      const vid = streamVideoRef.current;
                      if (vid) { vid.muted = !vid.muted; setStreamMuted(vid.muted); }
                    }}
                    title={streamMuted ? 'Включить звук' : 'Выключить звук'}
                    style={{
                      background: streamMuted ? 'rgba(255,107,157,0.85)' : 'rgba(255,255,255,0.12)',
                      border: 'none', color: '#fff', borderRadius: '5px', padding: '3px 8px',
                      fontSize: '0.72rem', cursor: 'pointer', fontWeight: 600, flexShrink: 0,
                      animation: streamMuted ? 'pulse 1.4s ease-in-out infinite' : 'none',
                    }}
                  >
                    {streamMuted ? '🔇' : '🔊'}
                  </button>
                  {/* Volume slider */}
                  <input
                    type="range" min={0} max={1} step={0.05} value={streamMuted ? 0 : streamVolume}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      setStreamVolume(v);
                      const vid = streamVideoRef.current;
                      if (vid) { vid.volume = v; vid.muted = v === 0; setStreamMuted(v === 0); }
                    }}
                    style={{ width: '80px', cursor: 'pointer', accentColor: '#ff6b9d' }}
                  />
                  {/* Fullscreen */}
                  <button
                    onClick={() => {
                      const el = streamVideoRef.current?.parentElement;
                      if (!el) return;
                      if (!document.fullscreenElement) el.requestFullscreen?.();
                      else document.exitFullscreen?.();
                    }}
                    title="Полный экран"
                    style={{ background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', borderRadius: '5px', padding: '3px 8px', fontSize: '0.72rem', cursor: 'pointer', marginLeft: 'auto' }}
                  >
                    ⛶
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Broadcaster's floating PiP preview (position:fixed → no layout shift) */}
          {localStream && previewVisible && (
            <div
              ref={previewElRef}
              onMouseDown={handlePreviewMouseDown}
              style={{
                position: 'fixed',
                ...(previewPos ? { left: previewPos.left, top: previewPos.top } : { right: 16, bottom: 80 }),
                width: 200,
                aspectRatio: '16/9',
                borderRadius: 8,
                overflow: 'hidden',
                boxShadow: '0 4px 20px rgba(0,0,0,0.7)',
                border: '1px solid rgba(255,107,157,0.5)',
                background: '#000',
                cursor: 'move',
                zIndex: 1000,
                willChange: 'transform',
                transform: 'translateZ(0)',
                userSelect: 'none',
              }}
            >
              <video autoPlay playsInline muted
                style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
                ref={el => { if (el) el.srcObject = localStream; }}
              />
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px', background: 'linear-gradient(to bottom, rgba(0,0,0,0.75), transparent)', pointerEvents: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <span style={{ background: '#ff6b9d', color: '#fff', fontSize: '0.5rem', fontWeight: 700, padding: '1px 4px', borderRadius: 3 }}>LIVE</span>
                  <span style={{ color: '#fff', fontSize: '0.6rem', fontWeight: 600 }}>{streamType === 'screen' ? '📺' : '📷'}</span>
                </div>
              </div>
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={stopStreaming}
                style={{ position: 'absolute', bottom: 4, right: 4, background: 'rgba(248,113,113,0.85)', border: 'none', color: '#fff', borderRadius: 4, padding: '2px 6px', fontSize: '0.6rem', cursor: 'pointer', fontWeight: 600 }}
              >⏹</button>
            </div>
          )}

          {/* ── Participants strip + persistent voice controls ─ */}
          {(members.length > 0 || activeVoice.inVoice) && (
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.75rem', background: 'rgba(0,0,0,0.4)', borderTop: '1px solid rgba(255,255,255,0.04)', overflowX: 'auto' }}>
              {/* Voice cluster — always visible so you can talk while watching video */}
              {(() => {
                const vcBtn = (bg, bd, color) => ({ background: bg, border: `1px solid ${bd}`, borderRadius: '6px', padding: '0.18rem 0.4rem', cursor: 'pointer', color, fontSize: '0.78rem', fontWeight: 600, flexShrink: 0, lineHeight: 1 });
                const vcWrap = { flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.3rem', paddingRight: '0.5rem', marginRight: '0.2rem', borderRight: '1px solid rgba(255,255,255,0.08)' };
                if (!activeVoice.inVoice) return (
                  <div style={vcWrap}>
                    <button onClick={activeVoice.join} title="Войти в голосовой чат" style={vcBtn('rgba(124,111,247,0.16)', 'rgba(124,111,247,0.4)', '#a78bfa')}>🎙 Голос</button>
                  </div>
                );
                return (
                  <div style={vcWrap}>
                    <button onClick={activeVoice.toggleMic} title={activeVoice.muted ? 'Включить микрофон' : 'Выключить микрофон'} style={vcBtn(activeVoice.muted ? 'rgba(248,113,113,0.2)' : 'rgba(74,222,128,0.15)', activeVoice.muted ? 'rgba(248,113,113,0.5)' : 'rgba(74,222,128,0.35)', activeVoice.muted ? '#f87171' : '#4ade80')}>
                      {activeVoice.muted ? '🔇' : '🎙'}
                    </button>
                    {voiceMode === 'p2p' && (
                      <button onClick={activeVoice.toggleDeafen} title={activeVoice.deafened ? 'Включить звук' : 'Заглушить'} style={vcBtn(activeVoice.deafened ? 'rgba(248,113,113,0.2)' : 'rgba(255,255,255,0.06)', activeVoice.deafened ? 'rgba(248,113,113,0.5)' : 'rgba(255,255,255,0.12)', activeVoice.deafened ? '#f87171' : 'rgba(255,255,255,0.5)')}>
                        {activeVoice.deafened ? '🔇' : '🔊'}
                      </button>
                    )}
                    {window.electronAPI?.isElectron && (
                      <button onClick={() => (activeVoice.isSystemAudio ? activeVoice.stopSystemAudio() : activeVoice.startSystemAudio())} title={activeVoice.isSystemAudio ? 'Выключить системный звук' : 'Транслировать системный звук'} style={vcBtn(activeVoice.isSystemAudio ? 'rgba(74,222,128,0.2)' : 'rgba(255,255,255,0.06)', activeVoice.isSystemAudio ? 'rgba(74,222,128,0.5)' : 'rgba(255,255,255,0.12)', activeVoice.isSystemAudio ? '#4ade80' : 'rgba(255,255,255,0.5)')}>
                        🔊
                      </button>
                    )}
                    <button onClick={activeVoice.leave} title="Выйти из голосового чата" style={vcBtn('rgba(248,113,113,0.15)', 'rgba(248,113,113,0.35)', '#f87171')}>✕</button>
                    <span style={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.4)', fontWeight: 700, flexShrink: 0 }}>{activeVoice.voiceMemberIds.length + 1}</span>
                  </div>
                );
              })()}
              {members.map((m) => {
                const isSpeaking = activeVoice.speaking[m.user_id];
                const isBroadcasting = activeBroadcaster?.user_id === m.user_id;
                const isMe = m.user_id === myId;
                const letter = (m.username || m.user_id || '?')[0].toUpperCase();
                return (
                  <div key={m.user_id} title={activeVoice.systemAudioPeers?.[m.user_id] ? `${m.username || m.user_id} (системный звук)` : (m.username || m.user_id)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem', cursor: 'default', flexShrink: 0, position: 'relative' }}>
                    {activeVoice.systemAudioPeers?.[m.user_id] && (
                      <span title="Системный звук" style={{ position: 'absolute', top: -4, right: -6, fontSize: '0.6rem' }}>🔊</span>
                    )}
                    <div style={{
                      width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                      background: isSpeaking ? 'rgba(74,222,128,0.25)' : isBroadcasting ? 'rgba(255,107,157,0.2)' : 'rgba(124,111,247,0.15)',
                      border: `2px solid ${isSpeaking ? '#4ade80' : isBroadcasting ? '#ff6b9d' : isMe ? '#7c6ff7' : 'rgba(255,255,255,0.15)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.72rem', fontWeight: 700, color: isSpeaking ? '#4ade80' : isBroadcasting ? '#ff6b9d' : '#e2e8f0',
                      transition: 'border-color 0.15s, background 0.15s',
                      boxShadow: isSpeaking ? '0 0 8px rgba(74,222,128,0.4)' : isBroadcasting ? '0 0 8px rgba(255,107,157,0.4)' : 'none',
                    }}>
                      {letter}
                    </div>
                    <div style={{ fontSize: '0.55rem', color: 'rgba(255,255,255,0.35)', maxWidth: 36, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {isMe ? 'Вы' : (m.username || m.user_id.slice(0, 5))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Chat overlay (when sidebar closed + chat tab) ─ */}
          {!sidebarOpen && activeTab === 'chat' && (() => {
            if (unreadCount > 0) setTimeout(() => setUnreadCount(0), 0);
            return (
              <div style={{ position: 'absolute', bottom: members.length > 0 ? '72px' : '8px', right: '8px', width: '280px', maxHeight: '45%', display: 'flex', flexDirection: 'column', zIndex: 5, borderRadius: '10px', overflow: 'hidden', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
                {/* Messages */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: '0.2rem', background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(10px)' }}>
                  {messages.filter(Boolean).slice(-15).map((msg, i) => (
                    <div key={msg?.message_id || i} style={{ fontSize: '0.74rem', maxWidth: '100%', wordBreak: 'break-word' }}>
                      <span style={{ fontWeight: 600, color: '#a78bfa', marginRight: '0.3rem' }}>{msg?.username}:</span>
                      <span style={{ color: 'rgba(255,255,255,0.82)' }}>{msg?.content ?? ''}</span>
                    </div>
                  ))}
                </div>
                {/* Input */}
                <form onSubmit={sendChat} style={{ display: 'flex', gap: '0.3rem', padding: '0.4rem', background: 'rgba(0,0,0,0.7)', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                  <input
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    placeholder={t('player:chat_placeholder')}
                    maxLength={2000}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '0.3rem 0.45rem', color: '#e2e8f0', fontSize: '0.78rem', outline: 'none' }}
                  />
                  <button type="submit" disabled={!chatInput.trim()}
                    style={{ background: 'linear-gradient(135deg,#7c6ff7,#a78bfa)', border: 'none', borderRadius: '6px', padding: '0.3rem 0.55rem', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '0.78rem', opacity: chatInput.trim() ? 1 : 0.4 }}>
                    ➤
                  </button>
                </form>
              </div>
            );
          })()}
        </div>

        {/* Mobile bottom navigation bar */}
        {isMobile && (
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 300,
            height: 'calc(56px + env(safe-area-inset-bottom, 0px))',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            background: 'rgba(13,13,20,0.97)', backdropFilter: 'blur(12px)',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            display: 'flex', alignItems: 'stretch',
          }}>
            {TABS.map((tab) => {
              const tabIcons = { video: '▶', queue: '≡', chat: '💬', voice: '🎙', doomscroll: '📱' };
              const tabLabels = { video: 'Видео', queue: 'Очередь', chat: 'Чат', voice: 'Голос', doomscroll: 'Думскрол' };
              const isActive = activeTab === tab && mobileSheetOpen;
              return (
                <button
                  key={tab}
                  onClick={() => {
                    localStorage.setItem('sw_tab', tab);
                    setActiveTab(tab);
                    if (tab === 'chat') setUnreadCount(0);
                    setMobileSheetOpen(prev => !(prev && activeTab === tab));
                  }}
                  style={{
                    flex: 1, border: 'none', background: 'none', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    gap: '2px', position: 'relative',
                    color: isActive ? '#7c6ff7' : 'rgba(255,255,255,0.4)',
                    transition: 'color 0.15s',
                  }}
                >
                  <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>{tabIcons[tab]}</span>
                  <span style={{ fontSize: '0.58rem', fontWeight: isActive ? 600 : 400 }}>{tabLabels[tab]}</span>
                  {tab === 'chat' && unreadCount > 0 && !isActive && (
                    <span style={{
                      position: 'absolute', top: '6px', right: 'calc(50% - 14px)',
                      background: '#ff6b9d', color: 'white', fontSize: '0.52rem',
                      borderRadius: '8px', padding: '0 3px', minWidth: '12px', textAlign: 'center',
                    }}>
                      {unreadCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Right Panel (collapsible) — desktop only; mobile uses bottom sheet */}
        {sidebarOpen && !isMobile && (
        <>
        <div style={{
          flexShrink: 0, position: 'relative',
          width: sidebarWidth,
          borderLeft: '1px solid rgba(255,255,255,0.07)',
          display: 'flex', flexDirection: 'column',
          background: '#0d0d14',
        }}>
          {/* Drag handle */}
          <div
            onMouseDown={onSidebarMouseDown}
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, cursor: 'col-resize', zIndex: 1, background: 'transparent' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(124,111,247,0.3)'}
            onMouseLeave={e => { if (!sidebarResizing.current) e.currentTarget.style.background = 'transparent'; }}
          />
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            {TABS.map((tab) => {
              const labels = {
                video: '▶ Видео',
                queue: '≡ Очередь',
                chat: '💬 Чат',
                voice: activeVoice.inVoice ? '🎙 Голос' : '🎙 Голос',
                doomscroll: '📱 Думскрол',
              };
              return (
                <button
                  key={tab}
                  onClick={() => { localStorage.setItem('sw_tab', tab); setActiveTab(tab); if (tab === 'chat') setUnreadCount(0); }}
                  style={{
                    flex: 1, padding: '0.6rem 0.35rem', border: 'none',
                    background: 'none', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 500,
                    color: activeTab === tab ? '#7c6ff7' : 'rgba(255,255,255,0.35)',
                    borderBottom: activeTab === tab ? '2px solid #7c6ff7' : '2px solid transparent',
                    position: 'relative',
                    transition: 'color 0.15s',
                  }}
                >
                  {labels[tab]}
                  {tab === 'chat' && unreadCount > 0 && (
                    <span style={{
                      position: 'absolute', top: '-2px', right: '-2px',
                      background: '#ff6b9d', color: 'white', fontSize: '0.58rem',
                      borderRadius: '10px', padding: '0 4px', minWidth: '14px', textAlign: 'center',
                    }}>
                      {unreadCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {renderTabContent()}

        </div>
        </>
        )}

        {/* Mobile bottom sheet — shows active tab content */}
        {isMobile && mobileSheetOpen && (
          <>
            <div onClick={() => setMobileSheetOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 290, background: 'rgba(0,0,0,0.4)' }} />
            <div style={{
              position: 'fixed', bottom: 'calc(56px + env(safe-area-inset-bottom, 0px))', left: 0, right: 0, zIndex: 295,
              height: 'calc(60dvh + env(safe-area-inset-bottom, 0px))', background: '#0d0d14',
              borderTop: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '16px 16px 0 0',
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
            }}>
              {/* Drag indicator */}
              <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0', flexShrink: 0 }}>
                <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.2)' }} />
              </div>
              {/* Tab header */}
              <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
                {TABS.map((tab) => {
                  const labels = { video: '▶ Видео', queue: '≡ Очередь', chat: '💬 Чат', voice: '🎙 Голос', doomscroll: '📱 Думскрол' };
                  return (
                    <button
                      key={tab}
                      onClick={() => { localStorage.setItem('sw_tab', tab); setActiveTab(tab); if (tab === 'chat') setUnreadCount(0); }}
                      style={{
                        flex: 1, padding: '0.5rem 0.25rem', border: 'none',
                        background: 'none', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 500,
                        color: activeTab === tab ? '#7c6ff7' : 'rgba(255,255,255,0.35)',
                        borderBottom: activeTab === tab ? '2px solid #7c6ff7' : '2px solid transparent',
                        position: 'relative', transition: 'color 0.15s',
                      }}
                    >
                      {labels[tab]}
                      {tab === 'chat' && unreadCount > 0 && (
                        <span style={{ position: 'absolute', top: '-2px', right: '-2px', background: '#ff6b9d', color: 'white', fontSize: '0.55rem', borderRadius: '10px', padding: '0 3px', minWidth: '12px', textAlign: 'center' }}>
                          {unreadCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Tab content — reuses the same renderTabContent */}
              {renderTabContent()}
            </div>
          </>
        )}
      </div>

      {/* Voice settings modal */}
      {voiceSettingsOpen && (
        <div
          onClick={() => setVoiceSettingsOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: '#13131c', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '1.5rem', width: 380, maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 700, fontSize: '1rem', color: '#e2e8f0' }}>Настройки голоса</span>
              <button onClick={() => setVoiceSettingsOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: '1.2rem', lineHeight: 1 }}>✕</button>
            </div>

            {/* Mic level preview */}
            <div>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.45)', marginBottom: '0.4rem' }}>Уровень микрофона (в реальном времени)</div>
              <div style={{ height: 8, background: 'rgba(255,255,255,0.08)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${inputLevel}%`, background: inputLevel > 70 ? '#f87171' : inputLevel > 30 ? '#4ade80' : '#7c6ff7', borderRadius: 4, transition: 'width 0.08s' }} />
              </div>
            </div>

            {/* Input device */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>Микрофон (вход)</span>
              <select value={selectedInput} onChange={(e) => changeInputDevice(e.target.value)}
                style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', color: '#e2e8f0', padding: '0.5rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                {audioDevices.inputs.map(d => (
                  <option key={d.deviceId} value={d.deviceId} style={{ background: '#09090f' }}>
                    {d.label || `Микрофон ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
                {audioDevices.inputs.length === 0 && <option>Нет доступных устройств</option>}
              </select>
            </label>

            {/* Output device */}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>Динамики (выход)</span>
              <select value={selectedOutput} onChange={(e) => changeOutputDevice(e.target.value)}
                style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', color: '#e2e8f0', padding: '0.5rem 0.75rem', fontSize: '0.85rem', cursor: 'pointer' }}>
                {audioDevices.outputs.map(d => (
                  <option key={d.deviceId} value={d.deviceId} style={{ background: '#09090f' }}>
                    {d.label || `Динамики ${d.deviceId.slice(0, 8)}`}
                  </option>
                ))}
                {audioDevices.outputs.length === 0 && <option>Нет доступных устройств</option>}
              </select>
            </label>

            {/* Gain (amplification) */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>Усиление микрофона</span>
                <span style={{ fontSize: '0.78rem', color: '#7c6ff7', fontWeight: 600 }}>{audioSettings.gain.toFixed(1)}×</span>
              </div>
              <input type="range" min="0.0" max="4.0" step="0.1"
                value={audioSettings.gain}
                onChange={(e) => changeAudioSettings({ gain: parseFloat(e.target.value) })}
                style={{ width: '100%', cursor: 'pointer', accentColor: '#7c6ff7' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'rgba(255,255,255,0.25)', marginTop: '0.15rem' }}>
                <span>0× (тихо)</span><span>1× (норма)</span><span>4× (громко)</span>
              </div>
            </div>

            {/* VAD sensitivity */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>Чувствительность VAD</span>
                <span style={{ fontSize: '0.78rem', color: '#7c6ff7', fontWeight: 600 }}>{audioSettings.vadThreshold}</span>
              </div>
              <input type="range" min="1" max="60" step="1"
                value={audioSettings.vadThreshold}
                onChange={(e) => changeAudioSettings({ vadThreshold: parseInt(e.target.value) })}
                style={{ width: '100%', cursor: 'pointer', accentColor: '#7c6ff7' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'rgba(255,255,255,0.25)', marginTop: '0.15rem' }}>
                <span>Высокая (1)</span><span>Средняя (15)</span><span>Низкая (60)</span>
              </div>
            </div>

            {/* Echo / Noise / AGC toggles */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.55)', fontWeight: 600 }}>Обработка звука</span>
              {[
                { key: 'echoCancellation', label: 'Эхоподавление', desc: 'убирает эхо из динамиков' },
                { key: 'noiseSuppression', label: 'Шумоподавление', desc: 'фильтрует фоновый шум' },
                { key: 'autoGainControl', label: 'Автоусиление (AGC)', desc: 'автоматически выравнивает громкость' },
              ].map(({ key, label, desc }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                  <div
                    onClick={() => changeAudioSettings({ [key]: !audioSettings[key] })}
                    style={{
                      width: 40, height: 22, borderRadius: 11, flexShrink: 0, cursor: 'pointer', transition: 'background 0.2s',
                      background: audioSettings[key] ? '#7c6ff7' : 'rgba(255,255,255,0.12)',
                      position: 'relative',
                    }}
                  >
                    <div style={{
                      position: 'absolute', top: 3, left: audioSettings[key] ? 21 : 3,
                      width: 16, height: 16, borderRadius: '50%', background: '#fff',
                      transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                    }} />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.82rem', color: '#e2e8f0', fontWeight: 500 }}>{label}</div>
                    <div style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)' }}>{desc}</div>
                  </div>
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', paddingTop: '0.25rem' }}>
              <button onClick={() => refreshDevices()} style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '0.45rem 1rem', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.8rem' }}>
                Обновить устройства
              </button>
              <button onClick={() => setVoiceSettingsOpen(false)} style={{ background: 'linear-gradient(135deg,#7c6ff7,#a78bfa)', border: 'none', borderRadius: '8px', padding: '0.45rem 1rem', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.8rem' }}>
                Готово
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Anime parser modal */}
      {animeOpen && (
        <div
          onClick={() => setAnimeOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#13131c', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', width: '100%', maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.9rem 1.1rem', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
              <span style={{ fontWeight: 700, fontSize: '1rem', color: '#e2e8f0' }}>🎌 Поиск аниме</span>
              <button onClick={() => setAnimeOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: '1.2rem', lineHeight: 1 }}>✕</button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.85rem', padding: '1rem' }}>
              {/* Search row */}
              {!animeSelected && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {/* Source selector */}
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    {[
                      { id: 'animego', label: 'AnimеGO' },
                      { id: 'anilibria', label: 'AniLibria' },
                    ].map(src => (
                      <button
                        key={src.id}
                        onClick={() => { setAnimeSource(src.id); localStorage.setItem('sw_anime_source', src.id); setAnimeResults([]); setAnimeSelected(null); }}
                        style={{
                          padding: '0.25rem 0.65rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600,
                          border: animeSource === src.id ? '1px solid #7c6ff7' : '1px solid rgba(255,255,255,0.1)',
                          background: animeSource === src.id ? 'rgba(124,111,247,0.2)' : 'rgba(255,255,255,0.04)',
                          color: animeSource === src.id ? '#a78bfa' : 'rgba(255,255,255,0.45)',
                          cursor: 'pointer',
                        }}
                      >{src.label}</button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      className="input-base"
                      placeholder={animeSource === 'anilibria' ? 'Название аниме (AniLibria)...' : 'Название или ссылка animego.me...'}
                      value={animeQuery}
                      onChange={e => setAnimeQuery(e.target.value)}
                      onKeyDown={e => {
                        if (e.key !== 'Enter') return;
                        if (animeSource === 'animego' && animeQuery.includes('animego.me/anime/')) {
                          animeSelectTitle({ url: animeQuery.trim(), title: '' });
                        } else {
                          animeSearch();
                        }
                      }}
                      style={{ flex: 1, fontSize: '0.85rem' }}
                      autoFocus
                    />
                    <button
                      className="btn-primary"
                      onClick={() => {
                        if (animeSource === 'animego' && animeQuery.includes('animego.me/anime/')) {
                          animeSelectTitle({ url: animeQuery.trim(), title: '' });
                        } else {
                          animeSearch();
                        }
                      }}
                      disabled={animeSearching || animeParsing}
                      style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}
                    >
                      {(animeSearching || animeParsing) ? '...' : 'Найти'}
                    </button>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.25)' }}>
                    {animeSource === 'anilibria'
                      ? 'Поиск через публичный API AniLibria.TV'
                      : 'Введи название для поиска или вставь ссылку animego.me/anime/...'}
                  </div>
                </div>
              )}

              {/* Bookmarklet — main recommended method */}
              {!animeSelected && animeBookmarklet && (
                <div style={{ background: 'rgba(124,111,247,0.07)', border: '1px solid rgba(124,111,247,0.25)', borderRadius: '10px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#a78bfa' }}>Рекомендуемый способ</div>
                  <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)', lineHeight: 1.55 }}>
                    1. Перетащи кнопку в панель закладок браузера<br/>
                    2. Открой страницу аниме на <b style={{ color: 'rgba(255,255,255,0.7)' }}>animego.me</b><br/>
                    3. Нажми закладку — она загрузит список серий в WatchSync<br/>
                    4. Вернись сюда и вставь ту же ссылку в поле поиска
                  </div>
                  <a
                    href={animeBookmarklet}
                    draggable
                    onClick={e => e.preventDefault()}
                    style={{ display: 'inline-block', background: 'rgba(124,111,247,0.2)', border: '1px solid rgba(124,111,247,0.45)', borderRadius: '8px', padding: '0.45rem 1rem', color: '#c4b5fd', fontSize: '0.82rem', fontWeight: 600, cursor: 'grab', textDecoration: 'none', textAlign: 'center', userSelect: 'none' }}
                  >
                    🎌 WatchSync Anime
                  </a>
                  <div style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.25)' }}>Ссылка содержит твой токен — не передавай её другим</div>
                </div>
              )}

              {/* Cookies field — fallback */}
              {!animeSelected && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                    <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Cookies animego.me {animeCookies ? '✓' : '(альтернативный способ)'}
                    </span>
                    {animeCookies && (
                      <button
                        onClick={() => { setAnimeCookies(''); localStorage.removeItem('sw_animego_cookies'); }}
                        style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '0.72rem' }}
                      >очистить</button>
                    )}
                  </div>
                  {!animeCookies ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      <textarea
                        placeholder="Вставь cookies из браузера (F12 → Network → любой запрос к animego.me → заголовок Cookie)"
                        rows={3}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '0.5rem 0.75rem', color: '#e2e8f0', fontSize: '0.75rem', resize: 'vertical', fontFamily: 'monospace', outline: 'none' }}
                        onBlur={e => {
                          const v = e.target.value.trim();
                          if (v) { setAnimeCookies(v); localStorage.setItem('sw_animego_cookies', v); }
                        }}
                      />
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.72rem', color: '#4ade80' }}>Cookies сохранены — запросы пройдут через DDoS-Guard</div>
                  )}
                </div>
              )}

              {/* Error */}
              {animeError && (
                <div style={{ color: '#f87171', fontSize: '0.8rem', background: 'rgba(248,113,113,0.1)', borderRadius: '8px', padding: '0.5rem 0.75rem' }}>
                  {animeError}
                </div>
              )}

              {/* Results list */}
              {!animeSelected && animeResults.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {animeResults.map((r, i) => (
                    <button
                      key={i}
                      onClick={() => animeSelectTitle(r)}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '0.5rem 0.75rem', cursor: 'pointer', textAlign: 'left', color: '#e2e8f0' }}
                    >
                      {r.poster && <img src={r.poster} alt="" style={{ width: 36, height: 50, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} onError={e => e.target.style.display='none'} />}
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{r.title}</div>
                        {r.year && <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)' }}>{r.year}</div>}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Parsing spinner */}
              {animeParsing && (
                <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', padding: '1rem' }}>Загрузка...</div>
              )}

              {/* Anime selected — season / episode / player */}
              {animeSelected && !animeParsing && (
                <>
                  {/* Back + title */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <button
                      onClick={() => { setAnimeSelected(null); setAnimePlayers([]); setAnimeStreams([]); setAnimeError(''); }}
                      style={{ background: 'rgba(255,255,255,0.07)', border: 'none', borderRadius: '6px', padding: '0.3rem 0.6rem', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.8rem' }}
                    >← Назад</button>
                    <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{animeSelected.title}</span>
                  </div>

                  {/* Season selector */}
                  {animeSelected.seasons?.length > 1 && (
                    <div>
                      <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Сезон</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                        {animeSelected.seasons.map(s => (
                          <button
                            key={s.id}
                            onClick={() => { setAnimeSeason(s); setAnimeEpisode(null); setAnimePlayers([]); setAnimeStreams([]); }}
                            style={{ padding: '0.3rem 0.65rem', borderRadius: '6px', border: '1px solid', borderColor: animeSeason?.id === s.id ? '#7c6ff7' : 'rgba(255,255,255,0.1)', background: animeSeason?.id === s.id ? 'rgba(124,111,247,0.2)' : 'rgba(255,255,255,0.04)', color: animeSeason?.id === s.id ? '#a78bfa' : 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.8rem' }}
                          >{s.title}</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Episode selector */}
                  {animeSelected.episodes?.length > 0 && (
                    <div>
                      <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Серия</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', maxHeight: 130, overflowY: 'auto' }}>
                        {animeSelected.episodes
                          .filter(ep => !animeSeason || ep.season_id === animeSeason.id)
                          .map(ep => (
                            <button
                              key={ep.id}
                              onClick={() => { setAnimeEpisode(ep); animeFetchPlayers(ep); }}
                              style={{ padding: '0.3rem 0.55rem', borderRadius: '6px', border: '1px solid', borderColor: animeEpisode?.id === ep.id ? '#7c6ff7' : 'rgba(255,255,255,0.1)', background: animeEpisode?.id === ep.id ? 'rgba(124,111,247,0.2)' : 'rgba(255,255,255,0.04)', color: animeEpisode?.id === ep.id ? '#a78bfa' : 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.78rem', minWidth: 36, textAlign: 'center' }}
                            >{ep.number}</button>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Player (dub) selector */}
                  {animePlayers.length > 0 && (
                    <div>
                      <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Озвучка / Плеер</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                        {animePlayers.map((p, i) => (
                          <button
                            key={i}
                            onClick={() => { setAnimePlayer(p); setAnimeStreams([]); animeExtractStream(p); }}
                            style={{ padding: '0.3rem 0.65rem', borderRadius: '6px', border: '1px solid', borderColor: animePlayer === p ? '#7c6ff7' : 'rgba(255,255,255,0.1)', background: animePlayer === p ? 'rgba(124,111,247,0.2)' : 'rgba(255,255,255,0.04)', color: animePlayer === p ? '#a78bfa' : 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '0.8rem' }}
                          >{p.player_name || `Плеер ${i + 1}`}</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Extracting spinner */}
                  {animeExtracting && (
                    <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '0.82rem' }}>Извлечение потока...</div>
                  )}

                  {/* Streams */}
                  {animeStreams.length > 0 && (
                    <div>
                      <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Качество</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        {animeStreams.map((s, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '0.5rem 0.75rem', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.82rem', color: '#e2e8f0', fontWeight: 600 }}>{s.label || 'auto'}</span>
                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                              <button
                                onClick={() => animeAddToQueue(s)}
                                className="btn-primary"
                                style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem' }}
                              >+ В очередь</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* No episodes — bookmarklet prompt */}
                  {!animeEpisode && animeSelected.episodes?.length === 0 && (
                    <div style={{ background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '10px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ fontSize: '0.8rem', color: '#fca5a5', fontWeight: 600 }}>Эпизоды не найдены</div>
                      <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)', lineHeight: 1.55 }}>
                        Страница защищена DDoS-Guard. Используй букмарклет:<br/>
                        1. Перейди на <b style={{ color: 'rgba(255,255,255,0.7)' }}>{animeSelected.url}</b> в браузере<br/>
                        2. Нажми закладку <b style={{ color: '#c4b5fd' }}>WatchSync Anime</b><br/>
                        3. Вернись сюда и нажми «Назад» → снова открой это аниме
                      </div>
                      {animeBookmarklet && (
                        <a
                          href={animeBookmarklet}
                          draggable
                          onClick={e => e.preventDefault()}
                          style={{ display: 'inline-block', background: 'rgba(124,111,247,0.2)', border: '1px solid rgba(124,111,247,0.45)', borderRadius: '8px', padding: '0.4rem 0.85rem', color: '#c4b5fd', fontSize: '0.78rem', fontWeight: 600, cursor: 'grab', textDecoration: 'none', textAlign: 'center', userSelect: 'none', alignSelf: 'flex-start' }}
                        >🎌 WatchSync Anime</a>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* DM modal */}
      {dmOpen && (
        <div onClick={() => setDmOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '1rem' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#13131c', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', width: 320, maxHeight: '60dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#e2e8f0' }}>✉️ {dmWith?.username || '...'}</span>
              <button onClick={() => setDmOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: '1.1rem', lineHeight: 1 }}>✕</button>
            </div>
            {/* Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              {dmLoading && <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '0.8rem' }}>Загрузка...</div>}
              {!dmLoading && dmMessages.length === 0 && (
                <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.25)', fontSize: '0.8rem', margin: 'auto' }}>Нет сообщений</div>
              )}
              {dmMessages.map((dm, i) => {
                const isMe = dm.from_user_id === myId;
                return (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                    {!isMe && <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', marginBottom: '0.15rem' }}>{dm.from_username}</span>}
                    <div style={{ maxWidth: '85%', background: isMe ? 'rgba(124,111,247,0.25)' : 'rgba(255,255,255,0.07)', borderRadius: isMe ? '12px 12px 2px 12px' : '12px 12px 12px 2px', padding: '0.4rem 0.65rem', fontSize: '0.82rem', color: '#e2e8f0', wordBreak: 'break-word' }}>
                      {dm.content}
                    </div>
                    <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.2)', marginTop: '0.1rem' }}>
                      {dm.timestamp ? new Date(dm.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                );
              })}
              <div ref={dmEndRef} />
            </div>
            {/* Input */}
            <form onSubmit={sendDM} style={{ display: 'flex', gap: '0.4rem', padding: '0.65rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
              <input
                value={dmInput}
                onChange={e => setDmInput(e.target.value)}
                placeholder="Сообщение..."
                maxLength={2000}
                style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '0.45rem 0.65rem', color: '#e2e8f0', fontSize: '0.82rem', outline: 'none' }}
              />
              <button type="submit" disabled={!dmInput.trim()} style={{ background: 'linear-gradient(135deg,#7c6ff7,#a78bfa)', border: 'none', borderRadius: '8px', padding: '0.45rem 0.7rem', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '0.85rem', opacity: dmInput.trim() ? 1 : 0.4 }}>
                ➤
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
