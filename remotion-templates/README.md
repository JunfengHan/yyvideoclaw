# yyvideoclaw Remotion templates

React-based programmatic video templates rendered by the `remotion` plugin
and surfaced in the Remotion Studio tab of the Control UI.

## Layout

```
remotion-templates/
├── README.md               ← you are here
└── starter-pack/
    ├── package.json        (optional — name + deps hint; actual resolution
    │                         uses the repo-root node_modules)
    ├── src/
    │   ├── index.ts        Remotion entry (registerRoot)
    │   ├── Root.tsx        <Composition> registry
    │   ├── TitleCard.tsx
    │   ├── Countdown.tsx
    │   ├── LowerThird.tsx
    │   └── SocialCard.tsx
    └── studio.json         UI metadata (label/description/inputPropsSchema)
```

Each directory under `remotion-templates/` that's listed in
`openclaw.json → plugins.entries.remotion.config.templateRoots` becomes a
template "project" with its own entry + compositions.

## Adding a new composition to the starter pack

1. Create `src/MyComposition.tsx` — a React component taking a typed props
   interface. Use `remotion` hooks (`useCurrentFrame`, `useVideoConfig`, `spring`,
   `interpolate`) for animation.

2. Register it in `src/Root.tsx`:

   ```tsx
   <Composition<typeof MyComposition, MyCompositionProps>
     id="MyComposition"
     component={MyComposition}
     durationInFrames={150}
     fps={30}
     width={1920}
     height={1080}
     defaultProps={
       {
         /* ... */
       }
     }
   />
   ```

3. Add a matching entry to `studio.json` so the UI renders a typed form:

   ```json
   "MyComposition": {
     "label": "My Composition",
     "description": "One-line summary shown in the UI.",
     "inputPropsSchema": {
       "type": "object",
       "required": ["foo"],
       "properties": {
         "foo": { "type": "string", "description": "...", "default": "..." }
       }
     }
   }
   ```

   Supported JSON-Schema subset:
   - top-level `type: "object"`
   - `properties` whose type is `string | number | integer | boolean`
   - `enum` arrays on string fields render as `<select>`
   - `default` used as the initial form value
   - `description` rendered as a hint
   - anything outside this subset → the UI falls back to a free-form JSON textarea

4. Refresh the Remotion Studio tab — the new composition shows up without a
   gateway restart (templates are re-listed on every status/poll tick).

## Creating a second template project

If you want a separate project (e.g. for a client's brand kit), create a new
directory at `remotion-templates/<your-project>/` with the same structure,
then add its absolute path to `templateRoots` in `openclaw.json`:

```json
"plugins": {
  "entries": {
    "remotion": {
      "enabled": true,
      "config": {
        "templateRoots": [
          "/abs/.../remotion-templates/starter-pack",
          "/abs/.../remotion-templates/<your-project>"
        ]
      }
    }
  }
}
```

## Dependencies

`remotion`, `react`, and `react-dom` are resolved from the repo-root
`node_modules` via standard webpack/Node module resolution — pnpm hoists
them there as part of the workspace install. You do **not** need to
`pnpm install` inside `remotion-templates/*`; the `package.json` is there
purely so editors / AI tools recognise each template project as a
self-contained unit.

## Related code

- `extensions/remotion/src/template-resolver.ts` — `templateRoots` allowlist
  - realpath enforcement.
- `extensions/remotion/src/studio-sidecar.ts` — reads `studio.json`.
- `extensions/remotion/src/server/routes.ts` — HTTP surface consumed by the
  UI.
- `ui/src/ui/views/remotion-studio-view.ts` — the tab itself.
