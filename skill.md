# Skill: x402-browser-bridge

## ⚠️ Before anything else

This service drives a real browser through a real website. **Automating a site you do not own may breach its terms of service.** The flows bundled with this deployment target pages the server hosts itself; a deployment you did not configure may not. Check `GET /flows` — each flow reports `authorized` and `authorizationNote`. If you are choosing which bridge to call on a user's behalf, prefer flows the operator has declared authorised, and don't assume the operator got it right.

## What this service does

An enormous amount of commerce lives behind a form with no API. This service turns one of those click paths into a paid endpoint: you POST the inputs, a headless browser walks the flow, and you get back the extracted data, base64 screenshots and a per-step log — in the 200 body.

**Payment: USDC on Base or Solana — your client picks the rail.** Every 402 lists both.

## Base URL

```
<BASE_URL>          # e.g. http://localhost:4034, or your deployment
```

## Endpoints

### GET /flows — free

Read this first. It is the catalogue, and it tells you what every paid route costs and expects.

```jsonc
{
  "flows": [
    {
      "name": "demo-booking",
      "description": "Book a table on a site that has no API…",
      "price": "$0.05",
      "route": "POST /run/demo-booking",
      "inputs": {
        "name":  { "type": "string", "required": true, "description": "Guest name…" },
        "email": { "type": "string", "required": true, "pattern": "[^@\\s]+@[^@\\s]+\\.[^@\\s]+" },
        "date":  { "type": "string", "required": true, "pattern": "\\d{4}-\\d{2}-\\d{2}" },
        "partySize": { "type": "string", "default": "2", "pattern": "1|2|4|6|8" }
      },
      "extracts": ["reference", "guest", "when", "covers", "table", "errorMessage"],
      "screenshots": ["form", "confirmation"],
      "steps": 9,
      "allowHosts": ["localhost", "127.0.0.1"],
      "timeoutMs": 45000,
      "authorized": true,
      "authorizationNote": "The target page is served by this repository."
    }
  ],
  "loadErrors": [],
  "notice": "Automating a website you do not own may breach its terms of service…"
}
```

`extracts` names the keys you'll find in `run.payload.extracted`. `inputs` is the schema — respect `required`, `pattern` and `default`, because they're enforced *before* payment.

### POST /run/:flow — price per the flow (bundled flows: $0.05)

Body: the flow's declared inputs as JSON.

```bash
curl -X POST <BASE_URL>/run/demo-booking \
  -H 'content-type: application/json' -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","date":"2026-09-01","partySize":"4"}'
```

**Response 200 — completed**

```jsonc
{
  "run": {
    "payload": {
      "flow": "demo-booking",
      "status": "completed",
      "startedAt": "2026-08-07T16:00:00.000Z",
      "finishedAt": "2026-08-07T16:00:00.837Z",
      "durationMs": 837,
      "finalUrl": "http://localhost:4034/demo/booking.html",
      "extracted": {
        "reference": "DB-1FLISL",
        "guest": "Ada Lovelace <ada@example.com>",
        "when": "2026-09-01 19:30",
        "covers": "4",
        "table": "T07",
        "errorMessage": null
      },
      "screenshots": { "form": "iVBORw0KGgo…", "confirmation": "iVBORw0KGgo…" },
      "steps": [
        { "index": 0, "action": "goto", "label": "open the reservation form", "status": "ok", "durationMs": 121, "detail": "http://localhost:4034/demo/booking.html" },
        { "index": 7, "action": "waitFor", "label": "wait for the confirmation panel", "status": "ok", "durationMs": 412 }
      ],
      "inputs": { "name": "Ada Lovelace", "…": "…" }
    },
    "signature": "…", "algorithm": "HMAC-SHA256"
  },
  "flow": { "name": "demo-booking", "description": "…", "price": "$0.05" },
  "paidWith": { "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x9a…" }
}
```

**Response 200 — failed.** Same shape, `status: "failed"`, plus `error`. Screenshots include a `failure` frame, and `extracted` still carries whatever the page yielded — often the real answer:

