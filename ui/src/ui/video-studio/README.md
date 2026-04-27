# `ui/src/ui/video-studio/` — Video Studio front-end module

> Front-end companion to [`src/video-studio/`](../../../../src/video-studio/).
> This folder hosts **everything browser-side** that the Video Studio tab
> needs: the HTTP SDK (`client.ts`) talking to the embedded Pixelle FastAPI,
> shared UI types, and small helper components used only by the Video Studio
> view.
>
> The top-level Lit view itself lives next to the other tab views in
> [`ui/src/ui/views/video-studio-view.ts`](../views/) so the app-render dispatch
> table stays discoverable. **Do not** put the view here.

## Boundaries

- **This folder owns**:
  - `client.ts` — the only module allowed to make HTTP calls against the
    Pixelle backend. Every request reads `window.videoStudioEndpoint` and
    rejects any URL that is not loopback (loopback-only for defence in depth).
  - Small, Video-Studio-specific UI helpers (progress-stage formatter, aspect-
    ratio utilities, etc.) that have no use outside this tab.
- **This folder does NOT own**:
  - Sub-process / installer / preflight logic → `src/video-studio/` (main
    process / server side).
  - Navigation wiring (`TAB_GROUPS`, `iconForTab`, path routing) → kept in the
    existing `ui/src/ui/navigation.ts` to avoid splitting the routing source of
    truth.

## Error model

`client.ts` normalises transport errors into a small set of typed exceptions
(`BackendNotReadyError`, `InstallRequiredError`, `TaskFailedError`) so the view
can `switch` on them directly instead of re-parsing HTTP status codes.

## Testing

Vitest + MSW mocks the Pixelle FastAPI surface. Browser-level interactions on
the Lit view itself are covered in the `views/` folder.
