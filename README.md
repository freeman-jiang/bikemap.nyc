# bikemap.nyc

[bikemap.nyc](https://bikemap.nyc) is a GPU-accelerated visualization of [Citi Bike](https://citibikenyc.com), the largest bike-sharing system in the US.

[vid]

Each moving arrow represents a real bike ride, based on anonymized [historical system data](https://citibikenyc.com/system-data) published by Lyft.

## Features
- Visualizes 200M+ Citi Bike trips from 2013 to present
- Jump to any moment in history or search for a specific ride
- Full keyboard controls for playback and navigation

## How it works 

There is no backend. The client uses [DuckDB WASM](https://duckdb.org/docs/api/wasm/overview.html) to query parquet files using SQL directly from a CDN, downloading only the rows it needs via HTTP range requests.

### 1) Data processing pipeline

The [raw system data](https://citibikenyc.com/system-data) spans 12 years and has significant inconsistencies, making it difficult to use directly. The processing pipeline cleans and normalizes the data into optimized parquet files.

1. **Station clustering**: Creates a list of all unique station names and their coordinates.
2. **Route generation**: Queries [OSRM](https://project-osrm.org/) for bike routes between all station pairs. Geometries are cached per pair and stored as polyline6 in an intermediate SQLite database.
3. **Parquet export**: Generates a parquet file for each month by joining each trip with its corresponding route geometry.

### 2) Client application

This is what you see when you visit [bikemap.nyc](https://bikemap.nyc).

- **Data loading**: DuckDB WASM queries parquet files from the CDN using HTTP range requests. Trips load in 30-minute batches with lookahead prefetching.
- **Processing**: A Web Worker decodes the polyline6 geometry and pre-computes timestamps with easing so that bikes slow down at station endpoints.
- **Rendering**: Heavy lifting is done with deck.gl layers on top of Mapbox.
- **Search**: Natural language date parsing (chrono-node) lets you jump to any point in time or find a specific ride by querying the parquets directly.


## Quickstart

This project uses [Bun workspaces](https://bun.sh/docs/install/workspaces).

| Directory              | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `apps/client`          | Next.js frontend with deck.gl visualization      |
| `packages/processing`  | Data pipeline scripts (stations, routes, parquet)|

**1. Set up environment variables**

Copy `.env.example` to `.env` in `apps/client` and add your Mapbox token:

```sh
NEXT_PUBLIC_MAPBOX_TOKEN=pk.xxx  # Get one at https://mapbox.com
```

**2. Install dependencies and run**

```sh
bun install
bun dev
```

**Note:** The client queries parquet files from the official hosted CDN by default. You don't need to run the processing pipeline unless you want to regenerate the data. See the [processing README](packages/processing/README.md) for how to run the pipeline.

## Why

There is no economic value for this project except that I think it is cool and beautiful :)

I hope to keep this project free to use, but I am paying for Mapbox and hosting costs out of pocket. If you'd like to support me, please consider [buying me a coffee](https://buymeacoffee.com/freemanjiang)!
