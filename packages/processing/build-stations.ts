import { DuckDBConnection } from "@duckdb/node-api";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { execSync } from "child_process";
import fs from "fs";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import path from "path";

const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();

/**
 * Derive station data from trips Parquet + geocode with neighborhood boundaries.
 *
 * Input:
 * - `output/trips/*.parquet` (relative to this package cwd)
 *   Requires trips parquet to include:
 *   - startStationId, startStationName, startLat, startLng
 *   - endStationId, endStationName, endLat, endLng
 * - `../../data/d085e2f8d0b54d4590b1e7d1f35594c1pediacitiesnycneighborhoods.geojson`
 *   NYC neighborhood boundary polygons with { neighborhood, borough } properties.
 *
 * Output:
 * - `output/stations.json` with shape:
 *   Array<{ name, ids, latitude, longitude, borough, neighborhood }>
 *
 * Notes:
 * - We intentionally merge stations by NAME for search UX.
 * - Borough/neighborhood derived via point-in-polygon lookup.
 * - NJ stations use simple bounding box heuristic (west of Hudson).
 * - This is a derived artifact; regenerate whenever trips parquet changes.
 */

type NeighborhoodProperties = {
  neighborhood: string;
  borough: string;
};

type NeighborhoodFeature = Feature<Polygon, NeighborhoodProperties>;

type StationRegion = {
  borough: string;
  neighborhood: string;
};

type StationForSearch = {
  name: string;
  ids: string[];
  latitude: number;
  longitude: number;
  borough: string;
  neighborhood: string;
};

// Get region for NJ stations (simple bounding box)
function getNJRegion(lat: number, lng: number): StationRegion | null {
  // West of Hudson River = NJ
  if (lng < -74.02) {
    if (lat > 40.735) {
      return { borough: "New Jersey", neighborhood: "Hoboken" };
    }
    return { borough: "New Jersey", neighborhood: "Jersey City" };
  }
  return null;
}

// Get region for NYC stations (point-in-polygon)
function getNYCRegion(
  lat: number,
  lng: number,
  neighborhoods: NeighborhoodFeature[]
): StationRegion | null {
  const stationPoint = point([lng, lat]);

  for (const feature of neighborhoods) {
    if (booleanPointInPolygon(stationPoint, feature.geometry)) {
      return {
        borough: feature.properties.borough,
        neighborhood: feature.properties.neighborhood,
      };
    }
  }
  return null;
}

// Get region for a station
function getStationRegion(
  lat: number,
  lng: number,
  neighborhoods: NeighborhoodFeature[]
): StationRegion {
  // Try NJ first (fast bounding box check)
  const njRegion = getNJRegion(lat, lng);
  if (njRegion) return njRegion;

  // Try NYC (point-in-polygon)
  const nycRegion = getNYCRegion(lat, lng, neighborhoods);
  if (nycRegion) return nycRegion;

  return { borough: "Unknown", neighborhood: "Unknown" };
}

// Haversine distance in meters
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const WARN_COORD_VARIANCE_METERS = 200;

function checkStationCoordVariance(
  coordVariance: Array<{
    id: string;
    name: string;
    point_count: bigint;
    distinct_coords_6dp: bigint;
    coord1_lat: number;
    coord1_lng: number;
    coord2_lat: number;
    coord2_lng: number;
  }>
): void {
  const tooFar: Array<{ id: string; name: string; distance: number }> = [];

  for (const row of coordVariance) {
    const distance = haversineMeters(
      row.coord1_lat,
      row.coord1_lng,
      row.coord2_lat,
      row.coord2_lng
    );

    if (distance > WARN_COORD_VARIANCE_METERS) {
      tooFar.push({ id: row.id, name: row.name, distance });
    }
  }

  if (tooFar.length > 0) {
    console.warn(
      `\n⚠️  ${tooFar.length} station(s) have coordinate variance > ${WARN_COORD_VARIANCE_METERS}m:\n` +
        tooFar.map((s) => `  - ${s.id} "${s.name}" (${s.distance.toFixed(1)}m)`).join("\n")
    );
  }
}

