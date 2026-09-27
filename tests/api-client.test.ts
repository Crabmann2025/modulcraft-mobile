/**
 * Tests für src/api/client.ts – Einrichtung des generierten API-Clients.
 *
 * Geprüft wird das Zusammenspiel mit dem generierten Code: Anmeldung per Bearer-Token
 * aus dem Token-Lieferanten (bei jeder Anfrage neu, nie gespeichert), Adressbildung,
 * JSON-Body, typisierte Fehlerantworten und die Absicherung der Basisadresse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureApiClient, createJob, listJobs, getJob } from '../src/api';
import type { ApiErrorResponse, Job } from '../src/api';

const BASE_URL = 'http://127.0.0.1:5000';

const SYNTHETIC_JOB: Job = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Wartung Gas-Brennwerttherme',
  description: null,
  status: 'planned',
  scheduled_start: '2026-09-28T06:00:00Z',
  scheduled_end: '2026-09-28T08:00:00Z',
  created_at: '2026-09-27T08:00:00Z',
  updated_at: '2026-09-27T08:00:00Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** fetch-Attrappe, die jede Anfrage aufzeichnet (der Client übergibt ein Request-Objekt). */
function recordingFetch(response: () => Response) {
  const requests: Request[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    requests.push(input as Request);
    return response();
  });
  return { fetchImpl, requests };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('configureApiClient – Anmeldung und Adressen', () => {
  it('sendet das Bearer-Token des Lieferanten und bildet die Adresse mit Filter', async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonResponse({ items: [SYNTHETIC_JOB], page: 1, page_size: 50, total: 1 }),
    );
    configureApiClient({ baseUrl: BASE_URL, getAccessToken: () => 'synthetisches-token', fetch: fetchImpl });

    const result = await listJobs({ query: { status: 'planned' } });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe(`${BASE_URL}/api/v1/jobs?status=planned`);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer synthetisches-token');
    expect(result.data?.items[0].title).toBe('Wartung Gas-Brennwerttherme');
  });

  it('fragt das Token bei jeder Anfrage neu ab (Token-Erneuerung)', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse(SYNTHETIC_JOB));
    const tokens = ['erstes-token', 'erneuertes-token'];
    const getAccessToken = vi.fn(async () => tokens.shift());
    configureApiClient({ baseUrl: BASE_URL, getAccessToken, fetch: fetchImpl });

    await getJob({ path: { job_id: SYNTHETIC_JOB.id } });
    await getJob({ path: { job_id: SYNTHETIC_JOB.id } });

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer erstes-token');
    expect(requests[1].headers.get('Authorization')).toBe('Bearer erneuertes-token');
    expect(requests[0].url).toBe(`${BASE_URL}/api/v1/jobs/${SYNTHETIC_JOB.id}`);
  });

  it('sendet ohne Token keinen Authorization-Header (das Backend antwortet mit 401)', async () => {
    const { fetchImpl, requests } = recordingFetch(() =>
      jsonResponse({ error: { status: 401, code: 'unauthorized', message: 'Anmeldung erforderlich.' } }, 401),
    );
    configureApiClient({ baseUrl: BASE_URL, getAccessToken: () => undefined, fetch: fetchImpl });

    const result = await listJobs();

    expect(requests[0].headers.has('Authorization')).toBe(false);
    expect(result.response?.status).toBe(401);
    expect(result.data).toBeUndefined();
  });

  it('sendet neue Einsätze als JSON', async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse(SYNTHETIC_JOB, 201));
    configureApiClient({ baseUrl: BASE_URL, getAccessToken: () => 'synthetisches-token', fetch: fetchImpl });

    const result = await createJob({ body: { title: 'Wartung Ölkessel' } });

    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.get('Content-Type')).toBe('application/json');
    expect(await requests[0].json()).toEqual({ title: 'Wartung Ölkessel' });
    expect(result.response?.status).toBe(201);
  });

  it('liefert Fehlerantworten im einheitlichen Fehlerformat', async () => {
    const body: ApiErrorResponse = {
      error: { status: 404, code: 'not_found', message: 'Nicht gefunden.' },
    };
    const { fetchImpl } = recordingFetch(() => jsonResponse(body, 404));
    configureApiClient({ baseUrl: BASE_URL, getAccessToken: () => 'synthetisches-token', fetch: fetchImpl });

    const result = await getJob({ path: { job_id: SYNTHETIC_JOB.id } });

    expect(result.data).toBeUndefined();
    expect(result.error).toEqual(body);
    expect(result.response?.status).toBe(404);
  });
});

describe('configureApiClient – Absicherung der Basisadresse', () => {
  it.each([
    '',
    'https://api.example.test',
    'http://localhost:5000',
    'http://127.0.0.1:5000',
    'http://[::1]:5000',
    'http://192.168.178.20:5000',
    'http://10.0.2.2:5000',
    'http://172.16.0.5:5000',
  ])('erlaubt %j', (baseUrl) => {
    expect(() => configureApiClient({ baseUrl, getAccessToken: () => undefined })).not.toThrow();
  });

  it.each(['http://api.example.test', 'http://8.8.8.8:5000', 'http://172.32.0.1', 'ftp://127.0.0.1'])(
    'verbietet %s – Tokens nie unverschlüsselt ins Internet',
    (baseUrl) => {
      expect(() => configureApiClient({ baseUrl, getAccessToken: () => undefined })).toThrow(/Basisadresse/);
    },
  );

  it('verbietet ungültige Adressen', () => {
    expect(() => configureApiClient({ baseUrl: 'kein url', getAccessToken: () => undefined })).toThrow(
      /Basisadresse/,
    );
  });
});
