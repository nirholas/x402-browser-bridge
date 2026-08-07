/**
 * x402-browser-bridge — turn a website flow into a paid API.
 *
 * Declare a flow in YAML, and this package drives a headless browser through it
 * and returns the extracted data, screenshots and a step log — as one artifact,
 * in the response body.
 *
 * ⚠️  Automating a site you do not own may breach its terms of service. See the
 * README's "Terms of service" section before pointing a flow at a third party.
 *
 * @example
 * ```ts
 * import { loadFlows, validateInputs, FlowRunner } from "x402-browser-bridge";
 *
 * const { flows } = loadFlows("flows");
 * const runner = new FlowRunner({ baseUrl: "https://example.test" });
 *
 * const flow = flows.get("demo-booking")!;
 * const result = await runner.run(flow, validateInputs(flow, {
 *   name: "Ada", email: "ada@example.com", date: "2026-09-01", partySize: "2",
 * }));
 *
 * result.status;       // "completed" | "failed"
 * result.extracted;    // { reference: "DB-1A2B3C", table: "T07", … }
 * result.screenshots;  // { form: "<base64 png>", confirmation: "…" }
 * result.steps;        // per-step log with timings and errors
 * ```
 */

export {
  loadFlows,
  parseFlow,
  validateInputs,
  render,
  hostAllowed,
  FlowValidationError,
  InputValidationError,
  type Flow,
  type FlowStep,
  type FlowInput,
  type FlowExtractor,
  type StepType,
} from "./flow.js";

export {
  FlowRunner,
  BrowserUnavailableError,
  type RunResult,
  type StepResult,
  type RunnerOptions,
} from "./runner.js";

export {
  paywall,
  paymentReceipt,
  activeRails,
  routeMatches,
  usingSuiteDefaultPayTo,
  mountSolanaCheckout,
  DEFAULT_EVM_PAY_TO,
  DEFAULT_SOLANA_PAY_TO,
  type PaymentReceipt,
  type PaywallOptions,
  type RailInfo,
  type RoutePrices,
  type RouteSchema,
} from "./payments.js";

export { sign, verify, signed, canonicalize, type SignedRecord } from "./sign.js";
