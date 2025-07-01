import { useState, useCallback } from "react";
import { WebSocketEventManager } from "../websocketEvents";

const MICROPHONE_IS_MUTED =
  import.meta.env.VITE_MICROPHONE_IS_MUTED?.toLowerCase() === "true";
const SILENCE_THRESHOLD = 0.01;
const SPEECH_THRESHOLD = 0.015;
const SILENCE_DURATION = 1000;
const MIN_SPEECH_SAMPLES = 5;

export const useAudioRecording = (resetSilenceTimer: () => void) => {
  const [isRecording, setIsRecording] = useState<boolean>(false);

  const startRecording = useCallback(
    async (wsManager: WebSocketEventManager) => {
      setIsRecording(true);

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
            resetSilenceTimer();
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
            String.fromCharCode.apply(
              null,
              Array.from(new Uint8Array(pcmData.buffer))
            )
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
      } catch (error: any) {
        console.error("Error accessing microphone:", error);
        throw new Error(`Error: ${error.message}`);
      }
    },
    []
  );

  const stopRecording = useCallback(() => {
    if ((window as any).audioCleanup) (window as any).audioCleanup();
    setIsRecording(false);
  }, []);

  return {
    isRecording,
    startRecording,
    stopRecording,
  };
};
