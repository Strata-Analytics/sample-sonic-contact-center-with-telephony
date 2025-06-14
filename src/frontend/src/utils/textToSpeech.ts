import { synthesizeSpeech } from '../tts';
import { WebSocketEventManager } from '../websocketEvents';

export const submitAudiodataStream = (
  audioData: any,
  wsManager: WebSocketEventManager
) => {
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
};

export const handleTtsSubmit = async (text: string, wsManager: WebSocketEventManager | null) => {
  try {
    if (text && wsManager) {
      const audioData = await synthesizeSpeech(text);
      submitAudiodataStream(audioData, wsManager);
    }
  } catch (e) {
    wsManager?.stopUserTalking();
  }
};
