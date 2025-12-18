// Builds Parquet files from Citi Bike CSV trip data with embedded route geometries.
//
// Usage: bun run build-parquet.ts
//
// Processes ALL CSV files in data/**/*.csv in a single pass, handling both
// legacy (2013-2019) and modern (2020+) schemas automatically.
//
// Prerequisites:
// - CSV files in data/**/*.csv
// - output/routes.db (from build-routes.ts)
// - apps/client/public/stations.json (from build-stations.ts)
//
// Output:
// - output/trips/<year>-<month>.parquet for each month with data
import { DuckDBConnection } from "@duckdb/node-api";
import { globSync } from "glob";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "path";
import { csvGlob, dataDir, formatHumanReadableBytes, gitRoot, NYC_BOUNDS, outputDir } from "./utils";

const routesDbPath = path.join(outputDir, "routes.db");

type ValidationResult = {
  total_rows: bigint;
  null_ride_id: bigint;
  null_start_station_name: bigint;
  null_end_station_name: bigint;
  null_started_at: bigint;
  null_ended_at: bigint;
  null_start_lat: bigint;
  null_start_lng: bigint;
  null_end_lat: bigint;
  null_end_lng: bigint;
  null_rideable_type: bigint;
  null_member_casual: bigint;
  unparseable_started_at: bigint;
  unparseable_ended_at: bigint;
  unparseable_start_lat: bigint;
  unparseable_start_lng: bigint;
  unparseable_end_lat: bigint;
  unparseable_end_lng: bigint;
  invalid_rideable_type: bigint;
  invalid_member_casual: bigint;
  end_before_start: bigint;
};

function printValidationWarnings(v: ValidationResult): void {
  const warnings: string[] = [];
  const total = Number(v.total_rows);

  const fmt = (count: bigint, msg: string) => {
    const pct = ((Number(count) / total) * 100).toFixed(2);
    return `${count} rows (${pct}%) with ${msg}`;
  };

  // NULL checks
  if (v.null_ride_id > 0) warnings.push(fmt(v.null_ride_id, "NULL ride_id"));
  if (v.null_start_station_name > 0) warnings.push(fmt(v.null_start_station_name, "NULL start_station_name"));
  if (v.null_end_station_name > 0) warnings.push(fmt(v.null_end_station_name, "NULL end_station_name"));
  if (v.null_started_at > 0) warnings.push(fmt(v.null_started_at, "NULL started_at"));
  if (v.null_ended_at > 0) warnings.push(fmt(v.null_ended_at, "NULL ended_at"));
  if (v.null_start_lat > 0) warnings.push(fmt(v.null_start_lat, "NULL start_lat"));
  if (v.null_start_lng > 0) warnings.push(fmt(v.null_start_lng, "NULL start_lng"));
  if (v.null_end_lat > 0) warnings.push(fmt(v.null_end_lat, "NULL end_lat"));
  if (v.null_end_lng > 0) warnings.push(fmt(v.null_end_lng, "NULL end_lng"));
  if (v.null_rideable_type > 0) warnings.push(fmt(v.null_rideable_type, "NULL rideable_type"));
  if (v.null_member_casual > 0) warnings.push(fmt(v.null_member_casual, "NULL member_casual"));

  // Type/parse checks
  if (v.unparseable_started_at > 0) warnings.push(fmt(v.unparseable_started_at, "unparseable started_at"));
  if (v.unparseable_ended_at > 0) warnings.push(fmt(v.unparseable_ended_at, "unparseable ended_at"));
  if (v.unparseable_start_lat > 0) warnings.push(fmt(v.unparseable_start_lat, "unparseable start_lat"));
  if (v.unparseable_start_lng > 0) warnings.push(fmt(v.unparseable_start_lng, "unparseable start_lng"));
  if (v.unparseable_end_lat > 0) warnings.push(fmt(v.unparseable_end_lat, "unparseable end_lat"));
  if (v.unparseable_end_lng > 0) warnings.push(fmt(v.unparseable_end_lng, "unparseable end_lng"));

  // Enum checks
  if (v.invalid_rideable_type > 0) warnings.push(fmt(v.invalid_rideable_type, "invalid rideable_type (must be 'classic_bike' or 'electric_bike')"));
  if (v.invalid_member_casual > 0) warnings.push(fmt(v.invalid_member_casual, "invalid member_casual (must be 'member' or 'casual')"));

  // Logic checks
  if (v.end_before_start > 0) warnings.push(fmt(v.end_before_start, "ended_at before started_at"));

  if (warnings.length > 0) {
    console.warn(`\nValidation warnings (rows will be dropped):\n  - ${warnings.join("\n  - ")}`);
  } else {
    console.log("No validation issues found.");
  }
}

