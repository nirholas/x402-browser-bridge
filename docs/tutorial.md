# Tutorial — x402-browser-bridge

Run a browser flow behind a 402, then write your own.

> **Before you write a flow against a site that isn't yours, read the [terms-of-service section of the README](https://github.com/nirholas/x402-browser-bridge#️-terms-of-service--read-this-first).** Everything below targets pages this repository serves itself.

---

## 1. Install

```bash
git clone https://github.com/nirholas/x402-browser-bridge
cd x402-browser-bridge
npm install       # downloads Chromium — the big step
cp .env.example .env
```

Node 18+. If the Chromium download is blocked in your environment, install one yourself and point at it:

```bash
apt-get install -y chromium
echo 'PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium' >> .env
```

## 2. Run it

```bash
npm run dev
```

```
x402-browser-bridge on http://localhost:4034

Payment rails (client picks one):
  evm     base-sepolia   USDC → 0x40252CFDF8B20Ed757D61ff157719F33Ec332402
  solana  solana         USDC → WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW

Flows loaded from flows/:
  POST /run/demo-booking       $0.05   hosts: localhost, 127.0.0.1
  POST /run/demo-catalog       $0.05   hosts: localhost, 127.0.0.1

⚠️  Automating a site you do not own may breach its terms of service.
```

Check the browser actually works before anything else:

```bash
curl -s localhost:4034/health | jq .browserAvailable   # true
```

If that's `false`, paid runs will return a free `503` rather than charging for something that can't happen.

## 3. Read the catalogue

```bash
curl -s localhost:4034/flows | jq '.flows[] | {route, price, inputs: (.inputs|keys), extracts}'
```

```jsonc
{
  "route": "POST /run/demo-booking",
  "price": "$0.05",
  "inputs": ["name", "email", "date", "partySize"],
  "extracts": ["reference", "guest", "when", "covers", "table", "errorMessage"]
}
```

Free, and it's the schema you validate against locally before paying.

## 4. The three free failures

Worth trying deliberately, because they're the ones that don't cost you anything:

```bash
# Wrong flow name
curl -s -X POST localhost:4034/run/nope -H 'content-type: application/json' -d '{}' | jq
# { "error": "FLOW_NOT_FOUND", "available": ["demo-booking", "demo-catalog"], … }

# Missing a required input
curl -s -X POST localhost:4034/run/demo-booking -H 'content-type: application/json' -d '{}' | jq -r .message
# missing required input "name"

# Browser down (stop Chromium and retry) → 503 BROWSER_UNAVAILABLE
```

All three are checked **before** the paywall. That ordering is deliberate: x402 is pay-then-serve, so anything that makes a run impossible has to be caught while the caller still has their money.

## 5. Your first 402

```bash
curl -s -X POST localhost:4034/run/demo-booking \
  -H 'content-type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","date":"2026-09-01","partySize":"4"}' \
  | jq -r '.accepts[] | "\(.network)\t$\(.maxAmountRequired|tonumber/1000000)"'
```

```
base-sepolia	$0.05
solana	$0.05
```

## 6. Pay and run

Fund a Base Sepolia wallet at [faucet.circle.com](https://faucet.circle.com):

```bash
PRIVATE_KEY=0xyourTestKey npm run client
```

```
200 — flow completed in 837ms

Extracted:
{
  "reference": "DB-1FLISL",
  "guest": "Ada Lovelace <ada@example.com>",
  "when": "2026-09-01 19:30",
  "covers": "4",
  "table": "T07",
  "errorMessage": null
}

Step log:
  ✓  1. open the reservation form (121ms)
  ✓  2. fill in the guest name (43ms)
  ✓  3. fill in the email (38ms)
  ✓  4. fill in the date (12ms)
  ✓  5. choose the party size (9ms)
  ✓  6. capture the completed form (94ms)
  ✓  7. submit the request (11ms)
  ✓  8. wait for the confirmation panel (412ms)
  ✓  9. capture the confirmation (97ms)

Wrote form.png (49 KB base64)
Wrote confirmation.png (69 KB base64)
```

Open `confirmation.png`. That's a real screenshot of a real page that a real browser filled in.

## 7. Now break it

`name: "unavailable"` makes the demo page refuse:

```bash
SIMULATE=fail curl -s -X POST localhost:4034/run/demo-booking \
  -H 'content-type: application/json' -H "X-PAYMENT: $X_PAYMENT" \
  -d '{"name":"unavailable","email":"x@example.com","date":"2026-09-01"}' | jq '.run.payload | {status, error, extracted}'
```

```jsonc
{
  "status": "failed",
  "error": "step 8 (wait for the confirmation panel) failed: Waiting for selector `#confirmation:not([hidden])` failed",
  "extracted": {
    "reference": "", "guest": "", "when": "", "covers": "", "table": "",
    "errorMessage": "No tables available for that name. Please try another time."
  }
}
```

Still `200`. Look at what you actually got:

- **which step broke** — step 8, the confirmation wait
- **a `failure` screenshot** of the page at that moment
- **the site's own message** — "No tables available"

That last one is the real answer. The flow didn't malfunction; the restaurant said no. Retrying identical inputs would fail identically and cost another $0.05.

## 8. Write your own flow

Drop a YAML file in `flows/` and restart. That's the whole deployment process.

```yaml
name: my-flow
description: What this buys the caller.
price: "$0.05"

