import React, { useRef, useState } from 'react';

// Lazy-loaded tab content for Player (React.lazy code-split).
// Receives the full Player scope via the `p` bundle so the tab JSX stays intact.
export default function PlayerTabs({ p }) {
  const { activeTab, activeBroadcaster, activeVoice, broadcastAudioDevice, broadcastAudioDevices, broadcastBitrate, broadcastSourceId, addToQueue, addVideoUrl, audioDevices, audioSettings, cacheAllQueue, cancelUpload, changeAudioSettings, changeInputDevice, changeOutputDevice, chatEndRef, chatFileRef, chatInput, chatUploading, clearQueue, currentVideo, deleteCacheJob, deleteMessage, disableProxyMode, dragItemRef, dragOverItemRef, editingMsg, enableProxyMode, fetchShorts, fileInputRef, getCacheJobForItem, getItemThumbnail, handleChatFileAttach, handleUpload, inputLevel, isOwner, jumpToVideo, localBlobRef, members, messages, myId, openDM, openSections, playNext, previewVisible, proxyLoading, proxyMode, queue, queueLoading, queueSearch, recording, refreshDevices, refreshQueue, removeFromQueue, reorderQueue, room, roomId, screenSources, selectedInput, selectedOutput, sendChat, sendMessage, setAddVideoUrl, setBroadcastAudioDevice, setBroadcastBitrate, setBroadcastSourceId, setChatInput, setCurrentVideo, setEditingMsg, setInitialState, setPreviewVisible, setQueueSearch, setShortsChannel, setStreamQuality, setSubExtractOpen, setSubFormat, setSubLoading, setSubResult, setSubStreamIndex, setSyncSettings, setTranscodeLoading, setTranscodeOpen, setTranscodeQuality, setTranscodeToast, setUploadFile, setVoiceMode, setVoiceSettingsOpen, shortsChannel, shortsLoading, startCaching, startRecording, startStreaming, startStreamingPlayer, stopRecording, stopStreaming, streaming, streamQuality, subExtractOpen, subFormat, subLoading, subResult, subStreamIndex, submitEditMessage, syncSettings, t, token, toggleSection, transcodeLoading, transcodeOpen, transcodeQuality, transcodeToast, typingDebounceRef, typingUsers, uploadFile, uploading, uploadProgress, username, voiceMode } = p;

  // Pull-to-refresh for the queue tab (mobile bottom sheet)
  const [pullDist, setPullDist] = useState(0);
  const pullStartYRef = useRef(null);
  const onQueueTouchStart = (e) => {
    if (e.currentTarget.scrollTop <= 0) pullStartYRef.current = e.touches[0].clientY;
  };
  const onQueueTouchMove = (e) => {
    if (pullStartYRef.current == null) return;
    const dy = e.touches[0].clientY - pullStartYRef.current;
    if (dy > 0 && e.currentTarget.scrollTop <= 0) setPullDist(Math.min(dy * 0.5, 80));
  };
  const onQueueTouchEnd = () => {
    if (pullDist > 50) {
      setPullDist(40);
      refreshQueue();
      setTimeout(() => setPullDist(0), 600);
    } else {
      setPullDist(0);
    }
    pullStartYRef.current = null;
  };
  return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Video tab */}
        {activeTab === 'video' && (
          <div style={{ padding: '0.75rem', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '0' }}>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={(e) => setUploadFile(e.target.files[0] || null)}
              style={{ display: 'none' }}
              id="video-upload-input"
            />

            {/* ACCORDION: Добавить видео */}
            <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: '0.1rem' }}>
              <div onClick={() => toggleSection('add')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '0.5rem 0', userSelect: 'none' }}>
                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Добавить видео</div>
                <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.7rem' }}>{openSections.add ? '▲' : '▼'}</span>
              </div>
              {openSections.add && (
                <div style={{ paddingBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {/* URL + file button in one row */}
                  <form onSubmit={addToQueue} style={{ display: 'flex', gap: '0.3rem' }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const file = e.dataTransfer.files[0];
                      if (file && file.type.startsWith('video/')) setUploadFile(file);
                    }}
                  >
                    <input
                      className="input-base"
                      placeholder="URL или YouTube..."
                      value={addVideoUrl}
                      onChange={(e) => setAddVideoUrl(e.target.value)}
                      style={{ flex: 1, fontSize: '0.78rem' }}
                    />
                    <label htmlFor="video-upload-input" title="Загрузить файл" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '0.9rem', flexShrink: 0 }}>📎</label>
                    <button className="btn-primary" type="submit" disabled={queueLoading} style={{ fontSize: '0.75rem', whiteSpace: 'nowrap', padding: '0 0.6rem' }}>
                      {queueLoading ? '...' : '+'}
                    </button>
                  </form>
                  {/* File selected block */}
                  {uploadFile && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                      <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        📁 {uploadFile.name}
                      </div>
                      {!uploading && (
                        <button
                          onClick={() => {
                            if (localBlobRef.current) URL.revokeObjectURL(localBlobRef.current);
                            const blobUrl = URL.createObjectURL(uploadFile);
                            localBlobRef.current = blobUrl;
                            const title = uploadFile.name;
                            setCurrentVideo({ src: blobUrl, video_url: blobUrl, video_source: 'direct', type: 'direct', title });
                            setInitialState(null);
                            setUploadFile(null);
                            if (fileInputRef.current) fileInputRef.current.value = '';
                            sendMessage({ type: 'video_action', payload: { action: 'host_watching_locally', title }, timestamp: Date.now() });
                          }}
                          style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: '6px', padding: '0.3rem 0.5rem', cursor: 'pointer', color: '#4ade80', fontSize: '0.75rem', fontWeight: 500 }}
                        >
                          ▶ Смотреть только локально
                        </button>
                      )}
                      <div style={{ display: 'flex', gap: '0.3rem' }}>
                        <button
                          className="btn-primary"
                          onClick={handleUpload}
                          disabled={uploading}
                          style={{ fontSize: '0.75rem', flex: 1 }}
                        >
                          {uploading ? `Загрузка... ${uploadProgress}%` : 'Загрузить'}
                        </button>
                        {uploading && (
                          <button
                            onClick={cancelUpload}
                            style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '6px', padding: '0.3rem 0.5rem', cursor: 'pointer', color: '#f87171', fontSize: '0.75rem', flexShrink: 0 }}
                          >✕</button>
                        )}
                      </div>
                      {uploadProgress > 0 && uploadProgress < 100 && (
                        <div style={{ height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
                          <div style={{ height: '100%', width: `${uploadProgress}%`, background: '#7c6ff7', borderRadius: 2, transition: 'width 0.3s' }} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ACCORDION: Текущее видео (proxy + transcode + subtitles) */}
            {currentVideo && (
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: '0.1rem' }}>
                <div onClick={() => toggleSection('current')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '0.5rem 0', userSelect: 'none' }}>
                  <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Текущее видео</div>
                  <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.7rem' }}>{openSections.current ? '▲' : '▼'}</span>
                </div>
                {openSections.current && (
                  <div style={{ paddingBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {/* Proxy mode */}
                    <div>
                      <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', marginBottom: '0.35rem', lineHeight: 1.4 }}>
                        Маршрутизирует видео через сервер — обходит CORS и гео-блокировки
                      </div>
                      {(currentVideo?.type === 'youtube' || currentVideo?.type === 'embed' || currentVideo?.type === 'twitch' || currentVideo?.video_source === 'youtube' || currentVideo?.video_source === 'embed' || currentVideo?.video_source === 'twitch') ? (
                        <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '6px', padding: '0.35rem 0.6rem', color: 'rgba(255,255,255,0.3)', fontSize: '0.72rem', textAlign: 'center' }}>
                          🛡 Прокси недоступен — только для прямых ссылок (MP4/HLS)
                        </div>
                      ) : (<>
                        {!proxyMode ? (
                          <button
                            onClick={enableProxyMode}
                            disabled={proxyLoading}
                            style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '0.35rem 0.6rem', cursor: 'pointer', color: 'rgba(255,255,255,0.55)', fontSize: '0.78rem', fontWeight: 500 }}
                          >
                            {proxyLoading ? '...' : '🛡 Включить прокси'}
                          </button>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                            <div style={{ background: 'rgba(124,111,247,0.15)', border: '1px solid rgba(124,111,247,0.4)', borderRadius: '6px', padding: '0.35rem 0.6rem', color: '#a78bfa', fontSize: '0.78rem', fontWeight: 600 }}>
                              🛡 Прокси активен
                            </div>
                            <button
                              onClick={disableProxyMode}
                              style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '6px', padding: '0.3rem 0.6rem', cursor: 'pointer', color: '#f87171', fontSize: '0.72rem' }}
                            >
                              Отключить прокси
                            </button>
                          </div>
                        )}
                      </>)}
                    </div>

                    {/* Transcode panel */}
                    {currentVideo?.video_url?.includes('/api/v1/videos/stream/') && (
                      <div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '0.35rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          🎬 Транскодирование
                        </div>
                        {!transcodeOpen ? (
                          <button
                            onClick={() => setTranscodeOpen(true)}
                            style={{ width: '100%', background: 'rgba(124,111,247,0.08)', border: '1px solid rgba(124,111,247,0.2)', borderRadius: '6px', padding: '0.35rem 0.6rem', cursor: 'pointer', color: 'rgba(255,255,255,0.55)', fontSize: '0.78rem', textAlign: 'left' }}
                          >
                            Транскодировать / конвертировать файл
                          </button>
                        ) : (
                          <div style={{ background: 'rgba(124,111,247,0.06)', border: '1px solid rgba(124,111,247,0.2)', borderRadius: '8px', padding: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {(() => {
                              const template = transcodeQuality <= 33 ? 'hls_adaptive' : transcodeQuality <= 66 ? 'mp4_1080p' : 'mp4_720p';
                              const label = transcodeQuality <= 33 ? 'HLS Adaptive (360p/720p/1080p — лучшее качество)' : transcodeQuality <= 66 ? 'MP4 1080p (хорошее качество)' : 'MP4 720p (быстрее)';
                              const estMin = transcodeQuality <= 33 ? '~15 мин/ГБ' : transcodeQuality <= 66 ? '~8 мин/ГБ' : '~4 мин/ГБ';
                              return (
                                <>
                                  <label style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)' }}>
                                    Качество / скорость: <b style={{ color: '#a78bfa' }}>{transcodeQuality}</b>
                                    <input type="range" min={0} max={100} step={1} value={transcodeQuality}
                                      onChange={e => setTranscodeQuality(parseInt(e.target.value))}
                                      style={{ display: 'block', width: '100%', marginTop: '0.2rem' }} />
                                    <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>
                                      0 = лучшее качество&nbsp;&nbsp;100 = быстрее всего
                                    </span>
                                  </label>
                                  <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', background: 'rgba(0,0,0,0.2)', borderRadius: '5px', padding: '0.3rem 0.5rem' }}>
                                    📦 {label}<br />⏱ Оценка: {estMin}
                                  </div>
                                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                                    <button
                                      disabled={transcodeLoading}
                                      onClick={async () => {
                                        if (!currentVideo?.video_url) return;
                                        setTranscodeLoading(true);
                                        try {
                                          const videoKey = currentVideo.video_url.replace('/api/v1/videos/stream/', '');
                                          const res = await fetch('/api/v1/transcode', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                                            body: JSON.stringify({ video_id: videoKey, input_url: currentVideo.video_url, template, room_id: roomId }),
                                          });
                                          if (res.ok) {
                                            setTranscodeToast({ msg: `Задание поставлено в очередь (${template})`, type: 'success' });
                                            setTimeout(() => setTranscodeToast(null), 5000);
                                            setTranscodeOpen(false);
                                          } else {
                                            const d = await res.json();
                                            setTranscodeToast({ msg: d.message || 'Ошибка постановки задания', type: 'error' });
                                            setTimeout(() => setTranscodeToast(null), 6000);
                                          }
                                        } catch { setTranscodeToast({ msg: 'Сетевая ошибка', type: 'error' }); setTimeout(() => setTranscodeToast(null), 6000); }
                                        setTranscodeLoading(false);
                                      }}
                                      style={{ flex: 1, background: 'linear-gradient(135deg,#7c6ff7,#a78bfa)', border: 'none', borderRadius: '6px', padding: '0.38rem 0.6rem', cursor: 'pointer', color: '#fff', fontSize: '0.78rem', fontWeight: 600, opacity: transcodeLoading ? 0.6 : 1 }}
                                    >
                                      {transcodeLoading ? 'Отправка...' : '▶ Транскодировать'}
                                    </button>
                                    <button onClick={() => setTranscodeOpen(false)}
                                      style={{ background: 'none', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.38rem 0.5rem', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: '0.78rem' }}>
                                      ✕
                                    </button>
                                  </div>
                                </>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Subtitle extraction */}
                    {currentVideo?.video_url && (
                      <div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '0.35rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                          📝 Субтитры
                        </div>
                        {!subExtractOpen ? (
                          <button
                            onClick={() => { setSubExtractOpen(true); setSubResult(null); }}
                            style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '0.35rem 0.6rem', cursor: 'pointer', color: 'rgba(255,255,255,0.55)', fontSize: '0.78rem', fontWeight: 500 }}
                          >
                            Извлечь субтитры из видео
                          </button>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                              <label style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', flex: 1 }}>
                                Дорожка (0-based)
                                <input type="number" min={0} max={9} value={subStreamIndex} onChange={e => setSubStreamIndex(parseInt(e.target.value) || 0)}
                                  style={{ display: 'block', width: '100%', marginTop: '0.15rem', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '5px', color: '#e2e8f0', padding: '0.3rem 0.4rem', fontSize: '0.78rem' }}
                                />
                              </label>
                              <label style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', flex: 1 }}>
                                Формат
                                <select value={subFormat} onChange={e => setSubFormat(e.target.value)}
                                  style={{ display: 'block', width: '100%', marginTop: '0.15rem', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '5px', color: '#e2e8f0', padding: '0.3rem 0.4rem', fontSize: '0.78rem', cursor: 'pointer' }}>
                                  <option value="srt">SRT</option>
                                  <option value="vtt">VTT</option>
                                  <option value="ass">ASS</option>
                                </select>
                              </label>
                            </div>
                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                              <button
                                disabled={subLoading}
                                onClick={async () => {
                                  if (!currentVideo?.video_url) return;
                                  setSubLoading(true);
                                  setSubResult(null);
                                  try {
                                    const res = await fetch('/api/v1/transcode/extract-subtitles', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                                      body: JSON.stringify({ input_url: currentVideo.video_url, stream_index: subStreamIndex, format: subFormat }),
                                    });
                                    const data = await res.json();
                                    if (res.ok) setSubResult(data);
                                    else setSubResult({ error: data.message || 'Ошибка извлечения' });
                                  } catch { setSubResult({ error: 'Сетевая ошибка' }); }
                                  setSubLoading(false);
                                }}
                                style={{ flex: 1, background: 'linear-gradient(135deg,#7c6ff7,#a78bfa)', border: 'none', borderRadius: '6px', padding: '0.38rem 0.6rem', cursor: 'pointer', color: '#fff', fontSize: '0.78rem', fontWeight: 600, opacity: subLoading ? 0.6 : 1 }}
                              >
                                {subLoading ? 'Извлечение...' : 'Извлечь'}
                              </button>
                              <button onClick={() => { setSubExtractOpen(false); setSubResult(null); }}
                                style={{ background: 'none', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.38rem 0.5rem', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: '0.78rem' }}>
                                ✕
                              </button>
                            </div>
                            {subResult && !subResult.error && (
                              <a href={subResult.url} download={subResult.filename} style={{ display: 'block', background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: '6px', padding: '0.35rem 0.6rem', color: '#4ade80', fontSize: '0.75rem', textDecoration: 'none', textAlign: 'center', fontWeight: 600 }}>
                                ⬇ Скачать {subResult.filename}
                              </a>
                            )}
                            {subResult?.error && (
                              <div style={{ fontSize: '0.75rem', color: '#f87171', background: 'rgba(248,113,113,0.1)', borderRadius: '6px', padding: '0.35rem 0.6rem' }}>
                                {subResult.error}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ACCORDION: Трансляция */}
            <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: '0.1rem' }}>
              <div onClick={() => toggleSection('stream')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '0.5rem 0', userSelect: 'none' }}>
                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>📺 Трансляция</div>
                <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.7rem' }}>{openSections.stream ? '▲' : '▼'}</span>
              </div>
              {openSections.stream && (
                <div style={{ paddingBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <select
                      value={streamQuality}
                      onChange={e => setStreamQuality(e.target.value)}
                      style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.3rem 0.4rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.72rem', cursor: 'pointer' }}
                    >
                      {[['480p30','480p 30fps'],['480p60','480p 60fps'],['720p30','720p 30fps'],['720p60','720p 60fps'],['1080p30','1080p 30fps'],['1080p60','1080p 60fps'],['1440p30','1440p 30fps'],['1440p60','1440p 60fps'],['4k30','4K 30fps'],['4k60','4K 60fps']].map(([v,l]) => (
                        <option key={v} value={v} style={{ background: '#1a1a2e', color: 'rgba(255,255,255,0.85)' }}>{l}</option>
                      ))}
                    </select>
                    {streaming && (
                      <button
                        onClick={() => { const v = !previewVisible; setPreviewVisible(v); localStorage.setItem('sw_preview_show', v ? '1' : '0'); }}
                        style={{ background: previewVisible ? 'rgba(124,111,247,0.2)' : 'rgba(255,255,255,0.07)', border: `1px solid ${previewVisible ? 'rgba(124,111,247,0.5)' : 'rgba(255,255,255,0.12)'}`, borderRadius: '6px', padding: '0.3rem 0.5rem', cursor: 'pointer', color: previewVisible ? '#7c6ff7' : 'rgba(255,255,255,0.4)', fontSize: '0.72rem', whiteSpace: 'nowrap' }}
                        title="Показать/скрыть превью трансляции"
                      >👁</button>
                    )}
                  </div>
                  {/* Broadcast settings: bitrate + audio capture device */}
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <select
                      value={broadcastBitrate}
                      onChange={e => setBroadcastBitrate(parseInt(e.target.value, 10))}
                      title="Битрейт трансляции"
                      style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.3rem 0.4rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.72rem', cursor: 'pointer', minWidth: '90px' }}
                    >
                      {[['1000000','1 Мбит/с'],['2000000','2 Мбит/с'],['3000000','3 Мбит/с'],['4000000','4 Мбит/с'],['6000000','6 Мбит/с'],['8000000','8 Мбит/с'],['12000000','12 Мбит/с'],['16000000','16 Мбит/с'],['24000000','24 Мбит/с'],['32000000','32 Мбит/с'],['48000000','48 Мбит/с'],['64000000','64 Мбит/с'],['100000000','100 Мбит/с'],['150000000','150 Мбит/с'],['200000000','200 Мбит/с'],['300000000','300 Мбит/с'],['400000000','400 Мбит/с'],['500000000','500 Мбит/с']].map(([v,l]) => (
                        <option key={v} value={v} style={{ background: '#1a1a2e', color: 'rgba(255,255,255,0.85)' }}>{l}</option>
                      ))}
                    </select>
                    <select
                      value={broadcastAudioDevice}
                      onChange={e => setBroadcastAudioDevice(e.target.value)}
                      title="Аудиоустройство захвата"
                      style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.3rem 0.4rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.72rem', cursor: 'pointer', minWidth: '110px' }}
                    >
                      <option value="system" style={{ background: '#1a1a2e', color: 'rgba(255,255,255,0.85)' }}>🔊 Системный звук</option>
                      {broadcastAudioDevices.map(d => (
                        <option key={d.id} value={d.id} style={{ background: '#1a1a2e', color: 'rgba(255,255,255,0.85)' }}>🎙 {d.name}</option>
                      ))}
                    </select>
                  </div>
                  {screenSources.length > 0 && (
                    <select
                      value={broadcastSourceId}
                      onChange={e => setBroadcastSourceId(e.target.value)}
                      title="Экран или окно приложения для захвата"
                      style={{ width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.3rem 0.4rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.72rem', cursor: 'pointer' }}
                    >
                      <option value="" style={{ background: '#1a1a2e', color: 'rgba(255,255,255,0.85)' }}>🖥 Экран по умолчанию</option>
                      {screenSources.map(s => (
                        <option key={s.id} value={s.id} style={{ background: '#1a1a2e', color: 'rgba(255,255,255,0.85)' }}>{s.name}</option>
                      ))}
                    </select>
                  )}
                  {!streaming ? (
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <button onClick={() => startStreaming('screen')} style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.35rem 0.5rem', cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontSize: '0.75rem' }}>
                        📺 Экран
                      </button>
                      <button onClick={() => startStreaming('camera')} style={{ flex: 1, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.35rem 0.5rem', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>
                        📷 Камера
                      </button>
                      {(() => {
                        const t = currentVideo?.type || currentVideo?.video_source || '';
                        const canCapture = t !== 'youtube' && t !== 'embed' && t !== 'twitch' && t !== 'kodik' && !!currentVideo;
                        return (
                          <button
                            onClick={startStreamingPlayer}
                            disabled={!canCapture}
                            title={canCapture ? 'Транслировать видео из плеера напрямую (без захвата экрана)' : 'Недоступно для YouTube/embed источников'}
                            style={{ flex: 1, background: canCapture ? 'rgba(124,111,247,0.12)' : 'rgba(255,255,255,0.03)', border: `1px solid ${canCapture ? 'rgba(124,111,247,0.35)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '6px', padding: '0.35rem 0.5rem', cursor: canCapture ? 'pointer' : 'not-allowed', color: canCapture ? '#a78bfa' : 'rgba(255,255,255,0.2)', fontSize: '0.75rem', opacity: canCapture ? 1 : 0.5 }}
                          >
                            ▶ Плеер
                          </button>
                        );
                      })()}
                    </div>
                    ) : (
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <span style={{ background: 'rgba(255,107,157,0.15)', border: '1px solid rgba(255,107,157,0.35)', borderRadius: '6px', padding: '0.3rem 0.6rem', color: '#ff6b9d', fontSize: '0.75rem', fontWeight: 700 }}>● LIVE</span>
                      {!recording ? (
                        <button onClick={startRecording} style={{ flex: 1, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '6px', padding: '0.3rem 0.5rem', cursor: 'pointer', color: '#f87171', fontSize: '0.75rem' }}>⏺ Запись</button>
                      ) : (
                        <button onClick={stopRecording} style={{ flex: 1, background: 'rgba(248,113,113,0.2)', border: '1px solid rgba(248,113,113,0.5)', borderRadius: '6px', padding: '0.3rem 0.5rem', cursor: 'pointer', color: '#f87171', fontSize: '0.75rem', fontWeight: 600 }}>⏹ Стоп</button>
                      )}
                      <button onClick={stopStreaming} style={{ flex: 1, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '6px', padding: '0.3rem 0.5rem', cursor: 'pointer', color: '#f87171', fontSize: '0.75rem' }}>Завершить</button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ACCORDION: Настройки синхронизации (owner only) */}
            {isOwner && (
              <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: '0.1rem' }}>
                <div onClick={() => toggleSection('sync')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '0.5rem 0', userSelect: 'none' }}>
                  <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Настройки синхронизации</div>
                  <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.7rem' }}>{openSections.sync ? '▲' : '▼'}</span>
                </div>
                {openSections.sync && (
                  <div style={{ paddingBottom: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    <label style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)' }}>
                      Мягкий порог: <b style={{ color: '#7c6ff7' }}>{syncSettings.soft_threshold}с</b>
                      <input
                        type="range" min={0.1} max={2} step={0.1}
                        value={syncSettings.soft_threshold}
                        onChange={(e) => setSyncSettings(s => ({ ...s, soft_threshold: parseFloat(e.target.value) }))}
                        style={{ display: 'block', width: '100%', marginTop: '0.2rem' }}
                      />
                    </label>
                    <label style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)' }}>
                      Жёсткий порог: <b style={{ color: '#ff6b9d' }}>{syncSettings.hard_threshold}с</b>
                      <input
                        type="range" min={1} max={15} step={0.5}
                        value={syncSettings.hard_threshold}
                        onChange={(e) => setSyncSettings(s => ({ ...s, hard_threshold: parseFloat(e.target.value) }))}
                        style={{ display: 'block', width: '100%', marginTop: '0.2rem' }}
                      />
                    </label>
                    <button
                      onClick={() => {
                        sendMessage({
                          type: 'sync_settings_update',
                          room_id: roomId,
                          user_id: myId,
                          payload: { soft_threshold: syncSettings.soft_threshold, hard_threshold: syncSettings.hard_threshold },
                          timestamp: Date.now(),
                        });
                      }}
                      style={{ background: 'rgba(124,111,247,0.15)', border: '1px solid rgba(124,111,247,0.4)', borderRadius: '6px', padding: '0.35rem 0.6rem', cursor: 'pointer', color: '#a78bfa', fontSize: '0.78rem', fontWeight: 600 }}
                    >
                      Применить для всех
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ACCORDION: Зрители */}
            <div style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: '0.1rem' }}>
              <div onClick={() => toggleSection('members')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '0.5rem 0', userSelect: 'none' }}>
                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Зрители ({members.length})</div>
                <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.7rem' }}>{openSections.members ? '▲' : '▼'}</span>
              </div>
              {openSections.members && (
                <div style={{ paddingBottom: '0.75rem' }}>
                  {members.map((m) => (
                    <div key={m.user_id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)' }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: activeBroadcaster?.user_id === m.user_id ? '#ff6b9d' : '#4ade80', flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{m.username || m.user_id}</span>
                      {activeVoice.systemAudioPeers?.[m.user_id] && (
                        <span title="Транслирует системный звук" style={{ fontSize: '0.7rem' }}>🔊</span>
                      )}
                      {(m.user_id === room?.host_id) && (
                        <span style={{ fontSize: '0.62rem', color: '#7c6ff7' }}>(хост)</span>
                      )}
                      {activeBroadcaster?.user_id === m.user_id && (
                        <span style={{ fontSize: '0.62rem', color: '#ff6b9d' }}>
                          {activeBroadcaster.stream_type === 'camera' ? '📷' : activeBroadcaster.stream_type === 'player' ? '▶' : '📺'} стрим
                        </span>
                      )}
                      {token && m.user_id !== myId && (
                        <button onClick={() => openDM(m.user_id, m.username || m.user_id)} title="Написать в ЛС" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(124,111,247,0.5)', fontSize: '0.75rem', padding: '0', lineHeight: 1 }}>✉️</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Queue tab */}
        {activeTab === 'queue' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '0.6rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <form onSubmit={addToQueue} style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  className="input-base"
                  placeholder="URL видео (mp4, YouTube, animego.me...)"
                  value={addVideoUrl}
                  onChange={(e) => setAddVideoUrl(e.target.value)}
                  style={{ fontSize: '0.78rem' }}
                />
                <button className="btn-primary" type="submit" disabled={queueLoading} style={{ whiteSpace: 'nowrap', fontSize: '0.78rem', padding: '0.35rem 0.65rem' }}>
                  {queueLoading ? '...' : 'Добавить'}
                </button>
              </form>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  onClick={() => window.open(`/files?room=${roomId}`, '_blank')}
                  style={{ background: 'rgba(124,111,247,0.12)', border: '1px solid rgba(124,111,247,0.25)', borderRadius: '6px', color: '#a78bfa', cursor: 'pointer', fontSize: '0.75rem', padding: '0.25rem 0.6rem', whiteSpace: 'nowrap', flex: 1 }}
                >
                  📁 Файловый менеджер
                </button>
                <button
                  onClick={() => window.open(`/cache?room=${roomId}`, '_blank')}
                  style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)', borderRadius: '6px', color: '#4ade80', cursor: 'pointer', fontSize: '0.75rem', padding: '0.25rem 0.6rem', whiteSpace: 'nowrap', flex: 1 }}
                >
                  💾 Кеш
                </button>
              </div>
              {/* Shorts doomscroll */}
              <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                <input
                  className="input-base"
                  placeholder="@канал или хештег"
                  value={shortsChannel}
                  onChange={(e) => setShortsChannel(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && fetchShorts()}
                  style={{ fontSize: '0.72rem', flex: 1 }}
                />
                <button
                  onClick={fetchShorts}
                  disabled={shortsLoading}
                  style={{ background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '6px', color: '#f87171', cursor: 'pointer', fontSize: '0.72rem', padding: '0.25rem 0.5rem', whiteSpace: 'nowrap' }}
                >
                  {shortsLoading ? '...' : '📱 Shorts'}
                </button>
              </div>
              {queue.length > 0 && (
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <button onClick={playNext} style={{ background: 'rgba(124,111,247,0.15)', border: '1px solid rgba(124,111,247,0.3)', borderRadius: '6px', color: '#a78bfa', cursor: 'pointer', fontSize: '0.75rem', padding: '0.25rem 0.6rem', whiteSpace: 'nowrap' }}>
                    ▶ Следующее
                  </button>
                  <button onClick={cacheAllQueue} title="Кешировать всю очередь"
                    style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)', borderRadius: '6px', color: '#4ade80', cursor: 'pointer', fontSize: '0.7rem', padding: '0.25rem 0.4rem', whiteSpace: 'nowrap' }}>
                    💾 Всё
                  </button>
                  <button onClick={clearQueue} title="Очистить очередь"
                    style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: '6px', color: '#f87171', cursor: 'pointer', fontSize: '0.7rem', padding: '0.25rem 0.4rem', whiteSpace: 'nowrap' }}>
                    🗑
                  </button>
                  <input
                    className="input-base"
                    placeholder="Поиск..."
                    value={queueSearch}
                    onChange={(e) => setQueueSearch(e.target.value)}
                    style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', flex: 1 }}
                  />
                  {queueSearch && (
                    <button onClick={() => setQueueSearch('')} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 2px' }}>×</button>
                  )}
                </div>
              )}
            </div>
            <div
              onTouchStart={onQueueTouchStart}
              onTouchMove={onQueueTouchMove}
              onTouchEnd={onQueueTouchEnd}
              style={{ flex: 1, overflowY: 'auto', padding: '0.4rem' }}
            >
              {pullDist > 0 && (
                <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', fontSize: '0.72rem', height: pullDist, lineHeight: `${pullDist}px`, overflow: 'hidden', transition: 'height 0.1s ease' }}>
                  {pullDist > 50 ? '⬇ Отпустите, чтобы обновить' : '⬇ Потяните вниз'}
                </div>
              )}
              {/* Upload progress item */}
              {uploading && uploadFile && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.45rem 0.55rem', borderRadius: '6px', marginBottom: '0.2rem',
                  background: 'rgba(124,111,247,0.08)',
                  border: '1px solid rgba(124,111,247,0.2)',
                  userSelect: 'none',
                }}>
                  <div style={{ width: 44, height: 25, borderRadius: 3, background: 'rgba(124,111,247,0.15)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: 'rgba(124,111,247,0.6)' }}>
                    ↑
                  </div>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: '0.78rem', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '0.25rem' }}>
                      {uploadFile.name}
                    </div>
                    <div style={{ position: 'relative', height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{
                        position: 'absolute', left: 0, top: 0, height: '100%',
                        width: `${uploadProgress}%`,
                        background: 'linear-gradient(90deg, #7c6ff7, #a78bfa)',
                        borderRadius: '2px',
                        transition: 'width 0.2s ease',
                      }} />
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(124,111,247,0.7)', marginTop: '0.2rem' }}>
                      Загрузка {uploadProgress}%
                    </div>
                  </div>
                </div>
              )}
              {queue.length === 0 && !uploading && (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'rgba(255,255,255,0.25)', fontSize: '0.8rem' }}>
                  {t('player:queue_empty')}
                </div>
              )}
              {queue.filter(item => {
                if (!queueSearch) return true;
                const q = queueSearch.toLowerCase();
                return (item.title || item.video_url || '').toLowerCase().includes(q);
              }).map((item, idx) => (
                <div
                  key={item.id}
                  draggable
                  onDragStart={() => { dragItemRef.current = idx; }}
                  onDragEnter={() => { dragOverItemRef.current = idx; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnd={() => {
                    const from = dragItemRef.current;
                    const to = dragOverItemRef.current;
                    if (from === null || to === null || from === to) return;
                    const reordered = [...queue];
                    const [moved] = reordered.splice(from, 1);
                    reordered.splice(to, 0, moved);
                    dragItemRef.current = null;
                    dragOverItemRef.current = null;
                    reorderQueue(reordered);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                    padding: '0.45rem 0.55rem', borderRadius: '6px', marginBottom: '0.2rem',
                    background: currentVideo?.id === item.id ? 'rgba(124,111,247,0.15)' : 'rgba(255,255,255,0.04)',
                    cursor: 'grab',
                    userSelect: 'none',
                  }}
                  onClick={() => jumpToVideo(item)}
                >
                  <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.2)', cursor: 'grab', marginRight: '2px', letterSpacing: '-1px' }}>⠿</span>
                  <span style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', minWidth: '14px' }}>
                    {idx + 1}
                  </span>
                  {/* Thumbnail */}
                  {getItemThumbnail(item) ? (
                    <img
                      src={getItemThumbnail(item)}
                      alt=""
                      style={{ width: 44, height: 25, objectFit: 'cover', borderRadius: 3, flexShrink: 0, background: '#111' }}
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  ) : (
                    <div style={{ width: 44, height: 25, borderRadius: 3, background: 'rgba(255,255,255,0.06)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: 'rgba(255,255,255,0.2)' }}>
                      ▶
                    </div>
                  )}
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: '0.78rem', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.title || item.video_url}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)' }}>
                      {item.video_source || item.type}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); jumpToVideo(item, true); }}
                    title="Воспроизвести"
                    style={{ background: 'none', border: 'none', color: currentVideo?.id === item.id ? 'rgba(124,111,247,0.8)' : 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1, padding: '0 2px' }}
                  >
                    ▶
                  </button>
                  {/* Cache buttons */}
                  {(() => {
                    const cj = getCacheJobForItem(item);
                    if (!cj) return (
                      <button
                        onClick={(e) => { e.stopPropagation(); startCaching(item); }}
                        title="Закешировать поток"
                        style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.25)', cursor: 'pointer', fontSize: '0.75rem', lineHeight: 1, padding: '0 2px' }}
                      >💾</button>
                    );
                    if (cj.status === 'downloading' || cj.status === 'pending') return (
                      <span
                        title={`Кешируется: ${cj.progress}%`}
                        style={{ fontSize: '0.65rem', color: '#a78bfa', padding: '0 2px', cursor: 'default', minWidth: 28, textAlign: 'center' }}
                      >{cj.progress}%</span>
                    );
                    if (cj.status === 'done') return (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); jumpToVideo({ ...item, video_url: cj.cached_url, src: cj.cached_url, video_source: 'direct' }); }}
                          title="Воспроизвести из кеша"
                          style={{ background: 'none', border: 'none', color: '#4ade80', cursor: 'pointer', fontSize: '0.75rem', lineHeight: 1, padding: '0 2px' }}
                        >✓</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteCacheJob(cj.id); }}
                          title="Удалить из кеша"
                          style={{ background: 'none', border: 'none', color: 'rgba(248,113,113,0.5)', cursor: 'pointer', fontSize: '0.7rem', lineHeight: 1, padding: '0 2px' }}
                        >🗑</button>
                      </>
                    );
                    if (cj.status === 'error') return (
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteCacheJob(cj.id); startCaching(item); }}
                        title={`Ошибка: ${cj.error || 'unknown'} — повторить`}
                        style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '0.75rem', lineHeight: 1, padding: '0 2px' }}
                      >⚠</button>
                    );
                    return null;
                  })()}
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFromQueue(item.id); }}
                    style={{ background: 'none', border: 'none', color: 'rgba(248,113,113,0.6)', cursor: 'pointer', fontSize: '0.95rem', lineHeight: 1 }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Chat tab */}
        {activeTab === 'chat' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {messages.filter(Boolean).map((msg, i) => {
                if (!msg || (msg.content == null && !msg.attachment_url && !msg.metadata?.attachment_url)) return null;
                const isOwn = msg.message_id && msg.user_id === myId;
                const isEditing = editingMsg?.message_id === msg.message_id;
                const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                const attUrl = msg.attachment_url || msg.metadata?.attachment_url;
                const attType = msg.attachment_type || msg.metadata?.attachment_type || '';
                const attName = msg.attachment_name || msg.metadata?.attachment_name || 'Файл';
                return (
                  <div key={msg.message_id || i} className="chat-msg" style={{ fontSize: '0.8rem', lineHeight: 1.45, paddingBottom: '0.1rem' }}>
                    {/* Header: username + time + actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.1rem' }}>
                      <span style={{ fontWeight: 700, color: isOwn ? '#a78bfa' : '#7c6ff7', fontSize: '0.76rem', flexShrink: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {msg.username || msg.user_id}
                      </span>
                      {timeStr && (
                        <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.22)', flexShrink: 0 }}>{timeStr}</span>
                      )}
                      {msg.edited && (
                        <span style={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.28)', flexShrink: 0 }}>(ред.)</span>
                      )}
                      <span style={{ flex: 1 }} />
                      {isOwn && !isEditing && (
                        <>
                          <button onClick={() => setEditingMsg({ message_id: msg.message_id, content: msg.content })} title="Редактировать"
                            style={{ background: 'none', border: 'none', color: 'rgba(124,111,247,0.45)', cursor: 'pointer', fontSize: '0.72rem', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>✎</button>
                          <button onClick={() => deleteMessage(msg.message_id)} title="Удалить"
                            style={{ background: 'none', border: 'none', color: 'rgba(248,113,113,0.45)', cursor: 'pointer', fontSize: '0.82rem', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</button>
                        </>
                      )}
                    </div>
                    {/* Content / edit form */}
                    {isEditing ? (
                      <form style={{ display: 'flex', gap: '0.25rem' }}
                        onSubmit={(e) => { e.preventDefault(); submitEditMessage(msg.message_id, editingMsg.content); }}>
                        <input
                          autoFocus
                          value={editingMsg.content}
                          onChange={(e) => setEditingMsg(prev => ({ ...prev, content: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Escape') setEditingMsg(null); }}
                          style={{ flex: 1, fontSize: '0.78rem', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(124,111,247,0.4)', borderRadius: '4px', color: '#e2e8f0', padding: '3px 7px' }}
                        />
                        <button type="submit" style={{ background: 'rgba(124,111,247,0.2)', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: '0.7rem', padding: '2px 7px', borderRadius: '4px' }}>✓</button>
                        <button type="button" onClick={() => setEditingMsg(null)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '0.7rem', padding: '2px 5px' }}>✕</button>
                      </form>
                    ) : (
                      <div style={{ color: msg._pending ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.82)', wordBreak: 'break-word', whiteSpace: 'pre-wrap', fontStyle: msg._pending ? 'italic' : 'normal' }}>
                        {msg.content}
                        {msg._pending && <span style={{ fontSize: '0.6rem', color: 'rgba(255,200,0,0.55)', marginLeft: '5px' }}>⏳</span>}
                        {attUrl && (
                          <div style={{ marginTop: '0.3rem' }}>
                            {attType.startsWith('image/') ? (
                              <img src={attUrl} alt={attName}
                                style={{ maxWidth: '180px', maxHeight: '120px', borderRadius: '6px', display: 'block', cursor: 'pointer' }}
                                onClick={() => window.open(attUrl, '_blank')}
                              />
                            ) : (
                              <a href={attUrl} target="_blank" rel="noreferrer"
                                style={{ color: '#7c6ff7', fontSize: '0.75rem' }}>
                                📎 {attName}
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            {/* Typing indicator */}
            {Object.keys(typingUsers).length > 0 && (
              <div style={{ padding: '0.2rem 0.65rem', fontSize: '0.72rem', color: 'rgba(167,139,250,0.7)', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'center' }}>
                  {[0,1,2].map(i => (
                    <span key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(167,139,250,0.6)', display: 'inline-block', animation: `typingDot 1.2s ${i * 0.2}s infinite ease-in-out` }} />
                  ))}
                </span>
                {Object.keys(typingUsers).join(', ')} печатает…
              </div>
            )}
            <form
              onSubmit={sendChat}
              style={{ padding: '0.65rem', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', gap: '0.4rem' }}
            >
              <input
                ref={chatFileRef}
                type="file"
                accept="image/*,application/pdf,.txt,.doc,.docx,.zip"
                style={{ display: 'none' }}
                onChange={handleChatFileAttach}
              />
              <button
                type="button"
                title="Прикрепить файл"
                disabled={chatUploading}
                onClick={() => chatFileRef.current?.click()}
                style={{ background: 'none', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', color: chatUploading ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.55)', cursor: chatUploading ? 'default' : 'pointer', padding: '0 0.45rem', fontSize: '0.9rem', flexShrink: 0 }}
              >
                {chatUploading ? '…' : '📎'}
              </button>
              <input
                className="input-base"
                placeholder={t('player:chat_placeholder')}
                value={chatInput}
                onChange={(e) => {
                  setChatInput(e.target.value);
                  if (e.target.value.trim()) {
                    clearTimeout(typingDebounceRef.current);
                    typingDebounceRef.current = setTimeout(() => {
                      sendMessage({ type: 'chat_typing', room_id: roomId, payload: { username }, timestamp: Date.now() });
                    }, 300);
                  }
                }}
                style={{ fontSize: '0.8rem' }}
              />
              <button className="btn-primary" type="submit" style={{ whiteSpace: 'nowrap', fontSize: '0.8rem', padding: '0.35rem 0.65rem' }}>
                {t('player:send')}
              </button>
            </form>
          </div>
        )}

        {/* Voice tab */}
        {activeTab === 'voice' && (
          <div style={{ padding: '0.9rem', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Voice mode selector */}
            {!activeVoice.inVoice && (
              <div style={{ display: 'flex', gap: '0.4rem', background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '0.3rem' }}>
                {[{ value: 'p2p', label: 'P2P' }, { value: 'sfu', label: 'SFU' }].map(({ value, label }) => (
                  <button key={value} onClick={() => { setVoiceMode(value); localStorage.setItem('sw_voice_mode', value); }}
                    style={{ flex: 1, background: voiceMode === value ? 'rgba(124,111,247,0.25)' : 'none', border: `1px solid ${voiceMode === value ? 'rgba(124,111,247,0.5)' : 'transparent'}`, borderRadius: '6px', padding: '0.3rem', color: voiceMode === value ? '#a78bfa' : 'rgba(255,255,255,0.4)', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}>
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* Join / status */}
            {!activeVoice.inVoice ? (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', marginBottom: '0.75rem' }}>
                  {t('player:voice_not_in')}
                </div>
                <button
                  onClick={activeVoice.join}
                  style={{ background: 'linear-gradient(135deg,#7c6ff7,#a78bfa)', border: 'none', borderRadius: '8px', padding: '0.5rem 1.5rem', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  {t('player:voice_join')}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center' }}>
                <button onClick={activeVoice.toggleMic}
                  style={{ flex: 1, background: activeVoice.muted ? 'rgba(248,113,113,0.15)' : 'rgba(74,222,128,0.12)', border: `1px solid ${activeVoice.muted ? 'rgba(248,113,113,0.4)' : 'rgba(74,222,128,0.3)'}`, borderRadius: '8px', padding: '0.45rem', cursor: 'pointer', color: activeVoice.muted ? '#f87171' : '#4ade80', fontSize: '0.8rem', fontWeight: 600 }}>
                  {activeVoice.muted ? t('player:voice_mic_mute') : t('player:voice_mic_unmute')}
                </button>
                {voiceMode === 'p2p' && (
                  <button onClick={activeVoice.toggleDeafen}
                    style={{ flex: 1, background: activeVoice.deafened ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.07)', border: `1px solid ${activeVoice.deafened ? 'rgba(248,113,113,0.4)' : 'rgba(255,255,255,0.12)'}`, borderRadius: '8px', padding: '0.45rem', cursor: 'pointer', color: activeVoice.deafened ? '#f87171' : 'rgba(255,255,255,0.6)', fontSize: '0.8rem', fontWeight: 600 }}>
                    {activeVoice.deafened ? t('player:voice_undeafen') : t('player:voice_deafen')}
                  </button>
                )}
                {window.electronAPI?.isElectron && (
                  <button
                    onClick={() => (activeVoice.isSystemAudio ? activeVoice.stopSystemAudio() : activeVoice.startSystemAudio())}
                    title={activeVoice.isSystemAudio ? 'Выключить системный звук' : 'Транслировать системный звук'}
                    style={{ flex: 1, background: activeVoice.isSystemAudio ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.07)', border: `1px solid ${activeVoice.isSystemAudio ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.12)'}`, borderRadius: '8px', padding: '0.45rem', cursor: 'pointer', color: activeVoice.isSystemAudio ? '#4ade80' : 'rgba(255,255,255,0.6)', fontSize: '0.8rem', fontWeight: 600, animation: activeVoice.isSystemAudio ? 'pulse 1.5s ease-in-out infinite' : 'none' }}
                  >
                    🔊
                  </button>
                )}
              </div>
            )}

            {/* Mic level meter (P2P only — SFU VAD covers this via speaking indicator) */}
            {activeVoice.inVoice && voiceMode === 'p2p' && (
              <div>
                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', marginBottom: '0.35rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {t('player:mic_level')}
                </div>
                <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${inputLevel}%`, background: inputLevel > 70 ? '#f87171' : inputLevel > 30 ? '#4ade80' : '#7c6ff7', borderRadius: 4, transition: 'width 0.08s' }} />
                </div>
              </div>
            )}

            {/* Device settings */}
            <div>
              <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', marginBottom: '0.5rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('player:devices')}
                <button onClick={refreshDevices} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(124,111,247,0.7)', fontSize: '0.7rem', marginLeft: '0.4rem' }}>↻</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>
                  {t('player:mic_input')}
                  <select value={selectedInput} onChange={(e) => changeInputDevice(e.target.value)}
                    style={{ display: 'block', width: '100%', marginTop: '0.2rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', color: '#e2e8f0', padding: '0.35rem 0.5rem', fontSize: '0.78rem', cursor: 'pointer' }}>
                    {audioDevices.inputs.map(d => (
                      <option key={d.deviceId} value={d.deviceId} style={{ background: '#09090f' }}>
                        {d.label || `Микрофон ${d.deviceId.slice(0, 8)}`}
                      </option>
                    ))}
                    {audioDevices.inputs.length === 0 && <option value="">{t('player:no_devices')}</option>}
                  </select>
                </label>
                <label style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>
                  {t('player:speakers_output')}
                  <select value={selectedOutput} onChange={(e) => changeOutputDevice(e.target.value)}
                    style={{ display: 'block', width: '100%', marginTop: '0.2rem', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', color: '#e2e8f0', padding: '0.35rem 0.5rem', fontSize: '0.78rem', cursor: 'pointer' }}>
                    {audioDevices.outputs.map(d => (
                      <option key={d.deviceId} value={d.deviceId} style={{ background: '#09090f' }}>
                        {d.label || `Динамики ${d.deviceId.slice(0, 8)}`}
                      </option>
                    ))}
                    {audioDevices.outputs.length === 0 && <option value="">{t('player:no_devices')}</option>}
                  </select>
                </label>
              </div>
            </div>

            {/* Quick audio settings */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('player:audio_processing')}</span>
                <button onClick={() => { setVoiceSettingsOpen(true); refreshDevices(); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(124,111,247,0.7)', fontSize: '0.72rem' }}>
                  {t('player:all_settings')}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                {[
                  { key: 'echoCancellation', label: t('player:echo_cancel') },
                  { key: 'noiseSuppression', label: t('player:noise_suppress') },
                  { key: 'autoGainControl', label: t('player:auto_gain') },
                ].map(({ key, label }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)' }}>{label}</span>
                    <div onClick={() => changeAudioSettings({ [key]: !audioSettings[key] })} style={{ width: 36, height: 20, borderRadius: 10, cursor: 'pointer', transition: 'background 0.2s', background: audioSettings[key] ? '#7c6ff7' : 'rgba(255,255,255,0.1)', position: 'relative', flexShrink: 0 }}>
                      <div style={{ position: 'absolute', top: 2, left: audioSettings[key] ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Voice members */}
            <div>
              <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', marginBottom: '0.5rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('player:voice_in_count')} ({activeVoice.inVoice ? activeVoice.voiceMemberIds.length + 1 : 0})
              </div>
              {activeVoice.inVoice && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {/* Self */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.5rem', borderRadius: '6px', background: 'rgba(124,111,247,0.1)' }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: activeVoice.speaking[myId] ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.1)', border: `2px solid ${activeVoice.speaking[myId] ? '#4ade80' : 'rgba(255,255,255,0.15)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', flexShrink: 0, transition: 'border-color 0.1s, background 0.1s' }}>
                      {(username || 'Вы')[0].toUpperCase()}
                    </div>
                    <span style={{ fontSize: '0.8rem', color: '#e2e8f0', flex: 1 }}>{username || 'Вы'} (вы)</span>
                    {activeVoice.muted && <span title="Микрофон выключен" style={{ fontSize: '0.7rem', color: '#f87171' }}>🔇</span>}
                  </div>
                  {/* Remote members */}
                  {activeVoice.voiceMemberIds.map(uid => {
                    const m = members.find(m => m.user_id === uid);
                    const uname = m?.username || uid.slice(0, 8);
                    const isMe = uid === myId;
                    const vol = activeVoice.peerVolumes[uid] ?? 1;
                    return (
                      <div key={uid} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', padding: '0.35rem 0.5rem', borderRadius: '6px', background: 'rgba(255,255,255,0.04)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: activeVoice.speaking[uid] ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.08)', border: `2px solid ${activeVoice.speaking[uid] ? '#4ade80' : 'rgba(255,255,255,0.12)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', flexShrink: 0, transition: 'border-color 0.1s, background 0.1s' }}>
                            {uname[0]?.toUpperCase() || '?'}
                          </div>
                          <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.75)', flex: 1 }}>{uname}{isMe ? ' (вы)' : ''}</span>
                          {activeVoice.speaking[uid] && <span style={{ fontSize: '0.65rem', color: '#4ade80', fontWeight: 600 }}>●</span>}
                          {activeVoice.systemAudioPeers?.[uid] && <span title="Транслирует системный звук" style={{ fontSize: '0.7rem' }}>🔊</span>}
                          {activeVoice.peerPings[uid] != null && (() => {
                            const ms = activeVoice.peerPings[uid];
                            const c = ms < 100 ? '#4ade80' : ms < 250 ? '#fbbf24' : '#f87171';
                            return <span title={`Пинг ${ms} мс`} style={{ fontSize: '0.65rem', color: c, fontWeight: 600, minWidth: 32, textAlign: 'right' }}>{ms}мс</span>;
                          })()}
                          {token && <button onClick={() => openDM(uid, uname)} title="Написать в ЛС" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(124,111,247,0.6)', fontSize: '0.8rem', padding: '0 2px', lineHeight: 1 }}>✉️</button>}
                        </div>
                        {!isMe && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', paddingLeft: '36px' }}>
                            <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.3)' }}>🔊</span>
                            <input
                              type="range" min={0} max={1} step={0.05}
                              value={vol}
                              onChange={e => activeVoice.setPeerVolume(uid, parseFloat(e.target.value))}
                              style={{ flex: 1, accentColor: '#7c6ff7', cursor: 'pointer', height: '3px' }}
                              title={`Громкость ${uname}: ${Math.round(vol * 100)}%`}
                            />
                            <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.3)', minWidth: 24, textAlign: 'right' }}>{Math.round(vol * 100)}%</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {activeVoice.voiceMemberIds.length === 0 && (
                    <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: '0.5rem' }}>
                      {t('player:voice_only_me')}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Leave button */}
            {activeVoice.inVoice && (
              <button onClick={activeVoice.leave}
                style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '8px', padding: '0.5rem', cursor: 'pointer', color: '#f87171', fontSize: '0.8rem', fontWeight: 600 }}>
                {t('player:voice_leave')}
              </button>
            )}
          </div>
        )}
        {activeTab === 'doomscroll' && (
          <div style={{ padding: '0.9rem', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ fontSize: '0.85rem', color: '#f87171', fontWeight: 700, textAlign: 'center' }}>
              📱 Думскрол
            </div>
            <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', textAlign: 'center', lineHeight: 1.5 }}>
              Лента YouTube Shorts. Вставь @канал или хештег, нажми «Загрузить» — и скролль с друзьями.
            </div>
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              <input
                className="input-base"
                placeholder="@канал или хештег (mkbhd, shorts, music)"
                value={shortsChannel}
                onChange={(e) => setShortsChannel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchShorts()}
                style={{ fontSize: '0.78rem', flex: 1 }}
              />
              <button
                onClick={fetchShorts}
                disabled={shortsLoading}
                style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: '6px', color: '#f87171', cursor: 'pointer', fontSize: '0.78rem', padding: '0.35rem 0.75rem', whiteSpace: 'nowrap', fontWeight: 600 }}
              >
                {shortsLoading ? '...' : 'Загрузить'}
              </button>
            </div>
            {/* Preset buttons */}
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              {[10, 20, 50].map(n => (
                <button key={n} onClick={() => fetchShorts(n)} disabled={shortsLoading}
                  style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '0.65rem', padding: '0.2rem' }}>
                  +{n}
                </button>
              ))}
              <button onClick={() => fetchShorts(10)} disabled={shortsLoading}
                style={{ flex: 1, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '4px', color: '#f87171', cursor: 'pointer', fontSize: '0.65rem', padding: '0.2rem' }}>
                +10
              </button>
            </div>
            {queue.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                  <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', fontWeight: 600, textTransform: 'uppercase' }}>
                    Лента ({queue.length})
                  </span>
                  <button onClick={playNext} style={{ background: 'rgba(124,111,247,0.15)', border: '1px solid rgba(124,111,247,0.3)', borderRadius: '6px', color: '#a78bfa', cursor: 'pointer', fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}>
                    ▶ Следующий
                  </button>
                </div>
                <div style={{
                  flex: 1, overflowY: 'auto', scrollSnapType: 'y proximity',
                  display: 'flex', flexDirection: 'column', gap: '0.35rem',
                }}>
                {queue.map((item, idx) => {
                  const isCurrent = currentVideo?.id === item.id;
                  const thumb = item.thumbnail_url || getItemThumbnail(item);
                  const isNext = !isCurrent && idx === queue.findIndex(i => i.id === currentVideo?.id) + 1;
                  const cj = getCacheJobForItem(item);
                  return (
                    <div
                      key={item.id || idx}
                      onClick={() => jumpToVideo(item, true)}
                      style={{
                        display: 'flex', gap: '0.5rem', padding: '0.4rem', borderRadius: '8px',
                        cursor: 'pointer', alignItems: 'center', scrollSnapAlign: 'start',
                        background: isCurrent ? 'rgba(124,111,247,0.12)' : isNext ? 'rgba(74,222,128,0.06)' : cj?.status === 'done' ? 'rgba(74,222,128,0.05)' : 'rgba(255,255,255,0.03)',
                        border: isCurrent ? '1px solid rgba(124,111,247,0.4)' : isNext ? '1px solid rgba(74,222,128,0.2)' : cj?.status === 'done' ? '1px solid rgba(74,222,128,0.15)' : '1px solid transparent',
                      }}
                    >
                      <div style={{ width: 56, height: 56, borderRadius: '6px', overflow: 'hidden', flexShrink: 0, background: 'rgba(255,255,255,0.05)', position: 'relative' }}>
                        {thumb ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" /> : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.2)', fontSize: '0.7rem' }}>📱</div>}
                        {cj?.status === 'done' && <div style={{ position: 'absolute', inset: 0, background: 'rgba(74,222,128,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: '#fff', fontWeight: 700 }}>✓</div>}
                        {(cj?.status === 'downloading' || cj?.status === 'pending') && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', color: '#a78bfa', fontWeight: 700 }}>{cj.progress || 0}%</div>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.75rem', color: isCurrent ? '#a78bfa' : 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: isCurrent ? 600 : 400 }}>
                          {item.title || 'Без названия'}
                        </div>
                        <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.3)', marginTop: '2px' }}>
                          {isCurrent ? '▶ Сейчас' : isNext ? '⏭ Далее' : cj?.status === 'done' ? '💾 Кеш' : cj?.status === 'downloading' ? '⬇ Кешируется' : cj?.status === 'pending' ? '⏳ Очередь' : `#${idx + 1}`}
                        </div>
                      </div>
                      {isCurrent && (
                        <span style={{ fontSize: '0.65rem', color: '#a78bfa', fontWeight: 700 }}>▶</span>
                      )}
                    </div>
                  );
                })}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center' }}>
              <button onClick={playNext} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.4rem 1rem', cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontSize: '0.8rem', flex: 1 }}>
                ⏭ Пропустить
              </button>
              <button onClick={() => { if (queue.length > 0) jumpToVideo(queue[0]); }} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '0.4rem 1rem', cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontSize: '0.8rem', flex: 1 }}>
                🔄 С начала
              </button>
            </div>
          </div>
        )}
      </div>
  );
}
