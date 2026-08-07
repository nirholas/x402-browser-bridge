import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parse } from "yaml";

/**
 * Flow definitions — the declarative half of the bridge.
 *
 * A flow is a YAML file describing how to drive one website: where to start,
 * what to fill in, what to click, what to wait for, and what to pull out. The
 * runner in `runner.ts` executes it; nothing here touches a browser.
 *
 * Keeping flows declarative is what makes this safe to expose as a paid API.
 * A flow cannot execute arbitrary JavaScript, cannot reach a host outside its
 * own allowlist, and cannot run forever. Adding a flow is a config change with
 * a reviewable diff, not a code change.
 */

export type StepType =
  | "goto"
  | "click"
  | "type"
  | "select"
  | "press"
  | "waitFor"
  | "waitForText"
  | "wait"
  | "scroll"
  | "screenshot";

/** One instruction. Exactly one of the action keys is set. */
export interface FlowStep {
  /** Human label used in the step log. Defaults to a description of the action. */
  label?: string;
  /** Navigate to a URL (templated). Must resolve to an allowed host. */
  goto?: string;
  /** CSS selector to click. */
  click?: string;
  /** Fill a field: `{ selector, value }`. `value` is templated. */
  type?: { selector: string; value: string };
  /** Choose an option in a `<select>`: `{ selector, value }`. */
  select?: { selector: string; value: string };
  /** Send a raw key to the page, e.g. `Enter`. */
  press?: string;
  /** Wait for a selector to appear. */
  waitFor?: string;
  /** Wait until the page contains this text. */
  waitForText?: string;
  /** Wait a fixed number of milliseconds. Capped at 10s. */
  wait?: number;
  /** Scroll to a selector, or `"bottom"`. */
  scroll?: string;
  /** Capture a screenshot under this name. */
  screenshot?: string;
  /** Per-step timeout in ms. Defaults to the flow's `timeoutMs`. */
  timeoutMs?: number;
  /** When true, a failure is logged and the flow continues. */
  optional?: boolean;
}

/** How to pull one value out of the final page. */
export interface FlowExtractor {
  selector: string;
  /** `text` (default), `html`, or an attribute name like `href` / `value`. */
  attr?: string;
  /** Collect every match instead of the first. */
  all?: boolean;
  /** A miss is null rather than a flow failure. */
  optional?: boolean;
}

export interface FlowInput {
  type?: "string" | "number" | "boolean";
  required?: boolean;
  description?: string;
  default?: string | number | boolean;
  /** Reject values that don't match this anchored regular expression. */
  pattern?: string;
}

export interface Flow {
  name: string;
  description: string;
  /** x402 price, e.g. `"$0.05"`. */
  price: string;
  /**
   * Hosts this flow may reach. A flow that tries to navigate anywhere else
   * fails immediately — an allowlist is the whole security model here.
   */
  allowHosts: string[];
  inputs: Record<string, FlowInput>;
  steps: FlowStep[];
  extract: Record<string, FlowExtractor>;
  /** Whole-run budget in ms. Default 60s, capped at 180s. */
  timeoutMs: number;
  /** Viewport used for the run and its screenshots. */
  viewport: { width: number; height: number };
  /** Where the definition came from, for the /flows listing. */
  file: string;
  /**
   * Set by the flow author when the target site's terms permit automation —
   * e.g. it's your own site, or you have written permission. Purely
   * informational: the operator is responsible either way.
   */
  authorized?: boolean;
  /** Free-form note about that authorisation, surfaced in `/flows`. */
  authorizationNote?: string;
}

export class FlowValidationError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "FlowValidationError";
  }
}

const STEP_KEYS: StepType[] = [
  "goto",
  "click",
  "type",
  "select",
  "press",
  "waitFor",
  "waitForText",
  "wait",
  "scroll",
  "screenshot",
];

const MAX_TIMEOUT_MS = 180_000;
const MAX_STEPS = 60;

