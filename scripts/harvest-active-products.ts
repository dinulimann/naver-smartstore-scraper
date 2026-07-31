/**
 * Gently sweeps through a candidate URL list, keeping only the ones that
 * succeed on a SINGLE attempt (no aggressive retries) and skipping failures
 * immediately. Built to slowly accumulate a verified-working dataset without
 * hammering already-failing targets, and to be safe to run intermittently
 * (start, stop, resume) rather than as one long continuous burst.
 *
 * Usage:
 *   npx tsx scripts/harvest-active-products.ts --in discovered_urls_recent.txt --out verified_active.jsonl --delay-ms 4000
 *
 * Appends to --out as it goes (JSONL: one JSON object per line), and writes
 * remaining untried URLs back to --in so a later run picks up where this
 * one left off instead of re-trying URLs already confirmed dead this run.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { chromium } from 'patchright';
import { ProxyManager } from '../src/proxyManager';
import { randomFingerprint } from '../src/fingerprint';

const PRELOADED_STATE_PATTERN = /window\.__PRELOADED_STATE__\s*=\s*(\{.*?\});?\s*<\/script>/s;

function parsePreloadedState(html: string): unknown {
  const match = html.match(PRELOADED_STATE_PATTERN);
  if (!match) return undefined;
  const sanitized = match[1]
    .replace(/:\s*undefined\b/g, ':null')
    .replace(/:\s*-?Infinity\b/g, ':null')
    .replace(/:\s*NaN\b/g, ':null');
  try {
    return JSON.parse(sanitized);
  } catch {
    return undefined;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : fallback;
  };
  return {
    input: get('--in', 'discovered_urls_recent.txt'),
    output: get('--out', 'verified_active.jsonl'),
    delayMs: Number(get('--delay-ms', '4000')),
    limit: Number(get('--limit', '9999999')),
  };
}

async function tryOnce(url: string, proxyManager: ProxyManager): Promise<unknown | undefined> {
  const proxy = proxyManager.next();
  if (!proxy) throw new Error('No proxies configured — set PROXIES in .env for this harvesting script.');
  const browser = await chromium.launch({ headless: true });
  try {
    const majorVersion = browser.version().split('.')[0];
    const fp = randomFingerprint(majorVersion);
    const context = await browser.newContext({
      userAgent: fp.userAgent,
      viewport: fp.viewport,
      proxy: { server: `${proxy.host}:${proxy.port}`, username: proxy.username, password: proxy.password },
    });
    await context.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise((r) => setTimeout(r, 800));
    const html = await page.content();
    return parsePreloadedState(html);
  } catch {
    return undefined;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  const { input, output, delayMs, limit } = parseArgs();
  const urls = readFileSync(input, 'utf-8').split('\n').filter(Boolean).slice(0, limit);
  const proxyManager = new ProxyManager();

  let success = 0;
  let fail = 0;
  const remaining: string[] = [];

  console.log(`Memproses ${urls.length} kandidat, 1 percobaan per URL, jeda ${delayMs}ms...`);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const state = await tryOnce(url, proxyManager);

    if (state) {
      success++;
      appendFileSync(output, JSON.stringify({ url, data: state }) + '\n', 'utf-8');
      console.log(`[${i + 1}/${urls.length}] BERHASIL (total: ${success}) - ${url}`);
    } else {
      fail++;
      remaining.push(url); // simpan buat dicoba lagi lain kali, bukan sekarang
      console.log(`[${i + 1}/${urls.length}] gagal, skip - ${url}`);
    }

    if (i < urls.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Sisa URL yang gagal ditulis balik, biar run berikutnya nggak ngulang yang udah confirmed BERHASIL
  writeFileSync(input, remaining.join('\n') + (remaining.length ? '\n' : ''), 'utf-8');

  console.log(`\nSelesai. Berhasil: ${success}, Gagal (disimpan buat dicoba lagi nanti): ${fail}`);
  console.log(`Hasil tersimpan di ${output}, sisa kandidat di ${input}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
