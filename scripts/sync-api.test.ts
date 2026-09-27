/**
 * Tests für scripts/sync-api.ts – das Abholen und Pinnen des API-Vertrags (ADR-009).
 *
 * Geprüft werden Quellenwahl, Sicherheitsregeln (HTTPS außer localhost, Größen- und
 * Zeitlimit, keine Weiterleitungen), die inhaltliche Prüfung des Vertrags und das
 * atomare Schreiben. Netzwerkzugriffe sind durch ein gemocktes fetch ersetzt.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPEC_URL,
  SyncError,
  loadSpec,
  main,
  parseArgs,
  resolveSpecUrl,
  validateSpec,
  writeSpecAtomically,
} from './sync-api';

/** Kleinster Vertrag, der alle Pflichtprüfungen besteht (synthetisch). */
function validSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'Modul-Craft API', version: 'v1' },
    paths: { '/api/v1/jobs': { get: { operationId: 'listJobs', responses: {} } } },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'sync-api-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('nutzt ohne Argumente den lokalen Entwicklungsserver', () => {
    const source = parseArgs([], {});
    expect(source).toEqual({ kind: 'url', url: new URL(DEFAULT_SPEC_URL) });
    expect(DEFAULT_SPEC_URL).toBe('http://127.0.0.1:5000/api/openapi.json');
  });

  it('übernimmt API_SPEC_URL aus der Umgebung', () => {
    const source = parseArgs([], { API_SPEC_URL: 'https://api.example.test/api/openapi.json' });
    expect(source).toEqual({ kind: 'url', url: new URL('https://api.example.test/api/openapi.json') });
  });

  it('liest mit --file <pfad> aus einer Datei', () => {
    expect(parseArgs(['--file', '../backend/openapi.json'], {})).toEqual({
      kind: 'file',
      path: resolve('../backend/openapi.json'),
    });
  });

  it('akzeptiert auch --file=<pfad>', () => {
    expect(parseArgs(['--file=vertrag.json'], {})).toEqual({
      kind: 'file',
      path: resolve('vertrag.json'),
    });
  });

  it('lehnt --file ohne Pfad ab', () => {
    expect(() => parseArgs(['--file'], {})).toThrow(SyncError);
    expect(() => parseArgs(['--file='], {})).toThrow(SyncError);
  });

  it('lehnt unbekannte Argumente ab', () => {
    expect(() => parseArgs(['--force'], {})).toThrow(/Unbekanntes Argument/);
  });
});

describe('resolveSpecUrl', () => {
  it.each([
    'http://127.0.0.1:5000/api/openapi.json',
    'http://localhost:5000/api/openapi.json',
    'http://[::1]:5000/api/openapi.json',
    'https://api.example.test/api/openapi.json',
  ])('erlaubt %s', (raw) => {
    expect(resolveSpecUrl(raw).href).toBe(new URL(raw).href);
  });

  it('verbietet unverschlüsseltes HTTP zu entfernten Hosts', () => {
    expect(() => resolveSpecUrl('http://api.example.test/api/openapi.json')).toThrow(/HTTPS/);
  });

  it('verbietet andere Protokolle', () => {
    expect(() => resolveSpecUrl('file:///C:/openapi.json')).toThrow(SyncError);
    expect(() => resolveSpecUrl('ftp://127.0.0.1/openapi.json')).toThrow(SyncError);
  });

  it('lehnt ungültige Adressen ab – auch kopierte Markdown-Links', () => {
    expect(() => resolveSpecUrl('keine adresse')).toThrow(/Ungültige Adresse/);
    expect(() =>
      resolveSpecUrl('[http://127.0.0.1:5000/api/openapi.json](http://127.0.0.1:5000/api/openapi.json)'),
    ).toThrow(/Ungültige Adresse/);
  });
});

describe('validateSpec', () => {
  it('akzeptiert einen vollständigen Vertrag', () => {
    const spec = validSpec();
    expect(validateSpec(spec)).toBe(spec);
  });

  it.each([null, [], 'text', 42])('lehnt Nicht-Objekte ab (%j)', (value) => {
    expect(() => validateSpec(value)).toThrow(/kein JSON-Objekt/);
  });

  it.each(['3.1.0', '2.0', undefined])('lehnt OpenAPI-Version %s ab', (version) => {
    expect(() => validateSpec({ ...validSpec(), openapi: version })).toThrow(/OpenAPI-Version/);
  });

  it('lehnt einen Vertrag ohne Operationen ab', () => {
    expect(() => validateSpec({ ...validSpec(), paths: {} })).toThrow(/paths/);
    const { paths: _omitted, ...withoutPaths } = validSpec();
    expect(() => validateSpec(withoutPaths)).toThrow(/paths/);
  });

  it('verlangt das Security-Schema bearerAuth', () => {
    expect(() => validateSpec({ ...validSpec(), components: { securitySchemes: {} } })).toThrow(
      /bearerAuth/,
    );
  });

  it.each([undefined, [], [{ apiKey: [] }]])('verlangt globale Anmeldung per bearerAuth (%j)', (security) => {
    expect(() => validateSpec({ ...validSpec(), security })).toThrow(/Globale Security/);
  });
});

