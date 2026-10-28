const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const zlib = require('node:zlib');
const adapter = require('../server/services/openCodeGuiAdapter');

const fixture = `function RouterX(props){const get=()=>{const path=window.location.pathname.replace(/^\\/+/,"/");return path};return get()}
const routerProps={get component(){return opts.router??RouterX},root:null};
const defaultUrl=()=>location.hostname.includes("opencode.ai")?"http://localhost:4096":location.origin;
const storage="opencode.settings.dat:defaultServerUrl";
function sdk(request,config){const url=new URL(request.path,config.baseUrl);for(const key of []){}return url}
async function probe(config,fetcher,path){return fetcher(new URL(path,config.url),{headers:auth(config),signal:AbortSignal.timeout(5e3)})}
const classify=(path,search)=>{const parts=path.split("/").filter(Boolean);if(parts.length===0)return{type:"home"};return parts};
const notHome=loc.pathname!=="/",isDraft=loc.pathname==="/new-session";
const suffix=loc.pathname.slice(directory().length+1);
const historyKey=\`\${loc.pathname}\${loc.search}\${loc.hash}\`;
navigate(loc.pathname+loc.search,{replace:!0});navigate(loc.pathname+loc.search+anchor,{replace:!0});
const preloadType="modulepreload",preload=function(path){return"/"+path};
const api=requestUrl.pathname.startsWith("/api/");
const asset="/assets/icon.svg",relative="./relative.js";
function internal(){return navigate(loc.pathname+loc.search,{resolve:!1})}
`;
const trustedDigests = [createHash('sha256').update(fixture).digest('hex')];
const prefix = '/opencode/project%20one';
const transform = source => adapter.transformMain(source, prefix, { trustedDigests: [createHash('sha256').update(source).digest('hex')] });

function stream(bytes, encoding = 'identity') {
  const response = Readable.from([Buffer.from(bytes)]);
  response.headers = { 'content-encoding': encoding };
  return response;
}

test('digest and signature guards reject unsupported, missing and duplicated sites', () => {
  assert.throws(() => adapter.transformMain(fixture, prefix), /digest/);
  assert.throws(() => adapter.transformMain(fixture + ' ', prefix, { trustedDigests }), /digest/);
  for (const changed of [fixture.replace('window.location.pathname', 'window.location.hash'), fixture.replace('baseUrl);for(', 'baseUrl);while('), fixture + 'const duplicate="opencode.settings.dat:defaultServerUrl";']) assert.throws(() => transform(changed), /signature|definition/);
  assert.throws(() => transform(transform(fixture)), /already adapted/);
});

