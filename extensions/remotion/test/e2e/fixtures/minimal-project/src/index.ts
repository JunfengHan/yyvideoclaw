// Remotion entry point. Registered via `registerRoot` so that the bundler
// can discover the available <Composition>s.
//
// NOTE: relative imports intentionally OMIT file extensions. The Remotion
// bundler (webpack) resolves .tsx/.ts via its default extension list. The
// rest of the OpenClaw repo uses the `.js` suffix convention for Node/ESM,
// but inside a Remotion project we follow the Remotion convention.

import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
