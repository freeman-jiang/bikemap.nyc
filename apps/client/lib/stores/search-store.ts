import { create } from 'zustand'

export type SearchStep = "datetime" | "station" | "results"

type SearchState = {
  isOpen: boolean
  step: SearchStep
  open: () => void
  close: () => void
  toggle: () => void
  setStep: (step: SearchStep) => void
}

export const useSearchStore = create<SearchState>((set) => ({
  isOpen: false,
  step: "datetime",
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  setStep: (step) => set({ step }),
}))
