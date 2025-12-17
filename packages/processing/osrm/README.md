# NYC Bike Routing with OSRM

Bike-only routing for New York City using OSRM, with ferries excluded.

# Download OSM Data

OSM extracts for NewYork: https://download.bbbike.org/osm/bbbike/NewYork/
- Use Protocolbuffer (PBF) 142M

## Prerequisites

- Docker
- `NewYork.osm.pbf` (already downloaded)

## Setup

### 1. Extract

```bash
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-extract -p /data/bicycle-no-ferry.lua /data/NewYork.osm.pbf
```

### 2. Partition

```bash
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-partition /data/NewYork.osrm
```

### 3. Customize

```bash
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-customize /data/NewYork.osrm
```

### 4. Start Server

No need to repeat steps 1-3 unless you are making changes to the Lua profile.

```bash
docker run -t -i -p 5000:5000 -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-routed --algorithm mld /data/NewYork.osrm
```

#### With more CPU
```sh
docker run -t -i -p 5000:5000 \
  --cpus="10" \
  --memory="8g" \
  -v "${PWD}:/data" \
  ghcr.io/project-osrm/osrm-backend \
  osrm-routed --algorithm mld --threads 10 /data/NewYork.osrm \
  > /dev/null 2>&1
```

## Usage

The API runs on `http://localhost:5000`.

### Route Request

```
GET /route/v1/bike/{lon1},{lat1};{lon2},{lat2}
```

### Example

Brooklyn to Central Park:

```bash
curl "http://127.0.0.1:5000/route/v1/bike/-73.9857,40.6892;-73.9712,40.7831?overview=full"
```

### Query Parameters

| Parameter | Description |
|-----------|-------------|
| `overview` | `full`, `simplified`, or `false` - geometry detail level |
| `steps` | `true` or `false` - include turn-by-turn instructions |
| `geometries` | `polyline`, `polyline6`, or `geojson` - geometry format |
| `alternatives` | `true` or `false` - return alternative routes |

## Custom Profile

`bicycle-no-ferry.lua` is a modified OSRM bicycle profile with ferry routes disabled. This ensures all routes use bridges/tunnels only.

## All

```sh
# Step 1 - Extract (with updated profile)
  docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \
    osrm-extract -p /data/bicycle-no-ferry.lua /data/NewYork.osm.pbf

  # Step 2 - Partition
  docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \
    osrm-partition /data/NewYork.osrm

  # Step 3 - Customize
  docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \
    osrm-customize /data/NewYork.osrm

  # Step 4 - Restart the server
  docker run -t -i -p 5000:5000 -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \
    osrm-routed --algorithm mld /data/NewYork.osrm
```