import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SearchStep = "datetime" | "station" | "results"

const MAX_HISTORY = 10

type SearchState = {
  isOpen: boolean
  step: SearchStep
  datetimeHistory: string[]
  open: () => void
  close: () => void
  toggle: () => void
  setStep: (step: SearchStep) => void
  addToHistory: (query: string) => void
}

export const useSearchStore = create<SearchState>()(
  persist(
    (set) => ({
      isOpen: false,
      step: "datetime",
      datetimeHistory: [],
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),
      setStep: (step) => set({ step }),
      addToHistory: (query) => set((state) => {
        const trimmed = query.trim()
        if (!trimmed) return state
        // Remove duplicate if exists, add to front, cap at MAX_HISTORY
        const filtered = state.datetimeHistory.filter((h) => h !== trimmed)
        return { datetimeHistory: [trimmed, ...filtered].slice(0, MAX_HISTORY) }
      }),
    }),
    {
      name: 'search-store',
      partialize: (state) => ({ datetimeHistory: state.datetimeHistory }),
    }
  )
)