/** Parse and validate one YAML flow definition. */
export function parseFlow(source: string, file: string): Flow {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (err) {
    throw new FlowValidationError(file, `invalid YAML — ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object") throw new FlowValidationError(file, "flow must be a YAML mapping");

  const flow = raw as Record<string, unknown>;
  const name = String(flow.name ?? basename(file, extname(file)));
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new FlowValidationError(file, `name "${name}" must be lowercase kebab-case`);
  }

  const price = String(flow.price ?? "$0.05");
  if (!/^\$\d+(\.\d+)?$/.test(price)) {
    throw new FlowValidationError(file, `price "${price}" must look like "$0.05"`);
  }

  const allowHosts = asStringArray(flow.allowHosts);
  if (allowHosts.length === 0) {
    throw new FlowValidationError(
      file,
      "allowHosts is required — a flow must declare which hosts it may reach",
    );
  }

  const steps = Array.isArray(flow.steps) ? (flow.steps as Record<string, unknown>[]) : [];
  if (steps.length === 0) throw new FlowValidationError(file, "steps must be a non-empty list");
  if (steps.length > MAX_STEPS) throw new FlowValidationError(file, `too many steps (max ${MAX_STEPS})`);

  const parsedSteps = steps.map((step, index) => parseStep(step, index, file));
  if (!parsedSteps.some((step) => step.goto)) {
    throw new FlowValidationError(file, "at least one step must be a `goto`");
  }

  return {
    name,
    description: String(flow.description ?? name),
    price,
    allowHosts,
    inputs: parseInputs(flow.inputs, file),
    steps: parsedSteps,
    extract: parseExtractors(flow.extract, file),
    timeoutMs: Math.min(Number(flow.timeoutMs ?? 60_000), MAX_TIMEOUT_MS),
    viewport: {
      width: Number((flow.viewport as { width?: number } | undefined)?.width ?? 1280),
      height: Number((flow.viewport as { height?: number } | undefined)?.height ?? 900),
    },
    file,
    authorized: flow.authorized === true,
    authorizationNote: flow.authorizationNote ? String(flow.authorizationNote) : undefined,
  };
}

function parseStep(step: Record<string, unknown>, index: number, file: string): FlowStep {
  const present = STEP_KEYS.filter((key) => step[key] !== undefined);
  if (present.length === 0) {
    throw new FlowValidationError(file, `step ${index + 1} has no action (one of: ${STEP_KEYS.join(", ")})`);
  }
  if (present.length > 1) {
    throw new FlowValidationError(file, `step ${index + 1} has ${present.length} actions; use one per step`);
  }

  const parsed: FlowStep = {
    label: step.label ? String(step.label) : undefined,
    optional: step.optional === true,
    timeoutMs: step.timeoutMs !== undefined ? Number(step.timeoutMs) : undefined,
  };

  const key = present[0];
  switch (key) {
    case "type":
    case "select": {
      const value = step[key] as { selector?: unknown; value?: unknown };
      if (!value?.selector || value.value === undefined) {
        throw new FlowValidationError(file, `step ${index + 1} \`${key}\` needs { selector, value }`);
      }
      parsed[key] = { selector: String(value.selector), value: String(value.value) };
      break;
    }
    case "wait":
      parsed.wait = Math.min(Number(step.wait), 10_000);
      break;
    default:
      (parsed as Record<string, unknown>)[key] = String(step[key]);
  }
  return parsed;
}

function parseInputs(raw: unknown, file: string): Record<string, FlowInput> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") throw new FlowValidationError(file, "inputs must be a mapping");
  const inputs: Record<string, FlowInput> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    if (spec.pattern !== undefined) {
      try {
        new RegExp(String(spec.pattern));
      } catch {
        throw new FlowValidationError(file, `input "${key}" has an invalid pattern`);
      }
    }
    inputs[key] = {
      type: (spec.type as FlowInput["type"]) ?? "string",
      required: spec.required === true,
      description: spec.description ? String(spec.description) : undefined,
      default: spec.default as FlowInput["default"],
      pattern: spec.pattern ? String(spec.pattern) : undefined,
    };
  }
  return inputs;
}

