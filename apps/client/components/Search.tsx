"use client"
import { EBike } from "@/components/icons/Ebike"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DATA_END_DATE, DATA_START_DATE, REAL_FADE_DURATION_MS } from "@/lib/config"
import { formatDateTime, formatDateTimeFull, formatDistance, formatDurationMinutes } from "@/lib/format"
import { useAnimationStore } from "@/lib/stores/animation-store"
import { usePickerStore } from "@/lib/stores/location-picker-store"
import { useSearchStore } from "@/lib/stores/search-store"
import { useStationsStore, type Station } from "@/lib/stores/stations-store"
import { filterTrips } from "@/lib/trip-filters"
import { cn } from "@/lib/utils"
import { duckdbService } from "@/services/duckdb-service"
import distance from "@turf/distance"
import { point } from "@turf/helpers"
import * as chrono from "chrono-node"
import { Fzf } from "fzf"
import { ArrowLeft, ArrowRight, Bike, CalendarSearch, Loader2, MapPin, Search as SearchIcon } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import React from "react"

type SearchMode = "ride" | "time"

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

const MAX_RESULTS = 15

export function Search() {
  const { isOpen, open: openSearch, toggle, close, step, setStep, datetimeHistory, addToHistory } = useSearchStore()
  const [search, setSearch] = React.useState("")

  // Mode switching (ride search vs time jump)
  const [mode, setMode] = React.useState<SearchMode>("time")

  // Multi-step flow state
  const [selectedStation, setSelectedStation] = React.useState<Station | null>(null)
  const [datetimeInput, setDatetimeInput] = React.useState("")
  const [trips, setTrips] = React.useState<Trip[]>([])
  const [resultsSearch, setResultsSearch] = React.useState("")
  const [isLoadingTrips, setIsLoadingTrips] = React.useState(false)

  // History navigation state
  const [historyIndex, setHistoryIndex] = React.useState(-1)
  const [savedInput, setSavedInput] = React.useState("")

  const { pickedLocation, startPicking } = usePickerStore()
  const { animationStartDate, simCurrentTimeMs } = useAnimationStore()
  const { stations, getStation, load: loadStations } = useStationsStore()

  // Compute current real time (absolute) for chrono reference
  const realCurrentTimeMs = React.useMemo(() => {
    return new Date(animationStartDate.getTime() + simCurrentTimeMs)
  }, [animationStartDate, simCurrentTimeMs])

  // Parse datetime with chrono - uses current real time as reference for relative dates like "now"
  const parsedDate = React.useMemo(() => {
    if (!datetimeInput.trim()) return null
    return chrono.parseDate(datetimeInput, realCurrentTimeMs)
  }, [datetimeInput, realCurrentTimeMs])

  // Check if parsed date is outside available data range
  const isDateOutOfRange = !!parsedDate && (parsedDate < DATA_START_DATE || parsedDate > DATA_END_DATE)

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        toggle()
      }
      // Tab to switch modes (only when dialog is open and on datetime step)
      if (e.key === "Tab" && isOpen && step === "datetime") {
        e.preventDefault()
        setMode((m) => (m === "ride" ? "time" : "ride"))
        // Re-focus the input after mode switch
        setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>('[cmdk-input]')
          input?.focus()
        }, 0)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [toggle, isOpen, step])

  // Handle Esc key: go back to previous step instead of closing dialog
  const handleEscapeKeyDown = React.useCallback((e: KeyboardEvent) => {
    if (step === "station") {
      e.preventDefault()
      setStep("datetime")
      setSearch("")
      focusInput()
    } else if (step === "results") {
      e.preventDefault()
      setStep("station")
      setSelectedStation(null)
      setTrips([])
      setResultsSearch("")
      setSearch("")
      focusInput()
    }
    // step === "datetime" falls through to default dialog close behavior
  }, [step, setStep])

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
      setHistoryIndex(-1)
      setSavedInput("")
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
    // Focus will be called after component updates
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('[cmdk-input]')
      input?.focus()
    }, 0)

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

  // Focus the command input after step transitions
  const focusInput = () => {
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('[cmdk-input]')
      input?.focus()
    }, 0)
  }

  // From station step, go back to datetime step
  const handleBackToDatetime = () => {
    setStep("datetime")
    setSearch("")
    focusInput()
  }

  // From results step, go back to station step
  const handleBackToStation = () => {
    setStep("station")
    setSelectedStation(null)
    setTrips([])
    setResultsSearch("")
    setSearch("") // Clear station search for fresh input
    focusInput()
  }

  const handleConfirmDatetime = () => {
    if (parsedDate) {
      addToHistory(datetimeInput)
      setHistoryIndex(-1)
      setSavedInput("")
      setSearch("") // Clear station search for fresh input
      setStep("station")
      focusInput()
    }
  }

  const handleJumpToTime = () => {
    if (!parsedDate) return
    addToHistory(datetimeInput)
    setHistoryIndex(-1)
    setSavedInput("")
    // Skip if jumping to the same time (e.g., "now" when already at that time)
    if (parsedDate.getTime() === animationStartDate.getTime()) {
      handleOpenChange(false)
      return
    }
    useAnimationStore.getState().setAnimationStartDateAndPlay(parsedDate)
    handleOpenChange(false)
  }

  // Handle up/down arrow keys for history navigation
  const handleDatetimeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault()
      if (datetimeHistory.length === 0) return
      if (historyIndex === -1) {
        // Save current input before navigating
        setSavedInput(datetimeInput)
      }
      const newIndex = Math.min(historyIndex + 1, datetimeHistory.length - 1)
      setHistoryIndex(newIndex)
      setDatetimeInput(datetimeHistory[newIndex])
    } else if (e.key === "ArrowDown") {
      e.preventDefault()
      if (historyIndex === -1) return
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      if (newIndex === -1) {
        // Restore saved input
        setDatetimeInput(savedInput)
      } else {
        setDatetimeInput(datetimeHistory[newIndex])
      }
    }
  }

  // Reset history navigation when input changes manually
  const handleDatetimeChange = (value: string) => {
    setDatetimeInput(value)
    setHistoryIndex(-1)
  }

  const handleSelectTrip = (trip: Trip) => {
    const { setAnimationStartDate, selectTrip, speedup } = useAnimationStore.getState()

    // Start animation at fade-in time (accounting for speedup)
    const realStartTimeMs = new Date(new Date(trip.startedAt).getTime() - REAL_FADE_DURATION_MS * speedup)
    setAnimationStartDate(realStartTimeMs)

    const endStation = getStation(trip.endStationName)
    if (!selectedStation) {
      throw new Error(`No station selected`)
    }

    // Select the trip - BikeMap will render it once trips load
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
      <CommandDialog open={isOpen} onOpenChange={handleOpenChange} onEscapeKeyDown={handleEscapeKeyDown} shouldFilter={false} className="sm:max-w-xl">
        <div className="flex items-center px-3 py-2 border-b">
          <Tabs value={mode} onValueChange={(v) => setMode(v as SearchMode)} >
            <TabsList className="bg-[#1c1c1f]">
              <TabsTrigger value="time" className="data-[state=active]:bg-zinc-800">
                <CalendarSearch className="size-3.5" />
                Time travel
              </TabsTrigger>
              <TabsTrigger value="ride" className="data-[state=active]:bg-zinc-800">
                <SearchIcon className="size-3.5" />
                Find ride
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="text-xs text-muted-foreground flex items-center gap-1 ml-3">
              <Kbd>Tab</Kbd> to switch
          </span>
        </div>
        <CommandInput
          autoFocus
          placeholder={mode === "ride" ? "When did this ride start?" : "What time do you want to jump to?"}
          value={datetimeInput}
          onValueChange={handleDatetimeChange}
          onKeyDown={handleDatetimeKeyDown}
          icon={mode === "ride" ? <SearchIcon className="size-4 shrink-0 text-muted-foreground" /> : <CalendarSearch className="size-4 shrink-0 text-muted-foreground" />}
        />
        <div className="px-3 py-2 text-xs text-zinc-500 flex flex-col gap-0.5">
          <span>Processed <a href="https://citibikenyc.com/" target="_blank" className="underline hover:text-zinc-50 text-zinc-300 font-medium">Citi Bike</a> data spans June 2013 – December 2025.</span>
          <span>{'Try "July 4th 2019 at 8pm" or "Fri 4pm"'}</span>
        </div>
        <CommandList>
          <AnimatePresence mode="wait">
            {parsedDate && (
              <motion.div
                key="parsed-date"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
              >
                <CommandGroup>
                  <CommandItem
                    value="parsed-datetime"
                    onSelect={isDateOutOfRange ? undefined : (mode === "ride" ? handleConfirmDatetime : handleJumpToTime)}
                    className={cn("bg-accent", isDateOutOfRange && "cursor-not-allowed")}
                    disabled={isDateOutOfRange}
                  >
                    <ArrowRight className="size-4" />
                    {formatDateTime(parsedDate)}
                  </CommandItem>
                  {isDateOutOfRange && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="px-3 py-2 text-xs text-zinc-400"
                    >
                      No data available for this date.
                    </motion.div>
                  )}
                </CommandGroup>
              </motion.div>
            )}
          </AnimatePresence>
        </CommandList>
      </CommandDialog>
    )
  }

  // Render station step (after datetime confirmed)
  if (step === "station" && parsedDate) {
    return (
      <CommandDialog open={isOpen} onOpenChange={handleOpenChange} onEscapeKeyDown={handleEscapeKeyDown} className="sm:max-w-xl" shouldFilter={false}>
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
                <CommandItem onSelect={handlePickFromMap}>
                  <MapPin className="size-4" />
                  Pick location from map
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
            </>
          )}
          {filteredStations.length > 0 && (
            <CommandGroup heading={pickedLocation ? "Nearest Stations" : "Citibike Stations"}>
                {filteredStations.map((station, index) => (
                  <motion.div
                    key={station.name}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut", delay: index * 0.05 }}
                  >
                    <CommandItem
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
                  </motion.div>
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
      <CommandDialog open={isOpen} onOpenChange={handleOpenChange} onEscapeKeyDown={handleEscapeKeyDown} className="sm:max-w-xl" shouldFilter={false}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button
            onClick={handleBackToStation}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span className="font-medium truncate">{selectedStation.name}</span>
          <AnimatePresence mode="wait">
            {isLoadingTrips ? (
              <motion.div
                key="loading-spinner"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />
              </motion.div>
            ) : (
              <motion.span
                key="trip-count"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-muted-foreground shrink-0"
              >
                · {trips.length} ride{trips.length !== 1 ? "s" : ""}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <CommandInput
          autoFocus
          placeholder="Search end station..."
          value={resultsSearch}
          onValueChange={setResultsSearch}
        />
        <CommandList className="max-h-[500px]">
          <AnimatePresence mode="wait">
            {/* Empty state - no results after loading */}
            {!isLoadingTrips && trips.length === 0 && (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="py-6 text-center text-sm text-muted-foreground"
              >
                No rides found.
              </motion.div>
            )}

            {/* Results - show filtered trips */}
            {!isLoadingTrips && filteredTrips.length > 0 && (
              <motion.div
                key="results-list"
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                <CommandGroup>
                    {filteredTrips.slice(0, MAX_RESULTS).map((trip, index) => (
                      <motion.div
                        key={trip.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25, ease: "easeOut", delay: index * 0.05 }}
                      >
                        <CommandItem value={trip.id} onSelect={() => handleSelectTrip(trip)}>
                          <div className="flex items-center gap-3 w-full">
                            {trip.bikeType === "electric_bike" ? (
                              <EBike className="size-8 text-[#7DCFFF] shrink-0" />
                            ) : (
                              <Bike className="size-8 text-[#BB9AF7] shrink-0" />
                            )}
                            <div className="flex flex-col min-w-0">
                              <span className="font-medium">
                                {trip.bikeType === "electric_bike" ? "E-Bike" : "Bike"} ride · {formatDurationMinutes(trip.startedAt, trip.endedAt)}
                              </span>
                              <span className="text-sm text-muted-foreground">
                                {formatDateTimeFull({ startDate: trip.startedAt, endDate: trip.endedAt })}{trip.routeDistance && ` · ${formatDistance(trip.routeDistance)}`}
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
                      </motion.div>
                    ))}
                </CommandGroup>
              </motion.div>
            )}

            {/* Filtered empty state - has trips but filter returned nothing */}
            {!isLoadingTrips && trips.length > 0 && filteredTrips.length === 0 && (
              <motion.div
                key="filtered-empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="py-6 text-center text-sm text-muted-foreground"
              >
                No results found.
              </motion.div>
            )}
          </AnimatePresence>
        </CommandList>
      </CommandDialog>
    )
  }

  // Fallback (shouldn't reach here in normal flow)
  return null
}
