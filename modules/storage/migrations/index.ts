import type { Migration } from '../db';
import { init } from './0001_init';
import { urlShare } from './0002_url_share';
import { pendingImportsNullablePath } from './0003_pending_imports_nullable_path';
import { renameScreenshotToImage } from './0004_rename_screenshot_to_image';
import { pipelineEvents } from './0005_pipeline_events';
import { countrySearch } from './0006_country_search';
import { entitlementPausedReason } from './0007_entitlement_paused_reason';
import { categoryRename } from './0008_category_rename';
import { dropTags } from './0009_drop_tags';
import { extractionStrategyColumns } from './0010_extraction_strategy_columns';

export const migrations: Migration[] = [
  init,
  urlShare,
  pendingImportsNullablePath,
  renameScreenshotToImage,
  pipelineEvents,
  countrySearch,
  entitlementPausedReason,
  categoryRename,
  dropTags,
  extractionStrategyColumns,
];
