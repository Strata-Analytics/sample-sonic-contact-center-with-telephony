import React, { useEffect, useState, useRef, useCallback } from "react";
import { WebSocketEventManager } from "./websocketEvents";
import sentimentTracker from "./sentimentTracker";
import type {
  ConversationMessage,
  SentimentDataPoint,
  OverallSentiment,
  SentimentResult,
  HistoryItem,
} from "./types";
import { synthesizeSpeech } from "./tts";
import "./App.css";
import { useAuth } from "./hooks/useAuth";
import Header from "./components/common/Header";
import SentimentLineChart from "./components/charts/SentimentLineChart";
import SentimentDonutChart from "./components/charts/SentimentDonutChart";
import NovaInsights from "./components/insights/NovaInsights";
import LiveTranscript from "./components/transcript/LiveTranscript";
import Footer from "./components/common/Footer";
import { useSilenceDetection } from "./hooks/useSilenceDetection";
import { useConversation } from "./hooks/useConversation";
import { useAudioRecording } from "./hooks/useAudioRecording";

let wsManager: WebSocketEventManager | null = null;
let sessionTimer: number | null = null;

// .env settings
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "localhost:3001";
const SOCKET_PROTOCOL = SERVER_URL.startsWith("localhost") ? "ws" : "wss";
const WS_URL = `${SOCKET_PROTOCOL}://${SERVER_URL}/socket`;

// Misc settings
const GREEN = "34, 197, 94"; // green
const ORANGE = "249, 115, 22"; // orange
const YELLOW = "234, 179, 8"; // yellow
const sentimentLabels = ["positive", "neutral", "negative"];

const App: React.FC = () => {
  const { authorized } = useAuth();

  const handleTtsSubmit = useCallback(async (text: string) => {
    if (!wsManager) {
      console.error("WebSocket manager not initialized.");
      return;
    }
    try {
      const audioData = await synthesizeSpeech(text);
      if (audioData) {
        const base64Audio = btoa(
          String.fromCharCode.apply(null, Array.from(new Uint8Array(audioData)))
        );
        wsManager.sendAudioChunk(base64Audio);
      }
    } catch (error) {
      console.error("Error synthesizing speech:", error);
    }
  }, []);

  const handleSilence = useCallback(() => {
    if (wsManager) {
      console.log("------------->Silence detected");
      // handleTtsSubmit("I am the system and you decide what you have to do like search for tool results or inform about the process to the user or ask if the user is there");
      // handleTtsSubmit("decide what to do");
      handleTtsSubmit("Take the bull by the horns");
      // handleTtsSubmit("I am the system and you decide what you have to do like search for tool results or inform the user or ask if the user is there");
      // handleTtsSubmit("I am the system  decide what to do");
    }
  }, [handleTtsSubmit]);

  const { resetSilenceTimer } = useSilenceDetection({
    onSilence: handleSilence,
  });
  const { isRecording, startRecording, stopRecording } =
    useAudioRecording(resetSilenceTimer);
  const { conversationData, updateTranscript } =
    useConversation(resetSilenceTimer);

  const [sessionTime, setSessionTime] = useState<number>(0);
  const [sentimentData, setSentimentData] = useState<SentimentDataPoint[]>([]);
  const [overallSentiment, setOverallSentiment] = useState<OverallSentiment>({
    positive: 33.33,
    neutral: 33.334,
    negative: 33.33,
  });
  const [novaInsights, setNovaInsights] = useState<string[]>([
    "Waiting for conversation to begin",
  ]);
  const [connectionStatus, setConnectionStatus] =
    useState<string>("disconnected");
  const [statusMessage, setStatusMessage] = useState<string>("Disconnected");
  const [sessionId, setSessionId] = useState<string>("");

  const updateDashboard = (result: SentimentResult | null) => {
    if (!result) return;
    if (result.sentimentData) {
      setSentimentData(result.sentimentData);
    }
    if (result.overallSentiment) {
      setOverallSentiment(result.overallSentiment);
    }
    if (result.insights) {
      setNovaInsights(result.insights);
    }
  };

  const startStreaming = async () => {
    let id = sessionId;
    if (!id) {
      const newId = window.prompt(
        "Enter existing session ID or leave blank for new session:"
      );
      if (newId) {
        id = newId;
        setSessionId(newId);
      }
    }

    const url = id ? `${WS_URL}?channel=${id}` : WS_URL;
    wsManager = new WebSocketEventManager(url);

    (wsManager as any).onUpdateTranscript = async (history: HistoryItem[]) => {
      updateTranscript(history, sessionTime);
      const sentimentResult = await sentimentTracker.processHistory(history);
      updateDashboard(sentimentResult);
    };

    (wsManager as any).onUpdateStatus = (message: string, status: string) => {
      setStatusMessage(message);
      setConnectionStatus(status);
    };

    (wsManager as any).onAudioReceived = () => {
      resetSilenceTimer();
    };

    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = window.setInterval(() => {
      setSessionTime((prevTime) => prevTime + 1);
    }, 1000);

    try {
      await startRecording(wsManager);
      handleTtsSubmit("Hola");
    } catch (error: any) {
      setStatusMessage(`Error starting recording: ${error.message}`);
    }
  };

  const stopStreaming = () => {
    if (wsManager) {
      wsManager.cleanup();
      wsManager = null;
    }
    stopRecording();
    if (sessionTimer) {
      clearInterval(sessionTimer);
      sessionTimer = null;
    }
    setConnectionStatus("disconnected");
    setStatusMessage("Disconnected");
  };

  if (!authorized) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Access Denied</h1>
          <p className="text-gray-600">
            Please log in to access the dashboard.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-screen bg-gray-50 gap-4">
      <div className="px-8 py-4 flex flex-col w-full h-full gap-4">
        <Header
          sessionId={sessionId}
          sessionTime={sessionTime}
          isRecording={isRecording}
          onSessionIdChange={setSessionId}
          onStartStreaming={startStreaming}
          onStopStreaming={stopStreaming}
        />
        <div className="flex gap-4 flex-grow overflow-hidden">
          <div className="flex flex-col flex-1 gap-4 overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              <SentimentLineChart data={sentimentData} />
              <SentimentDonutChart overallSentiment={overallSentiment} />
            </div>
            <NovaInsights insights={novaInsights} />
          </div>
          <div className="w-1/3 bg-white rounded-lg shadow p-4 flex flex-col">
            <LiveTranscript
              isRecording={isRecording}
              conversationData={conversationData}
              sentimentData={sentimentData}
            />
          </div>
        </div>
        <Footer
          connectionStatus={connectionStatus}
          statusMessage={statusMessage}
        />
      </div>
    </div>
  );
};

export default App;
