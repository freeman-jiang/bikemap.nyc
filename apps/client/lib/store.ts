import { create } from 'zustand'

type PickerState = {
  isPickingLocation: boolean
  pickedLocation: { lat: number; lng: number } | null
  startPicking: () => void
  setPickedLocation: (loc: { lat: number; lng: number }) => void
  clearPicking: () => void
}

export const usePickerStore = create<PickerState>((set) => ({
  isPickingLocation: false,
  pickedLocation: null,
  startPicking: () => set({ isPickingLocation: true, pickedLocation: null }),
  setPickedLocation: (loc) => set({ isPickingLocation: false, pickedLocation: loc }),
  clearPicking: () => set({ isPickingLocation: false, pickedLocation: null }),
}))
