// =============================================================================
// Animation Defaults
// =============================================================================

// Default animation start date for trip data timeframe
export const DEFAULT_ANIMATION_START_DATE = new Date("2025-06-04T22:00:00.000Z"); // June 4, 2025 6pm EDT

// Default speedup multiplier for animation
export const DEFAULT_SPEEDUP = 150;

// =============================================================================
// Data Pipeline (batch/chunk sizing)
// =============================================================================

// Chunk: how often deck.gl rebuilds geometry
export const CHUNK_SIZE_SECONDS = 60;

// Batch: how often we fetch from API + worker processes trips
export const BATCH_SIZE_SECONDS = 60 * 60; // 1 hour

export const CHUNKS_PER_BATCH = BATCH_SIZE_SECONDS / CHUNK_SIZE_SECONDS;

// Prefetch config - start prefetching next batch at 80% through current batch
export const PREFETCH_THRESHOLD_CHUNKS = Math.floor(CHUNKS_PER_BATCH * 0.8);

// =============================================================================
// Rendering (visual tuning)
// =============================================================================

export const TRAIL_LENGTH_SECONDS = 45;
export const EASE_DISTANCE_METERS = 300;

// Fade duration in real-time milliseconds
export const FADE_DURATION_MS = 700;

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
// Colors (RGB tuples)
// =============================================================================

export const COLORS = {
  // Trail colors (TripsLayer)
  classic: [187, 154, 247] as const, // purple
  electric: [125, 207, 255] as const, // sky blue
  selected: [255, 165, 0] as const, // orange

  // Bike head transition colors
  fadeIn: [115, 255, 140] as const, // green
  fadeOut: [247, 118, 142] as const, // red/pink
} as const;
