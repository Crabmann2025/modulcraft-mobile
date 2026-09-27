/**
 * Öffentliche Schnittstelle der API-Anbindung. Fachcode importiert ausschließlich von
 * hier, nie direkt aus ./generated – so bleibt der generierte Code austauschbar.
 */
export { assertSafeBaseUrl, configureApiClient } from './client';
export type { AccessTokenProvider, ApiClientOptions } from './client';

export { createJob, getJob, listJobs, updateJob } from './generated';
export type {
  Error as ApiErrorResponse,
  ErrorDetail as ApiErrorDetail,
  Job,
  JobCreate,
  JobPage,
  JobUpdate,
} from './generated';

import type { Job } from './generated';

/** Status eines Einsatzes (siehe Glossar: JobStatus). */
export type JobStatus = Job['status'];
