"use client"

import { useShallow } from "zustand/react/shallow"
import { cn } from "@/lib/utils"
import { useAnimationStore } from "@/lib/stores/animation-store"

export function FollowModeBorder() {
  const { selectedTripId, selectedTripInfo } = useAnimationStore(
    useShallow((s) => ({
      selectedTripId: s.selectedTripId,
      selectedTripInfo: s.selectedTripInfo,
    }))
  )

  if (!selectedTripId) return null

  const isElectric = selectedTripInfo?.bikeType === "electric_bike"

  return (
    <div
      className={cn(
        "fixed inset-0 pointer-events-none z-50 animate-pulse-border",
        isElectric ? "border-[#7DCFFF]" : "border-[#BB9AF7]"
      )}
      style={{
        borderWidth: "4px",
        borderStyle: "solid",
      }}
    />
  )
}
