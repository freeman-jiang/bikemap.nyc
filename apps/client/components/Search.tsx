"use client"
import { EBike } from "@/components/icons/Ebike"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { FADE_DURATION_MS } from "@/lib/config"
import { formatDateTime, formatDateTimeFull, formatDistance, formatDurationMinutes } from "@/lib/format"
import { useAnimationStore } from "@/lib/stores/animation-store"
import { usePickerStore } from "@/lib/stores/location-picker-store"
import { useSearchStore } from "@/lib/stores/search-store"
import { useStationsStore, type Station } from "@/lib/stores/stations-store"
import { filterTrips } from "@/lib/trip-filters"
import { duckdbService } from "@/services/duckdb-service"
import distance from "@turf/distance"
import { point } from "@turf/helpers"
import * as chrono from "chrono-node"
import { Fzf } from "fzf"
import { ArrowLeft, ArrowRight, Bike, CalendarSearch, Loader2, MapPin, X } from "lucide-react"
import React from "react"

/** ± 30 minutes search window around the selected time */
const SEARCH_WINDOW_MS = 30 * 60 * 1000

type StationWithDistance = Station & { distance: number }

type Trip = {
  id: string
  startStationName: string
  endStationName: string
  startedAt: Date
  endedAt: Date
  bikeType: string
  memberCasual: string
  routeDistance: number | null
}

type SearchStep = "datetime" | "station" | "results"

const MAX_RESULTS = 10

