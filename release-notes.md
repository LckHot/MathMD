What's new since v1.1.0

- **In-document search** (menu → Search), in both Edit and Preview:
  case-insensitive, all matches highlighted with the active one marked,
  prev/next stepping, and the view jumps to the active match. The editor
  searches the markdown source; the preview searches the rendered text, so
  match counts can differ between modes.
- **One window per document**: opening a file from another app now gets
  its own MathMD window instead of replacing the current one; re-opening
  the same file focuses (and reloads) the window already showing it.
- **Unsaved-changes guard**: opening another document with unsaved edits
  asks first — Save and open / Discard and open / Keep this and open in a
  new window / Cancel.
- **CJK bold fixed**: `**…**` next to CJK characters now renders bold
  (CommonMark flanking-rule gap).
- **Long tables scroll horizontally inside their own container** instead
  of widening the whole page.
- **Search and preview performance**: the preview no longer re-renders the
  whole document on every search keystroke or unrelated UI event, and
  search matching is cached per document.
- **Reliability**: process-death restore now preserves unsaved edits
  instead of silently reloading from disk; the dirty marker and open
  guard update immediately after saving; fixed a manifest issue
  (INSTALL_PARSE_FAILED_MANIFEST_MALFORMED) that blocked installation of
  post-v1.1.0 test builds.
- Internal: document IO extracted into a single-threaded service;
  open/save flows hardened (save snapshots, ordered opens).

- **app-release.apk** — signed release build (recommended)
- **app-debug.apk** — debug build

Install: download an APK and open it on the device (allow "install unknown
apps" for this app). To update over an existing install, the APK must be
signed with the same key.
