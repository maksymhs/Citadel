const { createHash } = require('node:crypto');
const http = require('node:http');
const zlib = require('node:zlib');

const MAIN_SHA256 = 'f50056f89aaa6d96b12c2532734b7b3142a68a37d9a96bc58ef1dfb2ead7b7d8';
const MAX_BYTES = 16 * 1024 * 1024;
const ID = '[A-Za-z_$][\\w$]*';
const API_PATH = /^\/(?:api|global|event|provider|path|session|project|config|vcs|instance|command|find|file|experimental|lsp|formatter|mcp|agent|log|tui|auth|permission|question|pty|skill|worktree|resource)(?:\/|$)/;
const ERROR_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>OpenCode GUI unavailable</title></head><body><h1>OpenCode GUI compatibility check failed</h1><p>This OpenCode frontend could not be safely adapted to the project URL. Use the OpenCode terminal, or install the supported frontend 1.19.2 (observed with server 1.19.3), then reopen the GUI. If already using that version, check the upstream asset response and proxy size/encoding limits. A new frontend build requires a reviewed Citadel adapter.</p></body></html>';

function prefixFor(projectId) {
  return `/opencode/${encodeURIComponent(projectId)}`;
}

function prefixUrl(value, prefix) {
  if (!value.startsWith('/') || value.startsWith('//')) return value;
  if (value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`) || value.startsWith(`${prefix}#`)) return value;
  return prefix + value;
}

function replaceChecked(source, pattern, replacement, count = 1) {
  let found = 0;
  const result = source.replace(pattern, (...args) => { found++; return replacement(...args); });
  if (found !== count) throw new Error('Unsupported OpenCode frontend signature.');
  return result;
}

function transformMain(source, prefix, { trustedDigests = [MAIN_SHA256] } = {}) {
  const digest = createHash('sha256').update(source).digest('hex');
  if (!trustedDigests.includes(digest)) throw new Error('Unsupported OpenCode frontend digest.');
  if (source.includes('__citadelOC')) throw new Error('OpenCode frontend already adapted.');
  const routerPattern = new RegExp(`get component\\(\\)\\{return (${ID})\\.router\\?\\?(${ID})\\},root:`, 'g');
  source = replaceChecked(source, routerPattern, (match, props, router) => {
    const definition = new RegExp(`function ${router.replace(/\$/g, '\\$')}\\((${ID})\\)\\{const (${ID})=\\(\\)=>\\{const (${ID})=window\\.location\\.pathname\\.replace`);
    if (!definition.test(source)) throw new Error('Unsupported OpenCode Router definition.');
    return `get component(){return ${props}.router??${router}},base:__citadelOCBase,root:`;
  });
  source = replaceChecked(source, /\(\)=>location\.hostname\.includes\("opencode\.ai"\)\?"http:\/\/localhost:4096":location\.origin/g, () => '()=>location.origin+__citadelOCBase');
  source = replaceChecked(source, /"opencode\.settings\.dat:defaultServerUrl"/g, () => '"opencode.settings.dat:defaultServerUrl:"+__citadelOCBase');
  source = replaceChecked(source, new RegExp(`new URL\\((${ID})\\.path,(${ID})\\.baseUrl\\);for\\(`, 'g'), (match, path, base) => `__citadelOCJoin(${path}.path,${base}.baseUrl);for(`);
  source = replaceChecked(source, new RegExp(`new URL\\((${ID}),(${ID})\\.url\\),\\{headers:(${ID})\\(\\2\\),signal:AbortSignal\\.timeout\\(5e3\\)\\}`, 'g'), (match, path, base, headers) => `__citadelOCJoin(${path},${base}.url),{headers:${headers}(${base}),signal:AbortSignal.timeout(5e3)}`);
  source = replaceChecked(source, new RegExp(`=\\((${ID}),(${ID})\\)=>\\{const (${ID})=\\1\\.split\\("/"\\)\\.filter\\(Boolean\\);if\\(\\3\\.length===0\\)return\\{type:"home"\\}`, 'g'), (match, path, search, parts) => `=(${path},${search})=>{const ${parts}=__citadelOCPath(${path}).split("/").filter(Boolean);if(${parts}.length===0)return{type:"home"}`);
  source = replaceChecked(source, new RegExp(`(${ID})\\.pathname!=="/"`, 'g'), (match, loc) => `__citadelOCPath(${loc}.pathname)!=="/"`);
  source = replaceChecked(source, new RegExp(`(${ID})\\.pathname==="/new-session"`, 'g'), (match, loc) => `__citadelOCPath(${loc}.pathname)==="/new-session"`);
  source = replaceChecked(source, new RegExp(`(${ID})\\.pathname\\.slice\\((${ID})\\(\\)\\.length\\+1\\)`, 'g'), (match, loc, directory) => `__citadelOCPath(${loc}.pathname).slice(${directory}().length+1)`);
  source = replaceChecked(source, new RegExp('`\\$\\{(' + ID + ')\\.pathname\\}\\$\\{\\1\\.search\\}\\$\\{\\1\\.hash\\}`', 'g'), (match, loc) => `\`\${__citadelOCPath(${loc}.pathname)}\${${loc}.search}\${${loc}.hash}\``);
  source = replaceChecked(source, new RegExp(`(${ID})\\((${ID})\\.pathname\\+\\2\\.search(?=,\\{replace:!0\\}|\\+${ID},\\{replace:!0\\})`, 'g'), (match, navigate, loc) => `${navigate}(__citadelOCPath(${loc}.pathname)+${loc}.search`, 2);
  source = replaceChecked(source, new RegExp(`"modulepreload",(${ID})=function\\((${ID})\\)\\{return"/"\\+\\2\\}`, 'g'), (match, preload, path) => `"modulepreload",${preload}=function(${path}){return __citadelOCBase+"/"+${path}}`);
  source = replaceChecked(source, new RegExp(`(${ID})\\.pathname\\.startsWith\\("/api/"\\)`, 'g'), (match, url) => `__citadelOCPath(${url}.pathname).startsWith("/api/")`);
  const helpers = `const __citadelOCBase=${JSON.stringify(prefix)},__citadelOCPath=p=>p===__citadelOCBase?"/":p.startsWith(__citadelOCBase+"/")?p.slice(__citadelOCBase.length):p,__citadelOCJoin=(p,b)=>new URL(String(p).replace(/^\\/+/,""),String(b).replace(/\\/+$/,"")+"/");\n`;
  return helpers + rewriteAssets(source, prefix);
}

function rewriteAssets(source, prefix) {
  return source.replace(/(["'`])(\/assets\/[A-Za-z0-9_./?=&%#:+~-]+)\1/g, (match, quote, path) => quote + prefixUrl(path, prefix) + quote);
}

function resourceKind(path, contentType) {
  path = path.split('?')[0];
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (mime === 'text/event-stream' || API_PATH.test(path)) return null;
  if (/^\/assets\/.*\.m?js$/.test(path)) return 'js';
  if (/^\/assets\/.*\.css$/.test(path)) return 'css';
  if (mime === 'text/html') return 'html';
  if (mime === 'application/manifest+json' || /\.(?:webmanifest|manifest\.json)$/.test(path)) return 'manifest';
  return null;
}

async function readText(response, maxBytes = MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('OpenCode GUI response exceeds size limit.');
    chunks.push(chunk);
  }
  let bytes = Buffer.concat(chunks);
  const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const decode = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync }[encoding];
  if (decode) bytes = decode(bytes, { maxOutputLength: maxBytes });
  else if (encoding !== 'identity') throw new Error('Unsupported OpenCode GUI encoding.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function fetchEntry(target, path, signal) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: target.port, path, signal, headers: { 'accept-encoding': 'identity', ...(target.auth ? { authorization: target.auth } : {}) }, timeout: 30000 }, async response => {
      try {
        if (response.statusCode !== 200 || !/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers['content-type'] || '')) throw new Error('OpenCode entry bundle unavailable.');
        resolve(await readText(response));
      } catch (error) { response.destroy(); reject(error); }
    });
    request.on('timeout', () => request.destroy(new Error('OpenCode entry bundle timed out.')));
    request.on('error', reject);
  });
}

