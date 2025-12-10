import {
  getRidesStartingIn as getRidesInWindow,
  getTripsForChunk,
} from "@/app/server/trips";
import {
  BATCH_SIZE_SECONDS,
  CHUNK_SIZE_SECONDS,
  CHUNKS_PER_BATCH,
} from "@/lib/config";
import type {
  MainToWorkerMessage,
  ProcessedTrip,
  TripWithRoute,
  WorkerToMainMessage,
} from "@/lib/trip-types";

export interface TripDataServiceConfig {
  windowStartMs: number;
  animationStartDate: Date;
  fadeDurationSimSeconds: number;
}

/**
 * Service that manages trip data fetching and worker processing.
 *
 * Lifecycle: new TripDataService(config) → init() → use → terminate()
 * Stateless after init - if config changes, create a new instance.
 */
export class TripDataService {
  private readonly config: TripDataServiceConfig;

  // Worker state
  private worker: Worker | null = null;
  private pendingChunkRequests = new Map<
    number,
    (trips: ProcessedTrip[]) => void
  >();
  private loadedBatches = new Set<number>();
  private loadingBatches = new Set<number>();
  private batchProcessedCallbacks = new Map<
    number,
    { resolve: () => void; reject: (error: unknown) => void }[]
  >();

  constructor(config: TripDataServiceConfig) {
    this.config = config;
  }

  /**
   * Initialize the worker and load initial data.
   * Must be called before using other methods.
   */
  async init(): Promise<Map<string, ProcessedTrip>> {
    const { windowStartMs, fadeDurationSimSeconds } = this.config;

    console.log("Initializing trip data service...");

    // Create worker dynamically to avoid SSR issues
    this.worker = new Worker(
      new URL("../workers/trip-processor.worker.ts", import.meta.url),
      { type: "module" }
    );

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);

    // Wait for ready message
    await new Promise<void>((resolve) => {
      const handler = (event: MessageEvent<WorkerToMainMessage>) => {
        if (event.data.type === "ready") {
          this.worker?.removeEventListener("message", handler);
          resolve();
        }
      };
      this.worker?.addEventListener("message", handler);

      this.post({
        type: "init",
        windowStartMs,
        fadeDurationSimSeconds,
      });
    });

    // Load first batch
    await this.loadBatch(0);

    // Request initial chunks (0-2 for buffer)
    const tripMap = new Map<string, ProcessedTrip>();
    const initialChunks = [0, 1, 2];

    for (const chunkIndex of initialChunks) {
      const trips = await this.requestChunk(chunkIndex);
      for (const trip of trips) {
        tripMap.set(trip.id, trip);
      }
    }

