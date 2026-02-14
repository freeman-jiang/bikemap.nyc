"use client"

import { useUserRidesStore, UserRide } from "@/lib/stores/user-rides-store"
import { useUploadStore } from "@/lib/stores/upload-store"
import { Bike, X, Upload, Zap, ChevronRight, Trash2, MapPin, Eye } from "lucide-react"
import { memo, useMemo, useState } from "react"
import { cn } from "@/lib/utils"

// Format date for ride list
function formatRideDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  })
}

// Format time for ride list  
function formatRideTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  })
}

// Group rides by month/year
function groupRidesByMonth(rides: UserRide[]): Map<string, UserRide[]> {
  const groups = new Map<string, UserRide[]>()
  
  for (const ride of rides) {
    const key = ride.date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "America/New_York",
    })
    
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key)!.push(ride)
  }
  
  return groups
}

// Single ride item component
const RideItem = memo(function RideItem({ 
  ride, 
  isSelected,
  onSelect,
  onClose
}: { 
  ride: UserRide
  isSelected: boolean
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const hasRoute = !!ride.routeGeometry
  
  const handleViewOnMap = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(ride.id)
    onClose() // Close the panel to see the map
  }
  
  return (
    <div 
      className={cn(
        "px-3 py-2.5 transition-colors cursor-pointer",
        isSelected ? "bg-blue-500/20 border-l-2 border-blue-400" : "",
        isExpanded && !isSelected ? "bg-white/5" : "",
        !isExpanded && !isSelected && "hover:bg-white/[0.03]"
      )}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {/* Route */}
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-white/90 truncate">{ride.startStation}</span>
            <ChevronRight className="size-3 text-white/40 flex-shrink-0" />
            <span className="text-white/90 truncate">{ride.endStation}</span>
          </div>
          
          {/* Time and duration */}
          <div className="mt-1 flex items-center gap-2 text-xs text-white/50">
            <span>{formatRideTime(ride.date)}</span>
            <span className="text-white/30">•</span>
            <span>{ride.durationMinutes} min</span>
            {ride.bikeType === 'ebike' && (
              <>
                <span className="text-white/30">•</span>
                <span className="flex items-center gap-0.5 text-yellow-400/80">
                  <Zap className="size-3" />
                  Ebike
                </span>
              </>
            )}
          </div>
        </div>
        
        {/* Cost and View button */}
        <div className="text-right flex-shrink-0 flex items-center gap-2">
          <span className="text-sm font-medium text-white/80">
            ${ride.cost.toFixed(2)}
          </span>
          {hasRoute && (
            <button
              onClick={handleViewOnMap}
              className={cn(
                "p-1.5 rounded-md transition-colors",
                isSelected 
                  ? "bg-blue-500 text-white" 
                  : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white/90"
              )}
              title="View on map"
            >
              <MapPin className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      
      {/* Expanded details */}
      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-white/10 text-xs text-white/60 space-y-1.5">
          <div className="flex justify-between">
            <span>Start</span>
            <span className="text-white/80">{ride.startTime}</span>
          </div>
          <div className="flex justify-between">
            <span>End</span>
            <span className="text-white/80">{ride.endTime}</span>
          </div>
          {ride.bikeId && (
            <div className="flex justify-between">
              <span>Bike #</span>
              <span className="text-white/80">{ride.bikeId}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Receipt</span>
            <span className="text-white/80 font-mono text-[10px]">#{ride.id.slice(-8)}</span>
          </div>
          {!hasRoute && (
            <div className="flex items-center gap-1 text-yellow-400/70 mt-2">
              <span>Route not available</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// Stats summary component
const RideStats = memo(function RideStats({ rides }: { rides: UserRide[] }) {
  const stats = useMemo(() => {
    const totalCost = rides.reduce((sum, r) => sum + r.cost, 0)
    const totalMinutes = rides.reduce((sum, r) => sum + r.durationMinutes, 0)
    const ebikeCount = rides.filter(r => r.bikeType === 'ebike').length
    
    return {
      totalRides: rides.length,
      totalCost,
      totalMinutes,
      totalHours: Math.floor(totalMinutes / 60),
      remainingMinutes: totalMinutes % 60,
      ebikeCount,
      classicCount: rides.length - ebikeCount,
    }
  }, [rides])
  
  return (
    <div className="grid grid-cols-3 gap-2 p-3 bg-white/[0.03] border-b border-white/10">
      <div className="text-center">
        <div className="text-lg font-semibold text-white/90">{stats.totalRides}</div>
        <div className="text-[10px] text-white/50 uppercase tracking-wide">Rides</div>
      </div>
      <div className="text-center">
        <div className="text-lg font-semibold text-white/90">
          {stats.totalHours > 0 ? `${stats.totalHours}h ${stats.remainingMinutes}m` : `${stats.totalMinutes}m`}
        </div>
        <div className="text-[10px] text-white/50 uppercase tracking-wide">Time</div>
      </div>
      <div className="text-center">
        <div className="text-lg font-semibold text-white/90">${stats.totalCost.toFixed(2)}</div>
        <div className="text-[10px] text-white/50 uppercase tracking-wide">Spent</div>
      </div>
    </div>
  )
})

type MyRidesPanelProps = {
  isOpen: boolean
  onClose: () => void
}

export const MyRidesPanel = memo(function MyRidesPanel({ isOpen, onClose }: MyRidesPanelProps) {
  const { rides, clearRides, selectedRideId, selectRide, showAllRides, setShowAllRides } = useUserRidesStore()
  const { open: openUpload } = useUploadStore()
  
  const groupedRides = useMemo(() => groupRidesByMonth(rides), [rides])
  const ridesWithRoutes = useMemo(() => rides.filter(r => r.routeGeometry), [rides])
  
  if (!isOpen) return null
  
  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-96 z-50 flex flex-col bg-black/90 backdrop-blur-xl border-l border-white/10 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Bike className="size-5 text-white/70" />
          <h2 className="text-lg font-semibold text-white/90">My Rides</h2>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
        >
          <X className="size-5 text-white/70" />
        </button>
      </div>
      
      {rides.length === 0 ? (
        /* Empty state */
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <Bike className="size-12 text-white/20 mb-4" />
          <h3 className="text-lg font-medium text-white/80 mb-2">No rides yet</h3>
          <p className="text-sm text-white/50 mb-6 max-w-xs">
            Import your Citi Bike ride receipts from Gmail to see your ride history.
          </p>
          <button
            onClick={() => {
              onClose()
              openUpload()
            }}
            className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 rounded-lg text-sm font-medium text-white/90 transition-colors"
          >
            <Upload className="size-4" />
            Import Rides
          </button>
        </div>
      ) : (
        <>
          {/* Stats */}
          <RideStats rides={rides} />
          
          {/* View All Toggle */}
          {ridesWithRoutes.length > 0 && (
            <div className="px-4 py-2 border-b border-white/10 flex items-center justify-between">
              <span className="text-xs text-white/60">
                {ridesWithRoutes.length} ride{ridesWithRoutes.length !== 1 ? 's' : ''} with routes
              </span>
              <button
                onClick={() => {
                  setShowAllRides(!showAllRides)
                  if (!showAllRides) {
                    selectRide(null) // Clear single selection when viewing all
                    onClose() // Close panel to see the map
                  }
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  showAllRides 
                    ? "bg-blue-500 text-white" 
                    : "bg-white/10 text-white/70 hover:bg-white/15"
                )}
              >
                <Eye className="size-3" />
                {showAllRides ? "Viewing All" : "View All on Map"}
              </button>
            </div>
          )}
          
          {/* Rides list */}
          <div className="flex-1 overflow-y-auto">
            {Array.from(groupedRides.entries()).map(([monthYear, monthRides]) => (
              <div key={monthYear}>
                {/* Month header */}
                <div className="sticky top-0 px-3 py-2 bg-black/80 backdrop-blur-sm border-b border-white/5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-white/60 uppercase tracking-wide">
                      {monthYear}
                    </span>
                    <span className="text-xs text-white/40">
                      {monthRides.length} ride{monthRides.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
                
                {/* Rides in month, grouped by date */}
                {(() => {
                  const byDate = new Map<string, UserRide[]>()
                  for (const ride of monthRides) {
                    const dateKey = formatRideDate(ride.date)
                    if (!byDate.has(dateKey)) byDate.set(dateKey, [])
                    byDate.get(dateKey)!.push(ride)
                  }
                  
                  return Array.from(byDate.entries()).map(([dateStr, dateRides]) => (
                    <div key={dateStr}>
                      {/* Date header */}
                      <div className="px-3 py-1.5 bg-white/[0.02]">
                        <span className="text-xs text-white/50">{dateStr}</span>
                      </div>
                      {/* Rides for this date */}
                      <div className="divide-y divide-white/5">
                        {dateRides.map(ride => (
                          <RideItem 
                            key={ride.id} 
                            ride={ride} 
                            isSelected={selectedRideId === ride.id}
                            onSelect={(id) => {
                              selectRide(id)
                              setShowAllRides(false) // Turn off "view all" when selecting a single ride
                            }}
                            onClose={onClose}
                          />
                        ))}
                      </div>
                    </div>
                  ))
                })()}
              </div>
            ))}
          </div>
          
          {/* Footer actions */}
          <div className="px-4 py-3 border-t border-white/10 flex items-center justify-between gap-2">
            <button
              onClick={() => {
                onClose()
                openUpload()
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white/70 hover:text-white/90 hover:bg-white/5 rounded-lg transition-colors"
            >
              <Upload className="size-3.5" />
              Import More
            </button>
            <button
              onClick={() => {
                if (confirm('Clear all imported rides?')) {
                  clearRides()
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-400/70 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
            >
              <Trash2 className="size-3.5" />
              Clear All
            </button>
          </div>
        </>
      )}
    </div>
  )
})
