# Changelog

All notable changes to the TFVC extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `src/extension.ts` trimmed from 445 to 350 lines by extracting review-command registrations into `src/reviewCommands.ts` and workspace-root detection into `src/workspaceDetect.ts`. Both are dependency-light and easier to reason about in isolation. Activation flow in `extension.ts` is now the coordination it's supposed to be, not buried under inline command bodies.
- SOAP clients (`AdoSoapClient` for code-review discussions, `TfvcSoapClient` for workspace + shelveset writes) now share a `SoapClientBase` that owns envelope construction, Basic auth, POST, and SOAP-fault parsing. `AdoSoapClient` gains two improvements from the consolidation: the SOAPAction header is now quoted per the SOAP 1.1 spec (was unquoted — some older on-prem TFS installs are fussier about this), and HTTP errors now fold the server's `<faultstring>` into the thrown message instead of being swallowed behind a generic "server error (500)".
- `initRestClient()` invocations are now serialized via a promise chain. Rapid config or PAT changes previously could interleave two reinit runs: both would dispose scoped state, both would create fresh clients, and the second would leak the first's repo into `repoDisposables`. Chaining ensures each run reads fresh config when its turn comes, and a failure no longer stalls subsequent runs.
- `TfvcRepository` no longer imports `vscode` directly. The change-event emitter is now passed in via the constructor (`ChangeEmitter` interface — structurally compatible with `vscode.EventEmitter<void>`), so the class can be unit-tested without a vscode runtime. `outputChannel.ts` lazy-loads `vscode` and falls back to `console.error` when it's not available, for the same reason.

### Added
- `test/manifest.test.ts` — 36 static-validation cases on `package.json`: every `tfvc.*` command has title + category "TFVC"; every palette-visible command has a matching `onCommand:` activation event (v0.3.2 regression guard); `onStartupFinished` is explicitly disallowed; the `workspaceContains:**/.vscode-tfvc/**` trigger is preserved; every command referenced in `contributes.menus` is declared in `contributes.commands` (catches menu-wiring typos); every configuration property has a non-trivial description.
- `test-e2e/suite/setPat.test.ts` — 4 cases covering the `tfvc.setPat` command: cancel (undefined input) is a no-op, submitting a value fires the "stored" toast, empty string fires the "removed" toast, and the stored/removed messages are distinct (so a refactor that conflates them gets caught).
- `test-e2e/suite/notConfigured.test.ts` expanded from 1 case to 14: every palette-invokable `tfvc.*` SCM command (`refresh`, `checkin`, `sync`, `checkout`, `undo`, `undoAll`, `add`, `delete`, `shelve`, `unshelve`, `shelvesets`, `history`) now has a regression test asserting it shows the "configure settings" toast when fired unconfigured. `tfvc.initWorkspace` has its own case (different guard path). `tfvc.setPat` explicitly verifies the "always available" contract. Catches v0.3.3-class regressions in the `wrapSCM → notConfigured()` pipeline.
- `src/ttlCache.ts` — reusable TTL cache, replacing the ad-hoc `{ content, timestamp }` Map in `TfvcQuickDiffProvider`. Clock injection makes expiry-boundary behaviour testable without real timers. `test/ttlCache.test.ts` adds 9 cases covering hit / miss / boundary / set-resets-window / delete / clear / lazy-eviction contract.
- `src/autoCheckoutHelpers.ts` — extracts the two pure filesystem predicates the handler uses (`isPathWithinWorkspace`, `isReadOnly`) so they can be tested without a vscode runtime. `AutoCheckoutHandler` now delegates to them; `test/autoCheckoutHelpers.test.ts` adds 11 cases covering inside/outside/equal, trailing-slash and look-alike-prefix edge cases, and readable/writable/missing/directory modes.
- `src/changeTypeMetadata.ts` — shared presentation metadata (badge letter, tooltip label, codicon name, theme color, strikethrough) for each TFVC change type. `TfvcDecorationProvider` and `TfvcSCMProvider` now pull from this single source instead of maintaining parallel switch statements with slightly different wording. `test/changeTypeMetadata.test.ts` adds 6 unit tests pinning the mapping, enforcing distinct letters per primary type, and regression-guarding the "never silently collapse unknown type to `edit`" contract from v0.3.2.
- `test/shelvesetName.test.ts` — 7 tests covering the shelveset-name validation rules (empty / whitespace / leading-dash / shell-metacharacter / unicode-OK). The validator is now `src/shelvesetName.ts`, exported for future programmatic callers and the existing input-box use.
- `test/tfvcRepository.test.ts` — 27 unit tests covering `TfvcRepository`: the `refresh` preservation contract from the silent-fail sweep, `shelve` / `unshelve` end-to-end with mocked clients, `checkin` payload construction and baseline update, thin REST/SOAP delegations, and state-mutation helpers.

