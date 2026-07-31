/**
 * Experiment: does arriving at the target product via a plausible human
 * journey (naver.com search -> shopping tab -> click a product -> dwell ->
 * navigate to target) get treated differently than a cold, direct
 * `page.goto(targetUrl)`? Each arm uses its own previously-unused proxy
 * session so neither arm's IP is exhausted by the other's requests — the
 * direct-IP tests earlier today showed a heavily-reused IP alone is enough
 * to explain a fast rate-limit, independent of navigation style.
 *
 * Every step is defensive (try/catch + screenshot) because the DOM
 * selectors for naver.com/shopping are guesses, not verified in advance —
 * a broken step is itself useful information (saved to logs/), not treated
 * as a silent failure.
 *
 * Usage:
 *   npx tsx scripts/experiment-navigation-journey.ts --direct-proxy host:port:user:pass --journey-proxy host:port:user:pass [--url productUrl] [--keyword "무선 이어폰"]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { Page } from 'patchright';
import { randomFingerprint } from '../src/fingerprint';
import { classifyFailurePage } from '../src/scraper';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : fallback;
  };
  return {
    url: get('--url', 'https://smartstore.naver.com/soo8099/products/5066189639')!,
    keyword: get('--keyword', '무선 이어폰')!,
    directProxyRaw: get('--direct-proxy'),
    journeyProxyRaw: get('--journey-proxy'),
  };
}

function parseProxy(raw?: string) {
  if (!raw) return undefined;
  const parts = raw.split(':');
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    return { server: `${host}:${port}`, username, password };
  }
  const [host, port] = parts;
  return { server: `${host}:${port}` };
}

function classifyPage(html: string, finalUrl: string, status: number | undefined): string {
  if (html.includes('__PRELOADED_STATE__')) return 'SUCCESS';
  return classifyFailurePage(html, finalUrl, { status });
}

async function snap(page: Page, dir: string, label: string) {
  await page.screenshot({ path: join(dir, `${label}.png`) }).catch(() => undefined);
}

async function runDirect(fp: ReturnType<typeof randomFingerprint>, proxy: ReturnType<typeof parseProxy>, url: string, dir: string) {
  console.log('\n=== Arm A: direct goto(target) ===');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ userAgent: fp.userAgent, viewport: fp.viewport, proxy });
  const page = await context.newPage();
  let status: number | undefined;
  page.once('response', (res) => { status = res.status(); });
  const start = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    console.log('  nav error:', (err as Error).message.slice(0, 120));
  }
  const elapsed = Date.now() - start;
  await new Promise((r) => setTimeout(r, 800));
  const html = await page.content().catch(() => '');
  await snap(page, dir, 'direct-final');
  const pageType = classifyPage(html, page.url(), status);
  await browser.close();
  console.log(`  result: ${pageType} (status ${status}, ${elapsed}ms)`);
  return { arm: 'direct', status, elapsedMs: elapsed, finalUrl: page.url(), pageType };
}

async function runJourney(fp: ReturnType<typeof randomFingerprint>, proxy: ReturnType<typeof parseProxy>, url: string, keyword: string, dir: string) {
  console.log('\n=== Arm B: naver.com search -> shopping tab -> click product -> dwell -> target ===');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ userAgent: fp.userAgent, viewport: fp.viewport, proxy });
  const page = await context.newPage();
  const steps: Record<string, string> = {};

  try {
    await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    steps.step1_naver_home = 'ok';
    await snap(page, dir, '1-naver-home');
  } catch (err) {
    steps.step1_naver_home = `failed: ${(err as Error).message.slice(0, 120)}`;
  }

  try {
    await page.fill('#query', keyword, { timeout: 5000 });
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    steps.step2_search = 'ok';
    await snap(page, dir, '2-search-results');
  } catch (err) {
    steps.step2_search = `failed: ${(err as Error).message.slice(0, 120)}`;
  }

  await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));

  try {
    const shoppingLink = page.locator('a[href*="shopping.naver.com"]').first();
    await shoppingLink.click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    steps.step3_click_shopping_tab = `ok -> ${page.url()}`;
    await snap(page, dir, '3-shopping-tab');
  } catch (err) {
    steps.step3_click_shopping_tab = `failed: ${(err as Error).message.slice(0, 120)}`;
  }

  await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));

  try {
    const productLink = page.locator('a[href*="smartstore.naver.com"], a[href*="/products/"]').first();
    await productLink.click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    steps.step4_click_product = `ok -> ${page.url()}`;
    await snap(page, dir, '4-clicked-product');
  } catch (err) {
    steps.step4_click_product = `failed: ${(err as Error).message.slice(0, 120)}`;
  }

  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

  console.log('  journey steps:', steps);

  let status: number | undefined;
  page.once('response', (res) => { status = res.status(); });
  const start = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, referer: page.url() });
  } catch (err) {
    console.log('  final nav error:', (err as Error).message.slice(0, 120));
  }
  const elapsed = Date.now() - start;
  await new Promise((r) => setTimeout(r, 800));
  const html = await page.content().catch(() => '');
  await snap(page, dir, '5-target-final');
  const pageType = classifyPage(html, page.url(), status);
  const cookies = await context.cookies();
  await browser.close();
  console.log(`  result: ${pageType} (status ${status}, ${elapsed}ms, ${cookies.length} cookies accumulated)`);
  return { arm: 'journey', steps, status, elapsedMs: elapsed, finalUrl: page.url(), pageType, cookieCount: cookies.length };
}

async function main() {
  const { url, keyword, directProxyRaw, journeyProxyRaw } = parseArgs();
  if (!directProxyRaw || !journeyProxyRaw) {
    console.error('Wajib kasih --direct-proxy dan --journey-proxy (masing-masing session fresh yang beda)');
    process.exit(1);
  }
  const directProxy = parseProxy(directProxyRaw);
  const journeyProxy = parseProxy(journeyProxyRaw);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('logs', `${timestamp}_navigation-journey`);
  mkdirSync(dir, { recursive: true });

  const versionProbe = await chromium.launch({ headless: true, channel: 'chrome' });
  const majorVersion = versionProbe.version().split('.')[0];
  await versionProbe.close();
  const fp = randomFingerprint(majorVersion);

  const directResult = await runDirect(fp, directProxy, url, dir);
  const journeyResult = await runJourney(fp, journeyProxy, url, keyword, dir);

  writeFileSync(join(dir, 'results.json'), JSON.stringify({ url, keyword, directResult, journeyResult }, null, 2));

  console.log('\n=== RINGKASAN ===');
  console.log(`Direct:  ${directResult.pageType} (status ${directResult.status})`);
  console.log(`Journey: ${journeyResult.pageType} (status ${journeyResult.status})`);
  console.log(`\nDetail disimpan di ${dir}/`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
