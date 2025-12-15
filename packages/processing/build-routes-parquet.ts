/**
 * Builds routes.parquet with pre-computed animation data.
 *
 * Prerequisites:
 * - output/trips/2025.parquet (from build-parquet.ts)
 * - apps/client/public/stations.json (from build-stations.ts)
 * - OSRM server running on localhost:5000
 *
 * Output:
 * - output/routes.parquet with: startStationId, endStationId, path, timeFractions, bearings, distance
 *
 * Resumable: Uses routes-checkpoint.duckdb to track progress. If interrupted,
 * re-run to continue from where it left off.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import polyline from "@mapbox/polyline";
import turfDistance from "@turf/distance";
import { point } from "@turf/helpers";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { formatHumanReadableBytes } from "../../apps/client/lib/utils";

const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();

const OSRM_URL = "http://localhost:5000";
const CONCURRENCY = 50;
const FLUSH_EVERY_N_BATCHES = 100; // Flush to disk every N batches (N * CONCURRENCY rows)

// Easing config (baked into routes at build time)
const EASE_DISTANCE_METERS = 300;
const EASE_TIME_MULTIPLIER = 2;
const BEARING_LOOK_AHEAD_METERS = 20;

const outputDir = path.join(gitRoot, "packages/processing/output");
const checkpointDbPath = path.join(outputDir, "routes-checkpoint.duckdb");

// Station format from build-stations.ts (grouped by name, multiple IDs)
type StationFromFile = {
  name: string;
  ids: string[];
  latitude: number;
  longitude: number;
  borough: string;
  neighborhood: string;
};

// Simplified station for our lookup map
type Station = {
  name: string;
  latitude: number;
  longitude: number;
};
type StationPair = { startStationId: string; endStationId: string };
type StationPairWithCoords = StationPair & {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
};
type ProcessedRoute = {
  startStationId: string;
  endStationId: string;
  path: [number, number][];
  timeFractions: number[];
  bearings: number[];
  distance: number;
};

// OSRM response schemas (following build-routes.ts pattern)
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

const OSRMResponseSchema = z.union([
  OSRMSuccessResponseSchema,
  OSRMErrorResponseSchema,
]);
type OSRMResponse = z.infer<typeof OSRMResponseSchema>;
type OSRMSuccessResponse = z.infer<typeof OSRMSuccessResponseSchema>;

function isOSRMSuccess(response: OSRMResponse): response is OSRMSuccessResponse {
  return response.code === "Ok";
}

// === Fail-fast helpers ===
function fail(msg: string): never {
  console.error(`\n❌ FATAL: ${msg}`);
  process.exit(1);
}

function loadStations(): Map<string, Station> {
  const clientPublicDir = path.join(gitRoot, "apps/client/public");
  const stationsPath = path.join(clientPublicDir, "stations.json");
  if (!fs.existsSync(stationsPath)) {
    fail(
      `stations.json not found at ${stationsPath}. Run build-stations.ts first.`
    );
  }
  const stationsFromFile: StationFromFile[] = JSON.parse(
    fs.readFileSync(stationsPath, "utf-8")
  );

  // Build map from each station ID to its coordinates
  const stationMap = new Map<string, Station>();
  for (const station of stationsFromFile) {
    for (const id of station.ids) {
      stationMap.set(id, {
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
      });
    }
  }
  return stationMap;
}

async function checkOSRM(): Promise<void> {
  try {
    const res = await fetch(
      `${OSRM_URL}/route/v1/bicycle/-73.99,40.73;-73.98,40.74`
    );
    if (!res.ok) fail(`OSRM test request failed: ${res.status}`);
    const json: unknown = await res.json();
    const parsed = OSRMResponseSchema.safeParse(json);
    if (!parsed.success) fail(`Invalid OSRM response: ${parsed.error.message}`);
    if (!isOSRMSuccess(parsed.data)) fail(`OSRM test failed: ${parsed.data.code}`);
  } catch {
    fail(`OSRM not reachable at ${OSRM_URL}. Start it first.`);
  }
}

// === Core computation (ported from worker) ===
function getTimeFraction(dist: number, totalDist: number): number {
  if (totalDist <= 0) return 0;
  const easeDist = Math.min(EASE_DISTANCE_METERS, totalDist / 4);
  const easeInEnd = easeDist;
  const easeOutStart = totalDist - easeDist;
  const linearDist = totalDist - 2 * easeDist;
  const easeInTime = EASE_TIME_MULTIPLIER * easeDist;
  const linearTime = linearDist;
  const totalTime = easeInTime + linearTime + easeInTime;

  if (dist < easeInEnd) {
    const t = dist / easeDist;
    return (Math.sqrt(t) * easeInTime) / totalTime;
  } else if (dist > easeOutStart) {
    const distIntoEaseOut = dist - easeOutStart;
    const t = Math.min(1, distIntoEaseOut / easeDist);
    const timeInEase = 1 - Math.sqrt(1 - t);
    return (easeInTime + linearTime + timeInEase * easeInTime) / totalTime;
  } else {
    return (easeInTime + (dist - easeInEnd)) / totalTime;
  }
}

function computeCumulativeDistances(coords: [number, number][]): number[] {
  const distances = [0];
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1]!;
    const curr = coords[i]!;
    const d = turfDistance(point(prev), point(curr), {
      units: "meters",
    });
    distances.push(distances[i - 1]! + d);
  }
  return distances;
}

function computeBearings(
  coords: [number, number][],
  cumDist: number[]
): number[] {
  const totalDist = cumDist[cumDist.length - 1] ?? 0;
  return coords.map((coord, i) => {
    const currentDist = cumDist[i] ?? 0;
    const lookAheadDist = Math.min(currentDist + BEARING_LOOK_AHEAD_METERS, totalDist);
    let laIdx = i;
    while (laIdx < cumDist.length - 1 && (cumDist[laIdx + 1] ?? 0) < lookAheadDist)
      laIdx++;
    const d0 = cumDist[laIdx] ?? 0;
    const d1 = cumDist[laIdx + 1] ?? d0;
    const frac = d1 > d0 ? (lookAheadDist - d0) / (d1 - d0) : 0;
    const p0 = coords[laIdx] ?? coord;
    const p1 = coords[laIdx + 1] ?? p0;
    const laX = p0[0] + frac * (p1[0] - p0[0]);
    const laY = p0[1] + frac * (p1[1] - p0[1]);
    return Math.atan2(laX - coord[0], laY - coord[1]) * (180 / Math.PI);
  });
}

async function fetchRoute(
  pair: StationPairWithCoords
): Promise<ProcessedRoute | null> {
  const url = `${OSRM_URL}/route/v1/bicycle/${pair.startLng},${pair.startLat};${pair.endLng},${pair.endLat}?geometries=polyline6&overview=full`;

  try {
    const res = await fetch(url);
    const json: unknown = await res.json();

    const parsed = OSRMResponseSchema.safeParse(json);
    if (!parsed.success) return null;
    if (!isOSRMSuccess(parsed.data)) return null;

    const route = parsed.data.routes[0]!; // min(1) guarantees at least one
    const decoded = polyline.decode(route.geometry, 6);
    const coords = decoded.map(([lat, lng]) => [lng, lat] as [number, number]);
    if (coords.length < 2) return null;

    const cumDist = computeCumulativeDistances(coords);
    const totalDist = cumDist[cumDist.length - 1] ?? 0;

    return {
      startStationId: pair.startStationId,
      endStationId: pair.endStationId,
      path: coords,
      timeFractions: cumDist.map((d) => getTimeFraction(d, totalDist)),
      bearings: computeBearings(coords, cumDist),
      distance: route.distance,
    };
  } catch {
    return null;
  }
}

async function main() {
  console.log("=== Build Routes Parquet ===\n");

  // 1. Load stations (fail fast if missing)
  console.log("Loading stations.json...");
  const stationMap = loadStations();
  console.log(`  ${stationMap.size} stations loaded`);

  // 2. Check OSRM is running (fail fast)
  console.log("Checking OSRM...");
  await checkOSRM();
  console.log("  OSRM OK");

  // 3. Open checkpoint database (persistent for resume)
  console.log("Opening checkpoint database...");
  fs.mkdirSync(outputDir, { recursive: true });
  const instance = await DuckDBInstance.create(checkpointDbPath);
  const db = await instance.connect();

  // Create routes table if not exists
  await db.run(`
    CREATE TABLE IF NOT EXISTS Route (
      startStationId VARCHAR,
      endStationId VARCHAR,
      path JSON,
      timeFractions JSON,
      bearings JSON,
      distance DOUBLE,
      PRIMARY KEY (startStationId, endStationId)
    )
  `);

  // 4. Load existing routes to skip (resume support)
  const existingReader = await db.runAndReadAll(`
    SELECT startStationId || '->' || endStationId as key FROM Route
  `);
  const existingRoutes = new Set(
    (existingReader.getRowObjects() as Array<{ key: string }>).map((r) => r.key)
  );
  console.log(`  ${existingRoutes.size} routes already cached`);

  // 5. Get unique station pairs from trips
  console.log("Reading station pairs from trips parquet...");
  const tripsPath = path.join(outputDir, "trips/2025.parquet");

  if (!fs.existsSync(tripsPath)) {
    fail(`trips parquet not found at ${tripsPath}. Run build-parquet.ts first.`);
  }

  const pairsReader = await db.runAndReadAll(`
    SELECT DISTINCT startStationId, endStationId
    FROM '${tripsPath}'
  `);
  const rawPairs = pairsReader.getRowObjects() as StationPair[];
  console.log(`  ${rawPairs.length} unique pairs total`);

  // 6. Resolve coordinates and filter out already-cached pairs
  console.log("Resolving station coordinates...");
  const pairs: StationPairWithCoords[] = [];
  for (const p of rawPairs) {
    const key = `${p.startStationId}->${p.endStationId}`;
    if (existingRoutes.has(key)) continue; // Skip already cached

    const start = stationMap.get(p.startStationId);
    const end = stationMap.get(p.endStationId);
    if (!start) fail(`Station not found: ${p.startStationId}`);
    if (!end) fail(`Station not found: ${p.endStationId}`);
    pairs.push({
      ...p,
      startLat: start.latitude,
      startLng: start.longitude,
      endLat: end.latitude,
      endLng: end.longitude,
    });
  }
  console.log(`  ${pairs.length} pairs remaining to fetch`);

  if (pairs.length === 0) {
    console.log("\nAll routes already cached!");
  } else {
    // 7. Fetch routes from OSRM using Appender for bulk inserts
    console.log("Fetching routes from OSRM...");

    const appender = await db.createAppender("Route");
    let success = 0,
      failed = 0;
    const startTime = Date.now();

    for (let i = 0; i < pairs.length; i += CONCURRENCY) {
      const batch = pairs.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(fetchRoute));

      // Append batch using Appender API
      for (const route of results) {
        if (route) {
          appender.appendVarchar(route.startStationId);
          appender.appendVarchar(route.endStationId);
          appender.appendVarchar(JSON.stringify(route.path));
          appender.appendVarchar(JSON.stringify(route.timeFractions));
          appender.appendVarchar(JSON.stringify(route.bearings));
          appender.appendDouble(route.distance);
          appender.endRow();
          success++;
        } else {
          failed++;
        }
      }
      // Flush every N batches for checkpoint durability
      const batchNum = i / CONCURRENCY;
      if (batchNum % FLUSH_EVERY_N_BATCHES === 0) {
        appender.flushSync();
      }

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (i + batch.length) / elapsed;
      const remaining = pairs.length - (i + batch.length);
      const eta = remaining / rate;
      const totalProcessed = existingRoutes.size + (i + batch.length);
      const totalPairs = rawPairs.length;
      const pct = ((totalProcessed / totalPairs) * 100).toFixed(1);

      process.stdout.write(
        `\r  [${pct}%] ${success} ok, ${failed} failed | ${rate.toFixed(0)}/s | ETA: ${(eta / 60).toFixed(1)}min`
      );
    }
    appender.closeSync(); // also flushes remaining rows
    console.log();

    if (failed > 0) console.warn(`⚠️  ${failed} routes failed (no OSRM path)`);
  }

  // 8. Export to parquet
  console.log("Writing routes.parquet...");
  const parquetPath = path.join(outputDir, "routes.parquet");
  await db.run(`
    COPY (SELECT * FROM Route) TO '${parquetPath}' (FORMAT PARQUET, COMPRESSION ZSTD)
  `);

  db.closeSync();

  const stats = fs.statSync(parquetPath);
  const totalRoutes = existingRoutes.size + pairs.length;
  console.log(
    `\n✅ Done: ${totalRoutes} routes (${formatHumanReadableBytes(stats.size)})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
