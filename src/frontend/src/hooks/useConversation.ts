import { useState, useCallback } from 'react';
import type { ConversationMessage, HistoryItem } from '../types';

export const useConversation = () => {
  const [conversationData, setConversationData] = useState<ConversationMessage[]>([]);

  const updateTranscript = useCallback(async (
    history: HistoryItem[] | null,
    sessionTime: number
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
  }, []);

  return {
    conversationData,
    updateTranscript
  };
};