async function main() {
  console.log("Starting parquet build (single-pass, all years)...");
  console.log(`Data directory: ${dataDir}`);
  console.log(`Output directory: ${outputDir}`);

  // Ensure output directories exist
  await mkdir(path.join(outputDir, "trips"), { recursive: true });

  const connection = await DuckDBConnection.create();

  // Configure DuckDB for large workloads - spill to disk instead of using 40GB RAM
  const tempDir = path.join(outputDir, "duckdb_tmp");
  await mkdir(tempDir, { recursive: true });
  await connection.run(`SET temp_directory = '${tempDir}'`);
  await connection.run(`SET memory_limit = '32GB'`);
  await connection.run(`SET preserve_insertion_order = false`);

  // 1. Load ALL data from all years using unified schema
  // Uses COALESCE to handle both legacy (2013-2019) and modern (2020+) schemas
  console.log(`\nReading CSVs matching: ${csvGlob}`);

  // Expand glob so we can report inputs deterministically
  const matchedCsvs = globSync(csvGlob, { nodir: true });
  if (matchedCsvs.length === 0) {
    throw new Error(`No CSV files matched: ${csvGlob}`);
  }

  let totalBytes = 0;
  for (const filePath of matchedCsvs) {
    totalBytes += (await stat(filePath)).size;
  }

  console.log(`Matched CSVs: ${matchedCsvs.length}`);
  console.log(matchedCsvs.map((p) => `- ${p}`).join("\n"));
  console.log(`Total input size: ${formatHumanReadableBytes(totalBytes)}`);

  const startTime = Date.now();

  // Unified schema handling:
  // - normalize_names=true converts "Start Station Name" -> start_station_name (merges with legacy)
  // - Legacy lowercase (2013-2018): starttime, start_station_name, usertype
  // - Legacy Title Case (2015-2016): start_time (normalized), start_station_name (merged), user_type
  // - Modern (2020+): started_at, start_station_name, member_casual
  console.log("Loading CSVs with unified schema...");
  await connection.run(`
    CREATE TEMP TABLE raw AS
    SELECT
      -- ID: use ride_id if present, else generate from legacy fields
      COALESCE(ride_id, md5(COALESCE(bikeid, bike_id)::VARCHAR || COALESCE(starttime, start_time::VARCHAR)::VARCHAR)) as ride_id,

      -- Bike type: use rideable_type if present, else 'classic_bike' for legacy
      COALESCE(rideable_type, 'classic_bike') as rideable_type,

      -- Timestamps: all columns are VARCHAR with all_varchar=true
      -- First COALESCE picks first non-null value, then parse
      COALESCE(
        TRY_CAST(started_at AS TIMESTAMP),
        TRY_CAST(start_time AS TIMESTAMP),
        TRY_CAST(starttime AS TIMESTAMP),
        TRY_STRPTIME(COALESCE(started_at, start_time, starttime), '%m/%d/%Y %H:%M:%S'),
        TRY_STRPTIME(COALESCE(started_at, start_time, starttime), '%m/%d/%Y %H:%M')
      ) as started_at,
      COALESCE(
        TRY_CAST(ended_at AS TIMESTAMP),
        TRY_CAST(stop_time AS TIMESTAMP),
        TRY_CAST(stoptime AS TIMESTAMP),
        TRY_STRPTIME(COALESCE(ended_at, stop_time, stoptime), '%m/%d/%Y %H:%M:%S'),
        TRY_STRPTIME(COALESCE(ended_at, stop_time, stoptime), '%m/%d/%Y %H:%M')
      ) as ended_at,

      -- Station names: normalize_names merges Title Case into snake_case
      start_station_name,
      end_station_name,

      -- Coordinates: all columns are VARCHAR with all_varchar=true
      TRY_CAST(COALESCE(start_lat, start_station_latitude) AS DOUBLE) as start_lat,
      TRY_CAST(COALESCE(start_lng, start_station_longitude) AS DOUBLE) as start_lng,
      TRY_CAST(COALESCE(end_lat, end_station_latitude) AS DOUBLE) as end_lat,
      TRY_CAST(COALESCE(end_lng, end_station_longitude) AS DOUBLE) as end_lng,

      -- Member type: normalize legacy 'Subscriber' -> 'member', 'Customer' -> 'casual'
      COALESCE(
        member_casual,
        CASE WHEN COALESCE(usertype, user_type) = 'Subscriber' THEN 'member' ELSE 'casual' END
      ) as member_casual

    FROM read_csv_auto('${csvGlob}', union_by_name=true, normalize_names=true, all_varchar=true, null_padding=true, quote='"')
  `);

  const loadTime = Date.now() - startTime;
  console.log(`Loaded CSVs into temp table in ${(loadTime / 1000).toFixed(1)}s`);

  // Pre-compute output month for efficient filtering
  // This avoids re-computing timezone conversion + string formatting for every row on every month iteration
  console.log("\nPre-computing output months...");
  const precomputeStart = Date.now();
  await connection.run(`
    ALTER TABLE raw ADD COLUMN output_month VARCHAR
  `);
  await connection.run(`
    UPDATE raw SET output_month = strftime(
      (started_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC',
      '%Y-%m'
    )
    WHERE started_at IS NOT NULL
  `);
  console.log("Creating index on output_month...");
  await connection.run(`
    CREATE INDEX idx_output_month ON raw(output_month)
  `);
  const precomputeTime = Date.now() - precomputeStart;
  console.log(`Pre-computed output months in ${(precomputeTime / 1000).toFixed(1)}s`);

  // 2. Validate data
  console.log("\nValidating data...");

  const validationReader = await connection.runAndReadAll(`
    SELECT
      -- NULL checks
      COUNT(*) FILTER (WHERE ride_id IS NULL) as null_ride_id,
      COUNT(*) FILTER (WHERE start_station_name IS NULL) as null_start_station_name,
      COUNT(*) FILTER (WHERE end_station_name IS NULL) as null_end_station_name,
      COUNT(*) FILTER (WHERE started_at IS NULL) as null_started_at,
      COUNT(*) FILTER (WHERE ended_at IS NULL) as null_ended_at,
      COUNT(*) FILTER (WHERE start_lat IS NULL) as null_start_lat,
      COUNT(*) FILTER (WHERE start_lng IS NULL) as null_start_lng,
      COUNT(*) FILTER (WHERE end_lat IS NULL) as null_end_lat,
      COUNT(*) FILTER (WHERE end_lng IS NULL) as null_end_lng,
      COUNT(*) FILTER (WHERE rideable_type IS NULL) as null_rideable_type,
      COUNT(*) FILTER (WHERE member_casual IS NULL) as null_member_casual,

      -- Type checks (TRY_CAST returns NULL if unparseable)
      COUNT(*) FILTER (WHERE TRY_CAST(started_at AS TIMESTAMP) IS NULL AND started_at IS NOT NULL) as unparseable_started_at,
      COUNT(*) FILTER (WHERE TRY_CAST(ended_at AS TIMESTAMP) IS NULL AND ended_at IS NOT NULL) as unparseable_ended_at,
      COUNT(*) FILTER (WHERE TRY_CAST(start_lat AS DOUBLE) IS NULL AND start_lat IS NOT NULL) as unparseable_start_lat,
      COUNT(*) FILTER (WHERE TRY_CAST(start_lng AS DOUBLE) IS NULL AND start_lng IS NOT NULL) as unparseable_start_lng,
      COUNT(*) FILTER (WHERE TRY_CAST(end_lat AS DOUBLE) IS NULL AND end_lat IS NOT NULL) as unparseable_end_lat,
      COUNT(*) FILTER (WHERE TRY_CAST(end_lng AS DOUBLE) IS NULL AND end_lng IS NOT NULL) as unparseable_end_lng,

      -- Enum checks
      COUNT(*) FILTER (WHERE rideable_type NOT IN ('classic_bike', 'electric_bike')) as invalid_rideable_type,
      COUNT(*) FILTER (WHERE member_casual NOT IN ('member', 'casual')) as invalid_member_casual,

      -- Logic checks
      COUNT(*) FILTER (WHERE ended_at < started_at) as end_before_start,

      -- Total
      COUNT(*) as total_rows
    FROM raw
  `);

  const validation = validationReader.getRowObjects()[0] as ValidationResult;
  console.log(`Total rows: ${validation.total_rows}`);

  // Check for duplicates
  const duplicateReader = await connection.runAndReadAll(`
    SELECT COUNT(*) as duplicate_count
    FROM (
      SELECT ride_id
      FROM raw
      GROUP BY ride_id
      HAVING COUNT(*) > 1
    )
  `);

  const duplicateCount = Number(
    (duplicateReader.getRowObjects()[0] as { duplicate_count: bigint }).duplicate_count
  );
  if (duplicateCount > 0) {
    const pct = ((duplicateCount / Number(validation.total_rows)) * 100).toFixed(2);
    console.warn(`\nWarning: ${duplicateCount} duplicate ride_ids (${pct}%) will be deduplicated`);
  }

  // Print validation warnings
  printValidationWarnings(validation);

  // 3. Load routes from SQLite into DuckDB
  console.log("\nLoading routes from SQLite...");
  if (!(await Bun.file(routesDbPath).exists())) {
    throw new Error(`routes.db not found at ${routesDbPath}. Run build-routes.ts first.`);
  }
  await connection.run(`
    INSTALL sqlite;
    LOAD sqlite;
  `);
  await connection.run(`
    CREATE TABLE routes AS
    SELECT * FROM sqlite_scan('${routesDbPath}', 'routes')
  `);
  const routeCountReader = await connection.runAndReadAll(`SELECT COUNT(*) as count FROM routes`);
  const routeCount = Number((routeCountReader.getRowObjects()[0] as { count: bigint }).count);
  console.log(`  ${routeCount} routes loaded`);

  // Load station data from stations.json for route matching
  // Routes are keyed by station NAME (not ID) because station IDs change between years
  const stationsJsonPath = path.join(gitRoot, "apps/client/public/stations.json");
  if (!(await Bun.file(stationsJsonPath).exists())) {
    console.warn(`stations.json not found - trips will have no routes`);
  } else {
    // Create name normalization lookup: maps any name (canonical OR alias) -> canonical name
    // This handles station names that changed over time (e.g., "8 Ave & W 31 St" -> "W 31 St & 8 Ave")
    console.log("\nLoading station name lookup from stations.json...");
    await connection.run(`
      CREATE TABLE station_name_lookup AS
      -- Canonical names map to themselves
      SELECT name as any_name, name as canonical_name
      FROM read_json_auto('${stationsJsonPath}')
      UNION ALL
      -- Aliases map to their canonical name
      SELECT UNNEST(aliases) as any_name, name as canonical_name
      FROM read_json_auto('${stationsJsonPath}')
    `);
    const lookupCountReader = await connection.runAndReadAll(`SELECT COUNT(*) as count FROM station_name_lookup`);
    const lookupCount = Number((lookupCountReader.getRowObjects()[0] as { count: bigint }).count);
    console.log(`  ${lookupCount} name mappings loaded (canonical + aliases)`);
  }

  // 4. Process year by year to avoid OOM
  const validRowFilter = `
    ride_id IS NOT NULL
    AND start_station_name IS NOT NULL
    AND end_station_name IS NOT NULL
    AND started_at IS NOT NULL
    AND ended_at IS NOT NULL
    AND start_lat IS NOT NULL
    AND start_lng IS NOT NULL
    AND end_lat IS NOT NULL
    AND end_lng IS NOT NULL
    AND rideable_type IN ('classic_bike', 'electric_bike')
    AND member_casual IN ('member', 'casual')
    AND ended_at >= started_at
    AND start_lat BETWEEN ${NYC_BOUNDS.minLat} AND ${NYC_BOUNDS.maxLat}
    AND start_lng BETWEEN ${NYC_BOUNDS.minLng} AND ${NYC_BOUNDS.maxLng}
    AND end_lat BETWEEN ${NYC_BOUNDS.minLat} AND ${NYC_BOUNDS.maxLat}
    AND end_lng BETWEEN ${NYC_BOUNDS.minLng} AND ${NYC_BOUNDS.maxLng}
  `;

  // Get distinct output months (uses pre-computed column)
  const monthsResult = await connection.runAndReadAll(`
    SELECT DISTINCT output_month as month
    FROM raw
    WHERE output_month IS NOT NULL
    ORDER BY month
  `);
  const months = monthsResult.getRowObjects() as Array<{ month: string }>;
  console.log(`\nFound ${months.length} months to process: ${months[0]?.month} to ${months[months.length - 1]?.month}`);

  let totalTripCount = 0;
  let totalWithRoute = 0;
  let totalParquetBytes = 0;

  for (let i = 0; i < months.length; i++) {
    const month = months[i]!.month;
    console.log(`\n[${i + 1}/${months.length}] Processing ${month}...`);
    const stepStart = Date.now();

    // Filter valid rows for this output month (uses pre-computed index)
    await connection.run(`
      CREATE TABLE filtered_month AS
      SELECT * FROM raw
      WHERE ${validRowFilter}
        AND output_month = '${month}'
    `);

    // Deduplicate by ride_id
    await connection.run(`
      CREATE TABLE deduped_month AS
      SELECT DISTINCT ON (ride_id) * FROM filtered_month
    `);

    // JOIN with routes
    await connection.run(`
      CREATE TABLE joined_month AS
      SELECT
        t.ride_id as id,
        COALESCE(snl_start.canonical_name, t.start_station_name) as startStationName,
        COALESCE(snl_end.canonical_name, t.end_station_name) as endStationName,
        (t.started_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' as startedAt,
        (t.ended_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' as endedAt,
        t.rideable_type as bikeType,
        t.member_casual as memberCasual,
        t.start_lat as startLat,
        t.start_lng as startLng,
        t.end_lat as endLat,
        t.end_lng as endLng,
        r.geometry as routeGeometry,
        r.distance as routeDistance
      FROM deduped_month t
      LEFT JOIN station_name_lookup snl_start
        ON t.start_station_name = snl_start.any_name
      LEFT JOIN station_name_lookup snl_end
        ON t.end_station_name = snl_end.any_name
      LEFT JOIN routes r
        ON r.start_station_name = COALESCE(snl_start.canonical_name, t.start_station_name)
        AND r.end_station_name = COALESCE(snl_end.canonical_name, t.end_station_name)
    `);

    // Get stats for this month
    const statsReader = await connection.runAndReadAll(`
      SELECT COUNT(*) as total, COUNT(routeGeometry) as with_route FROM joined_month
    `);
    const stats = statsReader.getRowObjects()[0] as { total: bigint; with_route: bigint };
    const monthTripCount = Number(stats.total);
    const monthWithRoute = Number(stats.with_route);
    totalTripCount += monthTripCount;
    totalWithRoute += monthWithRoute;

    // Export to parquet (only trips with routes - round trips and ferry crossings are excluded)
    const monthPath = path.join(outputDir, `trips/${month}.parquet`);
    await connection.run(`
      COPY (SELECT * FROM joined_month WHERE routeGeometry IS NOT NULL ORDER BY startedAt)
      TO '${monthPath}' (FORMAT PARQUET, COMPRESSION ZSTD)
    `);

    const monthStats = await stat(monthPath);
    totalParquetBytes += monthStats.size;
    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    console.log(`  ${monthTripCount} trips (${monthWithRoute} with routes) → ${(monthStats.size / 1024 / 1024).toFixed(1)} MB in ${elapsed}s`);
    console.log(`  → ${monthPath}`);

    // Clean up month tables before next iteration
    await connection.run(`DROP TABLE filtered_month`);
    await connection.run(`DROP TABLE deduped_month`);
    await connection.run(`DROP TABLE joined_month`);
  }

  // Final summary
  const totalWithoutRoute = totalTripCount - totalWithRoute;
  const droppedCount = Number(validation.total_rows) - totalTripCount;
  const droppedPct = ((droppedCount / Number(validation.total_rows)) * 100).toFixed(2);
  console.warn(`\nTotal data loss: ${droppedCount} rows (${droppedPct}%) dropped`);

  console.log(`\nTotal Parquet output: ${(totalParquetBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  ${totalTripCount} trips total`);
  console.log(`  ${totalWithRoute} with routes (${((totalWithRoute / totalTripCount) * 100).toFixed(1)}%)`);
  console.log(`  ${totalWithoutRoute} without routes`);

  connection.closeSync();

  // Clean up temp directory
  await rm(tempDir, { recursive: true, force: true });

  const totalTime = Date.now() - startTime;
  console.log(`\nDone in ${(totalTime / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
