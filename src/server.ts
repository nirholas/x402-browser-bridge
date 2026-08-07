import "dotenv/config";
import express from "express";
import { readFileSync } from "node:fs";
import {
  activeRails,
  mountSolanaCheckout,
  paymentReceipt,
  paywall,
  usingSuiteDefaultPayTo,
  type RouteSchema,
} from "./payments.js";
import { loadFlows, validateInputs, inputFields, InputValidationError, type Flow } from "./flow.js";
import { FlowRunner } from "./runner.js";
import { signed, verify } from "./sign.js";
import { ROUTE_SCHEMAS } from "./schemas.js";

/**
 * x402-browser-bridge — turn a website flow into a paid API.
 *
 *   POST /run/:flow   $0.05  → { extracted, screenshots, steps } for that flow
 *   GET  /flows       free   → declared flows, their inputs and their prices
 *   POST /verify      free   → verify a signed run record
 *
 * ⚠️  Automating a site you do not own may breach its terms of service. The
 * bundled flows target pages this repository serves itself. Read the README's
 * "Terms of service" section before pointing a flow anywhere else.
 */

const port = Number(process.env.PORT || 4034);
const flowsDir = process.env.FLOWS_DIR || "flows";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;

const { flows, errors } = loadFlows(flowsDir);
for (const error of errors) console.warn(`[flows] ${error}`);
if (flows.size === 0) console.warn(`[flows] no valid flows found in ${flowsDir}/ — POST /run/:flow will 404`);

