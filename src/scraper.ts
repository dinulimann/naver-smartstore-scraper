import { chromium } from 'patchright';
import type { Browser, BrowserContext } from 'patchright';

// Patchright is a patched, undetected drop-in replacement for Playwright —
// it patches CDP-level automation leaks (chrome.runtime, navigator.webdriver,
// and other CDP-injected artifacts) at the driver level, so no separate
// stealth plugin is layered on top here.
import { config } from './config';
import { ProxyManager } from './proxyManager';
import { randomFingerprint } from './fingerprint';
import { randomDelay } from './throttle';
import { ScrapeError } from './errors';
import { validateSmartstoreUrl } from './validateUrl';
import { solveCaptchaIfPresent } from './captchaSolver';

export { ScrapeError } from './errors';

// Lazy so this module can be imported (e.g. by server.ts) without requiring
// PROXIES to be set when the ScrapingBee backend is the one actually in use.
let proxyManager: ProxyManager | undefined;
function getProxyManager(): ProxyManager {
  if (!proxyManager) proxyManager = new ProxyManager();
  return proxyManager;
}

// Matches the inline `window.__PRELOADED_STATE__={...};` script SmartStore
// server-renders into the page. Extracted from the raw HTML rather than via
// page.evaluate() in the browser: the app reads this global during its own
// hydration and then deletes it, so evaluating it live races against that
// cleanup and can return undefined even on a fully successful page load.
const PRELOADED_STATE_PATTERN = /window\.__PRELOADED_STATE__\s*=\s*(\{.*?\});?\s*<\/script>/s;

export interface FailureContext {
  status?: number;
  /** Elapsed ms between navigation start and the first response event. */
  timeToResponseMs?: number;
}

// Instrumented logging (request/response event timestamps) showed a real
// Naver response arriving ~20.3s into one request, well past a naive
// timeout. Whether that specific delay is an intentional anti-bot tarpit,
// an edge-side challenge computation, or ordinary path/proxy latency isn't
// established from one observation — flagged as a modifier on the actual
// page-content classification below, not asserted as its own cause.
const SLOW_RESPONSE_THRESHOLD_MS = 8000;

// Naver's protection has multiple distinct response types on failure, not
// one generic "blocked" page — discovered by actually inspecting saved HTML
// instead of only logging "not found" (see scripts/scrape-with-artifacts.ts
// and the README's hypothesis log). Classifying which one occurred turns a
// dead-end error message into an actionable diagnosis without needing to
// reproduce the failure to find out what page was actually received.
export function classifyFailurePage(html: string, finalUrl: string, ctx: FailureContext = {}): string {
  const isSlow = ctx.timeToResponseMs !== undefined && ctx.timeToResponseMs > SLOW_RESPONSE_THRESHOLD_MS;
  const timingNote = ctx.timeToResponseMs !== undefined ? `, response in ${ctx.timeToResponseMs}ms${isSlow ? ' — slow, cause not confirmed' : ''}` : '';

  if (finalUrl.includes('nid.naver.com')) return `login-wall-redirect${timingNote}`;
  if (html.includes('ncpt.naver.com') || html.includes('title="captcha"')) return `captcha-challenge${timingNote}`;
  if (html.includes('운영이 중지')) return `seller-inactive (not a block — store/product genuinely closed)${timingNote}`;
  if (html.includes('상품이 존재하지 않습니다')) return `product-removed (not a block — listing deleted)${timingNote}`;
  if (ctx.status === 429) return `rate-limited-429${timingNote}`;
  if (html.includes('에러페이지') || html.includes('시스템오류')) return `generic-system-error-page${timingNote}`;
  return `unknown-page-shape${timingNote}`;
}

function parsePreloadedState(html: string): unknown {
  const match = html.match(PRELOADED_STATE_PATTERN);
  if (!match) return undefined;

  // The state is serialized as a JS object literal, not strict JSON — it can
  // contain bare `undefined`/`NaN`/`Infinity`, which JSON.parse rejects.
  const sanitized = match[1]
    .replace(/:\s*undefined\b/g, ':null')
    .replace(/:\s*-?Infinity\b/g, ':null')
    .replace(/:\s*NaN\b/g, ':null');
  try {
    return JSON.parse(sanitized);
  } catch (err) {
    // Distinguish "found the script tag but couldn't parse it" from "not
    // found at all" — the former is a real bug worth seeing, not a block page.
    console.error('parsePreloadedState: found __PRELOADED_STATE__ but JSON.parse failed:', err);
    return undefined;
  }
}

