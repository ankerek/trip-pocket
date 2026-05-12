import type { Migration } from '../db';
import { init } from './0001_init';
import { urlShare } from './0002_url_share';
import { pendingImportsNullablePath } from './0003_pending_imports_nullable_path';
import { renameScreenshotToImage } from './0004_rename_screenshot_to_image';

export const migrations: Migration[] = [
  init,
  urlShare,
  pendingImportsNullablePath,
  renameScreenshotToImage,
];
