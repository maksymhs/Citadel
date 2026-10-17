#!/usr/bin/env node
/**
 * Citadel System Doctor & Diagnostic Tool
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

console.log('====================================================');
console.log('       Citadel — System Diagnostics                 ');
console.log('====================================================\n');

let passCount = 0;
let warnCount = 0;
let failCount = 0;

function report(status, label, detail) {
  if (status === 'PASS') {
    passCount++;
    console.log(`\x1b[32m[✓ PASS]\x1b[0m ${label} — ${detail}`);
  } else if (status === 'WARN') {
    warnCount++;
    console.log(`\x1b[33m[! WARN]\x1b[0m ${label} — ${detail}`);
  } else {
    failCount++;
    console.log(`\x1b[31m[✗ FAIL]\x1b[0m ${label} — ${detail}`);
  }
}

// 1. Check Node.js
const nodeVer = process.version;
const major = parseInt(nodeVer.slice(1).split('.')[0], 10);
if (major >= 18) {
  report('PASS', 'Node.js Runtime', `${nodeVer} (compatible)`);
} else {
  report('FAIL', 'Node.js Runtime', `${nodeVer} (requires Node.js >= 18 LTS)`);
}

// 2. Check System Memory
const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
if (totalMemMB >= 500) {
  report('PASS', 'System Memory', `${totalMemMB} MB total (${freeMemMB} MB free)`);
} else {
  report('WARN', 'System Memory', `${totalMemMB} MB total (at least 512 MB recommended)`);
}

// 3. Check tmux
try {
  const tmuxRes = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (tmuxRes.status === 0) {
    report('PASS', 'tmux (Persistence)', tmuxRes.stdout.trim());
  } else {
    report('WARN', 'tmux (Persistence)', 'Not available. Terminals will use direct PTY without persistence across restarts.');
  }
} catch {
  report('WARN', 'tmux (Persistence)', 'tmux not found in PATH.');
}

// 4. Check Git
try {
  const gitRes = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitRes.status === 0) {
    report('PASS', 'Git CLI', gitRes.stdout.trim());
  } else {
    report('FAIL', 'Git CLI', 'Git is not available in PATH.');
  }
} catch {
  report('FAIL', 'Git CLI', 'Could not invoke git.');
}

// 5. Check AI Agents
const agents = ['claude', 'codex', 'opencode'];
const detectedAgents = [];
for (const agent of agents) {
  try {
    const res = spawnSync('which', [agent], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim()) {
      detectedAgents.push(`${agent} (${res.stdout.trim()})`);
    }
  } catch {
    // Ignore
  }
}
if (detectedAgents.length > 0) {
  report('PASS', 'AI Agents detected', detectedAgents.join(', '));
} else {
  report('WARN', 'AI Agents detected', 'No agent in PATH (install claude, codex or opencode whenever you want to use them)');
}

// 6. Check Caddy (Optional)
try {
  const caddyRes = spawnSync('caddy', ['version'], { encoding: 'utf8' });
  if (caddyRes.status === 0) {
    report('PASS', 'Caddy Proxy', `${caddyRes.stdout.trim()} (optional)`);
  } else {
    report('WARN', 'Caddy Proxy', 'Not installed. Automatic domain mapping and HTTPS will be inactive (optional).');
  }
} catch {
  report('WARN', 'Caddy Proxy', 'Not installed (optional). The panel works without a proxy.');
}

// 7. Check Docker (Optional)
try {
  const dockerRes = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (dockerRes.status === 0) {
    report('PASS', 'Docker Engine', `${dockerRes.stdout.trim()} (optional)`);
  } else {
    report('WARN', 'Docker Engine', 'Not installed (optional).');
  }
} catch {
  report('WARN', 'Docker Engine', 'Not installed (optional).');
}

// 8. Check Directories & DB Write Integrity
const dataDir = path.resolve(__dirname, '../data');
try {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const testFile = path.join(dataDir, '.write-test');
  fs.writeFileSync(testFile, 'ok');
  fs.unlinkSync(testFile);
  report('PASS', 'Storage Permissions', `Write verified at ${dataDir}`);
} catch (err) {
  report('FAIL', 'Storage Permissions', `Write error at ${dataDir}: ${err.message}`);
}

// 9. Check Vendor Assets
const vendorDir = path.resolve(__dirname, '../public/vendor');
const requiredVendor = ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-web-links.js'];
const missingVendor = requiredVendor.filter((f) => !fs.existsSync(path.join(vendorDir, f)));
if (missingVendor.length === 0) {
  report('PASS', 'Local Assets (xterm.js)', 'All vendor bundles are in public/vendor/ (0 CDNs)');
} else {
  report('FAIL', 'Local Assets (xterm.js)', `Missing files: ${missingVendor.join(', ')}. Run: npm run postinstall`);
}

console.log('\n====================================================');
console.log(`Diagnostics complete: ${passCount} passed, ${warnCount} warnings, ${failCount} failures`);
console.log('====================================================\n');

process.exit(failCount > 0 ? 1 : 0);
