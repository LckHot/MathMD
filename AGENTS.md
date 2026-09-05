# AGENTS.md — MathMD

Guidance for coding agents (and human contributors) working in this repo.

## What this is

An Android markdown reader with light editing for mathematicians. Kotlin +
Jetpack Compose app; math/markdown rendering happens in a sandboxed WebView
running a small TypeScript pipeline over vendored KaTeX + markdown-it.

## Non-negotiable invariants

1. **Math protection happens BEFORE markdown parsing.** Never feed raw
   markdown into a markdown parser and post-scan the DOM for math — that is
   the exact bug class this project exists to avoid (see docs/research-notes.md).
2. **All four delimiters** `$...$`, `$$...$$`, `\(...\)`, `\[...\]` must keep
   working. Run `node tools/mdtest/run.js` after any change to
   `tools/preview-src/` — the suite must stay at 100%.
3. **Vendored artifacts are never edited in place**
   (`app/src/main/assets/preview/markdown-it.umd.min.js`,
   `.../katex/`). Upgrade by replacing the whole artifact and recording the
   version bump.
4. **Offline**: the preview WebView must not load network content
   (`blockNetworkLoads = true`). Don't add internet-dependent features without
   an explicit discussion.

## Layout

- `app/src/main/java/io/github/lckhot/mathmd/` — app code (one concept per file)
- `app/src/main/assets/preview/` — WebView page + vendored JS/CSS + generated bundle
- `tools/preview-src/` — TypeScript source of the preview bundle (`bundle.js` is
  generated via `scripts/build-preview.sh` and committed)
- `tools/mdtest/run.js` — node vm-based regression harness (emulates WebView
  globals; the exact vendored artifacts are loaded)

## Commands

```sh
./scripts/build-preview.sh     # rebuild bundle.js from TS + typecheck
node tools/mdtest/run.js       # preview regression suite
gradle :app:assembleDebug      # build APK
```

## Conventions

- Self-written code: Kotlin (Android) / TypeScript (preview). No Java, no plain JS.
- Keep the app minimal: it is a reader first. New editing chrome needs a good
  reason.
- Don't add third-party dependencies for things the platform or the vendored
  stack already does.
- Git: one logical change per commit; never commit `docs/MEMORY.md` or other
  local agent-memory files (they are gitignored on purpose).

## Testing policy

The preview pipeline is covered by node tests (run them). UI behavior is
verified on-device by the maintainer; describe how to reproduce any behavioral
change in the commit message.
