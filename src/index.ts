// ElizaOS plugin for Tereno (https://www.tereno.xyz): paid Base contract
// safety verdicts, token/chain reads and prediction-market evidence over x402
// (USDC on Base). The agent pays with its own wallet; every call is capped per
// invocation (TERENO_MAX_PRICE_USD) and by a rolling daily budget
// (TERENO_DAILY_BUDGET_USD). No account or API key — the signed x402 payment
// is the identity.

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createHash } from "node:crypto";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { PaidCalls, TerenoBudgetError } from "./paid-calls.js";
import { createTerenoClient, TerenoPaymentPendingError, type CapabilityInput } from "tereno-client";

type PluginCapabilityInput =
  | CapabilityInput
  | {
      capabilityId: "prediction.evidence";
      question: string;
      market?: string;
      marketUrl?: string;
    }
  | {
      capabilityId: "token.launch.guard";
      address: string;
    }
  | {
      capabilityId: "token.holders.guard";
      address: string;
    };

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const PUBLIC_URL_RE = /https?:\/\/[^\s<>\"\x27]+/i;
const CAPABILITY_RE = /\b([a-z][a-z0-9]*(?:[._-][a-z0-9]+)+)\b/i;
const ARTIFACT_ID_RE = /sha256:[a-f0-9]{64}/i;

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function privateKey(): `0x${string}` | null {
  const raw = env("TERENO_PRIVATE_KEY") || env("EVM_PRIVATE_KEY");
  if (!raw) return null;
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  return /^0x[a-fA-F0-9]{64}$/.test(normalized) ? (normalized as `0x${string}`) : null;
}

// Defaults must cover the dearest thing the plugin can buy, or the client
// refuses the quote before paying and every guard degrades to "unavailable".
// See DEFAULT_MAX_PRICE_USD against CAPABILITY_PRICE_USD below;
// `src/index.test.ts` asserts the relationship.
export const DEFAULT_MAX_PRICE_USD = 0.1;
export const DEFAULT_DAILY_BUDGET_USD = 0.5;

function maxPriceUsd(): number {
  const parsed = Number(env("TERENO_MAX_PRICE_USD", String(DEFAULT_MAX_PRICE_USD)));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PRICE_USD;
}

/** Every price this plugin advertises, in ONE place.
 *
 *  Since 0.8.0 this table is only the offline fallback: at init the plugin
 *  reads GET /api/v1/capabilities and overwrites these entries, then rebuilds
 *  the action descriptions, so a repricing reaches installed agents without a
 *  new plugin version. What is actually charged always comes from the 402.
 *
 *  These numbers are read by the action descriptions the model sees, by
 *  TERENO_PREVIEW and by the seeding reserve — so when an agent quotes a price
 *  to a user, it quotes this table.
 *
 *  `src/index.test.ts` asserts each entry against GET /api/v1/capabilities on
 *  the live network, so the next price change fails CI instead of shipping.
 */
export const CAPABILITY_PRICE_USD: Record<string, { hit: number; miss: number }> = {
  "contract.guard": { hit: 0.01, miss: 0.03 },
  "token.metadata": { hit: 0.01, miss: 0.03 },
  "chain.snapshot": { hit: 0.01, miss: 0.02 },
  "prediction.evidence": { hit: 0.01, miss: 0.05 },
  "token.launch.guard": { hit: 0.02, miss: 0.07 },
  "token.holders.guard": { hit: 0.01, miss: 0.04 },
};

/** Overwrite the fallback table with the live catalog. Never throws. */
export async function refreshPricesFromCatalog(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/capabilities`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { capabilities?: Array<{ id?: string; pricing?: { cacheHitUsd?: number; fingerprintHitUsd?: number; cacheMissUsd?: number } }> };
    let updated = 0;
    for (const item of body.capabilities ?? []) {
      const pricing = item.pricing;
      if (!item.id || !pricing || typeof pricing.cacheMissUsd !== "number") continue;
      const tiers = [pricing.cacheHitUsd, pricing.fingerprintHitUsd, pricing.cacheMissUsd].filter((v): v is number => typeof v === "number" && v > 0);
      if (tiers.length === 0) continue;
      CAPABILITY_PRICE_USD[item.id] = { hit: Math.min(...tiers), miss: pricing.cacheMissUsd };
      updated += 1;
    }
    return updated > 0;
  } catch {
    return false;
  }
}

/** "$0.01-0.03" for a tiered read, "$0.05" for a flat one. */
export function priceLabel(capabilityId: string): string {
  const price = CAPABILITY_PRICE_USD[capabilityId];
  if (!price) return "price unknown";
  return price.hit === price.miss ? `$${price.hit}` : `$${price.hit}-${price.miss}`;
}

/** The most any single call can cost, used to check the configured cap is not
 *  set below what the agent is being told it can buy. */
export function dearestCapabilityUsd(): number {
  return Math.max(...Object.values(CAPABILITY_PRICE_USD).map((p) => p.miss));
}

// Rolling daily budget so a chatty agent cannot drain its wallet.
let budgetDay = "";
let spentTodayUsd = 0;
function underDailyBudget(nextPriceUsd: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    spentTodayUsd = 0;
  }
  const cap = Number(env("TERENO_DAILY_BUDGET_USD", String(DEFAULT_DAILY_BUDGET_USD)));
  const limit = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DAILY_BUDGET_USD;
  return spentTodayUsd + nextPriceUsd <= limit;
}

// Fail mode (issue #4). closed (default) = a failed/uncertain check on a
// FINANCIAL action recommends abort; open = it degrades to review (never
// auto-"sign"). Non-financial reads always degrade to review.
function failClosed(): boolean {
  return env("TERENO_FAIL_MODE", "closed").toLowerCase() !== "open";
}

// Dry-run (issue #5): wire the flow for free, no x402 payment.
function dryRunEnabled(): boolean {
  return env("TERENO_DRY_RUN").toLowerCase() === "true";
}

/** Free public evidence references intentionally do not require an x402 wallet.
 * The optional installation id is opaque, persisted by the operator and hashed
 * server-side solely for the circulation experiment. */
async function readEvidenceReference(artifactId: string) {
  const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz").replace(/\/+$/, "");
  const headers: Record<string, string> = { accept: "application/json" };
  const installationId = env("TERENO_EVIDENCE_INSTALLATION_ID");
  if (installationId) headers["x-tereno-evidence-installation"] = installationId;
  const response = await fetch(`${baseUrl}/api/v1/evidence/${encodeURIComponent(artifactId)}?channel=plugin-tereno`, {
    headers, signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Evidence reference failed (${response.status})`);
  return body;
}

/** A synthetic verdict for dry-run / fail-mode paths (no on-chain settlement). */
function syntheticVerdict(fields: {
  decision: Decision;
  riskLevel: RiskLevel;
  reason: string;
  recommendedAction: RecommendedAction;
}): TerenoVerdict {
  return {
    ...fields,
    exposure: { unlimitedApproval: false },
    cost: { paidUsd: 0, capUsd: maxPriceUsd(), dailySpentUsd: spentTodayUsd },
    receiptUrl: null,
    raw: {},
  };
}

/** What to return when a check cannot be settled (error/timeout/budget). */
export function failVerdict(reason: string, financial: boolean): TerenoVerdict {
  const abort = financial && failClosed();
  return syntheticVerdict({
    decision: abort ? "block" : "review",
    riskLevel: abort ? "high" : "medium",
    reason: `${reason} (fail-${failClosed() ? "closed" : "open"})`,
    recommendedAction: abort ? "abort" : "review",
  });
}

