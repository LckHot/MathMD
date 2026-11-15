What's new since v1.3.1

- **Clearer unsaved-changes dialog**: a single primary Save action,
  distinct destructive Discard styling, and neutral new-window/Cancel
  actions make dirty Open/New decisions easier to scan. Long filenames
  and large font scales remain accessible.
- **Organized Settings**: Appearance, Editor, Preview, and Tables are
  now lightweight sections. TSV conversion uses a Switch, numeric fields
  retain exact input with range hints, value pickers are full width, and
  a Done action provides an explicit exit.
- **Compact responsive search**: a filled query pill with inline Clear,
  stable result counts, icon navigation, and full-size touch targets.
  Narrow screens and large fonts wrap to two rows instead of clipping.
  IME Search/Enter advances to the next match; Escape closes search.

Math rendering, document IO, and Edit/Preview viewport behavior are
unchanged in this release. The preview suite remains at 604 checks per
fresh and committed bundle, with Android unit and build validation.

**Downloads**

- **app-release.apk** — signed release build (recommended)
- **app-debug.apk** — debug build

Install: download an APK and open it on the device (allow "install unknown
apps" for this app). To update over an existing install, the APK must be
signed with the same key.
