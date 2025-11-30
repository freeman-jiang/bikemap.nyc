import { type Station, type Trip, prisma } from '@bikemap/db';
import { glob } from 'glob';
import path from 'path';
import type { WorkerInput, WorkerOutput } from './worker';

const WORKER_COUNT = 10;
// const BATCH_SIZE = 10000;

type CSVRow = {
  ride_id: string;
  rideable_type: string;
  started_at: Date;
  ended_at: Date;
  start_station_name: string;
  start_station_id: string;
  end_station_name: string;
  end_station_id: string;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  member_casual: 'member' | 'casual';
};

function mapRowToTrip(row: CSVRow): Trip {
  return {
    id: row.ride_id,
    startStationId: row.start_station_id,
    endStationId: row.end_station_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    rideableType: row.rideable_type,
    memberCasual: row.member_casual,
    startLat: row.start_lat,
    startLng: row.start_lng,
    endLat: row.end_lat,
    endLng: row.end_lng,
  };
}

function updateStationMap(stationMap: Map<string, Station>, rows: CSVRow[]): void {
  for (const row of rows) {
    if (!stationMap.has(row.start_station_id)) {
      stationMap.set(row.start_station_id, {
        id: row.start_station_id,
        name: row.start_station_name,
        latitude: row.start_lat,
        longitude: row.start_lng,
      });
    }
    if (!stationMap.has(row.end_station_id)) {
      stationMap.set(row.end_station_id, {
        id: row.end_station_id,
        name: row.end_station_name,
        latitude: row.end_lat,
        longitude: row.end_lng,
      });
    }
  }
}

async function insertTripsInBatches(trips: Trip[]): Promise<void> {
  await prisma.trip.createMany({data: trips})
  // for (let i = 0; i < trips.length; i += BATCH_SIZE) {
  //   const batch = trips.slice(i, i + BATCH_SIZE);
  //   await prisma.trip.createMany({ data: batch });
  // }
}

type ProcessResult = {
  totalTrips: number;
  totalSkipped: number;
  stationMap: Map<string, Station>;
};

async function processFilesWithWorkers(filePaths: string[]): Promise<ProcessResult> {
  const stationMap = new Map<string, Station>();
  const fileQueue = [...filePaths];
  let activeWorkers = 0;
  let processedFiles = 0;
  let totalTrips = 0;
  let totalSkipped = 0;

  // Queue for sequential DB writes
  let writePromise = Promise.resolve();

  return new Promise((resolve) => {
    const workers: Worker[] = [];

    function assignWork(worker: Worker): void {
      const nextFile = fileQueue.shift();
      if (nextFile) {
        activeWorkers++;
        worker.postMessage({ type: 'process', filePath: nextFile } satisfies WorkerInput);
      } else if (activeWorkers === 0) {
        // All workers done, wait for final writes then resolve
        writePromise.then(() => {
          workers.forEach((w) => w.terminate());
          resolve({ totalTrips, totalSkipped, stationMap });
        });
      }
    }

    for (let i = 0; i < WORKER_COUNT; i++) {
      const worker = new Worker(new URL('./worker.ts', import.meta.url).href);

      worker.onmessage = (event: MessageEvent<WorkerOutput>) => {
        const data = event.data;

        if (data.type === 'ready') {
          assignWork(worker);
        } else if (data.type === 'result') {
          activeWorkers--;
          processedFiles++;

          const percentSkipped =
            data.totalCount > 0 ? ((data.skippedCount / data.totalCount) * 100).toFixed(2) : '0';
          console.log(
            `[${processedFiles}/${filePaths.length}] ${data.fileName}: ${data.validRows.length} valid, ${data.skippedCount} skipped (${percentSkipped}%)`
          );

          // Update stations (in memory, fast)
          updateStationMap(stationMap, data.validRows);
          totalSkipped += data.skippedCount;

          // Queue DB write for this file's trips
          const trips: Trip[] = [];
          for (const row of data.validRows) {
            trips.push(mapRowToTrip(row));
          }
          totalTrips += trips.length;

          writePromise = writePromise.then(() => insertTripsInBatches(trips));

          // Assign next work immediately (don't wait for DB write)
          assignWork(worker);
        }
      };

      worker.onerror = (error) => {
        console.error('Worker error:', error);
        activeWorkers--;
        assignWork(worker);
      };

      workers.push(worker);
    }
  });
}

async function main(): Promise<void> {
  const dataDir = path.join(process.cwd(), '../../data');
  const csvFiles = glob.sync('**/*.csv', { cwd: dataDir, absolute: true });

  console.log(`Found ${csvFiles.length} CSV files\n`);
  console.log(`Processing with ${WORKER_COUNT} workers...\n`);

  const startTime = Date.now();
  const { totalTrips, totalSkipped, stationMap } = await processFilesWithWorkers(csvFiles);

  // Insert stations at the end
  console.log(`\nInserting ${stationMap.size} stations...`);
  await prisma.station.createMany({
    data: Array.from(stationMap.values()),
  });

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`\nDone! ${totalTrips} trips, ${totalSkipped} skipped in ${totalTime.toFixed(1)}s`);
}

main();
