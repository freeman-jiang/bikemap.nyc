"use client";

import {
  CAMERA_POLLING_INTERVAL_MS,
  CHUNKS_PER_BATCH,
  COLORS,
  INITIAL_VIEW_STATE,
  PREFETCH_THRESHOLD_CHUNKS,
  REAL_FADE_DURATION_MS,
  REAL_MAX_FRAME_DELTA_MS,
  SIM_CHUNK_SIZE_MS,
  SIM_GRAPH_WINDOW_SIZE_MS,
  SIM_TRAIL_LENGTH_MS,
} from "@/lib/config";
import { createThrottledSampler } from "@/lib/misc";
import { useAnimationStore } from "@/lib/stores/animation-store";
import { usePickerStore } from "@/lib/stores/location-picker-store";
import { useSearchStore } from "@/lib/stores/search-store";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useStationsStore, type Station } from "@/lib/stores/stations-store";
import type { GraphDataPoint, Phase, ProcessedTrip } from "@/lib/trip-types";
import { TripDataService } from "@/services/trip-data-service";
import { DataFilterExtension, DataFilterExtensionProps } from "@deck.gl/extensions";
import { TripsLayer } from "@deck.gl/geo-layers";
import { IconLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import { DeckGL } from "@deck.gl/react";
import { Pause, Play, Search, Settings, Shuffle } from "lucide-react";
import "mapbox-gl/dist/mapbox-gl.css";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map as MapboxMap, Marker } from "react-map-gl/mapbox";
import { ActiveRidesPanel } from "./ActiveRidesPanel";
import { MapControlButton } from "./MapControlButton";
import { SelectedTripPanel } from "./SelectedTripPanel";
import { TimeDisplay } from "./TimeDisplay";
import { Kbd } from "./ui/kbd";

import type { MapViewState } from "@deck.gl/core";
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

// Color utilities
type Color4 = [number, number, number, number];
const MAX_ALPHA = 0.8 * 255;

// Layer accessor functions (extracted to avoid recreation on each render)
const getPath = (d: ProcessedTrip) => d.path;
const getTimestamps = (d: ProcessedTrip) => d.simTimestampsMs;
// Use currentPathColor which includes viewer fade alpha
const getTripColor = (d: ProcessedTrip): Color4 =>
  d.isSelected
    ? [COLORS.selected[0], COLORS.selected[1], COLORS.selected[2], d.currentPathColor[3]]
    : d.currentPathColor;

// IconLayer accessors - now use ProcessedTrip directly (no intermediate BikeHead objects)
const getBikeHeadPosition = (d: ProcessedTrip, { target }: { target: number[] }): [number, number, number] => {
  target[0] = d.currentPosition[0];
  target[1] = d.currentPosition[1];
  target[2] = 0;
  return target as [number, number, number];
};
const getBikeHeadAngle = (d: ProcessedTrip) => -d.currentBearing;
const getBikeHeadColor = (d: ProcessedTrip): Color4 => d.currentHeadColor;

const ICON_MAPPING = {
  arrow: { x: 0, y: 0, width: 24, height: 24, anchorX: 12, anchorY: 12, mask: true },
};

// Static polygon for dim overlay (full world bounds)
const DIM_OVERLAY_POLYGON = [
  [
    [-180, -90],
    [-180, 90],
    [180, 90],
    [180, -90],
    [-180, -90],
  ],
];

// Selected path color with fade in/out based on phase
const PATH_OPACITY = 180;
const getSelectedPathColor = (d: ProcessedTrip): Color4 => d.currentPathColor;

// DataFilterExtension for GPU-based visibility filtering
// filterSize: 2 means we filter on 2 values [simVisibleStartMs, simVisibleEndMs]
const dataFilter = new DataFilterExtension({ filterSize: 2 });

