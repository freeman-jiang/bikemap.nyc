import { DuckDBConnection } from "@duckdb/node-api";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import distance from "@turf/distance";
import { point } from "@turf/helpers";
import fs from "fs";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import path from "path";
import { csvGlob, dataDir, gitRoot, NYC_BOUNDS } from "./utils";

// Derive station data from raw CSV files + geocode with neighborhood boundaries.
// Clusters stations from ALL years by coordinates to create a unified station list
// with aliases for historical name lookups.
//
// Input:
// - data/**/*.csv (raw Citi Bike trip CSVs from all years)
// - data/d085e2f8d0b54d4590b1e7d1f35594c1pediacitiesnycneighborhoods.geojson
//
// Output:
// - apps/client/public/stations.json

// Distance threshold for clustering stations at same physical location
const CLUSTER_THRESHOLD_METERS = 60;

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
  aliases: string[]; // Historical names for search matching (excludes canonical name)
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

// Raw station data from CSV extraction (before clustering)
type RawStation = {
  name: string;
  latitude: number;
  longitude: number;
  year: number; // Year this name was observed (for canonical name selection)
};

// Cluster stations by coordinates (~50m threshold = same physical location)
// Returns merged stations with aliases
function clusterStationsByCoordinates(data: {
  stations: RawStation[];
  thresholdMeters: number;
}): Array<{
  canonicalName: string;
  aliases: string[];
  latitude: number;
  longitude: number;
}> {
  const { stations, thresholdMeters } = data;
  const clusters: Array<{
    names: Map<string, number>; // name -> latest year seen
    latSum: number;
    lngSum: number;
    count: number;
  }> = [];

  for (const station of stations) {
    // Find nearest cluster within threshold
    let nearestCluster: (typeof clusters)[number] | null = null;
    let nearestDist = Infinity;
    for (const cluster of clusters) {
      const clusterLat = cluster.latSum / cluster.count;
      const clusterLng = cluster.lngSum / cluster.count;
      const dist = distance(
        point([station.longitude, station.latitude]),
        point([clusterLng, clusterLat]),
        { units: "meters" }
      );
      if (dist < thresholdMeters && dist < nearestDist) {
        nearestCluster = cluster;
        nearestDist = dist;
      }
    }

    if (nearestCluster) {
      // Add to existing cluster
      const existingYear = nearestCluster.names.get(station.name);
      if (!existingYear || station.year > existingYear) {
        nearestCluster.names.set(station.name, station.year);
      }
      nearestCluster.latSum += station.latitude;
      nearestCluster.lngSum += station.longitude;
      nearestCluster.count++;
    } else {
      // Create new cluster
      const names = new Map<string, number>();
      names.set(station.name, station.year);
      clusters.push({
        names,
        latSum: station.latitude,
        lngSum: station.longitude,
        count: 1,
      });
    }
  }

  // Convert clusters to output format
  return clusters.map((cluster) => {
    // Pick canonical name: most recent year, then alphabetically
    const sortedNames = Array.from(cluster.names.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]; // Most recent year first
      return a[0].localeCompare(b[0]); // Alphabetically for ties
    });

    const canonicalName = sortedNames[0]![0];
    const aliases = sortedNames.slice(1).map(([name]) => name);

    return {
      canonicalName,
      aliases,
      latitude: cluster.latSum / cluster.count,
      longitude: cluster.lngSum / cluster.count,
    };
  });
}