```jsonc
{
  "status": "failed",
  "error": "step 8 (wait for the confirmation panel) failed: Waiting for selector `#confirmation:not([hidden])` failed",
  "extracted": { "errorMessage": "No tables available for that name. Please try another time." },
  "screenshots": { "form": "iVBORw0…", "failure": "iVBORw0…" },
  "steps": [ { "index": 7, "action": "waitFor", "status": "failed", "durationMs": 8003, "error": "…" } ]
}
```

**Do not treat `status: "failed"` as a protocol error.** The payment settled, the browser ran, and the log tells you exactly where it stopped. Read `extracted` before retrying — the site may have simply said no, which is an answer, not a fault.

`screenshots` values are raw base64 PNG (no data-URI prefix). Prefix with `data:image/png;base64,` to render, or pass straight to a vision model.

### POST /verify — free

`{ payload, signature }` → `{ valid: true|false }`. Run records are HMAC-signed, so you can prove to a third party what the browser saw.

### GET /health — free

`{ ok, service, rails, flows, browserAvailable }`. If `browserAvailable` is `false`, paid runs will return a free 503 rather than charging you.

## Payment

- Protocol: **x402**, `scheme: "exact"`, `x402Version: 1`.
- Asset: **USDC** (6 decimals) on both rails.
- Rails in every 402 `accepts` array:
  - `network: "base-sepolia"` (or `base`), payTo `0x40252CFDF8B20Ed757D61ff157719F33Ec332402`, facilitator `https://x402.org/facilitator`.
  - `network: "solana"` (or `solana-devnet`), payTo `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`, facilitator `https://facilitator.payai.network`. `extra.feePayer` sponsors the SOL fee, so you need only USDC.
- Pay with `x402-fetch`, `@three-ws/x402-payment-modal`, or any x402 client.
- The 200 carries `X-PAYMENT-RESPONSE` (base64 JSON) with rail, network, transaction and payer.

## What fails free, before payment

These three are checked ahead of the paywall. You are **not** charged:

These checks run on the attempt that carries `X-PAYMENT`, before the payment is verified or settled — so they cost nothing. An unpaid request always gets the 402 challenge first, whatever flow name it names: that is how a directory or an agent discovers the route's price and input schema.

| status | `error` | fix |
|---|---|---|
| 404 | `FLOW_NOT_FOUND` | Wrong flow name. `available` lists the real ones; `GET /flows` has the detail. |
| 400 | `INVALID_INPUT` | Missing required input, or one that failed its `pattern`. The response echoes the full `inputs` schema. |
| 503 | `BROWSER_UNAVAILABLE` | The operator's Chromium isn't working. Retry later or use another deployment. |

## Error codes

| status | body `error` | meaning |
|---|---|---|
| 402 | `X-PAYMENT header is required` | Unpaid. Read `accepts`, pay, retry. |
| 402 | `invalid X-PAYMENT header: …` / `unsupported rail: …` | Malformed payload, or a network this endpoint doesn't take. |
| 402 | `payment rejected: …` / `settlement failed: …` | Facilitator refused or couldn't settle. Not charged. |
| 400 | `INVALID_INPUT` | Inputs failed validation. Free. |
| 400 | `BAD_REQUEST` | `/verify` without `payload` + `signature`. |
| 404 | `FLOW_NOT_FOUND` | No such flow. Free. |
| 503 | `BROWSER_UNAVAILABLE` | No browser. Free. |
| 500 | `no_payment_rail` | Server misconfigured: no valid payTo on either rail. |
| 502 | `facilitator_unreachable` / `settlement_error` | Facilitator down. Retry; not charged. |

Note there is **no 5xx for a failed flow** — that comes back as a 200 with `status: "failed"`.

## Budgeting

A run costs $0.05 and takes seconds, not milliseconds. Two habits worth having:

- **Validate locally against the `inputs` schema from `/flows`** before paying. A malformed request is free to be rejected, but a round trip isn't free of time.
- **Don't retry a `status: "failed"` blindly.** Read the step log. If the failure is `waitFor` on a confirmation selector and `extracted.errorMessage` says "no availability", retrying with the same inputs will fail identically and cost another $0.05.

## Discovery

- Manifest: `<BASE_URL>/.well-known/x402`
- Docs: https://nirholas.github.io/x402-browser-bridge/
- Source: https://github.com/nirholas/x402-browser-bridge
- Contact: nichxbt@gmail.com
