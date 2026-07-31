// User-Agent claims an OS, but `navigator.platform` and WebGL's renderer
// string always reveal the *real* host OS regardless of what the UA string
// says — Playwright's `userAgent` context option doesn't touch either of
// those. Randomly picking a UA across Windows/Mac/Linux therefore risks an
// impossible combination no real browser could produce (e.g. UA claims
// Linux while navigator.platform says "MacIntel" and WebGL says "Apple
// M1" — exactly what this pool used to generate on this machine). Fix:
// key the UA to the *actual* host platform via `process.platform`, so it
// always agrees with what the browser leaks natively.
const UA_BY_PLATFORM: Record<string, (version: string) => string> = {
  darwin: (v) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
  win32: (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
  linux: (v) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
};

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface Fingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
}

/** @param chromeMajorVersion e.g. "150" — the real running browser's major version. */
export function randomFingerprint(chromeMajorVersion: string): Fingerprint {
  const uaBuilder = UA_BY_PLATFORM[process.platform] ?? UA_BY_PLATFORM.linux;
  return {
    userAgent: uaBuilder(chromeMajorVersion),
    viewport: pick(VIEWPORTS),
  };
}
