# API reference — x402-browser-bridge

> **Automating a website you do not own may breach its terms of service.** See the [README's ToS section](https://github.com/nirholas/x402-browser-bridge#️-terms-of-service--read-this-first) before writing a flow against a third-party site.

- Machine-readable: [`openapi.json`](https://github.com/nirholas/x402-browser-bridge/blob/main/openapi.json) · [`/.well-known/x402`](https://github.com/nirholas/x402-browser-bridge/blob/main/public/.well-known/x402)
- Agent-facing summary: [`skill.md`](https://github.com/nirholas/x402-browser-bridge/blob/main/skill.md)

---

## HTTP API

Base URL: `http://localhost:4034` in dev.

### `POST /run/:flow` — price from the flow (bundled: $0.05)

Body: the flow's declared inputs as JSON.

**200 — completed**

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
      "extracted": { "reference": "DB-1FLISL", "table": "T07", "errorMessage": null },
      "screenshots": { "form": "iVBORw0KGgo…", "confirmation": "iVBORw0KGgo…" },
      "steps": [
        { "index": 0, "action": "goto", "label": "open the reservation form",
          "status": "ok", "durationMs": 121, "detail": "http://localhost:4034/demo/booking.html" }
      ],
      "inputs": { "name": "Ada Lovelace", "…": "…" }
    },
    "signature": "…", "algorithm": "HMAC-SHA256"
  },
  "flow": { "name": "demo-booking", "description": "…", "price": "$0.05" },
  "paidWith": { "rail": "evm", "network": "base-sepolia", "transaction": "0x…", "payer": "0x9a…" }
}
```

**200 — failed.** Same shape, plus `error`. `screenshots` includes a `failure` frame; `extracted` still carries whatever the page yielded.

`screenshots` values are raw base64 PNG with **no** data-URI prefix.

**Pre-payment failures** — these cost nothing:

| status | `error` | cause |
|---|---|---|
| 404 | `FLOW_NOT_FOUND` | No such flow. Response lists `available`. |
| 400 | `INVALID_INPUT` | Missing required input or failed `pattern`. Response echoes the `inputs` schema. |
| 503 | `BROWSER_UNAVAILABLE` | Chromium won't start. |

### `GET /flows` — free

```jsonc
{
  "flows": [
    { "name": "demo-booking", "description": "…", "price": "$0.05",
      "route": "POST /run/demo-booking",
      "inputs": { "name": { "type": "string", "required": true, "description": "…" } },
      "extracts": ["reference", "guest", "when", "covers", "table", "errorMessage"],
      "screenshots": ["form", "confirmation"],
      "steps": 9,
      "allowHosts": ["localhost", "127.0.0.1"],
      "timeoutMs": 45000,
      "authorized": true,
      "authorizationNote": "The target page is served by this repository." }
  ],
  "loadErrors": [],
  "notice": "Automating a website you do not own may breach its terms of service…"
}
```

`loadErrors` lists flow files that failed to parse — they're skipped, not fatal.

### `POST /verify` — free

`{ payload, signature }` → `{ valid: boolean }`.

### `GET /health` — free

`{ ok, service, rails, flows, browserAvailable }`.

### Error cases

| status | body | when |
|---|---|---|
| 402 | `{ x402Version, error, accepts[] }` | No/invalid/unsupported payment |
| 400 | `INVALID_INPUT` / `BAD_REQUEST` | Free |
| 404 | `FLOW_NOT_FOUND` | Free |
| 503 | `BROWSER_UNAVAILABLE` | Free |
| 500 | `no_payment_rail` | No valid payTo on either rail |
| 502 | `facilitator_unreachable` / `settlement_error` | Facilitator down; not charged |

There is **no 5xx for a failed flow** — that's a 200 with `status: "failed"`.

---

## Flow definition schema

One YAML file per flow, in `FLOWS_DIR` (default `flows/`).

| key | type | default | notes |
|---|---|---|---|
| `name` | string | filename | Lowercase kebab-case, ≤64 chars. Becomes the route. |
| `description` | string | `name` | Shown in `/flows` and the 402 challenge |
| `price` | string | `"$0.05"` | Must match `$N` or `$N.NN` |
| `allowHosts` | string[] | — | **Required.** Exact host or `*.example.com`. Subdomains match. |
| `inputs` | map | `{}` | See below |
| `steps` | list | — | **Required**, 1–60, at least one `goto` |
| `extract` | map | `{}` | See below |
| `timeoutMs` | number | `60000` | Whole-run budget; capped at 180000 |
| `viewport` | `{width,height}` | `1280×900` | Used for the run and its screenshots |
| `authorized` | boolean | `false` | Author asserts the target permits automation. Informational. |
| `authorizationNote` | string | — | Surfaced in `/flows` |

### Inputs

```yaml
inputs:
  email:
    type: string          # string | number | boolean
    required: true
    default: "2"
    pattern: '[^@\s]+@[^@\s]+\.[^@\s]+'   # anchored automatically
    description: Shown to callers in GET /flows.
