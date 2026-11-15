What's new since v1.3.0

- **Safer math and Markdown rendering**: code spans, fenced/indented
  code, GFM tables, link reference definitions, and all four math
  delimiters are protected before Markdown parsing. Link labels,
  destinations, titles, Unicode case-insensitive search, CRLF documents,
  and inline/reference attributes now restore without lost content,
  broken links, token collisions, or math injected into real code.
- **More reliable document flows**: Open/New/Save As and asynchronous IO
  callbacks are bound to the current document and request. Picker state
  survives recreation, stale callbacks cannot overwrite newer edits,
  created documents request persistable read/write grants, and an
  interrupted Create reports an unknown result instead of rebinding to
  an unverified target.
- **Document decoding and test coverage**: UTF-8/UTF-16 BOM handling is
  explicit, and the preview suite now runs 604 checks against both fresh
  and committed bundles, plus Android unit and build checks.

**Downloads**

- **app-release.apk** — signed release build (recommended)
- **app-debug.apk** — debug build

Install: download an APK and open it on the device (allow "install unknown
apps" for this app). To update over an existing install, the APK must be
signed with the same key.
