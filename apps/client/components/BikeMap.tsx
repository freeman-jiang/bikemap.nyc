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
  bikeType: string;
  startTimeSeconds: number; // actual trip start (movement begins after transition)
  endTimeSeconds: number; // actual trip end (movement stops, fade-out begins)
  visibleStartSeconds: number; // when bike first appears (fade-in starts)
  visibleEndSeconds: number; // when bike disappears (fade-out ends)
  cumulativeDistances: number[]; // meters from route start
};

// Animation config - all times in seconds
const SPEEDUP = 100;
const TRAIL_LENGTH_SECONDS = 45;
const EASE_DISTANCE_METERS = 300; // Fixed easing distance at start/end of trips

// Fade/transition duration in real milliseconds (matches original)
const FADE_DURATION_MS = 700;
const TRANSITION_DURATION_MS = 700;

// Convert to simulation seconds: realMs / 1000 * SPEEDUP
const FADE_DURATION_SIM_SECONDS = (FADE_DURATION_MS / 1000) * SPEEDUP;
const TRANSITION_DURATION_SIM_SECONDS = (TRANSITION_DURATION_MS / 1000) * SPEEDUP;

// Chunking config
const CHUNK_SIZE_SECONDS = 15 * 60; // 15 minutes in seconds
const LOOKAHEAD_CHUNKS = 1;

// Animation start time
const WINDOW_START = new Date("2025-06-08T17:00:00.000Z"); // 4am EDT (8am UTC)

const THEME = {
  trailColor0: [187, 154, 247] as Color, // purple
  trailColor1: [125, 207, 255] as Color, // sky blue
  fadeInColor: [115, 255, 140] as Color, // vibrant mint green
  fadeOutColor: [247, 118, 142] as Color, // pink
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

// Interpolate between two angles, handling 360°/0° wrapping
function interpolateAngle(from: number, to: number, factor: number): number {
  from = ((from % 360) + 360) % 360;
  to = ((to % 360) + 360) % 360;
  let diff = to - from;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return ((from + diff * factor) % 360 + 360) % 360;
}

// Compute time fraction from distance, with fixed-distance easing at edges
// Makes bikes slow at start/end (docking) and constant speed in middle
function getTimeFraction(dist: number, totalDist: number): number {
  if (totalDist <= 0) return 0;

  // Scale down ease distance for short trips (max 25% of trip at each end)
  const easeDist = Math.min(EASE_DISTANCE_METERS, totalDist / 4);

  const easeInEnd = easeDist;
  const easeOutStart = totalDist - easeDist;
  const linearDist = totalDist - 2 * easeDist;

  // Time allocation: easing phases take 2x the time per meter
  const totalTime = 2 * easeDist + linearDist + 2 * easeDist;
  const easeInTime = 2 * easeDist;
  const linearTime = linearDist;

  if (dist < easeInEnd) {
    // INVERSE quadratic ease-in: time = sqrt(position) for slow start
    const t = dist / easeDist;
    const timeInEase = Math.sqrt(t);
    return (timeInEase * easeInTime) / totalTime;
  } else if (dist > easeOutStart) {
    // INVERSE quadratic ease-out: slow end
    const distIntoEaseOut = dist - easeOutStart;
    // Clamp t to prevent NaN from floating point errors at boundary
    const t = Math.min(1, distIntoEaseOut / easeDist);
    const timeInEase = 1 - Math.sqrt(1 - t);
    const timeBeforeEaseOut = easeInTime + linearTime;
    return (timeBeforeEaseOut + timeInEase * easeInTime) / totalTime;
  } else {
    // Linear middle
    const distIntoLinear = dist - easeInEnd;
    return (easeInTime + distIntoLinear) / totalTime;
  }
}

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
      if (speedKmh > 18 || speedKmh < 2) return null;

      // Convert to seconds from window start
      const tripStartSeconds = (tripStartMs - windowStartMs) / 1000;
      const tripEndSeconds = (tripEndMs - windowStartMs) / 1000;
      const tripDurationSeconds = tripEndSeconds - tripStartSeconds;

      // Generate timestamps with easing: slow at start/end (100m), fast in middle
      const timestamps = cumulativeDistances.map((dist) => {
        const timeFraction = getTimeFraction(dist, totalDistance);
        return tripStartSeconds + timeFraction * tripDurationSeconds;
      });

      return {
        id: trip.id,
        path: coordinates,
        timestamps,
        bikeType: trip.rideableType,
        startTimeSeconds: tripStartSeconds,
        endTimeSeconds: tripEndSeconds,
        visibleStartSeconds: tripStartSeconds - FADE_DURATION_SIM_SECONDS - TRANSITION_DURATION_SIM_SECONDS,
        visibleEndSeconds: tripEndSeconds + Math.max(FADE_DURATION_SIM_SECONDS, TRAIL_LENGTH_SECONDS),
        cumulativeDistances,
      };
    })
    .filter((trip): trip is DeckTrip => trip !== null);

  return prepared;
}

