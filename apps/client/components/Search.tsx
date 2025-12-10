"use client"
import { getStations, getTripsFromStation } from "@/app/server/trips"
import { EBike } from "@/components/icons/Ebike"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { useAnimationStore } from "@/lib/stores/animation-store"
import { formatDateTimeFull, formatDateTime, formatDistance, formatDurationMinutes } from "@/lib/format"
import { usePickerStore } from "@/lib/stores/location-picker-store"
import distance from "@turf/distance"
import { point } from "@turf/helpers"
import * as chrono from "chrono-node"
import { Fzf } from "fzf"
import { ArrowLeft, ArrowRight, Bike, CalendarSearch, MapPin, X } from "lucide-react"
import React from "react"

type Station = {
  ids: string[]
  name: string
  latitude: number
  longitude: number
}

type StationWithDistance = Station & { distance: number }

type Trip = {
  id: string
  startStationId: string
  endStationId: string
  startedAt: Date
  endedAt: Date
  rideableType: string
  memberCasual: string
  routeDistance: number | null
}

type SearchStep = "station" | "datetime" | "results"

const MAX_RESULTS = 10
const LOOKBACK_MINUTES = 10

type StationRegion = {
  region: string
  neighborhood: string
}

function getStationName(stationId: string, stationMap: Map<string, Station>): string {
  const station = stationMap.get(stationId)
  if (!station) {
    throw new Error(`Station not found: ${stationId}`)
  }
  return station.name
}

