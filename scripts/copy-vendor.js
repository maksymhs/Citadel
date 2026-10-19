/**
 * Copies frontend vendor assets (xterm.js, addons, css) into public/vendor
 * to eliminate external CDN dependencies in production.
 */
const fs = require('node:fs');
const path = require('node:path');

const targetDir = path.resolve(__dirname, '../public/vendor');
fs.mkdirSync(targetDir, { recursive: true });

const copies = [
  {
    src: path.resolve(__dirname, '../node_modules/@xterm/xterm/lib/xterm.js'),
    dest: path.join(targetDir, 'xterm.js'),
  },
  {
    src: path.resolve(__dirname, '../node_modules/@xterm/xterm/css/xterm.css'),
    dest: path.join(targetDir, 'xterm.css'),
  },
  {
    src: path.resolve(__dirname, '../node_modules/@xterm/addon-fit/lib/addon-fit.js'),
    dest: path.join(targetDir, 'addon-fit.js'),
  },
  {
    src: path.resolve(__dirname, '../node_modules/@xterm/addon-web-links/lib/addon-web-links.js'),
    dest: path.join(targetDir, 'addon-web-links.js'),
  },
  {
    src: path.resolve(__dirname, '../node_modules/jsqr/dist/jsQR.js'),
    dest: path.join(targetDir, 'jsQR.js'),
  },
  {
    src: path.resolve(__dirname, '../node_modules/wunderbaum/dist/wunderbaum.umd.js'),
    dest: path.join(targetDir, 'wunderbaum.umd.js'),
  },
  {
    src: path.resolve(__dirname, '../node_modules/wunderbaum/dist/wunderbaum.css'),
    dest: path.join(targetDir, 'wunderbaum.css'),
  },
];

for (const item of copies) {
  if (fs.existsSync(item.src)) {
    fs.copyFileSync(item.src, item.dest);
    console.log(`Copied: ${path.basename(item.src)} -> public/vendor/`);
  } else {
    console.warn(`Source not found: ${item.src}`);
  }
}

// Ensure node-pty spawn-helper binaries have executable permissions (+x).
// Linux installs compile into build/Release; packaged installs ship prebuilds.
const rootDir = path.resolve(__dirname, '..');
const spawnHelpers = [
  path.resolve(rootDir, 'node_modules/node-pty/build/Release/spawn-helper'),
];
try {
  const ptyPrebuilds = path.resolve(rootDir, 'node_modules/node-pty/prebuilds');
  if (fs.existsSync(ptyPrebuilds)) {
    for (const entry of fs.readdirSync(ptyPrebuilds, { recursive: true })) {
      if (entry.includes('spawn-helper')) {
        spawnHelpers.push(path.join(ptyPrebuilds, entry));
      }
    }
  }
  for (const helper of spawnHelpers) {
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log(`Ensured executable permissions on: ${path.relative(rootDir, helper)}`);
    }
  }
} catch (err) {
  console.warn(`[postinstall] Could not chmod spawn-helper: ${err.message}`);
}

console.log('Vendor assets copied and configured successfully.');
