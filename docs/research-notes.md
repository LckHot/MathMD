# MathMD — Research Notes (2026-09-05)

Goal: Android, open-source markdown editor/viewer for mathematicians.
Hard requirement: render TeX/LaTeX math in ALL FOUR delimiter styles:
`$...$`, `$$...$$`, `\(...\)`, `\[...\]` (OOTB or via config).

## Verdict on vorojar/md-preview Android: CONFIRMED BROKEN (root cause found)

Evidence (verified against `origin/master` @ 46fef8f and `origin/codex/mobile-release` @ 2026-05-30):

1. The mobile branch JS *does* implement all 4 delimiters:
   `assets/enhance/preview-enhance.js` `nextDelimiter()` handles `$$`, `\[`, `\(`, single `$`.
2. But the pipeline runs marked (CommonMark) BEFORE the math rescan. Node test using the
   repo's own `mobile/shared/vendor/marked.umd.js`:
   - `\( x+1 \)`        => `<p>( x+1 )</p>`          (backslashes eaten → `\[`/`\(` branches are dead code)
   - `\[ E=mc^2 \]`     => `<p>[ E=mc^2 ]</p>`
   - `$\{x\}$`          => `<p>${x}$</p>`            (escaped braces destroyed)
   - `$$\bar{\mu}_{n}$$` => survives (only style that survives intact)
   ⇒ Real math documents (e.g. `$W^{1,p}_0$ ... $\Omega_f$`) break via emphasis/underscore
   mangling too, not just backslash escaping.
3. Desktop fixed this in commit `240c6e7` (2026-05-25, "fix: protect math before markdown
   emphasis") — pre-parse math protection + `.math` spans. **The commit touched only desktop
   files** (`assets/enhance/preview-enhance.js`, `src/main.rs`); zero mobile changes.
4. The only published Android release `mobile-android-v1.0.9` (2026-06-18, commit `119cfa7`)
   contains the 4-delimiter scanner but NO pre-parse protection; same for mobile branch HEAD.
   Upstream is aware of the bug class (desktop CHANGELOG 1.1.2 admits `$\{x\}$`,
   `$\bar{\mu}_{n}$` were broken) but never ported the fix to mobile.
5. Upstream activity: master v1.4.0 (2026-07-25) is desktop-only; mobile branch untouched
   since 2026-05-30. License: MIT.

## Ecosystem survey

- **Markwon** `io.noties.markwon:core:4.6.2` (Maven Central; repo last commit 2021-03, inactive):
  `ext-latex` OOTB supports ONLY `$$...$$`. Source proof:
  `JLatexMathInlineProcessor.RE = (\${2})([\s\S]+?)\1`, block parser only counts `$` signs.
  Architecture (commonmark-java + `MarkwonInlineParserPlugin.addInlineProcessor` + custom
  block parser factories) fully supports adding custom delimiters — extension point confirmed.
- **jlatexmath-android**: `ru.noties:jlatexmath-android:0.2.0` (Maven Central, 2020) —
  **GPL-2.0-or-later** (upstream JLaTeXMath, Scilab forge). Active fork:
  `github.com/rikkahub/jlatexmath-android` (android branch, releases through 2025-10), same GPL.
  ⇒ Native rendering path makes the app GPL-2.0-or-later (or infringing).
- **KaTeX**: MIT license, JS, needs WebView (System WebView ships real Chrome on all
  supported Android). md-preview already vendors katex.min.js + woff2 fonts offline.
- **Markor** v2.16.1: has KaTeX math (flexmark katex extension + WebView render), general
  note editor, not a math-document viewer. Delimiter set not yet audited line-by-line.
- No maintained OSS Android markdown app renders all four styles OOTB (user's own survey +
  this spot-check agree).

## Environment facts (sandbox)

- Debian 13 container: **no Java, no Android SDK, no /dev/kvm** (no emulator possible).
- Node v26.7.0 available (used for pipeline experiments).
- Building an APK requires: JDK 17 + Android cmdline-tools + platform + build-tools
  (~0.5–2 GB download, needs user approval per standing rule), or use host Android Studio.
- Local verification possible without emulator: javac compile against android.jar,
  unit-test the markdown+math parsing layer on the JVM (pure Java), Robolectric optional.
- On-device install/test: user's phone (user is the acceptance tester).

## Candidate architectures

- A (recommended): Native, Markwon core + self-written math extension implementing all four
  delimiters correctly at the parser level (protect math from CommonMark before inline
  parsing, mirroring desktop 240c6e7 strategy). License: GPL-2.0-or-later (jlatexmath) — or
  swap renderer to KaTeX-in-WebView for MIT-only. No dependency on upstream fixes.
- B: WebView + KaTeX shell (md-preview-mobile-like) with correct math protection. Fastest,
  MIT-able; quality bounded by WebView.
- C: Fork md-preview mobile branch and port 240c6e7's protection. Fastest "fix", but tied
  to upstream structure, no tests, inactive branch.