// Accessor for DataFilterExtension - returns [simVisibleStartMs, simVisibleEndMs]
const getFilterValue = (d: ProcessedTrip): [number, number] => [d.simVisibleStartMs, d.simVisibleEndMs];

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
  simTimeMs: number,
  realFadeDurationMs: number
): boolean {
  const {
    path,
    simVisibleStartMs,
    simVisibleEndMs,
    simFadeInEndMs,
    simEndTimeMs,
    firstSegmentBearing,
    lastSegmentBearing,
  } = trip;

  // Not visible yet or already gone
  if (simTimeMs < simVisibleStartMs || simTimeMs > simVisibleEndMs) {
    trip.isVisible = false;
    return false;
  }

  // Track when viewer first sees this trip
  if (trip.simViewerFirstSeenMs === null) {
    trip.simViewerFirstSeenMs = simTimeMs;
  }

  // Calculate viewer fade progress (0 to 1, clamped) - used as alpha multiplier
  const viewerFadeProgress = Math.min(1, (simTimeMs - trip.simViewerFirstSeenMs) / realFadeDurationMs);

  // Determine timeline phase and progress using precomputed boundaries
  let phase: Phase;
  let phaseProgress: number;

  if (simTimeMs < simFadeInEndMs) {
    phase = "fading-in";
    phaseProgress = (simTimeMs - simVisibleStartMs) / realFadeDurationMs;
  } else if (simTimeMs >= simEndTimeMs) {
    phase = "fading-out";
    phaseProgress = (simTimeMs - simEndTimeMs) / realFadeDurationMs;
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
    computeTripColors(trip, viewerFadeProgress);
    return true;
  }

  if (phase === "fading-out") {
    trip.currentPosition[0] = path[path.length - 1][0];
    trip.currentPosition[1] = path[path.length - 1][1];
    trip.currentBearing = lastSegmentBearing;
    trip.currentPhase = phase;
    trip.currentPhaseProgress = phaseProgress;
    trip.isVisible = true;
    computeTripColors(trip, viewerFadeProgress);
    return true;
  }

  // Moving phase: interpolate along route with look-ahead bearing
  const { simTimestampsMs, cumulativeDistances } = trip;
  const simMovingDurationMs = simEndTimeMs - simFadeInEndMs;
  const movingProgress = simMovingDurationMs > 0
    ? Math.max(0, Math.min(1, (simTimeMs - simFadeInEndMs) / simMovingDurationMs))
    : 1;

  // Map to timestamp along route
  const simTripTimeMs = simTimestampsMs[0] + movingProgress * (simTimestampsMs[simTimestampsMs.length - 1] - simTimestampsMs[0]);

  // Use cached index and scan forward (time only increases)
  let idx = trip.lastSegmentIndex;
  while (idx < simTimestampsMs.length - 1 && simTimestampsMs[idx + 1] < simTripTimeMs) {
    idx++;
  }
  trip.lastSegmentIndex = idx;

  let t = 0;
  if (idx >= path.length - 1) {
    trip.currentPosition[0] = path[path.length - 1][0];
    trip.currentPosition[1] = path[path.length - 1][1];
  } else {
    const t0 = simTimestampsMs[idx];
    const t1 = simTimestampsMs[idx + 1];
    t = t1 > t0 ? (simTripTimeMs - t0) / (t1 - t0) : 0;

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
  computeTripColors(trip, viewerFadeProgress);

  return true;
}

// Compute colors in-place based on current phase, progress, and viewer fade
function computeTripColors(trip: ProcessedTrip, viewerFadeProgress: number): void {
  const bikeColor = trip.bikeType === "electric_bike" ? COLORS.electric : COLORS.classic;
  const phase = trip.currentPhase;
  const progress = trip.currentPhaseProgress;

  let r: number, g: number, b: number;
  let headAlpha: number, pathAlpha: number;

  switch (phase) {
    case "fading-in":
      // Lerp from fadeIn to bikeColor
      r = COLORS.fadeIn[0] + (bikeColor[0] - COLORS.fadeIn[0]) * progress;
      g = COLORS.fadeIn[1] + (bikeColor[1] - COLORS.fadeIn[1]) * progress;
      b = COLORS.fadeIn[2] + (bikeColor[2] - COLORS.fadeIn[2]) * progress;
      headAlpha = progress * MAX_ALPHA;
      pathAlpha = progress * PATH_OPACITY;
      break;
    case "fading-out":
      r = COLORS.fadeOut[0];
      g = COLORS.fadeOut[1];
      b = COLORS.fadeOut[2];
      headAlpha = (1 - progress) * MAX_ALPHA;
      pathAlpha = (1 - progress) * PATH_OPACITY;
      break;
    default: // moving
      r = bikeColor[0];
      g = bikeColor[1];
      b = bikeColor[2];
      headAlpha = MAX_ALPHA;
      pathAlpha = PATH_OPACITY;
  }

  // Apply viewer fade as final alpha multiplier (orthogonal to timeline phases)
  trip.currentHeadColor[0] = r;
  trip.currentHeadColor[1] = g;
  trip.currentHeadColor[2] = b;
  trip.currentHeadColor[3] = headAlpha * viewerFadeProgress;

  trip.currentPathColor[0] = r;
  trip.currentPathColor[1] = g;
  trip.currentPathColor[2] = b;
  trip.currentPathColor[3] = pathAlpha * viewerFadeProgress;
}

// Cached interpolator for camera follow (avoid allocating new object every frame)
const cameraInterpolator = new LinearInterpolator(["longitude", "latitude"]);

export const BikeMap = () => {
  // Animation store
  const speedup = useAnimationStore((s) => s.speedup);
  const animationStartDate = useAnimationStore((s) => s.animationStartDate);
  const simTimeMs = useAnimationStore((s) => s.simCurrentTimeMs);
  const storePlay = useAnimationStore((s) => s.play);
  const storePause = useAnimationStore((s) => s.pause);
  const isPlaying = useAnimationStore((s) => s.isPlaying);
  const advanceSimTime = useAnimationStore((s) => s.advanceSimTime);
  const setSimCurrentTimeMs = useAnimationStore((s) => s.setSimCurrentTimeMs);
  const selectedTripId = useAnimationStore((s) => s.selectedTripId);
  const selectedTripInfo = useAnimationStore((s) => s.selectedTripInfo);
  const selectTrip = useAnimationStore((s) => s.selectTrip);

  // Derived values (computed at consumption time)
  const realWindowStartMs = animationStartDate.getTime();
  const realFadeDurationMs = REAL_FADE_DURATION_MS * speedup;

  const [activeTrips, setActiveTrips] = useState<ProcessedTrip[]>([]);
  const [animState, setAnimState] = useState<AnimationState>("idle");
  const [initialViewState, setInitialViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const [graphData, setGraphData] = useState<GraphDataPoint[]>([]);
  const [bearing, setBearing] = useState(0);

  const { isPickingLocation, setPickedLocation, pickedLocation } = usePickerStore();
  const { getStation, load: loadStations, stations } = useStationsStore();
  const openSearch = useSearchStore((s) => s.open);
  const toggleSettings = useSettingsStore((s) => s.toggle);

  // Detect Mac vs Windows/Linux for keyboard shortcut display
  const [isMac, setIsMac] = useState(true); // Default to Mac to avoid layout shift
  useEffect(() => {
    setIsMac(navigator.platform.toUpperCase().includes("MAC"));
  }, []);

  // Load station data
  useEffect(() => {
    loadStations();
  }, [loadStations]);

  // Esc key handler: deselect selected trip
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedTripId !== null) {
        e.preventDefault();
        selectTrip(null);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedTripId, selectTrip]);

  // Keyboard shortcut refs (to avoid stale closures)
  const animStateRef = useRef(animState);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    animStateRef.current = animState;
    isPlayingRef.current = isPlaying;
  }, [animState, isPlaying]);

  const rafRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const panelRef = useRef<{ fps: HTMLDivElement | null; rides: HTMLSpanElement | null }>(null);
  const smoothedFpsRef = useRef(60);
  const visibleCountRef = useRef(0);
  const tripMapRef = useRef<Map<string, ProcessedTrip>>(new Map());
  const loadingChunksRef = useRef<Set<number>>(new Set());
  const loadedChunksRef = useRef<Set<number>>(new Set());
  const lastChunkRef = useRef(-1);
  const lastBatchRef = useRef(-1);
  const serviceRef = useRef<TripDataService | null>(null);
  const graphSamplerRef = useRef(createThrottledSampler({ intervalMs: 100 }));
  const fpsSamplerRef = useRef(createThrottledSampler({ intervalMs: 100 }));
  const cameraSamplerRef = useRef(createThrottledSampler({ intervalMs: CAMERA_POLLING_INTERVAL_MS }));

  // Button refs for keyboard shortcut animations
  const playPauseButtonRef = useRef<HTMLButtonElement>(null);
  const randomButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  // Helper to trigger button press animation
  const triggerButtonAnimation = useCallback((ref: React.RefObject<HTMLButtonElement | null>) => {
    const button = ref.current;
    if (!button) return;
    button.style.transform = "scale(0.95)";
    setTimeout(() => {
      button.style.transform = "";
    }, 100);
  }, []);

  // Get chunk index from simulation time (ms)
  const getChunkIndex = useCallback(
    (simTimeMs: number) => Math.floor(simTimeMs / SIM_CHUNK_SIZE_MS),
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


  const currentChunk = getChunkIndex(simTimeMs);

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
      if (trip.simVisibleEndMs < simTimeMs) {
        tripMapRef.current.delete(id);
      }
    }

    // Sync state for rendering
    const currentTrips = Array.from(tripMapRef.current.values());
    setActiveTrips(currentTrips);
  }, [currentChunk, animState, loadUpcomingRides, simTimeMs]);

  // Start the animation loop (used by both play and resume)
  const startLoop = useCallback(() => {
    const tick = (timestamp: number) => {
      if (lastTimestampRef.current !== null) {
        const realRawDeltaMs = timestamp - lastTimestampRef.current;
        // Cap delta to prevent time jumps when returning from background tab
        const realDeltaMs = Math.min(realRawDeltaMs, REAL_MAX_FRAME_DELTA_MS);
        advanceSimTime(realDeltaMs * speedup);
        const currentFps = 1000 / realRawDeltaMs;
        smoothedFpsRef.current = smoothedFpsRef.current * 0.9 + currentFps * 0.1;
        fpsSamplerRef.current.sample(() => {
          if (panelRef.current?.fps) {
            panelRef.current.fps.textContent = `${Math.round(smoothedFpsRef.current)} FPS`;
          }
          if (panelRef.current?.rides) {
            panelRef.current.rides.textContent = visibleCountRef.current.toLocaleString();
          }
        });

        // Sample graph data at intervals
        graphSamplerRef.current.sample(() => {
          const simTimeMs = useAnimationStore.getState().simCurrentTimeMs;
          setGraphData((prev) => {
            const newPoint = { simTimeMs, count: visibleCountRef.current };
            const updated = [...prev, newPoint];
            // Keep only points within rolling window
            return updated.filter((p) => simTimeMs - p.simTimeMs <= SIM_GRAPH_WINDOW_SIZE_MS);
          });
        });

        // Camera follow + cleanup - throttled to 500ms
        cameraSamplerRef.current.sample(() => {
          const state = useAnimationStore.getState();
          const selectedId = state.selectedTripId;
          if (selectedId === null) return;

          const trip = tripMapRef.current.get(selectedId);

          // Clear selection if trip ended OR if trip no longer exists in map
          if (!trip || state.simCurrentTimeMs > trip.simVisibleEndMs) {
            state.selectTrip(null);
            return;
          }

          // Follow if visible
          if (trip.isVisible) {
            setInitialViewState((prev) => ({
              ...prev,
              longitude: trip.currentPosition[0],
              latitude: trip.currentPosition[1],
              transitionDuration: CAMERA_POLLING_INTERVAL_MS,
              transitionInterpolator: cameraInterpolator,
            }));
          }
        });
      }
      lastTimestampRef.current = timestamp;
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [speedup, advanceSimTime]);

  const play = useCallback(() => {
    setAnimState("playing");
    setSimCurrentTimeMs(0);
    storePlay();
    lastChunkRef.current = 0;
    lastTimestampRef.current = null;
    graphSamplerRef.current.reset();
    fpsSamplerRef.current.reset();
    setGraphData([]);
    startLoop();
  }, [setSimCurrentTimeMs, storePlay, startLoop]);

  const resume = useCallback(() => {
    lastTimestampRef.current = null; // Reset to avoid large delta on first frame
    storePlay();
    startLoop();
  }, [storePlay, startLoop]);

  const pause = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    storePause();
  }, [storePause]);

  // Pause animation when entering picking mode
  useEffect(() => {
    if (isPickingLocation && rafRef.current) {
      pause();
    }
  }, [isPickingLocation, pause]);

  // Toggle play/pause based on current state
  const togglePlayPause = useCallback(() => {
    if (animStateRef.current === "idle") {
      play();
    } else if (isPlayingRef.current) {
      pause();
    } else {
      resume();
    }
  }, [play, pause, resume]);

  // Initialize service and reload when config changes
  const configRef = useRef<{ realWindowStartMs: number; speedup: number } | null>(null);
  useEffect(() => {
    const prev = configRef.current;
    const isInitialMount = prev === null;

    // Skip if config unchanged (but always run on initial mount)
    if (!isInitialMount && prev.realWindowStartMs === realWindowStartMs && prev.speedup === speedup) return;
    configRef.current = { realWindowStartMs, speedup };

    // Only log and reset state on config changes, not initial mount
    if (!isInitialMount) {
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
      graphSamplerRef.current.reset();
      fpsSamplerRef.current.reset();
      setActiveTrips([]);
      setAnimState("idle");
      setGraphData([]);
    }

    // Initialize/recreate service
    const initService = async () => {
      useAnimationStore.getState().setIsLoadingTrips(true);

      // Terminate old service if exists
      serviceRef.current?.terminate();

      // Create new service
      const service = new TripDataService({
        realWindowStartMs,
        animationStartDate,
        realFadeDurationMs,
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
      useAnimationStore.getState().setIsLoadingTrips(false);

      // Auto-play after trips load
      play();
    };

    initService();

    // Cleanup on unmount
    return () => {
      serviceRef.current?.terminate();
      serviceRef.current = null;
    };
  }, [realWindowStartMs, speedup, realFadeDurationMs, play, animationStartDate]);

  // Select a random visible biker with at least half their trip remaining
  const selectRandomBiker = useCallback(() => {
    const eligibleTrips = activeTrips.filter((t) => {
      if (!t.isVisible) return false;
      // Only select trips that have at least half their duration remaining
      const simMidpointMs = (t.simStartTimeMs + t.simEndTimeMs) / 2;
      return simTimeMs < simMidpointMs;
    });
    if (eligibleTrips.length === 0) return;
    const randomTrip = eligibleTrips[Math.floor(Math.random() * eligibleTrips.length)];

    const startStation = getStation(randomTrip.startStationName);
    const endStation = getStation(randomTrip.endStationName);

    selectTrip({
      id: randomTrip.id,
      info: {
        id: randomTrip.id,
        bikeType: randomTrip.bikeType,
        memberCasual: randomTrip.memberCasual,
        startStationName: startStation.name,
        endStationName: endStation.name,
        startNeighborhood: startStation.neighborhood,
        endNeighborhood: endStation.neighborhood,
        startedAt: new Date(randomTrip.realStartedAtMs),
        endedAt: new Date(randomTrip.realEndedAtMs),
        routeDistance: randomTrip.routeDistance,
      },
    });
  }, [activeTrips, selectTrip, getStation, simTimeMs]);

  // Keyboard shortcuts: Space for play/pause, R for random, S for settings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === " " && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        togglePlayPause();
        triggerButtonAnimation(playPauseButtonRef);
      } else if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        selectRandomBiker();
        triggerButtonAnimation(randomButtonRef);
      } else if (e.key.toLowerCase() === "i" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleSettings();
        triggerButtonAnimation(settingsButtonRef);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [togglePlayPause, selectRandomBiker, toggleSettings, triggerButtonAnimation]);

  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
    throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN is not set");
  }

  // Update all trip states in place - GPU handles visibility filtering via DataFilterExtension
  useMemo(() => {
    let count = 0;
    for (const trip of activeTrips) {
      if (simTimeMs < trip.simVisibleStartMs || simTimeMs > trip.simVisibleEndMs) {
        trip.isVisible = false;
        continue;
      }
      updateTripState(trip, simTimeMs, realFadeDurationMs);
      trip.isSelected = trip.id === selectedTripId;
      count++;
    }
    visibleCountRef.current = count;
  }, [activeTrips, simTimeMs, selectedTripId, realFadeDurationMs]);

  // Memoize selected trip data - O(1) map lookup instead of O(n) filter
  // Depends on activeTrips to recalculate when trips load after config change
  const selectedTripData = useMemo(() => {
    if (!selectedTripId) return [];
    const trip = tripMapRef.current.get(selectedTripId);
    return trip ? [trip] : [];
  }, [selectedTripId, activeTrips]);

  const layers = useMemo(() => {
    // Show station dots when picking a location (GPU-accelerated)
    if (isPickingLocation) {
      return [
        // Glow effect layer (larger, semi-transparent)
        new ScatterplotLayer<Station>({
          id: "stations-glow",
          data: stations,
          getPosition: (d) => [d.longitude, d.latitude],
          getFillColor: [125, 207, 255, 60],
          getRadius: 6,
          radiusUnits: "pixels",
          pickable: false,
        }),
        // Core dot layer
        new ScatterplotLayer<Station>({
          id: "stations",
          data: stations,
          getPosition: (d) => [d.longitude, d.latitude],
          getFillColor: [125, 207, 255, 255],
          getRadius: 2,
          radiusUnits: "pixels",
          pickable: false,
        }),
      ];
    }

    const hasSelection = selectedTripData.length > 0;

    return [
      // Trips layer - dimmed when selection active
      // Uses DataFilterExtension to GPU-filter trips by visibility window
      new TripsLayer<ProcessedTrip, DataFilterExtensionProps<ProcessedTrip>>({
        id: "trips",
        data: activeTrips,
        getPath,
        getTimestamps,
        getColor: getTripColor,
        opacity: 0.2,
        widthMinPixels: 3,
        jointRounded: true,
        capRounded: true,
        trailLength: SIM_TRAIL_LENGTH_MS,
        currentTime: simTimeMs,
        pickable: false,
        // GPU-based visibility filtering - only render trips where:
        // simVisibleStartMs <= simTimeMs AND simVisibleEndMs >= simTimeMs
        extensions: [dataFilter],
        getFilterValue,
        filterRange: [[-Infinity, simTimeMs], [simTimeMs, Infinity]],
        updateTriggers: {
          getColor: [simTimeMs, selectedTripId],
        },
      }),
      new IconLayer({
        id: "bike-heads",
        data: activeTrips,
        billboard: false,
        opacity: 0.75,
        getPosition: getBikeHeadPosition,
        getAngle: getBikeHeadAngle,
        getIcon: () => "arrow",
        getSize: 9,
        getColor: getBikeHeadColor,
        iconAtlas: ARROW_SVG,
        iconMapping: ICON_MAPPING,
        pickable: false,
        // GPU-based visibility filtering
        extensions: [dataFilter],
        getFilterValue,
        filterRange: [[-Infinity, simTimeMs], [simTimeMs, Infinity]],
        updateTriggers: {
          getPosition: [simTimeMs],
          getAngle: [simTimeMs],
          getColor: [simTimeMs, selectedTripId],
        },
      }),
      // Dimming overlay - always present, fades via GPU transitions
      new SolidPolygonLayer({
        id: "dim-overlay",
        data: DIM_OVERLAY_POLYGON,
        getPolygon: (d) => d,
        getFillColor: hasSelection ? [0, 0, 0, 180] : [0, 0, 0, 0],
        transitions: {
          getFillColor: 250,
        },
        pickable: false,
      }),
      // Selected route - rendered on TOP with bike type color
      ...(hasSelection
        ? [
            new PathLayer<ProcessedTrip>({
              id: "selected-route",
              data: selectedTripData,
              getPath: (d) => d.path,
              getColor: getSelectedPathColor,
              getWidth: 4,
              widthMinPixels: 2,
              opacity: 0.75,
              pickable: false,
              updateTriggers: {
                getColor: [simTimeMs],
              },
            }),
            // Selected bike head - rendered on top at full opacity
            new IconLayer({
              id: "selected-bike-head",
              data: selectedTripData,
              billboard: false,
              opacity: 1,
              getPosition: getBikeHeadPosition,
              getAngle: getBikeHeadAngle,
              getIcon: () => "arrow",
              getSize: 9,
              getColor: getBikeHeadColor,
              iconAtlas: ARROW_SVG,
              iconMapping: ICON_MAPPING,
              pickable: false,
              extensions: [dataFilter],
              getFilterValue,
              filterRange: [[-Infinity, simTimeMs], [simTimeMs, Infinity]],
              updateTriggers: {
                getPosition: [simTimeMs],
                getAngle: [simTimeMs],
                getColor: [simTimeMs],
              },
            }),
          ]
        : []),
    ];
  }, [activeTrips, simTimeMs, selectedTripId, selectedTripData, isPickingLocation, stations]);

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
        onViewStateChange={({ viewState }) => {
          // Capture bearing before the microtask so TS keeps the narrowing.
          const bearing = "bearing" in viewState ? viewState.bearing : undefined;
          if (typeof bearing === "number") {
            queueMicrotask(() => setBearing(bearing));
          }
        }}
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

      {/* HUD - top bar */}
      <div className="absolute top-3 inset-x-0 z-10 flex items-start justify-between px-3 pointer-events-none">
        {/* Controls - bottom-right on mobile, top-left on desktop */}
        <div className="fixed bottom-8 right-3 z-20 sm:static sm:z-auto flex flex-col items-end sm:items-stretch gap-1 pointer-events-auto">
          {/* Search button */}
          <MapControlButton onClick={openSearch}>
            <span className="flex items-center gap-1.5 min-w-20">
              <Search className="w-4 h-4" />
              Search
            </span>
            <Kbd className="bg-zinc-800 text-white/70">{isMac ? "⌘" : "Ctrl+"}K</Kbd>
          </MapControlButton>
          {/* Play/Pause button */}
          {animState === "idle" ? (
            <MapControlButton ref={playPauseButtonRef} onClick={play}>
              <span className="flex items-center gap-1.5">
                <Play className="w-4 h-4" />
                Play
              </span>
              <Kbd className="bg-zinc-800 text-white/70">Space</Kbd>
            </MapControlButton>
          ) : isPlaying ? (
            <MapControlButton ref={playPauseButtonRef} onClick={pause}>
              <span className="flex items-center gap-1.5">
                <Pause className="w-4 h-4" />
                Pause
              </span>
              <Kbd className="bg-zinc-800 text-white/70">Space</Kbd>
            </MapControlButton>
          ) : (
            <MapControlButton ref={playPauseButtonRef} onClick={resume}>
              <span className="flex items-center gap-1.5">
                <Play className="w-4 h-4" />
                Play
              </span>
              <Kbd className="bg-zinc-800 text-white/70">Space</Kbd>
            </MapControlButton>
          )}
          {/* Random button */}
          <MapControlButton ref={randomButtonRef} onClick={selectRandomBiker}>
            <span className="flex items-center gap-1.5">
              <Shuffle className="w-4 h-4" />
              Random
            </span>
            <Kbd className="bg-zinc-800 text-white/70">R</Kbd>
          </MapControlButton>
          {/* Settings button */}
          <MapControlButton ref={settingsButtonRef} onClick={toggleSettings}>
            <span className="flex items-center gap-1.5">
              <Settings className="w-4 h-4" />
              Settings
            </span>
            <Kbd className="bg-zinc-800 text-white/70">{isMac ? "⌘" : "Ctrl+"}I</Kbd>
          </MapControlButton>
        </div>

        {/* Time - absolutely centered */}
        <div className="absolute left-1/2 -translate-x-1/2 pointer-events-auto">
          <TimeDisplay simTimeMs={simTimeMs} realWindowStartDate={animationStartDate} />
        </div>

        {/* Stats - right */}
        <div className="pointer-events-none">
          <ActiveRidesPanel ref={panelRef} graphData={graphData} simTimeMs={simTimeMs} bearing={bearing} />
          <AnimatePresence>
            {selectedTripInfo && <SelectedTripPanel info={selectedTripInfo} />}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
