import { create } from "zustand";
import { DEFAULT_ANIMATION_START_DATE, DEFAULT_SPEEDUP } from "../config";
import { usePickerStore } from "./location-picker-store";

export type SelectedTripInfo = {
  id: string;
  bikeType: string;
  memberCasual: string;
  startStationName: string;
  endStationName: string;
  startNeighborhood: string | null;
  endNeighborhood: string | null;
  startedAt: Date;
  endedAt: Date;
  routeDistance: number | null;
};

type AnimationStore = {
  // Source config only
  speedup: number
  animationStartDate: Date

  // Playback
  isPlaying: boolean
  simCurrentTimeMs: number // simulation ms from windowStart
  pendingAutoPlay: boolean // flag to auto-play after trips load

  // Loading state
  isLoadingTrips: boolean
  loadError: string | null

  // Trip selection (shared between Search and BikeMap)
  selectedTripId: string | null
  selectedTripInfo: SelectedTripInfo | null

  // Actions
  setSpeedup: (value: number) => void
  setAnimationStartDate: (date: Date) => void
  setAnimationStartDateAndPlay: (date: Date) => void
  clearPendingAutoPlay: () => void
  play: () => void
  pause: () => void
  setSimCurrentTimeMs: (simTimeMs: number) => void
  advanceSimTime: (deltaMs: number) => void
  resetPlayback: () => void
  selectTrip: (data: { id: string; info?: SelectedTripInfo | null } | null) => void
  setIsLoadingTrips: (loading: boolean) => void
  setLoadError: (error: string | null) => void
}

export const useAnimationStore = create<AnimationStore>((set) => ({
  // Config
  speedup: DEFAULT_SPEEDUP,
  animationStartDate: DEFAULT_ANIMATION_START_DATE,

  // Playback
  isPlaying: false,
  simCurrentTimeMs: 0,
  pendingAutoPlay: true, // Auto-play on initial page load

  // Loading state
  isLoadingTrips: true,
  loadError: null,

  // Trip selection
  selectedTripId: null,
  selectedTripInfo: null,

  // Config actions (reset playback when config changes)
  setSpeedup: (speedup) => set({ speedup, isPlaying: false, simCurrentTimeMs: 0 }),
  setAnimationStartDate: (animationStartDate) => set({ animationStartDate, isPlaying: false, simCurrentTimeMs: 0 }),
  setAnimationStartDateAndPlay: (animationStartDate) => set({ animationStartDate, isPlaying: false, simCurrentTimeMs: 0, pendingAutoPlay: true }),
  clearPendingAutoPlay: () => set({ pendingAutoPlay: false }),

  // Playback actions
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  setSimCurrentTimeMs: (simCurrentTimeMs) => set({ simCurrentTimeMs }),
  advanceSimTime: (deltaMs) => set((state) => ({ simCurrentTimeMs: state.simCurrentTimeMs + deltaMs })),
  resetPlayback: () => set({ isPlaying: false, simCurrentTimeMs: 0 }),

  // Trip selection
  selectTrip: (data) => {
    // Clear picked location when selecting a bike
    if (data) {
      usePickerStore.getState().clearPicking();
    }
    set({
      selectedTripId: data?.id ?? null,
      selectedTripInfo: data?.info ?? null,
    });
  },

  // Loading state
  setIsLoadingTrips: (isLoadingTrips) => set({ isLoadingTrips }),
  setLoadError: (loadError) => set({ loadError }),
}))