# Required. The security boundary — navigation anywhere else is aborted.
allowHosts: [example.internal]

# Assert that you're allowed to automate the target. Informational; it does not
# transfer responsibility to anyone else.
authorized: true
authorizationNote: Internal system owned by us.

inputs:
  reference:
    type: string
    required: true
    pattern: '[A-Z]{2}-\d{6}'      # validated BEFORE payment
    description: Shown to callers in GET /flows.

steps:
  - label: open the lookup page
    goto: "https://example.internal/lookup"
  - type: { selector: "#ref", value: "{{inputs.reference}}" }
  - click: "#go"
  - waitFor: "#result"
    timeoutMs: 8000
  - screenshot: result

extract:
  status: { selector: "#status" }
  updatedAt: { selector: "#updated", attr: "datetime" }
  lineItems: { selector: ".line-item", all: true }
```

Things worth knowing while writing one:

- **Label your steps.** The label is what the caller reads in the failure log. `"wait for the confirmation panel"` is useful; `waitFor #confirmation` is not.
- **Set per-step `timeoutMs` on the step that proves success.** The default is 30s, and a caller waiting 30s to learn the booking failed is a worse experience than 8s.
- **Mark genuinely optional things `optional: true`** — both steps and extractors. An error banner that only appears on failure should be an optional extractor, or every successful run "fails".
- **Use `attr`** to read something other than text: `attr: href`, `attr: value`, `attr: datetime`, or `attr: html`.
- **Use `all: true`** to collect every match into an array — that's how `demo-catalog` returns table rows.
- **Segmented inputs are handled for you.** `type` into a `date`/`time`/`month` field sets the value directly rather than typing digits into the wrong segments.

Validate without spending anything:

```bash
curl -s localhost:4034/flows | jq '.loadErrors'    # [] means every file parsed
```

A malformed flow is skipped with a message rather than taking down the server.

## 9. Use it as a library

```ts
import { loadFlows, validateInputs, FlowRunner } from "x402-browser-bridge";

const { flows, errors } = loadFlows("flows");
if (errors.length) console.warn(errors);

const runner = new FlowRunner({ baseUrl: "https://example.internal" });
const flow = flows.get("my-flow")!;

const result = await runner.run(flow, validateInputs(flow, { reference: "AB-123456" }));
if (result.status === "failed") console.error(result.error, result.steps.at(-1));

await runner.close();   // shuts down the shared Chromium
```

One browser is shared across runs; each run gets a fresh incognito context, so cookies never leak between callers.

## 10. Going to production

```bash
NETWORK=base
SOLANA_NETWORK=mainnet-beta
FACILITATOR_URL=https://facilitator.payai.network
SOLANA_FACILITATOR_URL=https://facilitator.payai.network
PAY_TO_ADDRESS=0xYourRealWallet
SOLANA_PAY_TO_ADDRESS=YourRealSolanaWallet
PUBLIC_BASE_URL=https://bridge.example.com
SIGNING_SECRET=$(openssl rand -hex 32)
```

Checklist:

- **Re-read the ToS section for every flow you serve.** This is the one that will actually cause you problems.
- **Set `PUBLIC_BASE_URL`.** It's used both for the 402 `resource` field (facilitators check it) *and* to resolve `{{baseUrl}}` in flows.
- **Set `SIGNING_SECRET`**, or run records are signed with a public dev key and prove nothing.
- **Leave `EXTRA_ALLOW_HOSTS` empty** unless you know exactly why you're widening it. Per-flow `allowHosts` is the boundary.
- **Give Chromium memory.** In Docker, `--shm-size=1gb`; without it Chromium crashes on large pages under load.
- **Cap concurrency.** Each run is a real page. A queue in front of this is the difference between a service and an outage.

---

Next: [API reference](./api.md) · [For AI agents](./agents.md)
