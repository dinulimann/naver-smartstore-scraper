/**
 * Diagnostic scraper: runs one scrape attempt against one proxy and saves a
 * full artifact bundle regardless of outcome — so a failure never needs a
 * re-run just to find out what page was actually received, and timing is
 * captured precisely enough to tell "no response at all" apart from "a real,
 * slow response arrived after our own timeout".
 *
 * Saves to logs/<timestamp>/:
 *   meta.json       - proxy used, full timing breakdown, status, page type,
 *                      error (if any)
 *   request.json    - the exact request config (UA, viewport, proxy host)
 *   headers.json    - response headers
 *   cookies.json    - cookies present in the browser context after navigation
 *   response.html   - first 20KB of the raw HTML response
 *   response.png    - screenshot (best-effort; empty/blank if the page never
 *                      got far enough to render anything)
 *
 * Usage:
 *   npx tsx scripts/scrape-with-artifacts.ts --url <productUrl> --proxy host:port:user:pass --label success-case-1
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'patchright';
import { randomFingerprint } from '../src/fingerprint';
import { classifyFailurePage } from '../src/scraper';
import { config } from '../src/config';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : fallback;
  };
  return {
    url: get('--url', 'https://smartstore.naver.com/soo8099/products/5066189639')!,
    proxy: get('--proxy'),
    label: get('--label', 'run'),
  };
}

function parseProxy(raw: string) {
  const parts = raw.split(':');
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    return { host, port, username, password };
  }
  const [host, port] = parts;
  return { host, port, username: undefined, password: undefined };
}

async function main() {
  const { url, proxy: proxyRaw, label } = parseArgs();
  if (!proxyRaw) {
    console.error('Wajib kasih --proxy host:port:user:pass');
    process.exit(1);
  }
  const proxy = parseProxy(proxyRaw);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('logs', `${timestamp}_${label}`);
  mkdirSync(dir, { recursive: true });

  const meta: Record<string, unknown> = {
    url,
    proxyHost: proxy.host,
    proxyPort: proxy.port,
    startedAt: new Date().toISOString(),
    navigationTimeoutMs: config.navigationTimeoutMs,
  };

  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const majorVersion = browser.version().split('.')[0];
  const fp = randomFingerprint(majorVersion);

  meta.chromeVersion = browser.version();
  meta.userAgent = fp.userAgent;
  meta.viewport = fp.viewport;

  const context = await browser.newContext({
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    proxy: { server: `${proxy.host}:${proxy.port}`, username: proxy.username, password: proxy.password },
  });
  const page = await context.newPage();

  // Timing breakdown, not just a pass/fail boolean — the whole point of this
  // tool is to tell "no response at all" apart from "a real, slow response".
  const navStart = Date.now();
  let responseAtMs: number | undefined;
  let responseStatus: number | undefined;
  let responseHeaders: Record<string, string> = {};
  page.once('response', (res) => {
    responseAtMs = Date.now() - navStart;
    responseStatus = res.status();
    responseHeaders = res.headers();
  });

  try {
    let navigationError: unknown;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs });
      meta.timeToDomContentLoadedMs = Date.now() - navStart;
    } catch (err) {
      navigationError = err;
    }

    meta.timeToResponseMs = responseAtMs;
    meta.status = responseStatus;
    meta.finalUrl = page.url();

    if (navigationError && responseAtMs === undefined) {
      // Genuinely nothing came back — different from a slow-but-real response.
      meta.outcome = 'NETWORK_TIMEOUT_NO_RESPONSE';
      meta.error = navigationError instanceof Error ? navigationError.message : String(navigationError);
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      await browser.close();
      console.log(`[${meta.outcome}] disimpan di ${dir}`);
      console.log(JSON.stringify(meta, null, 2));
      return;
    }

    meta.title = await page.title();
    await new Promise((r) => setTimeout(r, 800));

    writeFileSync(join(dir, 'headers.json'), JSON.stringify(responseHeaders, null, 2));

    const cookies = await context.cookies();
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify(cookies, null, 2));

    const html = await page.content();
    writeFileSync(join(dir, 'response.html'), html.slice(0, 20_000));
    meta.htmlLength = html.length;
    meta.hasPreloadedState = html.includes('__PRELOADED_STATE__');
    if (!meta.hasPreloadedState) {
      meta.pageType = classifyFailurePage(html, page.url(), { status: responseStatus, timeToResponseMs: responseAtMs });
    }

    await page.screenshot({ path: join(dir, 'response.png'), fullPage: false }).catch(() => undefined);

    meta.outcome = meta.hasPreloadedState ? 'SUCCESS' : 'FAILED_NO_STATE';
  } catch (err) {
    meta.outcome = 'ERROR';
    meta.error = err instanceof Error ? err.message : String(err);
  }

  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(
    join(dir, 'request.json'),
    JSON.stringify({ url, proxy: { host: proxy.host, port: proxy.port }, userAgent: fp.userAgent, viewport: fp.viewport, chromeVersion: meta.chromeVersion }, null, 2),
  );

  await browser.close();

  console.log(`[${meta.outcome}] disimpan di ${dir}`);
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
