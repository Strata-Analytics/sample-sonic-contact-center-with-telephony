import { useRef, useEffect } from "react";

type UseSilenceDetectionProps = {
  onSilence: () => void;
  silenceDuration?: number;
};

export const useSilenceDetection = ({
  onSilence,
  silenceDuration = 8000,
}: UseSilenceDetectionProps) => {
  const silenceTimer = useRef<number | null>(null);

  const resetSilenceTimer = () => {
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current);
    }
    silenceTimer.current = window.setTimeout(onSilence, silenceDuration);
  };

  useEffect(() => {
    resetSilenceTimer(); // Start the timer on mount

    return () => {
      if (silenceTimer.current) {
        clearTimeout(silenceTimer.current);
      }
    };
  }, [onSilence, silenceDuration]);

  return { resetSilenceTimer };
};
