import type { Browser, Page } from "puppeteer";
import { hostAllowed, render, type Flow, type FlowStep } from "./flow.js";

/**
 * The runner — the imperative half of the bridge.
 *
 * Takes a validated flow plus validated inputs, drives a headless browser
 * through the steps, and returns three things regardless of outcome:
 *
 *   1. `extracted`  — the data the flow declared it wanted
 *   2. `screenshots` — base64 PNGs, including one on failure
 *   3. `steps`      — a timestamped log of every action and its result
 *
 * That last one is why a failed run is still worth something. When a site
 * changes its markup, the step log tells you exactly which selector stopped
 * matching and shows you the page at that moment. Returning a bare error
 * instead would take the customer's money and teach them nothing.
 */

export interface StepResult {
  index: number;
  action: string;
  label: string;
  status: "ok" | "skipped" | "failed";
  durationMs: number;
  detail?: string;
  error?: string;
}

export interface RunResult {
  flow: string;
  status: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The final URL the browser landed on. */
  finalUrl: string | null;
  /** Values named by the flow's `extract` block. */
  extracted: Record<string, unknown>;
  /** Base64 PNGs, keyed by the name the step gave them. */
  screenshots: Record<string, string>;
  steps: StepResult[];
  /** Present when `status === "failed"`. */
  error?: string;
  inputs: Record<string, unknown>;
}

export interface RunnerOptions {
  /** Base URL used to resolve `{{ baseUrl }}` in flows. */
  baseUrl: string;
  /** Extra hosts every flow may reach, on top of its own allowlist. */
  extraAllowHosts?: string[];
  /** Run with a visible browser (debugging only). */
  headless?: boolean;
  /** Chromium executable, when not using the bundled download. */
  executablePath?: string;
}

export class BrowserUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `Could not start a browser: ${cause}. ` +
        `Install Chromium (\`npx puppeteer browsers install chrome\`) or set PUPPETEER_EXECUTABLE_PATH.`,
    );
    this.name = "BrowserUnavailableError";
  }
}

/**
 * Owns the Chromium process. One browser is shared across runs (launching one
 * per request would triple the latency of a $0.05 call); each run gets its own
 * incognito context so cookies and storage never leak between customers.
 */
export class FlowRunner {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(private readonly options: RunnerOptions) {}

