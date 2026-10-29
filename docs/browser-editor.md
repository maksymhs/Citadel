# Native Chat and browser VS Code

## Sidebar space

Use the toggle beside the page title to open or close the sidebar. Desktop starts
with the sidebar visible and remembers your choice in this browser per signed-in
owner and panel origin, independently of project, machine and workspace mode.
Choosing Chat, Terminal or VS Code never folds it automatically. On mobile the
same button opens the existing overlay; navigation, backdrop click or Escape
closes it without changing the desktop preference. Hidden navigation is excluded
from keyboard focus; closing it while focused inside returns focus to the toggle.

## Projects and removal

New browser sessions start in Projects; an existing saved screen is restored.
System (host) is always the first Projects card and is not listed under Workspace.
Workspace appears only for projects with observed live terminals, your running
Chat engine, or a running shared editor plus this browser's opened-project hint.
Saved mode and chat history alone do not mark a project open. VS Code hints are
not authoritative: another tab can open a folder, and closing an iframe does not
prove that its folder is closed in the shared editor. Unavailable status is not
reported as stopped.

**Remove from Citadel** sends `deleteFiles=false` and preserves files on disk.
**Delete project files from disk** is a separate action requiring the exact path.
Both recheck status before submitting. The server rejects live registered project
terminals or a running project Chat engine for any owner, without exposing owner
or session details. Chat removal checks and synchronous deletion share the engine
queue, so Chat startup cannot interleave. Because shared VS Code cannot report
which project folders remain open, removal conservatively requires the shared
editor to be stopped, including when it was opened from another project. This
is not a guarantee that arbitrary host processes are idle. Existing managed-tree
restrictions still apply to explicit disk deletion.

## Native Chat

The composer supports `/new`, `/reset`, `/context`, `/model` and `/help` with
keyboard suggestions. `/reset` confirms a new session, retaining history and
never cancelling active work; busy engines reject session creation. `/context`
reports bounded latest-assistant counters and configured gateway model limits,
not a live context percentage or session total. `/model` shows gateway aliases
and can switch Plan/Build when idle, not select a native provider. Commands and
unknown slash input never reach the model. Tool activity exposes names/status
only, not raw tool inputs; permission requests remain separate approvals.

On first opening a project, choose a centered **Chat**, **Terminal** or **VS Code**
card. No terminal, Chat session or editor starts until you select a mode. The selection
is remembered per signed-in owner, panel instance, selected host and project, including
existing Terminal/Chat preferences. Use the sidebar's three-dot workspace menu or
**Projects → More actions** to switch modes; there is no workspace mode toolbar.
An already mounted terminal stays mounted when switching modes. Entering a workspace
remembered in Chat or VS Code does not create or attach a terminal.
The **Choose mode** back button in Citadel's global header appears
only in a selected project mode. It clears only the mode preference and returns to the cards;
terminal and Chat session selections, drafts and running work are retained. Navigating
away closes the view but remembers the mode. There is no Chat toolbar above the conversation.
Each chooser card has a separate stop button and read-only running status; checking
status never starts a mode. Stops require confirmation. **Stop terminals** terminates
only the alive registered terminal sessions listed for this project (not arbitrary
host processes). **Stop Chat** cancels the signed-in owner's active work and stops
only the matching owner/project/canonical-directory engine, preserving saved histories.
It refuses unowned busy sessions and reports engine/abort failures rather than claiming
success. **Stop shared editor** stops the one VS Code process for **all projects**,
including its integrated terminals and extension hosts; save work first. These controls
are disabled when nothing is running or status is unavailable. Chat/editor management
requires a local administrator session. No process is stopped by merely returning here.
This is not an embedded
OpenCode GUI: the old GUI, bundle adapter, `/opencode/*`, `/api/opencode-web` and
root API proxies have been removed. VS Code and native terminal agents remain available.

Chat is administrator-only and **AI Gateway only**. In **Settings → AI Gateway**,
explicitly connect your Claude and/or ChatGPT accounts, choose a route, select
**OpenCode** under **Choose your tools**, save and enable the gateway. Chat reuses
those connected subscriptions and shared planning/execution/background aliases;
it does not import CLI login caches or fall back to native providers. Account
entitlement and third-party compatibility remain experimental. A missing or stopped
gateway produces an error. Engine failures identify the operation and HTTP status,
empty/invalid/oversized response or connection/timeout failure without exposing
upstream bodies, credentials or session IDs. An engine 404 for a saved session asks
you to create a new chat. See [AI Gateway](ai-gateway.md).

