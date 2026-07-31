/**
 * Experiment: does browser state (persistent profile with accumulated
 * cookies/storage vs a brand-new empty context) change Naver's response,
 * holding IP, browser, fingerprint, and target URL constant? Prompted by
 * manual testing showing two different real-Chrome sessions on two
 * different networks got two different challenge types (system-error vs
 * login-wall) with zero automation involved — suggesting IP/session state,
 * not fingerprint, may be the dominant signal.
 *
 * Caveat this does NOT control for: the two arms still run sequentially
 * from the same IP, so by the time Arm B runs, that IP has made more total
 * requests in this run than when Arm A ran. Order is deliberately ephemeral
 * -> persistent so the ephemeral baseline sees the freshest possible IP
 * state, but this is a real confound, not a fully isolated variable.
 *
 * Usage:
 *   npx tsx scripts/experiment-persistent-vs-ephemeral.ts [--url <productUrl>] [--proxy host:port:user:pass]
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
    proxyRaw: get('--proxy'),
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

interface Outcome {
  label: string;
  status?: number;
  finalUrl: string;
  cookieCountBeforeNav: number;
  pageType: string;
  timestamp: string;
}

function classifyPage(html: string, finalUrl: string, status: number | undefined): string {
  if (html.includes('__PRELOADED_STATE__')) return 'SUCCESS';
  return classifyFailurePage(html, finalUrl, { status });
}

async function navigateAndClassify(page: Page, url: string, label: string, cookieCountBeforeNav: number): Promise<Outcome> {
  let status: number | undefined;
  page.once('response', (res) => {
    status = res.status();
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    // fall through — classify whatever actually came back, if anything
  }
  await new Promise((r) => setTimeout(r, 800));
  const html = await page.content().catch(() => '');
  const pageType = classifyPage(html, page.url(), status);
  return { label, status, finalUrl: page.url(), cookieCountBeforeNav, pageType, timestamp: new Date().toISOString() };
}

async function main() {
  const { url, proxyRaw } = parseArgs();
  const proxy = parseProxy(proxyRaw);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('logs', `${timestamp}_persistent-vs-ephemeral`);
  mkdirSync(dir, { recursive: true });
  const profileDir = join(dir, 'profile');

  // Shared fingerprint across both arms — the variable under test is browser
  // state (persistent profile vs brand-new context), not UA/viewport.
  const versionProbe = await chromium.launch({ headless: true, channel: 'chrome' });
  const chromeVersion = versionProbe.version();
  const majorVersion = chromeVersion.split('.')[0];
  await versionProbe.close();
  const fp = randomFingerprint(majorVersion);

  const results: Outcome[] = [];

  console.log('=== Arm A: ephemeral context (baru, tanpa histori) ===');
  const browserA = await chromium.launch({ headless: true, channel: 'chrome' });
  const contextA = await browserA.newContext({ userAgent: fp.userAgent, viewport: fp.viewport, proxy });
  const pageA = await contextA.newPage();
  const cookiesBeforeA = await contextA.cookies();
  const outcomeA = await navigateAndClassify(pageA, url, 'ephemeral', cookiesBeforeA.length);
  console.log(outcomeA);
  results.push(outcomeA);
  await browserA.close();

  console.log('\n=== Warm-up: persistent profile browsing naver.com -> smartstore homepage ===');
  const contextB = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: 'chrome',
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    proxy,
  });
  const warmupPage = await contextB.newPage();
  for (const warmupUrl of ['https://www.naver.com', 'https://smartstore.naver.com']) {
    try {
      await warmupPage.goto(warmupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(`  visited ${warmupUrl} -> ${warmupPage.url()}`);
    } catch (err) {
      console.log(`  visit ${warmupUrl} failed: ${(err as Error).message.slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
  }

  console.log('\n=== Arm B: persistent context (sudah dihangatkan) ===');
  const cookiesBeforeB = await contextB.cookies();
  const outcomeB = await navigateAndClassify(warmupPage, url, 'persistent-warmed', cookiesBeforeB.length);
  console.log(outcomeB);
  results.push(outcomeB);
  await contextB.close();

  writeFileSync(
    join(dir, 'results.json'),
    JSON.stringify({ url, proxy: proxy?.server, chromeVersion, userAgent: fp.userAgent, results }, null, 2),
  );

  console.log(`\nHasil disimpan di ${dir}/results.json`);
  console.log('\n=== RINGKASAN ===');
  console.log(`Ephemeral:  ${outcomeA.pageType} (status ${outcomeA.status}, cookies sebelum nav: ${outcomeA.cookieCountBeforeNav})`);
  console.log(`Persistent: ${outcomeB.pageType} (status ${outcomeB.status}, cookies sebelum nav: ${outcomeB.cookieCountBeforeNav})`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
