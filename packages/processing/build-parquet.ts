/**
 * Builds Parquet files from Citi Bike CSV trip data.
 *
 * CSV Assumptions:
 * - Located in ../../data/ matching *citibike-tripdata*.csv
 * - Required columns (exact names):
 *   ride_id, rideable_type, started_at, ended_at,
 *   start_station_name, start_station_id, end_station_name, end_station_id,
 *   start_lat, start_lng, end_lat, end_lng, member_casual
 *
 * Validation (warns and drops rows with):
 * - NULL in any required field
 * - Unparseable timestamp or coordinate
 * - Invalid rideable_type (must be 'classic_bike' or 'electric_bike')
 * - Invalid member_casual (must be 'member' or 'casual')
 * - ended_at < started_at (negative duration)
 * - Duplicate ride_id
 */
import { DuckDBConnection } from "@duckdb/node-api";
import fs from "fs";
import { globSync } from "glob";
import path from "path";
import { formatHumanReadableBytes } from "../../apps/client/lib/utils";

const dataDir = path.join(process.cwd(), "../../data");
const outputDir = path.join(process.cwd(), "output");

type ValidationResult = {
  total_rows: bigint;
  null_ride_id: bigint;
  null_start_station_id: bigint;
  null_end_station_id: bigint;
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
  if (v.null_start_station_id > 0) warnings.push(fmt(v.null_start_station_id, "NULL start_station_id"));
  if (v.null_end_station_id > 0) warnings.push(fmt(v.null_end_station_id, "NULL end_station_id"));
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
  console.log("Starting parquet build...");
  console.log(`Data directory: ${dataDir}`);
  console.log(`Output directory: ${outputDir}`);

  // Ensure output directories exist
  fs.mkdirSync(path.join(outputDir, "trips"), { recursive: true });

  const connection = await DuckDBConnection.create();

  // 1. Load ALL data without filtering (validation will catch issues)
  // Match all CSVs under `data/2025/` (including nested month folders)
  const csvGlob = path.join(dataDir, "2025/**/*.csv");
  console.log(`\nReading CSVs matching: ${csvGlob}`);

  // Expand glob so we can report inputs deterministically
  const matchedCsvs = globSync(csvGlob, { nodir: true });
  if (matchedCsvs.length === 0) {
    throw new Error(`No CSV files matched: ${csvGlob}`);
  }

  let totalBytes = 0;
  for (const filePath of matchedCsvs) {
    totalBytes += fs.statSync(filePath).size;
  }

  console.log(`Matched CSVs: ${matchedCsvs.length}`);
  console.log(matchedCsvs.map((p) => `- ${p}`).join("\n"));
  console.log(`Total input size: ${formatHumanReadableBytes(totalBytes)}`);

  const startTime = Date.now();

  await connection.run(`
    CREATE TEMP TABLE raw AS
    SELECT
      ride_id,
      rideable_type,
      started_at,
      ended_at,
      start_station_name,
      start_station_id,
      end_station_name,
      end_station_id,
      start_lat,
      start_lng,
      end_lat,
      end_lng,
      member_casual
    FROM read_csv_auto('${csvGlob}')
  `);

  const loadTime = Date.now() - startTime;
  console.log(`Loaded CSVs into temp table in ${(loadTime / 1000).toFixed(1)}s`);

  // 2. Validate data
  console.log("\nValidating data...");

  const validationReader = await connection.runAndReadAll(`
    SELECT
      -- NULL checks
      COUNT(*) FILTER (WHERE ride_id IS NULL) as null_ride_id,
      COUNT(*) FILTER (WHERE start_station_id IS NULL) as null_start_station_id,
      COUNT(*) FILTER (WHERE end_station_id IS NULL) as null_end_station_id,
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

  // 3. Export trips to Parquet (filtered and deduplicated)
  console.log("\nExporting trips to Parquet...");
  const parquetPath = path.join(outputDir, "trips/2025.parquet");

  // Filter condition for valid rows
  const validRowFilter = `
    ride_id IS NOT NULL
    AND start_station_id IS NOT NULL
    AND end_station_id IS NOT NULL
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
  `;

  await connection.run(`
    COPY (
      SELECT
        ride_id as id,
        start_station_id as startStationId,
        start_station_name as startStationName,
        end_station_id as endStationId,
        end_station_name as endStationName,
        started_at as startedAt,
        ended_at as endedAt,
        rideable_type as bikeType,
        member_casual as memberCasual,
        start_lat as startLat,
        start_lng as startLng,
        end_lat as endLat,
        end_lng as endLng
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY ride_id ORDER BY started_at) as rn
        FROM raw
        WHERE ${validRowFilter}
      )
      WHERE rn = 1
      ORDER BY started_at
    ) TO '${parquetPath}' (FORMAT PARQUET, COMPRESSION ZSTD)
  `);

  // Count exported rows and report data loss
  const exportedReader = await connection.runAndReadAll(
    `SELECT COUNT(*) as count FROM '${parquetPath}'`
  );
  const exportedCount = Number(
    (exportedReader.getRowObjects()[0] as { count: bigint }).count
  );
  const droppedCount = Number(validation.total_rows) - exportedCount;
  const droppedPct = ((droppedCount / Number(validation.total_rows)) * 100).toFixed(2);
  console.warn(`\nTotal data loss: ${droppedCount} rows (${droppedPct}%) dropped`);

  const parquetStats = fs.statSync(parquetPath);
  console.log(
    `Parquet file written: ${parquetPath} (${(parquetStats.size / 1024 / 1024).toFixed(1)} MB)`
  );

  connection.closeSync();

  const totalTime = Date.now() - startTime;
  console.log(`\nDone in ${(totalTime / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