describe('loadSpec – Datei', () => {
  it('liest den Vertrag aus einer Datei', async () => {
    const file = join(workDir, 'openapi.json');
    await writeFile(file, JSON.stringify(validSpec()), 'utf-8');
    await expect(loadSpec({ kind: 'file', path: file })).resolves.toEqual(validSpec());
  });

  it('meldet eine fehlende Datei mit Pfad', async () => {
    const file = join(workDir, 'fehlt.json');
    await expect(loadSpec({ kind: 'file', path: file })).rejects.toThrow(/nicht lesbar/);
  });

  it('meldet ungültiges JSON', async () => {
    const file = join(workDir, 'kaputt.json');
    await writeFile(file, '{ kein json', 'utf-8');
    await expect(loadSpec({ kind: 'file', path: file })).rejects.toThrow(/kein gültiges JSON/);
  });

  it('lehnt zu große Dateien ab', async () => {
    const file = join(workDir, 'gross.json');
    await writeFile(file, JSON.stringify(validSpec()), 'utf-8');
    await expect(loadSpec({ kind: 'file', path: file }, { maxBytes: 10 })).rejects.toThrow(/zu groß/);
  });
});

describe('loadSpec – URL', () => {
  const source = { kind: 'url', url: new URL(DEFAULT_SPEC_URL) } as const;

  it('lädt den Vertrag ohne Weiterleitungen und mit Abbruchsignal', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(validSpec()));
    await expect(loadSpec(source, { fetchImpl })).resolves.toEqual(validSpec());
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(DEFAULT_SPEC_URL);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('meldet HTTP-Fehler mit Status', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(loadSpec(source, { fetchImpl })).rejects.toThrow(/HTTP-Fehler: 404/);
  });

  it('lehnt eine Antwort ab, die kein JSON ist', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html></html>'));
    await expect(loadSpec(source, { fetchImpl })).rejects.toThrow(/kein gültiges JSON/);
  });

  it('lehnt eine zu große Antwort laut Content-Length ab', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(validSpec(), { headers: { 'content-length': '999999999' } }));
    await expect(loadSpec(source, { fetchImpl, maxBytes: 1000 })).rejects.toThrow(/zu groß/);
  });

  it('bricht eine zu große Antwort ohne Content-Length beim Lesen ab', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(600)));
        controller.enqueue(new TextEncoder().encode('x'.repeat(600)));
        controller.close();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(loadSpec(source, { fetchImpl, maxBytes: 1000 })).rejects.toThrow(/zu groß/);
  });

  it('bricht nach dem Zeitlimit ab', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Abgebrochen', 'AbortError')),
        );
      });
    });
    await expect(loadSpec(source, { fetchImpl, timeoutMs: 20 })).rejects.toThrow(/Zeitüberschreitung/);
  });

  it('meldet Netzwerkfehler mit Hinweis auf das Backend', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(loadSpec(source, { fetchImpl })).rejects.toThrow(/Backend/);
  });
});

describe('writeSpecAtomically', () => {
  it('schreibt formatiert mit Zeilenumbruch am Ende und legt den Ordner an', async () => {
    const target = join(workDir, 'openapi', 'openapi.json');
    await writeSpecAtomically(validSpec(), target);
    const written = await readFile(target, 'utf-8');
    expect(written).toBe(`${JSON.stringify(validSpec(), null, 2)}\n`);
    expect(written).not.toContain('\r');
    expect(await readdir(join(workDir, 'openapi'))).toEqual(['openapi.json']);
  });

  it('ersetzt einen vorhandenen Vertrag vollständig', async () => {
    const target = join(workDir, 'openapi.json');
    await writeFile(target, 'alt', 'utf-8');
    await writeSpecAtomically(validSpec(), target);
    expect(JSON.parse(await readFile(target, 'utf-8'))).toEqual(validSpec());
  });

  it('hinterlässt bei einem Fehler keine temporäre Datei', async () => {
    const target = join(workDir, 'ziel');
    await mkdir(join(target, 'blockiert'), { recursive: true }); // Ziel ist ein Ordner mit Inhalt
    await expect(writeSpecAtomically(validSpec(), target)).rejects.toThrow();
    expect(await readdir(workDir)).toEqual(['ziel']);
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('pinnt einen gültigen Vertrag aus einer Datei', async () => {
    const source = join(workDir, 'backend.json');
    const target = join(workDir, 'openapi', 'openapi.json');
    await writeFile(source, JSON.stringify(validSpec()), 'utf-8');
    await expect(main(['--file', source], {}, { targetFile: target })).resolves.toBe(0);
    expect(JSON.parse(await readFile(target, 'utf-8'))).toEqual(validSpec());
  });

  it('lässt den gepinnten Vertrag bei einem ungültigen Vertrag unverändert', async () => {
    const source = join(workDir, 'backend.json');
    const target = join(workDir, 'openapi.json');
    await writeFile(source, JSON.stringify({ ...validSpec(), security: undefined }), 'utf-8');
    await writeFile(target, 'bisheriger Vertrag', 'utf-8');
    await expect(main(['--file', source], {}, { targetFile: target })).resolves.toBe(1);
    expect(await readFile(target, 'utf-8')).toBe('bisheriger Vertrag');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Globale Security'));
  });

  it('meldet unzulässige Quellen mit Exit-Code 1', async () => {
    const target = join(workDir, 'openapi.json');
    await expect(
      main([], { API_SPEC_URL: 'http://api.example.test/openapi.json' }, { targetFile: target }),
    ).resolves.toBe(1);
  });
});
