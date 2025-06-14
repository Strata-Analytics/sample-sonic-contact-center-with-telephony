import React, { useEffect, useRef } from "react";
import Chart from "chart.js/auto";
import type { SentimentDataPoint } from "../../types";

interface SentimentLineChartProps {
  data: SentimentDataPoint[];
}

const SentimentLineChart: React.FC<SentimentLineChartProps> = ({ data }) => {
  const chartRef = useRef<Chart | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const COLORS = {
    GREEN: "34, 197, 94",
    ORANGE: "249, 115, 22",
    YELLOW: "234, 179, 8",
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
      type: "line",
      data: {
        labels: Array(20)
          .fill("")
          .map((_, i) => i.toString()),
        datasets: [
          {
            label: "Sentiment",
            data: Array(20).fill(50),
            borderColor: `rgb(${COLORS.YELLOW})`,
            backgroundColor: `rgba(${COLORS.YELLOW}, 0.1)`,
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

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !data) return;

    const dataPoints = data.slice(-20);
    while (dataPoints.length < 20) {
      dataPoints.unshift({ time: 0, score: 50 });
    }

    const scores = dataPoints.map((d) => d.score);
    const latestScore = scores[scores.length - 1] || 50;

    // Update chart data
    chartRef.current.data.labels = dataPoints.map((d) => d.time.toString());
    
    const dataset = chartRef.current.data.datasets[0];
    if (dataset) {
      dataset.data = scores;
      const [color, alpha] =
        latestScore >= 66
          ? [COLORS.GREEN, 0.1]
          : latestScore >= 33
            ? [COLORS.YELLOW, 0.1]
            : [COLORS.ORANGE, 0.1];
      dataset.borderColor = `rgb(${color})`;
      dataset.backgroundColor = `rgba(${color}, ${alpha})`;
    }
    
    chartRef.current.update();
  }, [data]);

  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <h2 className="text-md font-semibold mb-2">Real-time Sentiment Analysis</h2>
      <div style={{ height: "200px" }}>
        <canvas ref={canvasRef}></canvas>
      </div>
    </div>
  );
};

export default SentimentLineChart;