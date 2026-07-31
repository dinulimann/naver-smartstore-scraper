import { chromium } from 'patchright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const url = process.argv[2] || 'https://smartstore.naver.com/rainbows9030/products/11102379008';
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('status:', resp?.status());
  console.log('final url:', page.url());
  console.log('title:', await page.title());
  const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('body snippet:', bodySnippet);
  const state = await page.evaluate(() => (window as any).__PRELOADED_STATE__);
  console.log('type:', typeof state);
  console.log(JSON.stringify(state, null, 2)?.slice(0, 1500));
  await browser.close();
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
