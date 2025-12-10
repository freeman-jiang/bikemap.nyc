import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { Database } from "bun:sqlite";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import path from "node:path";

type StationRegion = {
  region: string;
  neighborhood: string;
};

type NeighborhoodProperties = {
  neighborhood: string;
  borough: string;
};

type NeighborhoodFeature = Feature<Polygon, NeighborhoodProperties>;

type Station = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};

// Get region for NJ stations (simple bounding box)
function getNJRegion(data: { lat: number; lng: number }): StationRegion | null {
  const { lat, lng } = data;

  // West of Hudson River = NJ
  if (lng < -74.02) {
    if (lat > 40.735) {
      return { region: "Hoboken", neighborhood: "Hoboken" };
    }
    return { region: "Jersey City", neighborhood: "Jersey City" };
  }

  return null;
}

// Get region for NYC stations (point-in-polygon)
function getNYCRegion(data: {
  lat: number;
  lng: number;
  neighborhoods: NeighborhoodFeature[];
}): StationRegion | null {
  const { lat, lng, neighborhoods } = data;
  const stationPoint = point([lng, lat]);

  for (const feature of neighborhoods) {
    if (booleanPointInPolygon(stationPoint, feature.geometry)) {
      return {
        region: feature.properties.borough,
        neighborhood: feature.properties.neighborhood,
      };
    }
  }

  return null;
}

// Get region for a station
function getStationRegion(data: {
  lat: number;
  lng: number;
  neighborhoods: NeighborhoodFeature[];
}): StationRegion {
  // Try NJ first (fast bounding box check)
  const njRegion = getNJRegion({ lat: data.lat, lng: data.lng });
  if (njRegion) return njRegion;

  // Try NYC (point-in-polygon)
  const nycRegion = getNYCRegion({
    lat: data.lat,
    lng: data.lng,
    neighborhoods: data.neighborhoods,
  });
  if (nycRegion) return nycRegion;

  // Fallback
  return { region: "Unknown", neighborhood: "Unknown" };
}

async function main() {
  const dataDir = path.join(process.cwd(), "../../data");
  const geoJsonPath = path.join(
    dataDir,
    "d085e2f8d0b54d4590b1e7d1f35594c1pediacitiesnycneighborhoods.geojson"
  );
  const outputPath = path.join(process.cwd(), "../../apps/client/public/station-regions.json");
  const dbPath = path.join(import.meta.dir, "../db/mydb.db");

  console.log("Loading neighborhood boundaries...");
  const geoData = (await Bun.file(geoJsonPath).json()) as FeatureCollection<
    Polygon,
    NeighborhoodProperties
  >;
  const neighborhoods = geoData.features;
  console.log(`Loaded ${neighborhoods.length} neighborhood polygons`);

  console.log("Loading stations from database...");
  const db = new Database(dbPath, { readonly: true });
  const stations = db.query("SELECT id, name, latitude, longitude FROM Station").all() as Station[];
  console.log(`Found ${stations.length} stations`);

  console.log("Geocoding stations...");
  const results: Record<string, StationRegion> = {};
  let matched = 0;
  let unmatched = 0;

  for (const station of stations) {
    const region = getStationRegion({
      lat: station.latitude,
      lng: station.longitude,
      neighborhoods,
    });

    results[station.id] = region;

    if (region.region === "Unknown") {
      unmatched++;
      console.log(`  ⚠ Unmatched: ${station.name} (${station.latitude}, ${station.longitude})`);
    } else {
      matched++;
    }
  }

  console.log(`\nResults: ${matched} matched, ${unmatched} unmatched`);

  // Write output
  await Bun.write(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nWritten to ${outputPath}`);

  db.close();
}

main();
