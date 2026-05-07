import type { Migration } from '../db';
import { init } from './0001_init';
import { ocrFts } from './0002_ocr_fts';
import { extraction } from './0003_extraction';

export const migrations: Migration[] = [init, ocrFts, extraction];
