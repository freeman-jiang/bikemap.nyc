// Shared types for trip processing between main thread and worker

// ============================================================================
// Graph Types
// ============================================================================

export type GraphDataPoint = {
  time: number; // Simulation seconds from window start
  count: number; // Active trip count at this time
};

// ============================================================================
// Trip Types (from Parquet schema)
// ============================================================================

// Trip from parquet joined with routes
// Routes are keyed by station NAME (not ID) because IDs changed between years
export type TripWithRoute = {
  id: string;
  startStationName: string;
  endStationName: string;
  startedAt: Date;
  endedAt: Date;
  bikeType: string;
  memberCasual: string;
  startLat: number;
  startLng: number;
  endLat: number | null;
  endLng: number | null;
  // From routes.db (polyline6 encoded for network efficiency)
  routeGeometry: string | null; // Polyline6 encoded path
  routeDistance: number | null; // Distance in meters
};

// ============================================================================
// Processed Trip (for deck.gl rendering)
// ============================================================================

export type Phase = "fading-in" | "moving" | "fading-out";

// Transformed trip data for deck.gl TripsLayer
export type ProcessedTrip = {
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
  // Precomputed phase boundary (avoid recalculating each frame)
  fadeInEndSeconds: number;
  // Precomputed bearings for stationary phases
  firstSegmentBearing: number;
  lastSegmentBearing: number;
  // Mutable state (initialized by worker, updated by main thread each frame)
  currentPosition: [number, number];
  currentBearing: number;
  currentPhase: Phase;
  currentPhaseProgress: number;
  isVisible: boolean;
  isSelected: boolean;
  currentHeadColor: [number, number, number, number];
  currentPathColor: [number, number, number, number];
  // Viewer-relative tracking (null = never seen by viewer)
  viewerFirstSeenSeconds: number | null;
  // Metadata for UI display
  memberCasual: string;
  startStationName: string;
  endStationName: string;
  startedAtMs: number;
  endedAtMs: number;
  routeDistance: number | null;
};

// ============================================================================
// Worker Messages
// ============================================================================

// Main Thread -> Worker
export type InitMessage = {
  type: "init";
  windowStartMs: number;
  fadeDurationSimSeconds: number;
};

export type LoadBatchMessage = {
  type: "load-batch";
  batchId: number;
  trips: TripWithRoute[];
};

export type RequestChunkMessage = {
  type: "request-chunk";
  chunkIndex: number;
};

export type ClearBatchMessage = {
  type: "clear-batch";
  batchId: number;
};

export type MainToWorkerMessage =
  | InitMessage
  | LoadBatchMessage
  | RequestChunkMessage
  | ClearBatchMessage;

// Worker -> Main Thread
export type ReadyMessage = {
  type: "ready";
};

export type BatchProcessedMessage = {
  type: "batch-processed";
  batchId: number;
  tripCount: number;
};

export type ChunkResponseMessage = {
  type: "chunk-response";
  chunkIndex: number;
  trips: ProcessedTrip[];
};

export type RequestBatchMessage = {
  type: "request-batch";
  batchId: number;
};

export type ErrorMessage = {
  type: "error";
  message: string;
  context?: string;
};

export type WorkerToMainMessage =
  | ReadyMessage
  | BatchProcessedMessage
  | ChunkResponseMessage
  | RequestBatchMessage
  | ErrorMessage;
