/**
 * Einrichtung des generierten API-Clients (ADR-009).
 *
 * Der Client in ./generated entsteht ausschließlich per `npm run generate-api` aus dem
 * gepinnten Vertrag openapi/openapi.json und wird nie von Hand geändert. Diese Datei
 * setzt nur Basisadresse und Anmeldung:
 *
 * - Das Zugangstoken liefert der Aufrufer über `getAccessToken` (bis M1.4 ein
 *   Entwicklungs-Token, danach Keycloak). Es wird bei jeder Anfrage neu abgefragt und
 *   hier weder gespeichert noch protokolliert.
 * - Tokens werden nie unverschlüsselt ins Internet gesendet: Unverschlüsseltes HTTP
 *   ist nur für localhost und private Netze (Test auf dem Gerät im WLAN) erlaubt.
 */
import { client } from './generated/client.gen';

/** Liefert das aktuelle Zugangstoken oder `undefined`, wenn niemand angemeldet ist. */
export type AccessTokenProvider = () => string | undefined | Promise<string | undefined>;

export interface ApiClientOptions {
  /** Basisadresse des Backends; '' bedeutet gleicher Ursprung (z. B. über einen Proxy). */
  baseUrl: string;
  getAccessToken: AccessTokenProvider;
  /** Eigene fetch-Implementierung, z. B. für Tests. */
  fetch?: typeof fetch;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Private IPv4-Netze nach RFC 1918 (Entwicklungsrechner im lokalen Netz). */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** Prüft die Basisadresse: gleicher Ursprung, HTTPS oder HTTP nur lokal bzw. im privaten Netz. */
export function assertSafeBaseUrl(baseUrl: string): void {
  if (baseUrl === '') {
    return;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Ungültige Basisadresse für die API: ${baseUrl}`);
  }
  if (url.protocol === 'https:') {
    return;
  }
  if (url.protocol === 'http:' && (LOCAL_HOSTS.has(url.hostname) || isPrivateIPv4(url.hostname))) {
    return;
  }
  throw new Error(
    `Unsichere Basisadresse für die API: ${baseUrl} – außerhalb von localhost und privaten Netzen ist HTTPS Pflicht.`,
  );
}

/** Richtet den generierten Client ein; einmal beim Start der Anwendung aufrufen. */
export function configureApiClient({ baseUrl, getAccessToken, fetch }: ApiClientOptions): void {
  assertSafeBaseUrl(baseUrl);
  client.setConfig({
    baseUrl,
    auth: () => getAccessToken(),
    ...(fetch ? { fetch } : {}),
  });
}