async function main() {
  const outputDir = path.join(gitRoot, "packages/processing/output");
  const dataDir = path.join(gitRoot, "data");
  const clientPublicDir = path.join(gitRoot, "apps/client/public");
  const tripsGlob = path.join(outputDir, "trips/*.parquet");
  const stationsPath = path.join(clientPublicDir, "stations.json");
  const geoJsonPath = path.join(
    dataDir,
    "d085e2f8d0b54d4590b1e7d1f35594c1pediacitiesnycneighborhoods.geojson"
  );

  console.log("Building stations.json from trips parquet...");
  console.log(`Trips glob: ${tripsGlob}`);
  console.log(`GeoJSON: ${geoJsonPath}`);
  console.log(`Output: ${stationsPath}`);

  // Load neighborhood boundaries for geocoding
  console.log("\nLoading neighborhood boundaries...");
  const geoData = JSON.parse(fs.readFileSync(geoJsonPath, "utf-8")) as FeatureCollection<
    Polygon,
    NeighborhoodProperties
  >;
  const neighborhoods = geoData.features as NeighborhoodFeature[];
  console.log(`Loaded ${neighborhoods.length} neighborhood polygons`);

  const connection = await DuckDBConnection.create();

  // Diagnostics: show station IDs whose coordinates vary (these get averaged downstream).
  const stationCoordVarianceReader = await connection.runAndReadAll(`
    WITH station_points AS (
      SELECT
        startStationId AS id,
        startStationName AS name,
        startLat AS lat,
        startLng AS lng
      FROM read_parquet('${tripsGlob}')
      UNION ALL
      SELECT
        endStationId AS id,
        endStationName AS name,
        endLat AS lat,
        endLng AS lng
      FROM read_parquet('${tripsGlob}')
    ),
    station_name AS (
      -- Pick the most frequently observed name for each station id
      SELECT id, name
      FROM (
        SELECT
          id,
          name,
          COUNT(*) AS cnt,
          ROW_NUMBER() OVER (PARTITION BY id ORDER BY COUNT(*) DESC, name) AS rn
        FROM station_points
        WHERE id IS NOT NULL AND name IS NOT NULL
        GROUP BY id, name
      )
      WHERE rn = 1
    ),
    coord_counts AS (
      SELECT
        id,
        ROUND(lat, 6) AS lat6,
        ROUND(lng, 6) AS lng6,
        COUNT(*) AS cnt
      FROM station_points
      WHERE id IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL
      GROUP BY id, lat6, lng6
    ),
    ranked AS (
      SELECT
        id,
        lat6,
        lng6,
        cnt,
        ROW_NUMBER() OVER (PARTITION BY id ORDER BY cnt DESC, lat6, lng6) AS rn,
        SUM(cnt) OVER (PARTITION BY id) AS point_count,
        COUNT(*) OVER (PARTITION BY id) AS distinct_coords_6dp
      FROM coord_counts
    )
    SELECT
      id,
      COALESCE(MAX(station_name.name), '') AS name,
      MAX(point_count) AS point_count,
      MAX(distinct_coords_6dp) AS distinct_coords_6dp,
      MAX(CASE WHEN rn = 1 THEN lat6 END) AS coord1_lat,
      MAX(CASE WHEN rn = 1 THEN lng6 END) AS coord1_lng,
      MAX(CASE WHEN rn = 2 THEN lat6 END) AS coord2_lat,
      MAX(CASE WHEN rn = 2 THEN lng6 END) AS coord2_lng
    FROM ranked
    LEFT JOIN station_name USING (id)
    GROUP BY id
    HAVING MAX(distinct_coords_6dp) > 1
    ORDER BY MAX(distinct_coords_6dp) DESC, MAX(point_count) DESC
    LIMIT 20
  `);

  checkStationCoordVariance(
    stationCoordVarianceReader.getRowObjectsJson() as unknown as Array<{
      id: string;
      name: string;
      point_count: bigint;
      distinct_coords_6dp: bigint;
      coord1_lat: number;
      coord1_lng: number;
      coord2_lat: number;
      coord2_lng: number;
    }>
  );

  const stationsReader = await connection.runAndReadAll(`
    WITH station_points AS (
      SELECT
        startStationId AS id,
        startStationName AS name,
        startLat AS lat,
        startLng AS lng
      FROM read_parquet('${tripsGlob}')
      UNION ALL
      SELECT
        endStationId AS id,
        endStationName AS name,
        endLat AS lat,
        endLng AS lng
      FROM read_parquet('${tripsGlob}')
    ),
    -- Count occurrences of each coordinate (rounded to 5dp) per station name
    coord_counts AS (
      SELECT
        name,
        ROUND(lat, 5) AS lat5,
        ROUND(lng, 5) AS lng5,
        COUNT(*) AS cnt
      FROM station_points
      WHERE name IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL
      GROUP BY name, lat5, lng5
    ),
    -- Pick the most common coordinate for each station name
    most_common_coord AS (
      SELECT
        name,
        lat5 AS latitude,
        lng5 AS longitude
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY cnt DESC) AS rn
        FROM coord_counts
      )
      WHERE rn = 1
    ),
    -- Collect all IDs for each station name
    station_ids AS (
      SELECT
        name,
        STRING_AGG(DISTINCT id, ',') AS ids_csv
      FROM station_points
      WHERE name IS NOT NULL AND id IS NOT NULL
      GROUP BY name
    )
    SELECT
      mcc.name,
      si.ids_csv,
      mcc.latitude,
      mcc.longitude
    FROM most_common_coord mcc
    JOIN station_ids si ON mcc.name = si.name
    ORDER BY mcc.name
  `);

  const rows = stationsReader.getRowObjectsJson() as unknown as Array<{
    name: string;
    ids_csv: string;
    latitude: number;
    longitude: number;
  }>;

  // Geocode each station
  console.log("\nGeocoding stations...");
  let matched = 0;
  let unmatched = 0;

  const stations: StationForSearch[] = rows.map((r) => {
    const region = getStationRegion(r.latitude, r.longitude, neighborhoods);
    if (region.borough === "Unknown") {
      unmatched++;
      console.warn(`  ⚠ Unmatched: ${r.name} (${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)})`);
    } else {
      matched++;
    }
    return {
      name: r.name,
      ids: r.ids_csv.split(",").filter(Boolean),
      latitude: r.latitude,
      longitude: r.longitude,
      borough: region.borough,
      neighborhood: region.neighborhood,
    };
  });

  console.log(`Geocoded: ${matched} matched, ${unmatched} unmatched`);

  fs.writeFileSync(stationsPath, JSON.stringify(stations, null, 2));
  console.log(`\nWrote ${stations.length} stations to ${stationsPath}`);

  connection.closeSync();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
