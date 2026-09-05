# MathMD — Architecture Decision Record (2026-09-05, ROUTE LOCKED)

## Decided
- **Route: A′ — native Kotlin editor (Jetpack Compose) + offline WebView KaTeX preview.**
  Owner confirmed 2026-09-05 ("按照你的倾向A"). MIT license target.
- **Product: editor + preview in one app from v1.**
- **Build env: sandbox CLI SDK (installed & verified). Device testing on owner's phone.**
- **Toolchain (all verified against official sources 2026-09-05):**
  - minSdk **29** (Android 10) — DERIVED, not chosen arbitrarily:
      * Security floor: Chrome/WebView 139 (2025-08) requires Android 10+; below API 29
        the system WebView is frozen at Chrome 138 with no further security patches —
        unacceptable for rendering untrusted markdown (Google support thread, Chrome
        sunset announcement).
      * Maintenance: below 29 is Android 8/9 (EOL), ~2-3% active share in 2026
        (Statcounter / Play Console data, Mar 2026); zero legacy branches at 29
        (SAF-only, updatable WebView, no version forks).
      * Features that need >29 (photo picker 33+, predictive-back animations 34+,
        per-app language 33+) are implemented as capability checks with graceful
        fallbacks — they do NOT raise the floor.
      * Owner's ">=14 acceptable" is headroom, not the requirement.
  - compileSdk / targetSdk **36** (Android 16, API level verified via
    developer.android.com Play target-SDK policy: mandatory ≥36 since 2026-08-31)
  - AGP **9.3.2** (current stable line 9.3, July 2026; 9.4.0 released ~2026-09-01, too fresh)
  - Gradle wrapper **9.7.1** (AGP 9.0 compatibility table: requires Gradle ≥ 9.1.0)
  - **JDK 17** — AGP 9.0 table lists min AND default JDK 17; sandbox JDK 17.0.20 already fits
  - Kotlin: **AGP 9 built-in Kotlin** (no org.jetbrains.kotlin.android plugin; KGP 2.2.x bundled)
  - SDK Build Tools **36.0.0** (AGP 9 default; installed), platforms;android-36 (installed)
  - Jetpack Compose BOM **2026.08.00** (material3 1.4.0), Material 3, single-Activity
  - Predictive back: platform-level on API 34+; enable `android:enableOnBackInvokedCallback`,
    Compose `BackHandler`/predictive patterns; no compat shims needed at minSdk 34.
- App still renders as: Compose editor screen + preview screen (WebView) + file layer
  (SAF + recents, final model pending owner's detailed requirements).

## Fixed by owner (LCK) earlier same day
- Editor+preview from v1; sandbox CLI SDK approved (~1 GB envelope; SDK now 728 MB used).

## Measured facts feeding the decision

- KaTeX offline bundle (js+css+fonts, md-preview's vendored set): 640 KB.
- Markwon AARs (core+ext-latex+editor, 4.6.2): 133+39+53 KB ≈ 225 KB.
- jlatexmath-android 0.2.0 AAR: 650 KB (fonts included; GPL-2.0+).
  ⇒ Engine size is a non-factor (<1 MB either way).
- markdown-it-texmath 1.0.0 (tested in sandbox with node + katex 0.18.5):
  `delimiters:'dollars'` → `$`,`$$` OK; `\(`,`\[` DESTROYED (backslashes eaten by
  markdown-it core first). `delimiters:'brackets'` → `\(` OK; `\[ \]` NOT recognized;
  `$`/`$$` not recognized. No single config covers all four.
  ⇒ Same bug class as md-preview (parser eats backslashes before math pass): the
  pre-parse math protection layer must be self-written regardless of stack.
- marked/markdown-it/commonmark-java all share this behavior (verified marked + texmath
  empirically; commonmark-java by spec: backslash escapes are core syntax).

## Options

### A. Full native: Kotlin + Markwon core + self-written math extension + jlatexmath
- License: GPL-2.0-or-later (forced by jlatexmath).
- Pros: true native editor UX (cursor/selection/IME correctness), math rendered as native
  drawables inside the TextView (Markwon), no WebView, no JS.
- Cons/risks: Markwon inactive upstream (frozen artifacts are stable but no fixes);
  ext-latex must be bypassed — we write our own block parser factories + inline processors
  for $, $$, \(, \[ with math-first priority (parser-level protection); rendering engine
  jlatexmath has wider variability vs KaTeX on exotic packages (mhchem etc.).
- Editor component: Markwon editor module exists (53 KB AAR) — syntax highlighting must
  be custom.
- Effort: highest of the three. Testing: parser layer = pure JVM (commonmark-java) ✓.

### A′. Native Kotlin app (editor) + WebView(KaTeX) preview — RECOMMENDED
- License: MIT-able (KaTeX MIT; everything else self-written).
- Architecture: standard Android editor (Kotlin, Compose or Views; single-Activity),
  markdown source editor with math-span awareness; preview = offline WebView loading
  vendored katex + self-written render.js implementing: (1) pre-parse math protection
  (extract all four delimiter styles BEFORE markdown-it, proven strategy from md-preview
  desktop 240c6e7), (2) math-itex placeholder re-scan, (3) katex.render, all offline.
  Vendor set ~640 KB + markdown-it ~100 KB.
- Pros: rendering quality = KaTeX (the standard for math on the web, mhchem included);
  render logic is pure JS = fully testable in sandbox node (no device needed) — the exact
  test harness used for the texmath experiment above; editor is where native code shines,
  preview is where WebView shines. Delimiter correctness is OUR code, not a dependency.
- Cons: preview is HTML in WebView (font/zoom linkage to system settings needs care);
  two rendering worlds (editor highlight vs preview) must be kept visually consistent.
- Effort: medium. Risk: low (every piece proven: KaTeX offline in md-preview, protection
  strategy in md-preview desktop, test harness already running in sandbox).

### B. WebView-first hybrid (md-preview-mobile-like shell + editor added)
- Essentially A′ but editor also lives inside WebView (contenteditable / CodeMirror in
  WebView). MIT-able.
- Pros: least native code; CodeMirror 6 gives mature editing UX incl. math overlays.
- Cons: Android IME + WebView + JS editor = the classic input-lag/keyboard-bug minefield;
  file/SAF integration needs JS bridges; offline asset plumbing more complex.
- Effort: medium-low code, high debugging-against-IME risk.

### C. Fork md-preview mobile branch, port 240c6e7
- Rejected direction (owner wants editor+preview from v1; upstream mobile is viewer-only,
  zero tests, branch inactive since 2026-05). Kept for the record only.

## Open items for owner decision
1. Confirm A′ (native Kotlin editor + offline KaTeX WebView preview, MIT).
2. UI framework inside A′: Jetpack Compose (modern, default) vs classic Views (Markwon
   editor module is Views-based — only matters if A is chosen).
3. App identity: name/package/applicationId (e.g. `mathmd` / `io.github.lckhot.mathmd`?).
4. Minimum supported Android version (suggestion: API 26 / Android 8.0, covers ~97% devices,
   keeps WebView modern via updatable WebView).
5. File model: SAF document picker + recent files (md-preview-style) vs in-app folder/library.
