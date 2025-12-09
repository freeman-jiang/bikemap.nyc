/// <reference lib="webworker" />

import polyline from "@mapbox/polyline";
import distance from "@turf/distance";
import { point } from "@turf/helpers";
import {
  BATCH_SIZE_SECONDS,
  CHUNK_SIZE_SECONDS,
  EASE_DISTANCE_METERS,
  TRAIL_LENGTH_SECONDS,
} from "../lib/chunk-config";
import type {
  ClearBatchMessage,
  InitMessage,
  LoadBatchMessage,
  MainToWorkerMessage,
  RequestChunkMessage,
  UpdateConfigMessage,
  WorkerToMainMessage,
} from "../lib/trip-processor-protocol";
import type { DeckTrip, Phase, RawTrip } from "../lib/trip-types";

// === Worker State ===
let windowStartMs = 0;
let fadeDurationSimSeconds = 0;
let initialized = false;

// Chunk index -> DeckTrip[]
const chunkMap = new Map<number, DeckTrip[]>();

// Track which batches are processed
const processedBatches = new Set<number>();

// === Helper: Post typed message ===
function post(message: WorkerToMainMessage): void {
  self.postMessage(message);
}

// === Trip Filtering (copied from trip-filters.ts) ===
type TripWithRoute = {
  startStationId: string;
  endStationId: string;
  startedAt: string;
  endedAt: string;
  routeGeometry: string | null;
  routeDistance: number | null;
};

function filterTrips<T extends TripWithRoute>(trips: T[]): T[] {
  return trips.filter((trip) => {
    if (!trip.routeGeometry) return false;
    if (trip.startStationId === trip.endStationId) return false;
    if (!trip.routeDistance) return false;

    const durationMs =
      new Date(trip.endedAt).getTime() - new Date(trip.startedAt).getTime();
    const durationHours = durationMs / (1000 * 60 * 60);
    const speedKmh = trip.routeDistance / 1000 / durationHours;
    if (speedKmh <= 2 || speedKmh >= 18) return false;

    return true;
  });
}

// === Time Fraction with Easing ===
function getTimeFraction(dist: number, totalDist: number): number {
  if (totalDist <= 0) return 0;

  const easeDist = Math.min(EASE_DISTANCE_METERS, totalDist / 4);
  const easeInEnd = easeDist;
  const easeOutStart = totalDist - easeDist;
  const linearDist = totalDist - 2 * easeDist;
  const totalTime = 2 * easeDist + linearDist + 2 * easeDist;
  const easeInTime = 2 * easeDist;
  const linearTime = linearDist;

  if (dist < easeInEnd) {
    const t = dist / easeDist;
    const timeInEase = Math.sqrt(t);
    return (timeInEase * easeInTime) / totalTime;
  } else if (dist > easeOutStart) {
    const distIntoEaseOut = dist - easeOutStart;
    const t = Math.min(1, distIntoEaseOut / easeDist);
    const timeInEase = 1 - Math.sqrt(1 - t);
    const timeBeforeEaseOut = easeInTime + linearTime;
    return (timeBeforeEaseOut + timeInEase * easeInTime) / totalTime;
  } else {
    const distIntoLinear = dist - easeInEnd;
    return (easeInTime + distIntoLinear) / totalTime;
  }
}

