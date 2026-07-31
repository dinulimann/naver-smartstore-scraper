/**
 * Opens a real Chrome window against Naver's login page, waits for you to
 * log in manually, then saves the authenticated session (cookies +
 * localStorage) to disk via Playwright's storageState. Point
 * NAVER_SESSION_STATE_PATH at the resulting file to let the scraper solve
 * CAPTCHA challenges as a logged-in session — see README hypothesis row 37:
 * a correctly-solved CAPTCHA on an anonymous session redirects to the login
 * wall instead of the product page, but the same solve on an authenticated
 * session reaches it.
 *
 * Usage:
 *   npx tsx scripts/save-naver-session.ts [output-path]
 *   (defaults to naver-session.json in the project root)
 */
import { chromium } from 'patchright';
import * as readline from 'node:readline/promises';

async function main() {
  const outputPath = process.argv[2] ?? 'naver-session.json';

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://nid.naver.com/nidlogin.login');

  console.log('\nSilakan login ke akun Naver kamu di window Chrome yang baru terbuka.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Setelah selesai login, tekan Enter di sini untuk lanjut... ');
  rl.close();

  const cookies = await context.cookies();
  const hasLogin = cookies.some((c) => c.name === 'NID_AUT');
  if (!hasLogin) {
    console.warn('\nPeringatan: cookie login (NID_AUT) tidak terdeteksi — pastikan kamu benar-benar sudah login sebelum lanjut.');
  }

  await context.storageState({ path: outputPath });
  console.log(`\nSesi disimpan di ${outputPath} (${cookies.length} cookies, login terdeteksi: ${hasLogin}).`);
  console.log(`Set NAVER_SESSION_STATE_PATH=${outputPath} di .env untuk memakainya.`);

  await browser.close();
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
