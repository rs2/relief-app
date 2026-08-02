// Populates www/ — Capacitor's webDir — with only the real app files.
// serve.js keeps serving straight from the repo root, unaffected; this is purely
// for the Android build, since Capacitor copies webDir wholesale into the APK's
// assets with no ignore mechanism (would otherwise bundle .git, node_modules,
// test/, tilecache/, serve.js itself).

import { cp, rm, mkdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const WWW = new URL('../www/', import.meta.url);
const ENTRIES = ['index.html', 'css', 'js', 'vendor'];

await rm(WWW, { recursive: true, force: true });
await mkdir(WWW, { recursive: true });
for (const e of ENTRIES) await cp(new URL(e, ROOT), new URL(e, WWW), { recursive: true });

console.log(`www/ rebuilt from: ${ENTRIES.join(', ')}`);
