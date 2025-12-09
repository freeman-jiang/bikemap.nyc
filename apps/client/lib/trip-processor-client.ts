import { CHUNKS_PER_BATCH } from "./chunk-config";
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from "./trip-processor-protocol";
import type { DeckTrip, RawTrip } from "./trip-types";

export class TripProcessorClient {
  private worker: Worker | null = null;
  private pendingChunkRequests = new Map<number, (trips: DeckTrip[]) => void>();
  private onBatchRequest: (batchId: number) => Promise<RawTrip[]>;
  private loadedBatches = new Set<number>();
  private loadingBatches = new Set<number>();
  private initPromise: Promise<void> | null = null;
  private batchProcessedCallbacks = new Map<number, () => void>();

  constructor(config: { onBatchRequest: (batchId: number) => Promise<RawTrip[]> }) {
    this.onBatchRequest = config.onBatchRequest;
  }

  async init(config: {
    windowStartMs: number;
    fadeDurationSimSeconds: number;
  }): Promise<void> {
    // Create worker dynamically to avoid SSR issues
    this.worker = new Worker(
      new URL("../workers/trip-processor.worker.ts", import.meta.url),
      { type: "module" }
    );

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);

    // Wait for ready message
    this.initPromise = new Promise<void>((resolve) => {
      const handler = (event: MessageEvent<WorkerToMainMessage>) => {
        if (event.data.type === "ready") {
          this.worker?.removeEventListener("message", handler);
          resolve();
        }
      };
      this.worker?.addEventListener("message", handler);

      this.post({
        type: "init",
        windowStartMs: config.windowStartMs,
        fadeDurationSimSeconds: config.fadeDurationSimSeconds,
      });
    });

    return this.initPromise;
  }

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

        // Resolve any waiting callbacks
        const callback = this.batchProcessedCallbacks.get(msg.batchId);
        if (callback) {
          callback();
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

  async loadBatch(batchId: number): Promise<void> {
    if (this.loadedBatches.has(batchId) || this.loadingBatches.has(batchId)) {
      // If already loading, wait for it
      if (this.loadingBatches.has(batchId)) {
        return new Promise((resolve) => {
          this.batchProcessedCallbacks.set(batchId, resolve);
        });
      }
      return;
    }

    this.loadingBatches.add(batchId);
    console.log(`Loading batch ${batchId}...`);

    try {
      // Fetch from server via callback
      const trips = await this.onBatchRequest(batchId);

      // Send to worker for processing
      this.post({
        type: "load-batch",
        batchId,
        trips,
      });

      // Wait for batch to be processed
      return new Promise((resolve) => {
        this.batchProcessedCallbacks.set(batchId, resolve);
      });
    } catch (error) {
      console.error(`Failed to load batch ${batchId}:`, error);
      this.loadingBatches.delete(batchId);
      throw error;
    }
  }

  async requestChunk(chunkIndex: number): Promise<DeckTrip[]> {
    // Ensure the batch containing this chunk is loaded
    const batchId = Math.floor(chunkIndex / CHUNKS_PER_BATCH);

    if (!this.loadedBatches.has(batchId)) {
      // Wait for batch to load if needed
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

  prefetchBatch(batchId: number): void {
    if (!this.loadedBatches.has(batchId) && !this.loadingBatches.has(batchId)) {
      this.loadBatch(batchId).catch((err) => {
        console.error(`Prefetch batch ${batchId} failed:`, err);
      });
    }
  }

  clearBatch(batchId: number): void {
    if (this.loadedBatches.has(batchId)) {
      this.post({
        type: "clear-batch",
        batchId,
      });
      this.loadedBatches.delete(batchId);
    }
  }

  isBatchLoaded(batchId: number): boolean {
    return this.loadedBatches.has(batchId);
  }

  updateConfig(config: {
    windowStartMs?: number;
    fadeDurationSimSeconds?: number;
  }): void {
    this.post({
      type: "update-config",
      ...config,
    });
  }

  reset(): void {
    // Clear all state
    this.loadedBatches.clear();
    this.loadingBatches.clear();
    this.pendingChunkRequests.clear();
    this.batchProcessedCallbacks.clear();
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pendingChunkRequests.clear();
    this.batchProcessedCallbacks.clear();
  }
}
