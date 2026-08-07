# Raw curl walkthrough — 402 → pay → 200

Against `npm run dev` on `localhost:4034`.

> Every flow here targets a page this server hosts itself. Read the [ToS section](../README.md#️-terms-of-service--read-this-first) before writing one against a site you don't own.

## 1. Free first

```bash
# Is the browser actually up? If false, paid runs 503 for free.
curl -s localhost:4034/health | jq '{browserAvailable, flows}'
# { "browserAvailable": true, "flows": 2 }

# The catalogue
curl -s localhost:4034/flows | jq '.flows[] | {route, price, inputs: (.inputs|keys), authorized}'
```

```jsonc
{ "route": "POST /run/demo-booking", "price": "$0.05",
  "inputs": ["name", "email", "date", "partySize"], "authorized": true }
{ "route": "POST /run/demo-catalog", "price": "$0.05",
  "inputs": ["query"], "authorized": true }
```

## 2. The three free failures

```bash
# Unknown flow
curl -s -X POST localhost:4034/run/nope -H 'content-type: application/json' -d '{}' | jq
```
```jsonc
{ "error": "FLOW_NOT_FOUND", "flow": "nope",
  "available": ["demo-booking", "demo-catalog"],
  "hint": "GET /flows lists every declared flow with its inputs and price" }
```

```bash
# Missing a required input
curl -s -X POST localhost:4034/run/demo-booking -H 'content-type: application/json' -d '{}' | jq -r '.error, .message'
# INVALID_INPUT
# missing required input "name"

# Failing a pattern
curl -s -X POST localhost:4034/run/demo-booking -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"not-an-email","date":"2026-09-01"}' | jq -r .message
# input "email" does not match [^@\s]+@[^@\s]+\.[^@\s]+
```

All checked **before** the paywall. Nothing was charged.

## 3. Ask without paying

```bash
curl -i -s -X POST localhost:4034/run/demo-booking \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","date":"2026-09-01","partySize":"4"}'
```

```http
HTTP/1.1 402 Payment Required
Access-Control-Expose-Headers: x-payment-response
```

```jsonc
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "50000",
      "resource": "http://localhost:4034/run/demo-booking",
      "description": "x402-browser-bridge: POST /run/demo-booking",
      "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "maxTimeoutSeconds": 60,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" } },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "50000",
      "resource": "http://localhost:4034/run/demo-booking",
      "description": "x402-browser-bridge: POST /run/demo-booking",
      "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "maxTimeoutSeconds": 60,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6,
                 "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", "amount": "50000" } }
  ]
}
```

`50000` atomic USDC units = $0.05.

## 4. Pay and run

Signing needs a wallet — produce the header with `npm run client` or any x402 client:

```bash
curl -s -X POST localhost:4034/run/demo-booking \
  -H 'content-type: application/json' -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","date":"2026-09-01","partySize":"4"}' \
  | jq '.run.payload | {status, durationMs, extracted}'
```

```jsonc
{
  "status": "completed",
  "durationMs": 837,
  "extracted": {
    "reference": "DB-1FLISL",
    "guest": "Ada Lovelace <ada@example.com>",
    "when": "2026-09-01 19:30",
    "covers": "4",
    "table": "T07",
    "errorMessage": null
  }
}
```

The step log:

```bash
… | jq -r '.run.payload.steps[] | "\(.status=="ok"|if . then "✓" else "✗" end) \(.index+1). \(.label) (\(.durationMs)ms)"'
```

```
✓ 1. open the reservation form (121ms)
✓ 2. fill in the guest name (43ms)
✓ 3. fill in the email (38ms)
✓ 4. fill in the date (12ms)
✓ 5. choose the party size (9ms)
✓ 6. capture the completed form (94ms)
✓ 7. submit the request (11ms)
✓ 8. wait for the confirmation panel (412ms)
✓ 9. capture the confirmation (97ms)
```

Save a screenshot (raw base64, no data-URI prefix):

```bash
… | jq -r '.run.payload.screenshots.confirmation' | base64 -d > confirmation.png
```

## 5. The failure path

```bash
curl -s -X POST localhost:4034/run/demo-booking \
  -H 'content-type: application/json' -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"name":"unavailable","email":"x@example.com","date":"2026-09-01"}' \
  | jq '.run.payload | {status, error, siteSaid: .extracted.errorMessage, failedAt: (.steps[] | select(.status=="failed"))}'
```

```jsonc
{
  "status": "failed",
  "error": "step 8 (wait for the confirmation panel) failed: Waiting for selector `#confirmation:not([hidden])` failed",
  "siteSaid": "No tables available for that name. Please try another time.",
  "failedAt": { "index": 7, "action": "waitFor", "label": "wait for the confirmation panel",
                "status": "failed", "durationMs": 8003 }
}
```

Still `200`. `siteSaid` is the real answer — the restaurant refused. Retrying identical inputs costs another $0.05 and fails identically.

## 6. Structured scraping

```bash
curl -s -X POST localhost:4034/run/demo-catalog \
  -H 'content-type: application/json' -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"query":"bolt"}' | jq '.run.payload.extracted'
```

```jsonc
{
  "matchCount": "2 part(s) found",
  "skus": ["BLT-M8-40", "BLT-M10-60"],
  "names": ["Hex bolt M8×40 (zinc)", "Hex bolt M10×60 (zinc)"],
  "stock": ["1820", "640"],
  "prices": ["$0.22", "$0.41"]
}
```

Note it's one run for every matching row — `all: true` extractors are what make a bridge economical. Searching per-SKU would cost 20× as much.

## 7. Verify the record

```bash
curl -s -X POST localhost:4034/verify -H 'content-type: application/json' \
  -d "$(curl -s -X POST localhost:4034/run/demo-catalog -H 'content-type: application/json' \
        -H "X-PAYMENT: $X_PAYMENT" -d '{"query":"bolt"}' | jq -c .run)"
# { "valid": true }
```

## 8. Errors you'll actually hit

```bash
# Garbage payment header    → 402 "invalid X-PAYMENT header: …"
# Wrong network signed      → 402 "unsupported rail: …"
# Facilitator down          → 502 { "error": "facilitator_unreachable" }   (not charged)
# Browser down              → 503 { "error": "BROWSER_UNAVAILABLE" }       (not charged)
```

There is no 5xx for a *flow* failure — that's always a 200 with `status: "failed"`.
