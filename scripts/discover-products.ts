/**
 * Discovers currently-active SmartStore product URLs using Naver's official
 * Search Shopping API (free, no scraping) — used purely to build a seed list
 * of real, live product URLs to feed into scripts/loadtest.ts, since the
 * brief's own example URLs are dead stores and SmartStore's own search/store
 * pages redirect to a login wall for automated browsing.
 *
 * Setup: register a free app at https://developers.naver.com/apps (Search
 * API), then set NAVER_CLIENT_ID / NAVER_CLIENT_SECRET in .env.
 *
 * Usage:
 *   npx tsx scripts/discover-products.ts --out urls.txt --per-keyword 100
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';

const ENDPOINT = 'https://openapi.naver.com/v1/search/shop.json';

// A spread of everyday Korean product categories — enough variety to surface
// hundreds of distinct, currently-selling SmartStore listings across
// different stores, not just one seller's catalog.
const KEYWORDS = [
  '텀블러', '이어폰', '쿨매트', '선풍기', '캠핑의자', '보조배터리',
  '무선청소기', '노트북거치대', '블루투스스피커', '전기포트', '운동화',
  '백팩', '우산', '마우스', '키보드', '가습기', '공기청정기', '전기장판',
  '캐리어', '텐트', '자전거', '헤드폰', '스마트워치', '유모차', '식기건조대',
  '에어프라이어', '커피머신', '책상', '의자', '침구세트',
];

interface ShopItem {
  title: string;
  link: string;
  mallName: string;
  lprice: string;
}

interface ShopResponse {
  items: ShopItem[];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : fallback;
  };
  return {
    out: get('--out', 'urls.txt'),
    perKeyword: Number(get('--per-keyword', '100')),
  };
}

async function searchKeyword(
  clientId: string,
  clientSecret: string,
  query: string,
  display: number,
): Promise<ShopItem[]> {
  const params = new URLSearchParams({ query, display: String(Math.min(display, 100)) });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Naver API request failed for "${query}" (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as ShopResponse;
  return data.items ?? [];
}

async function main() {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Set NAVER_CLIENT_ID and NAVER_CLIENT_SECRET in .env first.');
    console.error('Register a free Search API app at https://developers.naver.com/apps');
    process.exit(1);
  }

  const { out, perKeyword } = parseArgs();
  const found = new Set<string>();

  for (const keyword of KEYWORDS) {
    try {
      const items = await searchKeyword(clientId, clientSecret, keyword, perKeyword);
      let matched = 0;
      for (const item of items) {
        if (item.link.includes('smartstore.naver.com') && /\/products\/\d+/.test(item.link)) {
          found.add(item.link);
          matched++;
        }
      }
      console.log(`"${keyword}": ${items.length} hasil, ${matched} link SmartStore (total unik sejauh ini: ${found.size})`);
    } catch (err) {
      console.error(`Gagal untuk "${keyword}":`, err instanceof Error ? err.message : err);
    }
    // Be polite to Naver's free API rather than hammering it back-to-back.
    await new Promise((r) => setTimeout(r, 300));
  }

  const urls = Array.from(found);
  writeFileSync(out, urls.join('\n') + '\n', 'utf-8');
  console.log(`\nSelesai: ${urls.length} URL produk SmartStore unik ditulis ke ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
