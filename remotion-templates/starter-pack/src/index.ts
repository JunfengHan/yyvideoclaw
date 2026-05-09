// Remotion entry point for the starter-pack templates.
//
// Resolved by the OpenClaw Remotion plugin via `templateRoots` + the
// `<root>/src/index.ts` convention (see extensions/remotion/src/
// template-resolver.ts).
//
// NOTE: relative imports intentionally OMIT file extensions. The Remotion
// bundler (webpack) resolves .tsx/.ts via its default extension list.
// yyvideoclaw's Node/ESM rule of "always use .js" does NOT apply inside a
// Remotion project — we follow the Remotion convention here.

import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
