// src/components/VideoPlayer.js
import React, { useEffect, useState } from 'react';

const VideoPlayer = () => {
  const [queue, setQueue] = useState([]);
  const [currentVideo, setCurrentVideo] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [error, setError] = useState('');

  // Extract YouTube ID from URL
  const extractYouTubeId = (url) => {
    const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
    const match = url.match(regex);
    return match ? match[1] : null;
  };

  // Add video to queue
  const addVideoToQueue = () => {
    if (!inputUrl.trim()) {
      setError('Please enter a valid YouTube URL');
      return;
    }

    const videoId = extractYouTubeId(inputUrl);
    if (!videoId) {
      setError('Invalid YouTube URL');
      return;
    }

    setError('');
    fetch('/api/add-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: inputUrl }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setInputUrl('');
        } else {
          setError(data.error || 'Failed to add video');
        }
      })
      .catch(() => setError('Network error'));
  };

  // WebSocket connection
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:3000/ws');

    ws.onopen = () => {
      console.log('Connected to WebSocket server');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.queue && Array.isArray(data.queue)) {
          setQueue(data.queue);
          if (!currentVideo && data.queue.length > 0) {
            setCurrentVideo(data.queue[0]);
          }
        }
      } catch (e) {
        console.error('WebSocket message parse error:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    return () => ws.close();
  }, [currentVideo]);

  // Fetch initial queue
  useEffect(() => {
    fetch('/api/video-queue')
      .then((res) => res.json())
      .then((data) => {
        setQueue(data.queue);
        if (data.queue.length > 0 && !currentVideo) {
          setCurrentVideo(data.queue[0]);
        }
      })
      .catch((err) => console.error('Failed to load queue:', err));
  }, []);

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h2>YouTube Queue Player</h2>

      {/* Video Player */}
      <div style={{ marginBottom: '20px', position: 'relative', paddingBottom: '56.25%', height: '0', overflow: 'hidden' }}>
        {currentVideo ? (
          <iframe
            src={`https://www.youtube.com/embed/${currentVideo}?autoplay=1`}
            title="YouTube video player"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
          />
        ) : (
          <div style={{ color: '#999', textAlign: 'center', lineHeight: '200px' }}>
            No video in queue
          </div>
        )}
      </div>

      {/* Add Video Form */}
      <div style={{ marginBottom: '20px' }}>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          placeholder="Enter YouTube URL (e.g., https://youtu.be/dQw4w9WgXcQ)"
          style={{ width: '70%', padding: '10px', marginRight: '10px' }}
          onKeyPress={(e) => e.key === 'Enter' && addVideoToQueue()}
        />
        <button onClick={addVideoToQueue} style={{ padding: '10px 20px' }}>
          Add to Queue
        </button>
      </div>

      {error && <p style={{ color: 'red' }}>{error}</p>}

      {/* Queue List */}
      <div>
        <h3>Queue ({queue.length})</h3>
        {queue.length === 0 ? (
          <p style={{ color: '#aaa' }}>No videos in queue</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {queue.map((videoId, index) => (
              <li key={index} style={{ marginBottom: '8px', padding: '8px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
                <span style={{ fontWeight: 'bold' }}>#{index + 1}</span> —{' '}
                <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noopener noreferrer">
                  {videoId}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default VideoPlayer;