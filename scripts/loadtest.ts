/**
 * Drives the running API against a list of product URLs and reports
 * latency + error-rate stats against the challenge's success criteria:
 *   - avg latency <= 6s
 *   - error rate <= 5%
 *
 * Usage:
 *   npm run loadtest -- --file urls.txt --base http://localhost:3000 --concurrency 5
 *
 * urls.txt: one smartstore.naver.com product URL per line.
 */
import { readFileSync } from 'node:fs';

interface Args {
  file: string;
  base: string;
  concurrency: number;
  durationMinutes?: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : fallback;
  };
  return {
    file: get('--file', 'urls.txt')!,
    base: get('--base', 'http://localhost:3000')!,
    concurrency: Number(get('--concurrency', '5')),
    durationMinutes: get('--duration') ? Number(get('--duration')) : undefined,
  };
}

async function worker(
  urls: string[],
  cursorRef: { i: number },
  base: string,
  stats: { latencies: number[]; errors: number; total: number },
  deadline: number,
) {
  while (cursorRef.i < urls.length && Date.now() < deadline) {
    const url = urls[cursorRef.i++];
    const start = Date.now();
    try {
      const res = await fetch(`${base}/naver?productUrl=${encodeURIComponent(url)}`);
      const latency = Date.now() - start;
      stats.latencies.push(latency);
      stats.total++;
      if (!res.ok) stats.errors++;
    } catch {
      stats.latencies.push(Date.now() - start);
      stats.total++;
      stats.errors++;
    }
  }
}

async function main() {
  const { file, base, concurrency, durationMinutes } = parseArgs();
  const urls = readFileSync(file, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  console.log(`Loaded ${urls.length} URLs. Running with concurrency=${concurrency}`);

  const deadline = Date.now() + (durationMinutes ? durationMinutes * 60_000 : Infinity);
  const stats = { latencies: [] as number[], errors: 0, total: 0 };
  const cursorRef = { i: 0 };

  const startedAt = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, () => worker(urls, cursorRef, base, stats, deadline)),
  );
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  const avgLatency = stats.latencies.reduce((a, b) => a + b, 0) / (stats.latencies.length || 1);
  const errorRate = (stats.errors / (stats.total || 1)) * 100;

  console.log('--- Results ---');
  console.log(`Total requests: ${stats.total}`);
  console.log(`Elapsed: ${elapsedSec}s`);
  console.log(`Avg latency: ${(avgLatency / 1000).toFixed(2)}s (target <= 6s)`);
  console.log(`Error rate: ${errorRate.toFixed(2)}% (target <= 5%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
