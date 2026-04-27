// Ephemeral internal Gateway tokens for the embedded Video Studio backend.
//
// Design goals (per requirements §4, §8):
//
//   1. Each Pixelle subprocess spawn gets its own bearer token scoped to
//      the child's lifetime (process-level secret), distinct from any
//      user-facing Gateway token.
//   2. The token is only ever handed to the child via env (see
//      `process-manager.ts#buildEnv`); it is never persisted to disk, never
//      rendered in the UI Tokens list, and never logged.
//   3. The token is accepted **only** for a hard-coded path allow-list
//      (`POST /v1/chat/completions`). Any other endpoint hit with this
//      token must be rejected with 403 so a compromised / misbehaving
//      Pixelle cannot escalate into other Gateway surfaces.
//   4. Tokens auto-revoke when the owning child exits; callers can also
//      revoke explicitly.
//
// This module is deliberately framework-agnostic: it exposes a small
// `GatewayAuthorizationCheck` interface so whichever server wiring pulls it
// in (see Gateway's `server-http.ts` + `openai-http.ts`) can call a single
// function without taking a dependency on any Video-Studio-specific type
// beyond what is strictly necessary.
//
// The actual Gateway middleware glue (adding a one-line `check()` call
// before the default bearer check) is tracked as a follow-up in the plan
// step 10; this file is the canonical source of truth for the allow-list
// semantics and is unit-tested accordingly.

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * The HTTP methods + pathnames this module considers safe for internal
 * tokens. Kept as an exported constant so the Gateway middleware can assert
 * parity against what it actually serves.
 */
export const INTERNAL_TOKEN_ALLOWED_ROUTES: ReadonlyArray<{
  readonly method: "POST";
  readonly path: "/v1/chat/completions";
}> = [{ method: "POST", path: "/v1/chat/completions" }];

export type InternalTokenMetadata = {
  readonly token: string;
  readonly ownerLabel: string;
  readonly issuedAt: Date;
};

export type IssueOptions = {
  /**
   * Human-readable label (e.g. "video-studio#4") for audit logs only. Never
   * rendered to the user.
   */
  readonly ownerLabel: string;
};

export type AuthorizationCheckInput = {
  readonly token: string;
  readonly method: string;
  readonly pathname: string;
};

export type AuthorizationCheckResult =
  | { readonly kind: "accept"; readonly metadata: InternalTokenMetadata }
  | { readonly kind: "reject"; readonly status: 403; readonly reason: string }
  | { readonly kind: "unknown" };

export type TokenGenerator = () => string;

export type AuditEvent = {
  readonly kind: "issued" | "revoked" | "rejected";
  readonly ownerLabel: string | null;
  readonly method?: string;
  readonly pathname?: string;
  readonly reason?: string;
};

export type AuditSink = (event: AuditEvent) => void;

export type RegistryDeps = {
  readonly generator?: TokenGenerator;
  readonly now?: () => Date;
  readonly audit?: AuditSink;
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function defaultGenerator(): string {
  // A 128-bit hex random is plenty for a loopback, in-memory token.
  // `crypto.randomUUID` is available on Node ≥14.17 and in all supported
  // Electron renderers.
  const globals = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  const uuid = globals.crypto?.randomUUID?.();
  return `proc-${uuid ?? Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function isAllowedRoute(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  for (const allowed of INTERNAL_TOKEN_ALLOWED_ROUTES) {
    if (allowed.method === normalizedMethod && allowed.path === pathname) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Registry.
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory store of active internal tokens.
 *
 * Note: this is a plain class (not a module singleton) so tests can spin up
 * a fresh registry per case and so the main process can choose to hold
 * exactly one instance behind its own DI container. The Gateway middleware
 * should consume it through `check()` only.
 */
export class InternalTokenRegistry {
  private readonly tokens = new Map<string, InternalTokenMetadata>();
  private readonly generator: TokenGenerator;
  private readonly audit: AuditSink;
  private readonly now: () => Date;

  constructor(deps: RegistryDeps = {}) {
    this.generator = deps.generator ?? defaultGenerator;
    this.audit = deps.audit ?? (() => {});
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Issue a new ephemeral token and register it. Returns the metadata so
   * the caller (supervisor) can hand the token to the child and the
   * `ownerLabel` back to diagnostics.
   */
  issue(opts: IssueOptions): InternalTokenMetadata {
    let token = this.generator();
    // Extremely unlikely, but defend against duplicate tokens across rapid
    // concurrent issuances rather than silently overwriting.
    while (this.tokens.has(token)) {
      token = this.generator();
    }
    const metadata: InternalTokenMetadata = {
      token,
      ownerLabel: opts.ownerLabel,
      issuedAt: this.now(),
    };
    this.tokens.set(token, metadata);
    this.audit({ kind: "issued", ownerLabel: opts.ownerLabel });
    return metadata;
  }

  /** Revoke a previously-issued token; no-op if it is no longer live. */
  revoke(token: string): void {
    const meta = this.tokens.get(token);
    if (!meta) return;
    this.tokens.delete(token);
    this.audit({ kind: "revoked", ownerLabel: meta.ownerLabel });
  }

  /**
   * Decide whether the token should authorize the incoming request.
   *
   *   - `accept`    → token is live **and** the route is on the allow-list.
   *   - `reject`    → token is live but the route is NOT on the allow-list.
   *                   Caller must respond with 403 and not fall back to
   *                   any other auth mechanism.
   *   - `unknown`   → token is not in this registry; the caller should
   *                   fall through to its usual bearer-token check.
   */
  check(input: AuthorizationCheckInput): AuthorizationCheckResult {
    const meta = this.tokens.get(input.token);
    if (!meta) {
      return { kind: "unknown" };
    }
    if (!isAllowedRoute(input.method, input.pathname)) {
      this.audit({
        kind: "rejected",
        ownerLabel: meta.ownerLabel,
        method: input.method,
        pathname: input.pathname,
        reason: "route not on internal-token allow-list",
      });
      return {
        kind: "reject",
        status: 403,
        reason: "Internal tokens may only access the OpenAI-compat chat completions endpoint.",
      };
    }
    return { kind: "accept", metadata: meta };
  }

  /** Snapshot for diagnostics; never surface to end users. */
  snapshot(): readonly InternalTokenMetadata[] {
    return Array.from(this.tokens.values());
  }

  /** Total number of live tokens — primarily for assertions in tests. */
  get size(): number {
    return this.tokens.size;
  }
}

/**
 * Convenience helper for the supervisor: issue and return just the string
 * plus a revoke callback. Keeps `process-manager.ts` free of registry
 * concerns while still wiring lifecycle correctly.
 */
export function bindInternalToken(
  registry: InternalTokenRegistry,
  ownerLabel: string,
): { readonly token: string; readonly revoke: () => void } {
  const metadata = registry.issue({ ownerLabel });
  return {
    token: metadata.token,
    revoke: () => registry.revoke(metadata.token),
  };
}
