// =============================================================================
// Animation Defaults
// =============================================================================

import { Color } from "@deck.gl/core";

// Default animation start date for trip data timeframe
// Sept 11, 2025 4:50pm EDT = 1 hour before peak (4,913 concurrent at 5:50pm)
export const DEFAULT_ANIMATION_START_DATE = new Date("2025-09-11T20:50:00.000Z");

// Valid data range for Citi Bike data
export const DATA_START_DATE = new Date("2013-06-01T00:00:00Z");
export const DATA_END_DATE = new Date("2025-12-31T23:59:59Z");

// Default speedup multiplier for animation
export const DEFAULT_SPEEDUP = 150;

// =============================================================================
// Data Pipeline (batch/chunk sizing) - simulation time
// =============================================================================

// Chunk: how often deck.gl rebuilds geometry
export const SIM_CHUNK_SIZE_MS = 60 * 1000; // 1 minute

// Batch: how often we fetch from API + worker processes trips
export const SIM_BATCH_SIZE_MS = 30 * 60 * 1000; // 30 minutes

export const CHUNKS_PER_BATCH = SIM_BATCH_SIZE_MS / SIM_CHUNK_SIZE_MS;

// Prefetch config - start prefetching next batch at 80% through current batch
export const PREFETCH_THRESHOLD_CHUNKS = Math.floor(CHUNKS_PER_BATCH * 0.8);

// =============================================================================
// Rendering (visual tuning)
// =============================================================================

export const SIM_TRAIL_LENGTH_MS = 45 * 1000; // simulation time
export const EASE_DISTANCE_METERS = 300;
export const EASE_TIME_MULTIPLIER = 2; // How much longer ease zones take vs linear (2 = twice as slow)

// Fade duration in real-time milliseconds (multiplied by speedup at usage)
export const REAL_FADE_DURATION_MS = 700;

// Max frame delta to prevent time jumps when returning from background tab (100ms = 10 FPS minimum)
export const REAL_MAX_FRAME_DELTA_MS = 100;

// =============================================================================
// Map Configuration
// =============================================================================

export const INITIAL_VIEW_STATE = {
  longitude: -73.9903, // Manhattan Bridge center
  latitude: 40.7074,
  zoom: 13,
  pitch: 0, // Bird's eye view (straight down)
  bearing: 0,
};

// =============================================================================
// Graph Configuration
// =============================================================================

export const SIM_GRAPH_WINDOW_SIZE_MS = 3 * 60 * 60 * 1000; // 3-hour rolling window (simulation time)
export const GRAPH_MIN_SCALE = 100; // Minimum Y-axis scale (avoid jitter)

// =============================================================================
// Colors (RGB tuples)
// =============================================================================

export const COLORS = {
  // Trail colors (TripsLayer)
  classic: [187, 154, 247], // purple
  electric: [125, 207, 255], // sky blue
  selected: [255, 165, 0], // orange

  // Bike head transition colors
  fadeIn: [115, 255, 140], // green
  fadeOut: [247, 118, 142], // red/pink
} as const satisfies Record<string, Color>;

export const CAMERA_POLLING_INTERVAL_MS = 250;