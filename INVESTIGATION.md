# Investigation Log

Full record of how this scraper went from "looks like an unsolvable IP
block" to a working CAPTCHA-solving pipeline. Kept separate from the main
README because it's long — 46 tested hypotheses plus the original
debugging trail — but it's the part that actually explains *why* the
code looks the way it does.

Format: hypothesis → experiment → result, in the order things were
actually tried. Several early hypotheses turned out wrong; they're left
in rather than cleaned up, because the wrong turns are as instructive as
the right ones.

## Hypotheses tested

| # | Hypothesis | Experiment | Result |
|---|---|---|---|
| 1 | User-Agent string alone causes the block | Rotated 5 different UA strings across requests | No effect — block persisted identically regardless of UA |
| 2 | Datacenter IPs are categorically blocked | Tested free/cheap datacenter proxies from multiple resellers | Blocked at first — but later shown to be confounded by bugs #4/#5 below, not IP category itself (see #12) |
| 3 | `page.evaluate(() => window.__PRELOADED_STATE__)` should read the state | Compared against regex-extracting the same variable from raw HTML | **Confirmed bug**: the app deletes the global during its own hydration; evaluating it live races that cleanup and returns `undefined` even on fully successful loads. Fixed by parsing the raw HTML instead |
| 4 | Setting `locale: 'ko-KR'` helps (correct locale for a KR site) | Set explicit `locale` in `newContext()` | **Backfired** — flipped an otherwise-successful load into a login-wall redirect |
| 5 | A plain `Accept-Language` header (no full locale emulation) is safer | Set only that one header, nothing else | **Also backfired**, same login-wall result — the issue is triggering *any* explicit header/locale override via CDP, not the locale value itself |
| 6 | CDP-level automation leaks (e.g. `Runtime.enable`) are what's detected | Swapped Puppeteer for `rebrowser-puppeteer` (patches exactly this) | No effect — ruled out automation-protocol-level detection entirely |
| 7 | Residential proxies succeed where datacenter fails | Tested ~9 Decodo residential IPs, verified genuinely Korea-ISP-assigned | Blocked identically to datacenter — categorically wrong assumption at the time (see #12 for the real explanation) |
| 8 | Mobile carrier proxies succeed where residential/datacenter fail | Tested Decodo mobile product, sticky + rotating sessions | Blocked identically — same pattern again |
| 9 | A premium, properly Korea-located datacenter proxy (Bright Data, Seoul) succeeds | 6 requests across 6 different rotating sessions | 0/6 succeeded — ruled out "you get what you pay for" as the deciding factor |
| 10 | TLS fingerprint (JA3/JA4) reveals the automation | Compared JA3/JA4 against a real human Chrome session via tls.peet.ws, with and without `channel: 'chrome'` | JA4 matched the real human session **exactly** with `channel: 'chrome'`. JA3 differed, but Chrome deliberately randomizes JA3-relevant extension order per-connection by design — ruled out TLS fingerprinting as the mechanism |
| 11 | User-Agent and Client Hints (`sec-ch-ua`/`navigator.userAgentData`) stay consistent when only the UA header is overridden | Set a fake UA claiming Chrome 124, inspected `sec-ch-ua` and `navigator.userAgentData` on the same request | **Confirmed bug**: Client Hints still reported the true running version (150) regardless of the faked UA header — an inconsistency no real browser can produce. Fixed by templating the UA on the browser's actual real version |
| 12 | User-Agent OS claim stays consistent with `navigator.platform` when UA is rotated across Windows/Mac/Linux | Set a UA claiming Linux on a real Mac host, inspected `navigator.platform` and WebGL renderer | **Confirmed bug**: `navigator.platform` reported `"MacIntel"` and WebGL reported `"Apple M1"` regardless of the UA's claimed OS. Fixed by keying the UA to the host's real `process.platform` instead of rotating across OSes freely |
| 13 | Headless vs headed leaves a detectable footprint | Compared `window.outerWidth/outerHeight` between headless and headed on the same machine | Confirmed a real, unaddressed difference: headless reports `outerWidth === viewport width`; headed reports a realistic, viewport-independent size. Documented, not fixed (headless is required for the deployment target) |
| 14 | Cookie/session persistence (visiting naver.com first) improves success | Compared cold product hit vs. warm-up via naver.com → search.naver.com → product | Inconclusive — the proxy pool used was already exhausted/flagged in both runs |
| 15 | It's really about IP/proxy-provider reputation | Tested 7 distinct proxy classes (free, cheap datacenter, residential trial, mobile trial, Tor, premium Bright Data, a second residential reseller) across an entire session | Strong pattern: every class eventually gets blocked, but early on, several worked at 80-100%. Points to time/volume-based adaptive protection rather than a static IP blocklist |
| 16 | Naver's protection has an adaptive, session-wide sensitivity threshold (not just per-IP or per-product) | Tested a heavily-hit product vs. two never-touched products through the same proxies late in the session | Both failed identically — rules out "this product got extra scrutiny." Consistent with a broader, time-based escalation tied to sustained automated traffic across the whole session |
| 17 | A `502`/"not found" failure is one uniform thing ("blocked") | Built `scripts/scrape-with-artifacts.ts` to save full HTML/headers/screenshot on every attempt instead of a boolean | **Wrong — at least 4 distinct response shapes**: a generic system-error page, a `nid.naver.com` login-wall redirect, a genuine `ncpt.naver.com` CAPTCHA challenge, and legitimate non-block responses ("seller inactive"/"product removed"). `classifyFailurePage()` now distinguishes these |
| 18 | A request that never gets a response and a request that gets a slow-but-real response are the same failure | Added `page.once('response', ...)` timestamping instead of only catching `page.goto()`'s own timeout | **Wrong.** One request's actual response (a `490` CAPTCHA page) arrived at ~20.3s, past a 20s timeout that had been misreporting it as a network timeout. `NAV_TIMEOUT_MS` raised to 30s; failures now split into `network-timeout-no-response` vs. a classified page with a timing figure. What this doesn't establish: whether that delay was intentional or ordinary latency — a follow-up request came back in 2.9s with the same CAPTCHA page |
| 19 | The block/challenge is specific to automated traffic — a real, unautomated browser wouldn't trigger it | Manually browsed the same URL in real Chrome, zero proxy, from two different networks (home Wi-Fi, mobile data) | **Wrong.** Home Wi-Fi hit the same system-error page our classifier already matches; mobile data got a login-wall redirect. A real human on stock Chrome hit two different challenge categories depending only on network — breaks the assumption that these responses are bot-specific |
| 20 | A persistent browser profile succeeds where a brand-new context fails | Ran an ephemeral `newContext()` against a `launchPersistentContext()` warmed up by visiting naver.com first | Inconclusive — on an exhausted IP both arms failed; on a fresh proxy the warm-up itself timed out before it could complete |
| 21 | Client type (browser-matching TLS/HTTP2 fingerprint vs. a non-browser client like curl) determines the response, not just IP reputation | Hit the same target through the same sticky proxy session with curl, then Playwright, seconds apart; compared JA3/JA4 via tls.peet.ws | curl: `429` in 2.1s. Playwright: `490` CAPTCHA in 18.7s. Same IP, same URL — rules out IP drift as the explanation. JA3/JA4 confirmed completely different between clients. Consistent with two response paths: one for non-browser-looking clients, one for browser-matching ones |
| 22 | Automating a genuinely real Chrome profile (real cookies/extensions/history) avoids the challenge entirely | Attached Playwright via CDP to a real, manually-warmed Chrome browser instead of launching a fresh one | Confounded — got a fast `429`, but the human warm-up had already hit a CAPTCHA itself, and this ran on an IP already hit dozens of times that day |
| 23 | Proxy connectivity failures can be told apart from Naver's own response, and IP/ASN diversity predicts success | Built `scripts/proxy-healthcheck.ts`: ifconfig.me → ASN lookup → google.com → naver.com → target, via curl, before ever using a proxy with Playwright | Connectivity triage works well. But every proxy also got an identical fast `429` on the target — a curl artifact (curl's default UA is a trivial non-browser signal), re-confirming #21 rather than revealing anything IP-specific |
| 24 | The heavily-reused target product has itself become rate-limited from repeated testing, independent of IP | Ran the same browser-fingerprint request against the overused product and a never-touched one | **Wrong.** Both got `490` at nearly identical timing — rules out per-product poisoning, at least on an already-untrusted proxy |
| 25 | With IP held constant, real Chrome succeeds where Playwright fails | Fresh proxy session: real Chrome manual first, then Playwright, seconds later, same IP | Neither succeeded, and differently: Chrome got a login-wall, Playwright got a CAPTCHA 4 seconds later. Doesn't isolate a clean automation-specific signal — the IP itself seems distrusted regardless of client, with a non-deterministic component in exactly which response is served |
| 26 | The Decodo pool that produced this project's one clean success still performs the same way | Re-ran the identical URL through the same Decodo credentials, 5 times | All 5 failed. But the gateway turned out to be rotating (5 different IPs, one failure each) — doesn't distinguish "this account lost trust" from "these IPs are just currently bad" |
| 27 | A specific IP, pinned via a Decodo sticky session, gives a different result after time passes | Pinned one exact IP, confirmed via 3 `ifconfig.me` calls, tested it | Baseline recorded (curl `429` in 0.65s, Playwright `490` in 2.6s) — deliberately left open for a later re-test on the same IP |
| 28 | A natural referral path (clicking a real search-ad result) succeeds where a cold direct visit doesn't | Manually clicked a real Naver shopping ad result (genuine ad-tracking params in the URL) from a third network (office Wi-Fi) | **Wrong.** Immediate CAPTCHA, same as a cold visit. Three different networks now each hit a different failure category regardless of how natural the navigation path was |
| 29 | An authenticated Naver session gets through where an anonymous one doesn't | Real account, logged in via real Chrome, `NID_AUT`/`NID_SES` confirmed, attached via CDP, requested the target twice | **Wrong.** `490` once, `429` the next time, minutes apart, same everything. Login alone on an already-distrusted IP isn't enough |
| 30 | Combining login + a not-yet-exhausted proxy IP succeeds where either alone didn't | Injected real login cookies into a fresh proxy session | **Wrong.** `429` in 4.2s. Every individually-plausible signal tested by this point — fingerprint, cookies, referral path, login — with no success |
| 31 | The overused target product has its own reputation damage, separate from IP reputation | A real, aged, logged-in personal browser succeeded on a never-touched product but got CAPTCHA'd on the overused one, on the same network minutes apart | Two-layer result: on a trusted browser, product mattered (clean succeeded, overused didn't); on an untrusted proxy, the clean product also failed. **Both an untrusted IP and an overused product can independently block you** — the earlier "no per-product effect" (#24) only held because that test's IP was already untrusted regardless of product |
| 32 | With the target product now clean, the real server succeeds through Decodo | Ran the actual production server against the clean product through the Decodo pool | **Wrong** — still `login-wall-redirect`. A clean product doesn't help if the proxy account itself is untrusted |
| 33 | This machine's own direct IP is still clean enough to succeed on the clean product | No proxy, direct connection, clean product | **Wrong** — `490` CAPTCHA. This machine's own IP had also been used dozens of times that day for testing. Every IP used for automation that day — proxies and direct alike — had failed by this point, while a low-volume human session on an unrelated network succeeded. Points to cumulative automated request volume as the actual mechanism, not anything specific to a proxy vendor |
| 34 | A genuinely new, never-touched proxy account succeeds | New Decodo-style trial, confirmed fresh via ASN lookup, tested against two clean products, 20 attempts | All 20 failed — but the pool turned out to be datacenter-class (Psychz Networks), a category that had failed since the start of testing regardless of freshness. Didn't actually test a fresh *residential* pool |
| 35 | A second new *residential* trial succeeds | New account, confirmed Korea Telecom residential via ASN, 20 attempts | 19/20 failed. A brand-new residential account with zero history behaved the same as the exhausted ones |
| 36 | Reverse-engineered the CAPTCHA script to see what it actually checks | Fetched `wtm_captcha_v2.js` and the challenge iframe, grepped for fingerprinting APIs (Canvas, WebGL, AudioContext, WebAssembly, mouse/keyboard listeners), instrumented every sub-resource request | The main script touches none of the classic fingerprinting APIs — mostly generic polyfill code. The iframe bundle does register a Service Worker, read Client Hints, load font-probe files, and run WASM. **Concluded there was no interactive puzzle — this was wrong, corrected by #37** |
| 37 | (Correction of #36) There is a genuine, human-solvable visual question | Waited long enough to catch the `receipt/question` network response and rendered the embedded image | It's a small "receipt" graphic — fictional store name, address, phone number — with a fill-in-the-blank question like "the street number is [?]" or "what's the Nth digit of the phone number." Matching answer input and submit button live on the main page |
| 38 | Plain OCR (no paid solving service) can read it accurately enough | Ran Tesseract against captured question images, matched the answer via simple text patterns | Confirmed. OCR is imperfect on surrounding text but consistently gets the needed digits/numbers right. Built into `src/captchaSolver.ts` |
| 39 | Solving the CAPTCHA on an authenticated session reaches the real product page | Saved a logged-in session via `storageState`, ran the solve flow with no proxy and through an already-exhausted proxy pool | **Confirmed, twice, with genuine extracted data both times** (110 top-level keys, real name/price/store fields). The same solve on an anonymous session had redirected to the login wall instead — login turned out to be the missing piece the whole time, not proxy quality |
| 40 | The exhausted Decodo account's trust recovers after several hours | Re-tested the next day | Still `captcha-challenge` on all 3 ports tried — a few hours isn't enough, if recovery happens at all |
| 41 | An authenticated session changes the response from CAPTCHA to instant `429` | Ran the production server with a saved session across two different proxy pools | All 5 attempts got `429` — never even reached a CAPTCHA to solve. Same exact proxy, with vs. without login, minutes apart: `captcha-challenge` → `429`. Two explanations not yet distinguished: this specific account's reputation, or authenticated sessions generally routed differently |
| 42 | An anonymous session that solves the CAPTCHA still doesn't reach the product | Re-ran the production server, no login, same proxy as #41 | Confirmed — `login-wall-redirect`. Login is not optional; solving without it just trades one gate for another |
| 43 | **Bug, caught by reviewing a screen recording**: a phone-number answer was visibly wrong | User watched the CAPTCHA get answered on camera and the digit didn't match the question | Real bug: the phone-number regex (`\d{2,4}-\d{4}`) was loose enough to swallow a stray digit from OCR misreading the phone icon, shifting every ordinal position by one. Fixed by requiring exactly `\d{3}-\d{4}` — Korea's local-number format — so the regex engine slides past the contamination instead of absorbing it. Also added: an unrecognized question now logs and declines to answer instead of guessing |
| 44 | A brand-new account (never used anywhere) still gets `429` on the same proxy/port that CAPTCHA'd an anonymous session | New account, new Google-linked Naver signup, tested against the exact same proxy/port | Same `429`. With both account and proxy history controlled for, it still looks like authentication itself — not a specific account's reputation — routes the request to a faster-reject path, on the pools available |
| 45 | The same new account succeeds with no proxy at all, over a phone's mobile hotspot | Connected directly to a phone's personal hotspot (confirmed genuinely mobile-carrier via IP lookup), ran the real solve flow, no proxy configured | **Succeeded twice**, with the same real product data extracted both times. The cleanest result of the whole project: fresh account, fresh IP class with zero proxy-pool history, real CAPTCHA solved by OCR each time |
| 46 | On the same clean mobile IP, an anonymous session behaves like every proxy tested earlier | Same hotspot connection, no login, twice | One CAPTCHA correctly declined (OCR genuinely couldn't read that image), one solved correctly — and redirected to the login wall anyway. Completes the pattern: {proxy, mobile} × {anonymous, authenticated} — only mobile + authenticated actually reaches the product page |

**Note on an earlier framing error**: several rows above (and the section
below) originally described results as "Naver blocked this IP" when the
evidence was actually a `503` from the *proxy provider's own load
balancer* — the request never reached Naver at all. That's a
proxy-infrastructure problem, not a Naver-side block, and the two got
conflated in places below.

**Net effect of the code fixes (#3, #4/#5, #11, #12)**: success on a real
product went from 0% to 80-100% in controlled early tests, before the
proxy pool in use got exhausted from testing volume. That's the strongest
evidence that the code itself was never the real blocker.

**On "does a realistic fingerprint guarantee success" (rows 19-21)**: no.
A real human on real Chrome hit the same challenge categories this
scraper does. Fingerprint realism is a necessary condition, not a
sufficient one — network reputation, session state, and (per row 39
onward) authentication all still matter independently.

## How it actually works now

Put together, rows 31 through 46 describe a system with at least three
independent trust signals, all of which have to line up:

- **IP/network reputation** — gates whether you get a direct page, a
  login-wall, a system error, or a CAPTCHA. Proxy pools lose this after
  enough automated volume; a low-traffic residential/mobile IP tends to
  keep it.
- **Product/store reputation** — separate from IP reputation. A specific
  listing hit hundreds of times can develop its own scrutiny, independent
  of who's asking.
- **Session authentication** — solving the CAPTCHA on an anonymous session
  just gets you redirected to a login wall. An authenticated session is
  what actually converts a solved CAPTCHA into a real page load.

None of these alone was the answer at any earlier point in the log. The
one combination that reliably worked by the end: a clean product URL, an
IP with no proxy-pool history, and a logged-in session that solves the
CAPTCHA when it appears.

## The pre-fix debugging trail

Everything below happened before the real root causes above were found.
At the time it looked like an unfixable IP/geo-reputation block — two of
the three actual causes turned out to be bugs in this codebase instead.
Left in because the wrong turn is real and the methodology (change one
variable at a time, verify against an independent source) held up even
though the conclusion didn't.

**The Thordata trial proxy from the brief is dead**, independent of
anything in this repo:

```bash
curl -x http://<trial-username>:<trial-password>@6n8xhsmh.as.thordata.net:9999 http://httpbin.org/ip
# -> 403, body: {"errorMsg":"Credential verification failed..."}
```

**Public free-proxy lists are useless at scale.** Pulled 30 "KR, 100%
uptime" proxies from a public aggregator and tested all 30 in parallel:
0 reachable.

**Datacenter proxies connect fine but get blocked on SmartStore's data
routes specifically:**

| Route | Result |
|---|---|
| `smartstore.naver.com/` (marketing page) | `200 OK` |
| `smartstore.naver.com/{store}` | `429` |
| `smartstore.naver.com/{store}/products/{id}` | `429` |
| `m.smartstore.naver.com/{store}/products/{id}` | `429` |
| `msearch.shopping.naver.com/product/{id}` | `418` |

A session warm-up (visit the store page first, carry cookies/Referer into
the product request) didn't help — the warm-up request itself got the
same `429`.

**Tor exit nodes got the identical pattern.** Root page fine, product
page blocked.

**A real residential proxy trial (Decodo) got blocked too** — 9 distinct,
verified-genuine Korean residential IPs, all `429` on the product route,
while the root page kept loading. The trial pool was also independently
flaky (~10% connection success before even reaching Naver).

**Ruled out CDP/automation-protocol detection.** Swapped in
`rebrowser-puppeteer` (patches known DevTools Protocol leaks like
`Runtime.enable`) — identical `429`, no change. Whatever was happening on
these routes wasn't at the automation-protocol layer.

**Mobile proxies got blocked the same way** — 3 distinct mobile carrier
IPs, same `429` pattern, root page still fine.

The working theory at the time, based on five independent network classes
all failing identically: Naver was checking IPs against a commercial
proxy/VPN reputation database, regardless of the physical connection type
behind them. That theory didn't survive later testing (see the table
above) — the real causes were a `page.evaluate()` timing bug and a
locale/header side effect, plus the actual proxy pools used were smaller
and less reliable than assumed. What did hold up: the Thordata credentials
really were dead, free proxy lists really are useless, and isolating one
variable at a time is still the right way to debug this kind of thing.
