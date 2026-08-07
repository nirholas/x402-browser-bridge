# For AI agents — x402-browser-bridge

Buying an outcome from a website that has no API.

---

## 0. Read this before choosing a bridge

This service drives a real browser through a real website. **Automating a site the operator doesn't own may breach that site's terms of service.** `GET /flows` reports `authorized` and `authorizationNote` per flow — the flow author's assertion that permission exists. It's informational, and an operator can be wrong.

If you're selecting a bridge on a user's behalf, prefer flows declared authorised, prefer bridges over the operator's own systems, and don't route a user around a site's stated wishes because a paid endpoint made it convenient.

## 1. Discovery

| what | where | for |
|---|---|---|
| `GET /flows` | live, free | The real catalogue: prices, input schemas, extracted fields, host allowlists |
| `skill.md` | [raw](https://raw.githubusercontent.com/nirholas/x402-browser-bridge/main/skill.md) | Routes, run-record schema, error codes |
| `/.well-known/x402` | `<BASE_URL>/.well-known/x402` | Machine-readable manifest with per-flow schemas |
| `openapi.json` | repo root | OpenAPI 3.1 including the 402 response |

Always read `/flows` first — it's free and it's the only source that matches what the deployment actually has loaded.

## 2. Paying — either rail

```jsonc
{
  "x402Version": 1,
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "50000",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" } },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "50000",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "2wKup…" } }
  ]
}
```

`extra.feePayer` on the Solana entry is the facilitator's sponsor — it pays the SOL network fee, so you need **only USDC, no SOL**.

## 3. Validate locally before paying

The three pre-payment failures are free, but a round trip isn't free of *time*. Fetch the input schema once and check against it:

```ts
const { flows } = await fetch(`${BASE}/flows`).then(r => r.json());
const flow = flows.find(f => f.name === "demo-booking");

for (const [key, spec] of Object.entries(flow.inputs)) {
  if (spec.required && !(key in args)) throw new Error(`missing ${key}`);
  if (spec.pattern && !new RegExp(`^(?:${spec.pattern})$`).test(String(args[key]))) {
    throw new Error(`${key} does not match ${spec.pattern}`);
  }
}
```

Also check `GET /health` → `browserAvailable` before a batch. If it's false, every run will 503 (free, but pointless).

## 4. Reading a run record

**`status: "failed"` is not a protocol error.** The payment settled, the browser ran, and you got a paid-for artifact. Read it before deciding anything:

```ts
const { run } = await pay(`${BASE}/run/demo-booking`, { … }).then(r => r.json());

if (run.payload.status === "failed") {
  const lastStep = run.payload.steps.at(-1);
  const siteSaid = run.payload.extracted.errorMessage;
  // siteSaid: "No tables available for that name."
  // lastStep: { action: "waitFor", label: "wait for the confirmation panel", status: "failed" }
}
```

Three questions the record answers, in order:

1. **Did the site refuse?** Check `extracted` for an error field. If the site said "no availability", that *is* your answer. Report it; don't retry.
2. **Did a selector stop matching?** Look at the failing step's `action` and `label`. If a `waitFor` timed out on a page that previously worked, the site's markup probably changed — a human needs to update the flow. Retrying won't fix it.
3. **Did it time out under load?** `durationMs` near the flow's `timeoutMs`, with early steps slow. Retrying later may work.

**Never retry a failed run with identical inputs without reading the log first.** Each attempt is another $0.05 and the failure is usually deterministic.

## 5. Screenshots

`run.payload.screenshots` is a map of names to **raw base64 PNG** — no `data:` prefix. Two good uses:

```ts
// Show the user what happened
const dataUri = `data:image/png;base64,${run.payload.screenshots.confirmation}`;

// Or hand it to a vision model when the extractors came back empty and you
// need to work out what the page is actually showing
messages.push({
  role: "user",
  content: [
    { type: "image", source: { type: "base64", media_type: "image/png",
                               data: run.payload.screenshots.failure } },
    { type: "text", text: "This flow failed at 'wait for the confirmation panel'. What does the page say?" },
  ],
});
```

That second pattern is genuinely useful: the extractors only know the selectors the flow author declared, but the screenshot has everything.

## 6. Budgeting

$0.05 and seconds of wall clock per run — three orders of magnitude more than a typical API call, in both money and time.

- **Batch by flow, not by item**, where the flow supports it. `demo-catalog` returns every matching row in one run; searching per-SKU would cost 20× as much.
- **Cache the result.** A booking reference doesn't change. Re-running a flow to re-read something you already have is pure waste.
- **Set a wallet cap.** `wrapFetchWithPayment(fetch, signer, 100_000n)` limits any single call to $0.10.
- **Consider a spend policy.** [x402-agent-wallet](https://github.com/nirholas/x402-agent-wallet) enforces daily and per-merchant budgets before anything is signed.

## 7. MCP integration

[`examples/mcp-tool.md`](https://github.com/nirholas/x402-browser-bridge/blob/main/examples/mcp-tool.md) shows how to expose flows as Claude tools — including generating one tool per flow from `/flows`, and returning screenshots as image content so the model can look at the page itself.

## 8. Getting listed

- **[x402scan.com](https://x402scan.com)** — point it at your `/.well-known/x402`.
- **x402 Bazaar** — the protocol's own resource directory; same manifest format.
- **[agentic.market](https://agentic.market)** — agent-facing marketplace listing.

Keep the manifest honest about `authorized` — an index full of bridges over unwilling third parties is bad for everyone in it.

---

[Tutorial](./tutorial.md) · [API reference](./api.md) · Contact: nichxbt@gmail.com
