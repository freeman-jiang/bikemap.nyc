// Shared types for trip processing between main thread and worker

import type { Trip } from "@bikemap/db";

// ============================================================================
// Trip Types (derived from Prisma)
// ============================================================================

// Trip + Route join (what the SQL query returns)
// Route type is defined inline since Prisma doesn't generate it (composite key)
export type TripWithRoute = Trip & {
  routeGeometry: string | null;
  routeDistance: number | null;
  routeDuration: number | null;
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
