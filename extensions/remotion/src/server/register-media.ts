// Media library registration for Remotion render artifacts.
//
// After every successful render the plugin makes a copy of the produced file
// into the standard OpenClaw outbound media directory (~/.openclaw/media/
// outbound/<uuid>.<ext>). This is the same path used by channel runtimes
// when sending attachments, so the file becomes immediately reusable as an
// outbound asset for any downstream channel/plugin.
//
// Two important non-features:
//
//   1. We do NOT delete the original artifact in the plugin's outputDir.
//      That copy is the durable "source of truth" for the Remotion Studio
//      preview pane (it stays under our jobId/ subdir and is range-served
//      directly). The media-library copy may be GC'd by other media flows.
//
//   2. We do NOT register failed / partial renders. If the producer never
//      reached `done`, calling this function would mostly succeed but leak
//      junk into the operator's media library — explicit no-op on error
//      paths is safer.

import { promises as fs } from "node:fs";
import path from "node:path";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";

export interface RegisterArtifactInput {
  /** Absolute path of the produced artifact (already verified by output-manager). */
  outputPath: string;
  /** Configured maxOutputBytes — we forward this so the size guard stays consistent. */
  maxBytes: number;
}

export interface RegisterArtifactOk {
  ok: true;
  /** Absolute path inside ~/.openclaw/media/outbound/. */
  mediaLibraryPath: string;
  /** Detected/forwarded MIME type. */
  contentType?: string;
}

export interface RegisterArtifactSkipped {
  ok: false;
  /**
   * Reason the artifact was NOT registered. Always non-fatal — the caller
   * should still treat the render as successful and just record the reason
   * on the JobSnapshot.
   */
  reason: string;
}

export type RegisterArtifactResult = RegisterArtifactOk | RegisterArtifactSkipped;

/**
 * Detect MIME from output file extension. Keeps register-media free of any
 * runtime sniffing — we already produced the file ourselves and trust the
 * extension we wrote. (saveMediaBuffer also sniffs, but we hand it a hint
 * so the canonical filename ends in the right extension.)
 */
function inferContentType(outputPath: string): string | undefined {
  const ext = path.extname(outputPath).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return undefined;
  }
}

/**
 * Read the produced artifact and write a copy into the OpenClaw media library.
 *
 * Returns a structured result instead of throwing. Registration is a
 * best-effort enhancement — a render that produced bytes on disk is "done"
 * even if media-library copy fails (disk full, permission, oversize, etc.).
 */
export async function registerArtifactToMediaLibrary(
  input: RegisterArtifactInput,
): Promise<RegisterArtifactResult> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(input.outputPath);
  } catch (err) {
    return {
      ok: false,
      reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (buffer.byteLength === 0) {
    return { ok: false, reason: "artifact is empty" };
  }
  const fileName = path.basename(input.outputPath);
  const contentType = inferContentType(input.outputPath);
  try {
    const saved = await saveMediaBuffer(
      buffer,
      contentType,
      // Subdir = "outbound" → matches the channel-runtime convention so any
      // downstream message-send flow finds it without special-casing.
      "outbound",
      input.maxBytes,
      fileName,
    );
    return {
      ok: true,
      mediaLibraryPath: saved.path,
      ...(saved.contentType ? { contentType: saved.contentType } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `saveMediaBuffer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
