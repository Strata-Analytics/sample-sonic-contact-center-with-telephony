import React, { useEffect, useState, useRef } from "react";
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
import Chart from "chart.js/auto";
import "./App.css";
import { useAuth } from "./hooks/useAuth";
import Header from "./components/common/Header";
import SentimentLineChart from "./components/charts/SentimentLineChart";
import SentimentDonutChart from "./components/charts/SentimentDonutChart";
import NovaInsights from "./components/insights/NovaInsights";
import LiveTranscript from "./components/transcript/LiveTranscript";
import Footer from "./components/common/Footer";

let wsManager: WebSocketEventManager | null = null;
let sessionTimer: number | null = null;

// .env settings
const SERVER_URL = import.meta.env.VITE_SERVER_URL || "localhost:3001";
const SOCKET_PROTOCOL = SERVER_URL.startsWith("localhost") ? "ws" : "wss";
const WS_URL = `${SOCKET_PROTOCOL}://${SERVER_URL}/socket`;
const MICROPHONE_IS_MUTED =
  import.meta.env.VITE_MICROPHONE_IS_MUTED?.toLowerCase() === "true";

// Misc settings
const GREEN = "34, 197, 94"; // green
const ORANGE = "249, 115, 22"; // orange
const YELLOW = "234, 179, 8"; // yellow
const sentimentLabels = ["positive", "neutral", "negative"];
const SILENCE_THRESHOLD = 0.01;
const SPEECH_THRESHOLD = 0.015;
const SILENCE_DURATION = 1000;
const MIN_SPEECH_SAMPLES = 5;

