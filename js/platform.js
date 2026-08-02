// True only inside the Capacitor-wrapped Android app; false everywhere else
// (served via serve.js, opened directly, any other host, or plain Node — dem.js
// is imported directly by the Node test suite, which has no `window` at all).
// Everything that forks on this must leave the false branch byte-identical to
// pre-Android behaviour.
export const NATIVE = typeof window !== 'undefined' &&
  window.Capacitor?.isNativePlatform?.() === true;
