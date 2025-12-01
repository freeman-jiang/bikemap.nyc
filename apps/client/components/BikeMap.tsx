"use client"

import { getTrips } from "@/app/server/trips";
import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect } from "react";
import Map from 'react-map-gl/mapbox';

export const BikeMap = () => {
  useEffect(() => {
    const fetchTrips = async () => {
      const data = await getTrips();
      console.log(`Found ${data.count} trips`, data);
    };
    fetchTrips();
  }, []);

  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN) {
    throw new Error('NEXT_PUBLIC_MAPBOX_TOKEN is not set');
  }


  return (
    <Map
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
      initialViewState={{
        longitude: -74.0,
        latitude: 40.7,
        zoom: 14
      }}
      mapStyle="mapbox://styles/mapbox/streets-v9"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
