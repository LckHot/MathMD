# MathMD Code Quality Review — 2026-09-09

- **Scope**: full source review at HEAD `920f495` — all Kotlin (`app/src/main/java/`, 9 files),
  TypeScript pipeline (`tools/preview-src/src/`, 3 files), test harness (`tools/mdtest/run.js`),
  CI workflows, manifest, gradle config, preview HTML/CSS, scripts, README/AGENTS/docs.
- **Method**: line-by-line read of every self-written file, plus live execution probes: the
  mdtest suite was run at HEAD, and suspicious scanner/restore behaviors were reproduced
  through the real (esbuild-bundled, vendored markdown-it + KaTeX) pipeline in a node vm
  harness, not judged by inspection alone.
- **Context**: this is the third review round. Blind audit #1 (pre-v1.2.0) and blind audit #2
  (sa-0) landed as Batches A/B/C; their findings are **not repeated here**. Everything below
  was verified against the current tree.

**Baseline check at review time**: `node tools/mdtest/run.js` → **42/42 pass**; `git status`
clean; bundle.js in sync (CI guard would catch drift anyway).

---

## Summary

The codebase is in good shape for its size and purpose. The three things that make this
project hard — math-protection-before-parse, the WebView↔Compose bridge, and the
process-death/lifecycle matrix — are handled correctly and, more importantly, *documented at
the point of risk* (the drift-guard tests #14/#15 and the change-gate comments are exactly
where a future maintainer would break things). The WebView sandboxing posture
(`blockNetworkLoads`, `allowFileAccess=false`, `html:false` in markdown-it, `trust:false` in
KaTeX, random placeholder salt) is coherent and verified by tests.

What remains are: **one correctness bug in the guard/save flow** (R1), **one verified
rendering-fidelity bug in code-block restore** (R2), a small set of consistency/hardening
items, and a few deliberate-trade-off opportunities (R8 minification, Kotlin-side tests).

| # | Severity | Area | One-line |
|---|----------|------|----------|
| R1 | **High** | MainActivity.kt | Stale `pendingActionAfterSave` / `openInNewWindow` leak when a picker is cancelled → spurious action fires later |
| R2 | **Medium** | render.ts / delimiters.ts | Fenced-code interior indentation is stripped (verified live) — Python-style code mangled |
| R3 | Medium | build.gradle.kts | Release APK unminified (~24 MB); R8 + resource shrinking unexplored |
| R4 | Medium | app module | Zero JVM-side tests for pure Kotlin logic (no `app/src/test` exists) |
| R5 | Medium (owner call) | AndroidManifest.xml | VIEW intent-filter lacks `application/octet-stream` while the Open picker accepts it |
| R6 | Low | EditorPane.kt | `state.text.toString()` recomputed on every recomposition (O(n) copy on unrelated frames) |
| R7 | Low | PreviewPane.kt | `cssFontFamily` quotes custom names without escaping; safe today only because the UI list is closed |
| R8 | Low | release.yml | Always-true `if:` on the tag-check step (harmless leftover) |
| R9 | Low | release-notes.md | Trailing APK-asset bullets dangle without a section header |
| R10 | Low | docs/TODO.md | Batch C section pending prune (per its own policy: at next release) |

---

## Findings

### R1 (High) — Guard-follow-up flags leak when the file picker is cancelled

**Where**: `MainActivity.kt` — `openLauncher` (lines 170–196), `createLauncher` (218–234),
`pendingActionAfterSave` (137), `openInNewWindow` (136).

Both flags are set *before* a launcher is started and consumed *after* it succeeds — but the
`uri == null` (user cancelled) branch of neither callback resets them:

```kotlin
val createLauncher = rememberLauncherForActivityResult(
    ActivityResultContracts.CreateDocument("text/markdown"),
) { uri ->
    if (uri != null) { ... }   // cancel path: pendingActionAfterSave stays set forever
}
```

**Deterministic repro** (walked through the code; no data loss, but guaranteed-wrong UI):

