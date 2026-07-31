/**
 * "Gold standard" new-proxy evaluation protocol (per external review):
 * four cheap, well-isolated checks give more information than dozens of
 * random attempts, because each one holds a specific variable constant
 * against a known-different one.
 *
 *   1. curl            -> status, response time (non-browser baseline)
 *   2. Chrome manual    -> printed as manual instructions (can't automate a human)
 *   3. Playwright       -> channel:'chrome', same target, same proxy
 *   4. Same sticky IP, 24h later -> re-run this exact command tomorrow
 *
 * This script automates 1 and 3, prints setup instructions for 2, and
 * prints the exact re-run command for 4. It does not modify the proxy
 * string's session syntax — pass whatever sticky-session format the new
 * provider actually documents (Decodo's is
 * `user-<username>-session-<id>-sessionduration-<minutes>`, but this
 * varies by provider).
 *
 * Usage:
 *   npx tsx scripts/gold-standard-eval.ts --proxy host:port:user:pass [--url productUrl] [--label some-note]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'patchright';
import { randomFingerprint } from '../src/fingerprint';
import { classifyFailurePage } from '../src/scraper';

const execFileAsync = promisify(execFile);

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : fallback;
  };
  return {
    url: get('--url', 'https://smartstore.naver.com/soo8099/products/5066189639')!,
    proxyRaw: get('--proxy'),
    label: get('--label', 'eval'),
  };
}

function parseProxy(raw: string) {
  const parts = raw.split(':');
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    return { host, port, username, password };
  }
  const [host, port] = parts;
  return { host, port };
}

function proxyUrlForCurl(p: ReturnType<typeof parseProxy>): string {
  return p.username && p.password ? `${p.username}:${p.password}@${p.host}:${p.port}` : `${p.host}:${p.port}`;
}

async function step1Curl(p: ReturnType<typeof parseProxy>, url: string) {
  console.log('\n=== Langkah 1: curl (baseline non-browser) ===');
  try {
    const { stdout } = await execFileAsync('curl', [
      '-s', '-x', proxyUrlForCurl(p), '-m', '20',
      '-w', '\n__META__%{http_code}|%{time_total}',
      url,
    ], { maxBuffer: 10 * 1024 * 1024 });
    const idx = stdout.lastIndexOf('__META__');
    const meta = stdout.slice(idx).match(/__META__(\d+)\|([\d.]+)/);
    if (meta) {
      console.log(`  status: ${meta[1]}, waktu: ${meta[2]}s`);
      return { status: meta[1], timeSec: meta[2] };
    }
    console.log('  gagal parse hasil curl');
    return null;
  } catch (err) {
    console.log(`  curl gagal: ${(err as Error).message.slice(0, 150)}`);
    return null;
  }
}

function step2ChromeInstructions(p: ReturnType<typeof parseProxy>, url: string) {
  console.log('\n=== Langkah 2: Chrome manual (jalankan sendiri) ===');
  console.log('Jalankan ini di terminal untuk buka Chrome lewat proxy ini:');
  console.log(`\n  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\`);
  console.log(`    --proxy-server="${p.host}:${p.port}" \\`);
  console.log(`    --user-data-dir="$HOME/gold-standard-eval-profile" \\`);
  console.log(`    "${url}"\n`);
  if (p.username) {
    console.log(`  Kalau muncul popup login proxy, isi:`);
    console.log(`    Username: ${p.username}`);
    console.log(`    Password: ${p.password}\n`);
  }
  console.log('  Catat: halaman apa yang muncul (produk asli / CAPTCHA / login-wall / system-error).');
}

async function step3Playwright(p: ReturnType<typeof parseProxy>, url: string) {
  console.log('\n=== Langkah 3: Playwright (channel: chrome) ===');
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const majorVersion = browser.version().split('.')[0];
  const fp = randomFingerprint(majorVersion);
  const context = await browser.newContext({
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    proxy: { server: `${p.host}:${p.port}`, username: p.username, password: p.password },
  });
  const page = await context.newPage();
  let status: number | undefined;
  page.once('response', (res) => { status = res.status(); });
  const start = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    // fall through
  }
  const elapsed = Date.now() - start;
  await new Promise((r) => setTimeout(r, 800));
  const html = await page.content().catch(() => '');
  const pageType = html.includes('__PRELOADED_STATE__') ? 'SUCCESS' : classifyFailurePage(html, page.url(), { status });
  await browser.close();
  console.log(`  hasil: ${pageType} (status ${status}, ${elapsed}ms)`);
  return { pageType, status, elapsedMs: elapsed };
}

function step4Instructions(proxyRaw: string, url: string, label: string) {
  console.log('\n=== Langkah 4: ulangi 24 jam lagi (IP sticky yang sama) ===');
  console.log('Jalankan command yang sama persis besok untuk membandingkan:');
  console.log(`\n  npx tsx scripts/gold-standard-eval.ts --proxy "${proxyRaw}" --url "${url}" --label "${label}-day2"\n`);
  console.log('  (asumsikan proxy ini pakai sticky session yang bertahan >24 jam — cek dokumentasi provider-nya)');
}

async function main() {
  const { url, proxyRaw, label } = parseArgs();
  if (!proxyRaw) {
    console.error('Wajib kasih --proxy host:port:user:pass');
    process.exit(1);
  }
  const p = parseProxy(proxyRaw);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('logs', `${timestamp}_gold-standard-${label}`);
  mkdirSync(dir, { recursive: true });

  const curlResult = await step1Curl(p, url);
  step2ChromeInstructions(p, url);
  const playwrightResult = await step3Playwright(p, url);
  step4Instructions(proxyRaw, url, label ?? 'eval');

  writeFileSync(join(dir, 'results.json'), JSON.stringify({ url, proxy: `${p.host}:${p.port}`, curlResult, playwrightResult }, null, 2));
  console.log(`\nHasil (langkah 1 & 3) disimpan di ${dir}/results.json`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
