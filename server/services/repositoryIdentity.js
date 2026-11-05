/** Resolve all worktrees of a repository to one scheduling identity. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function repositoryIdentity(directory) {
  if (!directory) return null;
  let canonical = path.resolve(directory);
  try { canonical = fs.realpathSync(canonical); } catch { return canonical; }
  try {
    return fs.realpathSync(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: canonical, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch { return canonical; }
}
module.exports = { repositoryIdentity };
