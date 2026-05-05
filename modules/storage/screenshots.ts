import type { Database } from './db';

export type ScreenshotSource = 'share' | 'auto' | 'manual';

export type Screenshot = {
  id: string;
  tripId: string | null;
  filePath: string;
  contentHash: string;
  source: ScreenshotSource;
  ocrStatus: 'pending' | 'done' | 'failed';
  ocrText: string | null;
  extractionStatus: 'pending' | 'done' | 'failed';
  capturedAt: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertScreenshotInput = {
  id: string;
  tripId: string | null;
  filePath: string;
  contentHash: string;
  source: ScreenshotSource;
  capturedAt: string;
  ownerId: string;
};

export async function insertScreenshot(
  db: Database,
  input: InsertScreenshotInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO screenshots (
      id, trip_id, file_path, content_hash, source,
      ocr_status, extraction_status, captured_at,
      owner_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?)`,
    input.id,
    input.tripId,
    input.filePath,
    input.contentHash,
    input.source,
    input.capturedAt,
    input.ownerId,
    now,
    now,
  );
}

type Row = {
  id: string;
  trip_id: string | null;
  file_path: string;
  content_hash: string;
  source: ScreenshotSource;
  ocr_status: 'pending' | 'done' | 'failed';
  ocr_text: string | null;
  extraction_status: 'pending' | 'done' | 'failed';
  captured_at: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

function rowToScreenshot(r: Row): Screenshot {
  return {
    id: r.id,
    tripId: r.trip_id,
    filePath: r.file_path,
    contentHash: r.content_hash,
    source: r.source,
    ocrStatus: r.ocr_status,
    ocrText: r.ocr_text,
    extractionStatus: r.extraction_status,
    capturedAt: r.captured_at,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listScreenshots(
  db: Database,
  filter: { tripId: string | null },
): Promise<Screenshot[]> {
  const rows = await db.getAllAsync<Row>(
    `SELECT id, trip_id, file_path, content_hash, source,
            ocr_status, ocr_text, extraction_status, captured_at,
            owner_id, created_at, updated_at
       FROM screenshots
      WHERE deleted_at IS NULL
        AND ((? IS NULL AND trip_id IS NULL) OR trip_id = ?)
   ORDER BY captured_at DESC`,
    filter.tripId,
    filter.tripId,
  );
  return rows.map(rowToScreenshot);
}
