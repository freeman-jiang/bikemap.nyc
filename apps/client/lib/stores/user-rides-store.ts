import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type BikeType = 'classic' | 'ebike'

export interface UserRide {
  id: string              // Receipt number or generated ID
  date: Date              // Start date/time
  startStation: string    // Start station name
  endStation: string      // End station name  
  startTime: string       // e.g., "6:42 pm"
  endTime: string         // e.g., "6:51 pm"
  durationMinutes: number // Duration in minutes
  bikeType: BikeType
  bikeId: string | null   // Bike number if available
  cost: number            // Total charge in dollars
}

type UserRidesState = {
  rides: UserRide[]
  isLoading: boolean
  error: string | null
  
  // Actions
  setRides: (rides: UserRide[]) => void
  addRides: (rides: UserRide[]) => void
  clearRides: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

export const useUserRidesStore = create<UserRidesState>()(
  persist(
    (set) => ({
      rides: [],
      isLoading: false,
      error: null,

      setRides: (rides) => set({ 
        rides: rides.sort((a, b) => b.date.getTime() - a.date.getTime()), // newest first
        error: null 
      }),
      
      addRides: (newRides) => set((state) => {
        const existingIds = new Set(state.rides.map(r => r.id))
        const uniqueNewRides = newRides.filter(r => !existingIds.has(r.id))
        const allRides = [...state.rides, ...uniqueNewRides]
        return { 
          rides: allRides.sort((a, b) => b.date.getTime() - a.date.getTime()),
          error: null
        }
      }),
      
      clearRides: () => set({ rides: [], error: null }),
      
      setLoading: (isLoading) => set({ isLoading }),
      
      setError: (error) => set({ error }),
    }),
    {
      name: 'user-rides-storage',
      // Custom serialization to handle Date objects
      storage: {
        getItem: (name) => {
          const str = localStorage.getItem(name)
          if (!str) return null
          const parsed = JSON.parse(str)
          // Rehydrate Date objects
          if (parsed.state?.rides) {
            parsed.state.rides = parsed.state.rides.map((ride: UserRide & { date: string }) => ({
              ...ride,
              date: new Date(ride.date)
            }))
          }
          return parsed
        },
        setItem: (name, value) => {
          localStorage.setItem(name, JSON.stringify(value))
        },
        removeItem: (name) => {
          localStorage.removeItem(name)
        }
      }
    }
  )
)
