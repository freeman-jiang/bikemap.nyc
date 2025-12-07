"use client";

import { getRidesStartingIn as getRidesInWindow, getTripsForChunk } from "@/app/server/trips";
import { DataFilterExtension } from "@deck.gl/extensions";
import { TripsLayer } from "@deck.gl/geo-layers";
import { IconLayer, PathLayer } from "@deck.gl/layers";
import { DeckGL } from "@deck.gl/react";
import polyline from "@mapbox/polyline";
import distance from "@turf/distance";
import { point } from "@turf/helpers";
import "mapbox-gl/dist/mapbox-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MapboxMap } from "react-map-gl/mapbox";
import { usePickerStore } from "@/lib/store";

import type { Color, MapViewState } from "@deck.gl/core";
import { LinearInterpolator } from "@deck.gl/core";

// Infer types from server function
type ChunkResponse = Awaited<ReturnType<typeof getTripsForChunk>>;
type Trip = ChunkResponse["trips"][number];

type AnimationState = "idle" | "playing" | "finished";
type Phase = "fading-in" | "transitioning-in" | "moving" | "fading-out";

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
  lastSegmentIndex: number; // cached cursor for O(1) segment lookup
  // Precomputed phase boundaries (avoid recalculating each frame)
  fadeInEndSeconds: number;
  transitionInEndSeconds: number;
  // Precomputed bearings for stationary phases
  firstSegmentBearing: number;
  lastSegmentBearing: number;
  // Mutable state (updated in place each frame to avoid allocations)
  currentPosition: [number, number];
  currentBearing: number;
  currentPhase: Phase;
  currentPhaseProgress: number;
  isVisible: boolean;
  isSelected: boolean;
};

// Animation config - all times in seconds
const SPEEDUP = 150;
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
const WINDOW_START = new Date("2025-06-04T22:00:00.000Z"); // 6:00pm EDT (22:00 UTC)

