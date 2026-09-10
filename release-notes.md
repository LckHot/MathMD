What's new since v1.2.0

- **ChatGPT-style TSV tables render as real tables**: plain
  tab-separated blocks (as emitted by ChatGPT's web client, no pipe
  syntax, blank lines allowed between rows) are converted to tables in
  the preview. Conversion runs after math protection, so tabs can never
  cut a formula, and fenced/indented code is left alone. Tables wider
  than the page scroll inside their own container as before.
- **Settings: TSV table controls**: an On/Off toggle for the conversion,
  plus "TSV minimum rows" (default 3) and "TSV minimum columns"
  (default 2) knobs that set how large a tab-separated run must be to
  convert. Changing the toggle re-renders the preview live.
- **New document**: the menu gains New (first item). Unsaved edits are
  handled identically by Open and New — the unsaved-changes guard asks
  first (Save / Discard / Keep this and start a new window / Cancel),
  then creates the blank document.
- Internal: third round of code-quality review fixes (document IO,
  manifest queries, CI comment accuracy); mdtest suite now 64/64.

**Downloads**

- **app-release.apk** — signed release build (recommended)
- **app-debug.apk** — debug build

Install: download an APK and open it on the device (allow "install unknown
apps" for this app). To update over an existing install, the APK must be
signed with the same key.
