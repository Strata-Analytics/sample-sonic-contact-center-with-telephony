import React, { useRef, useEffect } from 'react';
import type { ConversationMessage, SentimentDataPoint } from '../../types';

interface LiveTranscriptProps {
  isRecording: boolean;
  conversationData: ConversationMessage[];
  sentimentData: SentimentDataPoint[];
}

const LiveTranscript: React.FC<LiveTranscriptProps> = ({
  isRecording,
  conversationData,
  sentimentData
}) => {
  const transcriptContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.innerHTML = "";
      let userMessageCount = 0;
      const totalUserMessages = conversationData.filter(
        (msg) => msg.sender === "user"
      ).length;

      conversationData.forEach((message) => {
        const messageDiv = document.createElement("div");
        messageDiv.className = `flex ${message.sender === "user" ? "justify-end" : "justify-start"}`;

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
    <>
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="text-blue-500">🎤</div>
          <h2 className="text-md font-semibold">Live Transcript</h2>
        </div>
        <div className="text-xs text-gray-500">
          <div className="flex items-center gap-1">
            <div
              className={`w-2 h-2 rounded-full ${isRecording ? "bg-red-500" : "bg-gray-400"
                }`}
            ></div>
            <span>{isRecording ? "Recording" : "Ready"}</span>
          </div>
        </div>
      </div>
      <div
        className="overflow-y-auto flex-grow bg-gray-100 rounded p-3 space-y-3"
        ref={transcriptContainerRef}
      ></div>
    </>
  );
};

export default LiveTranscript;