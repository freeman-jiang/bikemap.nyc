"use client";

import {
  CHUNK_SIZE_SECONDS,
  CHUNKS_PER_BATCH,
  COLORS,
  FADE_DURATION_MS,
  INITIAL_VIEW_STATE,
  PREFETCH_THRESHOLD_CHUNKS,
  TRAIL_LENGTH_SECONDS,
} from "@/lib/config";
import { formatTime } from "@/lib/format";
import { useAnimationStore } from "@/lib/stores/animation-store";
import { usePickerStore } from "@/lib/stores/location-picker-store";
import type { Phase, ProcessedTrip } from "@/lib/trip-types";
import { TripDataService } from "@/services/trip-data-service";
import { DataFilterExtension } from "@deck.gl/extensions";
import { TripsLayer } from "@deck.gl/geo-layers";
import { IconLayer, PathLayer } from "@deck.gl/layers";
import { DeckGL } from "@deck.gl/react";
import "mapbox-gl/dist/mapbox-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MapboxMap, Marker } from "react-map-gl/mapbox";

import type { Color, MapViewState } from "@deck.gl/core";
import { LinearInterpolator } from "@deck.gl/core";

type AnimationState = "idle" | "playing";

// Arrow icon for bike heads
const ARROW_SVG = `data:image/svg+xml;base64,${btoa(`
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<g transform="rotate(45 12 12)">
    <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>
</g>
</svg>
`)}`;

// Layer accessor functions (extracted to avoid recreation on each render)
const getPath = (d: ProcessedTrip) => d.path;
const getTimestamps = (d: ProcessedTrip) => d.timestamps;
const getTripColor = (d: ProcessedTrip): Color =>
  d.isSelected
    ? (COLORS.selected)
    : d.bikeType === "electric_bike"
      ? (COLORS.electric)
      : (COLORS.classic);

// Color utilities
type Color4 = [number, number, number, number];
const MAX_ALPHA = 0.8 * 255;

const rgba = (rgb: Color, alpha: number): Color4 => [rgb[0], rgb[1], rgb[2], alpha];

const lerpRgba = (a: Color, b: Color, t: number, alpha: number): Color4 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
  alpha,
];

// IconLayer accessors - now use ProcessedTrip directly (no intermediate BikeHead objects)
const getBikeHeadPosition = (d: ProcessedTrip, { target }: { target: number[] }): [number, number, number] => {
  target[0] = d.currentPosition[0];
  target[1] = d.currentPosition[1];
  target[2] = 0;
  return target as [number, number, number];
};
const getBikeHeadAngle = (d: ProcessedTrip) => -d.currentBearing;
const getBikeHeadIcon = () => "arrow";
const getBikeHeadSize = () => 9;
const getBikeHeadColor = (d: ProcessedTrip): Color4 => {
  // Selected trips are always orange (still respect alpha for fading)
  if (d.isSelected) {
    const alpha =
      d.currentPhase === "fading-in"
        ? d.currentPhaseProgress * MAX_ALPHA
        : d.currentPhase === "fading-out"
          ? (1 - d.currentPhaseProgress) * MAX_ALPHA
          : MAX_ALPHA;
    return rgba(COLORS.selected, alpha);
  }

  const bikeColor = d.bikeType === "electric_bike" ? COLORS.electric : COLORS.classic;

  switch (d.currentPhase) {
    case "fading-in":
      // Simultaneous opacity fade-in + color transition
      return lerpRgba(COLORS.fadeIn, bikeColor, d.currentPhaseProgress, d.currentPhaseProgress * MAX_ALPHA);
    case "fading-out":
      return rgba(COLORS.fadeOut, (1 - d.currentPhaseProgress) * MAX_ALPHA);
    default: // moving
      return rgba(bikeColor, MAX_ALPHA);
  }
};

const ICON_MAPPING = {
  arrow: { x: 0, y: 0, width: 24, height: 24, anchorX: 12, anchorY: 12, mask: true },
};

