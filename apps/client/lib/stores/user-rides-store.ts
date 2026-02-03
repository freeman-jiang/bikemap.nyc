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
  // Route geometry (resolved after parsing)
  routeGeometry: string | null  // polyline6-encoded path
  routeDistance: number | null  // distance in meters
  // Station coordinates (resolved from stations.json)
  startLat: number | null
  startLng: number | null
  endLat: number | null
  endLng: number | null
}

type UserRidesState = {
  rides: UserRide[]
  isLoading: boolean
  isResolvingRoutes: boolean
  error: string | null
  // View state
  selectedRideId: string | null
  showAllRides: boolean  // Show all rides on map at once
  
  // Actions
  setRides: (rides: UserRide[]) => void
  addRides: (rides: UserRide[]) => void
  updateRide: (id: string, updates: Partial<UserRide>) => void
  updateRides: (updates: Array<{ id: string; updates: Partial<UserRide> }>) => void
  clearRides: () => void
  setLoading: (loading: boolean) => void
  setResolvingRoutes: (resolving: boolean) => void
  setError: (error: string | null) => void
  // View actions
  selectRide: (id: string | null) => void
  setShowAllRides: (show: boolean) => void
}

export const useUserRidesStore = create<UserRidesState>()(
  persist(
    (set) => ({
      rides: [],
      isLoading: false,
      isResolvingRoutes: false,
      error: null,
      selectedRideId: null,
      showAllRides: false,

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

      updateRide: (id, updates) => set((state) => ({
        rides: state.rides.map(r => r.id === id ? { ...r, ...updates } : r)
      })),

      updateRides: (updates) => set((state) => {
        const updateMap = new Map(updates.map(u => [u.id, u.updates]))
        return {
          rides: state.rides.map(r => {
            const update = updateMap.get(r.id)
            return update ? { ...r, ...update } : r
          })
        }
      }),
      
      clearRides: () => set({ rides: [], error: null, selectedRideId: null }),
      
      setLoading: (isLoading) => set({ isLoading }),

      setResolvingRoutes: (isResolvingRoutes) => set({ isResolvingRoutes }),
      
      setError: (error) => set({ error }),

      selectRide: (selectedRideId) => set({ selectedRideId }),

      setShowAllRides: (showAllRides) => set({ showAllRides }),
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
