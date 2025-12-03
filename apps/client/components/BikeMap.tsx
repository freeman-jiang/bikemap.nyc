"use client";

import { getRidesStartingIn, getTripsForChunk } from "@/app/server/trips";
import { TripsLayer } from "@deck.gl/geo-layers";
import { IconLayer } from "@deck.gl/layers";
import { DeckGL } from "@deck.gl/react";
import polyline from "@mapbox/polyline";
import distance from "@turf/distance";
import { point } from "@turf/helpers";
import "mapbox-gl/dist/mapbox-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MapboxMap } from "react-map-gl/mapbox";

import type { Color, MapViewState } from "@deck.gl/core";

// Infer types from server function
type ChunkResponse = Awaited<ReturnType<typeof getTripsForChunk>>;
type Trip = ChunkResponse["trips"][number];

type AnimationState = "idle" | "playing" | "finished";

// DeckGL TripsLayer data format
type DeckTrip = {
  id: string;
  path: [number, number][];
  timestamps: number[]; // seconds from window start
  vendor: number; // 0 = classic, 1 = electric
  endTimeSeconds: number; // when trip ends (seconds from window start)
  cumulativeDistances: number[]; // meters from route start
};

// Animation config - all times in seconds
const SPEEDUP = 100;
const TRAIL_LENGTH_SECONDS = 60; // 1 minute of trail

// Chunking config
const CHUNK_SIZE_SECONDS = 15 * 60; // 15 minutes in seconds
const LOOKAHEAD_CHUNKS = 1;

// Animation start time
const WINDOW_START = new Date("2025-06-08T17:00:00.000Z"); // 1pm EDT

// Theme colors
const THEME = {
  trailColor0: [160, 160, 160] as Color, // gray - classic bikes
  trailColor1: [96, 165, 250] as Color, // blue - electric bikes
};

// Arrow icon for bike heads
const ARROW_SVG = `data:image/svg+xml;base64,${btoa(`
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<g transform="rotate(45 12 12)">
    <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>
</g>
</svg>
`)}`;

const INITIAL_VIEW_STATE: MapViewState = {
  longitude: -74.0,
  latitude: 40.7,
  zoom: 13,
  pitch: 45,
  bearing: 0,
};

// Format milliseconds timestamp to date + 12-hour time string (NYC timezone)
const formatTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });

// Prepare trips for deck.gl TripsLayer format with timestamps in seconds from window start
function prepareTripsForDeck(data: {
  trips: Trip[];
  windowStartMs: number;
}): DeckTrip[] {
  const { trips, windowStartMs } = data;

  const prepared = trips
    .filter(
      (trip): trip is Trip & { routeGeometry: string } =>
        trip.routeGeometry !== null &&
        trip.startStationId !== trip.endStationId
    )
    .map((trip) => {
      // Decode polyline6 - returns [lat, lng][], flip to [lng, lat]
      const decoded = polyline.decode(trip.routeGeometry, 6);
      const coordinates = decoded.map(
        ([lat, lng]) => [lng, lat] as [number, number]
      );

      if (coordinates.length < 2) return null;

      // Calculate cumulative distances for timestamp distribution
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

      // Calculate implied speed and filter unrealistic trips
      const tripStartMs = new Date(trip.startedAt).getTime();
      const tripEndMs = new Date(trip.endedAt).getTime();
      const tripDurationHours = (tripEndMs - tripStartMs) / (1000 * 60 * 60);
      const speedKmh = totalDistance / 1000 / tripDurationHours;

      // Skip trips faster than 20 km/h or slower than 2 km/h
      if (speedKmh > 20 || speedKmh < 2) return null;

      // Convert to seconds from window start
      const tripStartSeconds = (tripStartMs - windowStartMs) / 1000;
      const tripEndSeconds = (tripEndMs - windowStartMs) / 1000;
      const tripDurationSeconds = tripEndSeconds - tripStartSeconds;

      // Generate timestamps for each coordinate based on distance fraction
      const timestamps = cumulativeDistances.map((dist) => {
        const fraction = totalDistance > 0 ? dist / totalDistance : 0;
        return tripStartSeconds + fraction * tripDurationSeconds;
      });

      return {
        id: trip.id,
        path: coordinates,
        timestamps,
        vendor: trip.rideableType === "electric_bike" ? 1 : 0,
        endTimeSeconds: tripEndSeconds,
        cumulativeDistances,
      };
    })
    .filter((trip): trip is DeckTrip => trip !== null);

  return prepared;
}

