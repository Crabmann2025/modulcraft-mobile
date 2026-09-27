/**
 * Holt den API-Vertrag (openapi.json) des Backends und pinnt ihn in openapi/openapi.json.
 *
 *   npm run sync-api                                          # vom lokalen Entwicklungsserver
 *   npm run sync-api -- --file ../modulcraft-backend/openapi.json   # aus einer Datei
 *
 * Quelle ohne --file: API_SPEC_URL, sonst http://127.0.0.1:5000/api/openapi.json.
 * Danach erzeugt `npm run generate-api` den Client aus der gepinnten Datei (ADR-009).
 *
 * Sicherheitsregeln:
 * - Unverschlüsseltes HTTP nur für localhost, sonst HTTPS; keine Weiterleitungen.
 * - Zeitlimit 10 s, höchstens 5 MB.
 * - Gepinnt wird nur ein Vertrag mit OpenAPI 3.0.x, mindestens einer Operation, dem
 *   Security-Schema bearerAuth und globaler Anmeldepflicht – ein Vertrag ohne
 *   Anmeldung gelangt so nie unbemerkt in den Client.
 * - Atomar geschrieben: Bei einem Fehler bleibt der bisherige Vertrag unverändert.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const DEFAULT_SPEC_URL = 'http://127.0.0.1:5000/api/openapi.json';
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class SyncError extends Error {
  override name = 'SyncError';
}

export type SpecSource = { kind: 'url'; url: URL } | { kind: 'file'; path: string };

export interface OpenApiDocument {
  openapi: string;
  paths: Record<string, unknown>;
  components: { securitySchemes: { bearerAuth: unknown } };
  security: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface LoadOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Ermittelt die Quelle aus den Argumenten (--file) oder der Umgebung (API_SPEC_URL). */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): SpecSource {
  let file: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--file') {
      file = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else {
      throw new SyncError(`Unbekanntes Argument: ${arg} (erlaubt: --file <pfad>)`);
    }
    if (!file) {
      throw new SyncError('--file erwartet einen Pfad zur openapi.json.');
    }
  }
  if (file !== undefined) {
    return { kind: 'file', path: resolve(file) };
  }
  return { kind: 'url', url: resolveSpecUrl(env.API_SPEC_URL || DEFAULT_SPEC_URL) };
}

/** Prüft die Adresse: HTTPS, unverschlüsseltes HTTP nur für localhost. */
export function resolveSpecUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SyncError(`Ungültige Adresse für den API-Vertrag: ${raw}`);
  }
  if (url.protocol === 'https:') {
    return url;
  }
  if (url.protocol === 'http:') {
    if (LOCAL_HOSTS.has(url.hostname)) {
      return url;
    }
    throw new SyncError(`Unverschlüsseltes HTTP ist nur für localhost erlaubt – bitte HTTPS nutzen: ${url.href}`);
  }
  throw new SyncError(`Nicht unterstütztes Protokoll ${url.protocol} – erlaubt sind HTTPS und HTTP für localhost.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Prüft die Pflichtbestandteile des Vertrags und liefert ihn typisiert zurück. */
export function validateSpec(data: unknown): OpenApiDocument {
  if (!isRecord(data)) {
    throw new SyncError('Der API-Vertrag ist kein JSON-Objekt.');
  }
  if (typeof data.openapi !== 'string' || !data.openapi.startsWith('3.0.')) {
    throw new SyncError(`Ungültige OpenAPI-Version: ${String(data.openapi)} (erwartet 3.0.x).`);
  }
  if (!isRecord(data.paths) || Object.keys(data.paths).length === 0) {
    throw new SyncError('Der API-Vertrag enthält keine Operationen (paths fehlt oder ist leer).');
  }
  const components = isRecord(data.components) ? data.components : {};
  const securitySchemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  if (!('bearerAuth' in securitySchemes)) {
    throw new SyncError('Security-Schema bearerAuth fehlt.');
  }
  const security = data.security;
  if (!Array.isArray(security) || !security.some((entry) => isRecord(entry) && 'bearerAuth' in entry)) {
    throw new SyncError('Globale Security (bearerAuth) fehlt – jede Operation muss eine Anmeldung verlangen.');
  }
  return data as OpenApiDocument;
}

function parseJson(text: string, origin: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SyncError(`${origin} enthält kein gültiges JSON.`);
  }
}

function tooLarge(maxBytes: number): SyncError {
  return new SyncError(`Der API-Vertrag ist zu groß (höchstens ${maxBytes} Bytes).`);
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(maxBytes);
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

async function loadFromFile(path: string, maxBytes: number): Promise<unknown> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new SyncError(`Datei nicht lesbar: ${path}`);
  }
  if (size > maxBytes) {
    throw tooLarge(maxBytes);
  }
  return parseJson(await readFile(path, 'utf-8'), `Die Datei ${path}`);
}

async function loadFromUrl(url: URL, fetchImpl: typeof fetch, timeoutMs: number, maxBytes: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new SyncError(`HTTP-Fehler: ${response.status} beim Abruf von ${url.href}`);
    }
    return parseJson(await readBodyWithLimit(response, maxBytes), 'Die Antwort');
  } catch (error) {
    if (error instanceof SyncError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new SyncError(`Zeitüberschreitung nach ${timeoutMs} ms beim Abruf von ${url.href}`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new SyncError(`Netzwerkfehler beim Abruf von ${url.href} (${reason}). Läuft das Backend?`);
  } finally {
    clearTimeout(timer);
  }
}

/** Lädt den Vertrag aus Datei oder URL (noch ohne inhaltliche Prüfung). */
export async function loadSpec(source: SpecSource, options: LoadOptions = {}): Promise<unknown> {
  const { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_SPEC_BYTES } = options;
  return source.kind === 'file'
    ? loadFromFile(source.path, maxBytes)
    : loadFromUrl(source.url, fetchImpl, timeoutMs, maxBytes);
}

/** Schreibt den Vertrag formatiert (LF) über eine temporäre Datei und ersetzt dann das Ziel. */
export async function writeSpecAtomically(spec: unknown, targetFile: string): Promise<void> {
  await mkdir(dirname(targetFile), { recursive: true });
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  try {
    await writeFile(tempFile, `${JSON.stringify(spec, null, 2)}\n`, 'utf-8');
    await rename(tempFile, targetFile);
  } catch (error) {
    await rm(tempFile, { force: true });
    throw error;
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  options: LoadOptions & { targetFile?: string } = {},
): Promise<number> {
  const targetFile = options.targetFile ?? resolve('openapi', 'openapi.json');
  try {
    const source = parseArgs(argv, env);
    console.log(`Lade API-Vertrag von: ${source.kind === 'file' ? source.path : source.url.href}`);
    const spec = validateSpec(await loadSpec(source, options));
    await writeSpecAtomically(spec, targetFile);
    console.log(`✅ API-Vertrag synchronisiert: ${targetFile}\n   Weiter mit: npm run generate-api`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Fehler beim Synchronisieren: ${message}`);
    return 1;
  }
}

// Nur beim direkten Aufruf (tsx scripts/sync-api.ts) ausführen, nicht beim Import in Tests.
// Bewusst ohne import.meta: Das Skript läuft identisch in ESM- (Web) und CJS-Projekten (Expo).
if (/(^|[\\/])sync-api\.ts$/.test(process.argv[1] ?? '')) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
