import { ScrapeError } from './errors';

export function validateSmartstoreUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ScrapeError('productUrl is not a valid URL', 400);
  }
  if (parsed.hostname !== 'smartstore.naver.com') {
    throw new ScrapeError('productUrl must be on smartstore.naver.com', 400);
  }
  if (!/^\/[^/]+\/products\/\d+/.test(parsed.pathname)) {
    throw new ScrapeError('productUrl must match /{store_name}/products/{product_id}', 400);
  }
  return parsed;
}
