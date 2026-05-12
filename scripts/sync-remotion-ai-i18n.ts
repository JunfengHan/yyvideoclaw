// Helper script: appends the `remotionAi` + `library` translation blocks
// (English copy) to every shipped locale that doesn't already have them.
// Run once after adding a new section — keeps the i18n parity gate green
// while leaving translation as a follow-up PR.
//
// Usage: `node --import tsx scripts/sync-remotion-ai-i18n.ts`
//
// This script is idempotent for each section: already-present sections
// are left untouched. It also adds `tabs.library` + `subtitles.library`
// when those keys are missing (M1.5 introduced the Library tab).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SQ = String.fromCharCode(39); // ASCII single quote.

const REMOTION_AI_BLOCK =
  `  remotionAi: {\n` +
  `    heading: "AI Create",\n` +
  `    state: {\n` +
  `      idle: "Idle",\n` +
  `    },\n` +
  `    actions: {\n` +
  `      collapse: "Collapse",\n` +
  `      expand: "Expand",\n` +
  `    },\n` +
  `    form: {\n` +
  `      promptLabel: "Prompt",\n` +
  `      promptPlaceholder:\n` +
  `        ` +
  JSON.stringify(
    `Describe the Remotion video you want the agent to author (e.g. "A 3-second title card animating the word ${SQ}Hello${SQ} with a gradient background").`,
  ) +
  `,\n` +
  `      retryMaxLabel: "Max retries",\n` +
  `      submit: "Generate",\n` +
  `      submitting: "Generating…",\n` +
  `      cancel: "Cancel",\n` +
  `      advancedShow: "▸ Advanced",\n` +
  `      advancedHide: "▾ Advanced",\n` +
  `      advancedHint:\n` +
  `        "These settings have sensible defaults. Tweak only if a job keeps failing validation.",\n` +
  `      validation: {\n` +
  `        promptRequired: "Please enter a prompt to get started.",\n` +
  `      },\n` +
  `    },\n` +
  `    status: {\n` +
  `      phase: "Phase",\n` +
  `      retryCount: "{count} retry attempt(s)",\n` +
  `      elapsed: "{seconds}s elapsed",\n` +
  `      progressLabel: "Job progress",\n` +
  `    },\n` +
  `    phase: {\n` +
  `      queued: "queued",\n` +
  `      workspace: "preparing workspace",\n` +
  `      skills: "loading skills",\n` +
  `      agent: "agent thinking",\n` +
  `      bundle: "bundling project",\n` +
  `      select: "selecting composition",\n` +
  `      still: "rendering preview",\n` +
  `      retry: "retrying with feedback",\n` +
  `      done: "done",\n` +
  `      failed: "failed",\n` +
  `      cancelled: "cancelled",\n` +
  `    },\n` +
  `    outcome: {\n` +
  `      savedToLibrary: "✓ Saved to Library",\n` +
  `      composition: "Composition",\n` +
  `      openLibrary: "Open in Library",\n` +
  `      copyWorkspacePath: "Copy workspace path",\n` +
  `      cancelled: "Job cancelled.",\n` +
  `      failed: "Job failed.",\n` +
  `      failedNoDetail:\n` +
  `        "The job failed but the server didn${SQ}t report a specific reason. Check the gateway logs for details.",\n` +
  `      debugDetails: "Debug details",\n` +
  `    },\n` +
  `    errors: {\n` +
  `      submitFailed: "Could not submit job: {detail}",\n` +
  `    },\n` +
  `    auth: {\n` +
  `      badge: {\n` +
  `        unset: "Choose AI",\n` +
  `        hosted: "Hosted",\n` +
  `        byok: "Own key",\n` +
  `        openrouter: "OpenRouter",\n` +
  `        creditsRemaining: "{count} credits left",\n` +
  `        creditsUnknown: "Quota unknown",\n` +
  `      },\n` +
  `      modal: {\n` +
  `        close: "Close",\n` +
  `        back: "Back",\n` +
  `        submitting: "Working…",\n` +
  `        chooser: {\n` +
  `          title: "Choose your AI service",\n` +
  `          intro:\n` +
  `            "AI Create needs a model provider. Pick one to continue. You can switch later from the panel header.",\n` +
  `          hostedTitle: "Use yyvideoclaw hosted",\n` +
  `          hostedBadge: "Recommended",\n` +
  `          hostedDescription:\n` +
  `            "Sign in with your yyvideoclaw account; we cover the model. Free monthly quota included.",\n` +
  `          byokTitle: "Use my own key",\n` +
  `          byokDescription:\n` +
  `            "Bring an OpenAI or OpenRouter API key. Stored locally; you pay the model provider directly.",\n` +
  `        },\n` +
  `        hosted: {\n` +
  `          title: "Sign in to yyvideoclaw",\n` +
  `          intro: "Use the email + password from your yyvideoclaw account.",\n` +
  `          emailLabel: "Email",\n` +
  `          passwordLabel: "Password",\n` +
  `          submit: "Sign in",\n` +
  `        },\n` +
  `        byokPick: {\n` +
  `          title: "Pick a key provider",\n` +
  `          intro:\n` +
  `            "Both store the key on this machine. Pick the service whose API key you already have.",\n` +
  `          openaiTitle: "OpenAI (sk-…)",\n` +
  `          openaiDescription:\n` +
  `            "Use a key from platform.openai.com. Saved to ~/.codex/auth.json — same place codex login writes to.",\n` +
  `          openrouterTitle: "OpenRouter (sk-or-v1-…)",\n` +
  `          openrouterDescription:\n` +
  `            "Use one OpenRouter key for 300+ models (Claude, GPT, DeepSeek, Llama, …). Saved to ~/.openclaw/remotion-ai/byok-openrouter.json.",\n` +
  `          openrouterUnsupportedBadge: "Unavailable",\n` +
  `          openrouterUnsupportedHint:\n` +
  `            ` +
  JSON.stringify(
    `Disabled while the codex CLI requires wire_api = "responses" and OpenRouter has no Responses API. See openai/codex discussion #7782.`,
  ) +
  `,\n` +
  `        },\n` +
  `        byokOpenai: {\n` +
  `          title: "Use your OpenAI key",\n` +
  `          intro:\n` +
  `            "Paste a key starting with sk-…. We write it to ~/.codex/auth.json with 0600 perms — the same file the codex CLI uses.",\n` +
  `          apiKeyLabel: "OpenAI API key",\n` +
  `          apiKeyHint:\n` +
  `            "We never transmit this key to yyvideoclaw servers. The codex CLI reads it directly.",\n` +
  `          displayNameLabel: "Label (optional)",\n` +
  `          displayNamePlaceholder: "e.g. Personal account",\n` +
  `          submit: "Save key",\n` +
  `        },\n` +
  `        byokOpenrouter: {\n` +
  `          title: "Use your OpenRouter key",\n` +
  `          intro:\n` +
  `            "Paste a sk-or-v1-… key and pick a model. We update ~/.codex/config.toml with an OpenRouter provider entry and store the key under ~/.openclaw/remotion-ai/.",\n` +
  `          apiKeyLabel: "OpenRouter API key",\n` +
  `          apiKeyHint:\n` +
  `            "Find this at openrouter.ai/keys. The key is loaded into the codex child process as OPENROUTER_API_KEY.",\n` +
  `          modelLabel: "Model",\n` +
  `          modelLoading: "loading models…",\n` +
  `          modelHint:\n` +
  `            "Pricing shown is per 1M tokens. Code-strong models (Claude Sonnet, GPT-4.1) tend to produce better Remotion projects than cheap chat models.",\n` +
  `          displayNameLabel: "Label (optional)",\n` +
  `          displayNamePlaceholder: "e.g. OpenRouter trial",\n` +
  `          submit: "Save key",\n` +
  `        },\n` +
  `        errors: {\n` +
  `          invalidCredentials: "That email and password didn${SQ}t match an account.",\n` +
  `          backendUnreachable: "Couldn${SQ}t reach the yyvideoclaw service. Check your internet connection.",\n` +
  `          backendError: "The yyvideoclaw service returned an error: {detail}",\n` +
  `          invalidApiKey: "That doesn${SQ}t look like a valid API key. OpenAI keys start with sk-…, OpenRouter keys with sk-or-v1-….",\n` +
  `          ioError: "Couldn${SQ}t save the key on disk: {detail}",\n` +
  `          generic: "Something went wrong: {detail}",\n` +
  `        },\n` +
  `      },\n` +
  `    },\n` +
  `  },\n`;

