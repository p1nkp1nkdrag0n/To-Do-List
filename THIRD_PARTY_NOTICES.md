# Third-party notices

The application's original code is licensed under **AGPL-3.0-only**. Third-party
software, fonts, icons, and their copyright notices retain their own licenses.
This file does not relicense them.

## Distribution coverage

- [`licenses/npm-notices.txt`](licenses/npm-notices.txt) preserves the complete
  upstream LICENSE, NOTICE, COPYING, copyright and AUTHORS files found in the
  installed non-dev dependency tree for the checked-in `package-lock.json`.
  This is a reviewed Windows x64 snapshot, not a list of browser modules alone.
- Every Vite build regenerates `dist/legal/THIRD_PARTY_NOTICES.txt` from that
  build's installed packages, including platform-specific optional dependencies.
  `dist/legal/build.json` records versions, npm tarball URLs, integrity values,
  notice hashes, and packages found in the browser chunks. Missing licenses or
  a browser package absent from the notice inventory fail the build.
- The `dist/legal/` directory is part of the client distribution and is served
  without login by the existing static server. Keep it with `dist/`, the server
  output, `package.json`, and `package-lock.json` when distributing a build.
  Preserve the upstream notice files when separately distributing `node_modules`.
- Development-only test tools are not shipped by this app and are excluded.
  Node.js, the browser, Caddy, operating systems, and other separately installed
  software retain their own terms; the generated inventory does not claim to
  cover a container image or an operating system distribution.

## Components requiring particular care

| Component in the lockfile | License and scope |
| --- | --- |
| `@fontsource-variable/inter` 5.3.0 | SIL OFL-1.1. Preserve the Inter Project Authors statement and entire OFL. The WOFF2 files are bundled unchanged; they are **not** AGPL. |
| `lucide-react` 1.20.0 | ISC, with the package's full list of Feather-derived icons and Cole Bemis's MIT statement preserved. Package metadata saying ISC alone is not the complete notice. |
| `lightningcss` and its native binding 1.32.0 | MPL-2.0 build tool. Its full license is retained in the inventory. It is not included in browser chunks. Merely processing CSS with this tool does not label the resulting CSS MPL. If distributing or modifying the tool itself, comply with its source obligations; upstream source: https://github.com/parcel-bundler/lightningcss/tree/v1.32.0. |
| React, React DOM, Markdown dependencies, Express and runtime dependencies | Exact installed versions and original notices are in the full inventory. Preserve them in combined/minified distributions. |
| Vite, Rolldown, esbuild, concurrently | These are currently declared as non-dev dependencies, so the inventory conservatively includes their notices and bundled subcomponent notices. That does not mean their entire code is shipped to the browser. Native wrapper packages without a license file use their matching-version parent package's license. |
| `sql.js` 1.14.1 | Retained for the legacy server. Includes LICENSE and AUTHORS, even though the v2 server uses Node's SQLite. |
| `cookie-signature` 1.0.7 | The complete MIT notice is embedded in `Readme.md`; that file is preserved because this package has no separate LICENSE. |

## Maintenance

After an intentional lockfile change, run `npm ci`, `npm run licenses:update`,
review the full notice diff, and stage the reviewed source files. Then run
`npm run build` and `npm run licenses:check`. Do not publish a build if notices
are missing or if the source manifest no longer matches the working source.
No dependency versions were changed for the AGPL adoption.

The source archive is a snapshot of reviewed tracked source files, read from the
working tree, including build/install instructions and the lockfile. Its SHA-256
manifest identifies the actual contents, including local modifications; it does
not claim an unchanged Git commit or link to a moving branch. Git metadata,
credentials, live configuration, databases, uploads and backups are excluded.
Only the three reviewed deployment **examples** are included. New source files
must be reviewed and staged before building. The downloaded archive includes a
source manifest so it can be rebuilt without Git metadata.

Original-code provenance review for base commit
`72e0282dd0adfa8738201087757bf7e5fa5939d7`: history contains the author names
`p1nkp1nkdrag0n` and `KingBao`; current tracked-file blame attributes the surviving
lines to `p1nkp1nkdrag0n`. No earlier root license or conflicting copyright header
was found. This records observable history, not proof of copyright ownership or
a contributor assignment; no authors or assignments have been invented. Existing
history and all discovered third-party attribution are preserved.
