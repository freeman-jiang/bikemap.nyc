// Builds routes.db (SQLite) with route geometries from OSRM.
//
// Prerequisites:
// - CSV files in data/**/*.csv (all years)
// - apps/client/public/stations.json (from build-stations.ts)
// - OSRM server running on localhost:5000
//
// Output:
// - output/routes.db (SQLite) with: start_station_id, end_station_id, geometry (polyline6), distance
//
// Resumable: If interrupted, re-run to continue from where it left off.
import { DuckDBConnection } from "@duckdb/node-api";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { csvGlob, gitRoot } from "./utils";

const OSRM_URL = "http://localhost:5000";
const CONCURRENCY = 50;
const WRITE_BATCH_SIZE = 5000;

const outputDir = path.join(gitRoot, "packages/processing/output");
const routesDbPath = path.join(outputDir, "routes.db");

// Station format from build-stations.ts
type StationFromFile = {
  name: string;
  ids: string[];
  latitude: number;
  longitude: number;
  borough: string;
  neighborhood: string;
};

type Station = {
  latitude: number;
  longitude: number;
};

type StationPair = {
  startStationId: string;
  endStationId: string;
};

type StationPairWithCoords = StationPair & {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
};

type Route = {
  startStationId: string;
  endStationId: string;
  geometry: string; // polyline6-encoded
  distance: number;
};

// OSRM response schemas
const OSRMSuccessResponseSchema = z.object({
  code: z.literal("Ok"),
  routes: z
    .array(
      z.object({
        geometry: z.string(),
        distance: z.number(),
      })
    )
    .min(1),
});

const OSRMErrorResponseSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
});

const OSRMResponseSchema = z.union([OSRMSuccessResponseSchema, OSRMErrorResponseSchema]);
type OSRMResponse = z.infer<typeof OSRMResponseSchema>;
type OSRMSuccessResponse = z.infer<typeof OSRMSuccessResponseSchema>;

function isOSRMSuccess(response: OSRMResponse): response is OSRMSuccessResponse {
  return response.code === "Ok";
}

function fail(msg: string): never {
  console.error(`\n❌ FATAL: ${msg}`);
  process.exit(1);
}

function loadStations(): Map<string, Station> {
  const stationsPath = path.join(gitRoot, "apps/client/public/stations.json");
  if (!fs.existsSync(stationsPath)) {
    fail(`stations.json not found at ${stationsPath}. Run build-stations.ts first.`);
  }
  const stationsFromFile: StationFromFile[] = JSON.parse(fs.readFileSync(stationsPath, "utf-8"));

  const stationMap = new Map<string, Station>();
  for (const station of stationsFromFile) {
    for (const id of station.ids) {
      stationMap.set(id, {
        latitude: station.latitude,
        longitude: station.longitude,
      });
    }
  }
  return stationMap;
}

async function checkOSRM(): Promise<void> {
  try {
    const res = await fetch(`${OSRM_URL}/route/v1/bicycle/-73.99,40.73;-73.98,40.74`);
    if (!res.ok) fail(`OSRM test request failed: ${res.status}`);
    const json: unknown = await res.json();
    const parsed = OSRMResponseSchema.safeParse(json);
    if (!parsed.success) fail(`Invalid OSRM response: ${parsed.error.message}`);
    if (!isOSRMSuccess(parsed.data)) fail(`OSRM test failed: ${parsed.data.code}`);
  } catch {
    fail(`OSRM not reachable at ${OSRM_URL}. Start it first.`);
  }
}

async function fetchRoute(pair: StationPairWithCoords): Promise<Route | null> {
  const url = `${OSRM_URL}/route/v1/bicycle/${pair.startLng},${pair.startLat};${pair.endLng},${pair.endLat}?geometries=polyline6&overview=full`;

  try {
    const res = await fetch(url);
    const json: unknown = await res.json();

    const parsed = OSRMResponseSchema.safeParse(json);
    if (!parsed.success) return null;
    if (!isOSRMSuccess(parsed.data)) return null;

    const route = parsed.data.routes[0]!;
    // OSRM returns polyline6-encoded geometry directly - store as-is
    // Client will decode to get [lat, lng] pairs
    if (!route.geometry) return null;

    return {
      startStationId: pair.startStationId,
      endStationId: pair.endStationId,
      geometry: route.geometry,
      distance: route.distance,
    };
  } catch {
    return null;
  }
}

