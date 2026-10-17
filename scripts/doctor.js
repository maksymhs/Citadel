#!/usr/bin/env node
/**
 * NexusVPS System Doctor & Diagnostic Tool
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

console.log('====================================================');
console.log('       NexusVPS — Diagnóstico del Sistema           ');
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
  report('FAIL', 'Node.js Runtime', `${nodeVer} (requiere Node.js >= 18 LTS)`);
}

// 2. Check System Memory
const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
if (totalMemMB >= 500) {
  report('PASS', 'Memoria RAM', `${totalMemMB} MB total (${freeMemMB} MB libre)`);
} else {
  report('WARN', 'Memoria RAM', `${totalMemMB} MB total (se recomiendan al menos 512 MB)`);
}

// 3. Check tmux
try {
  const tmuxRes = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (tmuxRes.status === 0) {
    report('PASS', 'tmux (Persistencia)', tmuxRes.stdout.trim());
  } else {
    report('WARN', 'tmux (Persistencia)', 'No disponible. Terminales usarán PTY directo sin persistencia ante reinicios.');
  }
} catch {
  report('WARN', 'tmux (Persistencia)', 'tmux no encontrado en PATH.');
}

// 4. Check Git
try {
  const gitRes = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (gitRes.status === 0) {
    report('PASS', 'Git CLI', gitRes.stdout.trim());
  } else {
    report('FAIL', 'Git CLI', 'Git no está disponible en PATH.');
  }
} catch {
  report('FAIL', 'Git CLI', 'No se pudo invocar git.');
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
  report('PASS', 'Agentes IA detectados', detectedAgents.join(', '));
} else {
  report('WARN', 'Agentes IA detectados', 'Ningún agente en PATH (instala claude, codex u opencode cuando desees utilizarlos)');
}

// 6. Check Caddy (Optional)
try {
  const caddyRes = spawnSync('caddy', ['version'], { encoding: 'utf8' });
  if (caddyRes.status === 0) {
    report('PASS', 'Caddy Proxy', `${caddyRes.stdout.trim()} (opcional)`);
  } else {
    report('WARN', 'Caddy Proxy', 'No instalado. Mapeo automático de dominios y HTTPS estará inactivo (opcional).');
  }
} catch {
  report('WARN', 'Caddy Proxy', 'No instalado (opcional). El panel funciona sin proxy.');
}

// 7. Check Docker (Optional)
try {
  const dockerRes = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  if (dockerRes.status === 0) {
    report('PASS', 'Docker Engine', `${dockerRes.stdout.trim()} (opcional)`);
  } else {
    report('WARN', 'Docker Engine', 'No instalado (opcional).');
  }
} catch {
  report('WARN', 'Docker Engine', 'No instalado (opcional).');
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
  report('PASS', 'Permisos de Almacenamiento', `Escritura verificada en ${dataDir}`);
} catch (err) {
  report('FAIL', 'Permisos de Almacenamiento', `Error de escritura en ${dataDir}: ${err.message}`);
}

// 9. Check Vendor Assets
const vendorDir = path.resolve(__dirname, '../public/vendor');
const requiredVendor = ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-web-links.js'];
const missingVendor = requiredVendor.filter((f) => !fs.existsSync(path.join(vendorDir, f)));
if (missingVendor.length === 0) {
  report('PASS', 'Assets locales (xterm.js)', 'Todos los bundles vendor están en public/vendor/ (0 CDNs)');
} else {
  report('FAIL', 'Assets locales (xterm.js)', `Faltan archivos: ${missingVendor.join(', ')}. Ejecuta: npm run postinstall`);
}

console.log('\n====================================================');
console.log(`Diagnóstico completado: ${passCount} superadas, ${warnCount} advertencias, ${failCount} fallos`);
console.log('====================================================\n');

process.exit(failCount > 0 ? 1 : 0);
