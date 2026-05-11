import * as Sentry from '@sentry/react-native';

export type PipelineStage =
  | 'share_import'
  | 'storage'
  | 'ocr'
  | 'extraction'
  | 'enrichment'
  | 'trip_assign';

export function pipelineStep(stage: PipelineStage): void {
  if (__DEV__) return;
  Sentry.addBreadcrumb({ category: `pipeline.${stage}`, level: 'info' });
}

export function pipelineError(stage: PipelineStage, err: unknown): void {
  if (__DEV__) {
    console.error(`[pipeline.${stage}]`, err);
    return;
  }
  Sentry.addBreadcrumb({ category: `pipeline.${stage}.error`, level: 'error' });
  Sentry.captureException(err, { tags: { pipeline_stage: stage } });
}
