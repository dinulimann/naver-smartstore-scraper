import express from 'express';
import cors from 'cors';
import { config } from './config';
import { scrapeProduct as scrapeViaPlaywright } from './scraper';
import { scrapeProductViaScrapingBee } from './scrapingbeeScraper';
import { ScrapeError } from './errors';
import { queue } from './throttle';
import { TtlCache } from './cache';

const app = express();
app.use(cors());

const cache = new TtlCache<unknown>(config.cacheTtlMs);

const backend = config.scrapingBeeApiKey ? 'scrapingbee' : 'playwright';
const scrapeProduct = backend === 'scrapingbee' ? scrapeProductViaScrapingBee : scrapeViaPlaywright;

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', backend, queueSize: queue.size, queuePending: queue.pending });
});

app.get('/naver', async (req, res) => {
  const { productUrl } = req.query;

  if (typeof productUrl !== 'string' || productUrl.length === 0) {
    return res.status(400).json({ error: 'productUrl query param is required' });
  }

  const cached = cache.get(productUrl);
  if (cached) {
    return res.json({ source: 'cache', data: cached });
  }

  const startedAt = Date.now();
  try {
    const data = await queue.add(() => scrapeProduct(productUrl));
    cache.set(productUrl, data);
    res.json({ source: 'live', latencyMs: Date.now() - startedAt, data });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    if (err instanceof ScrapeError) {
      return res.status(err.statusCode).json({ error: err.message, latencyMs });
    }
    const message = err instanceof Error ? err.message : 'Internal scraping error';
    res.status(500).json({ error: message, latencyMs });
  }
});

app.listen(config.port, () => {
  console.log(`Naver SmartStore scraper API listening on port ${config.port} (backend: ${backend})`);
  console.log(`Try: GET http://localhost:${config.port}/naver?productUrl=https://smartstore.naver.com/{store}/products/{id}`);
});
