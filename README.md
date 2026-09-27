# modulcraft-mobile – Mobile App

Mobile App der Plattform Modul-Craft für die Monteure vor Ort („Mein Tag“, Einsatzdokumentation, Offline-Betrieb): React Native mit Expo und Expo Router ([ADR-005](https://github.com/Crabmann2025/modulcraft-docs/blob/main/docs/adr/ADR-005-technologie-stack.md)).

> **Streng vertraulich.** Ausschließlich synthetische Testdaten – keine echten Personen-, Kunden- oder Betriebsdaten ([ADR-006](https://github.com/Crabmann2025/modulcraft-docs/blob/main/docs/adr/ADR-006-hosting-uebergang.md)).

Eigenständiges Repository im Polyrepo ([ADR-009](https://github.com/Crabmann2025/modulcraft-docs/blob/main/docs/adr/ADR-009-repository-aufteilung-und-api-vertrag.md)). Mit dem Backend ([modulcraft-backend](https://github.com/Crabmann2025/modulcraft-backend)) spricht die App **ausschließlich über den API-Vertrag** `openapi.json`. Architektur, Roadmap und UX-Konzept liegen in [modulcraft-docs](https://github.com/Crabmann2025/modulcraft-docs).

**Stand:** Grundgerüst aus der Expo-Vorlage (SDK 57, Expo Router, zurückgesetzt) mit generiertem API-Client und Tests der API-Schicht (M1.3). Offen für M1.6:
- Anbindung des Clients in der App (`EXPO_PUBLIC_API_BASE_URL`)
- „Mein Tag“ und Offline-Synchronisation
- Lint und Komponententests
- Laufzeittest des Clients auf dem Gerät

## Voraussetzungen

- Node.js ab 22.18 (geprüft mit 22.20)
- Für `npm run sync-api` ohne `--file`: laufendes modulcraft-backend (siehe dessen README)
- Zum Ausprobieren: Expo Go bzw. Android-Emulator oder iOS-Simulator

## Einrichtung

```powershell
npm ci
Copy-Item .env.example .env   # Adressen bei Bedarf anpassen
```

## Befehle

| Zweck | Befehl |
|---|---|
| Expo-Entwicklungsserver | `npm start` (bzw. `npm run android`, `npm run ios`, `npm run web`) |
| Typprüfung (App und Werkzeuge getrennt) | `npm run typecheck` |
| Unit-Tests der API-Schicht | `npm test` |
| API-Vertrag holen und pinnen | `npm run sync-api` bzw. `npm run sync-api -- --file <pfad>` |
| API-Client aus dem gepinnten Vertrag erzeugen | `npm run generate-api` |
| Prüfen, ob der Client zum Vertrag passt (CI) | `npm run check-api` |

## API-Client synchronisieren

Der Client in `src/api/generated/` entsteht ausschließlich aus dem **gepinnten Vertrag** `openapi/openapi.json` – nie direkt vom laufenden Server. Builds (auch in EAS) und CI sind dadurch reproduzierbar und brauchen kein Backend; jede Vertragsänderung erscheint als prüfbarer Diff. Die API-Schicht ist mit der Desktop-Zentrale (modulcraft-web) bewusst identisch.

**Wann?** Sobald das Backend einen geänderten Vertrag (`openapi.json`) committet hat, den die App nutzen soll.

**Ablauf** (PowerShell, im Repo-Root):

```powershell
# 1. Vertrag holen und pinnen – bevorzugt aus dem Backend-Repo (entspricht einem Commit) …
npm run sync-api -- --file ../modulcraft-backend/openapi.json
#    … oder vom laufenden Entwicklungsserver (API_SPEC_URL, Standard http://127.0.0.1:5000/api/openapi.json)
npm run sync-api

# 2. Client erzeugen
npm run generate-api

# 3. Prüfen
npm run typecheck
npm test
```

**Was wird versioniert?** `openapi/openapi.json` und `src/api/generated/` gemeinsam in **einem** Commit, z. B. `chore(api): API-Vertrag auf Stand modulcraft-backend <Commit> aktualisiert`. Beides wird nie von Hand geändert; `npm run check-api` erzeugt den Client neu und schlägt fehl, wenn er vom versionierten Stand abweicht.

**Prüfliste für das Review** (Blick auf den Diff von `openapi/openapi.json`):
- Entfernte oder umbenannte Felder und Operationen?
- Neue Pflichtfelder (`required`) in Anfragen?
- Geänderte Statuscodes oder Fehlerantworten?
- Bei Breaking Changes: betroffene Aufrufer im selben Commit anpassen, `npm run typecheck` findet sie.
- Offline-Betrieb beachten: Geräte arbeiten bis zu einen Arbeitstag mit dem alten Stand ([ADR-003](https://github.com/Crabmann2025/modulcraft-docs/blob/main/docs/adr/ADR-003-offline-synchronisation.md)). Breaking Changes brauchen deshalb eine Übergangszeit im Backend.

**Format:** Die gepinnte Kopie ist inhaltlich identisch mit der `openapi.json` des Backends, aber nicht zwingend byte-gleich: JavaScript ordnet Schlüssel wie Statuscodes (`"200"`, `"422"`) aufsteigend. Ob per Datei oder URL synchronisiert – das Ergebnis ist byte-identisch und damit deterministisch.

### Filter-Logik: keine ungenutzten Typen

1. **An der Quelle:** Das Backend gibt nur Komponenten aus, die von einer Operation erreichbar sind; ein Test dort erzwingt das. Das ungenutzte Schema `PaginationMetadata` von flask-smorest entsteht deshalb gar nicht erst.
2. **Im Generator:** `parser.filters.orphans: false` in `openapi-ts.config.ts` entfernt zusätzlich alles, was keine Operation – auch indirekt über `$ref` – erreicht (`Error` → `ErrorDetail` bleibt also erhalten). Die Regel ist allgemein und braucht keine Namenslisten, die veralten könnten. Sie ist ausdrücklich gesetzt, damit ein Generator-Update das Verhalten nicht still ändert.
3. **Nachweis:** `tests/openapi-filter.test.ts` lässt den echten Generator mit dieser Konfiguration auf einem Vertrag mit absichtlich verwaisten Komponenten laufen – samt Gegenprobe ohne Filter.

## Sicherheitsregeln

- **`sync-api`:**
  - HTTP nur für localhost, sonst HTTPS; keine Weiterleitungen.
  - Zeitlimit 10 s, höchstens 5 MB.
  - Gepinnt wird nur ein Vertrag mit OpenAPI 3.0.x, mindestens einer Operation, dem Schema `bearerAuth` und globaler Anmeldepflicht. Geschrieben wird atomar: Bei einem Fehler bleibt der bisherige Vertrag unverändert.
- **Anmeldung:**
  - `configureApiClient({ baseUrl, getAccessToken })` fragt das Token bei jeder Anfrage beim Aufrufer ab und speichert es nicht.
  - Die sichere Ablage auf dem Gerät (Sicherheitschip) folgt mit Keycloak (M1.4) und `src/security` (M1.6).
- **Basisadresse:**
  - Unverschlüsseltes HTTP ist nur zu localhost und privaten Netzen erlaubt, etwa der Entwicklungsrechner im WLAN.
  - Sonst ist HTTPS Pflicht, damit Tokens nie unverschlüsselt ins Internet gehen.
- **Keine Geheimnisse in der App:** Alles mit `EXPO_PUBLIC_`-Präfix landet im App-Bundle und ist öffentlich.
- **Typen getrennt:** App-Code wird mit der Expo-Konfiguration geprüft (`tsconfig.json`), Werkzeuge und Tests mit `tsconfig.tools.json`. Node-Typen gehören nicht in React-Native-Code.

## Bekannte Punkte

- **`npm audit` meldet 14 Befunde (moderate) aus Expo SDK 57 selbst:**
  - `uuid` im iOS-Konfigurationswerkzeug `xcode`, nur zur Build-Zeit genutzt
  - `decode-uri-component` über `expo-router` → `query-string`, Deep-Link-Parsing, lokaler DoS

  npm schlägt als Lösung eine Herabstufung um mehrere Expo-Hauptversionen vor; das ist unbrauchbar. Die Befunde werden mit der SDK-Aktualisierung in M1.6 bewertet.
- **Override `js-yaml` 4.3.2** (`package.json` → `overrides`):
  - Der YAML-Parser des Generators pinnt `js-yaml` 4.2.0. Für diese Version gibt es drei Advisories.
  - Der Override erzwingt den Patch-Stand derselben Hauptversion.
  - Er entfällt, sobald `@hey-api/openapi-ts` ihn selbst mitbringt.
- **Tests:** Vitest prüft nur die API-Schicht und die Werkzeuge (Node-Umgebung). Die Wahl des Werkzeugs für Komponententests (jest-expo) fällt in M1.6.

## Struktur

```
modulcraft-mobile/
├── openapi/openapi.json      # gepinnter API-Vertrag (Kopie aus modulcraft-backend)
├── openapi-ts.config.ts      # Generator-Konfiguration (@hey-api/openapi-ts, exakt gepinnt)
├── scripts/sync-api.ts       # Vertrag holen, prüfen und atomar pinnen
├── src/
│   ├── app/                  # Bildschirme (Expo Router, dateibasiert) – Platzhalter bis M1.6
│   └── api/
│       ├── index.ts          # öffentliche Schnittstelle – Fachcode importiert nur von hier
│       ├── client.ts         # Basisadresse und Anmeldung
│       └── generated/        # erzeugt, nie von Hand ändern
├── tests/                    # Unit-Tests der API-Schicht, Filter-Nachweis
├── assets/                   # Icons, Splash (Vorlage, wird in M1.6 ersetzt)
└── tsconfig.json / tsconfig.tools.json   # App (Expo) bzw. Werkzeuge und Tests
```

Geplanter Ausbau ab M1.6:
- **`src/app/`:**
  - `unlock.tsx`: Entsperren per Biometrie oder PIN
  - `(day)/index.tsx`: „Mein Tag“
  - `jobs/[jobId]/`: Einsatz öffnen, arbeiten, abschließen
- **`src/`:**
  - `design/`: Themen Hell, Draußen, Dunkel
  - `components/`: handschuhtaugliche Bausteine
  - `features/`: `jobs`, `forms`, `photos`, `defects`, `maintenance`, `asset-tags`
  - `sync/`: Offline-Synchronisation, PowerSync gekapselt
  - `i18n/`
  - `security/`: Schlüsselverwaltung, Entsperren, Offline-Fenster

## Grundsätze

- API-Zugriffe nur über `src/api` (öffentliche Schnittstelle `index.ts`), nie direkt auf `generated/` oder mit eigenem `fetch`.
- Synchronisation ausschließlich über `src/sync` – Features rufen PowerSync nie direkt auf, damit es austauschbar bleibt.
- Nur Bausteine aus `src/components` verwenden (Tippfläche mindestens 56 × 56 dp, Farbe nie alleiniger Informationsträger).
- Texte ausschließlich über `src/i18n` (Deutsch, Englisch); Berichte immer auf Deutsch.
- Gestaltung nach dem [UX-Konzept](https://github.com/Crabmann2025/modulcraft-docs/blob/main/docs/UX-KONZEPT.md); Fachbegriffe nach dem [Glossar](https://github.com/Crabmann2025/modulcraft-docs/blob/main/docs/GLOSSAR.md).
- Code und Bezeichner Englisch, Kommentare und Dokumentation Deutsch.
