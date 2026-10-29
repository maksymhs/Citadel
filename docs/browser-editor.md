# Project workspaces and browser VS Code

## Sidebar space

Use the toggle beside the page title to open or close the sidebar. Desktop starts
with the sidebar visible and remembers your choice in this browser per signed-in
owner and panel origin, independently of project, machine and workspace mode.
Choosing Terminal or VS Code never folds it automatically. On mobile the
same button opens the existing overlay; navigation, backdrop click or Escape
closes it without changing the desktop preference. Hidden navigation is excluded
from keyboard focus; closing it while focused inside returns focus to the toggle.

## Projects and removal

New browser sessions start in Projects; an existing saved screen is restored.
System (host) is always the first Projects card and is not listed under Workspace.
Workspace appears only for projects with observed live terminals or a running
shared editor plus this browser's opened-project hint. Saved mode choices alone
do not mark a project open. VS Code hints are not authoritative: another tab can
open a folder, and closing an iframe does not prove that its folder is closed in
the shared editor. Unavailable status is not reported as stopped.

**Remove from Citadel** sends `deleteFiles=false` and preserves files on disk.
**Delete project files from disk** is a separate action requiring the exact path.
Both recheck terminal/editor status before submitting. The server also rejects a
running legacy Chat engine for any owner, without exposing owner or session
details. Legacy Chat removal checks and synchronous deletion share the engine
queue, so startup cannot interleave. Because shared VS Code cannot report which
project folders remain open, removal conservatively requires the shared editor
to be stopped, including when it was opened from another project. This is not a
guarantee that arbitrary host processes are idle. Existing managed-tree
restrictions still apply to explicit disk deletion.

## Terminal and VS Code modes

On first opening a project, choose a centered **Terminal** or **VS Code** card.
No terminal or editor starts until you select a mode. The selection is remembered
per signed-in owner, panel instance, selected host and project. Terminal selection
and editor state remain independent: switching modes does not overwrite the other
mode's state. Use the sidebar's three-dot workspace menu or **Projects → More
actions** to switch modes; there is no workspace mode toolbar. An already mounted
terminal stays mounted when switching modes. Entering a workspace remembered in
VS Code does not create or attach a terminal.

The icon-only **Choose mode** back arrow sits at the left of Citadel's global
header, beside the sidebar toggle, and appears only in a selected project mode.
It clears only the mode preference and returns to the two cards; terminal
selection, editor state and running work are retained. Navigating away closes the
view but remembers the mode. No process is stopped by merely returning here.

Each chooser card has a separate stop button and read-only running status;
checking status never starts a mode. Stops require confirmation. **Stop terminals**
terminates only the alive registered terminal sessions listed for this project
(not arbitrary host processes). **Stop shared editor** stops the one VS Code
process for **all projects**, including its integrated terminals and extension
hosts; save work first. These controls are disabled when nothing is running or
status is unavailable. Editor management requires a local administrator session.

The native Chat GUI, its slash-command composer and its panel entry points have
been removed. An old saved `mode='chat'` opens the chooser without starting work.
Existing preferences, histories and user data are not deleted, and removing the
GUI does not stop existing engines. The panel no longer calls Chat APIs or offers
Chat status/stop controls. The legacy backend, storage and server-side removal
guards remain for compatibility and safety; see [legacy Chat API boundaries](security.md#legacy-chat-api-boundaries).
The previously retired embedded OpenCode GUI, bundle adapter, `/opencode/*`,
`/api/opencode-web` and root API proxies remain absent. OpenCode and other terminal
agents, and optional AI Gateway routing, are unchanged.

## Browser VS Code

From **Projects → More actions → VS Code**, Citadel opens an
optional [code-server](https://github.com/coder/code-server) editor inside the
project workspace, not a fullscreen overlay. You can also choose **VS Code** from
the workspace cards, terminal toolbar or sidebar three-dot menu. Embedded VS Code
uses the global header's Choose mode action, without a duplicate internal return header.
The Citadel sidebar and global header remain visible and mounted terminals are preserved.
No desktop VS Code installation or SSH configuration is required.

On first use, click **Install browser editor and open project**. Citadel downloads
the pinned code-server 4.143.1 release for Linux/macOS x64/arm64, verifies its
embedded SHA-256 digest, and extracts it under `DATA_DIR/editor/runtime`. The
download is approximately 230 MB, with additional disk and memory costs after
extraction and while the IDE is running. It is optional and is not installed by
Citadel's installer. It needs `tar`, network access to GitHub and sufficient disk
space. No sudo, system service, desktop handler or public port is configured.

New editor profiles use **Default Dark Modern** with automatic system-theme
switching off. Existing explicit theme choices and commented JSONC settings
files are preserved.

After installation, either project action starts one shared editor process on
demand and opens the selected registered folder. VS Code workspace trust prompts
still apply. User settings, extensions and editor state persist under
`DATA_DIR/editor`; this data is not removed by stopping the editor.

Closing the workspace editor, navigating away, switching machines or logging out
removes its iframe; late startup responses cannot reattach it. Closing the view never
requests an editor stop.
The standalone fullscreen API still supports **Back to Citadel** and a separate explicit
**Stop editor** action. Stopping terminates the IDE process group, including extension
hosts and integrated terminals; save work first. The editor also stops after
15 minutes without requests or connected editor sockets and on clean Citadel
shutdown. A later project action starts it again.

The first implementation supports projects on the Citadel machine serving the
panel. The browser editor transport for paired machines is not implemented;
open that machine's own Citadel panel to edit its projects. Opening an arbitrary
remote path through the old desktop/SSH link has been removed.

## Access and limitations

All editor setup, open, HTTP asset and WebSocket routes require an administrator
session. Citadel verifies the initial folder against the registered project and
managed project tree, then proxies the IDE through the same authenticated panel
origin. Its backend listens only on loopback with an unpredictable password.
The backend session cookie stays server-side; Citadel session cookies and bearer
tokens are not forwarded to it. Unexpected origins are rejected. The built-in
code-server port proxy is disabled, and telemetry/update checks are off.

This editor has the privileges of the Citadel service account, including the
ability to execute commands and browse other accessible files. It is not a
project sandbox or a separate user account. Installed extensions share that
access. Code-server uses its own extension ecosystem, which differs from the
Microsoft Marketplace; see the [upstream FAQ](https://coder.com/docs/code-server/FAQ).
A full IDE costs substantially more resources than Citadel's built-in file editor;
keep it optional on small hosts. Some IDE features require a secure HTTPS browser
context, as described in the [upstream guide](https://coder.com/docs/code-server/guide).

Tests cover administrator/origin checks, HTTP and binary WebSocket forwarding,
credential filtering, managed project paths, checksums, lifecycle and the return
button, as well as the absence of retired OpenCode GUI/root proxy routes.
No real browser was exercised for this documentation update; real macOS and
paired-machine editor transport remain unverified.
