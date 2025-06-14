import { useState, useCallback } from 'react';
import sentimentTracker from '../sentimentTracker';
import type { SentimentDataPoint, OverallSentiment, SentimentResult, HistoryItem } from '../types';

export const useSentimentAnalysis = () => {
  const [sentimentData, setSentimentData] = useState<SentimentDataPoint[]>(
    Array(20).fill(null).map((_, index) => ({
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

  const updateSentimentWithResult = useCallback((result: SentimentResult) => {
    if (!result) return;
    if (result.sentimentData?.length > 0) {
      setSentimentData(
        result.sentimentData.map((item) => ({
          time: item.time - result.sentimentData[0].time,
          score: item.score,
        }))
      );
    }
    if (result.overallSentiment) setOverallSentiment(result.overallSentiment);
    if (result.insights?.length! > 0) setNovaInsights(result.insights!);
  }, []);

  const processHistory = useCallback(async (history: HistoryItem[] | null) => {
    if (!history || history.length === 0) return;
    
    const result = await sentimentTracker.processHistory(history);
    if (result) {
      updateSentimentWithResult(result);
    }
  }, [updateSentimentWithResult]);

  const getCurrentData = useCallback(() => {
    return sentimentTracker.getCurrentData();
  }, []);

  const getPercent = useCallback((category: string): string => {
    const toPercentString = (n: number): string => String(Math.round(n));
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
  }, [overallSentiment]);

  return {
    sentimentData,
    overallSentiment,
    novaInsights,
    updateSentimentWithResult,
    processHistory,
    getCurrentData,
    getPercent
  };
};
