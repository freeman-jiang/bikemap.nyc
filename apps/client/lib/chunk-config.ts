// Chunking config - single source of truth
export const CHUNK_SIZE_SECONDS = 30;
export const BATCH_SIZE_SECONDS = 60 * 60; // 1 hour
export const CHUNKS_PER_BATCH = BATCH_SIZE_SECONDS / CHUNK_SIZE_SECONDS;

// Animation config
export const TRAIL_LENGTH_SECONDS = 45;
export const EASE_DISTANCE_METERS = 300;

// Prefetch config - start prefetching next batch at 80% through current batch
export const PREFETCH_THRESHOLD_CHUNKS = Math.floor(CHUNKS_PER_BATCH * 0.8);
