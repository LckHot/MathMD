# MathMD

In the AI-for-research era, GPT and friends answer math questions in
Markdown. Android had no clean reader that renders all four common
TeX/LaTeX math delimiter styles — so this simple app now exists.

A minimal Android markdown **reader** (with light editing) built for
mathematicians. It renders TeX/LaTeX math correctly in **all four** common
delimiter styles:

```markdown
Inline:  $x_i$  and  \(u \in C^k\)
Display: $$...$$  and  \[ ... \]
```

## Why another markdown app?

Most Android markdown editors either render no math at all, or break on real
mathematical documents: the markdown parser runs *first* and eats
`\(...\)` / `\[...\]` backslashes (CommonMark escape rules) and mangles
`_`-containing formulas like `$\bar{\mu}_{n}$` into emphasis spans *before*
any math renderer sees them.

MathMD extracts math segments **before** markdown parsing (a
protection/placeholder pass), so all four delimiter styles survive intact.
The pass is written in TypeScript and covered by a 24-case regression suite
(including `$\{x\}$`, inline pairs, `$W^{1,p}_0(\Omega)$`, currency like
`$100 and $200`, and code spans/fences that must stay literal).

## Features

- Four math delimiter styles, rendered by bundled KaTeX (fully offline)
- Edit / Preview flip toggle; configurable startup mode
- Open via system file picker or "Open with…" from other apps; save in place or as a copy
- Light/dark/system theme; per-pane font family and free-size settings
- No network permission usage for the preview; the WebView is asset-sandboxed
- No accounts, no telemetry, no ads

## Known trade-off: dollar signs

There is deliberately no currency special-casing. `$` follows standard
Pandoc inline-math rules: an opening `$` pairs with the next unescaped `$`
(no whitespace right after the opener / before the closer). Spaced amounts
like `$100 and $200` stay prose automatically; tight pairs like `$5$` are
math — if your document mixes both, escape the literal dollars (`\$`) or
use code spans.

## Build

Requirements: JDK 17, Android SDK (platform 37 + build-tools 36), Node 20+.

```sh
# Preview pipeline (TypeScript → assets) + regression tests
(cd tools && npm install)
./scripts/build-preview.sh
node tools/mdtest/run.js

# Android app
gradle :app:assembleDebug     # APK: app/build/outputs/apk/debug/
```

## Repository layout

- `app/` — Android app (Kotlin, Jetpack Compose, Material 3)
- `tools/preview-src/` — math-protection scanner + render pipeline (TypeScript)
- `tools/mdtest/` — node regression harness for the preview pipeline
- `docs/` — architecture decision record and research notes
- `scripts/build-preview.sh` — esbuild bundle step

## Credits

- [KaTeX](https://katex.org) (MIT) — math rendering
- [markdown-it](https://github.com/markdown-it/markdown-it) (MIT) — markdown parsing
- [Material Symbols](https://fonts.google.com/icons) glyph paths (Apache-2.0) — icons
- Definitely a vibe coding result: every line of this repository was written
  by an AI agent; the human owner designed, tested on real hardware, and
  directed ~15 review rounds.

## License

MIT — see [LICENSE](LICENSE).
