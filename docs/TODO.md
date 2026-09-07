# TODO

Deferred work, newest first. Each entry cites its origin and the exact
location; remove entries as they land.

## Batch C — blind-audit hygiene round — DONE 2026-09-07 (post-v1.2.0)

All seven items landed in one hygiene commit; this section is kept for the
record until the next release, then this file can be pruned.

1. ~~Stale root-cause comment in CI~~ — `.github/workflows/build-test.yml`
   rewritten: cites the real `<queries>` root cause (c43fa84) and marks the
   old debuggable theory as wrong.
2. ~~Stale workflow description~~ — `.github/workflows/release.yml` header
   now describes build-test.yml correctly (signed release-variant rolling
   prerelease); the debug-APK release asset is kept and documented as a
   troubleshooting artifact.
3. ~~ADR out of sync~~ — `docs/architecture-decision.md` got a revision
   line: compileSdk 37 (Compose BOM requirement), targetSdk stays 36.
4. ~~mdtest section numbering~~ — `tools/mdtest/run.js` sections now run
   strictly 1..15.
5. ~~Silent bridge failure~~ — `findInPreview` treats a null
   `evaluateJavascript` result as failure: `Log.e` + `(0, -1)`, matching
   its doc comment.
6. ~~Deprecated String API~~ — `substr` → `substring` in
   `delimiters.ts`; `scanCloser` worst case documented as accepted.
7. ~~Saved-state Bundle ceiling~~ — closed as documented-only
   (`DocumentState.kt` comment); markdown notes are kilobytes, the ~1MB
   Binder ceiling stays an accepted, stated trade-off.

## Notes

- When item 1/2 landed, the disproven-theory commit messages (12f50e1,
  f988749) were deliberately left as history; c43fa84 remains the
  authoritative root cause.