async function getUniquePairsFromCSVs(): Promise<StationPair[]> {
  console.log(`Reading unique station pairs from CSVs using DuckDB...`);

  const connection = await DuckDBConnection.create();
  // Handle both modern (start_station_id) and legacy ("start station id") schemas
  // union_by_name=true merges different column schemas across CSV files
  const reader = await connection.runAndReadAll(`
    WITH all_pairs AS (
      -- Modern schema (2020+)
      SELECT DISTINCT
        start_station_id::VARCHAR AS startStationId,
        end_station_id::VARCHAR AS endStationId
      FROM read_csv_auto('${csvGlob}', union_by_name=true)
      WHERE start_station_id IS NOT NULL
        AND end_station_id IS NOT NULL
        AND start_station_id != end_station_id

      UNION

      -- Legacy schema (2013-2019)
      SELECT DISTINCT
        "start station id"::VARCHAR AS startStationId,
        "end station id"::VARCHAR AS endStationId
      FROM read_csv_auto('${csvGlob}', union_by_name=true)
      WHERE "start station id" IS NOT NULL
        AND "end station id" IS NOT NULL
        AND "start station id" != "end station id"
    )
    SELECT DISTINCT startStationId, endStationId FROM all_pairs
  `);

  const pairs = reader.getRowObjectsJson() as unknown as StationPair[];
  connection.closeSync();

  return pairs;
}

async function main() {
  console.log("=== Build Routes (SQLite) ===\n");

  // 1. Load stations
  console.log("Loading stations.json...");
  const stationMap = loadStations();
  console.log(`  ${stationMap.size} station IDs loaded`);

  // 2. Check OSRM
  console.log("Checking OSRM...");
  await checkOSRM();
  console.log("  OSRM OK");

  // 3. Open/create SQLite database
  console.log("Opening routes.db...");
  fs.mkdirSync(outputDir, { recursive: true });
  const db = new Database(routesDbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS routes (
      start_station_id TEXT NOT NULL,
      end_station_id TEXT NOT NULL,
      geometry TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (start_station_id, end_station_id)
    )
  `);

  // 4. Load existing routes for resume support
  const existingRoutes = new Set<string>();
  const existingRows = db.query("SELECT start_station_id || '->' || end_station_id as key FROM routes").all();
  for (const row of existingRows) {
    existingRoutes.add((row as { key: string }).key);
  }
  console.log(`  ${existingRoutes.size} routes already cached`);

  // 5. Get unique station pairs from CSVs
  const allPairs = await getUniquePairsFromCSVs();
  console.log(`  ${allPairs.length} unique pairs total`);

  // 6. Filter to pairs that need fetching
  const pairs: StationPairWithCoords[] = [];
  let missingStations = 0;

  for (const p of allPairs) {
    const key = `${p.startStationId}->${p.endStationId}`;
    if (existingRoutes.has(key)) continue;

    const start = stationMap.get(p.startStationId);
    const end = stationMap.get(p.endStationId);

    if (!start || !end) {
      missingStations++;
      continue;
    }

    pairs.push({
      ...p,
      startLat: start.latitude,
      startLng: start.longitude,
      endLat: end.latitude,
      endLng: end.longitude,
    });
  }

  if (missingStations > 0) {
    console.warn(`  ${missingStations} pairs skipped (station not in stations.json)`);
  }
  console.log(`  ${pairs.length} pairs to fetch`);

  if (pairs.length === 0) {
    console.log("\n✅ All routes already cached!");
    db.close();
    return;
  }

  // 7. Fetch routes from OSRM
  console.log("Fetching routes from OSRM...");

  const insertStmt = db.query(`
    INSERT OR REPLACE INTO routes (start_station_id, end_station_id, geometry, distance)
    VALUES ($startStationId, $endStationId, $geometry, $distance)
  `);

  let success = 0;
  let failed = 0;
  const startTime = Date.now();
  const pendingWrites: Route[] = [];

  const flushWrites = () => {
    if (pendingWrites.length === 0) return;
    db.transaction(() => {
      for (const route of pendingWrites) {
        insertStmt.run({
          $startStationId: route.startStationId,
          $endStationId: route.endStationId,
          $geometry: route.geometry,
          $distance: route.distance,
        });
      }
    })();
    pendingWrites.length = 0;
  };

  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const batch = pairs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchRoute));

    const validRoutes = results.filter((r): r is Route => r !== null);
    pendingWrites.push(...validRoutes);

    // Flush to SQLite when batch size reached
    if (pendingWrites.length >= WRITE_BATCH_SIZE) {
      flushWrites();
    }

    success += validRoutes.length;
    failed += results.length - validRoutes.length;

    // Progress
    const elapsed = (Date.now() - startTime) / 1000;
    const processed = i + batch.length;
    const rate = processed / elapsed;
    const remaining = pairs.length - processed;
    const eta = remaining / rate;
    const pct = (((existingRoutes.size + processed) / (existingRoutes.size + pairs.length)) * 100).toFixed(1);

    process.stdout.write(
      `\r  [${pct}%] ${success} ok, ${failed} failed | ${rate.toFixed(0)}/s | ETA: ${(eta / 60).toFixed(1)}min   `
    );
  }

  // Flush remaining writes
  flushWrites();

  console.log();

  if (failed > 0) {
    console.warn(`⚠️  ${failed} routes failed (no OSRM path)`);
  }

  // 8. Report final stats
  const countResult = db.query("SELECT COUNT(*) as count FROM routes").get() as { count: number };
  const dbStats = fs.statSync(routesDbPath);

  db.close();

  console.log(`\n✅ Done: ${countResult.count} routes (${(dbStats.size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