const THEME = {
  trailColor0: [187, 154, 247] as Color, // purple
  trailColor1: [125, 207, 255] as Color, // sky blue
  fadeInColor: [115, 255, 140] as Color, // vibrant mint green
  fadeOutColor: [247, 118, 142] as Color, // pink
  selectedColor: [255, 165, 0] as Color, // orange
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

// Layer accessor functions (extracted to avoid recreation on each render)
const getPath = (d: DeckTrip) => d.path;
const getTimestamps = (d: DeckTrip) => d.timestamps;
const getTripColor = (d: DeckTrip) =>
  d.isSelected
    ? THEME.selectedColor
    : d.bikeType === "electric_bike"
      ? THEME.trailColor1
      : THEME.trailColor0;

// =============================================================================
// Color utilities (gl-matrix style)
// =============================================================================
// These utilities mutate arrays in-place to avoid allocations in hot loops.
// This is safe because deck.gl's accessors (like `getColor`) are called
// synchronously — deck.gl copies the RGBA values immediately before calling
// the accessor again for the next item. By the time we mutate the array for
// item N+1, deck.gl has already copied item N's values into its internal buffer.
//
// WARNING: Do NOT store references returned by getBikeHeadColor() for later use.
// The underlying array will be mutated on the next call.
// =============================================================================
type Color4 = [number, number, number, number];
type RGB = readonly [number, number, number];

const color4 = {
  /** Copy RGB values and set alpha, writes to `out` */
  set(out: Color4, rgb: RGB, alpha: number): Color4 {
    out[0] = rgb[0];
    out[1] = rgb[1];
    out[2] = rgb[2];
    out[3] = alpha;
    return out;
  },
  /** Linear interpolate between RGB colors a and b, set alpha, writes to `out` */
  lerp(out: Color4, a: RGB, b: RGB, t: number, alpha: number): Color4 {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    out[3] = alpha;
    return out;
  },
};

// Source colors (immutable)
const COLORS = {
  fadeIn: [115, 255, 140] as const,
  fadeOut: [247, 118, 142] as const,
  electric: [125, 207, 255] as const,
  classic: [187, 154, 247] as const,
  selected: [255, 165, 0] as const,
} as const

// Single output buffer (mutated and reused each call)
const colorScratch: Color4 = [0, 0, 0, 0];
const MAX_ALPHA = 0.8 * 255;

// IconLayer accessors - now use DeckTrip directly (no intermediate BikeHead objects)
const getBikeHeadPosition = (d: DeckTrip, { target }: { target: number[] }): [number, number, number] => {
  target[0] = d.currentPosition[0];
  target[1] = d.currentPosition[1];
  target[2] = 0;
  return target as [number, number, number];
};
const getBikeHeadAngle = (d: DeckTrip) => -d.currentBearing;
const getBikeHeadIcon = () => "arrow";
const getBikeHeadSize = () => 9;
const getBikeHeadColor = (d: DeckTrip): Color4 => {
  // Selected trips are always orange (still respect alpha for fading)
  if (d.isSelected) {
    const alpha =
      d.currentPhase === "fading-in"
        ? d.currentPhaseProgress * MAX_ALPHA
        : d.currentPhase === "fading-out"
          ? (1 - d.currentPhaseProgress) * MAX_ALPHA
          : MAX_ALPHA;
    return color4.set(colorScratch, COLORS.selected, alpha);
  }

  const bikeColor = d.bikeType === "electric_bike" ? COLORS.electric : COLORS.classic;

  switch (d.currentPhase) {
    case "fading-in":
      return color4.set(colorScratch, COLORS.fadeIn, d.currentPhaseProgress * MAX_ALPHA);
    case "transitioning-in":
      return color4.lerp(colorScratch, COLORS.fadeIn, bikeColor, d.currentPhaseProgress, MAX_ALPHA);
    case "fading-out":
      return color4.set(colorScratch, COLORS.fadeOut, (1 - d.currentPhaseProgress) * MAX_ALPHA);
    default: // moving
      return color4.set(colorScratch, bikeColor, MAX_ALPHA);
  }
};

const ICON_MAPPING = {
  arrow: { x: 0, y: 0, width: 24, height: 24, anchorX: 12, anchorY: 12, mask: true },
};

// DataFilterExtension for GPU-based visibility filtering
// filterSize: 2 means we filter on 2 values [visibleStartSeconds, visibleEndSeconds]
const dataFilter = new DataFilterExtension({ filterSize: 2 });

// Accessor for DataFilterExtension - returns [visibleStartSeconds, visibleEndSeconds]
const getFilterValue = (d: DeckTrip): [number, number] => [d.visibleStartSeconds, d.visibleEndSeconds];

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

      // Precompute phase boundaries
      const visibleStartSeconds = tripStartSeconds - FADE_DURATION_SIM_SECONDS - TRANSITION_DURATION_SIM_SECONDS;
      const fadeInEndSeconds = visibleStartSeconds + FADE_DURATION_SIM_SECONDS;
      const transitionInEndSeconds = fadeInEndSeconds + TRANSITION_DURATION_SIM_SECONDS;

      // Precompute fade-in bearing using 20m look-ahead (matches original behavior)
      const lookAheadDistPrep = Math.min(20, totalDistance);
      let laIdxPrep = 0;
      while (laIdxPrep < cumulativeDistances.length - 1 && cumulativeDistances[laIdxPrep + 1] < lookAheadDistPrep) {
        laIdxPrep++;
      }
      const laD0Prep = cumulativeDistances[laIdxPrep];
      const laD1Prep = cumulativeDistances[laIdxPrep + 1] ?? laD0Prep;
      const laFracPrep = laD1Prep > laD0Prep ? (lookAheadDistPrep - laD0Prep) / (laD1Prep - laD0Prep) : 0;
      const laP0Prep = coordinates[laIdxPrep];
      const laP1Prep = coordinates[laIdxPrep + 1] ?? laP0Prep;
      const lookAheadXPrep = laP0Prep[0] + laFracPrep * (laP1Prep[0] - laP0Prep[0]);
      const lookAheadYPrep = laP0Prep[1] + laFracPrep * (laP1Prep[1] - laP0Prep[1]);
      const firstSegmentBearing = Math.atan2(lookAheadXPrep - coordinates[0][0], lookAheadYPrep - coordinates[0][1]) * (180 / Math.PI);

      // Precompute last segment bearing (for fade-out)
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
        visibleEndSeconds: tripEndSeconds + Math.max(FADE_DURATION_SIM_SECONDS, TRAIL_LENGTH_SECONDS),
        cumulativeDistances,
        lastSegmentIndex: 0,
        fadeInEndSeconds,
        transitionInEndSeconds,
        firstSegmentBearing,
        lastSegmentBearing,
        // Mutable state - initialized once, updated in place each frame
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

// Update trip's mutable state in place. Returns true if visible.
function updateTripState(trip: DeckTrip, currentTime: number): boolean {
  const {
    path,
    visibleStartSeconds,
    visibleEndSeconds,
    fadeInEndSeconds,
    transitionInEndSeconds,
    endTimeSeconds,
    firstSegmentBearing,
    lastSegmentBearing,
  } = trip;

  // Not visible yet or already gone
  if (currentTime < visibleStartSeconds || currentTime > visibleEndSeconds) {
    trip.isVisible = false;
    return false;
  }

  // Determine phase and progress using precomputed boundaries
  let phase: Phase;
  let phaseProgress: number;

  if (currentTime < fadeInEndSeconds) {
    phase = "fading-in";
    phaseProgress = (currentTime - visibleStartSeconds) / FADE_DURATION_SIM_SECONDS;
  } else if (currentTime < transitionInEndSeconds) {
    phase = "transitioning-in";
    phaseProgress = (currentTime - fadeInEndSeconds) / TRANSITION_DURATION_SIM_SECONDS;
  } else if (currentTime >= endTimeSeconds) {
    phase = "fading-out";
    phaseProgress = (currentTime - endTimeSeconds) / FADE_DURATION_SIM_SECONDS;
  } else {
    phase = "moving";
    phaseProgress = 1;
  }

  // Fast path for stationary phases - skip expensive look-ahead calculation
  if (phase === "fading-in") {
    trip.currentPosition[0] = path[0][0];
    trip.currentPosition[1] = path[0][1];
    trip.currentBearing = interpolateAngle(0, firstSegmentBearing, phaseProgress);
    trip.currentPhase = phase;
    trip.currentPhaseProgress = phaseProgress;
    trip.isVisible = true;
    return true;
  }

  if (phase === "fading-out") {
    trip.currentPosition[0] = path[path.length - 1][0];
    trip.currentPosition[1] = path[path.length - 1][1];
    trip.currentBearing = lastSegmentBearing;
    trip.currentPhase = phase;
    trip.currentPhaseProgress = phaseProgress;
    trip.isVisible = true;
    return true;
  }

  // Moving phases: interpolate along route with look-ahead bearing
  const { timestamps, cumulativeDistances } = trip;
  const movingDuration = endTimeSeconds - transitionInEndSeconds;
  const movingProgress = movingDuration > 0
    ? Math.max(0, Math.min(1, (currentTime - transitionInEndSeconds) / movingDuration))
    : 1;

  // Map to timestamp along route
  const tripTime = timestamps[0] + movingProgress * (timestamps[timestamps.length - 1] - timestamps[0]);

  // Use cached index and scan forward (time only increases)
  let idx = trip.lastSegmentIndex;
  while (idx < timestamps.length - 1 && timestamps[idx + 1] < tripTime) {
    idx++;
  }
  trip.lastSegmentIndex = idx;

  let t = 0;
  if (idx >= path.length - 1) {
    trip.currentPosition[0] = path[path.length - 1][0];
    trip.currentPosition[1] = path[path.length - 1][1];
  } else {
    const t0 = timestamps[idx];
    const t1 = timestamps[idx + 1];
    t = t1 > t0 ? (tripTime - t0) / (t1 - t0) : 0;

    const p0 = path[idx];
    const p1 = path[idx + 1];
    trip.currentPosition[0] = p0[0] + t * (p1[0] - p0[0]);
    trip.currentPosition[1] = p0[1] + t * (p1[1] - p0[1]);
  }

  // Calculate bearing using look-ahead point (~20m ahead)
  const cumDist = cumulativeDistances;
  const currentDist = cumDist[idx] + t * ((cumDist[idx + 1] ?? cumDist[idx]) - cumDist[idx]);
  const totalDist = cumDist[cumDist.length - 1];
  const lookAheadDist = Math.min(currentDist + 20, totalDist);

  // Find look-ahead position (start from current idx since look-ahead is only ~20m ahead)
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
  const lookAheadX = laP0[0] + laFrac * (laP1[0] - laP0[0]);
  const lookAheadY = laP0[1] + laFrac * (laP1[1] - laP0[1]);

  // Calculate bearing from current position to look-ahead point
  const dx = lookAheadX - trip.currentPosition[0];
  const dy = lookAheadY - trip.currentPosition[1];
  trip.currentBearing = Math.atan2(dx, dy) * (180 / Math.PI);

  // Update phase state
  trip.currentPhase = phase;
  trip.currentPhaseProgress = phaseProgress;
  trip.isVisible = true;

  return true;
}

export const BikeMap = () => {
  const windowStartMs = WINDOW_START.getTime();

  const [activeTrips, setActiveTrips] = useState<DeckTrip[]>([]);
  const [tripCount, setTripCount] = useState(0);
  const [time, setTime] = useState(0); // seconds from window start
  const [animState, setAnimState] = useState<AnimationState>("idle");
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [initialViewState, setInitialViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);

  const { isPickingLocation, setPickedLocation } = usePickerStore();

  const rafRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const fpsRef = useRef<HTMLDivElement>(null);
  const smoothedFpsRef = useRef(60);
  const lastFpsUpdateRef = useRef(0);
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
        const data = await getRidesInWindow({ from, to });
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
  }, [currentChunk, animState, loadUpcomingRides]);

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
        const currentFps = 1000 / deltaMs;
        smoothedFpsRef.current = smoothedFpsRef.current * 0.9 + currentFps * 0.1;
        if (fpsRef.current && timestamp - lastFpsUpdateRef.current >= 100) {
          fpsRef.current.textContent = `${Math.round(smoothedFpsRef.current)} FPS`;
          lastFpsUpdateRef.current = timestamp;
        }
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

  // Select a random visible biker
  const selectRandomBiker = useCallback(() => {
    const visibleTrips = activeTrips.filter((t) => t.isVisible);
    if (visibleTrips.length === 0) return;
    const randomTrip = visibleTrips[Math.floor(Math.random() * visibleTrips.length)];
    setSelectedTripId(randomTrip.id);
  }, [activeTrips]);

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

  // Update all trip states in place - GPU handles visibility filtering via DataFilterExtension
  useMemo(() => {
    for (const trip of activeTrips) {
      updateTripState(trip, time);
      // Only set isSelected if there's actually a selection (avoid work when no selection)
      if (selectedTripId !== null) {
        trip.isSelected = trip.id === selectedTripId;
      }
    }
  }, [activeTrips, time, selectedTripId]);

  // Camera follow effect - use LinearInterpolator for smooth transitions
  useEffect(() => {
    if (selectedTripId === null) return;
    const trip = activeTrips.find((t) => t.id === selectedTripId);
    if (trip?.isVisible) {
      setInitialViewState((prev) => ({
        ...prev,
        longitude: trip.currentPosition[0],
        latitude: trip.currentPosition[1],
        transitionDuration: 100,
        transitionInterpolator: new LinearInterpolator(["longitude", "latitude"]),
      }));
    } else {
      // Selected trip is no longer visible - clear selection
      setSelectedTripId(null);
    }
  }, [activeTrips, time, selectedTripId]);

  // Memoize selected trip data separately to avoid filtering every frame
  const selectedTripData = useMemo(
    () => (selectedTripId ? activeTrips.filter((t) => t.id === selectedTripId) : []),
    [activeTrips, selectedTripId]
  );

  const layers = useMemo(
    () => [
      // Selected biker's full route (rendered underneath trails, only when selected)
      ...(selectedTripData.length > 0
        ? [
            new PathLayer<DeckTrip>({
              id: "selected-route",
              data: selectedTripData,
              getPath: (d) => d.path,
              getColor: THEME.selectedColor,
              getWidth: 4,
              widthMinPixels: 2,
              opacity: 0.4,
              pickable: false,
            }),
          ]
        : []),
      new TripsLayer<DeckTrip>({
        id: "trips",
        data: activeTrips,
        getPath,
        getTimestamps,
        getColor: getTripColor,
        opacity: 0.3,
        widthMinPixels: 3,
        rounded: true,
        trailLength: TRAIL_LENGTH_SECONDS,
        currentTime: time,
        pickable: false,
        updateTriggers: {
          getColor: [selectedTripId],
        },
      }),
      new IconLayer({
        id: "bike-heads",
        data: activeTrips,
        billboard: false,
        opacity: 0.8,
        getPosition: getBikeHeadPosition,
        getAngle: getBikeHeadAngle,
        getIcon: getBikeHeadIcon,
        getSize: getBikeHeadSize,
        getColor: getBikeHeadColor,
        iconAtlas: ARROW_SVG,
        iconMapping: ICON_MAPPING,
        pickable: false,
        // GPU-based visibility filtering
        extensions: [dataFilter],
        getFilterValue,
        filterRange: [[-Infinity, time], [time, Infinity]],
        updateTriggers: {
          getPosition: [time],
          getAngle: [time],
          getColor: [time, selectedTripId],
        },
      }),
    ],
    [activeTrips, time, selectedTripId, selectedTripData]
  );

  const handleMapClick = useCallback(
    (info: { coordinate?: number[] }) => {
      if (isPickingLocation && info.coordinate && info.coordinate.length >= 2) {
        setPickedLocation({
          lng: info.coordinate[0],
          lat: info.coordinate[1],
        });
      }
    },
    [isPickingLocation, setPickedLocation]
  );

  return (
    <div className="relative w-full h-full">
      <DeckGL
        layers={layers}
        initialViewState={initialViewState}
        controller={true}
        onClick={handleMapClick}
        getCursor={() => (isPickingLocation ? "crosshair" : "grab")}
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
          <div ref={fpsRef} className="text-white/60 mt-1">-- FPS</div>
        </div>
      </div>

      {/* Play/Replay controls - top left */}
      <div className="absolute top-4 left-4 z-10 flex gap-2">
        {animState === "idle" && (
          <button
            onClick={play}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg shadow-lg transition-colors"
          >
            Play
          </button>
        )}
        {animState === "playing" && (
          <>
            <div className="bg-gray-800 text-white font-medium px-4 py-2 rounded-lg shadow-lg">
              Playing...
            </div>
            <button
              onClick={selectRandomBiker}
              className="bg-orange-500 hover:bg-orange-600 text-white font-medium px-4 py-2 rounded-lg shadow-lg transition-colors"
            >
              Random Biker
            </button>
          </>
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
