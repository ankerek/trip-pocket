import type { Migration } from '../db';
import { init } from './0001_init';
import { ocrFts } from './0002_ocr_fts';

export const migrations: Migration[] = [init, ocrFts];
