/**
 * Mapbox Directions API service for fetching bicycle routes.
 * 
 * Uses the Mapbox Directions API to get route geometry between two points.
 * Returns polyline6-encoded geometry compatible with the existing trip rendering.
 */

import polyline from "@mapbox/polyline"

export type RouteResult = {
  geometry: string      // polyline6-encoded path
  distance: number      // distance in meters
  duration: number      // duration in seconds (Mapbox estimate, not actual)
}

type MapboxRoute = {
  geometry: string      // polyline-encoded (precision 5)
  distance: number
  duration: number
}

type MapboxDirectionsResponse = {
  code: string
  routes: MapboxRoute[]
  message?: string
}

const MAPBOX_API_URL = "https://api.mapbox.com/directions/v5/mapbox/cycling"

/**
 * Fetch a cycling route between two coordinates using Mapbox Directions API.
 * 
 * @param start - [longitude, latitude] of start point
 * @param end - [longitude, latitude] of end point
 * @returns Route geometry (polyline6), distance, and duration
 */
export async function fetchRoute(
  start: [number, number],
  end: [number, number]
): Promise<RouteResult | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) {
    console.error("[MapboxRouting] No NEXT_PUBLIC_MAPBOX_TOKEN configured")
    return null
  }

  const coordinates = `${start[0]},${start[1]};${end[0]},${end[1]}`
  const url = `${MAPBOX_API_URL}/${coordinates}?geometries=polyline&overview=full&access_token=${token}`

  try {
    const response = await fetch(url)
    
    if (!response.ok) {
      console.error(`[MapboxRouting] API error: ${response.status} ${response.statusText}`)
      return null
    }

    const data: MapboxDirectionsResponse = await response.json()

    if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
      console.warn(`[MapboxRouting] No route found: ${data.message || data.code}`)
      return null
    }

    const route = data.routes[0]!
    
    // Mapbox returns polyline with precision 5, convert to precision 6 for consistency
    // with existing trip data (which uses polyline6 from OSRM)
    const decoded = polyline.decode(route.geometry, 5)
    const geometry = polyline.encode(decoded, 6)

    return {
      geometry,
      distance: route.distance,
      duration: route.duration,
    }
  } catch (error) {
    console.error("[MapboxRouting] Fetch error:", error)
    return null
  }
}

/**
 * Fetch routes for multiple coordinate pairs in parallel.
 * Includes rate limiting to avoid hitting Mapbox API limits.
 * 
 * @param pairs - Array of {start, end} coordinate pairs
 * @param concurrency - Max concurrent requests (default: 5)
 * @returns Map of "startLng,startLat->endLng,endLat" keys to RouteResult
 */
export async function fetchRoutesBatch(
  pairs: Array<{ start: [number, number]; end: [number, number] }>,
  concurrency = 5
): Promise<Map<string, RouteResult>> {
  const results = new Map<string, RouteResult>()
  
  // Process in batches to respect rate limits
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency)
    
    const promises = batch.map(async ({ start, end }) => {
      const key = `${start[0]},${start[1]}->${end[0]},${end[1]}`
      const route = await fetchRoute(start, end)
      if (route) {
        results.set(key, route)
      }
      return { key, route }
    })

    await Promise.all(promises)
    
    // Small delay between batches to be nice to the API
    if (i + concurrency < pairs.length) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  return results
}

/**
 * Create a straight-line route as fallback when API fails.
 * Returns polyline6-encoded geometry.
 */
export function createStraightLineRoute(
  start: [number, number],
  end: [number, number]
): RouteResult {
  // Create a simple 2-point path
  const path: [number, number][] = [
    [start[1], start[0]], // polyline uses [lat, lng]
    [end[1], end[0]],
  ]
  
  const geometry = polyline.encode(path, 6)
  
  // Calculate approximate distance using Haversine formula
  const R = 6371000 // Earth's radius in meters
  const dLat = (end[1] - start[1]) * Math.PI / 180
  const dLon = (end[0] - start[0]) * Math.PI / 180
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(start[1] * Math.PI / 180) * Math.cos(end[1] * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const distance = R * c

  return {
    geometry,
    distance,
    duration: 0, // Unknown for straight line
  }
}
