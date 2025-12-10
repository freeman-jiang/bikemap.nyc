import { create } from "zustand"
import { DEFAULT_ANIMATION_START_DATE, DEFAULT_SPEEDUP } from "../config"

type AnimationStore = {
  // Source config only
  speedup: number
  animationStartDate: Date

  // Playback
  isPlaying: boolean
  currentTime: number // simulation seconds from windowStart

  // Trip selection (shared between Search and BikeMap)
  selectedTripId: string | null

  // Actions
  setSpeedup: (value: number) => void
  setAnimationStartDate: (date: Date) => void
  play: () => void
  pause: () => void
  setCurrentTime: (time: number) => void
  advanceTime: (delta: number) => void
  resetPlayback: () => void
  selectTrip: (id: string | null) => void
}

export const useAnimationStore = create<AnimationStore>((set) => ({
  // Config
  speedup: DEFAULT_SPEEDUP,
  animationStartDate: DEFAULT_ANIMATION_START_DATE,

  // Playback
  isPlaying: false,
  currentTime: 0,

  // Trip selection
  selectedTripId: null,

  // Config actions (reset playback when config changes)
  setSpeedup: (speedup) => set({ speedup, isPlaying: false, currentTime: 0 }),
  setAnimationStartDate: (animationStartDate) => set({ animationStartDate, isPlaying: false, currentTime: 0 }),

  // Playback actions
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  advanceTime: (delta) => set((state) => ({ currentTime: state.currentTime + delta })),
  resetPlayback: () => set({ isPlaying: false, currentTime: 0 }),

  // Trip selection
  selectTrip: (selectedTripId) => set({ selectedTripId }),
}))
