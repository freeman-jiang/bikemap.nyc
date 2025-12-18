// Builds routes.db (SQLite) with route geometries from OSRM.
//
// Prerequisites:
// - CSV files in data/**/*.csv (all years)
// - apps/client/public/stations.json (from build-stations.ts)
// - OSRM server running on localhost:5000
//
// Output:
// - output/routes.db (SQLite) with: start_station_name, end_station_name, geometry (polyline6), distance
//
// Routes are keyed by station NAME (not ID) because:
// - Station names are unique
// - Same physical route can have 6+ different ID combinations across years
// - Name-based keying gives fewer unique pairs to fetch from OSRM
//
// Resumable: If interrupted, re-run to continue from where it left off.
import { DuckDBConnection } from "@duckdb/node-api";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { csvGlob, gitRoot, outputDir } from "./utils";

const OSRM_URL = "http://localhost:5000";
const CONCURRENCY = 50;
const WRITE_BATCH_SIZE = 5000;

const routesDbPath = path.join(outputDir, "routes.db");

// Station format from build-stations.ts
type StationFromFile = {
  name: string;
  aliases: string[];
  latitude: number;
  longitude: number;
  borough: string;
  neighborhood: string;
};

type Station = {
  name: string;
  latitude: number;
  longitude: number;
};

type StationPair = {
  startStationName: string;
  endStationName: string;
};

type StationPairWithCoords = StationPair & {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
};

type Route = {
  startStationName: string;
  endStationName: string;
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

  // Map station name -> coordinates
  // Include both canonical names AND aliases so we can look up historical names from CSVs
  const stationMap = new Map<string, Station>();
  for (const station of stationsFromFile) {
    // Canonical name
    stationMap.set(station.name, {
      name: station.name,
      latitude: station.latitude,
      longitude: station.longitude,
    });
    // Also map aliases to same coordinates (for historical station names in CSVs)
    for (const alias of station.aliases ?? []) {
      stationMap.set(alias, {
        name: station.name, // Use canonical name for route key
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
      startStationName: pair.startStationName,
      endStationName: pair.endStationName,
      geometry: route.geometry,
      distance: route.distance,
    };
  } catch {
    return null;
  }
}

async function getUniquePairsFromCSVs(): Promise<StationPair[]> {
  console.log(`Reading unique station NAME pairs from CSVs using DuckDB...`);

  const connection = await DuckDBConnection.create();
  // Extract unique station NAME pairs (not IDs) from all years
  // Names are unique and stable across years, unlike IDs which change
  const reader = await connection.runAndReadAll(`
    WITH all_pairs AS (
      -- Modern schema (2020+)
      SELECT DISTINCT
        start_station_name AS startStationName,
        end_station_name AS endStationName
      FROM read_csv_auto('${csvGlob}', union_by_name=true)
      WHERE start_station_name IS NOT NULL
        AND end_station_name IS NOT NULL
        AND start_station_name != end_station_name

      UNION

      -- Legacy schema (2013-2019)
      SELECT DISTINCT
        "start station name" AS startStationName,
        "end station name" AS endStationName
      FROM read_csv_auto('${csvGlob}', union_by_name=true)
      WHERE "start station name" IS NOT NULL
        AND "end station name" IS NOT NULL
        AND "start station name" != "end station name"
    )
    SELECT DISTINCT startStationName, endStationName FROM all_pairs
  `);

  const pairs = reader.getRowObjectsJson() as unknown as StationPair[];
  connection.closeSync();

  return pairs;
}

async function main() {
  console.log("=== Build Routes (SQLite) ===\n");

  // 1. Load stations (keyed by name)
  console.log("Loading stations.json...");
  const stationMap = loadStations();
  console.log(`  ${stationMap.size} station names loaded`);

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
      start_station_name TEXT NOT NULL,
      end_station_name TEXT NOT NULL,
      geometry TEXT NOT NULL,
      distance REAL NOT NULL,
      PRIMARY KEY (start_station_name, end_station_name)
    )
  `);

  // 4. Load existing routes for resume support
  const existingRoutes = new Set<string>();
  const existingRows = db.query("SELECT start_station_name || '->' || end_station_name as key FROM routes").all();
  for (const row of existingRows) {
    existingRoutes.add((row as { key: string }).key);
  }
  console.log(`  ${existingRoutes.size} routes already cached`);

  // 5. Get unique station pairs from CSVs
  const allPairs = await getUniquePairsFromCSVs();
  console.log(`  ${allPairs.length} unique pairs total`);

  // 6. Filter to pairs that need fetching
  // CSV names may be aliases - we normalize to canonical names for route keys
  const pairs: StationPairWithCoords[] = [];
  const seenKeys = new Set<string>(); // Dedupe after canonical normalization
  let missingStations = 0;

  for (const p of allPairs) {
    const start = stationMap.get(p.startStationName);
    const end = stationMap.get(p.endStationName);

    if (!start || !end) {
      missingStations++;
      continue;
    }

    // Use canonical names (from station lookup) for route key
    // This normalizes aliases like "8 Ave & W 31 St" -> "W 31 St & 8 Ave"
    const canonicalStartName = start.name;
    const canonicalEndName = end.name;
    const key = `${canonicalStartName}->${canonicalEndName}`;

    // Skip if we've already seen this canonical pair or it exists in DB
    if (seenKeys.has(key) || existingRoutes.has(key)) continue;
    seenKeys.add(key);

    pairs.push({
      startStationName: canonicalStartName,
      endStationName: canonicalEndName,
      startLat: start.latitude,
      startLng: start.longitude,
      endLat: end.latitude,
      endLng: end.longitude,
    });
  }

  if (missingStations > 0) {
    console.warn(`  ${missingStations} pairs skipped (station name not in stations.json)`);
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
    INSERT OR REPLACE INTO routes (start_station_name, end_station_name, geometry, distance)
    VALUES ($startStationName, $endStationName, $geometry, $distance)
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
          $startStationName: route.startStationName,
          $endStationName: route.endStationName,
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
