# TFVC for VS Code

Team Foundation Version Control (TFVC) source control integration for VS Code. Connects directly to Azure DevOps via REST — **no TEE-CLC or `tf` command-line tool required**.

Works with both Azure DevOps Services (cloud) and Azure DevOps Server (on-prem).

## Screenshots

*Screenshots coming soon — see the [Features](#features) section below for a functional overview.*

## Features

- **SCM sidebar integration** — pending changes shown in VS Code's Source Control view (Included / Excluded / Conflicts groups)
- **Check in / undo / sync** — standard TFVC operations against the server
- **Auto-checkout on save or edit** — configurable, for files that need to be locked for editing
- **Shelvesets** — create, list, and unshelve shelved changes
- **History** — view changeset history for any file
- **Code reviews** — browse and respond to TFVC code reviews (shelveset-based) without leaving the editor
  - File-by-file diff view (base vs shelved)
  - Inline comments via VS Code's Comments API
  - Submit verdicts: Looks Good / With Comments / Needs Work / Declined
- **File decorations** — M / A / D / C badges in the file explorer
- **Workspace initialization** — one command sets up baseline state; no Visual Studio or TEE-CLC install needed

## Prerequisites

- A TFVC project hosted on **Azure DevOps Services** (`dev.azure.com`) or **Azure DevOps Server** (on-prem).
- A **Personal Access Token (PAT)** with these scopes:
  - **Code → Read & write** (for source control operations)
  - **Code (status)** — if you use review verdicts
- VS Code 1.85.0 or newer.

## Quick Start

1. **Install the extension** from the Marketplace (search for "TFVC").
2. **Set your PAT**: open the command palette and run `TFVC: Set PAT (Personal Access Token)`. The token is stored in VS Code's SecretStorage.
3. **Configure the server** in VS Code settings:
   - For cloud: set `tfvc.adoOrg` (e.g. `myorg`) and `tfvc.adoProject`.
   - For on-prem: set `tfvc.adoBaseUrl` (e.g. `https://devops.example.com`), `tfvc.adoCollectionPath` (e.g. `/tfs/DefaultCollection`), and `tfvc.adoProject`.
4. **Initialize the workspace**: run `TFVC: Initialize Workspace`. This creates `.vscode-tfvc/` with baseline state so the extension can detect local changes.
5. **Open the Source Control view** — pending changes appear as you edit files.

## Configuration

| Setting | Description | Default |
|---|---|---|
| `tfvc.adoOrg` | Azure DevOps organization name (cloud only). | `""` |
| `tfvc.adoProject` | Azure DevOps project name. | `""` |
| `tfvc.adoBaseUrl` | On-prem ADO Server base URL. Leave empty for cloud. | `""` |
| `tfvc.adoCollectionPath` | On-prem collection path (e.g. `/tfs/DefaultCollection`). | `""` |
| `tfvc.adoApiVersion` | Override the ADO REST `api-version` query parameter. Leave empty for auto (7.1 cloud, 6.0 on-prem). Older TFS: `4.1` (2018), `5.0`/`5.1` (2019). | `""` |
| `tfvc.autoCheckout` | When to auto-checkout files: `disabled`, `onSave`, `onEdit`. | `onSave` |
| `tfvc.autoRefreshInterval` | Auto-refresh interval in seconds. `0` disables. | `0` |
| `tfvc.strictSSL` | Validate the server's TLS certificate. Set to `false` to trust self-signed or internal-CA certs on on-prem — disables verification entirely, so only flip on trusted networks. | `true` |
| `tfvc.proxy` | HTTP proxy URL (e.g. `http://user:pass@proxy.corp:8080`). Empty falls back to the `HTTPS_PROXY` / `HTTP_PROXY` env vars. | `""` |
| `tfvc.reviewRequestOpenState` | Workflow state used to filter open code reviews. Localized per server (`"Angefordert"` on German TFS). | `"Requested"` |
| `tfvc.reviewResponseClosedState` | Workflow state the verdict flow transitions a Code Review Response to. Localized per server (`"Geschlossen"` on German TFS). | `"Closed"` |

### Non-English Azure DevOps Server

Work item *type* and *category* lookups happen via language-neutral category reference names (`Microsoft.CodeReviewRequestCategory` / `Microsoft.CodeReviewResponseCategory`), so those need no configuration. Workflow **state** values are still localized — override `tfvc.reviewRequestOpenState` and `tfvc.reviewResponseClosedState` on non-English servers.

## Known Limitations

- **Large repositories**: initial workspace initialization downloads baseline metadata for all mapped files. This can be slow for very large trees.
- **SOAP parsing via regex**: the code review comment client parses SOAP responses with regex rather than a full XML parser. Well-formed ADO responses work; unusual responses may not.
- **Multi-root workspaces**: the extension picks a single workspace folder and warns if multiple folders contain `.vscode-tfvc/`. For full isolation, open each TFVC project in its own VS Code window.
- **No automatic retry**: transient network failures aren't automatically retried.

## Commands

All commands are available under the `TFVC:` category in the command palette:

- `Initialize Workspace`, `Set PAT (Personal Access Token)`
- `Refresh`, `Check In`, `Get Latest (Sync)`, `Check Out (Lock for Edit)`
- `Undo`, `Undo All Changes`, `Add File`, `Delete File`
- `Open Diff`, `Open File`, `Show History`
- `Shelve Changes`, `Unshelve Changes`, `List Shelvesets`
- `Refresh Code Reviews`, `Submit Review Verdict`

## License

MIT — see the `LICENSE` file for details.