// Get interpolated position and bearing for a trip at a given time
function getBikeState(
  trip: DeckTrip,
  currentTime: number
): { position: [number, number]; bearing: number } | null {
  const { timestamps, path } = trip;

  // Not started yet or already ended
  if (currentTime < timestamps[0] || currentTime > timestamps[timestamps.length - 1]) {
    return null;
  }

  // Binary search to find segment
  let lo = 0;
  let hi = timestamps.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (timestamps[mid] < currentTime) lo = mid + 1;
    else hi = mid;
  }

  const idx = Math.max(0, lo - 1);
  if (idx >= path.length - 1) {
    return { position: path[path.length - 1], bearing: 0 };
  }

  // Interpolate between points
  const t0 = timestamps[idx];
  const t1 = timestamps[idx + 1];
  const t = t1 > t0 ? (currentTime - t0) / (t1 - t0) : 0;

  const p0 = path[idx];
  const p1 = path[idx + 1];
  const position: [number, number] = [
    p0[0] + t * (p1[0] - p0[0]),
    p0[1] + t * (p1[1] - p0[1]),
  ];

  // Look ahead ~50m (or to end of route if less than 50m remaining)
  const cumDist = trip.cumulativeDistances;
  const currentDist = cumDist[idx] + t * (cumDist[idx + 1] - cumDist[idx]);
  const totalDist = cumDist[cumDist.length - 1];
  const lookAheadDist = Math.min(currentDist + 20, totalDist);

  // Find look-ahead position
  let laIdx = idx;
  while (laIdx < cumDist.length - 1 && cumDist[laIdx + 1] < lookAheadDist) {
    laIdx++;
  }

  // Interpolate look-ahead point
  const laD0 = cumDist[laIdx];
  const laD1 = cumDist[laIdx + 1] ?? laD0;
  const laFrac = laD1 > laD0 ? (lookAheadDist - laD0) / (laD1 - laD0) : 0;
  const laP0 = path[laIdx];
  const laP1 = path[laIdx + 1] ?? laP0;
  const lookAheadPos: [number, number] = [
    laP0[0] + laFrac * (laP1[0] - laP0[0]),
    laP0[1] + laFrac * (laP1[1] - laP0[1]),
  ];

  // Calculate bearing from current position to look-ahead point
  const dx = lookAheadPos[0] - position[0];
  const dy = lookAheadPos[1] - position[1];
  const bearing = Math.atan2(dx, dy) * (180 / Math.PI);

  return { position, bearing };
}