### Fixed
- `decodeXmlEntities` now handles numeric entities (`&#39;`, `&#x27;`, upper/lowercase hex marker, astral-plane codepoints) and no longer double-decodes chained entities. Previously an encoded literal `&lt;` (source `&amp;lt;`) was converted to `<` because `&amp;` was replaced first, then `&lt;` matched the next chained replace. Now runs as a single regex pass, and unknown entities pass through untouched instead of being dropped.
- `classifyHttpError` now returns actionable messages for 400, 408, 502, 503, and 504. 400 shows the server's detail so the malformed parameter is visible. 408 points users at `tfvc.proxy` and network. 502/503/504 distinguish "ADO is down" from generic 5xx.
- `tfvc.unshelve` no longer silently substitutes a local `.vscode-tfvc/shelves/` copy when the server unshelve fails. The fallback was dangerous: a local shelf happens to share the name but holds unrelated data, so users would see "Unshelved" but get different content than what teammates reviewed. REST errors (auth, missing shelveset, network) now propagate to the standard error toast.
- `tfvc.shelvesets` (List Shelvesets) no longer swallows REST errors and silently shows local `.vscode-tfvc/shelves/` entries as if they were server shelvesets. Auth failures and server outages previously looked like "you have no shelvesets"; now the error propagates to a standard toast.
- Auto-checkout `onEdit` path no longer swallows unexpected promise rejections. The inner `tryCheckout` already catches its own failures via `notifyFailure`, but the outer `.catch(() => {})` would have silently hidden any future regression where an error escaped. Now logs to the output channel and still routes through the deduped toast.
- `TfvcRepository.refresh()` no longer clears the pending-change list on a transient read failure. Previously, if `getPendingChanges()` threw (disk hiccup, permission glitch while hashing), the SCM tree blanked out and made it look like the user had lost their work. The in-memory list is now preserved until a successful refresh replaces it.
- Review-diff 404 detection in `ReviewFileContentProvider` now checks `TfvcError.statusCode === 404` instead of pattern-matching the error message. Brittle substring matches (`msg.includes('404')`) previously risked either missing real 404s when the message format shifted, or swallowing unrelated errors whose text happened to contain "404".
- `syncBaseline` now reports a conflict when a server-side-deleted file cannot be unlinked locally (file in use, permission denied), instead of silently ignoring the failure, removing the baseline entry, and reporting `action: 'deleting'`. Previously the file stayed on disk but vanished from every subsequent sync's bookkeeping — quiet desync between tree and baseline.
- `initRestClient()` failures on config- or PAT-change events now surface as warning toasts pointing the user at their settings, instead of only logging to the output channel. Previously a malformed `adoBaseUrl` or unreachable on-prem server left the extension in a stale state with no visible cue.
- `findTfvcRoots()` now logs filesystem errors when scanning workspace folders for `.vscode-tfvc/` instead of swallowing them silently. Helps users diagnose cases where an unreadable or dangling-symlink folder made the extension skip a valid TFVC root.

### Removed
- Dead local-shelf code on `WorkspaceState` (`saveLocalShelf`, `applyLocalShelf`, `listLocalShelves`, `deleteLocalShelf`) and the `.vscode-tfvc/shelves/` directory it managed. v0.3.7 stopped the silent fallback on shelve; today's Unreleased fixes cut the last two callers on unshelve and listShelvesets. Nothing references these methods anymore, and the "future explicit stash command" they were kept for is not in flight. If we ever build stash, it will be designed fresh. Existing `.vscode-tfvc/shelves/` folders on user machines are now inert — safe to delete manually.

## [0.3.7]

### Fixed
- `getBotIdentity()` now pins `/_apis/connectionData` to `api-version=1.0` instead of inheriting the client-wide default. Cloud ADO rejected 7.1 on this one endpoint with "resource is under preview … -preview flag must be supplied", which silently broke `tfvc.submitVerdict` on v0.3.5 because the response work item couldn't be assigned.
- **`tfvc.shelve` now actually shelves on the server** (issue #10). Previous versions called REST endpoints that don't exist (`POST /_apis/tfvc/shelvesets` → HTTP 405); the silent "local shelf" fallback produced machine-local copies that teammates and code reviews couldn't see. The write path is now SOAP against `/VersionControl/v1.0/Repository.asmx`, routed through a lightweight server-registered workspace that the extension manages transparently.
- **`tfvc.shelvesets` → Delete Shelveset** similarly now deletes on the server via SOAP instead of silently deleting a non-existent REST resource.

### Changed
- Local-shelf fallback no longer fires on server-shelve failure. Errors surface as toasts so the user can retry or check permissions. Local shelves (`.vscode-tfvc/shelves/`) remain in the codebase for a future explicit stash command; they just no longer masquerade as server shelvesets.
- New `.vscode-tfvc/server-workspace.json` holds the server TFVC workspace name this install registers for shelving. Self-healing: if the server reports the workspace is gone (admin sweep, expiry), the extension recreates on the next shelve.

### Added
- `src/ado/tfvcSoapClient.ts` — SOAP client for the TFVC repository service (createWorkspace, pendChanges, shelve, deleteShelveset, …).
- `src/ado/tfvcUploadClient.ts` — multipart upload helper for TFVC file content. 5 MB single-chunk cap; multi-chunk upload is future work.

### Removed
- `AdoRestClient.createShelveset` / `.deleteShelveset` — REST endpoints that don't exist on any ADO server. Replaced by the SOAP path above.

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
