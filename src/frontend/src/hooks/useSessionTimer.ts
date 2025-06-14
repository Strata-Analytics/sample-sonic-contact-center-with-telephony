import { useState, useCallback, useRef } from 'react';

export const useSessionTimer = () => {
  const [sessionTime, setSessionTime] = useState<number>(0);
  const sessionTimerRef = useRef<number | null>(null);

  const formatTime = useCallback((seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? "0" + secs : secs}`;
  }, []);

  const startTimer = useCallback((onTick?: () => void) => {
    setSessionTime(0);
    sessionTimerRef.current = window.setInterval(() => {
      setSessionTime((prev) => prev + 1);
      if (onTick) onTick();
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (sessionTimerRef.current) {
      clearInterval(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
  }, []);

  return {
    sessionTime,
    formatTime,
    startTimer,
    stopTimer
  };
};

