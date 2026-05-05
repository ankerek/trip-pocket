import type { Migration } from '../db';
import { init } from './0001_init';

export const migrations: Migration[] = [init];
