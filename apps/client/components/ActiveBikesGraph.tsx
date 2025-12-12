import { memo, useMemo } from "react";
import type { GraphDataPoint } from "@/lib/trip-types";
import { GRAPH_MIN_SCALE, GRAPH_WINDOW_SIZE_SECONDS } from "@/lib/config";

type ActiveBikesGraphProps = {
  data: GraphDataPoint[];
  currentTime: number;
  windowSize?: number;
};

const WIDTH = 120;
const HEIGHT = 52;
const PADDING = { top: 4, right: 4, bottom: 14, left: 4 };

const ActiveBikesGraph = memo(function ActiveBikesGraph({
  data,
  currentTime,
  windowSize = GRAPH_WINDOW_SIZE_SECONDS,
}: ActiveBikesGraphProps) {
  const { linePath, areaPath, maxCount } = useMemo(() => {
    if (data.length === 0) {
      return { linePath: "", areaPath: "", maxCount: 0 };
    }

    // Calculate bounds
    const timeStart = currentTime - windowSize;
    const timeEnd = currentTime;

    // Filter data to window and find max
    const windowData = data.filter((d) => d.time >= timeStart && d.time <= timeEnd);
    if (windowData.length === 0) {
      return { linePath: "", areaPath: "", maxCount: 0 };
    }

    const maxCount = Math.max(GRAPH_MIN_SCALE, ...windowData.map((d) => d.count));

    // Scale functions
    const chartWidth = WIDTH - PADDING.left - PADDING.right;
    const chartHeight = HEIGHT - PADDING.top - PADDING.bottom;

    const scaleX = (time: number) =>
      PADDING.left + ((time - timeStart) / (timeEnd - timeStart)) * chartWidth;

    const scaleY = (count: number) =>
      PADDING.top + chartHeight - (count / (maxCount * 1.1)) * chartHeight;

    // Generate line path
    const points = windowData.map((d) => ({
      x: scaleX(d.time),
      y: scaleY(d.count),
    }));

    const linePath = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");

    // Generate area path (fill under the line)
    const areaPath =
      linePath +
      ` L ${points[points.length - 1].x} ${HEIGHT - PADDING.bottom}` +
      ` L ${points[0].x} ${HEIGHT - PADDING.bottom}` +
      ` Z`;

    return { linePath, areaPath, maxCount };
  }, [data, currentTime, windowSize]);

  const hasData = linePath.length > 0;

  return (
    <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="overflow-visible">
      <defs>
        <linearGradient id="graph-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgba(125, 207, 255, 0.4)" />
          <stop offset="100%" stopColor="rgba(125, 207, 255, 0)" />
        </linearGradient>
      </defs>

      {/* Time axis labels */}
      <text x={PADDING.left} y={HEIGHT - 2} textAnchor="start" fill="rgba(255, 255, 255, 0.4)" fontSize={8}>
        -2h
      </text>
      <text x={WIDTH / 2} y={HEIGHT - 2} textAnchor="middle" fill="rgba(255, 255, 255, 0.4)" fontSize={8}>
        -1h
      </text>
      <text x={WIDTH - PADDING.right} y={HEIGHT - 2} textAnchor="end" fill="rgba(255, 255, 255, 0.4)" fontSize={8}>
        Now
      </text>

      {hasData ? (
        <>
          {/* Filled area under the line */}
          <path d={areaPath} fill="url(#graph-gradient)" />

          {/* Line */}
          <path
            d={linePath}
            fill="none"
            stroke="rgba(125, 207, 255, 0.9)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Current value dot */}
          {data.length > 0 && (
            <circle
              cx={WIDTH - PADDING.right}
              cy={
                PADDING.top +
                (HEIGHT - PADDING.top - PADDING.bottom) -
                (data[data.length - 1].count / (maxCount * 1.1)) * (HEIGHT - PADDING.top - PADDING.bottom)
              }
              r={2.5}
              fill="rgba(125, 207, 255, 1)"
            />
          )}
        </>
      ) : (
        <text x={WIDTH / 2} y={(HEIGHT - PADDING.bottom) / 2} textAnchor="middle" dominantBaseline="middle" fill="rgba(255, 255, 255, 0.3)" fontSize={9}>
          No data
        </text>
      )}
    </svg>
  );
});

export default ActiveBikesGraph;