// ————— Anonymous telemetry (issues #9/#10) —————
// Opt-out (TERENO_TELEMETRY=off). STRICT allowlist below — this is the ONLY
// data ever transmitted. Never the private key, prompt, secrets or tx content.
export const PLUGIN_VERSION = "0.8.1";

function telemetryEnabled(): boolean {
  return env("TERENO_TELEMETRY").toLowerCase() !== "off";
}

/** sha256(address) truncated — anonymized wallet, never the address in clear. */
function walletHash(): string | null {
  const wallet = agentWallet();
  return wallet
    ? createHash("sha256").update(wallet).digest("hex").slice(0, 32)
    : null;
}

/** Best-effort cross-wallet cache-hit signal from the raw response. */
function readCacheHit(data: VerdictResult): boolean {
  const raw = data as unknown as Record<string, unknown>;
  const status = (data.result as Record<string, unknown> | undefined)?.[
    "cacheStatus"
  ];
  return status === "hit" || raw["cached"] === true;
}

let paidCallCount = 0;

export interface TelemetryEvent {
  event: "init" | "check";
  checkType?: string;
  completed?: boolean;
  paid?: boolean;
  costUsd?: number;
  cacheHit?: boolean;
  repeat?: boolean;
  error?: string | null;
}

/** The EXACT set of fields ever transmitted. Anything not here is a leak. */
export const TELEMETRY_KEYS = [
  "pluginVersion", "walletHash", "network", "event", "checkType",
  "completed", "paid", "costUsd", "cacheHit", "repeat", "error",
] as const;

/** Pure allowlisted payload builder (issue #10). Testable; no PII/keys/prompts. */
export function telemetryPayload(
  e: TelemetryEvent,
  walletHashValue: string | null,
  network: string,
): Record<string, unknown> {
  return {
    pluginVersion: PLUGIN_VERSION,
    walletHash: walletHashValue,
    network,
    event: e.event,
    checkType: e.checkType ?? null,
    completed: e.completed ?? null,
    paid: e.paid ?? null,
    costUsd: e.costUsd ?? null,
    cacheHit: e.cacheHit ?? null,
    repeat: e.repeat ?? null,
    error: e.error ?? null,
  };
}

/** Fire-and-forget anonymized beacon. Never blocks or throws into the loop. */
function sendTelemetry(e: TelemetryEvent): void {
  if (!telemetryEnabled()) return;
  const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz");
  const url = env("TERENO_TELEMETRY_URL", `${baseUrl}/api/v1/telemetry`);
  const payload = telemetryPayload(
    e,
    walletHash(),
    env("TERENO_NETWORK", "eip155:8453"),
  );
  void fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tereno-client": `plugin-tereno@${PLUGIN_VERSION}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000),
  }).catch(() => {
    /* telemetry must never affect the agent */
  });
}

type TerenoAccount = NonNullable<Parameters<typeof createTerenoClient>[0]["account"]>;

function client() {
  const key = privateKey();
  if (!key) throw new Error("TERENO_PRIVATE_KEY (or EVM_PRIVATE_KEY) is not configured");
  return createTerenoClient({
    baseUrl: env("TERENO_API_URL", "https://www.tereno.xyz"),
    // Cast bridges duplicate viem type instances (plugin vs linked client);
    // the runtime shape is identical.
    account: privateKeyToAccount(key) as unknown as TerenoAccount,
    network: env("TERENO_NETWORK", "eip155:8453") === "eip155:84532" ? "eip155:84532" : "eip155:8453",
    rpcUrl: env("TERENO_RPC_URL", "https://mainnet.base.org"),
    maxPriceUsd: maxPriceUsd(),
  });
}

const paidCalls = new PaidCalls(underDailyBudget, (result, reservation) => {
  underDailyBudget(0); // Refresh the UTC budget day before accounting.
  const value = (result.data as VerdictResult)?.pricing?.pricePaidUsd;
  spentTodayUsd += typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : reservation;
});

let pendingSeed: { input: PluginCapabilityInput; key: string } | null = null;

function paidFingerprint(input: PluginCapabilityInput) {
  const key = privateKey();
  if (!key) throw new Error("TERENO_PRIVATE_KEY (or EVM_PRIVATE_KEY) is not configured");
  const fingerprint = createHash("sha256").update(JSON.stringify({
    wallet: privateKeyToAccount(key).address,
    url: env("TERENO_API_URL", "https://www.tereno.xyz").replace(/\/+$/, ""),
    network: env("TERENO_NETWORK", "eip155:8453"),
    input: Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
  })).digest("hex");
  return fingerprint;
}

async function invokePaid(input: PluginCapabilityInput, reservation: number) {
  const fingerprint = paidFingerprint(input);
  try {
    const result = await paidCalls.invoke(fingerprint, reservation, () => client().invokeCapability<VerdictResult>(input as CapabilityInput));
    if (pendingSeed?.key === fingerprint) pendingSeed = null;
    return result;
  } catch (error) {
    if (!(error instanceof TerenoPaymentPendingError) && pendingSeed?.key === fingerprint) pendingSeed = null;
    throw error;
  }
}

function firstAddress(message: Memory): string | null {
  return (message.content.text || "").match(ADDRESS_RE)?.[0] ?? null;
}

function firstPublicUrl(message: Memory): string | null {
  return (message.content.text || "").match(PUBLIC_URL_RE)?.[0] ?? null;
}

function predictionEvidenceInput(message: Memory): {
  capabilityId: "prediction.evidence";
  question: string;
  market?: string;
  marketUrl?: string;
} | null {
  const raw = (message.content.text || "").trim();
  if (!raw) return null;
  const jsonMatch = raw.match(/\{[\s\S]*\}/)?.[0];
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch) as {
        question?: unknown;
        market?: unknown;
        marketUrl?: unknown;
      };
      if (typeof parsed.question === "string" && parsed.question.trim().length >= 5) {
        return {
          capabilityId: "prediction.evidence",
          question: parsed.question.trim().slice(0, 2000),
          ...(typeof parsed.market === "string" && parsed.market.trim()
            ? { market: parsed.market.trim().toLowerCase() }
            : {}),
          ...(typeof parsed.marketUrl === "string" && parsed.marketUrl.trim()
            ? { marketUrl: parsed.marketUrl.trim() }
            : {}),
        };
      }
    } catch {
      // Fall through to plain-text parsing.
    }
  }
  const url = firstPublicUrl(message);
  const question = (url ? raw.replace(url, "") : raw).trim();
  if (question.length < 5) return null;
  return {
    capabilityId: "prediction.evidence",
    question: question.slice(0, 2000),
    ...(url ? { marketUrl: url } : {}),
  };
}

function requestedCapability(message: Memory): string | null {
  return (message.content.text || "").match(CAPABILITY_RE)?.[1]?.toLowerCase() ?? null;
}

// With TERENO_PRIVATE_ONLY=true, paid actions refuse public platform sources
// so strangers in a public channel cannot spend the agent's USDC.
function sourceAllowed(message: Memory): boolean {
  if (env("TERENO_PRIVATE_ONLY") !== "true") return true;
  const source = message.content.source;
  return source !== "discord" && source !== "telegram" && source !== "twitter";
}

interface Risk {
  code?: string;
  severity?: "low" | "medium" | "high" | string;
  title?: string;
}

