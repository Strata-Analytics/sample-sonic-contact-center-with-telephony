import { useState, useCallback } from 'react';
import { WebSocketEventManager } from '../websocketEvents';
import type { HistoryItem } from '../types';

// Environment settings
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "localhost:3001";
const SOCKET_PROTOCOL = SERVER_URL.startsWith("localhost") ? "ws" : "wss";
const WS_URL = `${SOCKET_PROTOCOL}://${SERVER_URL}/socket`;

export const useWebSocket = () => {
  const [wsManager, setWsManager] = useState<WebSocketEventManager | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>("disconnected");
  const [statusMessage, setStatusMessage] = useState<string>("Disconnected");
  const [sessionId, setSessionId] = useState<string>("");

  const enhanceWebSocketEventManager = useCallback(() => {
    const originalWsManagerClass = WebSocketEventManager;
    window.WebSocketEventManager = class ExtendedWebSocketEventManager extends originalWsManagerClass {
      private channelId: string = "";

      constructor(url: string) {
        super(url);
        const match = url.match(/channel=([^&]*)/);
        if (match && match[1]) {
          this.channelId = decodeURIComponent(match[1]);
          console.log(`Connecting to existing channel: ${this.channelId}`);
        }
      }

      protected onMessage(event: MessageEvent): void {
        try {
          const data = JSON.parse(event.data);
          if (data.event === "sessionReady") {
            if (data.channelId && !this.channelId) {
              this.channelId = data.channelId;
              setSessionId(this.channelId);
              console.log(`Connected to new channel: ${this.channelId}`);
            }
            setStatusMessage(
              this.channelId
                ? `Connected to session: ${this.channelId}`
                : "Connected to new session"
            );
            setConnectionStatus("connected");
          }
          super.onMessage(event);
        } catch (error) {
          console.error("Error processing WebSocket message:", error);
        }
      }
    };
  }, []);

  const createConnection = useCallback((
    onUpdateTranscript: (history: HistoryItem[] | null) => Promise<void>,
    onUpdateSpeechAnalytics: () => void
  ) => {
    const isJoiningExistingSession = sessionId !== "";
    const wsUrl = isJoiningExistingSession
      ? `${WS_URL}?channel=${encodeURIComponent(sessionId)}`
      : WS_URL;

    const manager = new WebSocketEventManager(wsUrl);
    manager.onUpdateTranscript = onUpdateTranscript;
    manager.onUpdateStatus = (message: string, status: string) => {
      setStatusMessage(message);
      setConnectionStatus(status);
    };
    manager.onAudioReceived = onUpdateSpeechAnalytics;

    setStatusMessage(
      isJoiningExistingSession
        ? `Connecting to session: ${sessionId}`
        : "Creating new session..."
    );
    setConnectionStatus("connecting");

    manager.resetTalkTimeMetrics();
    setWsManager(manager);
    return manager;
  }, [sessionId]);

  const cleanup = useCallback(() => {
    if (wsManager) {
      wsManager.cleanup();
      setWsManager(null);
    }
    setStatusMessage("Disconnected");
    setConnectionStatus("disconnected");
  }, [wsManager]);

  return {
    wsManager,
    connectionStatus,
    statusMessage,
    sessionId,
    setSessionId,
    enhanceWebSocketEventManager,
    createConnection,
    cleanup
  };
};