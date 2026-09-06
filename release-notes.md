What's new since v1.0.1

- **Save as…**: export the current document to a new location from the menu.
- **Line width setting**: fix the wrap standard in characters (0 = fill
  screen). The default zoom fits that column exactly to the screen (the
  minimum zoom, no horizontal panning); pinch-zoom scales the whole page
  uniformly — zooming past the fit level enables global horizontal panning
  and the wrap never changes.
- **Working pinch-zoom** in the preview (it was silently disabled before).
- **Equation tags (`\tag`) pinned to the right end of the line**: an
  over-wide formula scrolls horizontally under its own gesture while the
  label stays put, and the two never overlap at scroll end.
- **Strict dollar rule**: every unescaped `$` is a math delimiter — two
  unescaped `$` pair into a formula no matter what sits between them; only
  a lone `$` stays literal. Write literal dollars as `\$` or inside code
  spans.
- Removed the preview font-size setting (pinch-zoom supersedes it).

- **app-release.apk** — signed release build (recommended)
- **app-debug.apk** — debug build

Install: download an APK and open it on the device (allow "install unknown
apps" for this app). To update over an existing install, the APK must be
signed with the same key.
