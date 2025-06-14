import React from "react";

interface HeaderProps {
  sessionId: string;
  sessionTime: number;
  isRecording: boolean;
  onSessionIdChange: (sessionId: string) => void;
  onStartStreaming: () => void;
  onStopStreaming: () => void;
}

const Header: React.FC<HeaderProps> = ({
  sessionId,
  sessionTime,
  isRecording,
  onSessionIdChange,
  onStartStreaming,
  onStopStreaming,
}) => {
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? "0" + secs : secs}`;
  };

  return (
    <div className="flex justify-between items-center bg-white p-4 rounded-lg shadow flex-shrink-0">
      <div className="flex items-center gap-2">
        <div className="text-blue-500">⚡</div>
        <h1 className="text-xl font-bold">
          Amazon Nova Real-time Analytics Dashboard
        </h1>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="session-id" className="text-sm">
            Session ID (sessionId:caseId):
          </label>
          <input
            id="session-id"
            type="text"
            placeholder="Leave empty for new session"
            className="border rounded px-2 py-1 text-sm w-48"
            value={sessionId}
            onChange={(e) => onSessionIdChange(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <div>🕐</div>
          <span id="session-time" className="font-mono">
            {formatTime(sessionTime)}
          </span>
        </div>
        <button
          id="start-button"
          className="flex items-center gap-2 px-3 py-1 rounded-md bg-green-100 text-green-700"
          onClick={onStartStreaming}
          disabled={isRecording}
        >
          📞
        </button>
        <button
          id="stop-button"
          className="flex items-center gap-2 px-3 py-1 rounded-md bg-red-100 text-red-700"
          onClick={onStopStreaming}
          disabled={!isRecording}
        >
          📞
        </button>
      </div>
    </div>
  );
};

export default Header;