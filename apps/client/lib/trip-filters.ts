import type { TripWithRoute } from "./trip-types";

/**
 * Filters trips to only include those that can be rendered on the map.
 * Used by both Search (getTripsFromStation) and BikeMap (prepareTripsForDeck).
 *
 * Criteria:
 * 1. Must have route geometry
 * 2. Can't be same-station trip
 * 3. Speed must be 2-18 km/h
 */
export function filterTrips<T extends TripWithRoute>(trips: T[]): T[] {
  return trips.filter((trip) => {
    // Must have route geometry
    if (!trip.routeGeometry) return false;

    // Can't be same-station trip
    if (trip.startStationId === trip.endStationId) return false;

    // Speed must be 2-18 km/h
    if (!trip.routeDistance) return false;
    const durationMs = trip.endedAt.getTime() - trip.startedAt.getTime();
    const durationHours = durationMs / (1000 * 60 * 60);
    const speedKmh = trip.routeDistance / 1000 / durationHours;
    if (speedKmh <= 2 || speedKmh >= 18) return false;

    return true;
  });
}
