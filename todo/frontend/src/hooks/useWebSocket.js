import { useEffect, useRef, useState, useCallback } from 'react';

const WS_RECONNECT_INTERVAL = 3000;
const WS_MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL = 25000;

export const useWebSocket = (url, options = {}) => {
  const { onMessage, onConnect, onDisconnect, onError } = options;
  
  const wsRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const pingIntervalRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  
  const [isConnected, setIsConnected] = useState(false);
  const [latency, setLatency] = useState(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;
        
        // Start ping interval
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            const pingData = JSON.stringify({
              type: 'ping',
              timestamp: Date.now()
            });
            ws.send(pingData);
          }
        }, PING_INTERVAL);

        onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          // Handle pong for latency calculation
          if (message.type === 'pong') {
            const now = Date.now();
            const serverTime = message.timestamp;
            const calculatedLatency = now - serverTime;
            setLatency(calculatedLatency);
            return;
          }

          onMessage?.(message);
        } catch (error) {
          console.error('Failed to parse message:', error);
        }
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        setIsConnected(false);
        clearInterval(pingIntervalRef.current);

        // Attempt reconnection
        if (reconnectAttemptsRef.current < WS_MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          const delay = WS_RECONNECT_INTERVAL * Math.min(reconnectAttemptsRef.current, 5);
          
          console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        } else {
          console.error('Max reconnection attempts reached');
        }

        onDisconnect?.(event);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        onError?.(error);
      };

    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      onError?.(error);
    }
  }, [url, onMessage, onConnect, onDisconnect, onError]);

  const disconnect = useCallback(() => {
    clearInterval(pingIntervalRef.current);
    clearTimeout(reconnectTimeoutRef.current);
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const sendMessage = useCallback((message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const data = typeof message === 'string' ? message : JSON.stringify(message);
      wsRef.current.send(data);
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    isConnected,
    latency,
    sendMessage,
    connect,
    disconnect
  };
};
