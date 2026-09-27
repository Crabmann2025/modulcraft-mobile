import { defineConfig } from '@hey-api/openapi-ts';

// Erzeugt den API-Client aus dem gepinnten Vertrag (ADR-009) – nie direkt vom Server.
// `npm run sync-api` aktualisiert openapi/openapi.json, `npm run generate-api` den Client.
export default defineConfig({
  input: './openapi/openapi.json',
  output: { path: './src/api/generated' },
  // Entfernt jede Komponente, die von keiner Operation (auch indirekt über $ref)
  // erreichbar ist. Ausdrücklich gesetzt, damit ein Generator-Update das nicht ändert.
  parser: { filters: { orphans: false } },
  plugins: [
    '@hey-api/client-fetch', // Laufzeit-Client auf Basis von fetch (im Generator enthalten)
    '@hey-api/typescript', // Typen aus den Schemas (Job, JobPage, Error …)
    '@hey-api/sdk', // Funktionen je operationId (listJobs, createJob, getJob, updateJob)
  ],
});
