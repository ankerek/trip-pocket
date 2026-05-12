import type { Migration } from '../db';
import { init } from './0001_init';
import { urlShare } from './0002_url_share';

export const migrations: Migration[] = [init, urlShare];