function entryPath(html) {
  const paths = [];
  for (const script of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...script[1].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), m[3]]));
    if (attrs.type !== 'module' || !attrs.src) continue;
    if (!/^\/?assets\/[\w.-]+\.js$/.test(attrs.src)) throw new Error('Unsupported OpenCode module entry.');
    paths.push('/' + attrs.src.replace(/^\//, ''));
  }
  if (paths.length !== 1) throw new Error('Unsupported OpenCode HTML entry.');
  return paths[0];
}

async function adaptText(source, { kind, path, prefix, target, signal, loadEntry = fetchEntry, trustedDigests }) {
  if (kind === 'js') {
    if (/^\/assets\/index-[\w-]+\.js(?:\?|$)/.test(path) || /get component\(\)\{return [\w$]+\.router\?\?/.test(source) || source.includes('opencode.settings.dat:defaultServerUrl')) return transformMain(source, prefix, { trustedDigests });
    return rewriteAssets(source, prefix);
  }
  if (kind === 'html') {
    const entry = entryPath(source);
    transformMain(await loadEntry(target, entry, signal), prefix, { trustedDigests });
    return source.replace(/\b(src|href|action|poster)\s*=\s*(["'])(\/[^"']*)\2/gi, (match, attr, quote, value) => `${attr}=${quote}${prefixUrl(value, prefix)}${quote}`);
  }
  if (kind === 'css') return source.replace(/url\(\s*(["']?)(\/[^\s)'"\\]+)\1\s*\)/gi, (match, quote, value) => `url(${quote}${prefixUrl(value, prefix)}${quote})`);
  if (kind === 'manifest') {
    const manifest = JSON.parse(source);
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['src', 'start_url', 'scope', 'id', 'url', 'action'].includes(key) && typeof child === 'string') value[key] = prefixUrl(child, prefix);
        else visit(child);
      }
    };
    visit(manifest);
    return JSON.stringify(manifest);
  }
  throw new Error('Unsupported OpenCode GUI resource.');
}

module.exports = { MAIN_SHA256, MAX_BYTES, ERROR_PAGE, prefixFor, prefixUrl, transformMain, rewriteAssets, resourceKind, readText, entryPath, adaptText };