export const BikeMap = () => {
  const windowStartMs = WINDOW_START.getTime();

  const [activeTrips, setActiveTrips] = useState<DeckTrip[]>([]);
  const [tripCount, setTripCount] = useState(0);
  const [time, setTime] = useState(0); // seconds from window start
  const [animState, setAnimState] = useState<AnimationState>("idle");

  const rafRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const tripMapRef = useRef<Map<string, DeckTrip>>(new Map());
  const loadingChunksRef = useRef<Set<number>>(new Set());
  const loadedChunksRef = useRef<Set<number>>(new Set());
  const lastChunkRef = useRef(-1);

  // Convert seconds to real time (ms) for clock display
  const secondsToRealTime = useCallback(
    (seconds: number) => windowStartMs + seconds * 1000,
    [windowStartMs]
  );

  // Get chunk index from simulation time (seconds)
  const getChunkIndex = useCallback(
    (timeSeconds: number) => Math.floor(timeSeconds / CHUNK_SIZE_SECONDS),
    []
  );

  // Load rides starting in a specific chunk
  const loadUpcomingRides = useCallback(
    async (chunkIndex: number) => {
      if (loadedChunksRef.current.has(chunkIndex) || loadingChunksRef.current.has(chunkIndex)) {
        return;
      }

      if (chunkIndex < 0) {
        return;
      }

      loadingChunksRef.current.add(chunkIndex);
      console.log(`Loading rides starting in chunk ${chunkIndex}...`);

      const from = new Date(windowStartMs + chunkIndex * CHUNK_SIZE_SECONDS * 1000);
      const to = new Date(windowStartMs + (chunkIndex + 1) * CHUNK_SIZE_SECONDS * 1000);

      try {
        const data = await getRidesStartingIn({ from, to });
        const prepared = prepareTripsForDeck({
          trips: data.trips,
          windowStartMs,
        });

        console.log(`Chunk ${chunkIndex}: ${prepared.length} new rides`);

        // Add to ref (dedupes by ID)
        for (const trip of prepared) {
          tripMapRef.current.set(trip.id, trip);
        }

        loadedChunksRef.current.add(chunkIndex);
      } finally {
        loadingChunksRef.current.delete(chunkIndex);
      }
    },
    [windowStartMs]
  );

  // Initial load: rides active at t=0 plus rides starting in first chunk
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const loadInitial = async () => {
      console.log("Loading initial rides...");
      // Get rides that overlap with t=0 (already in progress)
      const data = await getTripsForChunk({
        chunkStart: WINDOW_START,
        chunkEnd: new Date(windowStartMs + CHUNK_SIZE_SECONDS * 1000),
      });
      const prepared = prepareTripsForDeck({
        trips: data.trips,
        windowStartMs,
      });
      console.log(`Initial load: ${prepared.length} rides`);

      for (const trip of prepared) {
        tripMapRef.current.set(trip.id, trip);
      }
      loadedChunksRef.current.add(0);

      // Also load chunk 1 for lookahead
      await loadUpcomingRides(1);

      // Update state for initial render
      setActiveTrips(Array.from(tripMapRef.current.values()));
      setTripCount(tripMapRef.current.size);
    };

    loadInitial();
  }, [windowStartMs, loadUpcomingRides]);

  // Calculate current real time for clock display
  const currentRealTime = secondsToRealTime(time);
  const currentChunk = getChunkIndex(time);

  // On chunk change: prefetch upcoming, remove ended trips, sync state
  useEffect(() => {
    if (animState !== "playing") return;
    if (currentChunk === lastChunkRef.current) return;

    console.log(`Entered chunk ${currentChunk}`);
    lastChunkRef.current = currentChunk;

    // Prefetch next chunk
    const nextChunk = currentChunk + LOOKAHEAD_CHUNKS + 1;
    loadUpcomingRides(nextChunk);

    // Remove trips that have ended
    for (const [id, trip] of tripMapRef.current) {
      if (trip.endTimeSeconds < time) {
        tripMapRef.current.delete(id);
      }
    }

    // Sync state for rendering
    const currentTrips = Array.from(tripMapRef.current.values());
    setActiveTrips(currentTrips);
    setTripCount(currentTrips.length);
  }, [currentChunk, time, animState, loadUpcomingRides]);

  const play = useCallback(() => {
    setAnimState("playing");
    setTime(0);
    lastChunkRef.current = 0;
    lastTimestampRef.current = null;

    const tick = (timestamp: number) => {
      if (lastTimestampRef.current !== null) {
        const deltaMs = timestamp - lastTimestampRef.current;
        const deltaSeconds = deltaMs / 1000;
        setTime((t) => t + deltaSeconds * SPEEDUP);
      }
      lastTimestampRef.current = timestamp;
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const replay = useCallback(() => {
    // Stop current animation
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    lastTimestampRef.current = null;

    // Reset state
    tripMapRef.current.clear();
    loadingChunksRef.current.clear();
    loadedChunksRef.current.clear();
    initialLoadDone.current = false;
    lastChunkRef.current = -1;
    setActiveTrips([]);
    setTripCount(0);

    // Reload initial data
    const loadInitial = async () => {
      const data = await getTripsForChunk({
        chunkStart: WINDOW_START,
        chunkEnd: new Date(windowStartMs + CHUNK_SIZE_SECONDS * 1000),
      });
      const prepared = prepareTripsForDeck({
        trips: data.trips,
        windowStartMs,
      });

      for (const trip of prepared) {
        tripMapRef.current.set(trip.id, trip);
      }
      loadedChunksRef.current.add(0);

      await loadUpcomingRides(1);

      setActiveTrips(Array.from(tripMapRef.current.values()));
      setTripCount(tripMapRef.current.size);

      // Start animation
      play();
    };

    loadInitial();
  }, [windowStartMs, loadUpcomingRides, play]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
    throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN is not set");
  }

  // Calculate current bike head positions and bearings
  const bikeHeads = useMemo(() => {
    const heads: { position: [number, number]; bearing: number; id: string; vendor: number }[] = [];
    for (const trip of activeTrips) {
      const state = getBikeState(trip, time);
      if (state) {
        heads.push({ ...state, id: trip.id, vendor: trip.vendor });
      }
    }
    return heads;
  }, [activeTrips, time]);

  const layers = [
    new TripsLayer<DeckTrip>({
      id: "trips",
      data: activeTrips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: (d) => (d.vendor === 0 ? THEME.trailColor0 : THEME.trailColor1),
      opacity: 0.3,
      widthMinPixels: 2,
      rounded: true,
      trailLength: TRAIL_LENGTH_SECONDS,
      currentTime: time,
    }),
    new IconLayer({
      id: "bike-heads",
      data: bikeHeads,
      getPosition: (d) => d.position,
      getAngle: (d) => -d.bearing,
      getIcon: () => "arrow",
      getSize: 8,
      getColor: (d) => (d.vendor === 0 ? THEME.trailColor0 : THEME.trailColor1),
      iconAtlas: ARROW_SVG,
      iconMapping: {
        arrow: { x: 0, y: 0, width: 24, height: 24, anchorX: 12, anchorY: 12, mask: true },
      },
      updateTriggers: {
        getPosition: [bikeHeads],
        getAngle: [bikeHeads],
      },
    }),
  ];

  return (
    <div className="relative w-full h-full">
      <DeckGL
        layers={layers}
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
      >
        <MapboxMap
          mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
          mapStyle="mapbox://styles/mapbox/dark-v11"
          reuseMaps
        />
      </DeckGL>

      {/* Clock display - top center */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
        <div className="bg-white/10 backdrop-blur-xl text-white text-sm font-medium px-3 py-1.5 rounded-lg">
          {formatTime(currentRealTime)}
        </div>
      </div>

      {/* Stats - top right */}
      <div className="absolute top-4 right-4 z-10">
        <div className="bg-white/10 backdrop-blur-xl text-white text-xs px-3 py-2 rounded-lg">
          <div className="font-medium mb-1">Active Trips</div>
          <div className="text-lg font-bold">{tripCount.toLocaleString()}</div>
        </div>
      </div>

      {/* Play/Replay controls - top left */}
      <div className="absolute top-4 left-4 z-10">
        {animState === "idle" && (
          <button
            onClick={play}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg shadow-lg transition-colors"
          >
            Play
          </button>
        )}
        {animState === "playing" && (
          <div className="bg-gray-800 text-white font-medium px-4 py-2 rounded-lg shadow-lg">
            Playing...
          </div>
        )}
        {animState === "finished" && (
          <button
            onClick={replay}
            className="bg-green-600 hover:bg-green-700 text-white font-medium px-4 py-2 rounded-lg shadow-lg transition-colors"
          >
            Replay
          </button>
        )}
      </div>
    </div>
  );
};
