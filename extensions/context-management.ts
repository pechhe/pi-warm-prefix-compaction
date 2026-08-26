import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CONTEXT_STATUS_EVENT = "pi-context-management:status";
export const CONTEXT_PROJECTION_EVENT = "pi-context-management:projection";
export const CONTEXT_FOLD_ENTRY = "pi-context-management:fold";
export const CONTEXT_VERSION = 1;

export interface ContextManagementConfig {
  maxChars: number;
  maxLines: number;
  errorMaxChars: number;
  errorMaxLines: number;
  maxImages: number;
  maxImageChars: number;
  defaultReadLines: number;
  foldPressure: number;
  foldMinChars: number;
  foldPreviewChars: number;
  protectedRecentResults: number;
  foldBatchNewResults: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextManagementConfig = {
  maxChars: 16_000,
  maxLines: 400,
  errorMaxChars: 24_000,
  errorMaxLines: 800,
  maxImages: 2,
  maxImageChars: 5_000_000,
  defaultReadLines: 240,
  foldPressure: 0.72,
  foldMinChars: 24_000,
  foldPreviewChars: 2_000,
  protectedRecentResults: 4,
  foldBatchNewResults: 3,
};

const BASE64_JSON = /((?:\\?")(?:data|image|base64|encrypted_content)(?:\\?")\s*:\s*(?:\\?"))([A-Za-z0-9+/_-]{1024,}={0,2})((?:\\?"))/g;
const BASE64_DATA_URL = /(data:[^;,\s"]+;base64,)([A-Za-z0-9+/_-]{1024,}={0,2})/g;
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

export interface ProjectionStats {
  version: 1;
  enabled: boolean;
  pressure: number | null;
  inputToolBytes: number;
  outputToolBytes: number;
  reclaimedBytes: number;
  boundedResults: number;
  foldCount: number;
  foldedResults: number;
  maskedChars: number;
  protectedRecentResults: number;
  recoveryUses: number;
  readWindowsApplied: number;
  foldEpoch: number;
  foldReachedProvider: boolean | null;
  cacheRewriteTokens: number | null;
  cachedReadSavingsTokens: number | null;
  netCacheSavingsTokens: number | null;
  config: ContextManagementConfig;
}

type Message = { role?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown; content?: unknown; stopReason?: unknown; [key: string]: unknown };
type TextBlock = { type?: unknown; text?: unknown; data?: unknown; [key: string]: unknown };

function toolId(message: Message, index: number): string {
  return typeof message.toolCallId === "string" && message.toolCallId ? message.toolCallId : `message-${index}`;
}

export function recoveryHandle(id: string, blockIndex: number): string {
  return `pictx:v1:${encodeURIComponent(id)}:${blockIndex}`;
}

export function parseRecoveryHandle(handle: string): { toolCallId: string; blockIndex: number } | null {
  const match = /^pictx:v1:([^:]+):(\d+)$/.exec(handle);
  if (!match) return null;
  return { toolCallId: decodeURIComponent(match[1]!), blockIndex: Number(match[2]) };
}

export function normalizeTransportNoise(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(CONTROL, "")
    .replace(BASE64_JSON, (_m, open: string, encoded: string, close: string) => `${open}[encoded payload omitted: ${encoded.length} chars]${close}`)
    .replace(BASE64_DATA_URL, (_m, prefix: string, encoded: string) => `${prefix}[encoded payload omitted: ${encoded.length} chars]`)
    .replace(/\n{6,}/g, "\n\n\n");
}

function safePrefix(text: string, count: number): string {
  let end = Math.min(text.length, Math.max(0, count));
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

function safeSuffix(text: string, count: number): string {
  let start = Math.max(0, text.length - Math.max(0, count));
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start]!)) start += 1;
  return text.slice(start);
}

function literalHeadTail(text: string, budget: number, notice: string): string {
  if (budget <= 0) return "";
  if (notice.length >= budget) return safePrefix(notice, budget);
  const contentBudget = budget - notice.length;
  const head = Math.ceil(contentBudget * 0.75);
  return `${safePrefix(text, head)}${notice}${safeSuffix(text, contentBudget - head)}`;
}

function lineBound(text: string, maxLines: number): { text: string; omitted: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, omitted: 0 };
  const head = Math.ceil(maxLines * 0.75);
  const tail = Math.max(0, maxLines - head);
  return { text: [...lines.slice(0, head), ...lines.slice(lines.length - tail)].join("\n"), omitted: lines.length - maxLines };
}