Fresh Citadel installs still include the OpenCode CLI, without auto-starting it;
install or update it through Settings → Tools if needed. Native Chat requires
**OpenCode 1.19.x** and checks the server's API document for session, async prompt,
status, SSE, permission and question endpoints. Other versions or missing API
operations fail explicitly. This API check does not depend on an OpenCode frontend
bundle and is not a guarantee that every 1.19.x build works end to end.

Chat uses Citadel's dark/light theme colors, a centered conversation with avatars,
collapsed tool activity and a rounded, auto-growing composer. The welcome screen
suggestions fill a draft only; they never submit a prompt automatically. The composer
stays visible on mobile while messages scroll independently.

Opening Chat resumes the remembered session if it is still in the server's project
list, otherwise the most recently updated session, or creates one if the list is empty.
Reconnecting rereads that list. Workspace mode, terminal ID and Chat session ID are
stored in browser localStorage, scoped to signed-in owner, panel instance, selected
host and project; stored IDs are selection hints, never authorization. Draft text and
Plan/Build choice stay in page memory per scope, survive mode/project navigation,
and are cleared on logout or machine switch (also lost on reload). They are never
written to localStorage. The project name appears only as subtle welcome context.
Use **Chat options → New chat** or **Session history** to start another conversation
or select an older one.
**Build** uses the execution alias;
**Plan** uses the planning alias and denies edit, bash, task and external-directory
permissions. Other permissions default to **ask**. Chat displays **Allow once** or
**Reject**, plus question choices/custom answers and question rejection; it does
not offer permanent permission grants. Send with the button or **Ctrl/Cmd+Enter**;
Enter inserts a newline. **Stop** requests cancellation of the selected session.
Returning to the terminal, navigating away or losing the connection does not cancel
an agent; it may still be running.

Live updates use session-scoped SSE notifications followed by bounded snapshots,
not a raw OpenCode event/API proxy. EventSource reconnects and refreshes state;
inline composer notices appear only for errors or required input, with **Settings**
and **Reconnect** available there rather than in a persistent status strip.
**Reconnect** reloads sessions, and online/tab-return handling refreshes the
selection. Sending and approvals wait for fresh state after a disconnect. The UI
shows at most the latest 100 messages, with bounded parts/text and tool names/status,
not a full transcript or full tool output. Text is rendered literally with fenced
code blocks, not full Markdown or HTML. There is no complete-history browsing or
full OpenCode GUI feature-parity promise.

Session ownership is private to the signed-in administrator, registered project
and canonical directory. Metadata and request deduplication live in
`DATA_DIR/chat/metadata.sqlite` (WAL), separate from Citadel's main schema and
migrations. OpenCode transcripts and state persist in a hashed per-owner/project/
directory HOME under `DATA_DIR/chat`, with separate XDG directories; terminal
conversations and interactive model overrides are not copied. One engine runs at
a time; busy work or pending approvals must be finished or cancelled before
switching owners/projects or starting another session. Clean Citadel shutdown
stops its process group but retains Chat storage.

The engine runs `opencode serve` only on loopback with a random password and a
restricted launch environment, with project config, external skills and Claude
Code configuration loading disabled. This logical separation is **not an OS
sandbox**: the engine and approved tools have the Citadel service account's file
and command privileges. Chat metadata/transcripts are not encrypted by the Chat
service; protect backups as sensitive data. Paired-machine Chat transport is not
supported: open that machine's own Citadel panel. Automated fixtures/jsdom and an
isolated installed-OpenCode capability/session/snapshot check cover the current
implementation; no real model prompt or browser validation is claimed for native Chat.

## Browser VS Code

From **Projects → More actions → Open VS Code in browser**, Citadel opens an
optional [code-server](https://github.com/coder/code-server) editor inside the
project workspace, not a fullscreen overlay. You can also choose **VS Code** from
the workspace cards, terminal toolbar or sidebar three-dot menu. Embedded VS Code
uses the global header's close action, without a duplicate internal return header.
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
button, as well as the absence of retired OpenCode GUI/root proxy routes. Earlier
Linux code-server browser checks do not verify the current native Chat implementation.
No real browser was exercised for this documentation update; real macOS and
paired-machine editor transport remain unverified.
