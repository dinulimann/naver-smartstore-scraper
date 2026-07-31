import { config } from './config';
import { ScrapeError } from './errors';
import { validateSmartstoreUrl } from './validateUrl';
import { randomDelay } from './throttle';

const SCRAPINGBEE_ENDPOINT = 'https://app.scrapingbee.com/api/v1/';

interface ScrapingBeeResponse {
  evaluate_results?: unknown[];
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeOnce(productUrl: string): Promise<unknown> {
  if (!config.scrapingBeeApiKey) {
    throw new ScrapeError('SCRAPINGBEE_API_KEY is not configured', 500);
  }

  // Runs window.__PRELOADED_STATE__ inside the fully-rendered page on
  // ScrapingBee's side and returns the value directly, instead of us having
  // to parse it back out of raw HTML.
  const jsScenario = JSON.stringify({
    instructions: [{ evaluate: 'window.__PRELOADED_STATE__' }],
  });

  const params = new URLSearchParams({
    api_key: config.scrapingBeeApiKey,
    url: productUrl,
    render_js: 'true',
    premium_proxy: 'true',
    country_code: config.scrapingBeeCountry,
    json_response: 'true',
    js_scenario: jsScenario,
  });

  const res = await fetchWithTimeout(`${SCRAPINGBEE_ENDPOINT}?${params.toString()}`, config.navigationTimeoutMs);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ScrapeError(`ScrapingBee request failed (${res.status}): ${body.slice(0, 300)}`, 502);
  }

  const data = (await res.json()) as ScrapingBeeResponse;
  const state = data.evaluate_results?.[0];

  if (!state) {
    throw new ScrapeError('__PRELOADED_STATE__ not found via ScrapingBee (layout change or block page)', 502);
  }

  return state;
}

export async function scrapeProductViaScrapingBee(productUrl: string): Promise<unknown> {
  validateSmartstoreUrl(productUrl);

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await scrapeOnce(productUrl);
    } catch (err) {
      lastError = err;
      if (attempt < config.maxRetries) await randomDelay();
    }
  }

  if (lastError instanceof ScrapeError) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ScrapeError(`Failed after ${config.maxRetries} attempts: ${message}`);
}