interface VerdictResult {
  verdict?: string;
  invocationId?: string;
  result?: {
    summary?: string;
    reasonCodes?: string[];
    agentNote?: string;
    validUntilBlock?: number;
    risks?: Risk[];
    balanceDeltas?: unknown;
    allowanceChanges?: unknown;
  };
  pricing?: { pricePaidUsd?: number };
  receiptUrl?: string;
}

// ————— Standardized verdict (issue #3) —————
// Every guard action returns this stable shape so integrators branch on one
// contract. `raw` preserves the full Tereno CapabilityResult unchanged.
export type Decision = "allow" | "review" | "block";
export type RiskLevel = "none" | "low" | "medium" | "high";
export type RecommendedAction = "sign" | "review" | "abort";

export interface TerenoVerdict {
  decision: Decision;
  riskLevel: RiskLevel;
  reason: string;
  exposure: {
    balanceDeltas?: unknown;
    allowanceChanges?: unknown;
    unlimitedApproval: boolean;
  };
  cost: { paidUsd: number; capUsd: number; dailySpentUsd: number; paymentStatus?: "pending" };
  recommendedAction: RecommendedAction;
  receiptUrl: string | null;
  raw: VerdictResult;
}

const UNLIMITED_APPROVAL_CODES = /unlimited|max_?approval|infinite/i;
const DRAINER_CODES = /drainer|sweep|malicious|scam/i;

function toDecision(verdict: string | undefined): Decision {
  return verdict === "allow" || verdict === "block" ? verdict : "review";
}

function toRiskLevel(data: VerdictResult, decision: Decision): RiskLevel {
  const risks = data.result?.risks ?? [];
  const severities = risks.map((r) => (r.severity || "").toLowerCase());
  if (severities.includes("high")) return "high";
  if (severities.includes("medium")) return "medium";
  const codes = (data.result?.reasonCodes ?? []).join(" ");
  if (DRAINER_CODES.test(codes)) return "high";
  if (UNLIMITED_APPROVAL_CODES.test(codes)) return "medium";
  if (severities.includes("low") || (data.result?.reasonCodes?.length ?? 0) > 0) {
    return "low";
  }
  // No explicit risks: infer a floor from the decision.
  return decision === "block" ? "high" : decision === "review" ? "low" : "none";
}

function toRecommendedAction(decision: Decision): RecommendedAction {
  return decision === "allow" ? "sign" : decision === "block" ? "abort" : "review";
}

/** Map a raw Tereno CapabilityResult into the stable TerenoVerdict shape. */
export function normalizeVerdict(
  data: VerdictResult,
  cost: { capUsd: number; dailySpentUsd: number },
  baseUrl: string,
): TerenoVerdict {
  const decision = toDecision(data.verdict);
  const codes = (data.result?.reasonCodes ?? []).join(" ");
  const reason = [data.result?.summary, data.result?.reasonCodes?.join(", ")]
    .filter(Boolean)
    .join(" — ") || "no reason provided";
  return {
    decision,
    riskLevel: toRiskLevel(data, decision),
    reason,
    exposure: {
      balanceDeltas: data.result?.balanceDeltas,
      allowanceChanges: data.result?.allowanceChanges,
      unlimitedApproval: UNLIMITED_APPROVAL_CODES.test(codes),
    },
    cost: {
      paidUsd: data.pricing?.pricePaidUsd ?? 0,
      capUsd: cost.capUsd,
      dailySpentUsd: cost.dailySpentUsd,
    },
    recommendedAction: toRecommendedAction(decision),
    receiptUrl: data.receiptUrl ? `${baseUrl}${data.receiptUrl}` : null,
    raw: data,
  };
}

function formatVerdict(v: TerenoVerdict): string {
  const icon = v.decision === "allow" ? "✅" : v.decision === "review" ? "⚠️" : "⛔";
  const lines = [
    `${icon} Tereno: ${v.decision.toUpperCase()} · risk ${v.riskLevel} · → ${v.recommendedAction}`,
    v.reason,
    v.exposure.unlimitedApproval ? "⚠️ unlimited approval detected" : null,
    `Payment: ${v.cost.paymentStatus === "pending" ? "pending confirmation; budget remains reserved" : `$${v.cost.paidUsd} USDC (x402)`} · cap $${v.cost.capUsd}/call · $${v.cost.dailySpentUsd.toFixed(3)} today`,
    v.receiptUrl ? `Receipt: ${v.receiptUrl}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Paid actions whose description quotes a price, rebuilt after the live catalog loads. */
const PRICED_ACTIONS: Array<{ action: Action; describe: () => string }> = [];

export function rebuildPricedDescriptions(): void {
  for (const entry of PRICED_ACTIONS) entry.action.description = entry.describe();
}

function paidAction(config: {
  name: string;
  similes: string[];
  describe: () => string;
  buildInput: (message: Memory) => PluginCapabilityInput | null;
  missingInputText: string;
  /** true for actions that gate a signature/spend (fail-closed by default). */
  financial?: boolean;
}): Action {
  const action: Action = {
    name: config.name,
    similes: config.similes,
    description: config.describe(),
    validate: async (_runtime: IAgentRuntime, message: Memory) =>
      dryRunEnabled() || (privateKey() !== null && sourceAllowed(message)),
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined,
      _options: unknown,
      callback: HandlerCallback | undefined,
    ): Promise<ActionResult> => {
      const respond = async (text: string, success: boolean, data?: unknown): Promise<ActionResult> => {
        await callback?.({ text, actions: [config.name], source: message.content.source });
        return { success, text, data: data as Record<string, unknown> | undefined };
      };
      const input = config.buildInput(message);
      if (!input) return respond(config.missingInputText, false);
      const perCall = maxPriceUsd();
      const financial = config.financial === true;

      // Dry-run (#5): validate + shape the flow without paying.
      if (dryRunEnabled()) {
        const v = syntheticVerdict({
          decision: "review",
          riskLevel: "low",
          reason: `dry-run: input accepted for ${input.capabilityId}; no x402 payment made. Set TERENO_DRY_RUN=false to buy the real verdict.`,
          recommendedAction: "review",
        });
        return respond(`🧪 ${formatVerdict(v)}`, true, v);
      }

      try {
        const { result: { data }, newlyAccounted } = await invokePaid(input, perCall);
        const paid = data.pricing?.pricePaidUsd ?? perCall;
        const repeat = paidCallCount > 0;
        if (newlyAccounted) paidCallCount += 1;
        sendTelemetry({
          event: "check",
          checkType: input.capabilityId,
          completed: true,
          paid: newlyAccounted,
          costUsd: newlyAccounted ? paid : 0,
          cacheHit: readCacheHit(data),
          repeat,
          error: null,
        });
        const verdict = normalizeVerdict(
          data,
          { capUsd: perCall, dailySpentUsd: spentTodayUsd },
          env("TERENO_API_URL", "https://www.tereno.xyz"),
        );
        return respond(formatVerdict(verdict), true, verdict);
      } catch (error) {
        logger.warn({ error, action: config.name }, "Tereno capability call failed");
        const reason = error instanceof Error ? error.message : String(error);
        sendTelemetry({
          event: "check",
          checkType: input.capabilityId,
          completed: false,
          paid: false,
          error: error instanceof TerenoPaymentPendingError ? "payment_pending" : error instanceof TerenoBudgetError ? "budget_exhausted" : "integration_error",
        });
        const pending = error instanceof TerenoPaymentPendingError;
        const v = failVerdict(pending
          ? "Payment outcome pending. Retry the SAME action and input to resume the original authorization; do not create another payment or restart the process while unresolved."
          : `guard unavailable: ${reason}`, financial);
        if (pending) v.cost.paymentStatus = "pending";
        return respond(formatVerdict(v), false, v);
      }
    },
    examples: [],
  };
  PRICED_ACTIONS.push({ action, describe: config.describe });
  return action;
}

const checkContract = paidAction({
  name: "TERENO_CHECK_CONTRACT",
  similes: ["IS_CONTRACT_SAFE", "CONTRACT_GUARD", "CHECK_ADDRESS_SAFETY"],
  describe: () =>
    `Before interacting with a Base contract, buy a bounded allow/review/block verdict (code present, EIP-1967 proxy implementation/admin, paused state) via Tereno contract.guard (${priceLabel("contract.guard")} USDC over x402 — first settled payer or free audited publisher becomes the seeder and earns 20% of later cross-wallet reuses, up to the cold price in credit). Use when the user asks whether a Base contract or token address is safe to interact with.`,
  buildInput: (message) => {
    const address = firstAddress(message);
    return address ? { capabilityId: "contract.guard", address } : null;
  },
  missingInputText: "I need a Base contract address (0x…) to run the Tereno contract check.",
  financial: true,
});

const tokenInfo = paidAction({
  name: "TERENO_TOKEN_INFO",
  similes: ["TOKEN_METADATA", "WHAT_TOKEN_IS_THIS", "TOKEN_LOOKUP"],
  describe: () =>
    `Read a Base token's on-chain identity — name, symbol, decimals, total supply — via Tereno token.metadata (${priceLabel("token.metadata")} USDC over x402 — you pay less when another agent already computed it, and the first settled payer earns $0.002-0.004 per cross-wallet reuse, up to the cold price in credit). Use when the user asks what a token address is.`,
  buildInput: (message) => {
    const address = firstAddress(message);
    return address ? { capabilityId: "token.metadata", address } : null;
  },
  missingInputText: "I need a Base token address (0x…) to look up its metadata.",
});

