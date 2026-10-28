# Browser VS Code and OpenCode web

From **Projects → More actions → Open OpenCode in browser**, or the **OpenCode**
button in a project terminal, Citadel starts OpenCode's web interface in that
project, inside Citadel's main workspace with its navigation still available.
The server creates and verifies a separate web session in the selected project
folder; reopening the same running project resumes that session. **Return to
Terminal** restores the mounted terminal without restarting it. Navigating elsewhere
closes the panel, not the OpenCode process. Switching projects restarts the shared
web server and rejects stale project URLs.

The GUI inherits the same configured model defaults as terminal-launched OpenCode.
If OpenCode is enabled in AI Gateway, it uses the same private launcher and
Build/Plan/small model aliases; an opted-in but stopped gateway produces an error.
Otherwise native OpenCode configuration applies. Transient model selections or
explicit model arguments in another terminal and its conversation are not copied.
Fresh Citadel installs include the OpenCode CLI; it is not auto-started.
Citadel runs `opencode serve` on loopback with a generated password and proxies
HTTP and WebSocket traffic through the authenticated panel. **Stop OpenCode**
terminates that process; clean shutdown also stops it. Only local projects are
supported; for paired machines, open that machine's panel. OpenCode shares the
Citadel service account's file and command privileges and is not a sandbox.
OpenCode's root-level API routes (including `/provider`, `/path`, `/session` and
`/project`) are forwarded only for the active project's GUI Referer and an
administrator session; unrelated Citadel routes retain their normal handling.
The GUI adapter keeps routing, API requests and assets under the project URL.
It accepts only the reviewed frontend bundle observed with OpenCode server 1.19.3
(frontend 1.19.2); other builds show a compatibility error instead of an empty
screen. Recheck compatibility before updating OpenCode independently. Desktop
and emulated mobile navigation, drafts, session reloads, workers and SSE were
verified with that build. Native new-tab/middle-click session links and live model
conversations remain unverified; use ordinary in-frame navigation for now.

From **Projects → More actions → Open VS Code in browser**, Citadel opens an
optional [code-server](https://github.com/coder/code-server) editor inside the
same browser. You can also click **VS Code** directly in a project terminal
toolbar. No desktop VS Code installation or SSH configuration is required.
The **Back to Citadel** button remains above the editor and restores the panel
exactly where you left it.

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

**Back to Citadel** hides the editor without killing ongoing work. **Stop editor**
terminates the IDE and its process group, including its extension hosts and
integrated terminals. Save work before stopping it. The editor also stops after
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
button. A real isolated Linux code-server install, Chrome workbench load, file edit/save
and return to Citadel were also exercised; no browser errors or editor processes
remained after clean shutdown. Real macOS and paired-machine editor transport remain unverified.