1. Untitled + dirty buffer → menu → Open → guard dialog → **"Save and open…"**
   → `saveThen(Open)` sets `pendingActionAfterSave = Open`, launches the Save-As picker.
2. User **cancels** the picker → callback does nothing; the flag survives.
3. At any later point in this window, a plain **Save** / **Save as…** that succeeds reads
   `followUp = pendingActionAfterSave` (= stale `Open`) and fires `afterGuardAction(Open)`
   → **the Open file-picker pops up uninvited** right after an ordinary save.

Same class for `openInNewWindow`: guard → "Keep this, open in new window…" → cancel the Open
picker → the flag stays `true`, so the *next* ordinary Open (even from a clean buffer) is
hijacked into "open in new window" instead of loading in place.

**Fix** (two one-liners, consume-on-cancel):

```kotlin
// createLauncher callback, first line:
if (uri == null) { pendingActionAfterSave = null; return@rememberLauncherForActivityResult }
// openLauncher callback, first line:
if (uri == null) { openInNewWindow = false; return@rememberLauncherForActivityResult }
```

Optionally add a code comment stating the invariant: *a follow-up flag set before a launcher
must be cleared on every terminal path of that launcher (cancel included).*

---

### R2 (Medium, verified live) — Fenced-code interior indentation is destroyed

**Where**: `tools/preview-src/src/render.ts` lines 92–109 (code restore) vs
`tools/preview-src/src/delimiters.ts` (`tryFence` / `tryIndented`).

The restore pass classifies a `CodeSegment` by sniffing its `raw` (`/^ {4}|^\t/`), because
`CodeSegment` carries no discriminator between a fence interior and an indented block. A
fence whose interior lines are 4-space-indented — i.e. how humans indent code inside fences,
and syntactically *meaningful* in Python — matches the indented-block sniff, and
`/^ {4}/gm` strips the indent from every interior line.

**Reproduced at HEAD** through the real pipeline (bundled TS + vendored markdown-it/KaTeX in
the node vm harness):

```
input fence:      ```            →  rendered <pre><code>: "line one keeps indent?\nline two also\n\n"
                      line one keeps indent?
                      line two also        (leading 4 spaces GONE on both lines)
                  ```
scanner raw was correct:  "    line one keeps indent?\n    line two also\n"
tab-indented interior: same stripping ("line one tab" — \t removed)
```

`protectMath` extracts the fence interior correctly; only the restore heuristic is wrong.
Inline spans are unaffected (they start with a backtick and take the `<code>` branch first);
plain unindented fences pass through the `isIndented == false` path untouched — which is why
the existing tests (which only pin `<code><code>` non-nesting and the *genuine* indented
case) never caught it.

**Fix**: make the construct kind explicit instead of sniffed —

```ts
// delimiters.ts
export interface CodeSegment {
  readonly token: string;
  readonly kind: 'code';
  readonly construct: 'fence' | 'indented' | 'span';   // NEW
  readonly raw: string;
}
// tryFence → 'fence', tryIndented → 'indented', tryCodeSpan → 'span'
```

```ts
// render.ts restore: dispatch on seg.construct
//   'span'   → current backtick branch (<code> wrap)
//   'fence'  → esc(seg.raw) verbatim (indent preserved!)
//   'indented' → current strip-marker branch
```

This also deletes the fragile `raw.startsWith('`')` sniff. Suggested mdtest additions
(add first — they fail on the current code, then land with the fix):

- fence with 4-space-indented interior → rendered `<pre><code>` preserves the indent;
- fence with tab-indented interior → tab preserved;
- genuine indented block still strips its marker (existing behavior pinned).