async function main() {
  const clientPublicDir = path.join(gitRoot, "apps/client/public");
  const stationsPath = path.join(clientPublicDir, "stations.json");
  const geoJsonPath = path.join(
    dataDir,
    "d085e2f8d0b54d4590b1e7d1f35594c1pediacitiesnycneighborhoods.geojson"
  );

  console.log("Building stations.json from ALL CSV files (with aliases)...");
  console.log(`CSV glob: ${csvGlob}`);
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

  // Extract all unique stations from ALL years
  // Single CSV scan with union_by_name=true to merge both legacy and modern schemas
  console.log("\nLoading all CSVs (single scan)...");
  await connection.run(`
    CREATE TEMP TABLE raw_trips AS
    SELECT
      -- Modern columns
      start_station_name,
      end_station_name,
      start_lat,
      start_lng,
      end_lat,
      end_lng,
      started_at,
      ended_at,
      -- Legacy columns (with spaces)
      "start station name",
      "end station name",
      "start station latitude",
      "start station longitude",
      "end station latitude",
      "end station longitude",
      starttime,
      stoptime
    FROM read_csv_auto('${csvGlob}', union_by_name=true)
  `);

  // Validate data quality before processing
  console.log("Validating data...");
  const validationReader = await connection.runAndReadAll(`
    SELECT
      COUNT(*) as total_rows,

      -- Modern schema issues (has station name but missing/bad coords or timestamp)
      COUNT(*) FILTER (WHERE start_station_name IS NOT NULL AND TRY_CAST(start_lat AS DOUBLE) IS NULL) as null_modern_start_lat,
      COUNT(*) FILTER (WHERE start_station_name IS NOT NULL AND TRY_CAST(start_lng AS DOUBLE) IS NULL) as null_modern_start_lng,
      COUNT(*) FILTER (WHERE end_station_name IS NOT NULL AND TRY_CAST(end_lat AS DOUBLE) IS NULL) as null_modern_end_lat,
      COUNT(*) FILTER (WHERE end_station_name IS NOT NULL AND TRY_CAST(end_lng AS DOUBLE) IS NULL) as null_modern_end_lng,
      COUNT(*) FILTER (WHERE start_station_name IS NOT NULL AND TRY_CAST(started_at AS TIMESTAMP) IS NULL) as unparseable_started_at,
      COUNT(*) FILTER (WHERE end_station_name IS NOT NULL AND TRY_CAST(ended_at AS TIMESTAMP) IS NULL) as unparseable_ended_at,

      -- Legacy schema issues
      COUNT(*) FILTER (WHERE "start station name" IS NOT NULL AND TRY_CAST("start station latitude" AS DOUBLE) IS NULL) as null_legacy_start_lat,
      COUNT(*) FILTER (WHERE "start station name" IS NOT NULL AND TRY_CAST("start station longitude" AS DOUBLE) IS NULL) as null_legacy_start_lng,
      COUNT(*) FILTER (WHERE "end station name" IS NOT NULL AND TRY_CAST("end station latitude" AS DOUBLE) IS NULL) as null_legacy_end_lat,
      COUNT(*) FILTER (WHERE "end station name" IS NOT NULL AND TRY_CAST("end station longitude" AS DOUBLE) IS NULL) as null_legacy_end_lng,
      COUNT(*) FILTER (WHERE "start station name" IS NOT NULL AND TRY_CAST(starttime AS TIMESTAMP) IS NULL) as unparseable_starttime,
      COUNT(*) FILTER (WHERE "end station name" IS NOT NULL AND TRY_CAST(stoptime AS TIMESTAMP) IS NULL) as unparseable_stoptime
    FROM raw_trips
  `);

  type ValidationResult = {
    total_rows: bigint;
    null_modern_start_lat: bigint;
    null_modern_start_lng: bigint;
    null_modern_end_lat: bigint;
    null_modern_end_lng: bigint;
    unparseable_started_at: bigint;
    unparseable_ended_at: bigint;
    null_legacy_start_lat: bigint;
    null_legacy_start_lng: bigint;
    null_legacy_end_lat: bigint;
    null_legacy_end_lng: bigint;
    unparseable_starttime: bigint;
    unparseable_stoptime: bigint;
  };

  const v = validationReader.getRowObjects()[0] as ValidationResult;
  console.log(`Total rows: ${v.total_rows}`);

  const warnings: string[] = [];
  const total = Number(v.total_rows);
  const fmt = (count: bigint, msg: string) => {
    const pct = ((Number(count) / total) * 100).toFixed(2);
    return `${count} rows (${pct}%) with ${msg}`;
  };

  if (v.null_modern_start_lat > 0) warnings.push(fmt(v.null_modern_start_lat, "NULL start_lat (modern)"));
  if (v.null_modern_start_lng > 0) warnings.push(fmt(v.null_modern_start_lng, "NULL start_lng (modern)"));
  if (v.null_modern_end_lat > 0) warnings.push(fmt(v.null_modern_end_lat, "NULL end_lat (modern)"));
  if (v.null_modern_end_lng > 0) warnings.push(fmt(v.null_modern_end_lng, "NULL end_lng (modern)"));
  if (v.unparseable_started_at > 0) warnings.push(fmt(v.unparseable_started_at, "unparseable started_at (modern)"));
  if (v.unparseable_ended_at > 0) warnings.push(fmt(v.unparseable_ended_at, "unparseable ended_at (modern)"));
  if (v.null_legacy_start_lat > 0) warnings.push(fmt(v.null_legacy_start_lat, "NULL start_lat (legacy)"));
  if (v.null_legacy_start_lng > 0) warnings.push(fmt(v.null_legacy_start_lng, "NULL start_lng (legacy)"));
  if (v.null_legacy_end_lat > 0) warnings.push(fmt(v.null_legacy_end_lat, "NULL end_lat (legacy)"));
  if (v.null_legacy_end_lng > 0) warnings.push(fmt(v.null_legacy_end_lng, "NULL end_lng (legacy)"));
  if (v.unparseable_starttime > 0) warnings.push(fmt(v.unparseable_starttime, "unparseable starttime (legacy)"));
  if (v.unparseable_stoptime > 0) warnings.push(fmt(v.unparseable_stoptime, "unparseable stoptime (legacy)"));

  if (warnings.length > 0) {
    console.warn(`\nValidation warnings (rows will be skipped):\n  - ${warnings.join("\n  - ")}`);
  } else {
    console.log("No validation issues found.");
  }

  console.log("\nExtracting stations from temp table...");
  const stationsReader = await connection.runAndReadAll(`
    WITH all_stations AS (
      -- Start stations (modern)
      SELECT
        start_station_name AS name,
        start_lat AS lat,
        start_lng AS lng,
        EXTRACT(YEAR FROM TRY_CAST(started_at AS TIMESTAMP)) AS year
      FROM raw_trips
      WHERE start_station_name IS NOT NULL

      UNION ALL

      -- End stations (modern)
      SELECT
        end_station_name AS name,
        end_lat AS lat,
        end_lng AS lng,
        EXTRACT(YEAR FROM TRY_CAST(ended_at AS TIMESTAMP)) AS year
      FROM raw_trips
      WHERE end_station_name IS NOT NULL

      UNION ALL

      -- Start stations (legacy)
      SELECT
        "start station name" AS name,
        TRY_CAST("start station latitude" AS DOUBLE) AS lat,
        TRY_CAST("start station longitude" AS DOUBLE) AS lng,
        EXTRACT(YEAR FROM TRY_CAST(starttime AS TIMESTAMP)) AS year
      FROM raw_trips
      WHERE "start station name" IS NOT NULL

      UNION ALL

      -- End stations (legacy)
      SELECT
        "end station name" AS name,
        TRY_CAST("end station latitude" AS DOUBLE) AS lat,
        TRY_CAST("end station longitude" AS DOUBLE) AS lng,
        EXTRACT(YEAR FROM TRY_CAST(stoptime AS TIMESTAMP)) AS year
      FROM raw_trips
      WHERE "end station name" IS NOT NULL
    ),
    station_summary AS (
      SELECT
        name,
        MEDIAN(lat) AS latitude,
        MEDIAN(lng) AS longitude,
        MAX(year) AS max_year
      FROM all_stations
      WHERE lat IS NOT NULL AND lng IS NOT NULL
      GROUP BY name
    )
    SELECT name, latitude, longitude, max_year
    FROM station_summary
    ORDER BY name
  `);

  const rawRows = stationsReader.getRowObjectsJson() as unknown as Array<{
    name: string;
    latitude: number;
    longitude: number;
    max_year: number;
  }>;

  console.log(`  Found ${rawRows.length} unique station names across all years`);

  // Filter to NYC bounding box and convert to RawStation format
  const rawStations: RawStation[] = rawRows
    .filter((r) => {
      const inBounds =
        r.latitude >= NYC_BOUNDS.minLat &&
        r.latitude <= NYC_BOUNDS.maxLat &&
        r.longitude >= NYC_BOUNDS.minLng &&
        r.longitude <= NYC_BOUNDS.maxLng;
      if (!inBounds) {
        console.log(`  Filtered out: ${r.name} (${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)}) - outside NYC bounds`);
      }
      return inBounds;
    })
    .map((r) => ({
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      year: r.max_year,
    }));

  console.log(`  ${rawStations.length} stations within NYC bounds`);

  // Cluster by coordinates
  console.log(`\nClustering stations by coordinates (threshold: ${CLUSTER_THRESHOLD_METERS}m)...`);
  const clustered = clusterStationsByCoordinates({
    stations: rawStations,
    thresholdMeters: CLUSTER_THRESHOLD_METERS,
  });
  console.log(`  Merged into ${clustered.length} physical locations`);

  const totalAliases = clustered.reduce((sum, c) => sum + c.aliases.length, 0);
  console.log(`  Total aliases: ${totalAliases} (for search matching)`);

  // Geocode each station
  console.log("\nGeocoding stations...");
  let matched = 0;
  let unmatched = 0;

  const stations: StationForSearch[] = clustered.map((c) => {
    const region = getStationRegion(c.latitude, c.longitude, neighborhoods);
    if (region.borough === "Unknown") {
      unmatched++;
      console.warn(`  ⚠ Unmatched: ${c.canonicalName} (${c.latitude.toFixed(6)}, ${c.longitude.toFixed(6)})`);
    } else {
      matched++;
    }
    return {
      name: c.canonicalName,
      aliases: c.aliases,
      latitude: c.latitude,
      longitude: c.longitude,
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
