# AGENTS.md

Context for AI agents working on this repo.

## What this is

A Firefox WebExtension (Manifest V3) that scrapes 3D model pages and uploads
the model + metadata to a user-configured Manyfold instance via its REST API.
Modeled after NZB Donkey / Torrent Control — one click, no leaving the page.

Currently supports Makerworld only. Architecture is designed to add Printables,
Thingiverse, and Cults3D scrapers as drop-in modules.

## Architecture

```
manifest.json                 # MV3 manifest, host permissions, content script matches
background/
  service-worker.js           # Message router; orchestrates the full upload flow
  manyfold-api.js             # OAuth client_credentials + REST client
  file-downloader.js          # fetch() with credentials: "include"
content-scripts/
  base-scraper.js             # Shared helpers (window.ManyfoldScraper)
  makerworld.js               # Site-specific scraper, posts SCRAPE_RESULT
popup/
  popup.{html,css,js}         # Model preview + send button + result states
options/
  options.{html,css,js}       # Manyfold URL, OAuth creds, default collection
icons/                        # 16/32/48/128 PNG icons
```

### Data flow

1. User loads a Makerworld model page.
2. `makerworld.js` content script runs at `document_idle`, reads `__NEXT_DATA__`
   from the DOM, fetches presigned file URLs, sends `SCRAPE_RESULT` to the
   background worker.
3. Background stores the model data keyed by `tabId` and sets a green badge.
4. User clicks the toolbar icon → popup queries `GET_PAGE_STATE` for the
   active tab, renders the preview.
5. User clicks "Send to Manyfold" → popup sends `START_UPLOAD`. Background
   authenticates against Manyfold (OAuth client credentials), downloads files
   via `credentials: "include"` (uses Makerworld session cookies), creates the
   model, uploads each file, optionally uploads the cover image.
6. Background streams progress updates back to the popup via `STATE_UPDATE`
   messages and persists final state in the per-tab map.

### Message contract

All cross-component communication goes through `browser.runtime.sendMessage`.
Message types handled by the background:

| Type             | From            | Payload                              | Returns                |
|------------------|-----------------|--------------------------------------|------------------------|
| `GET_PAGE_STATE` | popup           | `{ tabId }`                          | state object           |
| `START_UPLOAD`   | popup           | `{ modelData, tabId }`               | `{ success, ... }`     |
| `SCRAPE_RESULT`  | content script  | `{ modelData, error? }`              | —                      |
| `STATE_UPDATE`   | background→popup| `{ tabId, state }`                   | —                      |

The popup must pass `tabId` explicitly because messages from extension pages
don't carry `sender.tab` — only messages from content scripts do.

### State shapes (per-tab)

```
{ status: "idle" }
{ status: "ready",     modelData }
{ status: "uploading", progress, modelData }
{ status: "duplicate", existingUrl, modelData, downloadedFiles }
{ status: "done",      modelUrl }
{ status: "error",     error }
```

## Normalized `ModelData`

Every scraper must produce this shape. Add sites by writing a new content
script that emits this and wiring it up in `manifest.json` content_scripts:

```js
{
  title:       string,
  description: string,           // HTML or markdown
  sourceUrl:   string,           // canonical page URL
  creator:     { name, profileUrl },
  license:     string,           // SPDX-normalized when possible
  tags:        string[],
  coverImageUrl: string | null,
  files: [{ name, type: "model"|"image", fileExt: "3mf"|"stl"|..., downloadUrl }],
}
```

## Makerworld specifics (learned the hard way)

### Field names are camelCase, not snake_case

Despite what older scrapers/Apify docs claim, the live `__NEXT_DATA__` uses:
- `designCreator` (not `design_creator`)
- `coverUrl` (not `cover_url`)
- `designExtension` (not `design_extension`)
- `tagsOriginal`, `coverLandscape`, etc.

The exception: inside `designExtension`, the nested keys ARE snake_case
(`model_files`, `design_pictures`). Don't normalize blindly.

### Where the model data lives

`window.__NEXT_DATA__.props.pageProps.design` — NOT in React Query's
`dehydratedState`. There is no `dehydratedState` on model pages.

### File download endpoint

```
GET /api/v1/design-service/instance/{instance.id}/f3mf
  → { name, url }   where url is a 5-min presigned S3 link
```

The endpoint uses the user's session cookie (no Bearer token needed). The
`instance.id` field — **not** `profileId` — is what the path expects.

For STL-only models, `/instance/{id}/stl` is the likely path but is unverified
as of this writing.

