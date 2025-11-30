import { parse } from 'csv-parse/sync';
import path from 'path';
import { z } from 'zod';

declare var self: Worker;

const CSVRowSchema = z.object({
  ride_id: z.string().min(1),
  rideable_type: z.string().min(1),
  started_at: z.coerce.date(),
  ended_at: z.coerce.date(),
  start_station_name: z.string().min(1),
  start_station_id: z.string().min(1),
  end_station_name: z.string().min(1),
  end_station_id: z.string().min(1),
  start_lat: z.coerce.number(),
  start_lng: z.coerce.number(),
  end_lat: z.coerce.number(),
  end_lng: z.coerce.number(),
  member_casual: z.enum(['member', 'casual']),
});

type CSVRow = z.infer<typeof CSVRowSchema>;

export type WorkerInput = { type: 'process'; filePath: string };
export type WorkerOutput =
  | { type: 'result'; fileName: string; validRows: CSVRow[]; skippedCount: number; totalCount: number }
  | { type: 'ready' };

self.onmessage = async (event: MessageEvent<WorkerInput>) => {
  const { filePath } = event.data;
  const fileName = path.basename(filePath);

  const file = Bun.file(filePath);
  const fileString = await file.text();
  const records = parse(fileString, { columns: true }) as unknown[];

  const validRows: CSVRow[] = [];
  let skippedCount = 0;

  for (const record of records) {
    const result = CSVRowSchema.safeParse(record);
    if (result.success) {
      validRows.push(result.data);
    } else {
      skippedCount++;
    }
  }

  postMessage({
    type: 'result',
    fileName,
    validRows,
    skippedCount,
    totalCount: records.length,
  } satisfies WorkerOutput);
};

// Signal ready
postMessage({ type: 'ready' } satisfies WorkerOutput);
