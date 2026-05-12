# Pinned copy — do not edit

The contents of this directory are vendored by
`scripts/vendor-remotion-skills.ts` at build time from:

```
https://github.com/remotion-dev/remotion  →  packages/skills
```

The pinned commit SHA is recorded in `.skills/VERSION` alongside the
vendor timestamp. To upgrade, run:

```
pnpm vendor:remotion-skills --ref <commit-sha-or-tag>
```

Do NOT commit unrelated edits under `.skills/` — the vendor check (run
as part of `pnpm check`) diffs the directory against the pinned tarball
and fails on drift.
