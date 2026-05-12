// extensions/remotion-ai/src/validator/error-digest.ts
//
// Convert a structured `AiRenderWorkerMessage` (validation failure) into a
// short Markdown digest that can be fed back into the agent as the next
// user turn. The digest must:
//
//   - identify the failing stage (bundle / selectComposition / render still),
//   - point at the offending file with a workspace-RELATIVE path,
//   - quote the FIRST 2 KiB of the worker's error preview,
//   - never embed the full stack or absolute paths from the host machine.
//
// The shape is intentionally stable: the agent learns the format on the
// first retry and can rely on it for the second / third.

import path from "node:path";
import type { AiRenderWorkerMessage, ValidationStage } from "./types.js";

const STAGE_LABELS: Record<ValidationStage, string> = {
  bundle: "Bundle",
  select_composition: "selectComposition",
  render_still: "renderStill",
};

const PATH_QUOTE_RE = /["'`](\/[^"'`\s]+)["'`]|(?:[\s(\\])(\/[^\s)\\]+\.tsx?)/g;

export interface BuildDigestOptions {
  readonly workspaceDir: string;
  readonly attemptIndex: number;
  readonly retryMax: number;
}

/**
 * Build a Markdown digest. The caller is responsible for sending the result
 * to the agent as the next user turn.
 *
 * @param failure Worker message; must be `validation-failure`.
 * @param opts   Workspace + retry context (used only to render the header).
 */
export function buildErrorDigest(
  failure: Extract<AiRenderWorkerMessage, { kind: "validation-failure" }>,
  opts: BuildDigestOptions,
): string {
  const stageLabel = STAGE_LABELS[failure.stage];
  const remaining = Math.max(0, opts.retryMax - opts.attemptIndex);
  const header = `Validation failed at **${stageLabel}** (attempt ${opts.attemptIndex + 1} of ${opts.retryMax + 1}, ${remaining} retr${remaining === 1 ? "y" : "ies"} remaining).`;

  const messageLine = `**${failure.errorName}**: ${failure.errorMessage}`;
  const sanitizedPreview = sanitizeAbsolutePaths(failure.errorPreview, opts.workspaceDir);

  const lines = [
    header,
    "",
    messageLine,
    "",
    "```",
    sanitizedPreview,
    "```",
    "",
    "Please fix the project and keep the workspace contract:",
    "- `src/index.ts` must call `registerRoot(Root)`.",
    "- `src/Root.tsx` must export a React component named `Root` returning at least one `<Composition>`.",
    "- Every `<Composition>` needs `id`, `component`, `durationInFrames`, `fps`, `width`, `height`.",
  ];

  return lines.join("\n");
}

/**
 * Replace every absolute path that begins with `workspaceDir` with the
 * matching workspace-relative path. Anything else (host paths leaking from
 * `node_modules`, OS temp dirs, etc.) is replaced with a placeholder so the
 * digest stays portable across machines.
 */
export function sanitizeAbsolutePaths(text: string, workspaceDir: string): string {
  const wsWithSep = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep;
  // Step 1: replace workspace-prefixed absolute paths with relative ones.
  let result = text.split(wsWithSep).join("");
  // Step 2: replace any remaining absolute path inside quotes / backticks
  // with a placeholder. This is a best-effort scrub — we don't try to fully
  // parse stack traces.
  result = result.replace(PATH_QUOTE_RE, (_match, quoted, bare) => {
    const candidate = quoted ?? bare;
    if (typeof candidate !== "string") {
      return _match;
    }
    if (candidate.startsWith(wsWithSep) || candidate === workspaceDir) {
      return _match;
    }
    return _match.replace(candidate, "<host>");
  });
  return result;
}
