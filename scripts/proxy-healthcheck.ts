/**
 * Proxy quality triage — run this BEFORE spending a Naver/Playwright attempt
 * on a given proxy. Separates "is this proxy even reaching Naver's network
 * at all" from "what does Naver's anti-bot system think of it", which
 * earlier ad-hoc testing kept conflating (a dead/slow proxy silently
 * misread as "Naver blocked us", and vice versa).
 *
 * Uses curl (not Playwright) deliberately for the connectivity checks —
 * this step isn't testing Naver's bot-detection response, just whether the
 * proxy can route to Naver's network at all, and a browser-fingerprint
 * confound would muddy that.
 *
 * For each proxy:
 *   1. https://ifconfig.me                    -> exit IP
 *   2. http://ip-api.com/json/<exitIP>        -> ASN/ISP/city/country/reverse
 *      DNS for that IP (queried directly, not through the proxy)
 *   3. https://www.google.com                 -> general internet baseline
 *   4. https://www.naver.com                  -> can it reach Naver's network
 *   5. the actual target SmartStore URL       -> classified via classifyFailurePage
 *
 * Verdict:
 *   GOOD    - Google reachable AND got *some* HTTP response from both Naver
 *             and the target (even 490/429 counts as "reached" — this
 *             step isn't judging Naver's response, just connectivity)
 *   DISCARD - Google failed (proxy itself is broken) or Naver/target timed
 *             out with zero response (proxy can't route there)
 *
 * Usage:
 *   npx tsx scripts/proxy-healthcheck.ts --proxies host:port:user:pass,host:port:user:pass,...
 *   npx tsx scripts/proxy-healthcheck.ts --proxies-file proxies.txt   # one per line
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFailurePage } from '../src/scraper';

const execFileAsync = promisify(execFile);

interface ProxyCreds {
  host: string;
  port: string;
  username?: string;
  password?: string;
  raw: string;
  label: string;
}

function parseProxy(raw: string): ProxyCreds {
  const parts = raw.split(':');
  const sessionMatch = raw.match(/session-([a-z0-9]+)/i);
  const label = sessionMatch ? sessionMatch[1] : raw.split('@').pop()?.slice(0, 12) ?? raw.slice(0, 12);
  if (parts.length === 4) {
    const [host, port, username, password] = parts;
    return { host, port, username, password, raw, label };
  }
  const [host, port] = parts;
  return { host, port, raw, label };
}

function proxyUrl(p: ProxyCreds): string {
  return p.username && p.password ? `${p.username}:${p.password}@${p.host}:${p.port}` : `${p.host}:${p.port}`;
}

interface CurlResult {
  ok: boolean;
  httpCode: string;
  timeTotalMs: number;
  httpVersion: string;
  error?: string;
}

async function curlThroughProxy(px: ProxyCreds, url: string, timeoutSec: number, bodyPath?: string): Promise<CurlResult> {
  const args = ['-s', '-x', proxyUrl(px), '-m', String(timeoutSec), '-w', '__META__%{http_code}|%{time_total}|%{http_version}'];
  if (bodyPath) args.push('-o', bodyPath);
  args.push(url);
  try {
    const { stdout } = await execFileAsync('curl', args, { timeout: (timeoutSec + 5) * 1000, maxBuffer: 20 * 1024 * 1024 });
    const idx = stdout.lastIndexOf('__META__');
    const metaStr = idx >= 0 ? stdout.slice(idx) : stdout;
    const m = metaStr.match(/__META__(\d+)\|([\d.]+)\|([\d.]+)/);
    if (!m) return { ok: false, httpCode: '000', timeTotalMs: timeoutSec * 1000, httpVersion: '', error: 'unparseable curl output' };
    const httpCode = m[1];
    return { ok: httpCode !== '000', httpCode, timeTotalMs: Math.round(parseFloat(m[2]) * 1000), httpVersion: m[3] };
  } catch (err) {
    return { ok: false, httpCode: '000', timeTotalMs: timeoutSec * 1000, httpVersion: '', error: (err as Error).message.slice(0, 150) };
  }
}

async function lookupIpInfo(ip: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync('curl', ['-s', '-m', '10', `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,as,reverse,query`]);
    return JSON.parse(stdout);
  } catch {
    return {};
  }
}

interface ProxyReport {
  label: string;
  exitIp?: string;
  asn?: string;
  isp?: string;
  org?: string;
  city?: string;
  country?: string;
  reverseDns?: string;
  google: CurlResult;
  naver: CurlResult;
  target: CurlResult;
  targetPageType?: string;
  verdict: 'GOOD' | 'DISCARD';
}

async function checkOneProxy(raw: string, targetUrl: string, dir: string): Promise<ProxyReport> {
  const px = parseProxy(raw);
  console.log(`\n=== Proxy ${px.label} ===`);

  const ipRes = await curlThroughProxy(px, 'https://ifconfig.me', 10);
  let exitIp: string | undefined;
  if (ipRes.ok) {
    const bodyPath = join(dir, `${px.label}-ip.txt`);
    await curlThroughProxy(px, 'https://ifconfig.me', 10, bodyPath);
    exitIp = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8').trim() : undefined;
  }
  console.log(`  exit IP: ${exitIp ?? '(gagal dapat IP)'}`);

  const info = exitIp ? await lookupIpInfo(exitIp) : {};

  const google = await curlThroughProxy(px, 'https://www.google.com', 10);
  console.log(`  google.com: ${google.ok ? `${google.httpCode} in ${google.timeTotalMs}ms (${google.httpVersion})` : `GAGAL (${google.error})`}`);

  const naver = await curlThroughProxy(px, 'https://www.naver.com', 15);
  console.log(`  naver.com:  ${naver.ok ? `${naver.httpCode} in ${naver.timeTotalMs}ms (${naver.httpVersion})` : `GAGAL (${naver.error})`}`);

  const targetBodyPath = join(dir, `${px.label}-target.html`);
  const target = await curlThroughProxy(px, targetUrl, 20, targetBodyPath);
  let targetPageType: string | undefined;
  if (target.ok && existsSync(targetBodyPath)) {
    const html = readFileSync(targetBodyPath, 'utf8');
    targetPageType = html.includes('__PRELOADED_STATE__') ? 'SUCCESS' : classifyFailurePage(html, targetUrl, { status: Number(target.httpCode) });
  }
  console.log(`  target:     ${target.ok ? `${target.httpCode} in ${target.timeTotalMs}ms -> ${targetPageType}` : `GAGAL (${target.error})`}`);

  const verdict: 'GOOD' | 'DISCARD' = google.ok && naver.ok && target.ok ? 'GOOD' : 'DISCARD';
  console.log(`  VERDICT: ${verdict}`);

  return {
    label: px.label,
    exitIp,
    asn: info.as,
    isp: info.isp,
    org: info.org,
    city: info.city,
    country: info.country,
    reverseDns: info.reverse,
    google,
    naver,
    target,
    targetPageType,
    verdict,
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const targetUrl = get('--url') ?? 'https://smartstore.naver.com/soo8099/products/5066189639';
  const proxiesRaw = get('--proxies');
  const proxiesFile = get('--proxies-file');
  let proxies: string[] = [];
  if (proxiesRaw) proxies = proxiesRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (proxiesFile) proxies = readFileSync(proxiesFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  return { targetUrl, proxies };
}

async function main() {
  const { targetUrl, proxies } = parseArgs();
  if (proxies.length === 0) {
    console.error('Wajib kasih --proxies host:port:user:pass,... atau --proxies-file path');
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('logs', `${timestamp}_proxy-healthcheck`);
  mkdirSync(dir, { recursive: true });

  const reports: ProxyReport[] = [];
  for (const raw of proxies) {
    reports.push(await checkOneProxy(raw, targetUrl, dir));
  }

  writeFileSync(join(dir, 'report.json'), JSON.stringify(reports, null, 2));

  console.log('\n\n=== RINGKASAN ===');
  console.log('label            | verdict | exitIp           | ASN                          | city/country     | google(ms) | naver(ms) | target(status/ms/type)');
  for (const r of reports) {
    console.log(
      `${r.label.padEnd(16)} | ${r.verdict.padEnd(7)} | ${(r.exitIp ?? '-').padEnd(16)} | ${(r.asn ?? '-').slice(0, 28).padEnd(28)} | ${`${r.city ?? '-'}/${r.country ?? '-'}`.padEnd(16)} | ${(r.google.ok ? r.google.timeTotalMs : 'FAIL').toString().padEnd(10)} | ${(r.naver.ok ? r.naver.timeTotalMs : 'FAIL').toString().padEnd(9)} | ${r.target.ok ? `${r.target.httpCode}/${r.target.timeTotalMs}ms/${r.targetPageType}` : 'FAIL'}`,
    );
  }
  console.log(`\nDetail lengkap disimpan di ${dir}/report.json`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