export function Search() {
  const { isOpen, open: openSearch, toggle, close } = useSearchStore()
  const [search, setSearch] = React.useState("")

  // Multi-step flow state
  const [step, setStep] = React.useState<SearchStep>("datetime")
  const [selectedStation, setSelectedStation] = React.useState<Station | null>(null)
  const [datetimeInput, setDatetimeInput] = React.useState("")
  const [trips, setTrips] = React.useState<Trip[]>([])
  const [resultsSearch, setResultsSearch] = React.useState("")
  const [isLoadingTrips, setIsLoadingTrips] = React.useState(false)

  const { pickedLocation, startPicking, clearPicking } = usePickerStore()
  const { animationStartDate } = useAnimationStore()
  const { stations, getStation, load: loadStations } = useStationsStore()

  // Parse datetime with chrono
  const parsedDate = React.useMemo(() => {
    if (!datetimeInput.trim()) return null
    return chrono.parseDate(datetimeInput, animationStartDate)
  }, [datetimeInput, animationStartDate])

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        toggle()
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [toggle])

  React.useEffect(() => {
    loadStations()
  }, [loadStations])

  // Get display label for station (neighborhood, borough)
  const getStationRegionLabel = React.useCallback(
    (station: Station): string => {
      if (station.neighborhood.toLowerCase() === station.borough.toLowerCase()) {
        return station.neighborhood
      }
      return `${station.neighborhood}, ${station.borough}`
    },
    []
  )

  // Re-open dialog when location is picked
  React.useEffect(() => {
    if (pickedLocation) {
      openSearch()
    }
  }, [pickedLocation, openSearch])

  // Reset state when dialog closes
  const handleOpenChange = (newOpen: boolean) => {
    if (newOpen) {
      openSearch()
    } else {
      close()
      setStep("datetime")
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
        selector: (s) => s.neighborhood,
      }),
    [stations]
  )

  // Alias search: expand stations into (station, alias) pairs for fuzzy matching
  // This allows searching for historical station names while still returning the canonical station
  const aliasEntries = React.useMemo(
    () => stations.flatMap((s) => s.aliases.map((alias) => ({ station: s, alias }))),
    [stations]
  )
  const aliasFzf = React.useMemo(
    () => new Fzf(aliasEntries, { selector: (e) => e.alias }),
    [aliasEntries]
  )

  const filteredStations = React.useMemo((): (Station | StationWithDistance)[] => {
    // Helper to merge results from name, neighborhood, and alias fzf instances
    const getMergedMatches = (query: string): Station[] => {
      const nameMatches = nameFzf.find(query).map((r) => r.item)
      const neighborhoodMatches = neighborhoodFzf.find(query).map((r) => r.item)
      // Alias matches return the canonical station (not the alias text)
      const aliasMatches = aliasFzf.find(query).map((r) => r.item.station)

      const seen = new Set<string>()
      const merged: Station[] = []

      // Priority: name matches first, then neighborhood, then alias
      for (const station of [...nameMatches, ...neighborhoodMatches, ...aliasMatches]) {
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
  }, [stations, search, nameFzf, neighborhoodFzf, aliasFzf, pickedLocation])

  // Filter trips by end station name + neighborhood
  const filteredTrips = React.useMemo(() => {
    const query = resultsSearch.trim()
    if (!query) return trips

    const tripFzf = new Fzf(trips, {
      selector: (trip) => {
        const endStation = getStation(trip.endStationName)
        return `${endStation.name} ${endStation.neighborhood}`
      },
    })

    return tripFzf.find(query).map((r) => r.item)
  }, [trips, resultsSearch, getStation])

  const handlePickFromMap = () => {
    close()
    startPicking()
  }

  const handleClearLocation = () => {
    clearPicking()
  }

  const handleSelectStation = async (station: Station | StationWithDistance) => {
    if (!parsedDate) {
      throw new Error("Cannot select station without a parsed date")
    }

    // Optimistically transition to results step
    setSelectedStation(station)
    setTrips([]) // Clear previous results
    setSearch("") // Clear search input
    setResultsSearch("") // Clear results search for fresh input
    setStep("results")
    setIsLoadingTrips(true)

    try {
      // Initialize DuckDB if not already done
      await duckdbService.init()

      const rawTrips = await duckdbService.getTripsFromStation({
        startStationName: station.name,
        datetime: parsedDate,
        intervalMs: SEARCH_WINDOW_MS,
      })

      // Filter trips (must have route, valid speed, etc.)
      const filtered = filterTrips(rawTrips)
      console.log("Trips from station:", filtered)
      setTrips(filtered)
    } catch (error) {
      console.error("Failed to load trips:", error)
      // Keep trips as empty array on error
    } finally {
      setIsLoadingTrips(false)
    }
  }

  // From station step, go back to datetime step
  const handleBackToDatetime = () => {
    setStep("datetime")
    setSearch("")
  }

  // From results step, go back to station step
  const handleBackToStation = () => {
    setStep("station")
    setSelectedStation(null)
    setTrips([])
    setResultsSearch("")
    setSearch("") // Clear station search for fresh input
  }

  const handleConfirmDatetime = () => {
    if (parsedDate) {
      setSearch("") // Clear station search for fresh input
      setStep("station")
    }
  }

  const handleSelectTrip = (trip: Trip) => {
    const { setAnimationStartDate, selectTrip, speedup } = useAnimationStore.getState()

    // Start animation at fade-in time (accounting for speedup)
    const startTime = new Date(new Date(trip.startedAt).getTime() - FADE_DURATION_MS * speedup)
    setAnimationStartDate(startTime)

    const endStation = getStation(trip.endStationName)
    if (!selectedStation) {
      throw new Error(`No station selected`)
    }

    // Select the trip for highlighting with full metadata
    selectTrip({
      id: trip.id,
      info: {
        id: trip.id,
        bikeType: trip.bikeType,
        memberCasual: trip.memberCasual,
        startStationName: selectedStation.name,
        endStationName: endStation.name,
        startNeighborhood: selectedStation.neighborhood,
        endNeighborhood: endStation.neighborhood,
        startedAt: trip.startedAt,
        endedAt: trip.endedAt,
        routeDistance: trip.routeDistance,
      },
    })

    // Close dialog
    handleOpenChange(false)
  }

  // Render datetime step (first step - no station selected yet)
  if (step === "datetime") {
    return (
      <CommandDialog open={isOpen} onOpenChange={handleOpenChange} shouldFilter={false} className="sm:max-w-xl">
        <CommandInput
          autoFocus
          placeholder="When did this ride start?"
          value={datetimeInput}
          onValueChange={setDatetimeInput}
          icon={<CalendarSearch className="size-4 shrink-0 text-muted-foreground" />}
        />
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Search any <a href="https://citibikenyc.com/" target="_blank" rel="noopener" className="underline hover:text-foreground">{"Citi Bike"}</a> ride from 2013 to 2025.
        </div>
        <CommandList>
          {parsedDate && (
            <CommandGroup>
              <CommandItem onSelect={handleConfirmDatetime} className="bg-accent">
                <ArrowRight className="size-4" />
                {formatDateTime(parsedDate)}
              </CommandItem>
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    )
  }

  // Render station step (after datetime confirmed)
  if (step === "station" && parsedDate) {
    return (
      <CommandDialog open={isOpen} onOpenChange={handleOpenChange} className="sm:max-w-xl" shouldFilter={false}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button
            onClick={handleBackToDatetime}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <CalendarSearch className="size-4 text-muted-foreground" />
          <span className="font-medium">{formatDateTime(parsedDate)}</span>
        </div>
        <CommandInput
          autoFocus
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
          {filteredStations.length > 0 && (
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
                    <span className="text-xs text-muted-foreground">
                      {getStationRegionLabel(station)}
                    </span>
                  </div>
                  {"distance" in station && (
                    <span className="text-muted-foreground text-xs">
                      {formatDistance(station.distance)}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    )
  }

  // Render results step
  if (step === "results" && selectedStation) {
    return (
      <CommandDialog open={isOpen} onOpenChange={handleOpenChange} className="sm:max-w-xl" shouldFilter={false}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button
            onClick={handleBackToStation}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span className="font-medium truncate">{selectedStation.name}</span>
          {isLoadingTrips ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
          ) : (
            <span className="text-muted-foreground shrink-0">
              · {trips.length} ride{trips.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <CommandInput
          autoFocus
          placeholder="Search end station..."
          value={resultsSearch}
          onValueChange={setResultsSearch}
        />
        <CommandList className="max-h-[500px]">
          {/* Empty state - no results after loading */}
          {!isLoadingTrips && trips.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </div>
          )}

          {/* Results - show filtered trips */}
          {!isLoadingTrips && filteredTrips.length > 0 && (
            <CommandGroup>
              {filteredTrips.map((trip) => (
                <CommandItem key={trip.id} value={trip.id} onSelect={() => handleSelectTrip(trip)}>
                  <div className="flex items-center gap-3 w-full">
                    {trip.bikeType === "electric_bike" ? (
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
                        {getStation(trip.endStationName).name}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {getStation(trip.endStationName).neighborhood}
                      </span>
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {/* Filtered empty state - has trips but filter returned nothing */}
          {!isLoadingTrips && trips.length > 0 && filteredTrips.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </div>
          )}
        </CommandList>
      </CommandDialog>
    )
  }

  // Fallback (shouldn't reach here in normal flow)
  return null
}
