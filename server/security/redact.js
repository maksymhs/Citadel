/**
 * Shared redaction for text that may reach prompts, Markdown notes, logs or
 * learning memory. It is deliberately small and deterministic: no model call,
 * no second copy of the original, and no attempt to preserve a credential.
 *
 * Callers keep their own length limits. This module only removes values that
 * look like tokens/passwords and truncates to the requested maximum.
 */
const DEFAULT_MAX = 4000;

function scrub(value, max = DEFAULT_MAX) {
  if (value === undefined || value === null) return '';
  let text = String(value);
  text = text.replace(/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g, '[REDACTED]');
  text = text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})/g, '[REDACTED]');
  // Consume quoted values as a unit (including escaped quotes), and preserve
  // JSON key quotes. Schemes must be consumed with their credentials too.
  text = text.replace(/\b(password|passwd|secret|token|api[_-]?key|cookie|authorization)\b(["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|(?:Bearer|Basic)\s+[^\s,;}]+|[^\s,;}]+)/gi, (match, key, separator, value) => {
    const scheme = value.match(/^(Bearer|Basic)\s+/i);
    const quote = /^["']/.test(value) ? value[0] : '';
    return `${key}${separator}${scheme ? scheme[0] : ''}${quote}[REDACTED]${quote}`;
  });
  text = text.replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, '[REDACTED]');
  return text.trim().slice(0, max);
}

module.exports = { scrub };
