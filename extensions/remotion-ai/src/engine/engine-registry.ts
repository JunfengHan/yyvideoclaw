// extensions/remotion-ai/src/engine/engine-registry.ts
//
// Pick the agent engine to use for a given job. M1 ships only `codex`; M2
// adds claude-code / remote-worker by extending this switch (and the
// `EngineId` union in `../types.ts`).
//
// Keeping selection in a dedicated module means orchestrator.ts never
// branches on engine id directly — it asks the registry once and gets back
// a `RemotionAgentEngine` instance.

import type { EngineId } from "../types.js";
import { createCodexEngine, type CodexEngineDeps } from "./codex-engine.js";
import type { RemotionAgentEngine } from "./engine.js";

export interface EngineRegistryOptions {
  readonly codex?: CodexEngineDeps;
}

export class EngineRegistry {
  private readonly cache = new Map<EngineId, RemotionAgentEngine>();

  constructor(private readonly options: EngineRegistryOptions = {}) {}

  resolve(id: EngineId): RemotionAgentEngine {
    const cached = this.cache.get(id);
    if (cached) {
      return cached;
    }
    const engine = this.create(id);
    this.cache.set(id, engine);
    return engine;
  }

  /** Used by tests / shutdown to drop cached engine instances. */
  clear(): void {
    this.cache.clear();
  }

  private create(id: EngineId): RemotionAgentEngine {
    switch (id) {
      case "codex":
        return createCodexEngine(this.options.codex ?? {});
      default: {
        // Exhaustiveness guard for future EngineId additions.
        const _unused: never = id;
        void _unused;
        throw new Error(`unsupported engine id: ${id as string}`);
      }
    }
  }
}
