# Vendored scanner libraries

`jscanify.js` is the browser UMD build of [jscanify](https://github.com/ColonelParrot/jscanify)
(MIT licensed). We vendor it directly into the PWA's static assets rather than
installing the npm package because:

1. The npm package's `main` field points at a Node-only entry that requires
   `canvas` (a native module needing pixman/cairo to build) and `jsdom`.
   Vite resolves `import('jscanify')` to that file, producing a broken
   browser bundle. The browser-targeted file (`src/jscanify.js` in the
   upstream repo) is shipped as a UMD that expects a global `cv`.
2. Removing the npm dep eliminates ~150 transitive packages, including
   the regular cluster of native-build vulns flagged by Dependabot
   (serialize-javascript, tar, @tootallnate/once, etc.) — none of which
   we ever ship to production.

`opencv.js` (one directory up) is similarly vendored — same-origin so the
service worker can cache it; CDN URLs are blocked by the SW's same-origin
guard, breaking the spec's "offline after first load" promise.

## Updating

When jscanify ships a new version:

```bash
npm pack jscanify@<version>   # download the tarball
tar -xzf jscanify-*.tgz package/src/jscanify.js -O > pwa/public/scanner/jscanify.js
```

Then verify the diff is sensible (no surprise dependency on a different cv
API), retest on a real device, commit.

OpenCV.js: download the latest `4.x/opencv.js` from `https://docs.opencv.org/`
when ready to refresh; the file is self-contained (embedded wasm) so no
companion `.wasm` needs to ride along.