async function launchContext(): Promise<{ browser: Browser; context: BrowserContext }> {
  const proxy = getProxyManager().next();

  const browser = await chromium.launch({
    headless: config.headless,
    channel: config.useSystemChrome ? 'chrome' : undefined,
  });

  // Build the fake User-Agent around the *real* running browser's major
  // version. A stale hardcoded version (e.g. claiming Chrome 124 while
  // actually running Chrome 150) creates a detectable mismatch: modern
  // Chrome's Client Hints (`sec-ch-ua`, `navigator.userAgentData`) always
  // report the true version regardless of what the legacy User-Agent
  // header claims, and no genuine browser ever disagrees with itself like
  // that. Templating on the real version keeps every signal consistent.
  const realVersion = browser.version(); // e.g. "150.0.7871.187"
  const majorVersion = realVersion.split('.')[0];
  const fp = randomFingerprint(majorVersion);

  // Deliberately NOT setting `locale` (or an Accept-Language header) here.
  // Testing showed either one — even a "correct" ko-KR value — flips this
  // exact target from a real page load into a login-wall redirect, while
  // leaving locale/headers untouched and only rotating userAgent + viewport
  // loads the real page reliably. Likely cause: Playwright's locale
  // emulation and explicit header injection both go through CDP calls
  // (Emulation.setLocaleOverride / Network.setExtraHTTPHeaders) that a
  // genuine browser session never makes, and this target's protection
  // appears to key off exactly that signal rather than the header's value.
  const context = await browser.newContext({
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    // undefined (no PROXIES configured) means a direct connection — see
    // ProxyManager. Not a fallback-of-last-resort: a residential/mobile IP
    // with no proxy-pool history reached the product page reliably where
    // every exhausted commercial proxy pool tested didn't (row 45).
    proxy: proxy
      ? { server: `${proxy.host}:${proxy.port}`, username: proxy.username, password: proxy.password }
      : undefined,
    // Every observed CAPTCHA solve that actually reached the product page
    // did so on an authenticated session (README hypothesis row 37) — a
    // correctly-solved CAPTCHA on an anonymous session redirected to the
    // login wall instead. Optional: generate with `npm run save-naver-session`.
    storageState: config.naverSessionStatePath,
  });

  // We only need the inline __PRELOADED_STATE__ script tag out of the HTML —
  // images, fonts, stylesheets, and media are pure bandwidth cost with no
  // effect on that. This cuts proxy bandwidth usage and latency substantially
  // on a page this image-heavy.
  await context.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
      return route.abort();
    }
    return route.continue();
  });

  return { browser, context };
}

export async function scrapeProduct(productUrl: string): Promise<unknown> {
  const parsed = validateSmartstoreUrl(productUrl);
  const cleanUrl = parsed.toString();

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    let browser: Browser | undefined;
    try {
      const launched = await launchContext();
      browser = launched.browser;
      const context = launched.context;

      await randomDelay();

      const page = await context.newPage();

      // Track when/whether a response ever arrives, separately from whether
      // page.goto() itself reports success — a slow-but-real response can
      // still arrive after Playwright's own navigation timeout fires, and
      // that's a materially different failure than no response at all
      // (see README: a 20s timeout was once clipping a genuine ~20.3s
      // response and misreporting it as a network timeout).
      const navStart = Date.now();
      let responseAt: number | undefined;
      let responseStatus: number | undefined;
      page.once('response', (res) => {
        responseAt = Date.now();
        responseStatus = res.status();
      });

      // The CAPTCHA challenge (see README hypothesis rows 36-38) fetches its
      // question+image via this endpoint. Captured passively regardless of
      // config.solveCaptcha so classifyFailurePage's reasoning stays cheap;
      // only actually used below if solving is enabled and needed.
      let captchaQuestionPayload: unknown;
      if (config.solveCaptcha) {
        page.on('response', async (res) => {
          if (res.url().includes('receipt/question')) {
            captchaQuestionPayload = await res.json().catch(() => undefined);
          }
        });
      }

      let navigationError: unknown;
      try {
        await page.goto(cleanUrl, {
          waitUntil: 'domcontentloaded',
          timeout: config.navigationTimeoutMs,
        });
      } catch (err) {
        navigationError = err;
      }

      if (navigationError && responseAt === undefined) {
        throw new ScrapeError(
          `Navigation timed out with no response at all after ${config.navigationTimeoutMs}ms (network-timeout-no-response — distinct from a received block/challenge page)`,
          502,
        );
      }

      // Small settle delay: over a proxied connection, 'domcontentloaded'
      // can fire a beat before page.content() reflects the fully-streamed
      // HTML, which intermittently truncated the response right around the
      // inline __PRELOADED_STATE__ script and produced false "not found"
      // results even on genuinely live pages.
      await new Promise((resolve) => setTimeout(resolve, 800));

      let html = await page.content();
      let state = parsePreloadedState(html);

      if (!state && config.solveCaptcha) {
        // Give the challenge script (Service Worker registration, WASM,
        // font probe — see README row 36) a moment to finish and fire the
        // receipt/question request before deciding no CAPTCHA is present.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const solved = await solveCaptchaIfPresent(page, captchaQuestionPayload).catch(() => false);
        if (solved) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          html = await page.content();
          state = parsePreloadedState(html);
        }
      }

      if (!state) {
        const timeToResponseMs = responseAt !== undefined ? responseAt - navStart : undefined;
        const reason = classifyFailurePage(html, page.url(), { status: responseStatus, timeToResponseMs });
        throw new ScrapeError(`__PRELOADED_STATE__ not found (${reason})`, 502);
      }

      await browser.close();
      return state;
    } catch (err) {
      lastError = err;
      if (browser) await browser.close().catch(() => undefined);

      const isLastAttempt = attempt === config.maxRetries;
      if (!isLastAttempt) {
        await randomDelay();
        continue;
      }
    }
  }

  if (lastError instanceof ScrapeError) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ScrapeError(`Failed after ${config.maxRetries} attempts: ${message}`);
}