export function boundText(text: string, options: { maxChars: number; maxLines: number; handle: string }): string {
  const normalized = normalizeTransportNoise(text);
  const byLines = lineBound(normalized, Math.max(1, options.maxLines));
  const charLimit = Math.max(0, options.maxChars);
  if (byLines.omitted === 0 && byLines.text.length <= charLimit) return byLines.text;
  const omittedChars = Math.max(0, normalized.length - Math.min(normalized.length, charLimit));
  const notice = `\n\n[Context bounded: ${omittedChars} chars${byLines.omitted ? `, ${byLines.omitted} lines` : ""} omitted. Recover exactly with context_recover handle ${options.handle}.]\n\n`;
  return literalHeadTail(byLines.text, charLimit, notice);
}

function foldedText(text: string, handle: string, maxChars: number): string {
  const normalized = normalizeTransportNoise(text);
  if (normalized.length <= maxChars) return normalized;
  const notice = `\n\n[Stale tool output folded. Exact transcript recovery: ${handle}.]\n\n`;
  return literalHeadTail(normalized, maxChars, notice);
}

function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return 0; }
}

export interface ProjectionOptions {
  config?: ContextManagementConfig;
  foldedToolIds?: ReadonlySet<string>;
}

export function projectContextMessages(input: readonly unknown[], options: ProjectionOptions = {}): { messages: unknown[]; boundedResults: number; maskedChars: number; toolIds: string[] } {
  const config = options.config ?? DEFAULT_CONTEXT_CONFIG;
  const folded = options.foldedToolIds ?? new Set<string>();
  const messages = input.filter((value) => {
    const message = value as Message | undefined;
    const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
    return message?.role !== "assistant" || !failed || !Array.isArray(message.content) || message.content.length > 0;
  });
  let boundedResults = 0;
  let maskedChars = 0;
  const ids: string[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex] as Message | undefined;
    if (message?.role !== "toolResult" || !Array.isArray(message.content)) continue;
    const id = toolId(message, messageIndex);
    ids.push(id);
    const content = [...message.content] as TextBlock[];
    let remainingImages = config.maxImages;
    let changed = false;
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex]!;
      const handle = recoveryHandle(id, blockIndex);
      if (block.type === "image" && typeof block.data === "string") {
        if (remainingImages > 0 && block.data.length <= config.maxImageChars) { remainingImages -= 1; continue; }
        content[blockIndex] = { type: "text", text: `[Context bounded image: ${block.data.length} encoded chars omitted. Recover from transcript with ${handle}.]` };
        maskedChars += block.data.length;
        changed = true;
      } else if (block.type === "text" && typeof block.text === "string") {
        const error = message.isError === true;
        const first = boundText(block.text, {
          maxChars: error ? config.errorMaxChars : config.maxChars,
          maxLines: error ? config.errorMaxLines : config.maxLines,
          handle,
        });
        const projected = folded.has(id) ? foldedText(first, handle, config.foldPreviewChars) : first;
        if (projected !== block.text) {
          maskedChars += Math.max(0, block.text.length - projected.length);
          content[blockIndex] = { ...block, text: projected };
          changed = true;
        }
      }
    }
    if (changed) boundedResults += 1;
    messages[messageIndex] = { ...message, content };
  }
  return { messages, boundedResults, maskedChars, toolIds: ids };
}

function toolResultTextChars(message: Message): number {
  if (message.role !== "toolResult" || !Array.isArray(message.content)) return 0;
  return message.content.reduce((sum, block) => sum + (block && typeof block === "object" && (block as TextBlock).type === "text" && typeof (block as TextBlock).text === "string" ? ((block as TextBlock).text as string).length : 0), 0);
}