  /** Launch (or reuse) the browser. Throws BrowserUnavailableError if it can't start. */
  async ready(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.launching ??= this.launch();
    try {
      this.browser = await this.launching;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  /** Cheap health probe used to refuse payment when the browser is down. */
  async available(): Promise<boolean> {
    try {
      await this.ready();
      return true;
    } catch {
      return false;
    }
  }

  private async launch(): Promise<Browser> {
    try {
      const puppeteer = (await import("puppeteer")).default;
      return await puppeteer.launch({
        headless: this.options.headless ?? true,
        executablePath: this.options.executablePath,
        // --no-sandbox is required inside most containers. --disable-dev-shm-usage
        // avoids Chromium crashing on the small /dev/shm containers usually get.
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
    } catch (err) {
      throw new BrowserUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  /** Execute one flow. Never throws for flow-level failures — those come back in the result. */
  async run(flow: Flow, inputs: Record<string, unknown>): Promise<RunResult> {
    const browser = await this.ready();
    const startedAt = new Date();
    const steps: StepResult[] = [];
    const screenshots: Record<string, string> = {};
    const extracted: Record<string, unknown> = {};
    let error: string | undefined;
    let finalUrl: string | null = null;

    const allowHosts = [...flow.allowHosts, ...(this.options.extraAllowHosts ?? [])];
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    try {
      await page.setViewport(flow.viewport);
      page.setDefaultTimeout(Math.min(flow.timeoutMs, 30_000));

      // Second line of defence: even if a click triggers navigation to a host
      // the flow never named, the request is aborted rather than followed.
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          if (!hostAllowed(request.url(), allowHosts)) {
            void request.abort("blockedbyclient");
            return;
          }
        }
        void request.continue();
      });

      const deadline = Date.now() + flow.timeoutMs;

      for (const [index, step] of flow.steps.entries()) {
        if (Date.now() > deadline) {
          error = `flow exceeded its ${flow.timeoutMs}ms budget`;
          steps.push({
            index,
            action: actionOf(step),
            label: labelOf(step),
            status: "skipped",
            durationMs: 0,
            detail: "budget exhausted",
          });
          continue;
        }

        const began = Date.now();
        try {
          const detail = await runStep(page, step, {
            inputs,
            baseUrl: this.options.baseUrl,
            allowHosts,
            screenshots,
            timeoutMs: step.timeoutMs ?? Math.min(flow.timeoutMs, 30_000),
          });
          steps.push({
            index,
            action: actionOf(step),
            label: labelOf(step),
            status: "ok",
            durationMs: Date.now() - began,
            detail,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          steps.push({
            index,
            action: actionOf(step),
            label: labelOf(step),
            status: step.optional ? "skipped" : "failed",
            durationMs: Date.now() - began,
            error: message,
          });
          if (!step.optional) {
            error = `step ${index + 1} (${labelOf(step)}) failed: ${message}`;
            break;
          }
        }
      }

      finalUrl = page.url();

      // Extraction runs even after a failure — partial data beats none, and it
      // often explains what went wrong (an error banner, a validation message).
      for (const [key, extractor] of Object.entries(flow.extract)) {
        try {
          extracted[key] = await extractValue(page, extractor);
        } catch (err) {
          if (!extractor.optional && !error) {
            error = `extractor "${key}" failed: ${err instanceof Error ? err.message : String(err)}`;
          }
          extracted[key] = null;
        }
      }

      // Always capture the final frame. On failure this is the single most
      // useful thing in the response.
      if (!screenshots.final) {
        screenshots[error ? "failure" : "final"] = await page
          .screenshot({ encoding: "base64", fullPage: false })
          .then(String)
          .catch(() => "");
      }
    } catch (err) {
      error ??= err instanceof Error ? err.message : String(err);
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }

    const finishedAt = new Date();
    return {
      flow: flow.name,
      status: error ? "failed" : "completed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      finalUrl,
      extracted,
      screenshots,
      steps,
      error,
      inputs,
    };
  }
}

interface StepContext {
  inputs: Record<string, unknown>;
  baseUrl: string;
  allowHosts: string[];
  screenshots: Record<string, string>;
  timeoutMs: number;
}

async function runStep(page: Page, step: FlowStep, ctx: StepContext): Promise<string | undefined> {
  const template = (value: string) => render(value, { inputs: ctx.inputs, baseUrl: ctx.baseUrl });

  if (step.goto !== undefined) {
    const url = template(step.goto);
    if (!hostAllowed(url, ctx.allowHosts)) {
      throw new Error(`host not allowed by this flow: ${safeHost(url)}`);
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: ctx.timeoutMs });
    return url;
  }

  if (step.click !== undefined) {
    await page.waitForSelector(step.click, { timeout: ctx.timeoutMs });
    await page.click(step.click);
    return step.click;
  }

  if (step.type !== undefined) {
    const value = template(step.type.value);
    await page.waitForSelector(step.type.selector, { timeout: ctx.timeoutMs });

    // Segmented inputs (date, time, month, week…) interpret keystrokes per
    // segment, so typing "2026-09-01" into one lands the digits in the wrong
    // fields. For those, set `.value` directly and fire the events a framework
    // would be listening for. Everything else is typed for real, because plenty
    // of pages only react to genuine keyboard events.
    const segmented = await page.$eval(step.type.selector, (element) =>
      ["date", "datetime-local", "month", "week", "time", "color", "range"].includes(
        (element as HTMLInputElement).type,
      ),
    );

    if (segmented) {
      await page.$eval(
        step.type.selector,
        (element, next) => {
          const input = element as HTMLInputElement;
          input.value = next as string;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        value,
      );
    } else {
      // Clear first: re-running a flow against a pre-filled form otherwise appends.
      await page.$eval(step.type.selector, (element) => {
        (element as HTMLInputElement).value = "";
      });
      await page.type(step.type.selector, value);
    }
    return `${step.type.selector} ← ${redact(value)}`;
  }

  if (step.select !== undefined) {
    const value = template(step.select.value);
    await page.waitForSelector(step.select.selector, { timeout: ctx.timeoutMs });
    await page.select(step.select.selector, value);
    return `${step.select.selector} ← ${value}`;
  }

  if (step.press !== undefined) {
    await page.keyboard.press(step.press as Parameters<Page["keyboard"]["press"]>[0]);
    return step.press;
  }

  if (step.waitFor !== undefined) {
    await page.waitForSelector(step.waitFor, { timeout: ctx.timeoutMs });
    return step.waitFor;
  }

  if (step.waitForText !== undefined) {
    const needle = template(step.waitForText);
    await page.waitForFunction(
      (text: string) => document.body?.innerText?.includes(text) ?? false,
      { timeout: ctx.timeoutMs },
      needle,
    );
    return needle;
  }

  if (step.wait !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, step.wait));
    return `${step.wait}ms`;
  }

  if (step.scroll !== undefined) {
    if (step.scroll === "bottom") {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } else {
      await page.waitForSelector(step.scroll, { timeout: ctx.timeoutMs });
      await page.$eval(step.scroll, (element) => element.scrollIntoView({ block: "center" }));
    }
    return step.scroll;
  }

  if (step.screenshot !== undefined) {
    ctx.screenshots[step.screenshot] = String(await page.screenshot({ encoding: "base64", fullPage: false }));
    return step.screenshot;
  }

  throw new Error("step has no recognised action");
}

/**
 * Pull one value out of the page.
 *
 * The reader is written out in full inside each `evaluate` callback rather than
 * shared as a helper: these functions are serialised and run in the *browser*,
 * where nothing from this module's scope exists.
 */
async function extractValue(
  page: Page,
  extractor: { selector: string; attr?: string; all?: boolean; optional?: boolean },
): Promise<unknown> {
  const attr = extractor.attr ?? "text";

  if (extractor.all) {
    return page.$$eval(
      extractor.selector,
      (elements, mode) =>
        elements.map((element) => {
          if (mode === "text") return (element as HTMLElement).innerText?.trim() ?? element.textContent?.trim() ?? null;
          if (mode === "html") return element.innerHTML;
          if (mode === "value") return (element as HTMLInputElement).value;
          return element.getAttribute(mode as string);
        }),
      attr,
    );
  }

  const handle = await page.$(extractor.selector);
  if (!handle) {
    if (extractor.optional) return null;
    throw new Error(`no element matched ${extractor.selector}`);
  }
  return handle.evaluate((element, mode) => {
    if (mode === "text") return (element as HTMLElement).innerText?.trim() ?? element.textContent?.trim() ?? null;
    if (mode === "html") return element.innerHTML;
    if (mode === "value") return (element as HTMLInputElement).value;
    return element.getAttribute(mode as string);
  }, attr);
}

function actionOf(step: FlowStep): string {
  for (const key of ["goto", "click", "type", "select", "press", "waitFor", "waitForText", "wait", "scroll", "screenshot"] as const) {
    if (step[key] !== undefined) return key;
  }
  return "unknown";
}

function labelOf(step: FlowStep): string {
  if (step.label) return step.label;
  const action = actionOf(step);
  const target = step.type?.selector ?? step.select?.selector ?? step.goto ?? step.click ?? step.waitFor ?? step.screenshot;
  return target ? `${action} ${target}` : action;
}

/** Keep step logs from echoing whatever the caller typed into a field verbatim. */
function redact(value: string): string {
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable url)";
  }
}
