/**
 * Validate and store clipboard images as private, short-lived terminal inputs.
 */
const fileService = require('./fileService');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FORMATS = {
  'image/png': { signature: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { signature: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { signature: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
  'image/webp': { signature: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};

function validateImage(mimeType, content) {
  const format = typeof mimeType === 'string' && Object.hasOwn(FORMATS, mimeType) ? FORMATS[mimeType] : null;
  const maxBase64Length = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4;
  if (!format || typeof content !== 'string' || !content || content.length > maxBase64Length
    || content.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    const err = new Error('Unsupported or invalid image data.');
    err.statusCode = 400;
    throw err;
  }
  const bytes = Buffer.from(content, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== content || !format.signature(bytes)) {
    const err = new Error('Unsupported or invalid image data.');
    err.statusCode = 400;
    throw err;
  }
  return bytes.length;
}

async function save({ mimeType, content, asAdmin = false }) {
  const size = validateImage(mimeType, content);
  const result = await fileService.saveTerminalImage(mimeType, content, asAdmin);
  return { path: result.path, size, mimeType };
}

module.exports = { MAX_IMAGE_BYTES, validateImage, save };
