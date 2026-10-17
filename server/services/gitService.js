/**
 * Citadel Controlled Git Service
 * Structured argument execution preventing shell injection
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

class GitService {
  /**
   * Execute git command with structured array arguments
   */
  _execGit(args, cwd) {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd,
        env: { ...process.env, LC_ALL: 'C' },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `Git exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to execute git: ${err.message}`));
      });
    });
  }

  /**
   * Check if directory is a git repository
   */
  isGitRepo(targetDir) {
    if (!targetDir || !fs.existsSync(targetDir)) return false;
    const gitDir = path.join(targetDir, '.git');
    return fs.existsSync(gitDir);
  }

  /**
   * Clone a remote repository to target directory
   */
  async clone(repoUrl, targetDir, branch = null) {
    if (!repoUrl || typeof repoUrl !== 'string') {
      throw new Error('Repository URL is required.');
    }

    // Basic URL validation
    const cleanUrl = repoUrl.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://') && !cleanUrl.startsWith('git@')) {
      throw new Error('Invalid repository URL. Must start with https://, http://, or git@');
    }

    const args = ['clone'];
    if (branch) {
      args.push('--branch', branch.trim());
    }
    args.push('--', cleanUrl, targetDir);

    const parentDir = path.dirname(targetDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    await this._execGit(args, parentDir);
    return { success: true, targetDir, repoUrl: cleanUrl };
  }

  /**
   * Get branch and working tree status
   */
  async getStatus(repoPath) {
    if (!this.isGitRepo(repoPath)) {
      return { isGitRepo: false };
    }

    try {
      // Get branch
      let branch = 'unknown';
      try {
        branch = await this._execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
      } catch {
        // Empty repo or detached HEAD
      }

      // Get status summary
      const statusOutput = await this._execGit(['status', '--porcelain', '-b'], repoPath);
      const lines = statusOutput.split('\n').filter(Boolean);

      const modified = [];
      const untracked = [];
      let trackingInfo = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (i === 0 && line.startsWith('##')) {
          trackingInfo = line.slice(3).trim();
          continue;
        }
        const status = line.slice(0, 2);
        const file = line.slice(3).trim();
        if (status.includes('?')) {
          untracked.push(file);
        } else {
          modified.push({ status: status.trim(), file });
        }
      }

      // Check remote URL if configured
      let remoteUrl = null;
      try {
        remoteUrl = await this._execGit(['remote', 'get-url', 'origin'], repoPath);
      } catch {
        // No remote configured
      }

      return {
        isGitRepo: true,
        branch,
        trackingInfo,
        remoteUrl,
        isClean: modified.length === 0 && untracked.length === 0,
        modifiedFiles: modified,
        untrackedFiles: untracked,
      };
    } catch (err) {
      return {
        isGitRepo: true,
        error: err.message,
      };
    }
  }

  /**
   * Pull updates from remote
   */
  async pull(repoPath) {
    if (!this.isGitRepo(repoPath)) {
      throw new Error('Not a git repository.');
    }
    const output = await this._execGit(['pull'], repoPath);
    return { success: true, output };
  }

  /**
   * Get recent commits
   */
  async getRecentCommits(repoPath, limit = 10) {
    if (!this.isGitRepo(repoPath)) {
      return [];
    }

    try {
      const output = await this._execGit([
        'log',
        `-${Math.min(limit, 50)}`,
        '--pretty=format:%H|%an|%ae|%ad|%s',
        '--date=iso',
      ], repoPath);

      if (!output) return [];

      return output.split('\n').map((line) => {
        const [hash, authorName, authorEmail, date, subject] = line.split('|');
        return {
          hash,
          shortHash: hash ? hash.slice(0, 7) : '',
          authorName,
          authorEmail,
          date,
          subject,
        };
      });
    } catch {
      return [];
    }
  }
}

module.exports = new GitService();
