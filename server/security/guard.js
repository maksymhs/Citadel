/**
 * Citadel Security Guards & Path Traversal Protection
 */
const path = require('node:path');
const fs = require('node:fs');
const { PROJECTS_DIR, ALLOWED_ORIGINS } = require('../config');

/**
 * Validates that a requested path resolves to a safe directory inside allowed bases.
 * Prevents directory traversal, '../', and sneaky symlink escapes.
 */
function validateSafePath(targetPath, allowedBase = PROJECTS_DIR) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error('Invalid path provided.');
  }

  // Resolve absolute path
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(allowedBase);

  // If path exists on disk, check canonical realpath
  if (fs.existsSync(resolvedTarget)) {
    const canonicalTarget = fs.realpathSync(resolvedTarget);
    const canonicalBase = fs.existsSync(resolvedBase) ? fs.realpathSync(resolvedBase) : resolvedBase;

    if (!canonicalTarget.startsWith(canonicalBase)) {
      throw new Error(`Path traversal denied: path escapes allowed base directory.`);
    }
    return canonicalTarget;
  }

  // If creating new path, check resolved parent
  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error(`Path traversal denied: target path is outside allowed base directory.`);
  }

  return resolvedTarget;
}

/**
 * Validates project slug (alphanumeric, dashes, underscores)
 */
function sanitizeSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('Slug must be a non-empty string.');
  }
  const clean = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (clean.length < 2 || clean.length > 64) {
    throw new Error('Slug must be between 2 and 64 characters.');
  }
  return clean;
}

/**
 * Validates domain name (FQDN format)
 */
function validateDomain(domain) {
  if (!domain || typeof domain !== 'string') {
    throw new Error('Domain name is required.');
  }
  const clean = domain.trim().toLowerCase();
  const domainRegex = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,11}$/;
  if (!domainRegex.test(clean)) {
    throw new Error(`Invalid domain name format: "${domain}"`);
  }
  return clean;
}

/**
 * Validates origin header for WebSocket connections
 */
function isAllowedOrigin(originHeader) {
  if (!originHeader) {
    // Some local clients/scripts might omit origin; in dev allow, in prod check
    return true;
  }

  try {
    const originUrl = new URL(originHeader);
    const originHost = `${originUrl.protocol}//${originUrl.host}`;

    for (const allowed of ALLOWED_ORIGINS) {
      if (allowed === '*' || allowed === originHost || allowed === originUrl.origin) {
        return true;
      }
      // Also allow localhost/127.0.0.1 on the same port
      if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  validateSafePath,
  sanitizeSlug,
  validateDomain,
  isAllowedOrigin,
};
