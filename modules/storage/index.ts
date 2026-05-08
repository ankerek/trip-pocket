export { openDatabase, runMigrations } from './db';
export type { Database } from './db';
export { migrations } from './migrations';
export {
  insertSource,
  getSource,
  listSources,
  listAllSources,
  listInboxSources,
  listSourcesByTrip,
  assignSourceTrip,
  softDeleteSource,
  countSourcesByTrip,
  type Source,
  type SourceKind,
  type SourceOrigin,
  type ProcessingStatus,
  type InsertSourceInput,
} from './sources';
export {
  insertPlace,
  getPlace,
  listPlaces,
  movePlaceToTrip,
  softDeletePlace,
  applyEnrichment,
  setEnrichmentStatus,
  findSoleMatchByNormalizedKey,
  findCollidingByExternalId,
  normalizePlaceKey,
  type Place,
  type EnrichmentStatus,
  type EnrichmentColumns,
  type InsertPlaceInput,
} from './places';
export {
  linkPlaceSource,
  listSourcesForPlace,
  listPlacesForSource,
  transferJunctions,
  countLiveSourcesForPlace,
  type PlaceSource,
  type LinkPlaceSourceInput,
} from './place_sources';
export { provideDatabase, useLiveQuery, notifyChange, getDatabaseHandle } from './live-query';
export {
  createTrip,
  listTrips,
  getTrip,
  renameTrip,
  softDeleteTrip,
  type Trip,
  type InsertTripInput,
  type UpdateTripNameInput,
} from './trips';
