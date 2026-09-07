# TODO

Deferred work, newest first. Each entry cites its origin and the exact
location; remove entries as they land.

## Batch C — blind-audit hygiene round (deferred 2026-09-07, owner's call)

From blind audit #2 (2026-09-07, subagent sa-0; all items owner-verified).
Batches A (correctness) and B (structure) shipped in e7d632e..45acfe3;
these LOW/hygiene items were postponed:

1. **Stale root-cause comment in CI** — `.github/workflows/build-test.yml`
   (~line 48) still claims "debuggable=true is the prime suspect" for the
   install failures. Real root cause (c43fa84): `<queries>` `<intent>`
   allows at most one data scheme (`INSTALL_PARSE_FAILED_MANIFEST_MALFORMED`).
   Keep the release-variant choice (production parity stands), rewrite the
   justification.
2. **Stale workflow description** — `.github/workflows/release.yml` header
   still describes build-test.yml as "debug APK artifact only, no signing,
   no publishing" (pre-2d22437/12f50e1 reality: signed release-variant
   rolling prerelease). Also decide whether official releases should keep
   shipping `app-debug.apk` (value questionable after the debug-APK
   install saga; either drop it or add a comment stating why it stays).
3. **ADR out of sync** — `docs/architecture-decision.md` (~line 21) still
   records compileSdk/targetSdk 36; `app/build.gradle.kts` is compileSdk
   37 (its comment cites the Compose BOM requirement). Add a revision line
   to the ADR.
4. **mdtest section numbering** — `tools/mdtest/run.js`: `4c` precedes
   `4`/`4b`, and two sections numbered `11.` (Search bridge, Page-width
   contract). Renumber sequentially or drop numbers for descriptive
   sections.
5. **Silent bridge failure** — `PreviewPane.kt findInPreview`: a JS-side
   exception makes `evaluateJavascript` deliver `result == null`, which
   currently parses as `{}` and reports `(0, 0)` with no log, contradicting
   the doc comment ("bridge failure reports (0, -1)"). Treat null as
   failure: `Log.e` + `onResult(0, -1)`.
6. **Deprecated String API** — `tools/preview-src/src/delimiters.ts`
   (~lines 97-118, 274): two `String.prototype.substr` uses → `substring`.
   The same file's `scanCloser` is O(n×m) worst-case (dense unmatched `$`);
   real docs escape `$` per the strict rule, so accept + comment, or build
   a closer-candidate index first.
7. **Saved-state Bundle ceiling** — `text` + `DocumentState.savedText` put
   up to ~2x the document into the ~1MB saved-state Binder transaction
   (TransactionTooLargeException past it, crashing on backgrounding).
   Currently documented-only (DocumentState.kt comment). Decide: guard
   (temp-file persistence past a threshold) or accept for a markdown-notes
   app.

## Notes

- When item 1/2 lands, also re-read the commit messages of 12f50e1 and
  f988749: both encode disproven install-failure theories (kept for
  history; c43fa84 is the authoritative root cause).