const chainSnapshot = paidAction({
  name: "TERENO_CHAIN_SNAPSHOT",
  similes: ["BASE_GAS_PRICE", "LATEST_BASE_BLOCK", "BASE_CHAIN_STATE"],
  describe: () =>
    `Get the current Base chain state — latest block, timestamp, base fee and suggested gas fees — via Tereno chain.snapshot (${priceLabel("chain.snapshot")} USDC over x402 — you pay less when another agent already computed it, and the first settled payer earns $0.002 per cross-wallet reuse, up to the cold price in credit). No parameters needed.`,
  buildInput: () => ({ capabilityId: "chain.snapshot" }),
  missingInputText: "",
});

const predictionEvidence = paidAction({
  name: "TERENO_PREDICTION_EVIDENCE",
  similes: ["PREDICTION_MARKET_EVIDENCE", "POLYMARKET_EVIDENCE", "VERIFY_PREDICTION_QUESTION"],
  describe: () =>
    `Gather structured, reproducible on-chain and Polymarket evidence for a prediction market question via Tereno prediction.evidence (${priceLabel("prediction.evidence")} USDC over x402 — you pay $0.01 on a cache hit, and the first settled payer earns $0.002-0.004 per cross-wallet reuse, up to the cold price in credit). Pass a prediction question (and optional Polymarket URL or JSON with question/market/marketUrl).`,
  buildInput: (message) => predictionEvidenceInput(message),
  missingInputText:
    "I need a prediction market question (at least 5 characters, optionally with a Polymarket URL) to gather evidence.",
});

const tokenLaunchGuard = paidAction({
  name: "TERENO_TOKEN_LAUNCH_GUARD",
  similes: [
    "CHECK_HONEYPOT",
    "CAN_I_SELL",
    "TOKEN_LAUNCH_GUARD",
    "VERIFY_LP_LOCK",
    "EXIT_SIMULATION",
    "SIMULATE_TOKEN_EXIT",
  ],
  describe: () =>
    `Can I get out after I get in? Before buying or swapping a Base token, simulate a real sell/exit via eth_call, verify DEX LP reserve depth, check burn/lock status, and inspect owner powers (blacklist, mint, fee traps) via Tereno token.launch.guard (${priceLabel("token.launch.guard")} USDC over x402). Critical financial safety check before swaps or buying new Base tokens.`,
  buildInput: (message) => {
    const address = firstAddress(message);
    return address ? { capabilityId: "token.launch.guard", address } : null;
  },
  missingInputText: "I need a Base token address (0x…) to run the token launch and exit simulation guard.",
  financial: true,
});

const tokenHoldersGuard = paidAction({
  name: "TERENO_TOKEN_HOLDERS_GUARD",
  similes: [
    "CHECK_TOKEN_HOLDERS",
    "TOKEN_HOLDERS_GUARD",
    "DETECT_CABAL",
    "CHECK_SYBIL_CLUSTERS",
    "HOLDER_CONCENTRATION",
    "INSIDER_DUMP_RISK",
  ],
  describe: () =>
    `Who controls this token? Inspect Base token holder concentration (top 10 holders excluding DEX/burn) and trace ETH funding origins to uncover deployer-funded cabal Sybil clusters via Tereno token.holders.guard (${priceLabel("token.holders.guard")} USDC over x402). Financial action.`,
  buildInput: (message) => {
    const address = firstAddress(message);
    return address ? { capabilityId: "token.holders.guard", address } : null;
  },
  missingInputText: "I need a Base token address (0x…) to inspect holder concentration and cabal clusters.",
  financial: true,
});

interface AcpEvaluationResponse {
  jobId: string;
  verdict: "allow" | "review" | "block";
  score: number;
  escrowReleaseEligible: boolean;
  summary: string;
  reasonCodes: string[];
  erc8004ValidationUrl?: string;
  signedProof?: {
    signature: string;
    hash: string;
    signer: string;
  };
}

async function evaluateAcpEscrow(params: {
  jobId: string;
  targetAddress: string;
  taskType: "contract_safety" | "token_launch_safety" | "token_holders_concentration";
  clientAddress?: string;
  providerAddress?: string;
}): Promise<AcpEvaluationResponse> {
  const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/acp/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof (data as Record<string, unknown>).error === "string"
        ? ((data as Record<string, unknown>).error as string)
        : `ACP evaluation failed (${response.status})`
    );
  }
  return data as AcpEvaluationResponse;
}

