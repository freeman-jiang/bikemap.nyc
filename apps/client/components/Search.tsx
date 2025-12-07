"use client"
import { getStations } from "@/app/server/trips"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { usePickerStore } from "@/lib/store"
import distance from "@turf/distance"
import { point } from "@turf/helpers"
import { Fzf } from "fzf"
import { Bike, MapPin, X } from "lucide-react"
import React from "react"

type Station = {
  ids: string[]
  name: string
  latitude: number
  longitude: number
}

type StationWithDistance = Station & { distance: number }

const MAX_RESULTS = 10

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`
  }
  return `${(meters / 1000).toFixed(1)}km`
}

export function Search() {
  const [open, setOpen] = React.useState(false)
  const [stations, setStations] = React.useState<Station[]>([])
  const [search, setSearch] = React.useState("")

  const { pickedLocation, startPicking, clearPicking } = usePickerStore()

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

  // Re-open dialog when location is picked
  React.useEffect(() => {
    if (pickedLocation) {
      setOpen(true)
    }
  }, [pickedLocation])

  const fzf = React.useMemo(
    () => new Fzf(stations, { selector: (s) => s.name }),
    [stations]
  )

  const filteredStations = React.useMemo((): (Station | StationWithDistance)[] => {
    // If we have a picked location, sort by distance
    if (pickedLocation) {
      const pickedPoint = point([pickedLocation.lng, pickedLocation.lat])
      const withDistance = stations.map((s) => ({
        ...s,
        distance: distance(pickedPoint, point([s.longitude, s.latitude]), { units: "meters" }),
      }))
      withDistance.sort((a, b) => a.distance - b.distance)

      // If there's a search query, filter by name too
      if (search.trim()) {
        const matchingNames = new Set(
          fzf.find(search.trim()).map((r) => r.item.name)
        )
        return withDistance.filter((s) => matchingNames.has(s.name)).slice(0, MAX_RESULTS)
      }

      return withDistance.slice(0, MAX_RESULTS)
    }

    // Normal fuzzy search
    const query = search.trim()
    if (!query) return stations.slice(0, MAX_RESULTS)
    return fzf.find(query).slice(0, MAX_RESULTS).map((result) => result.item)
  }, [stations, search, fzf, pickedLocation])

  const handlePickFromMap = () => {
    setOpen(false)
    startPicking()
  }

  const handleClearLocation = () => {
    clearPicking()
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder={pickedLocation ? "Filter nearby stations..." : "Type a station name..."}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
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
        <CommandGroup heading={pickedLocation ? "Nearest Stations" : "Citibike Stations"}>
          {filteredStations.map((station) => (
            <CommandItem
              key={station.name}
              value={station.name}
              onSelect={() => {
                console.log("Selected station:", station)
                setOpen(false)
              }}
            >
              <Bike className="size-4" />
              <span className="flex-1">{station.name}</span>
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
