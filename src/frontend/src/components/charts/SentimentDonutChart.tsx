import React, { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
import type { OverallSentiment } from "../../types";

interface SentimentDonutChartProps {
  overallSentiment: OverallSentiment;
}

const SentimentDonutChart: React.FC<SentimentDonutChartProps> = ({
  overallSentiment,
}) => {
  const chartRef = useRef<Chart | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const COLORS = {
    GREEN: "34, 197, 94",
    ORANGE: "249, 115, 22",
    YELLOW: "234, 179, 8",
  };

  const sentimentLabels = ["positive", "neutral", "negative"];

  const toPercentString = (n: number): string => String(Math.round(n));

  const getPercent = (category: keyof OverallSentiment): string => {
    return toPercentString(overallSentiment[category]);
  };

  const getDominantTone = (): string => {
    return Object.entries(overallSentiment).reduce((max, [tone, value]) =>
      value > overallSentiment[max as keyof OverallSentiment] ? tone : max,
      "negative"
    );
  };

  useEffect(() => {
    if (!canvasRef.current) return;

    // Destroy existing chart
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }

    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    chartRef.current = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: sentimentLabels,
        datasets: [
          {
            data: [33, 33, 34],
            backgroundColor: [
              `rgb(${COLORS.GREEN})`,
              `rgb(${COLORS.YELLOW})`,
              `rgb(${COLORS.ORANGE})`,
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

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;

    if (chartRef.current.data.datasets[0]) {
      chartRef.current.data.datasets[0].data = [
        overallSentiment.positive,
        overallSentiment.neutral,
        overallSentiment.negative,
      ];
      chartRef.current.update();
    }
  }, [overallSentiment]);

  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <h2 className="text-md font-semibold mb-2">Overall Sentiment Distribution</h2>
      <div className="flex items-center">
        <div style={{ width: "50%", height: "180px" }}>
          <canvas ref={canvasRef}></canvas>
        </div>
        <div className="w-1/2">
          <div className="mb-4 flex items-center gap-2">
            <div className="text-green-500">📈</div>
            <span className="font-semibold">Dominant Tone:</span>
            <span className="text-sm">{getDominantTone()}</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
              <span>Positive: {getPercent("positive")}%</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
              <span>Neutral: {getPercent("neutral")}%</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-orange-500"></div>
              <span>Negative: {getPercent("negative")}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SentimentDonutChart;