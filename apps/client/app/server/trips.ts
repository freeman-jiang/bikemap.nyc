"use server";

import { filterTrips } from "@/lib/trip-filters";
import { Prisma, prisma } from "@bikemap/db";

export async function getTripsForChunk(params: {
  chunkStart: Date;
  chunkEnd: Date;
}) {
  const { chunkStart, chunkEnd } = params;

  // Get trips that overlap with this chunk (start before chunk ends, end after chunk starts)
  const tripsWithRoutes = await prisma.$queryRaw<
    Array<{
      id: string;
      startStationId: string;
      endStationId: string;
      startedAt: Date;
      endedAt: Date;
      rideableType: string;
      memberCasual: string;
      startLat: number;
      startLng: number;
      endLat: number | null;
      endLng: number | null;
      routeGeometry: string | null;
      routeDistance: number | null;
      routeDuration: number | null;
    }>
  >`
    SELECT
      t.id,
      t.startStationId,
      t.endStationId,
      t.startedAt,
      t.endedAt,
      t.rideableType,
      t.memberCasual,
      t.startLat,
      t.startLng,
      t.endLat,
      t.endLng,
      r.geometry as routeGeometry,
      r.distance as routeDistance,
      r.duration as routeDuration
    FROM Trip t
    LEFT JOIN Route r
      ON r.startStationId = t.startStationId
      AND r.endStationId = t.endStationId
    WHERE t.startedAt < ${chunkEnd}
      AND t.endedAt > ${chunkStart}
    ORDER BY t.startedAt ASC
  `;

  return {
    count: tripsWithRoutes.length,
    trips: tripsWithRoutes,
  };
}

// Get rides that START within a time window (for progressive loading)
export async function getRidesStartingIn(params: {
  from: Date;
  to: Date;
}) {
  const { from, to } = params;

  const tripsWithRoutes = await prisma.$queryRaw<
    Array<{
      id: string;
      startStationId: string;
      endStationId: string;
      startedAt: Date;
      endedAt: Date;
      rideableType: string;
      memberCasual: string;
      startLat: number;
      startLng: number;
      endLat: number | null;
      endLng: number | null;
      routeGeometry: string | null;
      routeDistance: number | null;
      routeDuration: number | null;
    }>
  >`
    SELECT
      t.id,
      t.startStationId,
      t.endStationId,
      t.startedAt,
      t.endedAt,
      t.rideableType,
      t.memberCasual,
      t.startLat,
      t.startLng,
      t.endLat,
      t.endLng,
      r.geometry as routeGeometry,
      r.distance as routeDistance,
      r.duration as routeDuration
    FROM Trip t
    LEFT JOIN Route r
      ON r.startStationId = t.startStationId
      AND r.endStationId = t.endStationId
    WHERE t.startedAt >= ${from}
      AND t.startedAt < ${to}
    ORDER BY t.startedAt ASC
  `;

  return {
    count: tripsWithRoutes.length,
    trips: tripsWithRoutes,
  };
}

export async function getStations() {
  // Merge duplicate stations by name, aggregating all IDs
  const stations = await prisma.$queryRaw<
    Array<{
      ids: string;
      name: string;
      latitude: number;
      longitude: number;
    }>
  >`
    SELECT
      GROUP_CONCAT(id) as ids,
      name,
      AVG(latitude) as latitude,
      AVG(longitude) as longitude
    FROM Station
    GROUP BY name
  `;

  // Convert comma-separated ids string to array
  return stations.map((s) => ({
    ...s,
    ids: s.ids.split(","),
  }));
}

// Get trips from station(s) within a time window (datetime ± interval)
// Accepts multiple station IDs to handle merged/duplicate stations
export async function getTripsFromStation(params: {
  startStationIds: string[];
  datetime: Date;
  intervalSeconds: number;
}) {
  const { startStationIds, datetime, intervalSeconds } = params;

  const windowStart = new Date(datetime.getTime() - intervalSeconds * 1000);
  const windowEnd = new Date(datetime.getTime() + intervalSeconds * 1000);

  const tripsWithRoutes = await prisma.$queryRaw<
    Array<{
      id: string;
      startStationId: string;
      endStationId: string;
      startedAt: Date;
      endedAt: Date;
      rideableType: string;
      memberCasual: string;
      startLat: number;
      startLng: number;
      endLat: number | null;
      endLng: number | null;
      routeGeometry: string | null;
      routeDistance: number | null;
      routeDuration: number | null;
    }>
  >`
    SELECT
      t.id,
      t.startStationId,
      t.endStationId,
      t.startedAt,
      t.endedAt,
      t.rideableType,
      t.memberCasual,
      t.startLat,
      t.startLng,
      t.endLat,
      t.endLng,
      r.geometry as routeGeometry,
      r.distance as routeDistance,
      r.duration as routeDuration
    FROM Trip t
    LEFT JOIN Route r
      ON r.startStationId = t.startStationId
      AND r.endStationId = t.endStationId
    WHERE t.startStationId IN (${Prisma.join(startStationIds)})
      AND t.startedAt >= ${windowStart}
      AND t.startedAt <= ${windowEnd}
    ORDER BY t.startedAt ASC
  `;

  const filtered = filterTrips(tripsWithRoutes);
  return {
    count: filtered.length,
    trips: filtered,
  };
}