```

Validated **before** payment. `pattern` applies to strings only and is wrapped in `^(?:…)$`.

### Steps

One action per step. Every step also takes `label`, `timeoutMs` and `optional: true`.

| action | shape | notes |
|---|---|---|
| `goto` | `goto: "{{baseUrl}}/path"` | Must resolve to an allowed host |
| `click` | `click: "#submit"` | Waits for the selector first |
| `type` | `type: { selector, value }` | Clears first; segmented inputs (date/time/month/week/color/range) are set directly |
| `select` | `select: { selector, value }` | `<select>` by option value |
| `press` | `press: "Enter"` | Raw key |
| `waitFor` | `waitFor: "#result"` | Selector appears |
| `waitForText` | `waitForText: "Confirmed"` | Body contains the text (templated) |
| `wait` | `wait: 500` | Fixed ms, capped at 10000 |
| `scroll` | `scroll: "#footer"` or `"bottom"` | |
| `screenshot` | `screenshot: confirmation` | Base64 PNG under that key |

`optional: true` logs a failure as `skipped` and carries on.

### Extractors

```yaml
extract:
  reference: "#ref"                                   # shorthand: selector, text
  updatedAt: { selector: "#u", attr: "datetime" }     # any attribute
  body:      { selector: "#main", attr: html }
  rows:      { selector: ".row", all: true }          # array of every match
  error:     { selector: "#err", optional: true }     # null instead of failing
```

`attr` is `text` (default), `html`, `value`, or an attribute name. **Extraction runs even after a step fails** — partial data usually explains what went wrong.

### Templating

`{{inputs.<name>}}` and `{{baseUrl}}` in `goto`, `type.value`, `select.value` and `waitForText`. No expressions, no function calls, no nested paths. A flow file is config, not a program.

---

## Library API

```ts
import {
  loadFlows, parseFlow, validateInputs, render, hostAllowed,
  FlowRunner, BrowserUnavailableError,
  FlowValidationError, InputValidationError,
} from "x402-browser-bridge";
```

### `loadFlows(directory)`

`{ flows: Map<string, Flow>, errors: string[] }`. Never throws — a bad file lands in `errors`.

### `parseFlow(source, file)`

Parse and validate one YAML string. Throws `FlowValidationError`.

### `validateInputs(flow, body)`

Applies defaults, coerces types, checks `pattern`. Returns the resolved inputs. Throws `InputValidationError`.

### `FlowRunner`

```ts
const runner = new FlowRunner({
  baseUrl: "https://example.internal",   // resolves {{baseUrl}}
  extraAllowHosts: [],                   // added to every flow's allowlist
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
});
```

| method | returns | notes |
|---|---|---|
| `ready()` | `Promise<Browser>` | Launches or reuses. Throws `BrowserUnavailableError`. |
| `available()` | `Promise<boolean>` | Health probe — use it to refuse payment when the browser is down |
| `run(flow, inputs)` | `Promise<RunResult>` | Never throws for flow-level failures |
| `close()` | `Promise<void>` | Shuts down the shared browser |

One browser is shared; each run gets its own incognito context.

### `RunResult`

```ts
interface RunResult {
  flow: string;
  status: "completed" | "failed";
  startedAt: string; finishedAt: string; durationMs: number;
  finalUrl: string | null;
  extracted: Record<string, unknown>;
  screenshots: Record<string, string>;   // base64 PNG
  steps: StepResult[];
  error?: string;
  inputs: Record<string, unknown>;
}

interface StepResult {
  index: number; action: string; label: string;
  status: "ok" | "skipped" | "failed";
  durationMs: number; detail?: string; error?: string;
}
```

### `hostAllowed(url, allowHosts)`

The allowlist check, exported so you can reuse it. Exact host or subdomain of an entry; `*.example.com` is accepted and normalised.

---

[Tutorial](./tutorial.md) · [For AI agents](./agents.md)
