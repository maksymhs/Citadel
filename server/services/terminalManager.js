/**
 * NexusVPS Terminal & Session Manager
 * Backed by node-pty and tmux for persistent, reconnectable sessions
 */
const pty = require('node-pty');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getDatabase } = require('../database/db');
const { TMUX_PATH } = require('../config');

class TerminalManager {
  constructor() {
    this.activePtySessions = new Map(); // sessionId -> { ptyProcess, buffer: [], clients: Set<WebSocket>, tmuxSession, cwd, projectId }
    this._tmuxChecked = false;
    this._tmuxAvailable = false;
    this._resolvedTmuxPath = null;
  }

  /**
   * Resolve absolute path to tmux binary
   */
  getTmuxPath() {
    if (this._resolvedTmuxPath) return this._resolvedTmuxPath;
    if (path.isAbsolute(TMUX_PATH) && fs.existsSync(TMUX_PATH)) {
      this._resolvedTmuxPath = TMUX_PATH;
      return TMUX_PATH;
    }
    try {
      const res = spawnSync('which', ['tmux'], { encoding: 'utf8' });
      if (res.status === 0 && res.stdout) {
        const found = res.stdout.trim().split('\n')[0];
        if (fs.existsSync(found)) {
          this._resolvedTmuxPath = found;
          return found;
        }
      }
    } catch {
      // Ignore
    }
    const candidates = ['/usr/local/bin/tmux', '/usr/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux'];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this._resolvedTmuxPath = c;
        return c;
      }
    }
    this._resolvedTmuxPath = TMUX_PATH;
    return TMUX_PATH;
  }

  /**
   * Check whether tmux is installed and executable
   */
  isTmuxAvailable() {
    if (this._tmuxChecked) {
      return this._tmuxAvailable;
    }
    try {
      const tmuxBin = this.getTmuxPath();
      const res = spawnSync(tmuxBin, ['-V'], { stdio: 'pipe' });
      this._tmuxAvailable = res.status === 0;
    } catch {
      this._tmuxAvailable = false;
    }
    this._tmuxChecked = true;
    return this._tmuxAvailable;
  }

  /**
   * Check if a tmux session is alive on the system
   */
  hasTmuxSession(sessionName) {
    if (!this.isTmuxAvailable()) return false;
    try {
      const res = spawnSync(this.getTmuxPath(), ['has-session', '-t', sessionName], { stdio: 'pipe' });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get or create a terminal session for a project
   */
  createSession({ projectId = null, name = 'Terminal', cwd = null, agentId = null, cols = 80, rows = 24 }) {
    const db = getDatabase();
    let targetCwd = cwd || process.cwd();
    let projectSlug = 'global';

    if (projectId) {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
      if (project) {
        projectSlug = project.slug;
        targetCwd = project.path;
      }
    }

    if (!fs.existsSync(targetCwd)) {
      fs.mkdirSync(targetCwd, { recursive: true });
    }

    const sessionId = crypto.randomUUID();
    const shortId = sessionId.split('-')[0];
    const sanitizedSlug = projectSlug.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmuxSessionName = `citadel_${sanitizedSlug}_${shortId}`;

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO term_sessions (id, project_id, name, tmux_session, agent_id, status, created_at, last_active)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(sessionId, projectId, name, tmuxSessionName, agentId, now, now);

    // Spawn the PTY
    this._spawnPty({
      sessionId,
      projectId,
      tmuxSessionName,
      cwd: targetCwd,
      cols,
      rows,
    });

    return {
      sessionId,
      projectId,
      name,
      tmuxSession: tmuxSessionName,
      hasTmux: this.isTmuxAvailable(),
      cwd: targetCwd,
      status: 'active',
      createdAt: now,
    };
  }

  /**
   * Spawns node-pty instance, wrapped in tmux if available
   */
  _spawnPty({ sessionId, projectId, tmuxSessionName, cwd, cols = 80, rows = 24, command = null, args = [] }) {
    // If PTY already exists, don't spawn duplicate
    if (this.activePtySessions.has(sessionId)) {
      return this.activePtySessions.get(sessionId);
    }

    const useTmux = this.isTmuxAvailable();
    let file;
    let spawnArgs;

    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    };

    if (useTmux) {
      file = this.getTmuxPath();
      // Start or attach to tmux session, setting the initial directory
      if (command) {
        // Run specific command inside the tmux session
        spawnArgs = ['new-session', '-A', '-s', tmuxSessionName, '-c', cwd, command, ...args];
      } else {
        spawnArgs = ['new-session', '-A', '-s', tmuxSessionName, '-c', cwd];
      }
    } else {
      // Direct shell fallback
      const defaultShell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
      file = defaultShell;
      spawnArgs = command ? ['-c', [command, ...args].join(' ')] : [];
    }

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(file, spawnArgs, {
        name: 'xterm-256color',
        cols: Math.max(cols || 80, 20),
        rows: Math.max(rows || 24, 10),
        cwd,
        env,
      });
    } catch (err) {
      console.error(`[TerminalManager] Failed to spawn PTY: ${err.message}`);
      // Fallback to /bin/sh if custom shell/tmux failed
      ptyProcess = pty.spawn('/bin/sh', [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd,
        env,
      });
    }

    const sessionData = {
      sessionId,
      projectId,
      tmuxSession: tmuxSessionName,
      cwd,
      ptyProcess,
      clients: new Set(),
      buffer: '', // Ring buffer for reconnects (max 64KB)
      maxBufferSize: 64 * 1024,
    };

    ptyProcess.onData((data) => {
      // Append to ring buffer
      sessionData.buffer += data;
      if (sessionData.buffer.length > sessionData.maxBufferSize) {
        sessionData.buffer = sessionData.buffer.slice(-sessionData.maxBufferSize);
      }

      // Broadcast to connected WebSocket clients
      for (const ws of sessionData.clients) {
        if (ws.readyState === 1 /* OPEN */) {
          try {
            ws.send(JSON.stringify({ type: 'output', data }));
          } catch {
            // Socket write error, client cleanup will handle
          }
        }
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[TerminalManager] PTY exited for session ${sessionId} (code ${exitCode}, signal ${signal})`);
      this.activePtySessions.delete(sessionId);

      // If tmux was NOT used or tmux session is gone, mark session closed in DB
      if (!useTmux || !this.hasTmuxSession(tmuxSessionName)) {
        try {
          const db = getDatabase();
          db.prepare("UPDATE term_sessions SET status = 'closed' WHERE id = ?").run(sessionId);
        } catch {
          // Ignore DB error during shutdown
        }
      }

      // Notify clients
      for (const ws of sessionData.clients) {
        if (ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
          } catch {
            // Ignore
          }
        }
      }
    });

    this.activePtySessions.set(sessionId, sessionData);
    return sessionData;
  }

  /**
   * Connects a WebSocket client to a terminal session.
   * Restores output buffer and enables real-time duplex communication.
   */
  attachClient(sessionId, ws) {
    let sessionData = this.activePtySessions.get(sessionId);

    // If PTY is not in memory, check if tmux session is still alive in the OS
    if (!sessionData) {
      const db = getDatabase();
      const sessionRow = db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(sessionId);
      if (!sessionRow) {
        ws.send(JSON.stringify({ type: 'error', message: 'Terminal session not found.' }));
        ws.close();
        return;
      }

      let cwd = process.cwd();
      if (sessionRow.project_id) {
        const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(sessionRow.project_id);
        if (project && fs.existsSync(project.path)) {
          cwd = project.path;
        }
      }

      // Re-spawn PTY attached to existing or new tmux session
      sessionData = this._spawnPty({
        sessionId: sessionRow.id,
        projectId: sessionRow.project_id,
        tmuxSessionName: sessionRow.tmux_session,
        cwd,
      });
    }

    sessionData.clients.add(ws);

    // Send initial handshake and replay buffer
    ws.send(JSON.stringify({
      type: 'connected',
      sessionId,
      tmuxSession: sessionData.tmuxSession,
    }));

    if (sessionData.buffer.length > 0) {
      ws.send(JSON.stringify({
        type: 'output',
        data: sessionData.buffer,
      }));
    }

    // Handle incoming client messages
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && typeof msg.data === 'string') {
          sessionData.ptyProcess.write(msg.data);
        } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          const safeCols = Math.min(Math.max(msg.cols, 10), 300);
          const safeRows = Math.min(Math.max(msg.rows, 5), 150);
          sessionData.ptyProcess.resize(safeCols, safeRows);
        }
      } catch (err) {
        console.warn(`[TerminalManager] Invalid WS message from client:`, err.message);
      }
    });

    ws.on('close', () => {
      sessionData.clients.delete(ws);
      // PTY keeps running in background so long tasks don't terminate!
    });
  }

  /**
   * Terminate a terminal session, kill PTY and tmux session
   */
  killSession(sessionId) {
    const db = getDatabase();
    const sessionRow = db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(sessionId);

    // Kill in-memory PTY
    const active = this.activePtySessions.get(sessionId);
    if (active) {
      try {
        active.ptyProcess.kill();
      } catch {
        // Ignore
      }
      this.activePtySessions.delete(sessionId);
    }

    // Kill tmux session if alive
    const tmuxName = sessionRow ? sessionRow.tmux_session : (active ? active.tmuxSession : null);
    if (tmuxName && this.isTmuxAvailable()) {
      try {
        spawnSync(this.getTmuxPath(), ['kill-session', '-t', tmuxName], { stdio: 'ignore' });
      } catch {
        // Ignore
      }
    }

    // Update DB
    db.prepare("UPDATE term_sessions SET status = 'closed' WHERE id = ?").run(sessionId);

    return { success: true, sessionId };
  }

  /**
   * List sessions, indicating live status
   */
  listSessions(projectId = null) {
    const db = getDatabase();
    const query = projectId
      ? 'SELECT * FROM term_sessions WHERE project_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM term_sessions ORDER BY created_at DESC';
    const rows = projectId ? db.prepare(query).all(projectId) : db.prepare(query).all();

    return rows.map((r) => {
      const isPtyAlive = this.activePtySessions.has(r.id);
      const isTmuxAlive = this.hasTmuxSession(r.tmux_session);
      return {
        ...r,
        isAlive: isPtyAlive || isTmuxAlive,
        isPtyAlive,
        isTmuxAlive,
        connectedClients: isPtyAlive ? this.activePtySessions.get(r.id).clients.size : 0,
      };
    });
  }
}

module.exports = new TerminalManager();