const App: React.FC = () => {
  const { authorized } = useAuth();
  if (!authorized) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Access Denied</h1>
          <p className="text-gray-600">Please log in to access the dashboard.</p>
        </div>
      </div>)
  }


  const [sessionTime, setSessionTime] = useState<number>(0);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [conversationData, setConversationData] = useState<
    ConversationMessage[]
  >([]);
  const [sentimentData, setSentimentData] = useState<SentimentDataPoint[]>(
    Array(20)
      .fill(null)
      .map((_, index) => ({
        time: index,
        score: 50,
      }))
  );
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
  const [ttsText, setTtsText] = useState<string>("");

  const sentimentLineChartRef = useRef<Chart | null>(null);
  const sentimentDonutChartRef = useRef<Chart | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);

  const toPercentString = (n: number): string => String(Math.round(n));

  const getPercent = (category: string): string => {
    switch (category) {
      case "positive":
        return toPercentString(overallSentiment.positive);
      case "neutral":
        return toPercentString(overallSentiment.neutral);
      case "negative":
        return toPercentString(overallSentiment.negative);
      default:
        return "";
    }
  };

  const initializeCharts = () => {
    if (sentimentLineChartRef.current) {
      sentimentLineChartRef.current.destroy();
      sentimentLineChartRef.current = null;
    }
    if (sentimentDonutChartRef.current) {
      sentimentDonutChartRef.current.destroy();
      sentimentDonutChartRef.current = null;
    }

    const sentimentCtx = (
      document.getElementById("sentiment-chart") as HTMLCanvasElement
    )?.getContext("2d");
    if (sentimentCtx) {
      sentimentLineChartRef.current = new Chart(sentimentCtx, {
        type: "line",
        data: {
          labels: Array(20)
            .fill("")
            .map((_, i) => i.toString()),
          datasets: [
            {
              label: "Sentiment",
              data: Array(20).fill(50),
              borderColor: `rgb(${YELLOW})`,
              backgroundColor: `rgba(${YELLOW}, 0.1)`,
              fill: true,
              tension: 0.4,
              pointRadius: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true,
              max: 100,
            },
          },
          plugins: {
            legend: {
              position: "top",
            },
            tooltip: {
              callbacks: {
                label: function (context) {
                  const value = context.raw as number;
                  let sentiment = "neutral";
                  if (value >= 66) sentiment = "positive";
                  else if (value <= 33) sentiment = "negative";
                  return `Sentiment: ${sentiment} (${value})`;
                },
              },
            },
          },
        },
      });
    }

    const donutCtx = (
      document.getElementById("sentiment-donut") as HTMLCanvasElement
    )?.getContext("2d");
    if (donutCtx) {
      sentimentDonutChartRef.current = new Chart(donutCtx, {
        type: "doughnut",
        data: {
          labels: sentimentLabels,
          datasets: [
            {
              data: [33, 33, 34],
              backgroundColor: [
                `rgb(${GREEN})`,
                `rgb(${YELLOW})`,
                `rgb(${ORANGE})`,
              ],
              hoverOffset: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "right",
            },
          },
        },
      });
    }
  };

  const enhanceWebSocketEventManager = () => {
    const originalWsManagerClass = WebSocketEventManager;
    window.WebSocketEventManager = class ExtendedWebSocketEventManager extends (
      originalWsManagerClass
    ) {
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
  };

  const initializeDashboard = () => {
    initializeCharts();
    updateDashboard();
  };

  const updateTranscript = async (
    history: HistoryItem[] | null
  ): Promise<void> => {
    if (!history || history.length === 0) return;
    const newConversationData: ConversationMessage[] = [];
    for (let i = 0; i < history.length; i++) {
      const historyItem = history[i];
      if (!historyItem.role || !historyItem.message) continue;
      if (historyItem.role.toLowerCase() === "system") continue;

      let sender: string;
      if (historyItem.role.toLowerCase() === "user") {
        sender = "user";
      } else if (historyItem.role.toLowerCase() === "assistant") {
        sender = "agent";
      } else {
        continue;
      }

      const messagePosition = i / history.length;
      const estimatedSeconds = Math.floor(sessionTime * messagePosition);
      const mins = Math.floor(estimatedSeconds / 60);
      const secs = estimatedSeconds % 60;
      const uniqueTime = `${mins}:${secs < 10 ? "0" + secs : secs}`;

      newConversationData.push({
        id: i + 1,
        sender,
        text: historyItem.message,
        time: uniqueTime,
      });
    }

    setConversationData(newConversationData);
    updateTranscriptUI();

    sentimentTracker
      .processHistory(history)
      .then((result: SentimentResult | null) => {
        if (result) {
          updateSentimentWithResult(result);
        }
      });
  };

  const updateTranscriptUI = () => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTop =
        transcriptContainerRef.current.scrollHeight;
    }
  };

  const updateSentimentWithResult = (result: SentimentResult) => {
    if (!result) return;
    if (result.sentimentData?.length > 0) {
      setSentimentData(
        result.sentimentData.map((item) => ({
          time: item.time - result.sentimentData[0].time,
          score: item.score,
        }))
      );
    }
    if (result.overallSentiment) setOverallSentiment(result.overallSentiment!);
    if (result.insights?.length! > 0) setNovaInsights(result.insights!);
    updateDashboard();
  };

  const updateDashboard = () => {
    const updateSentimentChart = () => {
      if (!sentimentLineChartRef.current) return;
      const dataPoints = sentimentData.slice(-20);
      while (dataPoints.length < 20) {
        dataPoints.unshift({ time: 0, score: 50 });
      }

      const scores = dataPoints.map((d) => d.score);
      // actualiza los labels de tiempo Y axis
      sentimentLineChartRef.current.data.labels = dataPoints.map((d) =>
        d.time.toString()
      );
      const latestScore = scores[scores.length - 1] || 50;

      const dataset = sentimentLineChartRef.current.data.datasets[0];
      if (dataset) {
        dataset.data = scores;
        const [color, alpha] =
          latestScore >= 66
            ? [GREEN, 0.1]
            : latestScore >= 33
              ? [YELLOW, 0.1]
              : [ORANGE, 0.1];
        dataset.borderColor = `rgb(${color})`;
        dataset.backgroundColor = `rgba(${color}, ${alpha})`;
      }
      sentimentLineChartRef.current.update();
    };

    const updateSentimentDonut = () => {
      if (sentimentDonutChartRef.current?.data.datasets[0]) {
        sentimentDonutChartRef.current.data.datasets[0].data = [
          overallSentiment.positive,
          overallSentiment.neutral,
          overallSentiment.negative,
        ];
        sentimentDonutChartRef.current.update();
      }
    };

    updateSentimentChart();
    updateSentimentDonut();
    updateTranscriptUI();
  };

  const startStreaming = async () => {
    setIsRecording(true);
    const isJoiningExistingSession = sessionId !== "";
    const wsUrl = isJoiningExistingSession
      ? `${WS_URL}?channel=${encodeURIComponent(sessionId)}`
      : WS_URL;

    wsManager = new WebSocketEventManager(wsUrl);
    wsManager.onUpdateTranscript = updateTranscript;
    wsManager.onUpdateStatus = (message: string, status: string) => {
      setStatusMessage(message);
      setConnectionStatus(status);
    };
    wsManager.onAudioReceived = updateSpeechAnalytics;

    setStatusMessage(
      isJoiningExistingSession
        ? `Connecting to session: ${sessionId}`
        : "Creating new session..."
    );
    setConnectionStatus("connecting");

    if (wsManager) wsManager.resetTalkTimeMetrics();

    try {
      const sampleRate = 16000;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate,
          sampleSize: 16,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const audioContext = new AudioContext({
        sampleRate,
        latencyHint: "interactive",
      });

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(1024, 1, 1);

      source.connect(processor);
      processor.connect(audioContext.destination);

      let userIsSpeaking = false;
      let silenceTimer: number | null = null;
      let speakingStarted = false;
      let speechSampleCount = 0;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        const audioLevel = Math.max(...Array.from(inputData).map(Math.abs));

        if (audioLevel > SPEECH_THRESHOLD) {
          speechSampleCount++;
          if (speechSampleCount >= MIN_SPEECH_SAMPLES && !userIsSpeaking) {
            userIsSpeaking = true;
            if (wsManager && !speakingStarted) {
              console.log("User speech detected, level:", audioLevel);
              wsManager.startUserTalking();
              speakingStarted = true;
            }
          }
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
        } else if (audioLevel < SILENCE_THRESHOLD && userIsSpeaking) {
          speechSampleCount = 0;
          if (!silenceTimer) {
            silenceTimer = window.setTimeout(() => {
              userIsSpeaking = false;
              speakingStarted = false;
              if (wsManager) {
                console.log("User silence detected");
                wsManager.stopUserTalking();
              }
              silenceTimer = null;
            }, SILENCE_DURATION);
          }
        } else {
          speechSampleCount = 0;
        }

        const base64data = btoa(
          String.fromCharCode.apply(null, new Uint8Array(pcmData.buffer))
        );
        if (wsManager && !MICROPHONE_IS_MUTED) {
          wsManager.sendAudioChunk(base64data);
        }
      };

      (window as any).audioCleanup = () => {
        if (wsManager && userIsSpeaking) wsManager.stopUserTalking();
        if (silenceTimer) clearTimeout(silenceTimer);
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
      };

      startDashboardUpdates();
    } catch (error: any) {
      console.error("Error accessing microphone:", error);
      setStatusMessage(`Error: ${error.message}`);
      setConnectionStatus("error");
    }
  };

  const stopStreaming = () => {
    if ((window as any).audioCleanup) (window as any).audioCleanup();
    if (wsManager) wsManager.cleanup();
    if (sessionTimer) clearInterval(sessionTimer);
    setIsRecording(false);
    setStatusMessage("Disconnected");
    setConnectionStatus("disconnected");
  };

  const startDashboardUpdates = () => {
    setSessionTime(0);
    sessionTimer = window.setInterval(() => {
      setSessionTime((prev) => prev + 1);
      updateSentimentWithResult(sentimentTracker.getCurrentData());
      updateSpeechAnalytics();
      updateDashboard();
    }, 1000);
  };

  const updateSpeechAnalytics = () => {
    if (!wsManager) return;
    const metrics = wsManager.getTalkTimeMetrics();
    // Update DOM elements directly or manage state if needed
  };

  function submitAudiodataStream(
    audioData: any,
    wsManager: WebSocketEventManager
  ) {
    if (audioData) {
      const audioBytes =
        audioData instanceof Uint8Array ? audioData : new Uint8Array(audioData);
      const chunkSize = 1024;
      wsManager.startUserTalking();
      for (let i = 0; i < audioBytes.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, audioBytes.length);
        const chunk = audioBytes.slice(i, end);
        const pcmData = new Int16Array(chunk.length / 2);
        for (let j = 0; j < chunk.length; j += 2) {
          pcmData[j / 2] = (chunk[j + 1] << 8) | chunk[j];
        }
        const base64Data = btoa(
          String.fromCharCode.apply(null, new Uint8Array(pcmData.buffer))
        );
        wsManager.sendAudioChunk(base64Data);
      }
      wsManager.stopUserTalking();
    }
  }

  const handleTtsSubmit = async () => {
    try {
      const text = ttsText;
      if (text && wsManager) {
        const audioData = await synthesizeSpeech(text);
        submitAudiodataStream(audioData, wsManager);
      }
    } catch (e) {
      wsManager?.stopUserTalking();
    }
  };

  useEffect(() => {
    enhanceWebSocketEventManager();
    initializeDashboard();

    return () => {
      if (sessionTimer) clearInterval(sessionTimer);
      if (wsManager) wsManager.cleanup();
    };
  }, []);

  useEffect(() => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.innerHTML = "";
      let userMessageCount = 0;
      const totalUserMessages = conversationData.filter(
        (msg) => msg.sender === "user"
      ).length;

      conversationData.forEach((message) => {
        const messageDiv = document.createElement("div");
        messageDiv.className = `flex ${message.sender === "user" ? "justify-end" : "justify-start"
          }`;

        const innerDiv = document.createElement("div");
        innerDiv.className = `max-w-xs p-3 rounded-lg ${message.sender === "user"
            ? "bg-blue-500 text-white rounded-br-none"
            : "bg-gray-300 text-black rounded-bl-none"
          }`;

        let cleanText = message.text;
        const handleTrailingDuplicates = (text: string): string => {
          for (
            let endLength = Math.floor(text.length / 2);
            endLength > 4;
            endLength--
          ) {
            const end = text.substring(text.length - endLength);
            const beforeEnd = text.substring(0, text.length - endLength);
            if (beforeEnd.includes(end)) {
              return beforeEnd;
            }
          }
          return text;
        };

        const handleCompleteDuplicates = (text: string): string => {
          const markers = [
            "[playful]",
            "[joyful]",
            "[excited]",
            "[thoughtful]",
            "[friendly]",
          ];
          for (const marker of markers) {
            if (
              text.includes(marker) &&
              text.indexOf(marker) !== text.lastIndexOf(marker)
            ) {
              return text.substring(0, text.lastIndexOf(marker));
            }
          }
          return text;
        };

        cleanText = handleCompleteDuplicates(cleanText);
        cleanText = handleTrailingDuplicates(cleanText);

        const textDiv = document.createElement("div");
        textDiv.className = "text-sm";
        textDiv.textContent = cleanText;

        const footerDiv = document.createElement("div");
        footerDiv.className =
          "flex justify-between items-center mt-1 text-xs opacity-70";

        const timeSpan = document.createElement("span");
        timeSpan.textContent = message.time;
        footerDiv.appendChild(timeSpan);

        if (message.sender === "user") {
          userMessageCount++;
          let messageSentiment = 50;
          if (sentimentData?.length > 0) {
            const sentimentIndex = Math.min(
              Math.floor(
                (userMessageCount / totalUserMessages) * sentimentData.length
              ) - 1,
              sentimentData.length - 1
            );
            const dataIndex = Math.max(0, sentimentIndex);
            messageSentiment = sentimentData[dataIndex].score;
          }

          const sentimentDot = document.createElement("div");
          let dotColor =
            messageSentiment >= 66
              ? "bg-green-500"
              : messageSentiment >= 33
                ? "bg-yellow-500"
                : "bg-orange-500";
          sentimentDot.className = `w-3 h-3 rounded-full ${dotColor} ml-2`;
          sentimentDot.title = `Sentiment: ${messageSentiment}`;
          footerDiv.appendChild(sentimentDot);
        }

        innerDiv.appendChild(textDiv);
        innerDiv.appendChild(footerDiv);
        messageDiv.appendChild(innerDiv);
        transcriptContainerRef.current?.appendChild(messageDiv);
      });
    }
  }, [conversationData, sentimentData]);

  return (
    <div className="flex flex-col w-full h-screen bg-gray-50 gap-4">
      <div className="px-8 py-4 flex flex-col w-full h-full gap-4">
        <Header {...{
          sessionId,
          sessionTime,
          isRecording
        }} onSessionIdChange={setSessionId} onStartStreaming={startStreaming} onStopStreaming={stopStreaming} />

        <div className="flex gap-4 flex-grow overflow-hidden">
          <div className="flex flex-col flex-1 gap-4 overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              <SentimentLineChart data={sentimentData} />
              <SentimentDonutChart overallSentiment={overallSentiment} />
            </div>
            <NovaInsights insights={novaInsights} />
          </div>
          <div className="w-1/3 bg-white rounded-lg shadow p-4 flex flex-col">
            <LiveTranscript {...{
              isRecording,
              conversationData,
              sentimentData
            }} />
            <div className="mt-4 border-t pt-3 flex-shrink-0">
              <h3 className="text-sm font-semibold mb-2">Speech Analytics</h3>
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  <span>
                    Agent Talk Time: <span id="agent-talk-time">0</span>%
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                  <span>
                    User Talk Time: <span id="user-talk-time">0</span>%
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                  <span>
                    Avg Response Time: <span id="response-time">0</span>s
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-4 border-t pt-3 flex-shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <div className="flex gap-2">
                  <textarea
                    id="tts-text"
                    className="border rounded p-2 text-sm w-4/5 mx-auto block"
                    rows={2}
                    placeholder="Enter text..."
                    value={ttsText}
                    onChange={(e) => setTtsText(e.target.value)}
                  ></textarea>
                  <button
                    id="tts-button"
                    className="bg-purple-500 hover:bg-purple-600 text-white rounded px-3 py-1 text-sm"
                    onClick={handleTtsSubmit}
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
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
