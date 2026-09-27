import { defineConfig } from 'vitest/config';

// Unit-Tests der API-Schicht und der Werkzeuge (Node-Umgebung, ohne React Native).
// Komponententests der App folgen mit M1.6 (jest-expo). Als .mts, weil das Expo-Projekt
// kein "type": "module" setzt und die Vitest-Konfiguration als ES-Modul geladen wird.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
