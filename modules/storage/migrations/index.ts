import type { Migration } from '../db';
import { init } from './0001_init';
import { urlShare } from './0002_url_share';
import { pendingImportsNullablePath } from './0003_pending_imports_nullable_path';

export const migrations: Migration[] = [init, urlShare, pendingImportsNullablePath];