export function Search() {
  const [open, setOpen] = React.useState(false)
  const [stations, setStations] = React.useState<Station[]>([])
  const [search, setSearch] = React.useState("")

  // Multi-step flow state
  const [step, setStep] = React.useState<SearchStep>("station")
  const [selectedStation, setSelectedStation] = React.useState<Station | null>(null)
  const [datetimeInput, setDatetimeInput] = React.useState("")
  const [trips, setTrips] = React.useState<Trip[]>([])
  const [resultsSearch, setResultsSearch] = React.useState("")
  const [stationRegions, setStationRegions] = React.useState<Record<string, StationRegion>>({})

  const { pickedLocation, startPicking, clearPicking } = usePickerStore()
  const { animationStartDate } = useAnimationStore()

  // Parse datetime with chrono
  const parsedDate = React.useMemo(() => {
    if (!datetimeInput.trim()) return null
    return chrono.parseDate(datetimeInput, animationStartDate)
  }, [datetimeInput, animationStartDate])

  // Map station IDs to stations for O(1) lookup
  const stationMap = React.useMemo(() => {
    const map = new Map<string, Station>()
    for (const station of stations) {
      for (const id of station.ids) {
        map.set(id, station)
      }
    }
    return map
  }, [stations])

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((open) => !open)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  React.useEffect(() => {
    getStations().then(setStations)
  }, [])

  // Load station regions
  React.useEffect(() => {
    fetch("/station-regions.json")
      .then((res) => res.json())
      .then(setStationRegions)
  }, [])

  // Get region for a station by checking all its IDs
  const getStationRegion = React.useCallback(
    (stationIds: string[]): StationRegion | null => {
      for (const id of stationIds) {
        if (stationRegions[id]) return stationRegions[id]
      }
      return null
    },
    [stationRegions]
  )

  // Re-open dialog when location is picked
  React.useEffect(() => {
    if (pickedLocation) {
      setOpen(true)
    }
  }, [pickedLocation])

  // Reset state when dialog closes
  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen)
    if (!newOpen) {
      setStep("station")
      setSelectedStation(null)
      setDatetimeInput("")
      setSearch("")
      setTrips([])
    }
  }

  const nameFzf = React.useMemo(
    () => new Fzf(stations, { selector: (s) => s.name }),
    [stations]
  )

  const neighborhoodFzf = React.useMemo(
    () =>
      new Fzf(stations, {
        selector: (s) => {
          const region = s.ids.map((id) => stationRegions[id]).find(Boolean)
          return region?.neighborhood ?? ""
        },
      }),
    [stations, stationRegions]
  )

  const filteredStations = React.useMemo((): (Station | StationWithDistance)[] => {
    // Helper to merge results from both fzf instances
    const getMergedMatches = (query: string): Station[] => {
      const nameMatches = nameFzf.find(query).map((r) => r.item)
      const neighborhoodMatches = neighborhoodFzf.find(query).map((r) => r.item)

      const seen = new Set<string>()
      const merged: Station[] = []

      for (const station of [...nameMatches, ...neighborhoodMatches]) {
        if (!seen.has(station.name)) {
          seen.add(station.name)
          merged.push(station)
        }
      }

      return merged
    }

    // If we have a picked location, sort by distance
    if (pickedLocation) {
      const pickedPoint = point([pickedLocation.lng, pickedLocation.lat])
      const withDistance = stations.map((s) => ({
        ...s,
        distance: distance(pickedPoint, point([s.longitude, s.latitude]), { units: "meters" }),
      }))
      withDistance.sort((a, b) => a.distance - b.distance)

      // If there's a search query, filter by merged matches
      if (search.trim()) {
        const matchingNames = new Set(getMergedMatches(search.trim()).map((s) => s.name))
        return withDistance.filter((s) => matchingNames.has(s.name)).slice(0, MAX_RESULTS)
      }

      return withDistance.slice(0, MAX_RESULTS)
    }

    // Normal fuzzy search
    const query = search.trim()
    if (!query) return stations.slice(0, MAX_RESULTS)
    return getMergedMatches(query).slice(0, MAX_RESULTS)
  }, [stations, search, nameFzf, neighborhoodFzf, pickedLocation])

  // Filter trips by end station name + neighborhood
  const filteredTrips = React.useMemo(() => {
    const query = resultsSearch.trim()
    if (!query) return trips

    const tripFzf = new Fzf(trips, {
      selector: (trip) => {
        const endStation = stationMap.get(trip.endStationId)
        const endStationName = endStation?.name ?? ""
        const neighborhood = stationRegions[trip.endStationId]?.neighborhood ?? ""
        return `${endStationName} ${neighborhood}`
      },
    })

    return tripFzf.find(query).map((r) => r.item)
  }, [trips, resultsSearch, stationMap, stationRegions])

  const handlePickFromMap = () => {
    setOpen(false)
    startPicking()
  }

  const handleClearLocation = () => {
    clearPicking()
  }

  const handleSelectStation = (station: Station | StationWithDistance) => {
    setSelectedStation(station)
    setStep("datetime")
    setSearch("")
  }

  const handleBackToStation = () => {
    setStep("station")
    setSelectedStation(null)
    setDatetimeInput("")
    setTrips([])
  }

  const handleBackToDatetime = () => {
    setStep("datetime")
    setTrips([])
  }

  const handleConfirmSelection = async () => {
    if (selectedStation && parsedDate) {
      const result = await getTripsFromStation({
        startStationIds: selectedStation.ids,
        datetime: parsedDate,
        intervalSeconds: 1800,
      })
      console.log("Trips from station:", result.trips)
      setTrips(result.trips)
      setStep("results")
    }
  }

  const handleSelectTrip = (trip: Trip) => {
    const { setAnimationStartDate, selectTrip } = useAnimationStore.getState()

    // Set start time to LOOKBACK_MINUTES before trip starts
    const startTime = new Date(new Date(trip.startedAt).getTime() - LOOKBACK_MINUTES * 60 * 1000)
    setAnimationStartDate(startTime)

    // Select the trip for highlighting
    selectTrip(trip.id)

    // Close dialog
    handleOpenChange(false)
  }

  // Render datetime step
  if (step === "datetime" && selectedStation) {
    return (
      <CommandDialog open={open} onOpenChange={handleOpenChange} shouldFilter={false} className="sm:max-w-xl">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button
            onClick={handleBackToStation}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <Bike className="size-4 text-muted-foreground" />
          <span className="font-medium">{selectedStation.name}</span>
        </div>
        <CommandInput
          autoFocus
          placeholder="When did this ride start?"
          value={datetimeInput}
          onValueChange={setDatetimeInput}
          icon={<CalendarSearch className="size-4 shrink-0 text-muted-foreground" />}
        />
        <CommandList>
          {parsedDate && (
            <CommandGroup>
              <CommandItem onSelect={handleConfirmSelection} className="bg-accent">
                <ArrowRight className="size-4" />
                {formatDateTime(parsedDate)}
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    )
  }

  // Render results step
  if (step === "results" && selectedStation) {
    return (
      <CommandDialog open={open} onOpenChange={handleOpenChange} className="sm:max-w-xl" shouldFilter={false}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button
            onClick={handleBackToDatetime}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span className="font-medium truncate">{selectedStation.name}</span>
          <span className="text-muted-foreground shrink-0">
            · {trips.length} ride{trips.length !== 1 ? "s" : ""}
          </span>
        </div>
        <CommandInput placeholder="Search end station..." value={resultsSearch} onValueChange={setResultsSearch} />
        <CommandList className="max-h-[500px]">
          <CommandGroup>
            {filteredTrips.map((trip) => (
              <CommandItem key={trip.id} onSelect={() => handleSelectTrip(trip)}>
                <div className="flex items-center gap-3 w-full">
                  {trip.rideableType === "electric_bike" ? (
                    <EBike className="size-8 text-[#7DCFFF] shrink-0" />
                  ) : (
                    <Bike className="size-8 text-[#BB9AF7] shrink-0" />
                  )}
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium">
                      Bike ride · {formatDurationMinutes(trip.startedAt, trip.endedAt)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {formatDateTimeFull(trip.startedAt)}{trip.routeDistance && ` · ${formatDistance(trip.routeDistance)}`}
                    </span>
                  </div>
                  <div className="ml-auto flex flex-col items-end">
                    <span className="text-zinc-100 font-normal truncate max-w-[30ch]">
                      {getStationName(trip.endStationId, stationMap)}
                    </span>
                    {stationRegions[trip.endStationId]?.neighborhood && (
                      <span className="text-sm text-muted-foreground">
                        {stationRegions[trip.endStationId].neighborhood}
                      </span>
                    )}
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    )
  }

  // Render station step (default)
  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange} className="sm:max-w-xl" shouldFilter={false}>
      <CommandInput
        placeholder={pickedLocation ? "Filter nearby stations..." : "Type a station name..."}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-[500px]">
        <CommandEmpty>No results found.</CommandEmpty>
        {!search.trim() && (
          <>
            <CommandGroup heading="Actions">
              {pickedLocation ? (
                <CommandItem onSelect={handleClearLocation}>
                  <X className="size-4" />
                  Clear picked location
                </CommandItem>
              ) : (
                <CommandItem onSelect={handlePickFromMap}>
                  <MapPin className="size-4" />
                  Pick location from map
                </CommandItem>
              )}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        <CommandGroup heading={pickedLocation ? "Nearest Stations" : "Citibike Stations"}>
          {filteredStations.map((station) => (
            <CommandItem
              key={station.name}
              value={station.name}
              onSelect={() => handleSelectStation(station)}
            >
              <Bike className="size-4" />
              <div className="flex flex-col flex-1">
                <span>{station.name}</span>
                {getStationRegion(station.ids) && (
                  <span className="text-xs text-muted-foreground">
                    {getStationRegion(station.ids)?.neighborhood}, {getStationRegion(station.ids)?.region}
                  </span>
                )}
              </div>
              {"distance" in station && (
                <span className="text-muted-foreground text-xs">
                  {formatDistance(station.distance)}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
