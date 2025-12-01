"use client";

import { getActiveRides } from "@/app/server/trips";
import { getColorFromBikeType } from "@/utils/map";
import polyline from "@mapbox/polyline";
import along from "@turf/along";
import bearing from "@turf/bearing";
import { lineString } from "@turf/helpers";
import length from "@turf/length";
import type { GeoJSONSource } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Map, { Layer, Source, useMap } from "react-map-gl/mapbox";

// Infer types from server function
type TripsResponse = Awaited<ReturnType<typeof getActiveRides>>;
type Trip = TripsResponse["trips"][number];

type AnimationState = "idle" | "playing" | "finished";

type PreparedTrip = {
  id: string;
  color: string;
  startTime: number; // ms offset from animation window start
  endTime: number;
  startProgress: number; // 0-1, where on route the bike starts (for clipped trips)
  endProgress: number; // 0-1, where on route the bike ends (for clipped trips)
  line: GeoJSON.Feature<GeoJSON.LineString>; // turf lineString for interpolation
  totalDistance: number; // in meters
  currentBearing: number; // Current bearing for smooth rotation (mutable)
};

// Animation plays at 150x speed (e.g., 2 hours plays in ~48 seconds)
const SPEEDUP = 150;

// Fade duration for start/end animations (in real time)
const FADE_DURATION_MS = 700;

// Color transition duration after fade-in (in real time)
const TRANSITION_DURATION_MS = 700;

// Interpolate between two angles, handling 360°/0° wrapping
function interpolateAngle(from: number, to: number, factor: number): number {
  // Normalize angles to 0-360
  from = ((from % 360) + 360) % 360;
  to = ((to % 360) + 360) % 360;

  // Calculate shortest distance
  let diff = to - from;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;

  // Interpolate
  let result = from + diff * factor;
  return ((result % 360) + 360) % 360;
}

// Ease-in at start, linear middle, ease-out at end
function easeInOutEdges(t: number, edgePercent: number = 0.1): number {
  const e = edgePercent;

  if (t < e) {
    // Ease-in: quadratic acceleration from 0 to linear speed
    return (t * t) / (2 * e * (1 - e));
  } else if (t > 1 - e) {
    // Ease-out: quadratic deceleration from linear speed to 0
    return 1 - ((1 - t) * (1 - t)) / (2 * e * (1 - e));
  } else {
    // Linear middle at constant speed
    const positionAtE = e / (2 * (1 - e));
    const slope = 1 / (1 - e);
    return positionAtE + slope * (t - e);
  }
}

function prepareTrips(data: {
  trips: Trip[];
  windowStartMs: number;
  windowEndMs: number;
}): PreparedTrip[] {
  const { trips, windowStartMs, windowEndMs } = data;
  const windowDuration = windowEndMs - windowStartMs;

  return trips
    .filter((trip): trip is Trip & { routeGeometry: string } =>
      trip.routeGeometry !== null &&
      trip.startStationId !== trip.endStationId
    )
    .map((trip) => {
      // Decode polyline6 - returns [lat, lng][], flip to [lng, lat]
      const decoded = polyline.decode(trip.routeGeometry, 6);
      const coordinates = decoded.map(
        ([lat, lng]) => [lng, lat] as [number, number]
      );

      // Create turf lineString and compute total distance
      const line = lineString(coordinates);
      const totalDistance = length(line, { units: "meters" });
    


      // Normalize times relative to window start (0 to windowDuration)
      const tripStartMs = new Date(trip.startedAt).getTime();
      const tripEndMs = new Date(trip.endedAt).getTime();

      // Calculate implied speed and filter unrealistic trips
      const tripDurationHours = (tripEndMs - tripStartMs) / (1000 * 60 * 60);
      const speedKmh = totalDistance / 1000 / tripDurationHours;

      // Skip trips faster than 25 km/h (unrealistic for bikes)
      if (speedKmh > 25 || speedKmh < 0.25) return null;

      // Calculate where on the route the bike should be at window boundaries
      // For trips that start before or end after the window
      const tripDurationMs = tripEndMs - tripStartMs;
      const startProgress = Math.max(0, (windowStartMs - tripStartMs) / tripDurationMs);
      const endProgress = Math.min(1, (windowEndMs - tripEndMs + tripDurationMs) / tripDurationMs);

      // Convert durations to simulation time
      const fadeDurationSim = (FADE_DURATION_MS / 1000) * SPEEDUP * 1000;
      const transitionDurationSim = (TRANSITION_DURATION_MS / 1000) * SPEEDUP * 1000;

      // Calculate initial bearing from the start of the route
      const startPoint = along(line, startProgress * totalDistance, { units: "meters" });
      const lookAhead = Math.min(100, totalDistance - startProgress * totalDistance);
      const nextPoint = along(line, startProgress * totalDistance + lookAhead, { units: "meters" });
      const initialBearing = bearing(startPoint, nextPoint);

      return {
        id: trip.id,
        color: getColorFromBikeType(trip.rideableType),
        startTime: Math.max(0, tripStartMs - windowStartMs) - fadeDurationSim - transitionDurationSim,
        endTime: Math.min(windowDuration, tripEndMs - windowStartMs) + fadeDurationSim,
        startProgress,
        endProgress,
        line,
        totalDistance,
        currentBearing: initialBearing,
      };
    })
    .filter((trip): trip is PreparedTrip => trip !== null);
}

