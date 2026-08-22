import React, { useRef, useEffect, useState, useCallback } from 'react';
import PropTypes from 'prop-types';

const SYNC_THRESHOLD = 0.1; // 100ms
const SYNC_CHECK_INTERVAL = 1000; // 1 second

export const VideoPlayer = ({
  src,
  roomId,
  userId,
  isOwner,
  wsConnected,
  sendMessage,
  syncState,
  onTimeUpdate,
  className = ''
}) => {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [buffering, setBuffering] = useState(false);
  
  const controlsTimeoutRef = useRef(null);
  const lastActionRef = useRef(0);
  const isSyncingRef = useRef(false);

  // Handle incoming sync state
  useEffect(() => {
    if (!syncState || !videoRef.current || isOwner) return;

    const video = videoRef.current;
    const { state, adjusted_time } = syncState;

    // Don't sync if we recently performed an action
    if (Date.now() - lastActionRef.current < 500) return;

    isSyncingRef.current = true;

    try {
      // Sync play/pause state
      if (state.is_playing && video.paused) {
        video.play().catch(() => {});
      } else if (!state.is_playing && !video.paused) {
        video.pause();
      }

      // Sync time if drift is significant
      const timeDiff = Math.abs(video.currentTime - adjusted_time);
      if (timeDiff > SYNC_THRESHOLD) {
        // Smooth sync - adjust playback rate temporarily
        if (timeDiff > 2) {
          // Large drift - seek immediately
          video.currentTime = adjusted_time;
        } else {
          // Small drift - adjust playback rate
          const rate = video.currentTime < adjusted_time ? 1.05 : 0.95;
          video.playbackRate = rate;
          
          // Reset rate after catching up
          setTimeout(() => {
            if (videoRef.current) {
              videoRef.current.playbackRate = state.playback_rate || 1;
            }
          }, 1000);
        }
      }

      // Sync playback rate
      if (video.playbackRate !== state.playback_rate) {
        video.playbackRate = state.playback_rate || 1;
      }

    } finally {
      isSyncingRef.current = false;
    }
  }, [syncState, isOwner]);

  // Send video action to server
  const sendVideoAction = useCallback((action, time = null) => {
    if (!wsConnected || !roomId) return;

    lastActionRef.current = Date.now();

    sendMessage({
      type: 'video_action',
      room_id: roomId,
      user_id: userId,
      payload: {
        action,
        time: time ?? videoRef.current?.currentTime ?? 0,
        rate: videoRef.current?.playbackRate ?? 1,
        version: Date.now()
      },
      timestamp: Date.now()
    });
  }, [wsConnected, roomId, userId, sendMessage]);

  // Video event handlers
  const handlePlay = useCallback(() => {
    if (isSyncingRef.current) return;
    
    setIsPlaying(true);
    if (isOwner) {
      sendVideoAction('play');
    }
  }, [isOwner, sendVideoAction]);

  const handlePause = useCallback(() => {
    if (isSyncingRef.current) return;
    
    setIsPlaying(false);
    if (isOwner) {
      sendVideoAction('pause');
    }
  }, [isOwner, sendVideoAction]);

  const handleSeek = useCallback((time) => {
    if (isSyncingRef.current) return;
    
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
    
    if (isOwner) {
      sendVideoAction('seek', time);
    }
  }, [isOwner, sendVideoAction]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    setCurrentTime(video.currentTime);
    onTimeUpdate?.(video.currentTime);

    // Periodic sync check for owner
    if (isOwner && Math.floor(video.currentTime) % 5 === 0) {
      sendVideoAction('sync', video.currentTime);
    }
  }, [isOwner, onTimeUpdate, sendVideoAction]);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      setDuration(video.duration);
    }
  }, []);

  const handleWaiting = useCallback(() => {
    setBuffering(true);
  }, []);

  const handleCanPlay = useCallback(() => {
    setBuffering(false);
  }, []);

  const handleVolumeChange = useCallback((newVolume) => {
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
    setIsMuted(newVolume === 0);
  }, []);

  const toggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  }, [isMuted]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  }, []);

  // Show/hide controls
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    
    clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  }, [isPlaying]);

  // Format time display
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div 
      ref={containerRef}
      className={`relative group bg-black rounded-lg overflow-hidden ${className}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        src={src}
        className="w-full h-full object-contain"
        onPlay={handlePlay}
        onPause={handlePause}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onWaiting={handleWaiting}
        onCanPlay={handleCanPlay}
        playsInline
      />

      {/* Buffering Indicator */}
      {buffering && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" />
        </div>
      )}

      {/* Controls Overlay */}
      <div 
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Progress Bar */}
        <div className="mb-4">
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={(e) => handleSeek(parseFloat(e.target.value))}
            className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer hover:bg-white/50 transition-colors"
            style={{
              background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${(currentTime / duration) * 100}%, rgba(255,255,255,0.3) ${(currentTime / duration) * 100}%, rgba(255,255,255,0.3) 100%)`
            }}
          />
        </div>

        {/* Control Buttons */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Play/Pause */}
            <button
              onClick={() => isPlaying ? videoRef.current?.pause() : videoRef.current?.play()}
              className="text-white hover:text-blue-400 transition-colors"
            >
              {isPlaying ? (
                <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
                </svg>
              ) : (
                <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              )}
            </button>

            {/* Time Display */}
            <span className="text-white text-sm font-mono">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Volume */}
            <div className="flex items-center gap-2">
              <button onClick={toggleMute} className="text-white hover:text-blue-400">
                {isMuted ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  </svg>
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="w-20 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer"
              />
            </div>

            {/* Fullscreen */}
            <button 
              onClick={toggleFullscreen}
              className="text-white hover:text-blue-400 transition-colors"
            >
              <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Sync Indicator */}
      {!isOwner && wsConnected && (
        <div className="absolute top-4 right-4 flex items-center gap-2 bg-black/50 px-3 py-1 rounded-full">
          <div className={`w-2 h-2 rounded-full ${syncState ? 'bg-green-500' : 'bg-yellow-500'} animate-pulse`} />
          <span className="text-white text-xs">
            {syncState ? 'Synced' : 'Syncing...'}
          </span>
        </div>
      )}
    </div>
  );
};

VideoPlayer.propTypes = {
  src: PropTypes.string.isRequired,
  roomId: PropTypes.string.isRequired,
  userId: PropTypes.string.isRequired,
  isOwner: PropTypes.bool,
  wsConnected: PropTypes.bool,
  sendMessage: PropTypes.func.isRequired,
  syncState: PropTypes.object,
  onTimeUpdate: PropTypes.func,
  className: PropTypes.string
};

VideoPlayer.defaultProps = {
  isOwner: false,
  wsConnected: false,
  className: ''
};

export default VideoPlayer;
