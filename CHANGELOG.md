# Changelog

All notable changes to the TFVC extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.5]

### Added
- `tfvc.strictSSL` setting (default `true`) — set to `false` to trust self-signed or internal-CA certificates on on-prem Azure DevOps Server. Disables TLS verification entirely, so only flip on networks you trust.
- `tfvc.proxy` setting — HTTP proxy URL to tunnel ADO requests through (e.g. `http://user:pass@proxy.corp:8080`). Leave empty to fall back to the `HTTPS_PROXY` / `HTTP_PROXY` environment variables, or to connect directly. Handles both HTTPS (via CONNECT tunnel) and HTTP (absolute-URL forwarding); Basic auth is read from embedded credentials in the URL.
- `tfvc.adoApiVersion` setting — override the ADO REST `api-version` query parameter. Leave empty to keep the defaults (7.1 for cloud, 6.0 for on-prem). Older TFS installs that haven't been upgraded past a particular API revision can downgrade (TFS 2018: `4.1`; TFS 2019: `5.0` / `5.1`).

## [0.3.4]

### Fixed
- Code review discovery on non-English ADO servers: WIQL now filters by `[System.WorkItemType] IN GROUP 'Microsoft.CodeReviewRequestCategory'` (a stable category reference name) instead of the English display name `'Code Review Request'`. On a German TFS the old query silently returned zero reviews.
- Creating a verdict response on non-English ADO servers: the work-item-type for the response is resolved at runtime via `/_apis/wit/workitemtypecategories/Microsoft.CodeReviewResponseCategory` and URL-encoded into the create path, instead of the hardcoded `$Code%20Review%20Response`. The lookup is cached per session.
- Collection-path URL construction: strip leading/trailing slashes from both `tfvc.adoBaseUrl` and `tfvc.adoCollectionPath` so `https://tfs.example.com` + `tfs/DefaultCollection` no longer produces `https://tfs.example.comtfs/DefaultCollection`. Applies to both the REST and SOAP client base URLs.

### Added
- `tfvc.reviewRequestOpenState` setting (default `"Requested"`) — the workflow state used to filter open reviews. State values are localized and not queryable by category, so non-English servers need to override (e.g. `"Angefordert"` on German TFS).
- `tfvc.reviewResponseClosedState` setting (default `"Closed"`) — the workflow state the verdict flow transitions a response to (e.g. `"Geschlossen"` on German TFS).

## [0.3.3]

### Fixed
- Register all contributed commands (`tfvc.shelvesets`, `tfvc.checkin`, `tfvc.sync`, etc.) unconditionally at activation. Previously they reported `command not found` until a `.vscode-tfvc/` folder existed *and* `adoOrg`/`adoProject`/PAT were all set. When invoked without full configuration they now show a clear "not configured" message pointing the user at Set PAT, settings, and Initialize Workspace.
- Extend `activationEvents` with `onCommand:` entries for every palette-visible `tfvc.*` command so running them triggers extension activation even without a `.vscode-tfvc/` folder.
- Move config-change and PAT-change listeners above the workspace-detection early return so saving settings or setting a PAT can bring an inactive extension to life without a VS Code reload.

### Changed
- Command registration moved from `TfvcSCMProvider.registerCommands()` into `activate()` so all wiring lives in one place. SCM handler methods on `TfvcSCMProvider` are now public.

## [0.3.2]

### Added
- Classify ADO HTTP errors by status code with user-actionable messages (401, 403, 404, 429, 5xx).
- Surface auto-checkout failures to the user with per-file deduped warning toasts.
- Warn when multiple workspace folders contain `.vscode-tfvc/`, explaining which root was chosen.
- Preserve unknown ADO change-type labels instead of silently collapsing them to `edit`.
- Validate `AdoRestClient` constructor arguments (PAT, project, org/baseUrl) with fail-early errors.
- Register `tfvc.setPat` before early returns so the command is available even without a configured workspace.

