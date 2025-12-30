import { GRAPH_MIN_SCALE, GRAPH_WINDOW_SIZE_SECONDS } from "@/lib/config";
import type { GraphDataPoint } from "@/lib/trip-types";
import { forwardRef, memo, useImperativeHandle, useMemo, useRef } from "react";

type ActiveRidesPanelProps = {
  graphData: GraphDataPoint[];
  currentTime: number;
  bearing: number;
};

export type ActiveRidesPanelRef = {
  fps: HTMLDivElement | null;
  rides: HTMLSpanElement | null;
};

const GRAPH_WIDTH = 176;
const GRAPH_HEIGHT = 52;
const PADDING = { top: 4, right: 4, bottom: 14, left: 4 };

export const ActiveRidesPanel = memo(
  forwardRef<ActiveRidesPanelRef, ActiveRidesPanelProps>(function ActiveRidesPanel(
    { graphData, currentTime, bearing },
    ref
  ) {
    const fpsRef = useRef<HTMLDivElement>(null);
    const ridesRef = useRef<HTMLSpanElement>(null);

    useImperativeHandle(ref, () => ({
      fps: fpsRef.current,
      rides: ridesRef.current,
    }));

    const { linePath, areaPath, maxCount } = useMemo(() => {
      if (graphData.length === 0) {
        return { linePath: "", areaPath: "", maxCount: 0 };
      }

      const timeStart = currentTime - GRAPH_WINDOW_SIZE_SECONDS;
      const timeEnd = currentTime;

      const windowData = graphData.filter((d) => d.time >= timeStart && d.time <= timeEnd);
      if (windowData.length === 0) {
        return { linePath: "", areaPath: "", maxCount: 0 };
      }

      const maxCount = Math.max(GRAPH_MIN_SCALE, ...windowData.map((d) => d.count));

      const chartWidth = GRAPH_WIDTH - PADDING.left - PADDING.right;
      const chartHeight = GRAPH_HEIGHT - PADDING.top - PADDING.bottom;

      const scaleX = (time: number) =>
        PADDING.left + ((time - timeStart) / (timeEnd - timeStart)) * chartWidth;

      const scaleY = (count: number) =>
        PADDING.top + chartHeight - (count / (maxCount * 1.1)) * chartHeight;

      const points = windowData.map((d) => ({
        x: scaleX(d.time),
        y: scaleY(d.count),
      }));

      const linePath = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");

      const areaPath =
        linePath +
        ` L ${points[points.length - 1].x} ${GRAPH_HEIGHT - PADDING.bottom}` +
        ` L ${points[0].x} ${GRAPH_HEIGHT - PADDING.bottom}` +
        ` Z`;

      return { linePath, areaPath, maxCount };
    }, [graphData, currentTime]);

    const hasData = linePath.length > 0;

    return (
      <div className="hidden sm:block bg-black/45 backdrop-blur-md text-white/90 px-3 py-2 rounded-xl border border-white/10 shadow-[0_0_24px_rgba(0,0,0,0.6)] w-[200px] relative">
        {/* Compass */}
        <div
          className="absolute top-2 right-2"
          style={{ transform: `rotate(${-bearing}deg)` }}
        >
          <svg width="40" height="40" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="14" fill="none" stroke="rgba(125, 207, 255, 0.2)" strokeWidth="1" />
            <path d="M20 9 L22 20 L20 18 L18 20 Z" fill="rgba(125, 207, 255, 0.9)" />
            <path d="M20 31 L22 20 L20 22 L18 20 Z" fill="rgba(125, 207, 255, 0.3)" />
            <circle cx="20" cy="20" r="1.5" fill="rgba(125, 207, 255, 0.6)" />
            <text x="20" y="7" textAnchor="middle" fontSize="8" fill="rgba(125, 207, 255, 0.7)" fontWeight="500">N</text>
            <text x="20" y="39" textAnchor="middle" fontSize="8" fill="rgba(125, 207, 255, 0.4)" fontWeight="500">S</text>
            <text x="4" y="22" textAnchor="middle" fontSize="8" fill="rgba(125, 207, 255, 0.4)" fontWeight="500">W</text>
            <text x="36" y="22" textAnchor="middle" fontSize="8" fill="rgba(125, 207, 255, 0.4)" fontWeight="500">E</text>
          </svg>
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5 text-left">
          <span ref={ridesRef} className="text-xl font-semibold tabular-nums tracking-tight">--</span>
          <span className="text-[10px] tracking-wide text-white/70">RIDES</span>
        </div>
        <div ref={fpsRef} className="mt-0.5 text-[10px] tracking-wide text-white/50 text-left">-- FPS</div>
        <div className="mt-2">
          <svg
            width={GRAPH_WIDTH}
            height={GRAPH_HEIGHT}
            viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
            className="overflow-visible"
          >
            <defs>
              <linearGradient id="graph-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="rgba(125, 207, 255, 0.4)" />
                <stop offset="100%" stopColor="rgba(125, 207, 255, 0)" />
              </linearGradient>
            </defs>

            {/* Time axis labels */}
            <text x={PADDING.left} y={GRAPH_HEIGHT - 2} textAnchor="start" fill="rgba(255, 255, 255, 0.4)" fontSize={8}>
              -3h
            </text>
            <text
              x={PADDING.left + (GRAPH_WIDTH - PADDING.left - PADDING.right) / 3}
              y={GRAPH_HEIGHT - 2}
              textAnchor="middle"
              fill="rgba(255, 255, 255, 0.4)"
              fontSize={8}
            >
              -2h
            </text>
            <text
              x={PADDING.left + (2 * (GRAPH_WIDTH - PADDING.left - PADDING.right)) / 3}
              y={GRAPH_HEIGHT - 2}
              textAnchor="middle"
              fill="rgba(255, 255, 255, 0.4)"
              fontSize={8}
            >
              -1h
            </text>
            <text
              x={GRAPH_WIDTH - PADDING.right}
              y={GRAPH_HEIGHT - 2}
              textAnchor="end"
              fill="rgba(255, 255, 255, 0.4)"
              fontSize={8}
            >
              Now
            </text>

            {hasData ? (
              <>
                <path d={areaPath} fill="url(#graph-gradient)" />
                <path
                  d={linePath}
                  fill="none"
                  stroke="rgba(125, 207, 255, 0.9)"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {graphData.length > 0 && (
                  <circle
                    cx={GRAPH_WIDTH - PADDING.right}
                    cy={
                      PADDING.top +
                      (GRAPH_HEIGHT - PADDING.top - PADDING.bottom) -
                      (graphData[graphData.length - 1].count / (maxCount * 1.1)) *
                        (GRAPH_HEIGHT - PADDING.top - PADDING.bottom)
                    }
                    r={2.5}
                    fill="rgba(125, 207, 255, 1)"
                  />
                )}
              </>
            ) : (
              <text
                x={GRAPH_WIDTH / 2}
                y={(GRAPH_HEIGHT - PADDING.bottom) / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(255, 255, 255, 0.3)"
                fontSize={9}
              >
                No data
              </text>
            )}
          </svg>
        </div>
      </div>
    );
  })
);
