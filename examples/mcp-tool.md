# Expose x402-browser-bridge as MCP tools

The interesting bit: generate one tool per flow from `GET /flows`, so adding a YAML file adds a tool with no code change.

> Read the [ToS section](../README.md#️-terms-of-service--read-this-first) before exposing a bridge over a site you don't own. A model given a tool will use it.

## Install

```bash
npm install @modelcontextprotocol/sdk x402-fetch viem zod
```

## The server

`mcp-browser-bridge.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z, type ZodRawShape } from "zod";

const BASE_URL = process.env.BRIDGE_URL ?? "http://localhost:4034";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const pay = wrapFetchWithPayment(fetch, account, 100_000n);   // ≤ $0.10 per run

const server = new McpServer({ name: "x402-browser-bridge", version: "0.1.0" });

interface FlowSummary {
  name: string; description: string; price: string;
  inputs: Record<string, { type?: string; required?: boolean; description?: string; default?: unknown }>;
  extracts: string[]; screenshots: string[];
  authorized: boolean; authorizationNote?: string;
}

// One tool per declared flow, built from the live catalogue.
const { flows } = (await fetch(`${BASE_URL}/flows`).then(r => r.json())) as { flows: FlowSummary[] };

for (const flow of flows) {
  const shape: ZodRawShape = {};
  for (const [key, spec] of Object.entries(flow.inputs)) {
    let field: z.ZodTypeAny =
      spec.type === "number" ? z.number() : spec.type === "boolean" ? z.boolean() : z.string();
    if (spec.description) field = field.describe(spec.description);
    shape[key] = spec.required ? field : field.optional();
  }

  server.tool(
    `run_${flow.name.replace(/-/g, "_")}`,
    `${flow.description} Costs ${flow.price} USDC per run and drives a real browser, so it takes seconds. ` +
      `Returns extracted data, screenshots and a step log. A run with status "failed" is still a paid result — ` +
      `read extracted and the step log before retrying; most failures are the site saying no, and retrying costs again. ` +
      (flow.authorized
        ? `The operator declares this flow authorised${flow.authorizationNote ? `: ${flow.authorizationNote.trim()}` : "."}`
        : `⚠️ The operator has NOT declared this flow authorised by the target site.`),
    shape,
    async (args) => {
      const res = await pay(`${BASE_URL}/run/${flow.name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      const body = await res.json();
      const run = body?.run?.payload;
      if (!run) return { content: [{ type: "text", text: JSON.stringify(body) }], isError: !res.ok };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: run.status, error: run.error, durationMs: run.durationMs, extracted: run.extracted,
                steps: run.steps.map((s: { index: number; label: string; status: string; error?: string }) =>
                  `${s.index + 1}. ${s.label}: ${s.status}${s.error ? ` — ${s.error}` : ""}`) },
              null, 2,
            ),
          },
          // Give the model the page itself. When the extractors come back empty
          // this is often the only thing that explains why.
          ...Object.entries(run.screenshots as Record<string, string>)
            .filter(([, data]) => data)
            .map(([, data]) => ({
              type: "image" as const,
              data,                        // already raw base64, no data: prefix
              mimeType: "image/png" as const,
            })),
        ],
        // Only a protocol failure is an error. A failed flow is a paid result.
        isError: !res.ok,
      };
    },
  );
}

server.tool(
  "list_flows",
  "List every browser flow this bridge offers, with prices, input schemas and whether the operator " +
    "declares the target site permits automation. Free — call it before planning.",
  {},
  async () => {
    const res = await fetch(`${BASE_URL}/flows`);
    return { content: [{ type: "text", text: await res.text() }] };
  },
);

await server.connect(new StdioServerTransport());
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "x402-browser-bridge": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-browser-bridge.ts"],
      "env": {
        "PRIVATE_KEY": "0xYourAgentWalletKey",
        "BRIDGE_URL": "http://localhost:4034"
      }
    }
  }
}
```

## Notes that matter in practice

- **A failed run is not `isError`.** Key it off the HTTP status. Mark a failed flow as an error and the model retries a $0.05 call whose failure was deterministic — usually the site simply refusing.
- **Return the screenshots as image content.** This is the single highest-value thing you can do here. When `extracted` comes back empty, the model can look at the page and tell you the form moved, the site is down, or a CAPTCHA appeared.
- **Put the price in the tool description.** Models are noticeably more careful with a tool that says "costs $0.05 and takes seconds" than one that doesn't.
- **Surface `authorized: false` loudly** in the description, as above. If the operator hasn't declared permission, the model should hesitate — and be able to tell the user why.
- **Cap the wallet.** The third argument to `wrapFetchWithPayment` bounds any single run.
- **Validate before paying.** The bridge rejects bad inputs for free, but a model that reads `list_flows` first gets it right on the first attempt and saves the round trip.