    console.log(`Trip data service initialized: ${tripMap.size} trips loaded`);
    return tripMap;
  }

  /**
   * Request processed trips for a specific chunk index.
   */
  async requestChunk(chunkIndex: number): Promise<ProcessedTrip[]> {
    // Ensure the batch containing this chunk is loaded
    const batchId = Math.floor(chunkIndex / CHUNKS_PER_BATCH);

    if (!this.loadedBatches.has(batchId)) {
      await this.loadBatch(batchId);
    }

    return new Promise((resolve) => {
      this.pendingChunkRequests.set(chunkIndex, resolve);

      this.post({
        type: "request-chunk",
        chunkIndex,
      });
    });
  }

  /**
   * Prefetch a batch in the background.
   */
  prefetchBatch(batchId: number): void {
    if (!this.loadedBatches.has(batchId) && !this.loadingBatches.has(batchId)) {
      this.loadBatch(batchId).catch((err) => {
        console.error(`Prefetch batch ${batchId} failed:`, err);
      });
    }
  }

  /**
   * Clear a batch from worker memory.
   */
  clearBatch(batchId: number): void {
    if (this.loadedBatches.has(batchId)) {
      this.post({
        type: "clear-batch",
        batchId,
      });
      this.loadedBatches.delete(batchId);
    }
  }

  /**
   * Check if a batch is loaded.
   */
  isBatchLoaded(batchId: number): boolean {
    return this.loadedBatches.has(batchId);
  }

  /**
   * Terminate the worker and clean up resources.
   */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pendingChunkRequests.clear();
    this.batchProcessedCallbacks.clear();
    this.loadedBatches.clear();
    this.loadingBatches.clear();
  }

  // ===========================================================================
  // Private: Worker Communication
  // ===========================================================================

  private post(message: MainToWorkerMessage): void {
    this.worker?.postMessage(message);
  }

  private handleMessage(event: MessageEvent<WorkerToMainMessage>): void {
    const msg = event.data;

    switch (msg.type) {
      case "chunk-response": {
        const resolver = this.pendingChunkRequests.get(msg.chunkIndex);
        if (resolver) {
          resolver(msg.trips);
          this.pendingChunkRequests.delete(msg.chunkIndex);
        }
        break;
      }

      case "request-batch": {
        // Worker needs this batch - fetch from server
        this.loadBatch(msg.batchId);
        break;
      }

      case "batch-processed": {
        this.loadedBatches.add(msg.batchId);
        this.loadingBatches.delete(msg.batchId);
        console.log(`Batch ${msg.batchId} processed: ${msg.tripCount} trips`);

        // Resolve ALL waiting callbacks (supports concurrent waiters)
        const callbacks = this.batchProcessedCallbacks.get(msg.batchId);
        if (callbacks) {
          for (const { resolve } of callbacks) {
            resolve();
          }
          this.batchProcessedCallbacks.delete(msg.batchId);
        }
        break;
      }

      case "error": {
        console.error("Worker error:", msg.message, msg.context);
        break;
      }
    }
  }

  private handleError(error: ErrorEvent): void {
    console.error("Worker crashed:", error);
    // Reject all pending requests
    for (const [, resolver] of this.pendingChunkRequests) {
      resolver([]); // Return empty array on error
    }
    this.pendingChunkRequests.clear();
  }

  // ===========================================================================
  // Private: Batch Loading
  // ===========================================================================

  private async loadBatch(batchId: number): Promise<void> {
    if (this.loadedBatches.has(batchId)) {
      return; // Already loaded
    }

    // If already loading, add to waiters and return promise
    if (this.loadingBatches.has(batchId)) {
      return new Promise((resolve, reject) => {
        const callbacks = this.batchProcessedCallbacks.get(batchId) ?? [];
        callbacks.push({ resolve, reject });
        this.batchProcessedCallbacks.set(batchId, callbacks);
      });
    }

    this.loadingBatches.add(batchId);
    console.log(`Loading batch ${batchId}...`);

    try {
      // Fetch from server
      const trips = await this.fetchBatch(batchId);

      // Send to worker for processing
      this.post({
        type: "load-batch",
        batchId,
        trips,
      });

      // Wait for batch to be processed
      return new Promise((resolve, reject) => {
        const callbacks = this.batchProcessedCallbacks.get(batchId) ?? [];
        callbacks.push({ resolve, reject });
        this.batchProcessedCallbacks.set(batchId, callbacks);
      });
    } catch (error) {
      console.error(`Failed to load batch ${batchId}:`, error);
      this.loadingBatches.delete(batchId);

      // Reject all waiting callbacks
      const callbacks = this.batchProcessedCallbacks.get(batchId);
      if (callbacks) {
        for (const { reject } of callbacks) {
          reject(error);
        }
        this.batchProcessedCallbacks.delete(batchId);
      }

      throw error;
    }
  }

  private async fetchBatch(batchId: number): Promise<TripWithRoute[]> {
    const { windowStartMs, animationStartDate } = this.config;

    const batchStartMs = windowStartMs + batchId * BATCH_SIZE_SECONDS * 1000;
    const batchEndMs = batchStartMs + BATCH_SIZE_SECONDS * 1000;

    console.log(`Fetching batch ${batchId} from server...`);

    const data = await getRidesInWindow({
      from: new Date(batchStartMs),
      to: new Date(batchEndMs),
    });

    // For batch 0, also fetch trips already in progress at animation start
    if (batchId === 0) {
      const overlapData = await getTripsForChunk({
        chunkStart: animationStartDate,
        chunkEnd: new Date(windowStartMs + CHUNK_SIZE_SECONDS * 1000),
      });

      // Merge and dedupe by id
      const tripMap = new Map<string, TripWithRoute>();
      for (const trip of overlapData.trips) {
        tripMap.set(trip.id, trip);
      }
      for (const trip of data.trips) {
        tripMap.set(trip.id, trip);
      }

      console.log(
        `Batch 0: ${data.trips.length} starting + ${overlapData.trips.length} overlap = ${tripMap.size} unique`
      );
      return Array.from(tripMap.values());
    }

    return data.trips;
  }
}