const LIBRARY_BLOCK =
  `  library: {\n` +
  `    heading: "Library",\n` +
  `    description:\n` +
  `      "Local AI-generated resources. Every AI Create job lands here automatically — browse, preview, or delete past runs.",\n` +
  `    actions: {\n` +
  `      refresh: "Refresh",\n` +
  `    },\n` +
  `    filter: {\n` +
  `      searchPlaceholder: "Search prompt, path, or engine…",\n` +
  `      includeLive: "Show in-flight jobs",\n` +
  `    },\n` +
  `    sources: {\n` +
  `      all: "All sources",\n` +
  `      remotionAi: "Remotion AI jobs",\n` +
  `    },\n` +
  `    item: {\n` +
  `      untitled: "(no prompt)",\n` +
  `      liveBadge: "running",\n` +
  `      created: "Created {ts}",\n` +
  `      copyPath: "Copy path",\n` +
  `      delete: "Delete",\n` +
  `      deleting: "Deleting…",\n` +
  `    },\n` +
  `    empty: {\n` +
  `      zero: "Your Library is empty. Kick off an AI Create job in Remotion Studio.",\n` +
  `      cta: "Go to Remotion Studio",\n` +
  `      filtered: "No items match the current filter.",\n` +
  `    },\n` +
  `  },\n`;

const SKIP = new Set(["en.ts", "zh-CN.ts"]);
const dir = "ui/src/i18n/locales";
const entries = readdirSync(dir).filter((f) => f.endsWith(".ts") && !SKIP.has(f));

