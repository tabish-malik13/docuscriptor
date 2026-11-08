# Third-party software

DocuScripter remains proprietary. Third-party software retains its own copyright, license and notice requirements. No new npm dependency was added for persistence, service authentication, or tests; these use Node.js built-ins. No commercial editor extensions or Docxtemplater add-ons are used.

## Application dependencies

Direct dependency versions are pinned in the workspace manifests; `package-lock.json` pins the transitive dependency graph. The installed package/lockfile license metadata was checked for all locked dependencies on 2026-11-08; no package was missing license metadata. Keep the original license and NOTICE files in distributed npm packages.

| Component | License / notice source |
| --- | --- |
| `@docx-editor.dev/core` and `@docx-editor.dev/react` 2.35.0 | Apache-2.0; package LICENSE and NOTICE files |
| React / React DOM 19.2.8 | MIT; package LICENSE files |
| `@supabase/supabase-js` 2.119.0 | MIT; package LICENSE |
| Fastify 5.12.8 and `@fastify/rate-limit` 10.3.0 | MIT; package LICENSE files |
| Docxtemplater core 3.71.1 | MIT; package LICENSE |
| `docx` 9.5.1, `lodash` 4.18.1, `yauzl` 3.3.0 | MIT; package LICENSE files |
| PizZip 3.2.0 and transitive JSZip | Dual MIT/GPL choices; use the MIT option and retain its notice |
| Pako | MIT AND Zlib; retain both notices |
| Lucide React 0.577.0 | ISC; package LICENSE |
| Inter via `@fontsource-variable/inter` 5.2.8 | OFL-1.1; bundled font license |
| TypeScript, Vite and build dependencies | Original package license files; the locked graph also contains BSD, Apache-2.0, ISC, 0BSD and BlueOak-1.0.0 notices |
| `caniuse-lite` build data | CC-BY-4.0; retain attribution if redistributing this build dependency |

The Vite build emits `frontend/dist/third-party-notices.txt`, served as `/third-party-notices.txt`, for bundled web dependencies and fonts. It does not replace the license files for backend packages, build tooling or container operating-system components.

## Runtime and container components

| Component | Primary source |
| --- | --- |
| Node.js 24 runtime | [MIT and bundled component notices](https://github.com/nodejs/node/blob/v24.x/LICENSE) |
| SQLite through `node:sqlite` | [SQLite public-domain dedication](https://www.sqlite.org/copyright.html); Node also retains bundled component notices |
| Caddy 2.11 | [Apache-2.0](https://github.com/caddyserver/caddy/blob/master/LICENSE) |
| Gotenberg 9 API | [MIT](https://github.com/gotenberg/gotenberg/blob/main/LICENSE) |
| LibreOffice inside Gotenberg | [MPL-2.0 and bundled component licenses](https://www.libreoffice.org/licenses/) |
| Chromium, PDF tools, fonts, Debian and Alpine packages inside the existing images | Their original per-component licenses and notices, including system package copyright files; the Gotenberg API's MIT license does not cover these components |

The Gotenberg image remains pinned to the repository's existing SHA-256 digest. This implementation does not introduce a new renderer/container dependency. Upstream license sources above were reviewed, but an exhaustive inventory of the exact installed image components could not be extracted here because the Docker daemon was unavailable. Preserve each image's original notices and finish that inventory against the built images before redistributing them. Do not apply an application-wide open-source license to DocuScripter as a consequence of these third-party notices.

## Optional CI tooling

The GitHub Actions workflow uses [actions/checkout](https://github.com/actions/checkout/blob/main/LICENSE) and [actions/setup-node](https://github.com/actions/setup-node/blob/main/LICENSE), both MIT-licensed. CI commands also run locally or on a self-hosted runner. GitHub hosting is not a runtime dependency.

Tenant implementation adds no npm dependency or application container. SQL CI uses the Ubuntu runner’s PostgreSQL service under the [PostgreSQL License](https://www.postgresql.org/about/licence/). Its license was verified before adding that test step; the application remains compatible with separately self-hosted Supabase. The selected hosted project is optional infrastructure chosen for this installation.