const EMPTY_GEOJSON: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function AnimationController(props: {
  preparedTrips: PreparedTrip[];
  windowDurationMs: number;
  animationDurationMs: number;
}) {
  const { preparedTrips, windowDurationMs, animationDurationMs } = props;
  const { current: mapRef } = useMap();
  const [animState, setAnimState] = useState<AnimationState>("idle");

  const animationRef = useRef<{
    rafId: number | null;
    startTimestamp: number | null;
  }>({ rafId: null, startTimestamp: null });

  const animateFnRef = useRef<((timestamp: number) => void) | null>(null);

  // Store animate function in ref to avoid circular dependency
  useEffect(() => {
    animateFnRef.current = (timestamp: number) => {
      const map = mapRef?.getMap();
      if (!map) return;

      const ref = animationRef.current;
      if (ref.startTimestamp === null) {
        ref.startTimestamp = timestamp;
      }

      const elapsedReal = timestamp - ref.startTimestamp;
      // Map real time to simulation time using ratio
      const simulationTime =
        (elapsedReal / animationDurationMs) * windowDurationMs;

      // Check if animation finished
      if (simulationTime >= windowDurationMs) {
        setAnimState("finished");
        const source = map.getSource("riders") as GeoJSONSource | undefined;
        if (source) {
          source.setData(EMPTY_GEOJSON);
        }
        ref.rafId = null;
        return;
      }

      // Build features for active trips
      const features: GeoJSON.Feature[] = [];
      const fadeDurationSim = (FADE_DURATION_MS / 1000) * SPEEDUP * 1000;
      const transitionDurationSim = (TRANSITION_DURATION_MS / 1000) * SPEEDUP * 1000;

      for (const trip of preparedTrips) {
        if (simulationTime < trip.startTime || simulationTime > trip.endTime) {
          continue;
        }

        // Calculate phase boundaries
        const fadeInEnd = trip.startTime + fadeDurationSim;
        const transitionInEnd = fadeInEnd + transitionDurationSim;
        const fadeOutStart = trip.endTime - fadeDurationSim;

        // Determine phase and phase progress
        let phase: string;
        let phaseProgress: number;

        if (simulationTime < fadeInEnd) {
          phase = "fading-in";
          phaseProgress = (simulationTime - trip.startTime) / fadeDurationSim;
        } else if (simulationTime < transitionInEnd) {
          phase = "transitioning-in";
          phaseProgress = (simulationTime - fadeInEnd) / transitionDurationSim;
        } else if (simulationTime > fadeOutStart) {
          phase = "fading-out";
          phaseProgress = (simulationTime - fadeOutStart) / fadeDurationSim;
        } else {
          phase = "moving";
          phaseProgress = 1;
        }

        // Calculate position based on phase
        let routeProgress: number;
        if (phase === "fading-in") {
          routeProgress = trip.startProgress; // Stationary at start
        } else if (phase === "fading-out") {
          routeProgress = trip.endProgress; // Stationary at end
        } else {
          // Moving during transitioning-in, moving, and transitioning-out
          const movingStart = fadeInEnd;
          const movingEnd = fadeOutStart;
          const movingDuration = movingEnd - movingStart;
          const movingProgress = (simulationTime - movingStart) / movingDuration;
          const easedProgress = easeInOutEdges(movingProgress);
          routeProgress =
            trip.startProgress +
            easedProgress * (trip.endProgress - trip.startProgress);
        }

        // Use turf's along() to get point at distance along the line
        const distanceAlongRoute = routeProgress * trip.totalDistance;
        const point = along(trip.line, distanceAlongRoute, { units: "meters" });

        // Calculate bearing (direction) for icon rotation
        let bikeBearing: number;

        if (phase === "fading-out") {
          // Lock bearing during fade-out (keep final travel direction)
          bikeBearing = trip.currentBearing;
        } else {
          // Look 100 meters ahead for smoother direction changes
          const lookAheadDistance = Math.min(100, trip.totalDistance - distanceAlongRoute);
          const nextDistance = distanceAlongRoute + lookAheadDistance;
          const nextPoint = along(trip.line, nextDistance, { units: "meters" });
          const newBearing = bearing(point, nextPoint);

          // Smooth bearing changes: 30% new bearing, 70% old bearing
          bikeBearing = interpolateAngle(trip.currentBearing, newBearing, 0.3);
          trip.currentBearing = bikeBearing; // Update for next frame
        }

        features.push({
          type: "Feature",
          geometry: point.geometry,
          properties: {
            id: trip.id,
            color: trip.color,
            phase,
            phaseProgress,
            bearing: bikeBearing,
          },
        });
      }

      // Update Mapbox source directly - bypasses React
      const source = map.getSource("riders") as GeoJSONSource | undefined;
      if (source) {
        source.setData({ type: "FeatureCollection", features });
      }

      ref.rafId = requestAnimationFrame((ts) => animateFnRef.current?.(ts));
    };
  }, [mapRef, preparedTrips, windowDurationMs, animationDurationMs]);

  const play = useCallback(() => {
    animationRef.current.startTimestamp = null;
    setAnimState("playing");
    animationRef.current.rafId = requestAnimationFrame((ts) =>
      animateFnRef.current?.(ts)
    );
  }, []);

  const replay = useCallback(() => {
    if (animationRef.current.rafId) {
      cancelAnimationFrame(animationRef.current.rafId);
    }
    play();
  }, [play]);

  // Cleanup on unmount
  useEffect(() => {
    const ref = animationRef.current;
    return () => {
      if (ref.rafId) {
        cancelAnimationFrame(ref.rafId);
      }
    };
  }, []);

  return (
    <div className="absolute top-4 left-4 z-10">
      {animState === "idle" && (
        <button
          onClick={play}
          className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg shadow-lg transition-colors"
        >
          Play
        </button>
      )}
      {animState === "playing" && (
        <div className="bg-gray-800 text-white font-medium px-4 py-2 rounded-lg shadow-lg">
          Playing...
        </div>
      )}
      {animState === "finished" && (
        <button
          onClick={replay}
          className="bg-green-600 hover:bg-green-700 text-white font-medium px-4 py-2 rounded-lg shadow-lg transition-colors"
        >
          Replay
        </button>
      )}
    </div>
  );
}

