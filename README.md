# x402-browser-bridge

**Turn a website flow into a paid API.** Declare it in YAML, Puppeteer executes it, and the extracted data, screenshots and step log come back in the response.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![x402](https://img.shields.io/badge/x402-payments-0052ff.svg)](https://x402.org)
[![rails: Base + Solana](https://img.shields.io/badge/rails-Base%20%2B%20Solana-14f195.svg)](#both-rails-always)

---

## ⚠️ Terms of service — read this first

**Automating a website you do not own or have permission to automate may breach its terms of service, and in some jurisdictions may break the law.** This is a tool for driving browsers. It does not know, and cannot check, whether you are allowed to drive a particular one.

Before you point a flow at a site that isn't yours:

- **Read its terms of service.** Most sites explicitly prohibit automated access, scraping, or account use by non-humans. A ToS prohibition is a contract term, and breaching it can be a contract breach regardless of how you technically accessed the site.
- **Check `robots.txt` and any published API terms.** If there's an API, use the API. A bridge is for sites that don't have one — not for routing around one you'd rather not pay for.
- **Never bridge an authenticated session you don't own.** Automating someone else's account with their password is a different and much more serious category of problem, and computer-misuse statutes (CFAA in the US, the Computer Misuse Act in the UK, and equivalents elsewhere) can apply.
- **Don't circumvent access controls.** CAPTCHAs, rate limits, bot detection, and paywalls exist to say no. Defeating them is not a technical detail.
- **Respect personal data.** Anything you extract about identifiable people brings GDPR/CCPA obligations along with it, whoever's site it came from.
- **Reselling a paid bridge makes it worse, not better.** Charging $0.05 per run of someone else's site converts a ToS issue into a commercial one, and you will be the party doing the charging.

**The flows bundled with this repository target pages this repository serves itself** (`public/demo/`). No third-party site is automated by anything shipped here. That was a deliberate choice, and it's the model to copy: bridge your own systems, or systems you've been given written permission to bridge.

If you deploy this, **you** are the operator, and the legality of every flow it serves is yours. Flows carry an `authorized: true` marker for the author to assert that permission exists; it's informational, and it does not transfer responsibility to anyone else.

---

## The problem

An enormous amount of commerce still lives behind a form. No API, no partner programme, no webhook — just a page, a submit button, and a confirmation screen. An agent that can pay for things cannot use any of it.

A bridge closes that gap: declare the click path once, expose it as an x402 endpoint, and the agent buys the outcome without ever knowing a browser was involved.

## Why x402 for this

Browser automation is expensive in a way API calls aren't — a real Chromium, a real page load, seconds of wall clock. Metering it per run rather than per month is the only pricing that reflects the cost. And the caller is a program: it wants to pay for one outcome, right now, without an account, a key, or a contract.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-browser-bridge && cd x402-browser-bridge
npm install                          # downloads Chromium
cp .env.example .env
npm run dev
```

```bash
curl -s localhost:4034/flows | jq '.flows[] | {route, price, inputs: (.inputs|keys)}'
npm run client                       # pay $0.05, run the flow, get the artifact
```

## API

| Route | Price | What you get back |
|---|---|---|
| `POST /run/:flow` | **$0.05** | `{ extracted, screenshots, steps }` — signed, in the 200 body |
| `GET /flows` | free | Every declared flow: inputs, extracted fields, price, host allowlist |
| `POST /verify` | free | Signature check on a run record |
| `GET /health` | free | Liveness, rails, flow count, browser availability |

Prices come from the flow files, so **adding a YAML file adds a priced route** — no code change.

## A flow

```yaml
name: demo-booking
description: Book a table on a site that has no API.
price: "$0.05"

allowHosts: [localhost, 127.0.0.1]     # the security boundary. Required.
authorized: true
authorizationNote: The target page is served by this repository.

inputs:
  name:  { type: string, required: true }
  email: { type: string, required: true, pattern: '[^@\s]+@[^@\s]+\.[^@\s]+' }
  date:  { type: string, required: true, pattern: '\d{4}-\d{2}-\d{2}' }
  partySize: { type: string, default: "2", pattern: '1|2|4|6|8' }

steps:
  - goto: "{{baseUrl}}/demo/booking.html"
  - type:   { selector: "#name",  value: "{{inputs.name}}" }
  - type:   { selector: "#email", value: "{{inputs.email}}" }
  - type:   { selector: "#date",  value: "{{inputs.date}}" }
  - select: { selector: "#party", value: "{{inputs.partySize}}" }
  - screenshot: form
  - click: "#submit"
  - waitFor: "#confirmation:not([hidden])"
    timeoutMs: 8000
  - screenshot: confirmation

extract:
  reference: { selector: "#reference" }
  table:     { selector: "#table" }
  errorMessage: { selector: "#error:not([hidden])", optional: true }
```

Steps: `goto` · `click` · `type` · `select` · `press` · `waitFor` · `waitForText` · `wait` · `scroll` · `screenshot`. One action per step, each with an optional `label`, `timeoutMs` and `optional: true`.

**A flow cannot execute arbitrary JavaScript.** Templating is `{{inputs.x}}` and `{{baseUrl}}` — no expressions, no calls. Adding a flow is a config change with a reviewable diff.

## Failure is an artifact, not an error

```jsonc
{
  "run": {
    "payload": {
      "status": "failed",
      "error": "step 8 (wait for the confirmation panel) failed: Waiting for selector `#confirmation:not([hidden])` failed",
      "extracted": { "errorMessage": "No tables available for that name. Please try another time." },
      "screenshots": { "form": "iVBORw0…", "failure": "iVBORw0…" },
      "steps": [ { "index": 7, "action": "waitFor", "status": "failed", "durationMs": 8003, "error": "…" } ]
    },
    "signature": "…", "algorithm": "HMAC-SHA256"
  }
}
```

Still a `200`. The payment settled before the browser started, so a bare 500 would take the money and teach the caller nothing. Instead you get the step that broke, the page at that moment, and whatever the site said — which is usually the actual answer ("no tables available"), not a bug.

**What fails *free*, before payment:** unknown flow (404), malformed inputs (400), and no browser available (503). Those are checked ahead of the paywall, so you are never charged for a run that could not have happened.

## Both rails, always

| rail | network | asset | payTo | facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` (or `base`) | USDC | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `x402.org/facilitator` |
| Solana | `solana` (or `solana-devnet`) | USDC | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `facilitator.payai.network` |

Every 402 lists both; the client picks. On Solana the facilitator's `extra.feePayer` sponsors the network fee, so payers need only USDC and no SOL.

## Use it as a library

```ts
import { loadFlows, validateInputs, FlowRunner } from "x402-browser-bridge";

const { flows } = loadFlows("flows");
const runner = new FlowRunner({ baseUrl: "https://example.test" });

const flow = flows.get("demo-booking")!;
const result = await runner.run(flow, validateInputs(flow, {
  name: "Ada", email: "ada@example.com", date: "2026-09-01", partySize: "4",
}));

result.status;      // "completed"
result.extracted;   // { reference: "DB-1FLISL", table: "T07", … }
result.screenshots; // { form: "<base64>", confirmation: "<base64>" }
result.steps;       // per-step log with timings
```

One Chromium is shared across runs (launching per request would triple the latency of a $0.05 call); each run gets a fresh incognito context, so cookies and storage never leak between customers.

## Safety model

Three layers, because a browser is a large attack surface:

1. **Declarative flows.** No `eval`, no script injection, no dynamic selectors. YAML in, clicks out.
2. **Per-flow host allowlist.** `allowHosts` is required. Navigation to anything else is aborted at the request-interception layer — so even a click that triggers an off-site redirect can't follow it.
3. **Budgets.** Whole-run `timeoutMs` (default 60s, hard cap 180s), per-step timeouts, max 60 steps, and a 128 KB request body limit.

Input values are validated against the flow's declared types and patterns *before* payment, and truncated in the step log so a log dump doesn't echo everything the caller typed.

## Real backend / API keys

No API keys. The only external dependency is Chromium, which `npm install` downloads. In a container without it, set `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` — `/health` reports `browserAvailable`, and `POST /run/:flow` returns a free 503 rather than charging for a run that can't start.

The demo flows produce **real** results from a real browser against real pages; nothing here is fixtures.

## For AI agents

- **`skill.md`** — the agent-facing contract: routes, prices, run-record schema, error codes.
- **`/.well-known/x402`** — machine-readable manifest with per-flow input/output schemas.
- **`openapi.json`** — OpenAPI 3.1 including the 402 response.
- **MCP** — `examples/mcp-tool.md` exposes flows as Claude tools, including how to hand screenshots to a vision model.
- **Discovery** — list your deployment on [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market).

## Docs

Full docs: **https://nirholas.github.io/x402-browser-bridge/** — [tutorial](https://nirholas.github.io/x402-browser-bridge/tutorial), [API reference](https://nirholas.github.io/x402-browser-bridge/api), [for agents](https://nirholas.github.io/x402-browser-bridge/agents).

## Support

Questions, bugs, integrations: **nichxbt@gmail.com**

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## License

Apache-2.0 — see [LICENSE](./LICENSE). The licence grants you rights to *this software*; it grants you nothing with respect to any website you point it at.