test('captured identifiers, actual Router base, API joins and application-only paths work', async () => {
  const output = transform(fixture);
  const navigations = [];
  const context = {
    URL, AbortSignal, window: { location: { pathname: prefix + '/directory/session/42' } },
    location: { hostname: 'opencode.ai', origin: 'https://panel.example' }, opts: {},
    loc: { pathname: prefix + '/directory/session/42', search: '?q=1', hash: '#message' },
    directory: () => 'directory', requestUrl: { pathname: prefix + '/api/health' },
    anchor: '#other', auth: () => ({}), navigate: (...args) => navigations.push(args),
  };
  vm.createContext(context);
  vm.runInContext(output + '\nglobalThis.result={routerProps,defaultUrl,storage,sdk,probe,classify,notHome,isDraft,suffix,historyKey,preload,api,asset,relative,internal,strip:__citadelOCPath};', context);
  const r = context.result;
  assert.equal(r.routerProps.base, prefix);
  assert.equal(r.routerProps.component, vm.runInContext('RouterX', context));
  assert.equal(r.defaultUrl(), 'https://panel.example' + prefix);
  assert.equal(r.storage, 'opencode.settings.dat:defaultServerUrl:' + prefix);
  for (const path of ['/api/event', '/session', 'global/health']) {
    assert.equal(r.sdk({ path }, { baseUrl: 'https://panel.example' + prefix }).href, 'https://panel.example' + prefix + '/' + path.replace(/^\//, ''));
    assert.equal(await r.probe({ url: 'https://panel.example' + prefix + '/' }, url => url.href, path), 'https://panel.example' + prefix + '/' + path.replace(/^\//, ''));
  }
  assert.equal(r.sdk({ path: '/api/health' }, { baseUrl: 'http://localhost:4096' }).href, 'http://localhost:4096/api/health');
  assert.equal(r.classify(prefix, '').type, 'home');
  assert.equal(r.classify(prefix + '/', '').type, 'home');
  assert.deepEqual(Array.from(r.classify(prefix + '/directory/session/42', '')), ['directory', 'session', '42']);
  assert.equal(r.strip(prefix + '-other/x'), prefix + '-other/x');
  assert.equal(r.suffix, '/session/42');
  assert.equal(r.historyKey, '/directory/session/42?q=1#message');
  assert.equal(r.preload('assets/chunk.js'), prefix + '/assets/chunk.js');
  assert.equal(r.api, true);
  assert.equal(r.asset, prefix + '/assets/icon.svg');
  assert.equal(r.relative, './relative.js');
  assert.equal(navigations[0][0], '/directory/session/42?q=1');
  assert.equal(navigations[1][0], '/directory/session/42?q=1#other');
  r.internal();
  assert.equal(navigations[2][0], prefix + '/directory/session/42?q=1');
  assert.match(output, /window\.location\.pathname\.replace/);
});

test('HTML preflight verifies its module before rewriting deep-link document assets', async () => {
  const html = '<html><script crossorigin type="module" src="/assets/index-fixture.js"></script><link href="/manifest.webmanifest"><img src="/assets/a.svg"><a href="./relative">Relative</a></html>';
  const args = { kind: 'html', path: '/directory/session/42', prefix, trustedDigests, loadEntry: async (target, path) => { assert.equal(path, '/assets/index-fixture.js'); return fixture; } };
  const adapted = await adapter.adaptText(html, args);
  assert.match(adapted, /src="\/opencode\/project%20one\/assets\/index-fixture.js"/);
  assert.match(adapted, /href="\/opencode\/project%20one\/manifest.webmanifest"/);
  assert.match(adapted, /href="\.\/relative"/);
  await assert.rejects(adapter.adaptText(html, { ...args, loadEntry: async () => 'unknown build' }), /digest/);
  for (const source of ['<html></html>', '<script type="module" src="https://elsewhere/entry.js"></script>', html + '<script type="module" src="/assets/other.js"></script>']) await assert.rejects(adapter.adaptText(source, args), /entry/);
});

test('JS chunks, CSS and manifests rewrite root resources and preserve relative/external URLs', async () => {
  assert.equal(await adapter.adaptText('const x="/assets/a.svg",y="./a.svg";', { kind: 'js', path: '/assets/chunk.js', prefix }), `const x="${prefix}/assets/a.svg",y="./a.svg";`);
  assert.equal(await adapter.adaptText('a{src:url(/assets/a.woff)}b{src:url("./a.woff")}c{src:url(//cdn/a)}', { kind: 'css', prefix }), `a{src:url(${prefix}/assets/a.woff)}b{src:url("./a.woff")}c{src:url(//cdn/a)}`);
  const manifest = JSON.parse(await adapter.adaptText(JSON.stringify({ start_url: '/', scope: '/', icons: [{ src: '/assets/a.png' }, { src: 'relative.png' }], shortcuts: [{ url: '/new-session' }] }), { kind: 'manifest', prefix }));
  assert.equal(manifest.start_url, prefix + '/');
  assert.equal(manifest.icons[0].src, prefix + '/assets/a.png');
  assert.equal(manifest.icons[1].src, 'relative.png');
  assert.equal(manifest.shortcuts[0].url, prefix + '/new-session');
  for (const path of ['/api/file', '/session/42', '/global/event', '/file/foo.js']) assert.equal(adapter.resourceKind(path, 'text/html'), null);
  assert.equal(adapter.resourceKind('/assets/a.js?x=1', 'application/octet-stream'), 'js');
  assert.equal(adapter.resourceKind('/dir/session/42', 'text/html'), 'html');
  assert.equal(adapter.resourceKind('/events', 'text/event-stream'), null);
  for (const url of [prefix + '/session', prefix + '?x=1', prefix + '#hash', '//external/path', 'relative']) assert.equal(adapter.prefixUrl(url, prefix), url);
  assert.equal(adapter.prefixUrl('/session', prefix), prefix + '/session');
});

test('bounded text decoding supports identity/gzip/deflate/br and rejects corruption or bombs', async () => {
  for (const [encoding, compress] of [['identity', b => b], ['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) assert.equal(await adapter.readText(stream(compress(Buffer.from('hello')), encoding)), 'hello');
  await assert.rejects(adapter.readText(stream('too large'), 2), /size limit/);
  await assert.rejects(adapter.readText(stream(zlib.gzipSync(Buffer.alloc(2000)), 'gzip'), 100), /larger|length|size/i);
  await assert.rejects(adapter.readText(stream('bad gzip', 'gzip')));
  await assert.rejects(adapter.readText(stream('hello', 'zstd')), /encoding/);
  await assert.rejects(adapter.readText(stream(Buffer.from([255]))), /encoded data/);
});