// Component to load custom icon into map
function IconLoader() {
  const { current: mapRef } = useMap();

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;

    // Create a cursor-style pointer icon with rounded corners, rotated to point up
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <g transform="rotate(45 12 12)">
          <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>
        </g>
      </svg>
    `;

    const img = new Image(24, 24);
    img.onload = () => {
      if (!map.hasImage('caret')) {
        map.addImage('caret', img, { sdf: true }); // sdf: true allows recoloring
      }
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(svg);
  }, [mapRef]);

  return null;
}

export const BikeMap = () => {
  const [preparedTrips, setPreparedTrips] = useState<PreparedTrip[]>([]);
  const [windowDurationMs, setWindowDurationMs] = useState(0);

  useEffect(() => {
    const fetchTrips = async () => {
      const data = await getActiveRides();
      console.log(`Found ${data.count} trips`);

      const windowStartMs = data.startTime.getTime();
      const windowEndMs = data.endTime.getTime();

      const prepared = prepareTrips({
        trips: data.trips,
        windowStartMs,
        windowEndMs,
      });

      console.log(`Prepared ${prepared.length} trips with routes`);
      setPreparedTrips(prepared);
      setWindowDurationMs(windowEndMs - windowStartMs);
    };
    fetchTrips();
  }, []);

  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
    throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN is not set");
  }

  return (
    <Map
      id="bikemap"
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
      initialViewState={{
        longitude: -74.0,
        latitude: 40.7,
        zoom: 14,
      }}
      mapStyle="mapbox://styles/mapbox/dark-v11"
      style={{ width: "100%", height: "100%" }}
    >
      <Source id="riders" type="geojson" data={EMPTY_GEOJSON}>
        <Layer
          id="riders"
          type="symbol"
          layout={{
            "icon-image": "caret",
            "icon-size": 0.5,
            "icon-rotate": ["get", "bearing"],
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          }}
          paint={{
            "icon-opacity": [
              "case",
              ["==", ["get", "phase"], "fading-in"],
              ["*", ["get", "phaseProgress"], 0.8], // 0 → 0.8
              ["==", ["get", "phase"], "fading-out"],
              ["*", ["-", 1, ["get", "phaseProgress"]], 0.8], // 0.8 → 0
              0.8, // moving = max opacity
            ],
            "icon-color": [
              "case",
              ["==", ["get", "phase"], "fading-in"],
              "#22c55e", // green

              ["==", ["get", "phase"], "transitioning-in"],
              [
                "interpolate",
                ["linear"],
                ["get", "phaseProgress"],
                0, "#22c55e", // green at start
                1, ["get", "color"], // gray/blue at end
              ],

              ["==", ["get", "phase"], "fading-out"],
              "#ef4444", // red (instant)

              ["get", "color"], // moving = gray/blue based on bike type
            ],
          }}
        />
      </Source>

      <IconLoader />

      {preparedTrips.length > 0 && windowDurationMs > 0 && (
        <AnimationController
          preparedTrips={preparedTrips}
          windowDurationMs={windowDurationMs}
          animationDurationMs={windowDurationMs / SPEEDUP}
        />
      )}
    </Map>
  );
};
