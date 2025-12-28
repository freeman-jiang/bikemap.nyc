import { EBike } from "@/components/icons/Ebike";
import { formatDistance, formatDurationMinutes } from "@/lib/format";
import type { SelectedTripInfo } from "@/lib/stores/animation-store";
import { Bike } from "lucide-react";
import { Kbd } from "./ui/kbd";

type SelectedTripPanelProps = {
  info: SelectedTripInfo;
};

export function SelectedTripPanel({ info }: SelectedTripPanelProps) {
  const isElectric = info.bikeType === "electric_bike";

  return (
    <div className="bg-black/45 backdrop-blur-md text-white/90 px-3 py-2 rounded-xl border border-white/10 shadow-[0_0_24px_rgba(0,0,0,0.6)] w-[200px] mt-2">
      {/* Header with bike icon */}
      <div className="flex items-center gap-2">
        {isElectric ? (
          <EBike className="size-5 text-[#7DCFFF] shrink-0" />
        ) : (
          <Bike className="size-5 text-[#BB9AF7] shrink-0" />
        )}
        <span className="text-sm font-medium">
          {isElectric ? "Electric Bike" : "Classic Bike"}
        </span>
        <span className="ml-auto text-[10px] text-white/50 font-mono">
          {info.id.slice(-8)}
        </span>
      </div>

      {/* Route */}
      <div className="mt-2 text-xs text-white/70">
        <div className="wrap-break-words">{info.startStationName}</div>
        <div className="text-white/40 my-0.5">to</div>
        <div className="wrap-break-words">{info.endStationName}</div>
      </div>

      {/* Stats */}
      <div className="mt-2 flex items-center gap-3 text-xs text-white/90 font-medium">
        <span>
          {info.startedAt.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: "America/New_York",
          })}
        </span>
        <span>{formatDurationMinutes(info.startedAt, info.endedAt)}</span>
        {info.routeDistance && <span>{formatDistance(info.routeDistance)}</span>}
      </div>

      {/* Footer hint */}
      <div className="flex items-center gap-1 text-xs text-white/40 mt-2 pt-2 border-t border-white/5">
        <Kbd>Esc</Kbd>
        <span>to deselect</span>
      </div>
    </div>
  );
}