Note this is a `CodeSegment` shape change; `render.ts`'s re-export and the mdtest `protectMath`
unit test (#10) are the only other touch points.

---

### R3 (Medium) — Release build ships unminified (~24 MB)

`app/build.gradle.kts`: `isMinifyEnabled = false`; no `isShrinkResources`. The release APK
has been ~23.6 MB since v1.0.1 for an app whose own code is ~2.2k lines — the bulk is
unshrunk Compose/material3 dex.

Enabling R8 (`isMinifyEnabled = true` + `isShrinkResources = true`, keeping
`proguard-android-optimize.txt`) typically cuts a Compose app to roughly half or less. The
two keep-rule surfaces to verify in this app:

- `@JavascriptInterface` methods (`PreviewBridge`) — the SDK's default rules keep these;
  verify with the built APK that `getPageWidthChars`/`getPreviewFontFamily` still resolve
  (the boot script fails soft to fill-mode if they vanish — a silent regression, so test
  with a non-zero line width).
- `DocumentState` / `GuardAction` reaching `rememberSaveable` via `java.io.Serializable` /
  Parcelable — enum + Uri+String are platform types; low risk, but the process-restore
  matrix from blind audit #2 is the regression suite to re-walk.

This is a tooling/behavior trade-off for the owner to decide; if enabled, it should ride a
test-build (`build-test.yml`) and get an on-device open/save/search pass before the next tag.

---

### R4 (Medium) — No JVM-side tests for pure Kotlin logic

`app/src/` contains only `main/`. The preview pipeline is excellently covered (42 tests,
including two cross-language drift guards), but the Kotlin side has zero tests even for
pure, dependency-free functions that encode user-facing contracts:

- `matchRanges` (EditorPane.kt) — the editor side of the shared search contract
  (non-overlapping, case-insensitive; mirrored in `host.ts find()`);
- `cssFontFamily` (PreviewPane.kt) — half of the ch-measurement drift guard (the other half
  *is* pinned by mdtest #14);
- `isDarkTheme` (MainActivity.kt); `Settings` clamping conventions;
- `extractViewUri`.

`matchRanges` in particular is the kind of function whose subtle semantics (non-overlapping
advance by `i + q.length`, lowercase folding) can silently diverge from the TS side — exactly
the drift class the project already guards against elsewhere. A minimal `app/src/test`
source set with JUnit on these five costs little and closes the biggest remaining coverage
gap. (Owner call on adding the dependency; noting the gap is this review's job.)

---

### R5 (Medium, consistency — owner call) — VIEW intake vs Open picker MIME mismatch

`OPEN_MIMES` (MainActivity.kt) offers `application/octet-stream`, but the manifest
ACTION_VIEW filter accepts only `text/markdown`, `text/x-markdown`, `text/plain`. A `.md`
file that its source app/FileManager labels `application/octet-stream` (common for
attachments and some chat apps) can be opened via the in-app picker but will not be offered
"open with MathMD" from other apps. Adding the mime to the intent-filter widens VIEW
eligibility to *all* unknown-type files (they still load as text or fail with a toast). If
the asymmetry is deliberate, a one-line comment on `OPEN_MIMES` prevents future confusion.

---

### R6 (Low) — EditorPane recomputes `state.text.toString()` every recomposition

`EditorPane.kt` line 85: `val currentText = state.text.toString()` runs on *every*
recomposition of the pane (search-tick bumps, mode flips, menu opens), each an O(n) buffer
copy, while the memoized `matchRanges` it feeds only needs the value when text actually
changed. At current document sizes this is sub-millisecond; flagging it only because the
same file already fixed the identical pattern for the lowercase copy (commit 45acfe3). The
clean shape: cache the string in a `mutableStateOf` updated from the existing
`snapshotFlow` collector, and key `remember` on that.

---

### R7 (Low, hardening) — `cssFontFamily` interpolates names into CSS unescaped

`PreviewPane.kt` line 174: `else -> "'$name', sans-serif"` — a name containing `'` or `;`
would break out of the CSS string (and the value is also injected into the boot-script probe
`cssText` in preview.html). Safe today only because `SettingsDialog` offers a closed list.
Making it safe *by construction* is one line — validate against `FONT_FAMILIES` (or a
character whitelist) inside `cssFontFamily` and fall back to `null` otherwise — which turns
a UI-level invariant into a data-level one, in the spirit of the project's other drift
guards.

---

### R8–R10 (Low, hygiene)

- **R8** `release.yml`: the "Tag matches versionName" step's `if: startsWith(github.ref,
  'refs/tags/')` is always true (the workflow only fires on `v*` tags). Harmless leftover
  from when the steps were shared with build-test.yml; can be dropped with the step kept.
- **R9** `release-notes.md`: the trailing `**app-release.apk**` / `**app-debug.apk**` bullets
  and "Install:" paragraph sit after the changelog with no section header. Cosmetic; fix at
  the next release-notes rewrite.
- **R10** `docs/TODO.md`: the Batch C section is kept "until the next release, then pruned"
  per its own policy — that trigger fires at the next tag. No action needed before then.

---

## Checked and found sound (verified non-issues)

Recorded so future review rounds don't re-flag them:

- **Search double-report race**: both panes hold a `SearchSpec` with the same `onResult`,
  but only the visible pane ever reports (PreviewPane gates `find` on `visible`; EditorPane
  leaves composition in Preview mode). The mode-flip tick bump routes correctly.
- **`allowFileAccess = false` + `loadUrl(file:///android_asset/…)`**: not a conflict —
  `android_asset`/`android_res` URLs are exempt from that setting per the WebView docs;
  the setting blocks the *page* from touching the filesystem, which is the intent.
- **KaTeX fonts: only `.woff2` shipped** (300 KB). `katex.min.css` also names `.woff`/`.ttf`
  URLs, but Chromium always selects woff2 when present and never fetches the others. Fine
  for the WebView; only relevant if the page ever moves to a non-Chromium engine.
- **Per-render `markdownit()` instantiation** in `render.ts`: stateless per call, and the
  PreviewPane change-gate means renders happen once per visible edit/flip, not per
  keystroke. Not worth caching.
- **Fence closing semantics** in `tryFence` (same char, `≥` opener length, no info string,
  0–3 space indent) match CommonMark; `\\`` escape handling and strict-`$` pairing are
  test-pinned (mdtest 1–7).
- **`findInPreview`'s manual JSON unescape** is only ever applied to a
  numbers-only payload (`{"total":N,"active":N}`), so its simpleness is safe today; if
  `FindResult` ever gains string fields, switch to a real JSON parse of the outer result.
- **Process-restore guard** (`restoredViewHandled` + `processRestored`): rotation and
  process-death paths both skip the same-uri reload; a genuinely different uri still loads.
  Matches the audit-#2 fix intent.
- **CI**: bundle-sync (`git diff --exit-code`), tag↔versionName guard, and the rolling
  `test-build` tag dance are all correct as written; workflow action versions have three
  green release runs behind them (v1.0.1 → v1.2.0), so they are not second-guessed here.

---

## Opportunities (not defects)

1. **R8 minification** (see R3) — largest single user-visible improvement available
   (download size).
2. **Kotlin unit-test source set** (see R4) — closes the only untested contract surface.
3. **MainActivity composition-root split** — at 541 lines it is still the one big file
   (menu + guard flow + search state + settings plumbing). The IO/dialog extraction (B3)
   took the real complexity out; what remains is genuinely wiring. A `MathMdTopBar`
   composable + a `SearchState` holder would get it under ~350 lines, but the payoff is
   mostly navigational; fine to defer.
4. **`Scanner` performance headroom** — `scanCloser`'s O(n·openers) worst case is already
   documented as accepted; no action unless a pathological document ever shows a stall.

## Suggested order

1. R1 (two one-liners; user-visible correctness).
2. R2 (small, test-pinned fix; add the two failing mdtest cases first).
3. R4 / R5 / R7 in any order (independent, all small).
4. R3 (R8/minify) as its own verified test-build cycle, owner's call.
5. R8–R10 folded into the next hygiene pass or release prep.

*Everything above was verified against `920f495` on 2026-09-09; line numbers refer to that
tree.*