function toolMessages(messages: readonly unknown[]): Array<{ id: string; chars: number }> {
  const out: Array<{ id: string; chars: number }> = [];
  messages.forEach((value, index) => {
    const message = value as Message;
    if (message?.role !== "toolResult") return;
    out.push({ id: toolId(message, index), chars: toolResultTextChars(message) });
  });
  return out;
}

function findOriginalText(ctx: ExtensionContext, id: string, blockIndex: number): string | null {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message as Message;
    if (message.role !== "toolResult" || message.toolCallId !== id || !Array.isArray(message.content)) continue;
    const block = message.content[blockIndex] as TextBlock | undefined;
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "image" && typeof block.data === "string") return block.data;
  }
  return null;
}

export function installContextManagement(pi: ExtensionAPI): void {
  const config = { ...DEFAULT_CONTEXT_CONFIG };
  const folded = new Set<string>();
  const seen = new Set<string>();
  const readWindowCalls = new Set<string>();
  let enabled = true;
  let bypassNext = false;
  let foldEpoch = 0;
  let lastFoldToolCount = 0;
  let foldCount = 0;
  let recoveryUses = 0;
  let readWindowsApplied = 0;
  let lastStats: ProjectionStats | null = null;
  let estimatedMaskedTokens = 0;

  const numericFlag = (name: string, fallback: number): number => {
    const value = pi.getFlag(name);
    const parsed = typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const emitStatus = () => pi.events.emit(CONTEXT_STATUS_EVENT, lastStats ?? { version: 1, enabled, config, foldEpoch, foldCount, recoveryUses, readWindowsApplied });

  pi.registerFlag("context-management", { description: "Enable shared deterministic context management", type: "boolean", default: true });
  pi.registerFlag("context-max-chars", { description: "Normal tool-result character preview budget", type: "string", default: String(config.maxChars) });
  pi.registerFlag("context-max-lines", { description: "Normal tool-result line preview budget", type: "string", default: String(config.maxLines) });
  pi.registerFlag("context-error-max-chars", { description: "Failed tool-result character preview budget", type: "string", default: String(config.errorMaxChars) });
  pi.registerFlag("context-error-max-lines", { description: "Failed tool-result line preview budget", type: "string", default: String(config.errorMaxLines) });
  pi.registerFlag("context-read-lines", { description: "Default line window for otherwise unbounded read calls", type: "string", default: String(config.defaultReadLines) });
  pi.registerFlag("context-fold-pressure", { description: "Context pressure fraction that permits a discrete stale fold", type: "string", default: String(config.foldPressure) });
  pi.registerFlag("context-protected-results", { description: "Most recent tool results protected from stale folding", type: "string", default: String(config.protectedRecentResults) });
  pi.registerCommand("context-status", { description: "Show shared context-management status", handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(lastStats ?? { enabled, config, foldEpoch, foldCount, recoveryUses, readWindowsApplied }, null, 2), "info") });
  pi.registerCommand("context-bypass-next", { description: "Show the next tool result without first-visibility bounding", handler: async (_args, ctx) => { bypassNext = true; ctx.ui.notify("The next tool result will bypass first-visibility context bounds once.", "warning"); emitStatus(); } });

  pi.on("session_start", (_event, ctx) => {
    enabled = pi.getFlag("context-management") !== false;
    config.maxChars = numericFlag("context-max-chars", DEFAULT_CONTEXT_CONFIG.maxChars);
    config.maxLines = numericFlag("context-max-lines", DEFAULT_CONTEXT_CONFIG.maxLines);
    config.errorMaxChars = numericFlag("context-error-max-chars", DEFAULT_CONTEXT_CONFIG.errorMaxChars);
    config.errorMaxLines = numericFlag("context-error-max-lines", DEFAULT_CONTEXT_CONFIG.errorMaxLines);
    config.defaultReadLines = numericFlag("context-read-lines", DEFAULT_CONTEXT_CONFIG.defaultReadLines);
    config.foldPressure = Math.min(0.98, numericFlag("context-fold-pressure", DEFAULT_CONTEXT_CONFIG.foldPressure));
    config.protectedRecentResults = Math.floor(numericFlag("context-protected-results", DEFAULT_CONTEXT_CONFIG.protectedRecentResults));
    folded.clear();
    seen.clear();
    foldEpoch = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === CONTEXT_FOLD_ENTRY && entry.data && typeof entry.data === "object") {
        const data = entry.data as { toolCallIds?: unknown; epoch?: unknown };
        if (Array.isArray(data.toolCallIds)) for (const id of data.toolCallIds) if (typeof id === "string") folded.add(id);
        if (typeof data.epoch === "number") foldEpoch = Math.max(foldEpoch, data.epoch);
      }
      if (entry.type === "message") {
        const message = entry.message as Message;
        if (message.role === "toolResult" && typeof message.toolCallId === "string") seen.add(message.toolCallId);
      }
    }
    lastFoldToolCount = seen.size;
    emitStatus();
  });

  pi.on("tool_call", (event) => {
    if (!enabled || event.toolName !== "read") return;
    const input = event.input as { offset?: unknown; limit?: unknown };
    if (input.offset === undefined && input.limit === undefined) {
      input.limit = config.defaultReadLines;
      readWindowCalls.add(event.toolCallId);
      readWindowsApplied += 1;
    }
  });

  pi.on("tool_result", (event) => {
    if (!readWindowCalls.delete(event.toolCallId)) return;
    return { content: [...event.content, { type: "text", text: `[Context guard: read defaulted to ${config.defaultReadLines} lines because no explicit range was supplied. Read a targeted offset/limit for more.]` }] };
  });

  pi.on("context", (event, ctx) => {
    if (!enabled) return;
    const originals = event.messages as unknown[];
    const tools = toolMessages(originals);
    const currentIds = new Set(tools.map((tool) => tool.id));
    for (const id of [...folded]) if (!currentIds.has(id)) folded.delete(id);

    const usage = ctx.getContextUsage();
    const pressure = usage?.percent == null ? null : usage.percent / 100;
    const protectedIds = new Set(tools.slice(-config.protectedRecentResults).map((tool) => tool.id));
    const eligible = tools.filter((tool) => seen.has(tool.id) && !folded.has(tool.id) && !protectedIds.has(tool.id) && tool.chars > config.foldPreviewChars);
    const reclaimable = eligible.reduce((sum, tool) => sum + Math.max(0, tool.chars - config.foldPreviewChars), 0);
    const enoughNewResults = tools.length - lastFoldToolCount >= config.foldBatchNewResults;
    if (pressure != null && pressure >= config.foldPressure && reclaimable >= config.foldMinChars && (foldCount === 0 || enoughNewResults)) {
      for (const tool of eligible) folded.add(tool.id);
      foldEpoch += 1;
      foldCount += 1;
      lastFoldToolCount = tools.length;
      estimatedMaskedTokens = Math.ceil(reclaimable / 4);
      pi.appendEntry(CONTEXT_FOLD_ENTRY, { version: 1, epoch: foldEpoch, toolCallIds: eligible.map((tool) => tool.id), pressure, reclaimableChars: reclaimable });
    }

    const effectiveFolded = new Set(folded);
    if (bypassNext) {
      const newest = tools.at(-1)?.id;
      if (newest) effectiveFolded.delete(newest);
    }
    const projected = projectContextMessages(originals, { config, foldedToolIds: effectiveFolded });
    if (bypassNext && tools.length > 0) {
      const newestId = tools.at(-1)!.id;
      const index = originals.findIndex((value, i) => (value as Message)?.role === "toolResult" && toolId(value as Message, i) === newestId);
      if (index >= 0) projected.messages[index] = originals[index];
      bypassNext = false;
    }
    for (const id of projected.toolIds) seen.add(id);
    const inputBytes = originals.filter((m) => (m as Message)?.role === "toolResult").reduce((sum, value) => sum + byteLength(value), 0);
    const outputBytes = projected.messages.filter((m) => (m as Message)?.role === "toolResult").reduce((sum, value) => sum + byteLength(value), 0);
    lastStats = {
      version: 1,
      enabled,
      pressure,
      inputToolBytes: inputBytes,
      outputToolBytes: outputBytes,
      reclaimedBytes: Math.max(0, inputBytes - outputBytes),
      boundedResults: projected.boundedResults,
      foldCount,
      foldedResults: folded.size,
      maskedChars: projected.maskedChars,
      protectedRecentResults: Math.min(config.protectedRecentResults, tools.length),
      recoveryUses,
      readWindowsApplied,
      foldEpoch,
      foldReachedProvider: null,
      cacheRewriteTokens: null,
      cachedReadSavingsTokens: null,
      netCacheSavingsTokens: null,
      config,
    };
    pi.events.emit(CONTEXT_PROJECTION_EVENT, { ...lastStats, toolCallIds: projected.toolIds, foldedToolCallIds: [...folded] });
    emitStatus();
    return { messages: projected.messages as typeof event.messages };
  });

  pi.on("before_provider_request", (event) => {
    if (!lastStats) return;
    let foldReachedProvider: boolean | null = null;
    if (folded.size > 0) {
      try { foldReachedProvider = JSON.stringify(event.payload).includes("Stale tool output folded"); } catch { foldReachedProvider = false; }
    }
    lastStats = { ...lastStats, foldReachedProvider };
    emitStatus();
  });

  pi.on("turn_end", (event) => {
    if (!lastStats || foldEpoch === 0) return;
    const message = event.message as { role?: unknown; usage?: { cacheRead?: unknown; cacheWrite?: unknown } };
    if (message.role !== "assistant" || !message.usage) return;
    const cacheRead = typeof message.usage.cacheRead === "number" ? message.usage.cacheRead : null;
    const cacheWrite = typeof message.usage.cacheWrite === "number" ? message.usage.cacheWrite : null;
    const cachedReadSavingsTokens = cacheRead == null ? null : Math.min(cacheRead, estimatedMaskedTokens);
    const netCacheSavingsTokens = cachedReadSavingsTokens == null || cacheWrite == null ? null : cachedReadSavingsTokens - cacheWrite;
    lastStats = { ...lastStats, cacheRewriteTokens: cacheWrite, cachedReadSavingsTokens, netCacheSavingsTokens };
    emitStatus();
  });

  pi.registerTool({
    name: "context_recover",
    label: "Recover context",
    description: "Recover exact text from a context-bounded or stale-folded Pi tool result using its transcript-backed pictx handle. Prefer a targeted line range or lexical search.",
    parameters: Type.Object({
      handle: Type.String(),
      offset: Type.Optional(Type.Number({ minimum: 1 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 400 })),
      query: Type.Optional(Type.String()),
      around: Type.Optional(Type.Number({ minimum: 0, maximum: 80 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const parsed = parseRecoveryHandle(params.handle);
      if (!parsed) return { content: [{ type: "text", text: "Invalid context recovery handle." }], isError: true };
      const original = findOriginalText(ctx, parsed.toolCallId, parsed.blockIndex);
      if (original == null) return { content: [{ type: "text", text: "The authoritative session no longer contains that tool result." }], isError: true };
      recoveryUses += 1;
      const lines = original.split("\n");
      let start = Math.max(0, Math.floor((params.offset ?? 1) - 1));
      let end = Math.min(lines.length, start + Math.floor(params.limit ?? 120));
      if (params.query) {
        const needle = params.query.toLowerCase();
        const hit = lines.findIndex((line) => line.toLowerCase().includes(needle));
        if (hit < 0) return { content: [{ type: "text", text: `No lexical match for ${JSON.stringify(params.query)} in ${params.handle}.` }] };
        const around = Math.floor(params.around ?? 12);
        start = Math.max(0, hit - around);
        end = Math.min(lines.length, hit + around + 1);
      }
      emitStatus();
      return { content: [{ type: "text", text: lines.slice(start, end).join("\n") + `\n\n[Recovered exact transcript lines ${start + 1}-${end} of ${lines.length}.]` }], details: { handle: params.handle, startLine: start + 1, endLine: end, totalLines: lines.length } };
    },
  });
}