const runner = new FlowRunner({
  baseUrl: publicBaseUrl,
  extraAllowHosts: (process.env.EXTRA_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  headless: process.env.HEADLESS !== "false",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
});

const app = express();
app.use(express.json({ limit: "128kb" }));

// Prices come from the flow files themselves, so adding a flow adds a priced
// route without touching this file.
//
// Each flow also gets its own 402 schema: the generic `/run/{flow}` contract
// generated from openapi.json, with `bodyFields` narrowed to that flow's
// declared inputs. The spec can only describe the route generically — flows are
// loaded at boot — so the runtime challenge is where an agent learns that
// `demo-catalog` wants `query` and `demo-booking` wants `name`/`email`/`date`.
const runContract = ROUTE_SCHEMAS["POST /run/:flow"];
const PRICES: Record<string, string> = {};
const SCHEMAS: Record<string, RouteSchema> = {};
for (const flow of flows.values()) {
  const route = `POST /run/${flow.name}`;
  PRICES[route] = flow.price;
  // `pathParams` is dropped: on a concrete per-flow route the flow name is
  // already baked into the `resource` URL the challenge advertises.
  const { pathParams: _flowName, ...input } = runContract.input;
  SCHEMAS[route] = {
    ...runContract,
    input: { ...input, bodyType: "json", bodyFields: inputFields(flow) },
  };
}

/**
 * Catch-all for `/run/<anything>`, matched last because the per-flow keys above
 * were inserted first.
 *
 * Every `POST /run/*` must answer an unpaid request with a 402 — that is how a
 * directory or crawler discovers the route at all, and it probes with a
 * synthetic flow name it invented. Without this entry an unknown flow would 404
 * before the paywall ever ran, and the route would look unpriced. Paying against
 * a flow that does not exist still costs nothing: the preflight below rejects it
 * before the payment is verified or settled.
 */
const DEFAULT_RUN_PRICE = "$0.05"; // the price openapi.json advertises for /run/{flow}
PRICES["POST /run/:flow"] = DEFAULT_RUN_PRICE;
SCHEMAS["POST /run/:flow"] = runContract;

/**
 * Preflight, mounted BEFORE the paywall.
 *
 * x402's `exact` scheme is pay-then-serve, so anything that makes a run
 * impossible must be caught here — while the caller still has their money.
 * Unknown flow, malformed inputs, or a browser that won't start all fail free:
 * this runs before the paywall verifies or settles anything.
 *
 * It deliberately does nothing until the caller actually attempts payment. A
 * request with no `X-PAYMENT` header is either a first attempt or a discovery
 * probe, and both must fall through to the paywall and receive the 402
 * challenge — a crawler probing `/run/<invented-name>` has to learn the route's
 * price and schema, not a 404.
 */
app.post("/run/:flow", async (req, res, next) => {
  if (!req.header("X-PAYMENT")) return next();

  const flow = flows.get(req.params.flow);
  if (!flow) {
    res.status(404).json({
      error: "FLOW_NOT_FOUND",
      flow: req.params.flow,
      available: [...flows.keys()],
      hint: "GET /flows lists every declared flow with its inputs and price",
    });
    return;
  }

  try {
    validateInputs(flow, (req.body ?? {}) as Record<string, unknown>);
  } catch (err) {
    if (err instanceof InputValidationError) {
      res.status(400).json({
        error: "INVALID_INPUT",
        message: err.message,
        inputs: flow.inputs,
        hint: "Fix the inputs and retry — you have not been charged",
      });
      return;
    }
    throw err;
  }

  if (!(await runner.available())) {
    res.status(503).json({
      error: "BROWSER_UNAVAILABLE",
      message: "No browser could be started, so this flow cannot run. You have not been charged.",
      hint: "Operator: run `npx puppeteer browsers install chrome` or set PUPPETEER_EXECUTABLE_PATH",
    });
    return;
  }

  next();
});

app.use(
  paywall(PRICES, {
    service: "x402-browser-bridge",
    baseUrl: process.env.PUBLIC_BASE_URL,
    schemas: SCHEMAS,
  }),
);

/**
 * Execute the flow. Note the response is 200 even when the run fails: by this
 * point the payment has settled, and the step log plus failure screenshot are
 * the artifact — they tell you exactly which selector stopped matching. A bare
 * 500 would take the money and teach the caller nothing.
 */
app.post("/run/:flow", async (req, res) => {
  const flow = flows.get(req.params.flow) as Flow;
  const inputs = validateInputs(flow, (req.body ?? {}) as Record<string, unknown>);

  try {
    const result = await runner.run(flow, inputs);
    res.json({
      run: signed(result),
      flow: { name: flow.name, description: flow.description, price: flow.price },
      paidWith: paymentReceipt(res),
    });
  } catch (err) {
    // Only infrastructure failures reach here (the runner handles flow-level
    // errors internally). Still 200 with a record, for the same reason.
    res.json({
      run: signed({
        flow: flow.name,
        status: "failed" as const,
        error: err instanceof Error ? err.message : String(err),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        finalUrl: null,
        extracted: {},
        screenshots: {},
        steps: [],
        inputs,
      }),
      flow: { name: flow.name, description: flow.description, price: flow.price },
      paidWith: paymentReceipt(res),
    });
  }
});

/** Free: the catalogue. An agent reads this to learn what it can buy. */
app.get("/flows", (_req, res) => {
  res.json({
    flows: [...flows.values()].map((flow) => ({
      name: flow.name,
      description: flow.description,
      price: flow.price,
      route: `POST /run/${flow.name}`,
      inputs: flow.inputs,
      extracts: Object.keys(flow.extract),
      screenshots: flow.steps.filter((s) => s.screenshot).map((s) => s.screenshot),
      steps: flow.steps.length,
      allowHosts: flow.allowHosts,
      timeoutMs: flow.timeoutMs,
      authorized: flow.authorized === true,
      authorizationNote: flow.authorizationNote,
    })),
    loadErrors: errors,
    notice:
      "Automating a website you do not own may breach its terms of service. Flows marked authorized:false " +
      "have not been declared as permitted by the flow author. The operator of this deployment is responsible " +
      "for the legality of every flow it serves.",
  });
});

app.post("/verify", (req, res) => {
  const { payload, signature } = (req.body ?? {}) as { payload?: unknown; signature?: string };
  if (payload === undefined || !signature) {
    res.status(400).json({ error: "BAD_REQUEST", hint: "POST { payload, signature }" });
    return;
  }
  res.json({ valid: verify(payload, signature) });
});

app.get("/.well-known/x402", (_req, res) => {
  res.type("application/json").send(readFileSync("public/.well-known/x402", "utf8"));
});

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "x402-browser-bridge",
    rails: activeRails(),
    flows: flows.size,
    browserAvailable: await runner.available(),
  });
});

app.use(express.static("public"));

await mountSolanaCheckout(app);

const server = app.listen(port, () => {
  console.log(`\nx402-browser-bridge on http://localhost:${port}`);
  console.log("\nPayment rails (client picks one):");
  for (const rail of activeRails()) {
    console.log(`  ${rail.rail.padEnd(7)} ${rail.network.padEnd(14)} USDC → ${rail.payTo}`);
  }
  if (usingSuiteDefaultPayTo()) {
    console.log("  note: using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself");
  }
  console.log(`\nFlows loaded from ${flowsDir}/:`);
  for (const flow of flows.values()) {
    console.log(`  ${`POST /run/${flow.name}`.padEnd(28)} ${flow.price.padEnd(7)} hosts: ${flow.allowHosts.join(", ")}`);
  }
  if (flows.size === 0) console.log("  (none)");
  console.log("\nFree routes:\n  GET /flows\n  POST /verify\n  GET /.well-known/x402\n  GET /health");
  console.log("\n⚠️  Automating a site you do not own may breach its terms of service.");
  console.log("    The bundled flows target pages this server hosts itself. See the README.\n");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      await runner.close();
      server.close(() => process.exit(0));
    })();
  });
}
