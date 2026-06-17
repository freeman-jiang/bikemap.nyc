/**
 * Service for resolving route geometries for user rides.
 * 
 * Flow:
 * 1. Match station names from receipts to stations.json (with fuzzy matching)
 * 2. Get coordinates for start/end stations
 * 3. Fetch route geometry from Mapbox Directions API
 * 4. Update rides with geometry
 */

import type { Station } from "@/lib/stores/stations-store"
import type { UserRide } from "@/lib/stores/user-rides-store"
import { fetchRoute, createStraightLineRoute, type RouteResult } from "./mapbox-routing-service"

type StationMatch = {
  station: Station
  confidence: "exact" | "alias" | "fuzzy"
}

/**
 * Find a station by name, checking canonical names, aliases, and fuzzy matches.
 */
function findStation(
  name: string,
  stations: Station[],
  stationByName: Map<string, Station>
): StationMatch | null {
  // 1. Exact match on canonical name
  const exact = stationByName.get(name)
  if (exact) {
    return { station: exact, confidence: "exact" }
  }

  // 2. Check aliases
  for (const station of stations) {
    if (station.aliases?.includes(name)) {
      return { station, confidence: "alias" }
    }
  }

  // 3. Fuzzy match - normalize and compare
  const normalized = normalizeName(name)
  
  for (const station of stations) {
    if (normalizeName(station.name) === normalized) {
      return { station, confidence: "fuzzy" }
    }
    for (const alias of station.aliases ?? []) {
      if (normalizeName(alias) === normalized) {
        return { station, confidence: "fuzzy" }
      }
    }
  }

  // 4. Partial match - check if one contains the other
  for (const station of stations) {
    const stationNorm = normalizeName(station.name)
    if (stationNorm.includes(normalized) || normalized.includes(stationNorm)) {
      return { station, confidence: "fuzzy" }
    }
  }

  return null
}

/**
 * Normalize station name for fuzzy matching.
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .replace(/\bst\b/g, "street")
    .replace(/\bave?\b/g, "avenue")
    .replace(/\bblvd\b/g, "boulevard")
    .replace(/\bpkwy\b/g, "parkway")
    .replace(/\bpl\b/g, "place")
    .replace(/\bdr\b/g, "drive")
    .replace(/\bln\b/g, "lane")
    .replace(/\brd\b/g, "road")
    .replace(/\bct\b/g, "court")
    .replace(/\bn\b/g, "north")
    .replace(/\bs\b/g, "south")
    .replace(/\be\b/g, "east")
    .replace(/\bw\b/g, "west")
    .trim()
}

export type RouteResolutionResult = {
  resolved: number
  failed: number
  errors: string[]
}

/**
 * Resolve routes for user rides.
 * 
 * @param rides - User rides to resolve routes for
 * @param stations - All stations from stations.json
 * @param stationByName - Map of station name -> Station
 * @param onProgress - Callback for progress updates
 * @returns Updates to apply to rides
 */
export async function resolveRoutesForRides(
  rides: UserRide[],
  stations: Station[],
  stationByName: Map<string, Station>,
  onProgress?: (current: number, total: number) => void
): Promise<{
  updates: Array<{ id: string; updates: Partial<UserRide> }>
  result: RouteResolutionResult
}> {
  const updates: Array<{ id: string; updates: Partial<UserRide> }> = []
  const errors: string[] = []
  let resolved = 0
  let failed = 0

  // Cache routes by station pair to avoid duplicate API calls
  const routeCache = new Map<string, RouteResult | null>()

  for (let i = 0; i < rides.length; i++) {
    const ride = rides[i]!
    onProgress?.(i + 1, rides.length)

    // Skip if already has route
    if (ride.routeGeometry) {
      resolved++
      continue
    }

    // Find start station
    const startMatch = findStation(ride.startStation, stations, stationByName)
    if (!startMatch) {
      errors.push(`Ride ${ride.id}: Start station not found: "${ride.startStation}"`)
      failed++
      continue
    }

    // Find end station
    const endMatch = findStation(ride.endStation, stations, stationByName)
    if (!endMatch) {
      errors.push(`Ride ${ride.id}: End station not found: "${ride.endStation}"`)
      failed++
      continue
    }

    const startCoords: [number, number] = [startMatch.station.longitude, startMatch.station.latitude]
    const endCoords: [number, number] = [endMatch.station.longitude, endMatch.station.latitude]
    const cacheKey = `${startCoords.join(",")}->${endCoords.join(",")}`

    // Check cache first
    let route: RouteResult | null
    if (routeCache.has(cacheKey)) {
      route = routeCache.get(cacheKey)!
    } else {
      // Fetch route from Mapbox
      route = await fetchRoute(startCoords, endCoords)
      
      // Fall back to straight line if API fails
      if (!route) {
        console.warn(`[RouteResolver] API failed for ${ride.startStation} -> ${ride.endStation}, using straight line`)
        route = createStraightLineRoute(startCoords, endCoords)
      }
      
      routeCache.set(cacheKey, route)
    }

    if (route) {
      updates.push({
        id: ride.id,
        updates: {
          routeGeometry: route.geometry,
          routeDistance: route.distance,
          startLat: startMatch.station.latitude,
          startLng: startMatch.station.longitude,
          endLat: endMatch.station.latitude,
          endLng: endMatch.station.longitude,
        }
      })
      resolved++
    } else {
      failed++
    }
  }

  return {
    updates,
    result: { resolved, failed, errors }
  }
}
