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
The pass is written in TypeScript and covered by a 27-case regression suite
(including `$\{x\}$`, inline pairs, `$W^{1,p}_0(\Omega)$`, and code
spans/fences that must stay literal).

## Features

- Four math delimiter styles, rendered by bundled KaTeX (fully offline)
- Edit / Preview flip toggle; configurable startup mode
- Open via system file picker or "Open with…" from other apps; save in place or as a copy
- Light/dark/system theme; per-pane font family and free-size settings
- No network permission usage for the preview; the WebView is asset-sandboxed
- No accounts, no telemetry, no ads

## Known trade-off: dollar signs

There is deliberately no currency special-casing. **Every unescaped `$`
interacts with the math pass:** two unescaped `$` pair into a formula no
matter what sits between them (`I have $12 and he have $23` renders
`12 and he have` as math), and only a lone `$` with no partner stays
literal.
**All dedicated dollar signs must therefore be written escaped (`\$`) or
inside code spans** — a literal `$` is never safe.

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
- `docs/` — architecture decision record, research notes, signing setup
- `scripts/` — esbuild bundle step, keystore generator

## Credits

- [KaTeX](https://katex.org) (MIT) — math rendering
- [markdown-it](https://github.com/markdown-it/markdown-it) (MIT) — markdown parsing
- [Material Symbols](https://fonts.google.com/icons) glyph paths (Apache-2.0) — icons
- Definitely a vibe coding result: every line of this repository was written
  by an AI agent; the human owner designed, tested on real hardware, and
  directed ~15 review rounds.

## License

MIT — see [LICENSE](LICENSE).
