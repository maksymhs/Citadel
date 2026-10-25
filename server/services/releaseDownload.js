/** Streams pinned GitHub release assets to private files with bounded size and SHA-256. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
async function downloadRelease(url, destination, sha256, { maxBytes = 300 * 1024 * 1024, fetchImpl = fetch } = {}) {
  let response;
  for (let i = 0; i < 5; i++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error('Untrusted release destination.');
    response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(180000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Invalid release redirect.');
    url = new URL(location, url).href;
  }
  if (!response?.ok || !response.body) throw new Error('Release download failed.');
  let size = 0;
  const hash = crypto.createHash('sha256');
  const measure = new Transform({ transform(chunk, encoding, done) {
    size += chunk.length;
    if (size > maxBytes) return done(new Error('Release download exceeds size limit.'));
    hash.update(chunk); done(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), measure, fs.createWriteStream(destination, { mode: 0o600, flags: 'wx' }));
    if (hash.digest('hex') !== sha256) throw new Error('Release checksum verification failed.');
  } catch (err) { fs.rmSync(destination, { force: true }); throw err; }
}
module.exports = { downloadRelease };
