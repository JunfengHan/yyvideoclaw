// Remotion entry point for the remotion-ai workspace.
//
// This file is copied into every remotion-ai workspace by
// `extensions/remotion-ai/src/workspace.ts`. The AI agent authors the
// actual compositions inside `./Root` and any sibling component files.
//
// NOTE: relative imports intentionally OMIT file extensions — Remotion's
// webpack bundler resolves .tsx/.ts via its default extension list.
// yyvideoclaw's Node/ESM "always use .js" rule does NOT apply inside a
// Remotion project. See remotion-templates/starter-pack/src/index.ts for
// the same convention.

import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
