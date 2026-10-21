// Citadel menu bar icon (macOS). A tiny status-bar app: shows whether the panel
// answers, opens the dashboard in the browser and starts / stops / restarts the
// service through the `citadel` CLI. Built on the user's Mac by
// scripts/menubar-macos.sh (needs the Xcode Command Line Tools: swiftc).
//
// Environment (set by the LaunchAgent): CITADEL_PORT, CITADEL_CLI, CITADEL_LOG.
import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let env = ProcessInfo.processInfo.environment
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let statusLine = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
    private let openItem = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "o")
    private let toggleItem = NSMenuItem(title: "Stop Citadel", action: #selector(toggleService), keyEquivalent: "")
    private let restartItem = NSMenuItem(title: "Restart Citadel", action: #selector(restartService), keyEquivalent: "")
    private let logItem = NSMenuItem(title: "Open Log", action: #selector(openLog), keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Menu Icon", action: #selector(quitIcon), keyEquivalent: "q")
    private var running = false
    private var busy = false
    private var timer: Timer?

    private var port: String { env["CITADEL_PORT"] ?? "3000" }
    private var cliPath: String { env["CITADEL_CLI"] ?? (NSHomeDirectory() + "/.local/bin/citadel") }
    private var panelURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let button = item.button {
            if #available(macOS 11.0, *),
               let image = NSImage(systemSymbolName: "shield.fill", accessibilityDescription: "Citadel") {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "Citadel"
            }
            button.toolTip = "Citadel"
        }
        statusLine.isEnabled = false
        for entry in [openItem, toggleItem, restartItem, logItem, quitItem] { entry.target = self }
        menu.addItem(statusLine)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(openItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(toggleItem)
        menu.addItem(restartItem)
        menu.addItem(logItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(quitItem)
        item.menu = menu
        apply(running: false, checked: false)
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    // Ask the panel itself: running means "answers on its port", not "has a PID".
    private func refresh() {
        var request = URLRequest(url: panelURL.appendingPathComponent("api/auth/status"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { self?.apply(running: ok, checked: true) }
        }.resume()
    }

    private func apply(running isRunning: Bool, checked: Bool) {
        running = isRunning
        if !checked {
            statusLine.title = "Citadel — checking…"
        } else {
            statusLine.title = isRunning ? "Citadel is running" : "Citadel is stopped"
        }
        openItem.isEnabled = isRunning
        restartItem.isEnabled = !busy
        toggleItem.title = isRunning ? "Stop Citadel" : "Start Citadel"
        toggleItem.isEnabled = !busy
        item.button?.appearsDisabled = checked && !isRunning
        item.button?.toolTip = isRunning ? "Citadel is running" : "Citadel is stopped"
    }

    // Runs `citadel <command>` and re-checks the panel when it finishes.
    private func runCLI(_ command: String) {
        guard !busy else { return }
        busy = true
        apply(running: running, checked: true)
        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: self.cliPath)
            process.arguments = [command]
            var environment = self.env
            environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                self.busy = false
                self.refresh()
            }
        }
    }

    @objc private func openDashboard() { NSWorkspace.shared.open(panelURL) }
    @objc private func toggleService() { runCLI(running ? "stop" : "start") }
    @objc private func restartService() { runCLI("restart") }

    @objc private func openLog() {
        if let path = env["CITADEL_LOG"] { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
    }

    @objc private func quitIcon() { NSApplication.shared.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
