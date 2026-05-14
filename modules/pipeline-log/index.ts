// Public API barrel for the pipeline observability module. See
// docs/superpowers/specs/2026-05-13-pipeline-observability-design.md.

export { startStage, type PipelineStage, type Stage } from './pipeline-log';
export {
  isFirehoseEnabled,
  setFirehoseEnabled as setFirehose,
  initFirehose as initPipelineLog,
} from './firehose';
export {
  sweepPipelineEvents,
  readRecentEvents,
  clearPipelineEvents,
  type PipelineEventRow,
} from './storage';
