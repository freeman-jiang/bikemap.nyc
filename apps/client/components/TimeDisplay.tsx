import { formatDateShort, formatTimeOnly } from "@/lib/format";

type Props = {
  simulationTime: number; // seconds from animation start
  startDate: Date; // animation start date
};

export function TimeDisplay({ simulationTime, startDate }: Props) {
  const displayTimeMs = startDate.getTime() + simulationTime * 1000;

  return (
    <div className="bg-black/45 backdrop-blur-md px-3 py-1.5 rounded-xl border border-white/10 shadow-[0_0_24px_rgba(0,0,0,0.6)] flex flex-col items-center">
      <div className="text-white/90 text-xs tracking-wide font-mono">
        {formatDateShort(displayTimeMs)}
      </div>
      <div className="text-xl font-semibold tabular-nums text-white/90 tracking-tight">
        {formatTimeOnly(displayTimeMs)}
      </div>
    </div>
  );
}