### Fixed
- Always base64-encode file content in checkin/shelve payloads; fixes corruption of UTF-16 and non-UTF-8 files.
- Guard `syncBaseline` against empty `listItems` responses to prevent wiping all baseline data.
- Report conflict when a new server file collides with an untracked local file during sync.
- Recreate missing parent directories before restoring files during undo.
- Quick-diff now compares against the baseline changeset version, not HEAD.
- Rebuild repository and swap REST client when ADO config changes without requiring a reload.
- Surface local-shelf fallback to the user when server shelve/unshelve/delete fails.
- Paginate `queryOpenReviews` instead of silently truncating at 200 work items.
- Remove shipped no-op "Post Inline Comment" command that did nothing.
- Compare TFVC paths case-insensitively throughout (baseline lookups, pending-change matching).
- Dedupe work-item IDs before sending them on checkin.
- Case-insensitive watcher-ignore lookup so `.Git/`, `Node_Modules/` etc. are filtered on macOS/Windows.
- Encode org name in SOAP client base URL (was already encoded in REST client).
- Use `path.relative` for workspace containment check in auto-checkout (case-insensitive on macOS/Windows).
- Filter empty strings from server path sets in `clearPending`/`undoChanges`.
- Prevent shelve from silently falling back to a local shelf when there are no changes to shelve.
- Catch unhandled promise rejections from `initRestClient()` on config/secret change events.
- Case-insensitive excluded-paths Set and all consumer-side pending-change lookups (quick diff, decorations, auto-checkout, open diff).
- Case-insensitive guards in `serverToLocal`/`localToServer` so mixed-case scopes are handled correctly.
- Narrow activation events from `onStartupFinished` to `onCommand` triggers so the extension doesn't load in every VS Code window.

### Changed
- Share Basic auth header construction between REST and SOAP clients.
- Type all ADO REST response interfaces explicitly.
- Extract `showShelveResult` helper to remove 4× duplicated toast pattern.

### Removed
- Plaintext PAT config fallback (`tfvc.pat` setting) — PAT is now stored exclusively in VS Code SecretStorage.
- Dead code from the TEE-CLC era (`logCommand`, `logOutput`, `showOutputOnError`).

### Performance
- Collapse `existsSync` + `statSync` into a single `statSync` call in refresh.
- Use a single stat after checkin to record baseline mtime.
- Issue per-path `listItems` calls during scoped sync instead of listing the entire tree.

## [0.3.1]

### Added
- Marketplace publishing: `README.md`, `CHANGELOG.md`, `LICENSE`, marketplace metadata in `package.json` (`publisher`, `repository`, `bugs`, `homepage`), and `@vscode/vsce` as a dev dependency.
- GitHub Actions workflow (`.github/workflows/ci.yml`) with test + publish jobs. Publish job runs on tags matching `v*` and verifies `package.json` version matches the git tag.

### Changed
- Extension ID renamed from `vscode-tfvc` to `tfvc` (now published as `qodev.tfvc`).

## [0.3.0]

### Added
- Unit tests for `pathMapping`, file hashing, and `workspaceState` (27 tests).
- Workspace file watcher for instant edit detection in the SCM sidebar.
- Conflict detection in `getLatest()` when both server and local copies have changed.

### Changed
- Decoupled `workspaceState` from the `vscode` module via an injectable logger.
- Replaced inline `require()` calls in `unshelve()` with proper imports.
- Updated `.vscodeignore` and `.gitignore` to exclude test artifacts.

## [0.2.0]

### Added
- `TFVC: Initialize Workspace` command for first-time workspace setup.
- New `src/workspace/` module: state manager, path mapping, file hashing.
- Expanded REST client: `listItems`, `createChangeset`, `getChangesets`, `createShelveset`, `deleteShelveset`, `downloadItemBuffer`.

### Changed
- **All TFVC operations now use the ADO REST API** plus a local workspace state manager that tracks baselines and pending changes in `.vscode-tfvc/`. No `tf` CLI or TEE-CLC install is required.
- Activation now triggers on `.vscode-tfvc/` instead of `.tf/`.
- `TfvcRepository` rewritten to delegate to `WorkspaceState` + `AdoRestClient`.

### Removed
- TEE-CLC (`tf` CLI) dependency and all 10 command handlers (`status`, `checkin`, `checkout`, `get`, `undo`, `add`, `delete`, `shelve`, `history`, `diff`).
- `tfvc.tfPath` setting (no longer needed).

## [0.1.0]

### Added
- Initial release: VS Code extension for Team Foundation Version Control.
- SCM sidebar with pending changes (Included / Excluded / Conflicts groups).
- Auto-checkout on save or edit for read-only files.
- File explorer decorations (M / A / D / C badges).
- Quick diff via `tf print` (server vs local).
- ADO REST client for shelvesets, code reviews, and file content.
- ADO SOAP client for reading and writing inline code review discussions.
- Code review tree view with file diffs (base vs shelved/changeset).
- Inline comment display via VS Code's Comments API.
- Review verdict submission (Looks Good / With Comments / Needs Work / Declined).
- Support for both cloud (`dev.azure.com`) and on-prem Azure DevOps Server.

### Security
- Moved PAT storage from plaintext settings to VS Code's SecretStorage (via `TFVC: Set PAT` command).
- Escaped single quotes in project name to prevent WIQL injection.
- Validated shelveset names to prevent CLI argument injection.
- Quoted checkin and shelve comments for safe TEE-CLC handling.
