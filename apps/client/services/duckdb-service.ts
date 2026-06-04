import { DATA_END_DATE, DATA_START_DATE } from "@/lib/config";
import type { TripWithRoute } from "@/lib/trip-types";
import * as duckdb from "@duckdb/duckdb-wasm";

const TRIPS_BASE_URL = "https://cdn.bikemap.nyc";

/**
 * Get day key from a date (e.g., "2025-09-15")
 * Uses UTC to match parquet file naming convention
 */
function getDayKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

// Valid data range boundaries (derived from config)
const DATA_START_DAY = getDayKey(DATA_START_DATE);
const DATA_END_DAY = getDayKey(DATA_END_DATE);

/**
 * Get the list of days that overlap with a date range
 * Uses UTC to match parquet file naming convention
 * Filters to only include days within the valid data range
 */
function getDaysForRange(from: Date, to: Date): string[] {
  const days: string[] = [];
  const current = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

  while (current <= end) {
    days.push(getDayKey(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  // Filter to valid data range (prevents loading non-existent parquet files)
  return days.filter((d) => d >= DATA_START_DAY && d <= DATA_END_DAY);
}

/**
 * DuckDB WASM service for querying Parquet files from GCS.
 * Uses an internal worker for non-blocking queries.
 */
class DuckDBService {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    const startTime = Date.now();

    // Use jsdelivr CDN bundles
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], {
        type: "text/javascript",
      })
    );

    const worker = new Worker(workerUrl);
    const noopLogger: duckdb.Logger = { log: () => {} };
    this.db = new duckdb.AsyncDuckDB(noopLogger, worker);

    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    // Configure for partial HTTP reads (range requests)
    await this.db.open({
      path: ":memory:",
      filesystem: {
        forceFullHTTPReads: false,
        allowFullHTTPReads: true,
        reliableHeadRequests: true
      },
    });

    this.conn = await this.db.connect();

    console.log(`[DuckDB] Initialized in ${Date.now() - startTime}ms`);
  }

  private ensureInitialized(): { conn: duckdb.AsyncDuckDBConnection; db: duckdb.AsyncDuckDB } {
    if (!this.conn || !this.db) {
      throw new Error("DuckDB not initialized. Call init() first.");
    }
    return { conn: this.conn, db: this.db };
  }

  /**
   * Register daily parquet files for a date range
   */
  private async registerDailyFiles(days: string[]): Promise<void> {
    const { db } = this.ensureInitialized();
    for (const day of days) {
      const filename = `${day}.parquet`;
      const url = `${TRIPS_BASE_URL}/parquets/${filename}`;
      await db.registerFileURL(filename, url, duckdb.DuckDBDataProtocol.HTTP, false);
    }
  }

  /**
   * Get trips that START within a time range (for progressive batch loading)
   */
  async getTripsInRange(params: { from: Date; to: Date }): Promise<TripWithRoute[]> {
    const { conn } = this.ensureInitialized();
    const { from, to } = params;

    const days = getDaysForRange(from, to);
    await this.registerDailyFiles(days);

    const files = days.map((d) => `'${d}.parquet'`).join(", ");
    console.log(`[DuckDB] getTripsInRange: ${from.toISOString()} to ${to.toISOString()} (files: ${days.length} days)`);
    const startTime = Date.now();

    const result = await conn.query(`
      SELECT
        id,
        startStationName,
        endStationName,
        startedAt,
        endedAt,
        bikeType,
        memberCasual,
        startLat,
        startLng,
        endLat,
        endLng,
        routeGeometry,
        routeDistance
      FROM read_parquet([${files}])
      WHERE startedAt >= epoch_ms(${from.getTime()})
        AND startedAt < epoch_ms(${to.getTime()})
      ORDER BY startedAt ASC
    `);

    const trips = this.transformResults(result);
    console.log(`[DuckDB] getTripsInRange completed in ${Date.now() - startTime}ms, ${trips.length} trips`);
    return trips;
  }

  /**
   * Get trips that OVERLAP with a time window (started before end, ended after start)
   * Used for loading trips already in progress at animation start
   */
  async getTripsOverlap(params: { chunkStart: Date; chunkEnd: Date }): Promise<TripWithRoute[]> {
    const { conn } = this.ensureInitialized();
    const { chunkStart, chunkEnd } = params;

    // For overlap queries, we need files that could contain trips starting before chunkEnd
    // 90 min lookback covers 99.92% of trips (P99.9 is 85 min with speed filters applied)
    const lookbackStart = new Date(chunkStart.getTime() - 90 * 60 * 1000); // 90 min lookback
    const days = getDaysForRange(lookbackStart, chunkEnd);
    await this.registerDailyFiles(days);

    const files = days.map((d) => `'${d}.parquet'`).join(", ");
    console.log(`[DuckDB] getTripsOverlap: ${chunkStart.toISOString()} to ${chunkEnd.toISOString()} (files: ${days.length} days)`);
    const startTime = Date.now();

    const result = await conn.query(`
      SELECT
        id,
        startStationName,
        endStationName,
        startedAt,
        endedAt,
        bikeType,
        memberCasual,
        startLat,
        startLng,
        endLat,
        endLng,
        routeGeometry,
        routeDistance
      FROM read_parquet([${files}])
      WHERE startedAt < epoch_ms(${chunkEnd.getTime()})
        AND endedAt > epoch_ms(${chunkStart.getTime()})
      ORDER BY startedAt ASC
    `);

    const trips = this.transformResults(result);
    console.log(`[DuckDB] getTripsOverlap completed in ${Date.now() - startTime}ms, ${trips.length} trips`);
    return trips;
  }

  /**
   * Get trips from a specific station within a time window (for search)
   * Now queries by station NAME since parquet is keyed by name
   */
  async getTripsFromStation(params: {
    startStationName: string;
    datetime: Date;
    intervalMs: number;
  }): Promise<TripWithRoute[]> {
    const { conn } = this.ensureInitialized();
    const { startStationName, datetime, intervalMs } = params;

    const windowStart = new Date(datetime.getTime() - intervalMs);
    const windowEnd = new Date(datetime.getTime() + intervalMs);

    const days = getDaysForRange(windowStart, windowEnd);
    await this.registerDailyFiles(days);

    const files = days.map((d) => `'${d}.parquet'`).join(", ");

    // Escape single quotes in station name
    const escapedName = startStationName.replace(/'/g, "''");

    const result = await conn.query(`
      SELECT
        id,
        startStationName,
        endStationName,
        startedAt,
        endedAt,
        bikeType,
        memberCasual,
        startLat,
        startLng,
        endLat,
        endLng,
        routeGeometry,
        routeDistance
      FROM read_parquet([${files}])
      WHERE startStationName = '${escapedName}'
        AND startedAt >= epoch_ms(${windowStart.getTime()})
        AND startedAt <= epoch_ms(${windowEnd.getTime()})
      ORDER BY startedAt ASC
    `);

    return this.transformResults(result);
  }

  /**
   * Transform DuckDB Arrow result to TripWithRoute[]
   */
  private transformResults(result: { toArray(): unknown[] }): TripWithRoute[] {
    const rows = result.toArray() as Array<{
      id: string;
      startStationName: string;
      endStationName: string;
      startedAt: bigint;
      endedAt: bigint;
      bikeType: string;
      memberCasual: string;
      startLat: number;
      startLng: number;
      endLat: number | null;
      endLng: number | null;
      routeGeometry: string | null;
      routeDistance: number | null;
    }>;

    return rows.map((row) => {
      // DuckDB WASM returns timestamps as BigInt milliseconds
      const startedAt = new Date(Number(row.startedAt));
      const endedAt = new Date(Number(row.endedAt));

      return {
        id: row.id,
        startStationName: row.startStationName,
        endStationName: row.endStationName,
        startedAt,
        endedAt,
        bikeType: row.bikeType,
        memberCasual: row.memberCasual,
        startLat: row.startLat,
        startLng: row.startLng,
        endLat: row.endLat,
        endLng: row.endLng,
        routeGeometry: row.routeGeometry,
        routeDistance: row.routeDistance,
      };
    });
  }

  terminate(): void {
    this.conn?.close();
    this.db?.terminate();
    this.conn = null;
    this.db = null;
    this.initPromise = null;
  }
}

// Singleton instance
export const duckdbService = new DuckDBService();
