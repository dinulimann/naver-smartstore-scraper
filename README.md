# Naver SmartStore Product Scraper API

A REST API that scrapes `window.__PRELOADED_STATE__` from Naver SmartStore
product pages (`smartstore.naver.com/{store}/products/{id}`) using a
stealth-patched headless browser, rotating proxies and fingerprints, and
request throttling.

```
GET /naver?productUrl=https://smartstore.naver.com/{store}/products/{id}
```

Two interchangeable backends are available — a self-hosted Playwright
pipeline, or a managed scraping API — switched purely by an env var, no
code changes needed. See [Backends](#two-backends) below.

## Status

Works end to end, including through Naver's CAPTCHA challenge. Getting
here took a real investigation — full log in
[INVESTIGATION.md](INVESTIGATION.md) if you want it — but the short
version:

Naver's product pages sit behind a few layers, not one simple block:

1. **Fingerprint consistency matters.** A believable User-Agent, Client
   Hints, and TLS handshake that don't contradict each other is table
   stakes — get any of them wrong (stale Chrome version, wrong OS in
   `navigator.platform`, an explicit `locale` that triggers a different
   code path) and you get flagged immediately, regardless of proxy.
2. **IP/network reputation decides which response you get** — a real
   page, a login wall, a generic error page, or a CAPTCHA. This isn't
   static: a proxy pool that works fine on IP freshness can lose that
   trust after enough automated volume, and a specific product listing
   can accumulate its own scrutiny independent of the IP hitting it.
3. **The CAPTCHA itself is solvable.** It's a small receipt-style image
   asking you to fill in a blank — a street number, or one digit of a
   phone number — not a fingerprint dead-end. Plain OCR reads it
   correctly most of the time. This is implemented in
   `src/captchaSolver.ts`, opt-in via `SOLVE_CAPTCHA=true` — see
   [Solving the CAPTCHA challenge](#solving-the-captcha-challenge-optional).
4. **Solving it isn't enough on its own — the session needs to be
   authenticated.** An anonymous session that answers the CAPTCHA
   correctly gets redirected to Naver's login page instead of the
   product. A logged-in session converts a correct answer into an actual
   page load.

The one combination that reliably works: a product that hasn't been
hammered by testing, an IP without a history of proxy-pool abuse (a
residential or mobile connection beats a heavily-shared commercial proxy
pool here), and a logged-in session that solves the CAPTCHA when it shows
up. [INVESTIGATION.md](INVESTIGATION.md) has the 46 tested hypotheses
that got to this conclusion, including the ones that turned out wrong.

## Setup

```bash
npm install
cp .env.example .env   # fill in PROXIES (or SCRAPINGBEE_API_KEY) and tuning values
npm run dev             # tsx watch, dev server
# or
npm run build && npm start
```

Server listens on `PORT` (default `3000`). `GET /health` reports which
backend is active.

## Usage

```bash
curl "http://localhost:3000/naver?productUrl=https://smartstore.naver.com/soo8099/products/5066189639"
```

(The brief's own example URL is a deactivated store as of this writing —
use an active product like the one above, or find one yourself on
`smartstore.naver.com`.)

Response:

```json
{
  "source": "live",
  "latencyMs": 4213,
  "data": { "...": "the raw __PRELOADED_STATE__ object" }
}
```

Errors come back as `{ "error": "..." }` with an appropriate status
(`400` for a malformed URL, `502` after retries are exhausted).

## Two backends

`src/server.ts` picks automatically: if `SCRAPINGBEE_API_KEY` is set, it
uses ScrapingBee; otherwise it falls back to the local
Playwright/Patchright pipeline. Same API surface either way.

### Backend A — Playwright + your own proxy pool (`src/scraper.ts`)

1. Validates the URL shape before opening a browser.
2. Picks a proxy round-robin from `PROXIES` (`src/proxyManager.ts`) and
   launches Chromium via [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) — a
   patched, undetected Playwright fork that closes CDP-level automation
   leaks (`navigator.webdriver`, `Runtime.enable`, etc.) without needing
   a separate stealth plugin.
3. Applies a random User-Agent/viewport per request
   (`src/fingerprint.ts`), templated on the browser's real version so
   Client Hints never contradict the UA string. Deliberately does *not*
   set `locale` or custom headers — that turned out to trigger a
   login-wall redirect on this target (see INVESTIGATION.md).
4. Navigates, then reads `__PRELOADED_STATE__` by regex-extracting the
   inline `<script>` tag from the raw HTML rather than evaluating it in
   the page — the app deletes the global during its own hydration, so a
   live `page.evaluate()` races that cleanup and can return `undefined`
   even on a successful load.
5. If `SOLVE_CAPTCHA` is on and the failure is a CAPTCHA, attempts to
   solve it (see below) before giving up.
6. Retries up to `MAX_RETRIES` times, rotating proxy and fingerprint each
   attempt.

`PROXIES` can be left empty for a direct connection — not a fallback of
last resort. A residential or mobile IP with no proxy-pool history
reached the product page more reliably than any commercial proxy tested
during development (INVESTIGATION.md, row 45).

### Backend B — ScrapingBee (`src/scrapingbeeScraper.ts`)

Delegates rendering and IP management to
[ScrapingBee](https://www.scrapingbee.com) instead of running a local
browser — useful as a fallback or comparison point, but worth being
upfront that it isn't really in the spirit of "build a scraper that
bypasses anti-scraping mechanisms": it's outsourcing that part rather
than implementing it. Backend A is the intended answer to the brief.

```
SCRAPINGBEE_API_KEY=your-key-here
SCRAPINGBEE_COUNTRY=kr
```

`PROXIES` is ignored once this is set.

### Shared plumbing

Both backends run through the same Express handler
(`src/server.ts`), queued through a concurrency-bounded `p-queue`
(`CONCURRENCY`) so HTTP concurrency doesn't map 1:1 onto simultaneous
browser/API calls, with a TTL cache (`CACHE_TTL_MS`) so repeat hits on
the same URL don't re-scrape.

## Solving the CAPTCHA challenge (optional)

Off by default. When it's on, a CAPTCHA response gets one solve attempt
before the usual retry/failure path.

**1. Install Tesseract** (the OCR engine — a system binary, not an npm
package):

```bash
brew install tesseract        # macOS
apt install tesseract-ocr     # Debian/Ubuntu
```

**2. Save a logged-in session.** A correctly-solved CAPTCHA on an
anonymous session redirects to the login wall, not the product — an
authenticated session is what makes the solve actually count. Use a
throwaway account for this rather than a personal one, since the cookies
get driven by an automated process:

```bash
npm run save-naver-session
# opens a real Chrome window — log in, then press Enter in the terminal
# saves to naver-session.json
```

(This script saves the session's `storageState` before the browser ever
closes. Logging in, closing Chrome, and trying to grab the cookies some
other way loses them — Naver's login cookies are session-only, with no
stored expiry, so a full browser restart wipes them even from the same
profile directory.)

**3. Enable it:**

```
SOLVE_CAPTCHA=true
NAVER_SESSION_STATE_PATH=./naver-session.json
```

**Worth knowing before relying on this**: every commercial proxy pool
tested during development started returning an instant reject to
*authenticated* sessions specifically, rather than serving a CAPTCHA to
solve — including a brand-new account that had never been used for
anything else. The one setup that reliably got through combined this
with a residential/mobile connection instead of a shared proxy pool.
Worth testing against whatever IP source you actually plan to use before
assuming it'll work. Details in INVESTIGATION.md, rows 39–46.

OCR also isn't perfect — it declines to answer (logs the question and
moves on) rather than guessing when it doesn't recognize the question
format, so a failed solve attempt falls through to the normal retry path
instead of submitting a wrong answer.

## Diagnosing a failure

```bash
npm run scrape-debug -- --url https://smartstore.naver.com/soo8099/products/5066189639 --proxy host:port:user:pass --label some-case
```

Saves a full artifact bundle to `logs/<timestamp>_<label>/` instead of
just a pass/fail result — response headers, cookies, a screenshot, the
first 20KB of HTML, and a `meta.json` with the classified failure type
and precise timing (including whether a response ever arrived at all vs.
arrived late). Useful for telling apart a dead proxy from an actual
Naver-side response without re-running anything.

## Evaluating a new proxy provider

```bash
npm run gold-standard-eval -- --proxy host:port:user:pass --url https://smartstore.naver.com/soo8099/products/5066189639 --label new-provider-name
```

Runs four cheap checks that isolate one variable each, rather than a pile
of random attempts: a curl baseline, printed instructions for a manual
Chrome check, a Playwright check on the same proxy, and a reminder to
re-run the same command a day later on the same IP. A provider is only
worth trusting if it clears the Playwright check *and* still works the
next day — a single success proves the code works, not that the pool is
currently trusted.

## Finding real product URLs to test with

The brief's example URLs are dead stores. `scripts/discover-products.ts`
uses Naver's official, free Search Shopping API (a sanctioned public API,
not scraping) to find currently-active product links:

```bash
# register a free Search API app at https://developers.naver.com/apps,
# put NAVER_CLIENT_ID / NAVER_CLIENT_SECRET in .env, then:
npm run discover-products -- --out urls.txt --per-keyword 100
```

## Load testing

The brief's target: 1000+ products, ≤6s average latency, ≤5% error rate,
sustained for an hour.

```bash
echo "https://smartstore.naver.com/soo8099/products/5066189639" > urls.txt
npm run loadtest -- --file urls.txt --base http://localhost:3000 --concurrency 5 --duration 60
```

A full 1000-request/1-hour run against Naver's live site wasn't fired off
unattended here — that's the kind of sustained load against a third
party that should be run deliberately by whoever owns the proxy/target
account, not left running unsupervised. A smaller sample (20 requests,
concurrency 3, cache disabled) landed at 10.08s average latency and a 10%
error rate against a 4-IP trial proxy pool — over target, but a small,
low-quality proxy pool explains both numbers directly: every retry
through a flaky connection adds latency, and every exhausted retry counts
as an error. A real proxy plan with tens to hundreds of reliable IPs,
spread thin per IP rather than concentrated (see
[Recommendations](#recommendations-for-production-use)), is the direct
path to closing this gap at 1000-request scale.

## Hosting via ngrok

```bash
npm run build && npm start
# in another terminal
ngrok http 3000
```

The `/naver` route is reachable at `<ngrok-url>/naver?productUrl=...`.

## Project layout

```
src/
  config.ts              env/config parsing
  errors.ts              shared ScrapeError
  validateUrl.ts         shared productUrl validation
  proxyManager.ts        proxy pool + rotation (backend A)
  fingerprint.ts         UA/viewport randomization (backend A)
  throttle.ts            concurrency queue + random delay (both backends)
  cache.ts               in-memory TTL cache
  captchaSolver.ts       optional OCR-based CAPTCHA solving
  scraper.ts             backend A: Playwright (Patchright) + proxy
  scrapingbeeScraper.ts  backend B: ScrapingBee API client
  server.ts              Express API, picks backend based on env
scripts/
  discover-products.ts        finds real, active product URLs via Naver's Search API
  loadtest.ts                 latency/error-rate load test against the running API
  debug-extract.ts            sanity-checks extraction against one URL, no proxy pool
  scrape-with-artifacts.ts    full diagnostic capture for one attempt
  proxy-healthcheck.ts        pre-flight proxy connectivity/ASN triage
  gold-standard-eval.ts       4-step new-proxy-provider evaluation
  save-naver-session.ts       logs in manually, saves session for SOLVE_CAPTCHA
```

## Recommendations for production use

The clearest lesson from development: trust is tied to cumulative
*automated* request volume on a given IP, not to which proxy provider or
product it happens to be pointed at. Concretely, for running this at the
brief's target volume:

- **Spread load thin per IP, not thick.** A large pool of proxies each
  taking a handful of requests looks nothing like a small pool taking
  dozens each. `ProxyManager`'s round-robin already spreads load evenly —
  the pool just needs to be large enough that no single IP's per-hour
  count looks abnormal.
- **Don't reuse the same handful of products for load testing at scale.**
  A single listing hit repeatedly can accumulate its own reputation
  separate from the IP hitting it — sample broadly instead.
- **A genuinely fresh IP source beats a "better" provider.** Every
  commercial proxy class tested eventually converged on the same
  degraded outcome once exhausted. A lightly-used cloud VPS in a Seoul
  region, or a residential/mobile connection, is likely to outperform any
  heavily-tested commercial pool simply by not sharing its usage history.
- **Trust may recover given enough idle time** — a few hours wasn't
  enough in testing; longer wasn't verified.

## Known limitations

- In-memory cache and the proxy round-robin cursor are per-process —
  running multiple instances behind a load balancer needs a shared store
  (Redis) if you want them coordinated across instances.
- CAPTCHA solving is OCR-based, not guaranteed, and needs an
  authenticated session to actually reach the product page rather than
  the login wall (see above). Off by default.
- Retries within a single request add latency on failure — tune
  `NAV_TIMEOUT_MS`/`MAX_RETRIES` against your own proxy pool's real
  latency/error profile.

## Further reading

[INVESTIGATION.md](INVESTIGATION.md) — the full debugging log: 46 tested
hypotheses, the CAPTCHA reverse-engineering process, and the original
(mistaken) conclusion that this was an unfixable IP-reputation block.
