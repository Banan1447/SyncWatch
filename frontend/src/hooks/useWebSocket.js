import { useEffect, useRef, useState, useCallback } from 'react';

const WS_RECONNECT_INTERVAL = 3000;
const WS_MAX_RECONNECT_DELAY = 30000; // cap backoff at 30s — always reconnect
const PING_INTERVAL = 25000;

export const useWebSocket = (url, options = {}) => {
  const { onMessage, onConnect, onDisconnect, onError } = options;

  // Store callbacks in refs — changing callbacks never triggers reconnect
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);
  onMessageRef.current = onMessage;
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;
  onErrorRef.current = onError;

  const wsRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const pingIntervalRef = useRef(null);
  const pingSentAtRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  const [isConnected, setIsConnected] = useState(false);
  const [latency, setLatency] = useState(0);

  const sendMessage = useCallback((message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    }
    return false;
  }, []);

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      reconnectAttemptsRef.current = 0;

      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          pingSentAtRef.current = Date.now();
          ws.send(JSON.stringify({ type: 'ping', timestamp: pingSentAtRef.current }));
        }
      }, PING_INTERVAL);

      onConnectRef.current?.();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') {
          const sent = pingSentAtRef.current;
          if (sent) setLatency(Math.max(0, Date.now() - sent));
          return;
        }
        onMessageRef.current?.(message);
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      clearInterval(pingIntervalRef.current);

      // Always reconnect — no attempt cap. Backoff grows to WS_MAX_RECONNECT_DELAY then stays there.
      // disconnect() sets reconnectAttemptsRef to Infinity to stop this loop on intentional close.
      if (reconnectAttemptsRef.current < Infinity) {
        reconnectAttemptsRef.current++;
        const delay = Math.min(
          WS_RECONNECT_INTERVAL * reconnectAttemptsRef.current,
          WS_MAX_RECONNECT_DELAY
        );
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      }

      onDisconnectRef.current?.(event);
    };

    ws.onerror = (error) => {
      onErrorRef.current?.(error);
    };
  }, [url]); // only url — callbacks go through refs, never cause reconnect

  const disconnect = useCallback(() => {
    clearInterval(pingIntervalRef.current);
    clearTimeout(reconnectTimeoutRef.current);
    reconnectAttemptsRef.current = Infinity; // stop auto-reconnect on intentional disconnect
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]); // fires only on mount/unmount or URL change

  return { isConnected, latency, sendMessage, connect, disconnect };
};