const acpEvaluateAction: Action = {
  name: "TERENO_ACP_EVALUATE",
  similes: [
    "EVALUATE_TASK_ESCROW",
    "CHECK_ACP_ESCROW",
    "ACP_EVALUATE",
    "VERIFY_TASK_RELEASE",
    "AUDIT_AGENT_ESCROW",
  ],
  description:
    "Evaluate an ERC-8183 Agent Escrow (ACP) task delivery via Tereno. Verifies target address safety (contract_safety, token_launch_safety, or token_holders_concentration) and returns an EIP-712 SignedVerdictProof, score (0-100), escrowReleaseEligible flag, and ERC-8004 validation link for on-chain escrow release or dispute.",
  validate: async () => true,
  handler: async (_runtime, message, _state, _options, callback): Promise<ActionResult> => {
    const respond = async (text: string, success: boolean, data?: unknown): Promise<ActionResult> => {
      await callback?.({ text, actions: ["TERENO_ACP_EVALUATE"], source: message.content.source });
      return { success, text, data: data as Record<string, unknown> | undefined };
    };

    const text = message.content.text || "";
    const address = firstAddress(message);
    if (!address) {
      return respond("I need a target Base contract or token address (0x…) to evaluate the ACP escrow task.", false);
    }

    const jobMatch = text.match(/\b(job-[a-zA-Z0-9_-]+|task-[a-zA-Z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    const jobId = jobMatch ? jobMatch[1] : `task-${Date.now().toString(36)}`;

    let taskType: "contract_safety" | "token_launch_safety" | "token_holders_concentration" = "token_launch_safety";
    if (/holder|cabal|cluster|concentration/i.test(text)) {
      taskType = "token_holders_concentration";
    } else if (/contract|bytecode|proxy/i.test(text)) {
      taskType = "contract_safety";
    }

    try {
      const evaluation = await evaluateAcpEscrow({
        jobId,
        targetAddress: address,
        taskType,
      });

      const icon = evaluation.escrowReleaseEligible ? "✅" : "⛔";
      const status = evaluation.escrowReleaseEligible ? "RELEASE ELIGIBLE" : "DISPUTE RECOMMENDED";
      const lines = [
        `${icon} ERC-8183 ACP Task Evaluation: ${status} (Score: ${evaluation.score}/100)`,
        `Job ID: ${evaluation.jobId} · Task: ${taskType}`,
        `Verdict: ${evaluation.verdict.toUpperCase()} · ${evaluation.summary}`,
        evaluation.reasonCodes.length > 0 ? `Reason Codes: ${evaluation.reasonCodes.join(", ")}` : null,
        evaluation.signedProof ? `Signed EIP-712 Proof: ${evaluation.signedProof.hash}` : null,
        evaluation.erc8004ValidationUrl ? `ERC-8004 Validation: ${evaluation.erc8004ValidationUrl}` : null,
      ].filter(Boolean).join("\n");

      return respond(lines, true, evaluation);
    } catch (error) {
      return respond(`ACP evaluation error: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  },
  examples: [],
};

const evidenceArtifactAction: Action = {
  name: "TERENO_VERIFY_EVIDENCE",
  similes: ["VERIFY_TERENO_ARTIFACT", "CHECK_EVIDENCE_PROVENANCE", "RECOMPUTE_EVIDENCE"],
  description: "Read a public Tereno evidence reference by sha256 artifactId. Free: returns provenance, validity and exact recomputation input without exposing paid output or payer identity. Private transaction intent is rejected.",
  validate: async () => true,
  handler: async (_runtime, message, _state, _options, callback): Promise<ActionResult> => {
    const artifactId = (message.content.text || "").match(ARTIFACT_ID_RE)?.[0] ?? null;
    const respond = async (text: string, success: boolean, data?: unknown): Promise<ActionResult> => {
      await callback?.({ text, actions: ["TERENO_VERIFY_EVIDENCE"], source: message.content.source });
      return { success, text, data: data as Record<string, unknown> | undefined };
    };
    if (!artifactId) return respond("I need a Tereno artifact id in the form sha256:<64 hex characters>.", false);
    try {
      const data = await readEvidenceReference(artifactId) as {
        provenance?: { validUntil?: string }; verification?: { href?: string }; observation?: { recorded?: boolean };
      };
      return respond([
        "Evidence reference resolved. Free — no x402 payment.",
        data.provenance?.validUntil ? "Valid until: " + data.provenance.validUntil : null,
        data.verification?.href ? "Verify: " + data.verification.href : null,
        data.observation?.recorded ? "Cross-agent reference observation recorded." : null,
      ].filter(Boolean).join("\n"), true, data);
    } catch (error) {
      return respond("Could not verify that evidence: " + (error instanceof Error ? error.message : String(error)), false);
    }
  },
  examples: [],
};

const opportunitiesAction: Action = {
  name: "TERENO_OPPORTUNITIES",
  similes: ["TERENO_MARKET_DEMAND", "WHAT_AGENTS_NEED", "LIST_AGENT_OPPORTUNITIES"],
  description: "List aggregate unknown asks and conditional pledges observed by Tereno. This is research evidence, not traction or a guaranteed reward. Free and wallet-free.",
  validate: async () => true,
  handler: async (_runtime, message, _state, _options, callback): Promise<ActionResult> => {
    try {
      const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz");
      const response = await fetch(baseUrl + "/api/v1/opportunities?limit=20", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      const data = await response.json() as { opportunities?: Array<{ requestedCapability: string; unknownCapabilityRequests: number; unknownMcpToolCalls: number; pledgeWallets: number; fulfilledPledges: number; signal: string }> };
      if (!response.ok) throw new Error("Tereno opportunities unavailable");
      const rows = data.opportunities ?? [];
      const text = rows.length ? "Tereno opportunity signals (not PMF proof):\n" + rows.map((item) => "- " + item.requestedCapability + ": " + (item.unknownCapabilityRequests + item.unknownMcpToolCalls) + " observed ask(s), " + item.pledgeWallets + " pledge wallet(s), " + item.fulfilledPledges + " paid proof (" + item.signal + ")").join("\n") : "No aggregate opportunity signals yet.";
      await callback?.({ text, actions: ["TERENO_OPPORTUNITIES"], source: message.content.source });
      return { success: true, text, data };
    } catch (error) {
      const text = "Could not read Tereno opportunities: " + (error instanceof Error ? error.message : String(error));
      await callback?.({ text, actions: ["TERENO_OPPORTUNITIES"], source: message.content.source });
      return { success: false, text };
    }
  },
  examples: [],
};

/** The capability names Tereno says it would build, read from the free
 *  catalog. Empty on any failure: a pledge must never be blocked because the
 *  suggestion list was unavailable. */
async function proposedCapabilityNames(): Promise<string[]> {
  try {
    const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz");
    const response = await fetch(`${baseUrl}/api/v1/capabilities`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body = await response.json() as { proposed?: { proposals?: { pledgeAs?: string }[] } };
    return (body.proposed?.proposals ?? [])
      .map((item) => item.pledgeAs)
      .filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

const pledgeDemandAction: Action = {
  name: "TERENO_PLEDGE_DEMAND",
  similes: ["PLEDGE_TERENO_DEMAND", "I_WOULD_BUY_CAPABILITY", "DECLARE_CAPABILITY_DEMAND"],
  description: "Explicitly declare that this agent would pay for a named future capability, for example wallet-scam-classification. Free. It earns no credit now; only a later paid settlement by this same wallet can release a bounded non-transferable credit.",
  validate: async (_runtime, message) => privateKey() !== null && sourceAllowed(message),
  handler: async (_runtime, message, _state, _options, callback): Promise<ActionResult> => {
    const capability = requestedCapability(message);
    const respond = async (text: string, success: boolean, data?: unknown): Promise<ActionResult> => {
      await callback?.({ text, actions: ["TERENO_PLEDGE_DEMAND"], source: message.content.source });
      return { success, text, data: data as Record<string, unknown> | undefined };
    };
    if (!capability) {
      const names = await proposedCapabilityNames();
      return respond(
        names.length
          ? `Name the capability explicitly. Tereno currently proposes: ${names.join(", ")}. Any other name is accepted but only earns a credit if Tereno ships that exact capability.`
          : "Name the capability explicitly, for example: pledge demand for solana.program.change.",
        false,
      );
    }
    try {
      const pledge = await client().pledgeDemand(capability);
      return respond("Pledged demand for " + pledge.capability + ". No credit was issued now; a bounded non-transferable credit is released only if this same wallet later settles that exact capability.", true, pledge);
    } catch (error) {
      return respond("Could not record the demand pledge: " + (error instanceof Error ? error.message : String(error)), false);
    }
  },
  examples: [],
};

// ————— Cooperative loop: the agent earns its own safety budget —————
// First settled payer (or audited publisher) of fresh work becomes its seeder
// and earns 20% of every settled cross-wallet reuse as non-transferable
// credits, which discount the guard capabilities. Bounties are the network's
// public statement of what it will pay for next.

interface Bounty {
  capabilityId: string;
  input: {
    address?: string;
    question?: string;
    market?: string;
    marketUrl?: string;
  };
  misses: number;
  fulfillment: "publish" | "first_settled_invocation";
  seederEconomics: { dividendPerSettledReuseUsd: number; lifetimeCapUsd: number };
}

function agentWallet(): string | null {
  const key = privateKey();
  return key ? privateKeyToAccount(key).address.toLowerCase() : null;
}

function basePublicClient() {
  const sepolia = env("TERENO_NETWORK", "eip155:8453") === "eip155:84532";
  return createPublicClient({
    chain: sepolia ? baseSepolia : base,
    transport: http(env("TERENO_RPC_URL", sepolia ? "https://sepolia.base.org" : "https://mainnet.base.org")),
  });
}

async function fetchBounties(): Promise<Bounty[]> {
  const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz");
  const response = await fetch(`${baseUrl}/api/v1/bounties?limit=20`, {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { bounties?: Bounty[] };
  return body.bounties ?? [];
}

function formatBounty(bounty: Bounty): string {
  const target = bounty.input.address
    ? ` for ${bounty.input.address}`
    : bounty.input.question
      ? ` for "${bounty.input.question}"`
      : "";
  const path = bounty.fulfillment === "publish"
    ? "publish a signed fingerprint (free RPC work)"
    : "be the first settled payer";
  return `- ${bounty.capabilityId}${target} · ${bounty.misses} miss(es) · earns $${bounty.seederEconomics.dividendPerSettledReuseUsd}/reuse (cap $${bounty.seederEconomics.lifetimeCapUsd}) · how: ${path}`;
}

/** Publish-path seeding: compute the contract fingerprint locally (free RPC
 *  reads), publish it EIP-712-signed, and let Tereno audit it by
 *  recomputation. On success the agent claims the seeder slot without paying. */
async function seedByPublishing(address: string): Promise<string> {
  const rpc = basePublicClient();
  const [blockNumber, bytecode] = await Promise.all([
    rpc.getBlockNumber(),
    rpc.getBytecode({ address: address as `0x${string}` }),
  ]);
  const hasCode = Boolean(bytecode && bytecode !== "0x");
  const result = await client().publishContractFingerprint<{
    status?: string; artifactId?: string; note?: string; audited?: boolean;
  }>({
    address,
    bytecodeHash: hasCode ? keccak256(bytecode as Hex) : null,
    bytecodeBytes: hasCode ? (bytecode!.length - 2) / 2 : 0,
    computedAtBlock: Number(blockNumber),
  });
  if (result.status === "published") {
    return `🌱 Seeded ${address}: fingerprint published and audited on-chain. I now earn the reuse dividend whenever another wallet's settled contract.guard call reuses it. Cost: only RPC reads.`;
  }
  return `Publishing ${address} returned "${result.status}"${result.note ? ` — ${result.note}` : ""}.`;
}

function bountyToCapabilityInput(bounty: Bounty): PluginCapabilityInput | null {
  if (bounty.capabilityId === "token.metadata" && bounty.input.address) {
    return { capabilityId: "token.metadata", address: bounty.input.address };
  }
  if (bounty.capabilityId === "chain.snapshot") {
    return { capabilityId: "chain.snapshot" };
  }
  if (bounty.capabilityId === "prediction.evidence" && bounty.input.question) {
    return {
      capabilityId: "prediction.evidence",
      question: bounty.input.question,
      ...(bounty.input.market ? { market: bounty.input.market } : {}),
      ...(bounty.input.marketUrl ? { marketUrl: bounty.input.marketUrl } : {}),
    };
  }
  return null;
}

interface GrifosQuest {
  questId: string;
  type: "contract_investigation" | "prediction_audit";
  difficulty: string;
  status: string;
  target: string;
  title: string;
  objective: string;
  requiredTools: string[];
  demandOriginCount: number;
}

async function fetchQuests(limit = 20): Promise<GrifosQuest[]> {
  const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/v1/quests?limit=${limit}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { quests?: GrifosQuest[] };
  return body.quests ?? [];
}

const questsAction: Action = {
  name: "TERENO_QUESTS",
  similes: ["GRIFOS_QUESTS", "INVESTIGATION_QUESTS", "LIST_QUESTS"],
  description:
    "List open Γρίφος investigation quests on the Tereno Investigation Network (contract_investigation and prediction_audit). Free. No USDC needed: your first verified quest earns $0.07 credit (enough for one full token.launch.guard check; first 20 wallets per UTC day, $0.005 past the cap), then $0.005 per quest, XP, 5 free Context Graph reads and 20% of every reuse of your work. Credit pays for checks with zero USDC; it is not yield.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const quests = await fetchQuests();
    const text = quests.length
      ? `Open Γρίφος investigation quests:\n${quests.map((q) => `- ${q.questId} [${q.type} · ${q.difficulty}] ${q.title} · target: ${q.target} · tools: ${q.requiredTools.join(", ")}`).join("\n")}`
      : "No qualified Γρίφος investigation quests are open right now.";
    await callback?.({ text, actions: ["TERENO_QUESTS"], source: message.content.source });
    return { success: true, text, data: { quests } };
  },
  examples: [],
};

const bountiesAction: Action = {
  name: "TERENO_BOUNTIES",
  similes: ["WHAT_DOES_THE_NETWORK_WANT", "OPEN_BOUNTIES", "TERENO_DEMAND"],
  description:
    "List Tereno's open bounties: real unmet demand other agents quoted but nobody seeded yet, with the seeder economics for each. Free. Use when asked what the Tereno network is asking for or how the agent could earn credits.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const bounties = await fetchBounties();
    const text = bounties.length
      ? `Open Tereno bounties (network demand nobody has seeded):\n${bounties.map(formatBounty).join("\n")}\nSay "seed it" and I will fulfil the best one.`
      : "No open bounties right now — the network's current demand is fully seeded.";
    await callback?.({ text, actions: ["TERENO_BOUNTIES"], source: message.content.source });
    return { success: true, text, data: { bounties } };
  },
  examples: [],
};

const seedAction: Action = {
  name: "TERENO_SEED",
  similes: ["SEED_BOUNTY", "EARN_TERENO_CREDITS", "FULFIL_BOUNTY", "CONTRIBUTE_WORK"],
  description:
    `Fulfil a Tereno bounty and claim the seeder slot. For contract.guard bounties the agent computes the bytecode fingerprint itself (free RPC work) and publishes it signed — audited by recomputation. For token.metadata (${priceLabel("token.metadata")}), chain.snapshot (${priceLabel("chain.snapshot")}) or prediction.evidence (${priceLabel("prediction.evidence")}) bounties it pays the first settled invocation within budget. Seeders earn 20% of every settled cross-wallet reuse as credits that discount future calls. Use when asked to seed, contribute or earn credits; an explicit 0x address seeds that contract directly.`,
  validate: async (_runtime: IAgentRuntime, message: Memory) =>
    privateKey() !== null && sourceAllowed(message),
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const respond = async (text: string, success: boolean, data?: unknown): Promise<ActionResult> => {
      await callback?.({ text, actions: ["TERENO_SEED"], source: message.content.source });
      return { success, text, data: data as Record<string, unknown> | undefined };
    };
    try {
      // Resume before refreshing bounties: a lost acknowledgement may already
      // have fulfilled the original bounty, removing it from the open queue.
      if (pendingSeed) {
        const pending = pendingSeed;
        if (paidFingerprint(pending.input) !== pending.key) {
          return respond("A seeding payment is pending for the original wallet/network/API. Restore that configuration to reconcile it before starting another.", false);
        }
        const { result: { data } } = await invokePaid(pending.input, maxPriceUsd());
        return respond(`Recovered the original ${pending.input.capabilityId} seeding result. No new payment authorization was created. Receipt: ${data.receiptUrl ?? data.invocationId ?? "see result"}`, true, data);
      }
      // Explicit address wins: seed that contract via the free publish path.
      const explicit = firstAddress(message);
      if (explicit) return respond(await seedByPublishing(explicit), true);

      const bounties = await fetchBounties();
      const publishable = bounties.find((bounty) => bounty.fulfillment === "publish" && bounty.input.address);
      if (publishable) return respond(await seedByPublishing(publishable.input.address!), true);

      const payable = bounties.find(
        (bounty) =>
          bounty.fulfillment === "first_settled_invocation" &&
          bountyToCapabilityInput(bounty) !== null,
      );
      if (!payable) return respond("No fulfillable bounty is open right now.", false);

      const input = bountyToCapabilityInput(payable)!;
      const seedCostUsd = CAPABILITY_PRICE_USD[payable.capabilityId]?.miss ?? DEFAULT_MAX_PRICE_USD;
      pendingSeed = { input, key: paidFingerprint(input) };
      const { result: { data } } = await invokePaid(input, Math.max(seedCostUsd, maxPriceUsd()));
      const target = payable.input.address ?? payable.input.question ?? payable.capabilityId;
      return respond(
        `🌱 Paid $${data.pricing?.pricePaidUsd ?? seedCostUsd} to seed ${payable.capabilityId} (${target}). As first settled payer I claimed the seeder slot: every settled reuse by another wallet now pays me $${payable.seederEconomics.dividendPerSettledReuseUsd} in credits (cap $${payable.seederEconomics.lifetimeCapUsd}).`,
        true, data,
      );
    } catch (error) {
      logger.warn({ error }, "Tereno seeding failed");
      const reason = error instanceof Error ? error.message : String(error);
      return respond(error instanceof TerenoPaymentPendingError
        ? "Seeding payment pending. The original authorization and budget reservation are retained; retry the same bounty input, do not create another payment or restart while unresolved."
        : `Seeding did not complete: ${reason}`, false);
    }
  },
  examples: [],
};

const standingAction: Action = {
  name: "TERENO_STANDING",
  similes: ["MY_TERENO_REPUTATION", "CREDIT_BALANCE", "PUBLISHER_STANDING"],
  description:
    "Report the agent's own Tereno track record: audited publications, settled reuse dividends, review credits and standing. Free; computed by the network from audits and settled economics, never self-reported.",
  validate: async () => privateKey() !== null,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const wallet = agentWallet();
    const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz");
    try {
      const response = await fetch(`${baseUrl}/api/v1/publishers/${wallet}`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as {
        standing?: string; auditPassRatePct?: number | null;
        publications?: { total?: number; passed?: number; failed?: number };
        dividends?: { settledReuses?: number; earnedUsd?: number };
        outcomeReviewCreditsEarnedUsd?: number; creditsSpentUsd?: number;
      };
      const earned = (data.dividends?.earnedUsd ?? 0) + (data.outcomeReviewCreditsEarnedUsd ?? 0);
      const text = [
        `Tereno standing: ${data.standing ?? "unknown"} (wallet ${wallet})`,
        `Publications: ${data.publications?.total ?? 0} (${data.publications?.passed ?? 0} audited-passed, ${data.publications?.failed ?? 0} failed)`,
        `Settled reuses of my work: ${data.dividends?.settledReuses ?? 0}`,
        `Credits earned: $${earned.toFixed(6)} · spent: $${(data.creditsSpentUsd ?? 0).toFixed(6)}`,
        "Credits discount my guard calls — my safety budget funds itself.",
      ].join("\n");
      await callback?.({ text, actions: ["TERENO_STANDING"], source: message.content.source });
      return { success: true, text, data };
    } catch {
      const text = "Could not read my Tereno publisher standing right now.";
      await callback?.({ text, actions: ["TERENO_STANDING"], source: message.content.source });
      return { success: false, text };
    }
  },
  examples: [],
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const reportOutcomeAction: Action = {
  name: "TERENO_REPORT_OUTCOME",
  similes: ["REPORT_VERDICT_OUTCOME", "TERENO_FEEDBACK"],
  description:
    "Attach a signed outcome (success, failure, avoided or unknown) to a settled Tereno invocation by its invocation id. The first honest outcome per invocation earns a small review credit and feeds publisher reputation. Only report what actually happened.",
  validate: async (_runtime: IAgentRuntime, message: Memory) =>
    privateKey() !== null && sourceAllowed(message),
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const respond = async (text: string, success: boolean): Promise<ActionResult> => {
      await callback?.({ text, actions: ["TERENO_REPORT_OUTCOME"], source: message.content.source });
      return { success, text };
    };
    const text = message.content.text || "";
    const invocationId = text.match(UUID_RE)?.[0];
    const value = text.toLowerCase().match(/\b(success|failure|avoided|unknown)\b/)?.[1] as
      | "success" | "failure" | "avoided" | "unknown" | undefined;
    if (!invocationId || !value) {
      return respond("I need the invocation id (uuid) and the outcome: success, failure, avoided or unknown.", false);
    }
    try {
      const result = await client().outcome<{ reviewCreditUsd?: number }>(invocationId, value);
      const credit = result.reviewCreditUsd ? ` Earned a $${result.reviewCreditUsd} review credit.` : "";
      return respond(`Outcome "${value}" signed and recorded for ${invocationId}.${credit}`, true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return respond(`Could not record the outcome: ${reason}`, false);
    }
  },
  examples: [],
};

const catalogAction: Action = {
  name: "TERENO_CATALOG",
  similes: ["LIST_TERENO_CAPABILITIES", "TERENO_PRICES"],
  description: "List Tereno capabilities and prices (free, no payment).",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz");
    try {
      const response = await fetch(`${baseUrl}/api/v1/capabilities`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json();
      const text = JSON.stringify(body, null, 2).slice(0, 5000);
      await callback?.({ text, actions: ["TERENO_CATALOG"], source: message.content.source });
      return { success: true, text };
    } catch {
      const text = "Could not reach the Tereno catalog.";
      await callback?.({ text, actions: ["TERENO_CATALOG"], source: message.content.source });
      return { success: false, text };
    }
  },
  examples: [],
};

const previewAction: Action = {
  name: "TERENO_PREVIEW",
  similes: ["TERENO_HELP", "WHAT_CAN_TERENO_CHECK", "TERENO_COVERAGE", "TERENO_COST"],
  description:
    "Free: explain what the Tereno security checks and evidence tools cover, what each costs, how the seeder reuse dividend works, and the current safety config (per-call cap, daily budget, fail mode, dry-run). No payment, no wallet needed. Use to preview before spending.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const configured = privateKey() !== null;
    const text = [
      "🛡️ Tereno — Base contract safety, chain reads & prediction evidence for agents. Coverage:",
      `• TERENO_CHECK_CONTRACT (${priceLabel("contract.guard")}) — is this Base contract safe to touch? code, proxy, pause`,
      `• TERENO_TOKEN_INFO (${priceLabel("token.metadata")}) — ERC-20 identity (name, symbol, decimals, totalSupply)`,
      `• TERENO_CHAIN_SNAPSHOT (${priceLabel("chain.snapshot")}) — latest Base block, timestamp, base fee & gas priority fee`,
      `• TERENO_PREDICTION_EVIDENCE (${priceLabel("prediction.evidence")}) — structured on-chain + Polymarket evidence brief for a prediction market question`,
      `• TERENO_TOKEN_LAUNCH_GUARD (${priceLabel("token.launch.guard")}) — can I sell after I buy? exit simulation, LP depth & lock, owner powers`,
      `• TERENO_TOKEN_HOLDERS_GUARD (${priceLabel("token.holders.guard")}) — top-holder concentration and deployer-funded wallet clusters`,
      "• TERENO_VERIFY_EVIDENCE (free) — provenance and recomputation input for a public artifact",
      "• TERENO_BOUNTIES (free) / TERENO_SEED — seed open demand or publish signed contract fingerprints to earn 20% reuse dividends ($0.002-0.008/reuse)",
      "• TERENO_OPPORTUNITIES (free) / TERENO_PLEDGE_DEMAND (free, explicit) — observed demand, never PMF proof",
      "Every check returns: decision, riskLevel, reason, exposure, cost, recommendedAction.",
      `Config: per-call cap $${maxPriceUsd()} · daily budget $${env("TERENO_DAILY_BUDGET_USD", String(DEFAULT_DAILY_BUDGET_USD))} · fail-${failClosed() ? "closed" : "open"}${dryRunEnabled() ? " · DRY-RUN (no payment)" : ""}`,
      maxPriceUsd() < dearestCapabilityUsd()
        ? `⚠️ Per-call cap $${maxPriceUsd()} is below the dearest check ($${dearestCapabilityUsd()}). Calls above the cap are refused before payment and return "guard unavailable". Raise TERENO_MAX_PRICE_USD.`
        : null,
      configured ? "Wallet configured — paid checks are available." : "No wallet configured yet — set TERENO_PRIVATE_KEY (Base USDC) to run paid checks; TERENO_DRY_RUN=true works with no wallet.",
      "Exact prices come from each 402 challenge and GET /api/v1/capabilities.",
      ...newsLines(),
    ].filter(Boolean).join("\n");
    await callback?.({ text, actions: ["TERENO_PREVIEW"], source: message.content.source });
    return { success: true, text };
  },
  examples: [],
};

const rulesAction: Action = {
  name: "TERENO_RULES",
  similes: ["TERENO_COOPERATION_RULES", "HOW_TERENO_WORKS", "AGENT_GUIDE", "SEIZE_DIVIDENDS"],
  description:
    "Free: read Tereno's cooperative rules of engagement for AI agents: how cache sharing saves up to 80% on compute, how seeders earn 20% reuse dividends on open bounties, and how passing verifiable evidence artifacts saves funds. No payment, no wallet needed.",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz");
    try {
      const response = await fetch(`${baseUrl}/agent.md?source=plugin-tereno`, {
        headers: { accept: "text/markdown" }, signal: AbortSignal.timeout(10_000),
      });
      const rules = response.ok ? await response.text() : "Could not fetch /agent.md";
      const text = [rules, ...newsLines()].join("\n\n");
      await callback?.({ text, actions: ["TERENO_RULES"], source: message.content.source });
      return { success: true, text };
    } catch {
      const fallback = "Tereno Agent Rules (offline): reusing an answer another agent already paid for costs less than computing it, and the first settled payer earns 20% of every later cross-wallet reuse in non-transferable credit. Current prices: GET https://www.tereno.xyz/api/v1/capabilities. Full rules: https://www.tereno.xyz/api/v1/agent-rules.";
      await callback?.({ text: fallback, actions: ["TERENO_RULES"], source: message.content.source });
      return { success: true, text: fallback };
    }
  },
  examples: [],
};

// --- Startup: live prices, update notice and platform news -------------------
//
// One free request each to the Tereno API at init, bounded to a few seconds
// and never able to fail startup. Set TERENO_UPDATE_CHECK=false to skip the
// version check (prices are still refreshed).

export interface ClientNews { date: string; title: string; summary: string; url: string }
export interface UpdateStatus { latest: string | null; updateAvailable: boolean; message: string | null; news: ClientNews[] }

let updateStatus: UpdateStatus | null = null;

export function lastUpdateStatus(): UpdateStatus | null {
  return updateStatus;
}

export async function checkForUpdate(baseUrl: string, timeoutMs = 3000): Promise<UpdateStatus | null> {
  if (env("TERENO_UPDATE_CHECK", "true").toLowerCase() === "false") return null;
  try {
    const url = `${baseUrl}/api/v1/clients?client=plugin-tereno&version=${encodeURIComponent(PLUGIN_VERSION)}`;
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<UpdateStatus>;
    updateStatus = {
      latest: typeof body.latest === "string" ? body.latest : null,
      updateAvailable: body.updateAvailable === true,
      message: typeof body.message === "string" ? body.message : null,
      news: Array.isArray(body.news) ? body.news.slice(0, 5) : [],
    };
    return updateStatus;
  } catch {
    return null;
  }
}

function newsLines(): string[] {
  const status = updateStatus;
  if (!status) return [];
  const lines: string[] = [];
  if (status.updateAvailable && status.message) lines.push(`⬆️ ${status.message}`);
  if (status.news.length > 0) {
    lines.push("What's new on Tereno:");
    for (const item of status.news.slice(0, 3)) lines.push(`• ${item.title}: ${item.summary} (${item.url})`);
  }
  return lines;
}

async function startup(): Promise<void> {
  const baseUrl = env("TERENO_API_URL", "https://www.tereno.xyz");
  const [pricesLive, status] = await Promise.all([refreshPricesFromCatalog(baseUrl), checkForUpdate(baseUrl)]);
  if (pricesLive) rebuildPricedDescriptions();
  if (status?.updateAvailable && status.message) logger.warn(`[plugin-tereno] ${status.message}`);
  if (status && status.news.length > 0) {
    logger.info(`[plugin-tereno] What's new on Tereno: ${status.news.slice(0, 3).map((n) => n.title).join(" · ")}`);
  }
}

export const terenoPlugin: Plugin = {
  name: "plugin-tereno",
  // Anonymous init beacon (plugin_initializations). Never blocks startup.
  init: async () => {
    sendTelemetry({ event: "init" });
    // Bounded: a slow or unreachable API never delays the agent's startup
    // beyond a few seconds, and the fallback prices stay in place.
    await Promise.race([startup().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 4000))]);
  },
  description:
    "Pre-action safety, honeypot exit simulation, cabal holder clusters, chain reads, prediction evidence and ERC-8183 escrow evaluations for ElizaOS agents over x402 on Base: bounded verdicts, fail-closed defaults and seeder reuse dividends.",
  actions: [
    // Active paid capabilities (6 canonical capabilities).
    checkContract, tokenInfo, chainSnapshot, predictionEvidence, tokenLaunchGuard, tokenHoldersGuard,
    // Free verification & discovery helpers.
    evidenceArtifactAction, acpEvaluateAction, previewAction, rulesAction, catalogAction, opportunitiesAction, pledgeDemandAction,
    // Cooperative loop (seeder dividends, quests, bounties, standing & outcomes).
    questsAction, bountiesAction, seedAction, standingAction, reportOutcomeAction,
  ],
};

export default terenoPlugin;
