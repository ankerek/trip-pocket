# extract-proxy

Stateless Cloudflare Worker that proxies a Gemini 2.5 Flash-Lite call for Trip Pocket's AI place extraction.

Spec: [`docs/superpowers/specs/2026-05-08-ai-extraction-design.md`](../../docs/superpowers/specs/2026-05-08-ai-extraction-design.md).

## Endpoint

`POST /extract`

Request:

```json
{ "ocr_text": "Maru Tonkatsu, Shibuya — best pork cutlet in Tokyo..." }
```

Response (200):

```json
{
  "places": [{ "name": "Maru Tonkatsu", "city": "Tokyo", "category": "food" }],
  "model": "gemini-2.5-flash-lite"
}
```

The client treats `5xx` as retryable, `4xx` as a permanent failure, and `429` as a deferral (re-enqueue after `Retry-After`).

## Privacy posture

The Worker:

- **Never** logs the OCR text.
- **Never** logs the Gemini response body.
- **Never** persists request bodies.

Logs only carry: HTTP status, latency, and error class (e.g. `upstream-rate-limited`, `upstream-schema-violation`).

## Setup (first time)

```bash
# In this directory:
npm install                                  # one time
npx wrangler login                           # opens a browser
npx wrangler secret put GEMINI_API_KEY       # paste the key when prompted
npx wrangler deploy                          # publishes to <subdomain>.workers.dev
```

After `wrangler deploy`, the URL it prints (e.g. `https://extract-proxy.<your-subdomain>.workers.dev`) goes into the app's `app.config.ts` `extra.extractionProxyUrl`.

## Tests

Tests live alongside the rest of the repo and run with the root Jest:

```bash
# From repo root:
npx jest workers/extract-proxy
```

The handler is pure (`handleExtract(request, env)`); tests mock `globalThis.fetch` to simulate Gemini and inject a stub Rate Limit binding. No `wrangler dev` server, no real network calls.

## Local dev

```bash
# Smoke the handler against real Gemini, locally:
GEMINI_API_KEY=AIza... npx wrangler dev
# Then in another shell:
curl -s http://localhost:8787/extract \
  -H 'content-type: application/json' \
  -d '{"ocr_text":"Maru Tonkatsu, Shibuya"}'
```
