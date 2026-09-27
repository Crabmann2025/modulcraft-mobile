/**
 * Nachweis der Filter-Logik des Generators (ADR-009).
 *
 * Der echte Generator läuft mit der Projekt-Konfiguration (openapi-ts.config.ts) auf
 * einem synthetischen Vertrag, der absichtlich verwaiste Komponenten enthält – darunter
 * PaginationMetadata aus flask-smorest und eine Waise, die nur von einer anderen Waise
 * referenziert wird. Erwartung: Alles, was keine Operation erreicht, fehlt im Client;
 * indirekt erreichbare Typen (Error → ErrorDetail, JobPage → Job) bleiben erhalten.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClient } from '@hey-api/openapi-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import projectConfig from '../openapi-ts.config';

const FIXTURE = resolve(__dirname, 'fixtures', 'orphan-spec.json');

let outputDir: string;
let types: string;

beforeAll(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'openapi-filter-test-'));
  const config = await projectConfig;
  await createClient({
    ...config,
    input: FIXTURE,
    output: { ...(typeof config.output === 'object' ? config.output : {}), path: outputDir },
    logs: { level: 'silent', file: false },
  });
  types = await readFile(join(outputDir, 'types.gen.ts'), 'utf-8');
}, 60_000);

afterAll(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe('Generator-Konfiguration: verwaiste Komponenten', () => {
  it('nutzt den Filter ausdrücklich (unabhängig von künftigen Standardwerten)', async () => {
    const config = await projectConfig;
    expect(config.parser?.filters?.orphans).toBe(false);
  });

  it.each(['PaginationMetadata', 'OrphanReferencingOrphan', 'OrphanOnlyReferencedByOrphan'])(
    'entfernt die Waise %s',
    (name) => {
      expect(types).not.toMatch(new RegExp(`export type ${name}\\b`));
    },
  );

  it.each(['Job', 'JobPage', 'Error', 'ErrorDetail'])('behält den erreichbaren Typ %s', (name) => {
    expect(types).toMatch(new RegExp(`export type ${name} = `));
  });

  it('erzeugt die Operation aus der operationId', async () => {
    const sdk = await readFile(join(outputDir, 'sdk.gen.ts'), 'utf-8');
    expect(sdk).toContain('export const listJobs');
  });

  it('Gegenprobe: ohne Filter erscheinen die Waisen – der Filter ist also wirksam', async () => {
    const config = await projectConfig;
    const unfilteredDir = await mkdtemp(join(tmpdir(), 'openapi-filter-gegenprobe-'));
    try {
      await createClient({
        ...config,
        input: FIXTURE,
        output: { ...(typeof config.output === 'object' ? config.output : {}), path: unfilteredDir },
        parser: { ...config.parser, filters: { ...config.parser?.filters, orphans: true } },
        logs: { level: 'silent', file: false },
      });
      const unfiltered = await readFile(join(unfilteredDir, 'types.gen.ts'), 'utf-8');
      expect(unfiltered).toMatch(/export type PaginationMetadata\b/);
      expect(unfiltered).toMatch(/export type OrphanReferencingOrphan\b/);
    } finally {
      await rm(unfilteredDir, { recursive: true, force: true });
    }
  }, 60_000);
});
