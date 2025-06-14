import React from "react";

interface NovaInsightsProps {
  insights: string[];
}

const NovaInsights: React.FC<NovaInsightsProps> = ({ insights }) => {
  return (
    <div className="bg-white p-4 rounded-lg shadow">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-amber-500">⚠️</div>
        <h2 className="text-md font-semibold">Nova AI Insights</h2>
      </div>
      <div id="insights-container" className="space-y-2">
        {insights.map((insight, index) => (
          <div
            key={index}
            className="p-2 bg-amber-50 rounded border-l-4 border-amber-400 text-sm"
          >
            {insight}
          </div>
        ))}
      </div>
    </div>
  );
};

export default NovaInsights;