// DataFilterExtension for GPU-based visibility filtering
// filterSize: 2 means we filter on 2 values [visibleStartSeconds, visibleEndSeconds]
const dataFilter = new DataFilterExtension({ filterSize: 2 });

// Accessor for DataFilterExtension - returns [visibleStartSeconds, visibleEndSeconds]
const getFilterValue = (d: ProcessedTrip): [number, number] => [d.visibleStartSeconds, d.visibleEndSeconds];

// Interpolate between two angles, handling 360°/0° wrapping
function interpolateAngle(from: number, to: number, factor: number): number {
  from = ((from % 360) + 360) % 360;
  to = ((to % 360) + 360) % 360;
  let diff = to - from;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return ((from + diff * factor) % 360 + 360) % 360;
}

// Update trip's mutable state in place. Returns true if visible.
function updateTripState(
  trip: ProcessedTrip,
  currentTime: number,
  fadeDurationSimSeconds: number
): boolean {
  const {
    path,
    visibleStartSeconds,
    visibleEndSeconds,
    fadeInEndSeconds,
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
    phaseProgress = (currentTime - visibleStartSeconds) / fadeDurationSimSeconds;
  } else if (currentTime >= endTimeSeconds) {
    phase = "fading-out";
    phaseProgress = (currentTime - endTimeSeconds) / fadeDurationSimSeconds;
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

  // Moving phase: interpolate along route with look-ahead bearing
  const { timestamps, cumulativeDistances } = trip;
  const movingDuration = endTimeSeconds - fadeInEndSeconds;
  const movingProgress = movingDuration > 0
    ? Math.max(0, Math.min(1, (currentTime - fadeInEndSeconds) / movingDuration))
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

// Cached interpolator for camera follow (avoid allocating new object every frame)
const cameraInterpolator = new LinearInterpolator(["longitude", "latitude"]);

export const BikeMap = () => {
  // Animation store
  const speedup = useAnimationStore((s) => s.speedup);
  const animationStartDate = useAnimationStore((s) => s.animationStartDate);
  const time = useAnimationStore((s) => s.currentTime);
  const storePlay = useAnimationStore((s) => s.play);
  const advanceTime = useAnimationStore((s) => s.advanceTime);
  const setCurrentTime = useAnimationStore((s) => s.setCurrentTime);
  const selectedTripId = useAnimationStore((s) => s.selectedTripId);
  const selectTrip = useAnimationStore((s) => s.selectTrip);

  // Derived values (computed at consumption time)
  const windowStartMs = animationStartDate.getTime();
  const fadeDurationSimSeconds = (FADE_DURATION_MS / 1000) * speedup;

  const [activeTrips, setActiveTrips] = useState<ProcessedTrip[]>([]);
  const [tripCount, setTripCount] = useState(0);
  const [animState, setAnimState] = useState<AnimationState>("idle");
  const [initialViewState, setInitialViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);

  const { isPickingLocation, setPickedLocation, pickedLocation } = usePickerStore();

  const rafRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const fpsRef = useRef<HTMLDivElement>(null);
  const smoothedFpsRef = useRef(60);
  const lastFpsUpdateRef = useRef(0);
  const tripMapRef = useRef<Map<string, ProcessedTrip>>(new Map());
  const loadingChunksRef = useRef<Set<number>>(new Set());
  const loadedChunksRef = useRef<Set<number>>(new Set());
  const lastChunkRef = useRef(-1);
  const lastBatchRef = useRef(-1);
  const serviceRef = useRef<TripDataService | null>(null);

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

  // Load rides starting in a specific chunk (from worker)
  const loadUpcomingRides = useCallback(
    async (chunkIndex: number) => {
      if (loadedChunksRef.current.has(chunkIndex) || loadingChunksRef.current.has(chunkIndex)) {
        return;
      }

      if (chunkIndex < 0 || !serviceRef.current) {
        return;
      }

      loadingChunksRef.current.add(chunkIndex);

      try {
        // Request pre-processed trips from service
        const trips = await serviceRef.current.requestChunk(chunkIndex);

        console.log(`Chunk ${chunkIndex}: ${trips.length} rides from worker`);

        // Add to ref (dedupes by ID)
        for (const trip of trips) {
          tripMapRef.current.set(trip.id, trip);
        }

        loadedChunksRef.current.add(chunkIndex);
      } finally {
        loadingChunksRef.current.delete(chunkIndex);
      }
    },
    []
  );

  // Initialize service and load first batch
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const initService = async () => {
      const service = new TripDataService({
        windowStartMs,
        animationStartDate,
        fadeDurationSimSeconds,
      });

      serviceRef.current = service;

      // Initialize and get initial trips
      const initialTrips = await service.init();

      // Copy to local ref
      tripMapRef.current = initialTrips;
      for (let i = 0; i <= 2; i++) {
        loadedChunksRef.current.add(i);
      }
      lastBatchRef.current = 0;

      // Update state for initial render
      setActiveTrips(Array.from(tripMapRef.current.values()));
      setTripCount(tripMapRef.current.size);
    };

    initService();

    // Cleanup on unmount
    return () => {
      serviceRef.current?.terminate();
      serviceRef.current = null;
    };
  }, [windowStartMs, animationStartDate, fadeDurationSimSeconds]);

  // Calculate current real time for clock display
  const currentRealTime = secondsToRealTime(time);
  const currentChunk = getChunkIndex(time);

  // On chunk change: load chunk from worker, prefetch next batch, cleanup old trips
  useEffect(() => {
    if (animState !== "playing") return;
    if (currentChunk === lastChunkRef.current) return;

    console.log(`Entered chunk ${currentChunk}`);
    lastChunkRef.current = currentChunk;

    // Load this chunk and next chunk from worker
    loadUpcomingRides(currentChunk);
    loadUpcomingRides(currentChunk + 1);

    // Check if we need to prefetch next batch (when 10 chunks from batch end)
    const currentBatch = Math.floor(currentChunk / CHUNKS_PER_BATCH);
    const chunkInBatch = currentChunk % CHUNKS_PER_BATCH;

    if (chunkInBatch >= PREFETCH_THRESHOLD_CHUNKS && serviceRef.current) {
      const nextBatch = currentBatch + 1;
      serviceRef.current.prefetchBatch(nextBatch);
    }

    // Clear old batch from worker memory (keep current batch and previous)
    if (currentBatch > 1 && serviceRef.current) {
      const oldBatch = currentBatch - 2;
      serviceRef.current.clearBatch(oldBatch);
    }

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
  }, [currentChunk, animState, loadUpcomingRides, time]);

  const play = useCallback(() => {
    setAnimState("playing");
    setCurrentTime(0);
    storePlay();
    lastChunkRef.current = 0;
    lastTimestampRef.current = null;

    const tick = (timestamp: number) => {
      if (lastTimestampRef.current !== null) {
        const deltaMs = timestamp - lastTimestampRef.current;
        const deltaSeconds = deltaMs / 1000;
        advanceTime(deltaSeconds * speedup);
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
  }, [speedup, advanceTime, setCurrentTime, storePlay]);

  // Reset and reload when config changes (track source values directly)
  const configRef = useRef({ windowStartMs, speedup });
  useEffect(() => {
    const prev = configRef.current;
    // Skip if config unchanged (including initial mount)
    if (prev.windowStartMs === windowStartMs && prev.speedup === speedup) return;
    configRef.current = { windowStartMs, speedup };

    console.log("Config changed, resetting animation...");

    // Stop current animation
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTimestampRef.current = null;

    // Clear all state
    tripMapRef.current.clear();
    loadingChunksRef.current.clear();
    loadedChunksRef.current.clear();
    lastChunkRef.current = -1;
    lastBatchRef.current = -1;
    setActiveTrips([]);
    setTripCount(0);
    setAnimState("idle");

    // Recreate service with new config
    const recreateService = async () => {
      // Terminate old service
      serviceRef.current?.terminate();

      // Create new service
      const service = new TripDataService({
        windowStartMs,
        animationStartDate,
        fadeDurationSimSeconds,
      });

      serviceRef.current = service;

      // Initialize and get initial trips
      const initialTrips = await service.init();

      // Copy to local ref
      tripMapRef.current = initialTrips;
      for (let i = 0; i <= 2; i++) {
        loadedChunksRef.current.add(i);
      }
      lastBatchRef.current = 0;

      setActiveTrips(Array.from(tripMapRef.current.values()));
      setTripCount(tripMapRef.current.size);

      if (selectedTripId) {
        play();
      }
    };

    recreateService();
  }, [windowStartMs, speedup, fadeDurationSimSeconds, selectedTripId, play, animationStartDate]);

  // Select a random visible biker
  const selectRandomBiker = useCallback(() => {
    const visibleTrips = activeTrips.filter((t) => t.isVisible);
    if (visibleTrips.length === 0) return;
    const randomTrip = visibleTrips[Math.floor(Math.random() * visibleTrips.length)];
    selectTrip(randomTrip.id);
  }, [activeTrips, selectTrip]);

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
      if (time < trip.visibleStartSeconds || time > trip.visibleEndSeconds) {
        trip.isVisible = false;
        continue;
      }
      updateTripState(trip, time, fadeDurationSimSeconds);
      // Only set isSelected if there's actually a selection (avoid work when no selection)
      if (selectedTripId !== null) {
        trip.isSelected = trip.id === selectedTripId;
      }
    }
  }, [activeTrips, time, selectedTripId, fadeDurationSimSeconds]);

  // Camera follow effect
  useEffect(() => {
    if (selectedTripId === null) return;
    // O(1) lookup via tripMapRef instead of O(n) activeTrips.find()
    const trip = tripMapRef.current.get(selectedTripId);

    // Only follow if trip exists AND is visible
    if (trip?.isVisible) {
      setInitialViewState((prev) => ({
        ...prev,
        longitude: trip.currentPosition[0],
        latitude: trip.currentPosition[1],
        transitionDuration: 100,
        transitionInterpolator: cameraInterpolator,
      }));
    }
    // Only clear selection if trip has FINISHED (past visibleEndSeconds)
    // Don't clear if trip just hasn't started yet
    else if (trip && time > trip.visibleEndSeconds) {
      selectTrip(null);
    }
    // If trip not found in tripMapRef at all, it might be in a future chunk - don't clear yet
  }, [time, selectedTripId, selectTrip]);

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
            new PathLayer<ProcessedTrip>({
              id: "selected-route",
              data: selectedTripData,
              getPath: (d) => d.path,
              getColor: COLORS.selected,
              getWidth: 4,
              widthMinPixels: 2,
              opacity: 0.4,
              pickable: false,
            }),
          ]
        : []),
      new TripsLayer<ProcessedTrip>({
        id: "trips",
        data: activeTrips,
        getPath,
        getTimestamps,
        getColor: getTripColor,
        opacity: 0.2,
        widthMinPixels: 3,
        jointRounded: true,
        capRounded: true,
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
        // updateTriggers required - deck.gl caches accessor results and won't
        // re-read mutated ProcessedTrip properties without this signal
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
        >
          {pickedLocation && (
            <Marker longitude={pickedLocation.lng} latitude={pickedLocation.lat} anchor="center">
              <span className="relative flex h-[6px] w-[6px] mt-1.5">
                <span className="animate-ping [animation-duration-[1.5s] absolute inline-flex h-full w-full rounded-full bg-sky-400/70 blur-[0.5px] shadow-[0_0_9px_3px_rgba(125,207,255,0.9)]"></span>
                <span className="absolute inline-flex h-full w-full rounded-full border border-sky-400/80 shadow-[0_0_4px_rgba(125,207,255,0.9)]"></span>
                <span className="relative inline-flex h-[6px] w-[6px] rounded-full bg-sky-300 shadow-[0_0_7px_2px_rgba(125,207,255,1)]"></span>
              </span>
            </Marker>
          )}
        </MapboxMap>
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
      </div>
    </div>
  );
};