// === Prepare Trips for DeckGL ===
function prepareTripsForDeck(data: {
  trips: RawTrip[];
  windowStartMs: number;
  fadeDurationSimSeconds: number;
}): DeckTrip[] {
  const { trips, windowStartMs: winStart, fadeDurationSimSeconds: fadeDur } = data;

  // Filter trips
  const validTrips = filterTrips(trips) as (RawTrip & {
    routeGeometry: string;
  })[];

  const prepared = validTrips
    .map((trip) => {
      // Decode polyline6 - returns [lat, lng][], flip to [lng, lat]
      const decoded = polyline.decode(trip.routeGeometry, 6);
      const coordinates = decoded.map(
        ([lat, lng]) => [lng, lat] as [number, number]
      );

      if (coordinates.length < 2) return null;

      // Calculate cumulative distances
      const cumulativeDistances: number[] = [0];
      for (let i = 1; i < coordinates.length; i++) {
        const segmentDist = distance(
          point(coordinates[i - 1]),
          point(coordinates[i]),
          { units: "meters" }
        );
        cumulativeDistances.push(cumulativeDistances[i - 1] + segmentDist);
      }

      const totalDistance = cumulativeDistances[cumulativeDistances.length - 1];

      // Convert to seconds from window start
      const tripStartMs = new Date(trip.startedAt).getTime();
      const tripEndMs = new Date(trip.endedAt).getTime();
      const tripStartSeconds = (tripStartMs - winStart) / 1000;
      const tripEndSeconds = (tripEndMs - winStart) / 1000;
      const tripDurationSeconds = tripEndSeconds - tripStartSeconds;

      // Generate timestamps with easing
      const timestamps = cumulativeDistances.map((dist) => {
        const timeFraction = getTimeFraction(dist, totalDistance);
        return tripStartSeconds + timeFraction * tripDurationSeconds;
      });

      // Precompute phase boundaries
      const visibleStartSeconds = tripStartSeconds - fadeDur;
      const fadeInEndSeconds = visibleStartSeconds + fadeDur;

      // Precompute fade-in bearing using 20m look-ahead
      const lookAheadDistPrep = Math.min(20, totalDistance);
      let laIdxPrep = 0;
      while (
        laIdxPrep < cumulativeDistances.length - 1 &&
        cumulativeDistances[laIdxPrep + 1] < lookAheadDistPrep
      ) {
        laIdxPrep++;
      }
      const laD0Prep = cumulativeDistances[laIdxPrep];
      const laD1Prep = cumulativeDistances[laIdxPrep + 1] ?? laD0Prep;
      const laFracPrep =
        laD1Prep > laD0Prep
          ? (lookAheadDistPrep - laD0Prep) / (laD1Prep - laD0Prep)
          : 0;
      const laP0Prep = coordinates[laIdxPrep];
      const laP1Prep = coordinates[laIdxPrep + 1] ?? laP0Prep;
      const lookAheadXPrep =
        laP0Prep[0] + laFracPrep * (laP1Prep[0] - laP0Prep[0]);
      const lookAheadYPrep =
        laP0Prep[1] + laFracPrep * (laP1Prep[1] - laP0Prep[1]);
      const firstSegmentBearing =
        Math.atan2(
          lookAheadXPrep - coordinates[0][0],
          lookAheadYPrep - coordinates[0][1]
        ) *
        (180 / Math.PI);

      // Precompute last segment bearing
      const lastIdx = coordinates.length - 1;
      const fdxN = coordinates[lastIdx][0] - coordinates[lastIdx - 1][0];
      const fdyN = coordinates[lastIdx][1] - coordinates[lastIdx - 1][1];
      const lastSegmentBearing = Math.atan2(fdxN, fdyN) * (180 / Math.PI);

      return {
        id: trip.id,
        path: coordinates,
        timestamps,
        bikeType: trip.rideableType,
        startTimeSeconds: tripStartSeconds,
        endTimeSeconds: tripEndSeconds,
        visibleStartSeconds,
        visibleEndSeconds:
          tripEndSeconds + Math.max(fadeDur, TRAIL_LENGTH_SECONDS),
        cumulativeDistances,
        lastSegmentIndex: 0,
        fadeInEndSeconds,
        firstSegmentBearing,
        lastSegmentBearing,
        // Mutable state - initialized here, updated by main thread
        currentPosition: [0, 0] as [number, number],
        currentBearing: 0,
        currentPhase: "fading-in" as Phase,
        currentPhaseProgress: 0,
        isVisible: false,
        isSelected: false,
      };
    })
    .filter((trip): trip is DeckTrip => trip !== null);

  return prepared;
}

// === Message Handlers ===

function handleInit(msg: InitMessage): void {
  windowStartMs = msg.windowStartMs;
  fadeDurationSimSeconds = msg.fadeDurationSimSeconds;
  initialized = true;
  post({ type: "ready" });
}

function handleLoadBatch(msg: LoadBatchMessage): void {
  if (!initialized) {
    post({
      type: "error",
      message: "Worker not initialized",
      context: "handleLoadBatch",
    });
    return;
  }

  const { batchId, trips } = msg;

  // Process all trips (heavy CPU work)
  const processed = prepareTripsForDeck({
    trips,
    windowStartMs,
    fadeDurationSimSeconds,
  });

  // Partition into 60-second chunks by visibleStartSeconds (not startTimeSeconds)
  // This ensures trips are delivered in time for their fade-in animation
  for (const trip of processed) {
    const chunkIndex = Math.max(0, Math.floor(trip.visibleStartSeconds / CHUNK_SIZE_SECONDS));

    if (!chunkMap.has(chunkIndex)) {
      chunkMap.set(chunkIndex, []);
    }
    chunkMap.get(chunkIndex)!.push(trip);
  }

  processedBatches.add(batchId);

  post({
    type: "batch-processed",
    batchId,
    tripCount: processed.length,
  });
}

function handleRequestChunk(msg: RequestChunkMessage): void {
  const { chunkIndex } = msg;
  const trips = chunkMap.get(chunkIndex) ?? [];

  post({
    type: "chunk-response",
    chunkIndex,
    trips,
  });
}

function handleUpdateConfig(msg: UpdateConfigMessage): void {
  if (msg.windowStartMs !== undefined) {
    windowStartMs = msg.windowStartMs;
  }
  if (msg.fadeDurationSimSeconds !== undefined) {
    fadeDurationSimSeconds = msg.fadeDurationSimSeconds;
  }
}

function handleClearBatch(msg: ClearBatchMessage): void {
  const { batchId } = msg;
  const BATCH_SIZE_SECONDS = 60 * 60; // 1 hour
  const CHUNKS_PER_BATCH = BATCH_SIZE_SECONDS / CHUNK_SIZE_SECONDS;

  const startChunk = batchId * CHUNKS_PER_BATCH;
  const endChunk = startChunk + CHUNKS_PER_BATCH;

  for (let i = startChunk; i < endChunk; i++) {
    chunkMap.delete(i);
  }
  processedBatches.delete(batchId);
}

// === Main Message Handler ===
self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "init":
      handleInit(message);
      break;
    case "load-batch":
      handleLoadBatch(message);
      break;
    case "request-chunk":
      handleRequestChunk(message);
      break;
    case "update-config":
      handleUpdateConfig(message);
      break;
    case "clear-batch":
      handleClearBatch(message);
      break;
  }
};

// Signal that worker script has loaded
console.log("Trip processor worker loaded");
