"use client";

import { getActiveRides } from "@/app/server/trips";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useState } from "react";
import Map, { Layer, Source } from "react-map-gl/mapbox";

// Infer types from server function - no Prisma import needed
type TripsResponse = Awaited<ReturnType<typeof getActiveRides>>;
type Trip = TripsResponse["trips"][number];

export const BikeMap = () => {
  const [trips, setTrips] = useState<Trip[]>([]);

  useEffect(() => {
    const fetchTrips = async () => {
      const data = await getActiveRides();
      console.log(`Found ${data.count} trips`);
      setTrips(data.trips);
    };
    fetchTrips();
  }, []);

  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
    throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN is not set");
  }

  // Create GeoJSON from trip start positions
  const geojson: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: trips.map((trip) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [trip.startLng, trip.startLat],
      },
      properties: { id: trip.id },
    })),
  };

  return (
    <Map
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
      initialViewState={{
        longitude: -74.0,
        latitude: 40.7,
        zoom: 14,
      }}
      mapStyle="mapbox://styles/mapbox/streets-v9"
      style={{ width: "100%", height: "100%" }}
    >
      <Source id="bikes" type="geojson" data={geojson}>
        <Layer
          id="bikes"
          type="circle"
          paint={{
            "circle-radius": 5,
            "circle-color": "#ff0000",
            "circle-opacity": 0.8,
          }}
        />
      </Source>
    </Map>
  );
};