for (const file of entries) {
  const p = path.join(dir, file);
  let src = readFileSync(p, "utf8");
  let changed = false;

  // 1) Remove stale keys that were removed in M1.5.
  const obsoletePatterns = [
    /\n\s{6}outputRootLabel:[^\n]*\n/u,
    /\n\s{6}outputRootPlaceholder:[^\n]*\n/u,
    /\n\s{8}outputRootRequired:[^\n]*\n/u,
    /\n\s{8}outputRootNotAbsolute:[^\n]*\n/u,
    /\n\s{6}addToTemplateRootsHint:[\s\S]*?"[^"]*",\n/u,
    /\n\s{6}success:[^\n]*"[^"]*",\n/u,
    /\n\s{6}validate:[^\n]*"[^"]*",\n/u,
  ];
  for (const re of obsoletePatterns) {
    if (re.test(src)) {
      src = src.replace(re, "\n");
      changed = true;
    }
  }

  // 2) Replace the whole `remotionAi:` block with the fresh English one.
  //    We match `  remotionAi: {` up to its matching `  },` using a
  //    brace-balancing scan (regex alone can't count braces reliably).
  const remotionStart = src.indexOf("  remotionAi: {");
  if (remotionStart >= 0) {
    const endIdx = findBlockEnd(src, remotionStart);
    if (endIdx > remotionStart) {
      src = src.slice(0, remotionStart) + REMOTION_AI_BLOCK + src.slice(endIdx);
      changed = true;
    }
  } else {
    // Section doesn't exist yet — inject it before the trailing `};\n`.
    const tail = "  },\n};\n";
    const idx = src.lastIndexOf(tail);
    if (idx >= 0) {
      src = src.slice(0, idx) + "  },\n" + REMOTION_AI_BLOCK + "};\n";
      changed = true;
    }
  }

  // 3) Append library section if missing.
  if (!src.includes("  library: {")) {
    const tail = "  },\n};\n";
    const idx = src.lastIndexOf(tail);
    if (idx >= 0) {
      src = src.slice(0, idx) + "  },\n" + LIBRARY_BLOCK + "};\n";
      changed = true;
    }
  }

  // 4) Ensure `tabs.library` + `subtitles.library` are present. Strategy:
  //    find each `remotionStudio: "..."` line and insert a `library: "..."`
  //    line directly below — once at tabs, once at subtitles.
  const lines = src.split("\n");
  let inTabsBlock = false;
  let inSubtitlesBlock = false;
  let tabsHasLibrary = false;
  let subtitlesHasLibrary = false;
  const insertions: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*tabs:\s*\{/.test(line)) {
      inTabsBlock = true;
      inSubtitlesBlock = false;
      tabsHasLibrary = false;
      continue;
    }
    if (/^\s*subtitles:\s*\{/.test(line)) {
      inSubtitlesBlock = true;
      inTabsBlock = false;
      subtitlesHasLibrary = false;
      continue;
    }
    if (inTabsBlock) {
      if (/^\s*library:\s*/.test(line)) {
        tabsHasLibrary = true;
      }
      if (/^\s*remotionStudio:\s*/.test(line) && !tabsHasLibrary) {
        insertions.push({ index: i + 1, text: `    library: "Library",` });
        tabsHasLibrary = true;
      }
      if (/^\s*\},?\s*$/.test(line)) {
        inTabsBlock = false;
      }
    } else if (inSubtitlesBlock) {
      if (/^\s*library:\s*/.test(line)) {
        subtitlesHasLibrary = true;
      }
      if (/^\s*remotionStudio:\s*/.test(line) && !subtitlesHasLibrary) {
        insertions.push({
          index: i + 1,
          text: `    library: "Browse AI-generated local resources across all sources.",`,
        });
        subtitlesHasLibrary = true;
      }
      if (/^\s*\},?\s*$/.test(line)) {
        inSubtitlesBlock = false;
      }
    }
  }
  if (insertions.length > 0) {
    // Apply from back to front to keep indices stable.
    insertions.sort((a, b) => b.index - a.index);
    for (const ins of insertions) {
      lines.splice(ins.index, 0, ins.text);
    }
    src = lines.join("\n");
    changed = true;
  }

  if (changed) {
    writeFileSync(p, src);
    console.log("synced", file);
  } else {
    console.log("skip (no change)", file);
  }
}

/**
 * Given an offset pointing at `  remotionAi: {`, find the offset *just
 * after* the closing `  },\n` of that block. Uses a simple brace-depth
 * counter that ignores braces inside strings.
 */
function findBlockEnd(src: string, start: number): number {
  let i = start;
  while (i < src.length && src[i] !== "{") {
    i += 1;
  }
  if (i >= src.length) {
    return -1;
  }
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        // Advance past `},\n` (or `}\n` if there's no comma).
        let j = i + 1;
        if (src[j] === ",") {
          j += 1;
        }
        if (src[j] === "\n") {
          j += 1;
        }
        return j;
      }
    }
  }
  return -1;
}
