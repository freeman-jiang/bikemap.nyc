# Processing Pipeline

Converts raw Citi Bike CSV data into optimized formats for the visualization client.

## Prerequisites

- [Bun](https://bun.sh/) v1.2.9+
- [Docker](https://www.docker.com/) (for OSRM routing server)
- [s5cmd](https://github.com/peak/s5cmd) (fast S3 client)

On Linux, ensure Docker daemon is running:

```bash
sudo systemctl start docker
```

## Setup

### 1. Download Citi Bike Trip Data

Download all historical trip data from the public S3 bucket (no credentials required):

```bash
mkdir -p data
s5cmd --no-sign-request cp 's3://tripdata/*.zip' data/
```

This downloads ~30GB of zip files covering 2013-present.

### 2. Download NYC Neighborhoods GeoJSON

Required for station geocoding (borough/neighborhood lookup):

```bash
cd data
wget -O d085e2f8d0b54d4590b1e7d1f35594c1pediacitiesnycneighborhoods.geojson \
  "https://data.dathere.com/dataset/acbbee9e-4e37-4439-8e69-ca906f476ae3/resource/d6db2e12-fc58-4e41-bc58-5bdfb5078131/download/d085e2f8d0b54d4590b1e7d1f35594c1pediacitiesnycneighborhoods.geojson"
cd ..
```

Source: [NYC Neighborhoods Dataset](https://data.dathere.com/dataset/nyc-neighborhoods)

### 3. Set Up OSRM Routing Server

The pipeline needs a local OSRM server for bike route calculations. See [`osrm/README.md`](osrm/README.md) for setup instructions.

Quick summary:
1. Download NYC OpenStreetMap data
2. Build routing graph with Docker
3. Start server on `localhost:5000`

## Data Flow

```
CSV files (all years) → build-stations.ts → stations.json
CSV files (all years) → build-routes.ts   → routes.db
CSV files (all years) → build-parquet.ts  → parquet files (per month)
```

## Scripts

Run in order:

```bash
# 0. Extract all .zip files (recursive)
bun run unzip-data.ts

# 1. Build unified station list with aliases (from ALL years)
bun run build-stations.ts

# 2. Build route cache from OSRM (requires OSRM server on localhost:5000)
bun run build-routes.ts

# 3. Build trips parquet with embedded route geometries (processes ALL years)
bun run build-parquet.ts
```

## Outputs

| File | Description |
|------|-------------|
| `apps/client/public/stations.json` | Station index with aliases, coordinates, borough/neighborhood |
| `output/routes.db` | SQLite cache of routes keyed by station NAME |
| `output/parquets/<year>-<month>.parquet` | Monthly trip data with embedded route geometry |

## How It Works

### Station Names as Universal Key

Routes are keyed by **station name** (not ID) because:
- Station IDs changed between years (e.g., `72` in 2018 → `6926.01` in 2025)
- Station names are unique (canonical name per physical location)

### Station Aliases

Station names changed over time (e.g., "8 Ave & W 31 St" → "W 31 St & 8 Ave"). The pipeline handles this via:

1. **`stations.json`** stores canonical name + historical aliases
2. **`build-routes.ts`** normalizes CSV names → canonical before creating route keys
3. **`build-parquet.ts`** normalizes CSV names → canonical before joining with routes

### Legacy vs Modern Schema

| Schema | Years | Detection | Route Matching |
|--------|-------|-----------|----------------|
| Legacy | 2013-2019 | Has `tripduration` column | Coordinate snap → nearest station name |
| Modern | 2020+ | Has `ride_id` column | CSV name → canonical name via alias lookup |

**Legacy coordinate matching:** Trip coordinates are matched to the nearest current station within 200m, giving ~98% route coverage despite old station names/IDs.

### DuckDB CSV Options

All scripts use these options to handle the diverse CSV schemas:

```sql
read_csv_auto('path/**/*.csv',
  union_by_name=true,     -- Merge columns by name across files
  normalize_names=true,   -- "Start Station Name" → start_station_name
  all_varchar=true,       -- Skip type detection, cast explicitly
  null_padding=true,      -- Handle rows with missing columns
  quote='"'               -- Handle quoted fields with commas
)
```

| Option | Purpose |
|--------|---------|
| `union_by_name` | Merge columns by name across files with different schemas |
| `normalize_names` | Case-insensitive column matching (Title Case → snake_case) |
| `all_varchar` | Avoid type mismatch errors in COALESCE by reading all as VARCHAR |
| `null_padding` | Handle rows with missing columns gracefully |
| `quote` | Parse quoted fields correctly (e.g., `"Industry City, Building 1 Basement"`) |

## Parquet Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | string | Trip ID |
| `startStationName` | string | Canonical station name |
| `endStationName` | string | Canonical station name |
| `startedAt` | timestamp | Trip start (UTC) |
| `endedAt` | timestamp | Trip end (UTC) |
| `bikeType` | string | `classic_bike` or `electric_bike` |
| `memberCasual` | string | `member` or `casual` |
| `startLat/Lng` | float | Start coordinates |
| `endLat/Lng` | float | End coordinates |
| `routeGeometry` | string | Polyline6-encoded route |
| `routeDistance` | float | Route distance in meters |

## Route Coverage

Trips without routes (round trips, ferry crossings) are filtered out at build time, so the parquet files contain only trips with valid route geometry.

| Year | Notes |
|------|-------|
| 2013-2019 | Coordinate-based matching to nearest station |
| 2020+ | Name-based matching with alias normalization |