// Get interpolated position, bearing, and phase for a trip at a given time
function getBikeState(
  trip: DeckTrip,
  currentTime: number
): { position: [number, number]; bearing: number; phase: string; phaseProgress: number } | null {
  const {
    timestamps,
    path,
    startTimeSeconds,
    endTimeSeconds,
    visibleStartSeconds,
    visibleEndSeconds,
    cumulativeDistances,
  } = trip;

  // Not visible yet or already gone
  if (currentTime < visibleStartSeconds || currentTime > visibleEndSeconds) {
    return null;
  }

  // Calculate phase boundaries (matching original timing exactly)
  const fadeInEnd = visibleStartSeconds + FADE_DURATION_SIM_SECONDS;
  const transitionInEnd = fadeInEnd + TRANSITION_DURATION_SIM_SECONDS; // = startTimeSeconds
  const fadeOutStart = endTimeSeconds; // movement stops at actual trip end

  // Determine phase and progress
  let phase: string;
  let phaseProgress: number;

  if (currentTime < fadeInEnd) {
    phase = "fading-in";
    phaseProgress = (currentTime - visibleStartSeconds) / FADE_DURATION_SIM_SECONDS;
  } else if (currentTime < transitionInEnd) {
    phase = "transitioning-in";
    phaseProgress = (currentTime - fadeInEnd) / TRANSITION_DURATION_SIM_SECONDS;
  } else if (currentTime >= fadeOutStart) {
    phase = "fading-out";
    phaseProgress = (currentTime - fadeOutStart) / FADE_DURATION_SIM_SECONDS;
  } else {
    phase = "moving";
    phaseProgress = 1;
  }

  // Calculate position based on phase
  let position: [number, number];
  let idx = 0;
  let t = 0;

  if (phase === "fading-in") {
    // Stationary at start position
    position = path[0];
  } else if (phase === "fading-out") {
    // Stationary at end position
    position = path[path.length - 1];
    idx = path.length - 2;
    t = 1;
  } else {
    // transitioning-in or moving: interpolate along route
    // Movement starts at transitionInEnd (= startTimeSeconds) and ends at fadeOutStart (= endTimeSeconds)
    const movingStart = transitionInEnd;
    const movingEnd = fadeOutStart;
    const movingDuration = movingEnd - movingStart;
    // Guard against division by zero for very short trips
    const movingProgress = movingDuration > 0
      ? Math.max(0, Math.min(1, (currentTime - movingStart) / movingDuration))
      : 1;

    // Map to timestamp along route
    const tripTime = timestamps[0] + movingProgress * (timestamps[timestamps.length - 1] - timestamps[0]);

    // Binary search to find segment
    let lo = 0;
    let hi = timestamps.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (timestamps[mid] < tripTime) lo = mid + 1;
      else hi = mid;
    }

    idx = Math.max(0, lo - 1);
    if (idx >= path.length - 1) {
      position = path[path.length - 1];
    } else {
      const t0 = timestamps[idx];
      const t1 = timestamps[idx + 1];
      t = t1 > t0 ? (tripTime - t0) / (t1 - t0) : 0;

      const p0 = path[idx];
      const p1 = path[idx + 1];
      position = [
        p0[0] + t * (p1[0] - p0[0]),
        p0[1] + t * (p1[1] - p0[1]),
      ];
    }
  }

  // Calculate bearing using look-ahead point (~20m ahead)
  const cumDist = cumulativeDistances;
  const currentDist = phase === "fading-in"
    ? 0
    : phase === "fading-out"
      ? cumDist[cumDist.length - 1]
      : cumDist[idx] + t * ((cumDist[idx + 1] ?? cumDist[idx]) - cumDist[idx]);
  const totalDist = cumDist[cumDist.length - 1];
  const lookAheadDist = Math.min(currentDist + 20, totalDist);

  // Find look-ahead position
  let laIdx = 0;
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
  const targetBearing = Math.atan2(dx, dy) * (180 / Math.PI);

  // During fade-in, rotate from 0° (north) to target bearing
  const bearing = phase === "fading-in"
    ? interpolateAngle(0, targetBearing, phaseProgress)
    : targetBearing;

  return { position, bearing, phase, phaseProgress };
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

    // Remove trips that have fully finished (including fade-out)
    for (const [id, trip] of tripMapRef.current) {
      if (trip.visibleEndSeconds < time) {
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

  // Calculate current bike head positions, bearings, and phases
  const bikeHeads = useMemo(() => {
    const heads: {
      position: [number, number];
      bearing: number;
      id: string;
      bikeType: string;
      phase: string;
      phaseProgress: number;
    }[] = [];
    for (const trip of activeTrips) {
      const state = getBikeState(trip, time);
      if (state) {
        heads.push({ ...state, id: trip.id, bikeType: trip.bikeType });
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
      getColor: (d) => (d.bikeType === "electric_bike" ? THEME.trailColor1 : THEME.trailColor0),
      opacity: 0.3,
      widthMinPixels: 3,
      rounded: true,
      trailLength: TRAIL_LENGTH_SECONDS,
      currentTime: time,
    }),
    new IconLayer({
      id: "bike-heads",
      data: bikeHeads,
      billboard: false,
      opacity: 0.8,
      getPosition: (d) => d.position,
      getAngle: (d) => -d.bearing,
      getIcon: () => "arrow",
      getSize: 9,
      getColor: (d) => {
        const bikeColor = d.bikeType === "electric_bike" ? THEME.trailColor1 : THEME.trailColor0;
        const maxAlpha = 0.8 * 255;

        if (d.phase === "fading-in") {
          // Green, fading in
          const alpha = d.phaseProgress * maxAlpha;
          return [THEME.fadeInColor[0], THEME.fadeInColor[1], THEME.fadeInColor[2], alpha];
        }
        if (d.phase === "transitioning-in") {
          // Interpolate green → bike color
          return [
            THEME.fadeInColor[0] + (bikeColor[0] - THEME.fadeInColor[0]) * d.phaseProgress,
            THEME.fadeInColor[1] + (bikeColor[1] - THEME.fadeInColor[1]) * d.phaseProgress,
            THEME.fadeInColor[2] + (bikeColor[2] - THEME.fadeInColor[2]) * d.phaseProgress,
            maxAlpha,
          ];
        }
        if (d.phase === "fading-out") {
          // Red, fading out
          const alpha = (1 - d.phaseProgress) * maxAlpha;
          return [THEME.fadeOutColor[0], THEME.fadeOutColor[1], THEME.fadeOutColor[2], alpha];
        }
        // moving - bike color at full opacity
        return [bikeColor[0], bikeColor[1], bikeColor[2], maxAlpha];
      },
      iconAtlas: ARROW_SVG,
      iconMapping: {
        arrow: { x: 0, y: 0, width: 24, height: 24, anchorX: 12, anchorY: 12, mask: true },
      },
      updateTriggers: {
        getPosition: [bikeHeads],
        getAngle: [bikeHeads],
        getColor: [bikeHeads],
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
