import { complete, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// ponytail: filter only the tools that actually blow up context; add more if they show up hot
const FILTERED_TOOLS = new Set(["bash", "grep", "read"]);
const LINE_THRESHOLD = 80;
const CHAR_THRESHOLD = 4000;
const FILTER_MODEL = { provider: "anthropic", id: "claude-haiku-4-5-20251001" };
const MAX_SEEN_SUMMARIES = 10;
const CHUNK_DIR = mkdtempSync(join(tmpdir(), "pi-context-filter-"));
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

// ponytail: opt-in JSONL log for measuring jev accuracy — off by default, no cost when unset
const DEBUG_LOG_PATH = process.env.JEV_DEBUG ? process.env.JEV_DEBUG_LOG ?? join(homedir(), ".jev-context-filter-debug.jsonl") : undefined;

function debugLog(entry: Record<string, unknown>): void {
  if (!DEBUG_LOG_PATH) return;
  try {
    appendFileSync(DEBUG_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    // best-effort logging, never break the tool over a disk error
  }
}

type Visibility = "hide" | "short" | "long" | "full";

async function jevVisibility(args: {
  taskGoal?: string;
  recentIntent: string;
  toolName: string;
  input: unknown;
  raw: string;
}): Promise<{ visibility?: Visibility; detail: unknown }> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { detail: "no_api_key" };

  try {
    const res = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: {
          task_goal: args.taskGoal ?? "unknown",
          recent_intent: args.recentIntent,
          tool: { name: args.toolName, input: args.input },
          chunk: args.raw.slice(0, 8000),
        },
        questions: {
          visibility: {
            type: "choice",
            instructions:
              "How visible should this tool output chunk be to the coding agent, given the task goal and recent intent?",
            criteria: {
              hide: "Irrelevant to the task goal and recent intent; safe to drop entirely",
              short: "Marginally relevant; a one or two line gist is enough",
              long: "Relevant; a detailed but partial summary is needed",
              full: "Directly needed for the next step; must be shown unmodified",
            },
          },
        },
      }),
    });
    if (!res.ok) return { detail: `http_${res.status}` };
    const data = (await res.json()) as { answers: { visibility: { choice: Visibility } } };
    return { visibility: data.answers.visibility.choice, detail: data.answers.visibility };
  } catch (err) {
    return { detail: `error: ${String(err)}` };
  }
}

type State = {
  taskGoal?: string;
  seenSummaries: string[];
};

const state: State = { seenSummaries: [] };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function stashChunk(raw: string): string {
  const id = Math.random().toString(36).slice(2, 8);
  writeFileSync(join(CHUNK_DIR, `${id}.txt`), raw, "utf8");
  return id;
}

function recentIntentOf(ctx: ExtensionContext): string {
  return ctx.sessionManager
    .getBranch()
    .filter((e) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"))
    .slice(-3)
    .map((e) => `${e.message!.role}: ${extractText(e.message!.content).slice(0, 300)}`)
    .join("\n");
}

async function summarize(
  ctx: ExtensionContext,
  raw: string,
  toolName: string,
  input: unknown,
  recent: string,
  visibility: "short" | "long",
): Promise<string | undefined> {
  const model = getModel(FILTER_MODEL.provider, FILTER_MODEL.id);
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  const lengthHint = visibility === "short" ? "One or two lines, just the gist." : "A detailed but partial summary.";
  const prompt = [
    "You compress noisy tool output for a coding agent's context window.",
    `Keep only what's relevant to the task and recent intent below. ${lengthHint}`,
    "State how many lines you dropped at the end, e.g. '(dropped 1800 irrelevant lines)'.",
    "",
    `Task goal: ${state.taskGoal ?? "unknown"}`,
    state.seenSummaries.length ? `Already shown this session:\n${state.seenSummaries.join("\n")}` : "",
    `Recent turns:\n${recent}`,
    `Tool: ${toolName} ${JSON.stringify(input).slice(0, 300)}`,
    "",
    "<tool_output>",
    raw,
    "</tool_output>",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await complete(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      { apiKey: auth.apiKey, headers: auth.headers },
    );
    return response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const first = ctx.sessionManager.getEntries().find((e) => e.type === "message" && e.message?.role === "user");
    state.taskGoal = first ? extractText(first.message!.content).slice(0, 300) : undefined;
    state.seenSummaries = [];
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!FILTERED_TOOLS.has(event.toolName) || event.isError) return;
    const raw = extractText(event.content);
    if (raw.length < CHAR_THRESHOLD && raw.split("\n").length < LINE_THRESHOLD) return;

    const recent = recentIntentOf(ctx);
    const jev = await jevVisibility({ taskGoal: state.taskGoal, recentIntent: recent, toolName: event.toolName, input: event.input, raw });
    const source = jev.visibility ? "jev" : "fallback";
    const visibility =
      jev.visibility ??
      "long"; // ponytail: no TYPESAFE_API_KEY or API error — default to summarizing rather than dropping data

    if (visibility === "full") {
      debugLog({ event: "decision", visibility, source, jev: jev.detail, command: JSON.stringify(event.input).slice(0, 200), toolName: event.toolName, lines: raw.split("\n").length, chars: raw.length });
      return;
    }

    const id = stashChunk(raw);
    const lineCount = raw.split("\n").length;
    debugLog({ event: "decision", visibility, source, jev: jev.detail, command: JSON.stringify(event.input).slice(0, 200), toolName: event.toolName, lines: lineCount, chars: raw.length, chunkId: id });

    if (visibility === "hide") {
      return { content: [{ type: "text", text: `[hidden as irrelevant, ${lineCount} lines — call expand_chunk("${id}") to see it]` }] };
    }

    const summary = await summarize(ctx, raw, event.toolName, event.input, recent, visibility);
    if (!summary) return;

    const text = `${summary}\n\n[full output stashed, ${lineCount} lines — call expand_chunk("${id}") to see all]`;
    state.seenSummaries = [...state.seenSummaries, summary.slice(0, 150)].slice(-MAX_SEEN_SUMMARIES);

    return { content: [{ type: "text", text }] };
  });

  pi.registerTool({
    name: "expand_chunk",
    label: "Expand Chunk",
    description: "Retrieve the full, unfiltered output of a previously compressed tool result by its chunk id.",
    parameters: Type.Object({
      id: Type.String({ description: "Chunk id from a '[full output stashed ...]' note" }),
    }),
    async execute(_id, params) {
      try {
        const raw = readFileSync(join(CHUNK_DIR, `${params.id}.txt`), "utf8");
        debugLog({ event: "expand", chunkId: params.id });
        return { content: [{ type: "text", text: raw }], details: {} };
      } catch {
        return { content: [{ type: "text", text: `No stashed chunk with id ${params.id}` }], details: {}, isError: true };
      }
    },
  });
}