### File list location

`design.designExtension.model_files` is a top-level array, NOT per-instance.
Each file has `modelType: "3mf" | "stl"`, `modelName`, `modelSize`. The
`modelUrl` field in `__NEXT_DATA__` is always empty — you must hit the
endpoint above to get a real URL.

### Picking files

User preference: prefer 3MF; include STL only if no 3MF exists. The current
scraper makes one endpoint call per instance per format.

## Manyfold API specifics

- Auth: OAuth 2 client_credentials flow.
  `POST {base}/oauth/token` with `grant_type=client_credentials`, scope
  `public read write`. Token TTL is honored with a 60s safety margin.
- Routes assumed: `/api/v1/models`, `/api/v1/models/:id/model_files`,
  `/api/v1/collections`. JSON:API envelope (`data.attributes`, `data.relationships`).
- File uploads use `multipart/form-data` with field `model_file[file]` and
  `model_file[kind]`. Do NOT set Content-Type — let fetch derive the boundary.
- Manyfold has no `source_url` field on models. We stuff the source URL into
  `notes` so duplicate detection can grep for it on subsequent uploads.
- Duplicate check is best-effort: list first 50 models, substring match notes
  for the source URL. The check is skipped when `modelData._skipDuplicateCheck`
  is set (via the "Import Anyway" path).

## CSS gotcha — view switching

All view containers start with `class="view hidden"`. The `.hidden` class uses
`display: none !important`, which overrides `.view.active { display: block }`.
The `showView()` helper must BOTH add `active` AND remove `hidden`. If you add
a new view, follow this pattern or it'll render blank.

## Testing workflow

There is no automated test suite. The dev loop is:

1. Make changes.
2. In Firefox: `about:debugging` → **This Firefox** → **Reload** on the extension.
3. Navigate to a Makerworld model page (e.g. `makerworld.com/en/models/1888017-...`).
4. Open browser console (F12) to see `[Manyfold]` log lines from the scraper.
5. Click the toolbar icon. Watch the popup state.
6. For background-worker logs: in `about:debugging`, click **Inspect** on the
   extension to open the background script's DevTools.

### Debugging with Chrome MCP (if available)

If working through Claude with the Claude-in-Chrome MCP tool, you can drive a
real logged-in browser to inspect Makerworld's DOM / network without installing
the extension. Useful for verifying scraper assumptions before coding them.
The MCP redacts JWT tokens and presigned URL query strings from output — split
URLs at `?` to see just the path structure.

## Things NOT to do

- **Don't add a background-script User-Agent header.** `navigator` exists in
  service workers but adding a custom `User-Agent` is forbidden by the fetch
  spec and silently fails or warns. Use `credentials: "include"` and let
  Firefox handle headers.
- **Don't try `webRequest` blocking on Manifest V3.** Firefox still allows it
  but the codebase doesn't need it — content scripts have full DOM access on
  the user's logged-in page, and the background can do authenticated fetches
  to first-party endpoints with the cookie jar.
- **Don't reintroduce a "Bambu token" localStorage scrape.** The earlier scraper
  tried to extract a Bearer token from localStorage to call `api.bambulab.com`
  directly. That path is fragile and unnecessary — the Makerworld `/api/v1/
  design-service/instance/{id}/f3mf` endpoint accepts session cookies and
  returns the same presigned URL.
- **Don't generate documentation files (READMEs, CHANGELOGs) unless asked.**
  Code comments should be sparse — only when the WHY isn't obvious.
- **Don't `cd` into the project dir in Bash calls.** It's the working dir already.

## Adding a new site

1. Create `content-scripts/<site>.js`. Use `window.ManyfoldScraper` helpers.
2. Produce the normalized `ModelData` object and call `reportModelData(...)`.
3. Add the site's URL pattern to `manifest.json` content_scripts.
4. Add the site's host to `host_permissions`.
5. If the site's API needs more than session cookies, document why in this file.

## Open follow-ups

- STL fallback endpoint path is guessed (`/instance/{id}/stl`) — needs verification.
- Cover image upload uses `kind: "image"` — confirm Manyfold accepts this kind.
- No retry on transient upload failures; currently logs and continues.
- License normalizer in `base-scraper.js` is a tiny lookup table — extend as
  new licenses are encountered.
- Per-tab state is in-memory in the background worker. MV3 non-persistent
  backgrounds CAN be torn down between events; if state loss becomes an issue,
  move to `browser.storage.session`.
