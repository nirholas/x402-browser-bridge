/**
 * The full x402 flow: read the catalogue, get a 402, pay, run a browser flow,
 * read the artifact — including the failure path, which is also an artifact.
 *
 *   PRIVATE_KEY=0x… npx tsx examples/agent-client.ts
 *
 * Without PRIVATE_KEY the script still shows the free catalogue and the 402.
 */
import { writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4034";

interface RunResponse {
  run: {
    payload: {
      status: "completed" | "failed";
      durationMs: number;
      error?: string;
      extracted: Record<string, unknown>;
      screenshots: Record<string, string>;
      steps: { index: number; action: string; label: string; status: string; durationMs: number; error?: string }[];
    };
    signature: string;
  };
}

// ── 1. Free: the catalogue ──────────────────────────────────────────────────
// An agent should always read this first: it carries the price, the input
// schema, and the terms-of-service posture of every flow on offer.
const catalogue = (await fetch(`${BASE_URL}/flows`).then((r) => r.json())) as {
  flows: { name: string; route: string; price: string; inputs: Record<string, unknown>; authorized: boolean; authorizationNote?: string }[];
  notice: string;
};

console.log("Available flows (free to list):");
for (const flow of catalogue.flows) {
  console.log(`  ${flow.route.padEnd(28)} ${flow.price}  inputs: ${Object.keys(flow.inputs).join(", ")}`);
  console.log(`  ${"".padEnd(28)} authorized: ${flow.authorized}${flow.authorizationNote ? ` — ${flow.authorizationNote.trim()}` : ""}`);
}
console.log(`\n⚠️  ${catalogue.notice}\n`);

// ── 2. Unpaid request: see what the service accepts ─────────────────────────
const booking = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  date: "2026-09-01",
  partySize: "4",
};

const challenge = await fetch(`${BASE_URL}/run/demo-booking`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(booking),
});

if (challenge.status !== 402) {
  console.error(`Expected 402, got ${challenge.status}: ${await challenge.text()}`);
  process.exit(1);
}

const { accepts } = (await challenge.json()) as {
  accepts: { network: string; maxAmountRequired: string; payTo: string }[];
};

console.log("402 Payment Required — this service accepts:");
for (const accept of accepts) {
  console.log(
    `  ${accept.network.padEnd(14)} $${(Number(accept.maxAmountRequired) / 1e6).toFixed(2)} USDC → ${accept.payTo}`,
  );
}

if (!process.env.PRIVATE_KEY) {
  console.log("\nSet PRIVATE_KEY (a funded base-sepolia wallet) to pay and run the flow.");
  process.exit(0);
}

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const pay = wrapFetchWithPayment(fetch, account, 100_000n); // ≤ $0.10 per call

// ── 3. Run the flow ─────────────────────────────────────────────────────────
const res = await pay(`${BASE_URL}/run/demo-booking`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(booking),
});

const body = (await res.json()) as RunResponse;
const run = body.run.payload;

console.log(`\n${res.status} — flow ${run.status} in ${run.durationMs}ms`);
const receiptHeader = res.headers.get("x-payment-response");
if (receiptHeader) console.log("X-PAYMENT-RESPONSE:", decodeXPaymentResponse(receiptHeader));

console.log("\nExtracted:");
console.log(JSON.stringify(run.extracted, null, 2));

console.log("\nStep log:");
for (const step of run.steps) {
  const mark = step.status === "ok" ? "✓" : step.status === "skipped" ? "–" : "✗";
  console.log(`  ${mark} ${String(step.index + 1).padStart(2)}. ${step.label} (${step.durationMs}ms)${step.error ? ` — ${step.error}` : ""}`);
}

// Screenshots are raw base64 PNG, no data-URI prefix.
for (const [name, base64] of Object.entries(run.screenshots)) {
  if (!base64) continue;
  writeFileSync(`${name}.png`, Buffer.from(base64, "base64"));
  console.log(`\nWrote ${name}.png (${Math.round(base64.length / 1024)} KB base64)`);
}

// ── 4. The failure path is also an artifact ─────────────────────────────────
// `name: "unavailable"` makes the demo page refuse. Note what comes back: a
// 200, a step log pinpointing the step that timed out, a failure screenshot,
// and — most usefully — the site's own error message in `extracted`.
console.log("\n── now the failure path ──");

const failed = (await pay(`${BASE_URL}/run/demo-booking`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...booking, name: "unavailable" }),
}).then((r) => r.json())) as RunResponse;

console.log(`status: ${failed.run.payload.status}`);
console.log(`error:  ${failed.run.payload.error}`);
console.log(`site said: ${JSON.stringify(failed.run.payload.extracted.errorMessage)}`);
console.log("Retrying this with the same inputs would fail identically and cost another $0.05.");

// ── 5. The record is signed ─────────────────────────────────────────────────
const valid = await fetch(`${BASE_URL}/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body.run),
}).then((r) => r.json());
console.log("\nRun record signature valid:", valid.valid);

// ── Paying on Solana instead ────────────────────────────────────────────────
//
// The same 402 also offers `network: "solana"`. Build an SPL USDC
// transferChecked to `payTo` — the facilitator's `extra.feePayer` sponsors the
// SOL fee, so no SOL is needed — sign it, and send the base64 x402 payload:
//
//   import { prepareSolanaCheckout, encodeX402Payment }
//     from "@three-ws/x402-payment-modal/server";
//
//   const accept = accepts.find(a => a.network.startsWith("solana"))!;
//   const { tx_base64 } = await prepareSolanaCheckout({ accept, buyer: wallet.publicKey.toBase58() });
//   const signedTx = await wallet.signTransaction(tx_base64);
//   const { x_payment } = encodeX402Payment({ accept, signedTxBase64: signedTx, resourceUrl });
//   await fetch(resourceUrl, {
//     method: "POST",
//     headers: { "content-type": "application/json", "X-PAYMENT": x_payment },
//     body: JSON.stringify(booking),
//   });
//
// Or with x402-fetch, pass a multi-network signer and let it pick:
//
//   import { createSigner } from "x402-fetch";
//   const pay = wrapFetchWithPayment(fetch, {
//     evm: await createSigner("base-sepolia", process.env.EVM_KEY!),
//     svm: await createSigner("solana", process.env.SOLANA_KEY!),
//   });
