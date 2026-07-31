import 'dotenv/config';

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

function parseProxyString(raw: string): ProxyConfig {
  const parts = raw.split(':');
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    return { host, port: Number(port), username, password };
  }
  if (parts.length === 2) {
    const [host, port] = parts;
    return { host, port: Number(port) };
  }
  throw new Error(`Invalid proxy string (expected host:port or host:port:user:pass): ${raw}`);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  proxies: (process.env.PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseProxyString),
  minDelayMs: Number(process.env.MIN_DELAY_MS ?? 1500),
  maxDelayMs: Number(process.env.MAX_DELAY_MS ?? 4500),
  concurrency: Number(process.env.CONCURRENCY ?? 3),
  // 30s, not a round-number guess: instrumented logging observed Naver's
  // own block/challenge response arriving at ~20.3s on a slow path — a 20s
  // timeout was clipping that response and misreporting it as a client-side
  // timeout instead of the actual page received. See README hypothesis log.
  navigationTimeoutMs: Number(process.env.NAV_TIMEOUT_MS ?? 30000),
  maxRetries: Number(process.env.MAX_RETRIES ?? 3),
  cacheTtlMs: Number(process.env.CACHE_TTL_MS ?? 60_000),
  headless: (process.env.HEADLESS ?? 'true') !== 'false',
  scrapingBeeApiKey: process.env.SCRAPINGBEE_API_KEY || undefined,
  scrapingBeeCountry: process.env.SCRAPINGBEE_COUNTRY ?? 'kr',
  // Launch the system's real installed Chrome instead of Patchright's
  // bundled Chromium. Measured to produce a JA4 TLS fingerprint identical
  // to genuine human Chrome (vs. a differing one for bundled Chromium) —
  // see README. Off by default since it requires Chrome to actually be
  // installed on the host, which bundled Chromium doesn't.
  useSystemChrome: (process.env.USE_SYSTEM_CHROME ?? 'false') === 'true',
  // Whether to attempt solving the CAPTCHA challenge (OCR-based) when one
  // is served, instead of just failing. See README hypothesis log rows
  // 36-39: the challenge turned out to be a fill-in-the-blank question
  // about text visible in a small receipt-style image, not a fingerprint
  // wall — genuinely solvable with plain OCR (Tesseract), no paid
  // CAPTCHA-solving service needed. Off by default since it requires
  // Tesseract installed on the host (`brew install tesseract`).
  solveCaptcha: (process.env.SOLVE_CAPTCHA ?? 'false') === 'true',
  tesseractPath: process.env.TESSERACT_PATH ?? 'tesseract',
  // Path to a Playwright storageState JSON (cookies + localStorage) from a
  // real, logged-in Naver session. Optional, but every observed success
  // solving the CAPTCHA happened with an authenticated session — an
  // anonymous session that solves the CAPTCHA correctly was observed to
  // redirect to the login wall instead of the product page (row 37).
  // Generate one with `npm run save-naver-session`.
  naverSessionStatePath: process.env.NAVER_SESSION_STATE_PATH || undefined,
};
