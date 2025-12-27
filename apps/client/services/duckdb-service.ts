import type { TripWithRoute } from "@/lib/trip-types";
import * as duckdb from "@duckdb/duckdb-wasm";

const TRIPS_BASE_URL = "https://bikemap.storage.googleapis.com";

/**
 * Get month key from a date (e.g., "2025-09")
 * Uses UTC to match parquet file naming convention
 */
function getMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Get the list of months that overlap with a date range
 * Uses UTC to match parquet file naming convention
 */
function getMonthsForRange(from: Date, to: Date): string[] {
  const months: string[] = [];
  const current = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));

  while (current <= end) {
    months.push(getMonthKey(current));
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return months;
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
    console.log("[DuckDB] Initializing...");
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
    const logger = new duckdb.ConsoleLogger();
    this.db = new duckdb.AsyncDuckDB(logger, worker);

    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    // Configure for partial HTTP reads (range requests)
    await this.db.open({
      path: ":memory:",
      filesystem: {
        forceFullHTTPReads: false,
        allowFullHTTPReads: false,
      },
    });
    console.log("[DuckDB] Configured filesystem for range requests");

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
   * Register monthly parquet files for a date range
   */
  private async registerMonthlyFiles(months: string[]): Promise<void> {
    const { db } = this.ensureInitialized();
    for (const month of months) {
      const filename = `${month}.parquet`;
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

    const months = getMonthsForRange(from, to);
    await this.registerMonthlyFiles(months);

    const files = months.map((m) => `'${m}.parquet'`).join(", ");
    console.log(`[DuckDB] getTripsInRange: ${from.toISOString()} to ${to.toISOString()} (files: ${months.join(", ")})`);
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
    // Since trips can be long, we look back further (e.g., a trip could start in previous month)
    const lookbackStart = new Date(chunkStart.getTime() - 24 * 60 * 60 * 1000); // 1 day lookback
    const months = getMonthsForRange(lookbackStart, chunkEnd);
    await this.registerMonthlyFiles(months);

    const files = months.map((m) => `'${m}.parquet'`).join(", ");
    console.log(`[DuckDB] getTripsOverlap: ${chunkStart.toISOString()} to ${chunkEnd.toISOString()} (files: ${months.join(", ")})`);
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

    const months = getMonthsForRange(windowStart, windowEnd);
    await this.registerMonthlyFiles(months);

    const files = months.map((m) => `'${m}.parquet'`).join(", ");

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
