import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';
import Hls from 'hls.js';

// ── YouTube IFrame API loader (module-level singleton) ──────────────────────
let _ytApiLoaded = false;
let _ytApiReady = false;
const _ytCallbacks = [];

function loadYTApi() {
  if (_ytApiLoaded) return;
  _ytApiLoaded = true;
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    _ytApiReady = true;
    if (prev) prev();
    _ytCallbacks.splice(0).forEach(cb => cb());
  };
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}

function onYTReady(cb) {
  if (_ytApiReady && window.YT?.Player) { cb(); return; }
  _ytCallbacks.push(cb);
  loadYTApi();
}

function getYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ────────────────────────────────────────────────────────────────────────────

const VideoPlayer = ({
  src,
  srcType,
  roomId,
  userId,
  isOwner,
  wsConnected,
  sendMessage,
  syncState,
  onTimeUpdate,
  onPlayStateChange = null,
  onAutoplayBlocked = null,
  onEnded = null,
  captureStreamRef = null,
  initialState = null,
  onSyncReady = null,
  softThreshold = 0.5,
  hardThreshold = 4,
  className = '',
  token = null,
  videoKey = null,
  syncBlocked = false,
}) => {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const hlsRef = useRef(null);
  const iframeRef = useRef(null); // embed / kodik

  // YouTube
  const ytPlayerRef = useRef(null);
  // Stable ID for YT player div (must not change across renders)
  const ytDivId = useRef(`yt-${Math.random().toString(36).slice(2, 9)}`).current;

  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem('sw_volume'));
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 1;
  });
  const [isMuted, setIsMuted] = useState(() => localStorage.getItem('sw_muted') === '1');
  const volumeRef = useRef(volume);
  const mutedRef = useRef(isMuted);
  useEffect(() => { volumeRef.current = volume; localStorage.setItem('sw_volume', String(volume)); }, [volume]);
  useEffect(() => { mutedRef.current = isMuted; localStorage.setItem('sw_muted', isMuted ? '1' : '0'); }, [isMuted]);
  // Expose captureStream() to parent — only works for native <video> (not YT/embed iframes)
  useEffect(() => {
    if (!captureStreamRef) return;
    captureStreamRef.current = () => {
      try { return videoRef.current?.captureStream?.() ?? null; }
      catch (e) { console.warn('[captureStream]', e); return null; }
    };
    return () => { if (captureStreamRef) captureStreamRef.current = null; };
  }, [captureStreamRef]);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [syncStatus, setSyncStatus] = useState('synced');
  const [iframeBlocked, setIframeBlocked] = useState(false);

  // Double-tap to seek (mobile)
  const tapTimerRef = useRef(null);
  const lastTapRef = useRef({ x: 0, time: 0 });
  const [seekFlash, setSeekFlash] = useState(null); // { dir: 'left'|'right', key: number }

  // Swipe-down to exit fullscreen
  const touchStartY = useRef(0);

  // HLS quality levels
  const [hlsLevels, setHlsLevels] = useState([]);   // [{height, bitrate}]
  const [hlsLevel, setHlsLevel] = useState(-1);      // -1 = auto

  // Captions / subtitles
  const [captionsOn, setCaptionsOn] = useState(false);

  // MP4 / direct file quality variants (from transcoder)
  const [mp4Qualities, setMp4Qualities] = useState(null);  // null = not loaded
  const [mp4QualityLoading, setMp4QualityLoading] = useState(false);

  // YouTube quality levels — hardcoded (getAvailableQualityLevels unreliable)
  const YT_QUALITIES = ['hd1080', 'hd720', 'large', 'medium', 'small'];
  const YT_QUALITY_LABELS = { small: '240p', medium: '360p', large: '480p', hd720: '720p', hd1080: '1080p', highres: '4K' };
  const [ytQuality, setYtQuality] = useState('auto');
  const [clickFlash, setClickFlash] = useState(null); // { type: 'play'|'pause', key: number } | null
  const clickFlashTimer = useRef(null);
  const lastPlayPauseRef = useRef(0); // debounce: last handlePlayPauseClick timestamp

  const controlsTimeoutRef = useRef(null);
  const softSyncTimeoutRef = useRef(null);
  const lastSyncTimestampRef = useRef(0);
  // P-controller: projected server position updated on every state_sync heartbeat
  const projectedRef = useRef(null); // { base, at, rate, nominal }
  const pControllerRef = useRef(null);
  // Per-tab session ID — generated fresh on each mount, NOT stored in localStorage.
  // Used for echo guard: prevents filtering a same-user action from another tab.
  const clientIdRef = useRef(null);
  if (!clientIdRef.current) clientIdRef.current = crypto.randomUUID();
  // Seek grace period: block sync corrections for 500ms after user-initiated seek
  const seekGraceRef = useRef(0);
  const initialStateRef = useRef(initialState);
  useEffect(() => { initialStateRef.current = initialState; }, [initialState]);
  const onSyncReadyRef = useRef(onSyncReady);
  useEffect(() => { onSyncReadyRef.current = onSyncReady; }, [onSyncReady]);
  // YouTube is auto-proxied: the video is resolved server-side (yt-dlp through
  // the upstream tunnel) and played through the server proxy, so no client-side
  // proxy config is needed. `youtubeResolved` is set when the proxied stream is
  // ready; until then (and on resolve failure) the YT iframe stays as fallback.
  const [youtubeResolved, setYoutubeResolved] = useState(null); // {src, type}
  const isYT = srcType === 'youtube' && !youtubeResolved;
  const isEmbed = srcType === 'embed';
  const isKodik = isEmbed && src && /kodik\.(biz|info)/.test(src);

  // Twitch: the player.twitch.tv iframe is blocked by frame-ancestors, so we
  // resolve the channel to a fresh HLS m3u8 here and play it as HLS instead.
  const [twitchResolvedSrc, setTwitchResolvedSrc] = useState(null);
  useEffect(() => {
    if (srcType !== 'twitch' || !src) { setTwitchResolvedSrc(null); return; }
    let cancelled = false;
    setTwitchResolvedSrc(null);
    (async () => {
      try {
        const rRes = await fetch(`/api/v1/videos/resolve-stream?url=${encodeURIComponent(src)}`);
        if (!rRes.ok) return;
        const data = await rRes.json();
        if (data.stream_url && !cancelled) setTwitchResolvedSrc(data.stream_url);
      } catch { /* keep null → native video will show a load error instead of a blocked iframe */ }
    })();
    return () => { cancelled = true; };
  }, [srcType, src]);

  // YouTube auto-proxy: resolve the video server-side (yt-dlp goes through the
  // proxy upstream, e.g. NB1 socks5) and wrap the ip-pinned stream URL in the
  // server proxy, so playback works from any network — no client proxy config.
  useEffect(() => {
    if (srcType !== 'youtube' || !src || !roomId) { setYoutubeResolved(null); return; }
    let cancelled = false;
    setYoutubeResolved(null);
    (async () => {
      try {
        const rRes = await fetch(`/api/v1/videos/resolve-stream?url=${encodeURIComponent(src)}&cookies=1`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!rRes.ok) return;
        const data = await rRes.json();
        if (!data.stream_url || cancelled) return;
        setYoutubeResolved({
          src: `/api/v1/rooms/${roomId}/proxy-url?url=${encodeURIComponent(data.stream_url)}`,
          type: data.type === 'hls' ? 'hls' : 'direct',
        });
      } catch { /* keep null → YT iframe fallback */ }
    })();
    return () => { cancelled = true; };
  }, [srcType, src, roomId]);

  // Effective playback source/type: twitch swaps to its resolved HLS m3u8,
  // youtube swaps to its proxied stream.
  const effSrc = srcType === 'twitch' ? (twitchResolvedSrc || '')
    : srcType === 'youtube' ? (youtubeResolved?.src || '')
    : src;
  const effSrcType = srcType === 'twitch' ? (twitchResolvedSrc ? 'hls' : 'direct')
    : srcType === 'youtube' ? (youtubeResolved ? youtubeResolved.type : 'youtube')
    : srcType;


  // Apply YouTube quality via setPlaybackQualityRange (setPlaybackQuality deprecated)
  useEffect(() => {
    if (!isYT || !ytPlayerRef.current) return;
    if (ytQuality === 'auto') {
      try { ytPlayerRef.current.setPlaybackQualityRange?.('hd2160'); } catch {} // remove limit
    } else {
      try { ytPlayerRef.current.setPlaybackQualityRange?.(ytQuality); } catch {}
    }
  }, [ytQuality, isYT]);

  // Reset YT quality levels on src change
  // Reset iframe error state and quality state when src changes
  useEffect(() => {
    setIframeBlocked(false);
    setHlsLevels([]);
    setHlsLevel(-1);
    setMp4Qualities(null);
    setMp4QualityLoading(false);
    setYtQuality('auto');
  }, [src]);

  // Apply HLS quality level when changed
  useEffect(() => {
    if (!hlsRef.current) return;
    hlsRef.current.currentLevel = hlsLevel;
  }, [hlsLevel]);

  const loadMp4Qualities = useCallback(async () => {
    const key = videoKey || (src ? src.replace('/api/v1/videos/stream/', '') : null);
    if (!key) return;
    setMp4QualityLoading(true);
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`/api/v1/videos/qualities?key=${encodeURIComponent(key)}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMp4Qualities(data);
    } catch (e) {
      setMp4Qualities({ qualities: [], has_variants: false, error: e.message });
    } finally {
      setMp4QualityLoading(false);
    }
  }, [src, videoKey, token]);

  // Auto-load MP4 quality variants when src is a MinIO stream
  useEffect(() => {
    const isStream = src && (src.includes('/api/v1/videos/stream/') || src.includes('/api/v1/videos/qualities'));
    if (isStream && (srcType === 'direct' || srcType === 'mp4')) {
      loadMp4Qualities();
    }
  }, [src, srcType, loadMp4Qualities]);

  // ── Send video action ─────────────────────────────────────────────────────
  const sendVideoAction = useCallback((action, time = null) => {
    if (!wsConnected || !roomId) return;
    const curTime = isYT
      ? (ytPlayerRef.current?.getCurrentTime?.() ?? 0)
      : (videoRef.current?.currentTime ?? 0);
    sendMessage({
      type: 'video_action',
      room_id: roomId,
      user_id: userId,
      payload: { action, time: time ?? curTime, rate: videoRef.current?.playbackRate ?? 1, version: Date.now(), client_id: clientIdRef.current },
      timestamp: Date.now()
    });
  }, [wsConnected, roomId, userId, sendMessage, isYT]);

  // ── Watch-time tick (30s of actual playback) ──────────────────────────────
  // Maps the player source type to the canonical watch:type bucket expected by
  // ws-gateway / user-service: {youtube, local, hls, embed}.
  const watchType = useMemo(() => {
    switch (srcType) {
      case 'youtube': return 'youtube';
      case 'hls': return 'hls';
      case 'embed':
      case 'kodik': return 'embed';
      default: return 'local'; // direct, mp4, twitch(resolved→hls), anything else
    }
  }, [srcType]);

  useEffect(() => {
    if (!isPlaying || syncBlocked || !wsConnected || !roomId) return;
    // A fresh interval is started whenever playback (re)starts, sync is blocked,
    // or the video changes — so the 30s counter resets on pause / video switch.
    const id = setInterval(() => {
      if (!isPlayingRef.current || syncBlocked || !wsConnected || !roomId) return;
      sendMessage({
        type: 'watch_tick',
        room_id: roomId,
        user_id: userId,
        payload: { seconds: 30, video_type: watchType, room_id: roomId },
        timestamp: Date.now(),
      });
    }, 30000);
    return () => clearInterval(id);
  }, [isPlaying, syncBlocked, wsConnected, roomId, watchType, src, videoKey, sendMessage, userId]);

  // ── HLS / direct setup ────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    if (isYT) return; // YouTube handled separately

    // On canplay: apply initial seek position and signal sync-ready
    const handleCanPlay = () => {
      const init = initialStateRef.current;
      if (init?.current_time > 0) {
        video.currentTime = init.current_time;
      }
      video.volume = volumeRef.current;
      video.muted = mutedRef.current;
      if (init?.is_playing) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
      onSyncReadyRef.current?.();
    };
    video.addEventListener('canplay', handleCanPlay, { once: true });

    if (isEmbed) return; // embed uses iframe, not <video> (twitch resolves to HLS above)

    // No video selected (e.g. queue drained) — release the buffered source so the
    // last video doesn't linger in the <video> element.
    if (!effSrc) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      setDuration(0);
      setCurrentTime(0);
      currentTimeRef.current = 0;
      setIsPlaying(false);
      isPlayingRef.current = false;
      setHlsLevels([]);
      setBuffering(false);
      return () => { video.removeEventListener('canplay', handleCanPlay); };
    }

    // Auth token for stream URLs — <video>/HLS can't send Authorization headers,
    // so append the access token as a query param (video-service accepts it).
    const streamSrc = (effSrc && token && effSrc.includes('/api/v1/videos/stream/'))
      ? `${effSrc}${effSrc.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
      : effSrc;

    let cancelled = false;

    if (effSrcType === 'hls' && Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(streamSrc);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        const levels = data.levels.map((l, i) => ({ index: i, height: l.height, bitrate: l.bitrate }));
        setHlsLevels(levels);
        setHlsLevel(-1);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        // Surface HLS failures instead of silently not playing (e.g. live Twitch).
        console.error('[hls] error:', data.type, data.details, 'fatal=', data.fatal);
        setBuffering(false);
        setSyncStatus(data.fatal ? 'error' : 'buffering');
      });
    } else if (effSrc) {
      video.src = streamSrc;
    }

    return () => {
      cancelled = true;
      video.removeEventListener('canplay', handleCanPlay);
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [effSrc, effSrcType, isYT]);

  // ── YouTube player setup ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isYT || !src) {
      if (ytPlayerRef.current) {
        try { ytPlayerRef.current.destroy(); } catch {}
        ytPlayerRef.current = null;
      }
      return;
    }

    const videoId = getYouTubeId(src);
    if (!videoId) return;

    if (ytPlayerRef.current) {
      try { ytPlayerRef.current.destroy(); } catch {}
      ytPlayerRef.current = null;
    }

    setIsPlaying(false);
    setDuration(0);
    setCurrentTime(0);

    onYTReady(() => {
      const el = document.getElementById(ytDivId);
      if (!el) return;
      ytPlayerRef.current = new window.YT.Player(ytDivId, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, enablejsapi: 1, origin: window.location.origin, cc_load_policy: 0 },
        events: {
          onReady: (e) => {
            setDuration(e.target.getDuration() || 0);
            const init = initialStateRef.current;
            if (init?.current_time > 0) {
              e.target.seekTo(init.current_time, true);
            }
            try {
              e.target.setVolume(Math.round(volumeRef.current * 100));
              if (mutedRef.current) e.target.mute(); else e.target.unMute();
            } catch {}
            if (init?.is_playing) {
              // Auto-playing — don't pause, sync will take over if needed
              onSyncReadyRef.current?.();
            } else {
              e.target.pauseVideo();
              onSyncReadyRef.current?.();
            }
          },
          onStateChange: (e) => {
            const S = window.YT.PlayerState;
            if (e.data === S.PLAYING)   { setIsPlaying(true);  isPlayingRef.current = true;  onPlayStateChange?.(true);  setBuffering(false); setSyncStatus('synced'); }
            if (e.data === S.PAUSED)    { setIsPlaying(false); isPlayingRef.current = false; onPlayStateChange?.(false); }
            if (e.data === S.BUFFERING) { setBuffering(true);  setSyncStatus('buffering'); }
            if (e.data === S.ENDED)     { setIsPlaying(false); isPlayingRef.current = false; onPlayStateChange?.(false); onEnded?.(); }
          }
        }
      });
    });

    return () => {
      if (ytPlayerRef.current) {
        try { ytPlayerRef.current.destroy(); } catch {}
        ytPlayerRef.current = null;
      }
    };
  }, [src, srcType, isYT, ytDivId]);

  // ── YouTube time polling ──────────────────────────────────────────────────
  useEffect(() => {
    if (!isYT) return;
    const id = setInterval(() => {
      if (!ytPlayerRef.current?.getCurrentTime) return;
      const t = ytPlayerRef.current.getCurrentTime();
      setCurrentTime(t);
      currentTimeRef.current = t;
      onTimeUpdate?.(t);
    }, 250);
    return () => clearInterval(id);
  }, [isYT, onTimeUpdate]);

  // ── Kodik postMessage listener ───────────────────────────────────────────
  useEffect(() => {
    if (!isKodik) return;
    const handler = (e) => {
      let data;
      try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (!data?.key) return;
      switch (data.key) {
        case 'kodik_player_current_time':
          setCurrentTime(Number(data.value) || 0);
          currentTimeRef.current = Number(data.value) || 0;
          onTimeUpdate?.(Number(data.value) || 0);
          break;
        case 'kodik_player_duration':
          setDuration(Number(data.value) || 0);
          break;
        case 'kodik_player_play':
          setIsPlaying(true); isPlayingRef.current = true; onPlayStateChange?.(true); setBuffering(false);
          break;
        case 'kodik_player_pause':
          setIsPlaying(false); isPlayingRef.current = false; onPlayStateChange?.(false);
          break;
        case 'kodik_player_end':
          setIsPlaying(false); isPlayingRef.current = false; onPlayStateChange?.(false); onEnded?.();
          break;
        case 'kodik_player_ready':
          onSyncReadyRef.current?.();
          break;
        default: break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [isKodik, onTimeUpdate, onPlayStateChange]);

  // ── Sync state (from server) ──────────────────────────────────────────────
  useEffect(() => {
    if (!syncState?.state) return;                        // ignore join-time payload (has .users, not .state)
    // Echo guard: skip own actions using per-tab clientId (not userId — userId is shared across tabs).
    if (syncState?.source_client_id && syncState.source_client_id === clientIdRef.current) return;

    // Reject stale state ONLY for seek/rate operations — never reject play/pause changes.
    // Heartbeats carry the same timestamp as the last saved state, so filtering by timestamp
    // would cause play/pause to be silently dropped when heartbeat arrives after the action.
    const incomingTs = syncState.state?.timestamp ?? 0;
    const isPlayPauseChange = syncState.source_user_id !== '_heartbeat' && syncState.source_user_id !== '_probe_response';
    if (!isPlayPauseChange && incomingTs > 0 && incomingTs < lastSyncTimestampRef.current) return;
    if (incomingTs > lastSyncTimestampRef.current) {
      lastSyncTimestampRef.current = incomingTs;
    }

    const { state, adjusted_time } = syncState;
    setSyncStatus('syncing');

    // Kodik iframe sync via postMessage
    if (isKodik && iframeRef.current?.contentWindow) {
      const win = iframeRef.current.contentWindow;
      const timeDiff = Math.abs(currentTime - adjusted_time);
      if (timeDiff > softThreshold && performance.now() > seekGraceRef.current) {
        win.postMessage(JSON.stringify({ key: 'seek', seconds: adjusted_time }), '*');
      }
      if (state.is_playing && !isPlaying)  win.postMessage(JSON.stringify({ key: 'play' }), '*');
      if (!state.is_playing && isPlaying)  win.postMessage(JSON.stringify({ key: 'pause' }), '*');
      setSyncStatus('synced');
      return;
    }

    if (isYT && ytPlayerRef.current) {
      // YouTube: seek FIRST, then play/pause (avoids play() interruption)
      const inGrace = performance.now() < seekGraceRef.current;
      const timeDiff = Math.abs((ytPlayerRef.current.getCurrentTime?.() ?? 0) - adjusted_time);
      if (timeDiff > softThreshold && !inGrace) ytPlayerRef.current.seekTo?.(adjusted_time, true);
      if (!inGrace) {
        const ytState = ytPlayerRef.current.getPlayerState?.();
        const S = window.YT?.PlayerState;
        const ytPlaying = ytState === S?.PLAYING;
        if (state.is_playing && !ytPlaying)  ytPlayerRef.current.playVideo?.();
        if (!state.is_playing && ytPlaying)  ytPlayerRef.current.pauseVideo?.();
      }
    } else {
      const video = videoRef.current;
      if (!video) return;

      const inGrace = performance.now() < seekGraceRef.current;
      // Step A: hard seek only — P-controller handles continuous drift between heartbeats.
      const timeDiff = Math.abs(video.currentTime - adjusted_time);
      if (!inGrace && (timeDiff > hardThreshold || (timeDiff > softThreshold && !state.is_playing))) {
        if (video.readyState >= 2) {
          video.currentTime = adjusted_time;
        }
      }

      // Step B: apply play/pause AFTER seek (prevents play() interruption by seek)
      if (!inGrace) {
        if (state.is_playing && !syncBlocked && video.paused && !video.ended)
          video.play().catch(err => { if (err.name === 'NotAllowedError') onAutoplayBlocked?.(); });
        if (!state.is_playing || syncBlocked) video.pause();
      }

      // Step C: sync playback rate — let P-controller handle fine-grained corrections
      if (video.playbackRate !== (state.playback_rate || 1)) {
        video.playbackRate = state.playback_rate || 1;
      }
    }
    // Update projected reference for P-controller
    if (state.is_playing && !syncBlocked && adjusted_time != null) {
      projectedRef.current = {
        base:    adjusted_time,
        at:      performance.now(),
        rate:    state.playback_rate || 1,
        nominal: state.playback_rate || 1,
      };
    } else {
      projectedRef.current = null;
      // Reset playback rate when paused or blocked
      if (videoRef.current) videoRef.current.playbackRate = state.playback_rate || 1;
    }

    setSyncStatus('synced');
  }, [syncState, isYT, syncBlocked]);

  // ── Continuous P-controller (drift correction between heartbeats) ─────────
  useEffect(() => {
    const KP       = 0.5;   // proportional gain
    const DEADBAND = 0.05;  // seconds — no correction within ±50ms
    const MAX_CORR = 0.10;  // max ±10% speed adjustment

    const id = setInterval(() => {
      const p = projectedRef.current;
      const video = videoRef.current;
      if (!p || !video || video.paused || syncBlocked || video.readyState < 2) {
        // Reset rate to nominal when not correcting
        if (video && !video.paused && video.readyState >= 2) {
          const nominal = projectedRef.current?.nominal ?? 1;
          if (Math.abs(video.playbackRate - nominal) > 0.001) video.playbackRate = nominal;
        }
        return;
      }
      const elapsed = (performance.now() - p.at) / 1000;
      const projected = p.base + elapsed * p.rate;
      const drift = video.currentTime - projected; // positive = ahead, negative = behind
      if (Math.abs(drift) < DEADBAND) {
        if (video.playbackRate !== p.nominal) video.playbackRate = p.nominal;
        return;
      }
      // Behind (drift < 0) → speed up; ahead (drift > 0) → slow down
      const correction = Math.max(-MAX_CORR, Math.min(MAX_CORR, drift * KP));
      video.playbackRate = p.nominal - correction;
    }, 200);

    pControllerRef.current = id;
    return () => { clearInterval(id); pControllerRef.current = null; };
  }, [syncBlocked]); // restart only when syncBlocked changes

  // ── Fullscreen listener ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // ── Swipe-down to exit fullscreen ─────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onTouchStart = (e) => { touchStartY.current = e.touches[0].clientY; };
    const onTouchEnd = (e) => {
      const delta = e.changedTouches[0].clientY - touchStartY.current;
      if (delta > 80 && isFullscreen) document.exitFullscreen?.();
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => { el.removeEventListener('touchstart', onTouchStart); el.removeEventListener('touchend', onTouchEnd); };
  }, [isFullscreen]);

  // ── Auto-fullscreen on landscape orientation ──────────────────────────────
  useEffect(() => {
    const onChange = () => {
      if (screen.orientation?.type?.startsWith('landscape') && !document.fullscreenElement) {
        containerRef.current?.requestFullscreen?.().catch(() => {});
      }
    };
    screen.orientation?.addEventListener?.('change', onChange);
    return () => screen.orientation?.removeEventListener?.('change', onChange);
  }, []);

  // ── Video element events ──────────────────────────────────────────────────
  const handlePlay = useCallback(() => {
    setIsPlaying(true);
    isPlayingRef.current = true;
    onPlayStateChange?.(true);
  }, [onPlayStateChange]);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    onPlayStateChange?.(false);
  }, [onPlayStateChange]);

  const handleSeek = useCallback((time) => {
    // called only from UI (progress bar, keyboard) — no echo guard needed
    if (isYT && ytPlayerRef.current) {
      ytPlayerRef.current.seekTo(time, true);
    } else if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    seekGraceRef.current = performance.now() + 1000; // block sync for 1s
    sendVideoAction('seek', time);
  }, [sendVideoAction, isYT]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    currentTimeRef.current = video.currentTime;
    onTimeUpdate?.(video.currentTime);
  }, [onTimeUpdate]);

  const handleLoadedMetadata = useCallback(() => {
    if (videoRef.current) setDuration(videoRef.current.duration);
  }, []);

  const handleVolumeChange = useCallback((newVolume) => {
    setVolume(newVolume);
    if (videoRef.current) videoRef.current.volume = newVolume;
    if (isYT && ytPlayerRef.current) {
      ytPlayerRef.current.setVolume(newVolume * 100);
      if (newVolume === 0) ytPlayerRef.current.mute();
      else ytPlayerRef.current.unMute();
    }
    setIsMuted(newVolume === 0);
  }, [isYT]);

  const toggleMute = useCallback((e) => {
    e?.stopPropagation?.();
    if (videoRef.current) { videoRef.current.muted = !isMuted; }
    if (isYT && ytPlayerRef.current) {
      isMuted ? ytPlayerRef.current.unMute() : ytPlayerRef.current.mute();
    }
    setIsMuted(!isMuted);
  }, [isMuted, isYT]);

  const toggleCaptions = useCallback((e) => {
    e?.stopPropagation?.();
    const next = !captionsOn;
    setCaptionsOn(next);
    if (isYT && ytPlayerRef.current) {
      try {
        if (next) ytPlayerRef.current.loadModule?.('captions');
        else ytPlayerRef.current.unloadModule?.('captions');
      } catch {}
    } else if (videoRef.current) {
      // toggle native text tracks
      const tracks = videoRef.current.textTracks;
      if (tracks) {
        for (let i = 0; i < tracks.length; i++) {
          tracks[i].mode = next ? 'showing' : 'hidden';
        }
      }
    }
  }, [captionsOn, isYT]);

  const toggleFullscreen = useCallback((e) => {
    e?.stopPropagation?.();
    if (!containerRef.current) return;
    if (!document.fullscreenElement) containerRef.current.requestFullscreen?.();
    else document.exitFullscreen?.();
  }, []);

  const triggerClickFlash = useCallback((type) => {
    clearTimeout(clickFlashTimer.current);
    setClickFlash({ type, key: Date.now() });
    clickFlashTimer.current = setTimeout(() => setClickFlash(null), 600);
  }, []);

  const handlePlayPauseClick = useCallback((e) => {
    e?.stopPropagation?.();
    // Debounce: block calls within 400ms to prevent double-fires
    const now = performance.now();
    if (now - lastPlayPauseRef.current < 400) return;
    lastPlayPauseRef.current = now;
    const playing = isPlayingRef.current;
    if (isYT && ytPlayerRef.current) {
      if (playing) {
        ytPlayerRef.current.pauseVideo();
        sendVideoAction('pause');
        triggerClickFlash('pause');
      } else {
        ytPlayerRef.current.playVideo();
        sendVideoAction('play');
        triggerClickFlash('play');
      }
    } else {
      if (playing) {
        videoRef.current?.pause();
        sendVideoAction('pause');
        triggerClickFlash('pause');
      } else {
        videoRef.current?.play().catch(err => { if (err.name === 'NotAllowedError') onAutoplayBlocked?.(); });
        sendVideoAction('play');
        triggerClickFlash('play');
      }
    }
  }, [isYT, sendVideoAction, triggerClickFlash]);

  // ── Double-tap to seek handler ────────────────────────────────────────────
  const handleContainerClick = useCallback((e) => {
    // Desktop double-click → fullscreen (browser sets e.detail to click count)
    if (e.detail === 2) {
      clearTimeout(tapTimerRef.current);
      toggleFullscreen();
      return;
    }

    // Ignore clicks on controls (buttons, selects, inputs — including SVG inside them)
    if (e.target.closest('button, select, input')) return;
    // Ignore clicks on the controls overlay bar (bottom panel)
    if (e.target.closest('[data-controls]')) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX ?? e.touches?.[0]?.clientX ?? 0) - rect.left;
    const now = Date.now();

    if (now - lastTapRef.current.time < 300 && Math.abs(x - lastTapRef.current.x) < 80) {
      // double tap (mobile) — seek ±10s
      clearTimeout(tapTimerRef.current);
      const isLeft = x < rect.width / 2;
      const seekDelta = isLeft ? -10 : 10;
      if (isYT && ytPlayerRef.current) {
        const newTime = Math.max(0, (ytPlayerRef.current.getCurrentTime?.() || 0) + seekDelta);
        ytPlayerRef.current.seekTo?.(newTime, true);
        sendVideoAction('seek', newTime);
      } else if (videoRef.current) {
        const newTime = Math.max(0, Math.min(duration || Infinity, (videoRef.current.currentTime || 0) + seekDelta));
        handleSeek(newTime);
      }
      setSeekFlash({ dir: isLeft ? 'left' : 'right', key: Date.now() });
      lastTapRef.current = { x: 0, time: 0 };
    } else {
      // single tap — play/pause after 300ms (cancelled if double-tap or double-click)
      lastTapRef.current = { x, time: now };
      tapTimerRef.current = setTimeout(() => {
        handlePlayPauseClick();
      }, 300);
    }
  }, [handlePlayPauseClick, handleSeek, duration, isYT, sendVideoAction, toggleFullscreen]);

  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => { if (isPlayingRef.current) setShowControls(false); }, 3000);
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      // Prevent Space from activating focused buttons (double-toggle bug)
      if (e.key === ' ') e.preventDefault();
      switch (e.key) {
        case ' ':
          handlePlayPauseClick();
          break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'c': case 'C': toggleCaptions(); break;
        case 'm': case 'M': toggleMute(); break;
        case 'ArrowLeft': handleSeek(Math.max(0, currentTimeRef.current - (e.shiftKey ? 30 : 10))); break;
        case 'ArrowRight': handleSeek(Math.min(duration || Infinity, currentTimeRef.current + (e.shiftKey ? 30 : 10))); break;
        case 'ArrowUp': handleVolumeChange(Math.min(1, volumeRef.current + 0.1)); break;
        case 'ArrowDown': handleVolumeChange(Math.max(0, volumeRef.current - 0.1)); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleFullscreen, toggleCaptions, toggleMute, handleSeek, handleVolumeChange, handlePlayPauseClick, duration]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const formatTime = (s) => {
    if (!s || isNaN(s)) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  const progressPercent = duration ? (currentTime / duration) * 100 : 0;
  const syncColors = { synced: '#4ade80', syncing: '#fbbf24', buffering: '#f87171', disconnected: '#6b7280' };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className={`relative bg-black rounded-lg overflow-hidden ${className}`}
      style={{ aspectRatio: '16/9', cursor: 'pointer' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlayingRef.current && setShowControls(false)}
      onClick={handleContainerClick}
    >
      {/* Embed iframe (Kodik, Alloha, anime sites, etc.) */}
      {isEmbed && src && !iframeBlocked && (
        <iframe
          key={src}
          ref={iframeRef}
          src={src}
          className="absolute inset-0 w-full h-full"
          style={{ border: 'none', zIndex: 1 }}
          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
          allowFullScreen
          title="embed-player"
          onError={() => setIframeBlocked(true)}
        />
      )}
      {isEmbed && iframeBlocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6"
          style={{ background: '#09090f', zIndex: 2 }}>
          <div style={{ fontSize: '2rem' }}>🚫</div>
          <div style={{ color: '#f87171', fontWeight: 600 }}>Сайт заблокировал встраивание</div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.82rem', maxWidth: 360 }}>
            Сайт запрещает показывать себя в iframe (X-Frame-Options).
            Чтобы смотреть вместе — используйте <b style={{ color: '#7c6ff7' }}>📺 Трансляцию экрана</b>,
            или вставьте прямой URL плеера (например, kodik.biz) из DevTools браузера.
          </div>
          <a href={src} target="_blank" rel="noopener noreferrer"
            style={{ color: '#7c6ff7', fontSize: '0.8rem', textDecoration: 'underline' }}>
            Открыть в новой вкладке ↗
          </a>
        </div>
      )}

      {/* Native video element (hidden for YouTube and embed; Twitch plays as resolved HLS here) */}
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        style={{ display: isYT || isEmbed ? 'none' : 'block', pointerEvents: 'none' }}
        onClick={e => e.preventDefault()}
        onDoubleClick={undefined}
        onPlay={handlePlay}
        onPause={handlePause}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onSeeking={() => { setBuffering(true); setSyncStatus('buffering'); }}
        onSeeked={() => { setBuffering(false); }}
        onWaiting={() => { setBuffering(true); setSyncStatus('buffering'); }}
        onCanPlay={() => { setBuffering(false); setSyncStatus('synced'); }}
        onEnded={() => { setIsPlaying(false); isPlayingRef.current = false; onEnded?.(); }}
        preload="auto"
        playsInline
      />

      {/* YouTube player container — always in DOM so YT API can target it */}
      <div
        id={ytDivId}
        className="absolute inset-0"
        style={{ display: isYT ? 'block' : 'none' }}
      />

      {/* Transparent click interceptor for YouTube.
          Sits on top of the iframe so direct clicks on the video go through
          our handleContainerClick instead of YouTube's built-in toggle.
          pointer-events:none while hidden so it never blocks non-YT players. */}
      {isYT && (
        <div
          className="absolute inset-0"
          style={{ zIndex: 10, cursor: 'pointer' }}
          onDoubleClick={undefined}
        />
      )}

      {/* Click flash feedback — centered play/pause icon that fades out */}
      {clickFlash && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ zIndex: 20 }}
        >
          <div
            key={clickFlash.key}
            style={{
              width: 72, height: 72,
              borderRadius: '50%',
              background: 'rgba(0,0,0,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: 'sw-click-flash 0.6s ease-out forwards',
            }}
          >
            {clickFlash.type === 'play' ? (
              <svg width="36" height="36" fill="white" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg width="36" height="36" fill="white" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Seek flash — double-tap left/right feedback */}
      {seekFlash && (
        <div key={seekFlash.key} style={{
          position: 'absolute', top: '50%', [seekFlash.dir === 'left' ? 'left' : 'right']: '15%',
          transform: 'translateY(-50%)', pointerEvents: 'none', zIndex: 21,
          animation: 'sw-click-flash 0.6s ease-out forwards',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
          color: 'rgba(255,255,255,0.9)', fontSize: '0.8rem', fontWeight: 700,
        }}>
          <span style={{ fontSize: '1.5rem' }}>{seekFlash.dir === 'left' ? '◀◀' : '▶▶'}</span>
          <span>10 сек</span>
        </div>
      )}

      {/* Buffering Spinner */}
      {buffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
          <div
            className="w-12 h-12 border-4 rounded-full animate-spin"
            style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: '#7c6ff7' }}
          />
        </div>
      )}

      {/* Sync Status Badge */}
      <div
        className="absolute top-3 right-3 flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium"
        style={{ background: 'rgba(0,0,0,0.6)', zIndex: 20 }}
      >
        <div
          className="w-2 h-2 rounded-full"
          style={{ background: syncColors[syncStatus], boxShadow: `0 0 6px ${syncColors[syncStatus]}` }}
        />
        <span className="text-white/80">{syncStatus}</span>
      </div>

      {/* Controls Overlay — hidden for embed (iframe has its own controls) */}
      {!isEmbed && <div
        data-controls="true"
        className="absolute inset-x-0 bottom-0 p-4 transition-opacity duration-300"
        style={{
          background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
          opacity: showControls ? 1 : 0,
          pointerEvents: showControls ? 'auto' : 'none',
          zIndex: 20,
        }}
      >
        {/* Progress Bar */}
        <div className="mb-3">
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={(e) => handleSeek(parseFloat(e.target.value))}
            className="w-full cursor-pointer"
            style={{
              height: '20px',
              background: `linear-gradient(to right, #7c6ff7 0%, #7c6ff7 ${progressPercent}%, rgba(255,255,255,0.25) ${progressPercent}%, rgba(255,255,255,0.25) 100%)`,
            }}
          />
        </div>

        {/* Control Buttons */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Play/Pause */}
            <button
              onClick={handlePlayPauseClick}
              className="text-white hover:text-primary transition-colors"
              title="Space"
              tabIndex={-1}
              style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              {isPlaying ? (
                <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Volume */}
            <div className="flex items-center gap-2">
              <button onClick={toggleMute} className="text-white hover:text-primary transition-colors" title="M" tabIndex={-1} style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {isMuted || volume === 0 ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="w-20 cursor-pointer"
              />
            </div>

            {/* Captions toggle */}
            <button onClick={toggleCaptions} className="text-white hover:text-primary transition-colors" title="C" tabIndex={-1}
              style={{ minWidth: 40, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: captionsOn ? 1 : 0.4 }}>
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19.5 4.5H4.5C3.12 4.5 2 5.62 2 7v10c0 1.38 1.12 2.5 2.5 2.5h15c1.38 0 2.5-1.12 2.5-2.5V7c0-1.38-1.12-2.5-2.5-2.5zM4.5 6.5h15c.28 0 .5.22.5.5v10c0 .28-.22.5-.5.5h-15c-.28 0-.5-.22-.5-.5V7c0-.28.22-.5.5-.5zm2 3h3v5h-3v-5zm5 0h6v1.5h-6V9.5zm0 2.5h4v1.5h-4V12z"/>
              </svg>
            </button>

            {/* Time */}
            <span className="text-white/70 text-xs font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Speed presets (only for non-YouTube) */}
            {!isYT && [0.5, 1, 1.5, 2].map((rate) => (
              <button
                key={rate}
                onClick={(e) => {
                  e.stopPropagation();
                  if (videoRef.current) videoRef.current.playbackRate = rate;
                  sendVideoAction('rate_change', videoRef.current?.currentTime);
                }}
                className="text-xs font-medium transition-colors"
                style={{ color: videoRef.current?.playbackRate === rate ? '#7c6ff7' : 'rgba(255,255,255,0.5)' }}
                tabIndex={-1}
              >
                {rate}×
              </button>
            ))}

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="text-white hover:text-primary transition-colors" title="F" tabIndex={-1} style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {isFullscreen ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>}
    </div>
  );
};

VideoPlayer.propTypes = {
  src: PropTypes.string,
  srcType: PropTypes.string,
  roomId: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  isOwner: PropTypes.bool,
  wsConnected: PropTypes.bool,
  sendMessage: PropTypes.func.isRequired,
  syncState: PropTypes.object,
  onTimeUpdate: PropTypes.func,
  className: PropTypes.string,
};

VideoPlayer.defaultProps = {
  isOwner: false,
  wsConnected: false,
  srcType: 'direct',
  className: '',
};

export default VideoPlayer;
