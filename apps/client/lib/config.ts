// =============================================================================
// Animation Defaults
// =============================================================================

import { Color } from "@deck.gl/core";

// Default animation start date for trip data timeframe
// Sept 11, 2025 4:50pm EDT = 1 hour before peak (4,913 concurrent at 5:50pm)
export const DEFAULT_ANIMATION_START_DATE = new Date("2025-09-11T20:50:00.000Z");

// Default speedup multiplier for animation
export const DEFAULT_SPEEDUP = 150;

// =============================================================================
// Data Pipeline (batch/chunk sizing)
// =============================================================================

// Chunk: how often deck.gl rebuilds geometry
export const CHUNK_SIZE_SECONDS = 60 * 1;

// Batch: how often we fetch from API + worker processes trips
export const BATCH_SIZE_SECONDS = 30 * 60; // 1 hour

export const CHUNKS_PER_BATCH = BATCH_SIZE_SECONDS / CHUNK_SIZE_SECONDS;

// Prefetch config - start prefetching next batch at 80% through current batch
export const PREFETCH_THRESHOLD_CHUNKS = Math.floor(CHUNKS_PER_BATCH * 0.8);

// =============================================================================
// Rendering (visual tuning)
// =============================================================================

export const TRAIL_LENGTH_SECONDS = 45;
export const EASE_DISTANCE_METERS = 300;
export const EASE_TIME_MULTIPLIER = 2; // How much longer ease zones take vs linear (2 = twice as slow)

// Fade duration in real-time milliseconds
export const FADE_DURATION_MS = 700;

// Max frame delta to prevent time jumps when returning from background tab (100ms = 10 FPS minimum)
export const MAX_FRAME_DELTA_MS = 100;

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

export const GRAPH_WINDOW_SIZE_SECONDS = 10800; // 3-hour rolling window
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