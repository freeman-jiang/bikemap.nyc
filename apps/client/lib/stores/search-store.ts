import { create } from 'zustand'

type SearchState = {
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
}

export const useSearchStore = create<SearchState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
}))