function parseExtractors(raw: unknown, file: string): Record<string, FlowExtractor> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") throw new FlowValidationError(file, "extract must be a mapping");
  const extractors: Record<string, FlowExtractor> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const spec = typeof value === "string" ? { selector: value } : (value as Record<string, unknown>);
    if (!spec?.selector) throw new FlowValidationError(file, `extractor "${key}" needs a selector`);
    extractors[key] = {
      selector: String(spec.selector),
      attr: spec.attr ? String(spec.attr) : "text",
      all: spec.all === true,
      optional: spec.optional === true,
    };
  }
  return extractors;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.map(String) : [];
}

/** Load every `.yaml` / `.yml` flow in a directory. */
export function loadFlows(directory: string): { flows: Map<string, Flow>; errors: string[] } {
  const flows = new Map<string, Flow>();
  const errors: string[] = [];
  if (!existsSync(directory)) return { flows, errors: [`flow directory not found: ${directory}`] };

  for (const entry of readdirSync(directory).sort()) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const file = join(directory, entry);
    try {
      const flow = parseFlow(readFileSync(file, "utf8"), file);
      if (flows.has(flow.name)) {
        errors.push(`${file}: duplicate flow name "${flow.name}"`);
        continue;
      }
      flows.set(flow.name, flow);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { flows, errors };
}

/**
 * Substitute `{{ inputs.x }}` and `{{ baseUrl }}` in a template string.
 * Deliberately dumb: no expressions, no function calls, no property chains
 * beyond one level. A flow file is config, not a program.
 */
export function render(template: string, context: { inputs: Record<string, unknown>; baseUrl: string }): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
    if (path === "baseUrl") return context.baseUrl;
    if (path.startsWith("inputs.")) {
      const value = context.inputs[path.slice("inputs.".length)];
      return value === undefined || value === null ? "" : String(value);
    }
    return "";
  });
}

export class InputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}

/**
 * The flow's declared inputs as JSON-Schema properties.
 *
 * Used for `outputSchema.input.bodyFields` in the 402 challenge, so the paywall
 * tells an agent exactly which body fields *this* flow wants — the OpenAPI
 * document can only describe `/run/{flow}` generically, since flows are loaded
 * from `flows/` at boot.
 */
export function inputFields(flow: Flow): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(flow.inputs)) {
    fields[name] = {
      type: spec.type ?? "string",
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.pattern ? { pattern: spec.pattern } : {}),
      ...(spec.default !== undefined ? { default: spec.default } : {}),
      ...(spec.required ? { "x-required": true } : {}),
    };
  }
  return fields;
}

/** Check a request body against the flow's declared inputs, applying defaults. */
export function validateInputs(flow: Flow, body: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(flow.inputs)) {
    let value = body[key];
    if (value === undefined || value === "") value = spec.default;
    if (value === undefined || value === "") {
      if (spec.required) throw new InputValidationError(`missing required input "${key}"`);
      continue;
    }
    if (spec.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new InputValidationError(`input "${key}" must be a number`);
      value = number;
    } else if (spec.type === "boolean") {
      value = value === true || value === "true";
    } else {
      value = String(value);
      if (spec.pattern && !new RegExp(`^(?:${spec.pattern})$`).test(value as string)) {
        throw new InputValidationError(`input "${key}" does not match ${spec.pattern}`);
      }
    }
    resolved[key] = value;
  }
  return resolved;
}

/** True when a URL's host is allowed by the flow (exact match or subdomain). */
export function hostAllowed(url: string, allowHosts: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowHosts.some((allowed) => {
    const candidate = allowed.toLowerCase().replace(/^\*\./, "");
    return host === candidate || host.endsWith(`.${candidate}`);
  });
}
