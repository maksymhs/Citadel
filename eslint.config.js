// Minimal lint: catches undefined/unused variables, not style.
const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  structuredClone: 'readonly', queueMicrotask: 'readonly', Headers: 'readonly', WebSocket: 'readonly',
};
const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', localStorage: 'readonly',
  location: 'readonly', history: 'readonly', fetch: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', WebSocket: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', FormData: 'readonly', Blob: 'readonly',
  FileReader: 'readonly', Image: 'readonly', ResizeObserver: 'readonly', MutationObserver: 'readonly',
  IntersectionObserver: 'readonly', AbortController: 'readonly', TextDecoder: 'readonly',
  TextEncoder: 'readonly', Terminal: 'readonly', FitAddon: 'readonly', WebLinksAddon: 'readonly',
  Wunderbaum: 'readonly', mar10: 'readonly', jsQR: 'readonly', confirm: 'readonly', alert: 'readonly', prompt: 'readonly',
  getComputedStyle: 'readonly', matchMedia: 'readonly', Notification: 'readonly', Event: 'readonly',
  CustomEvent: 'readonly', HTMLElement: 'readonly', atob: 'readonly', btoa: 'readonly',
  sessionStorage: 'readonly', screen: 'readonly', performance: 'readonly',
};
const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
};

module.exports = [
  { ignores: ['node_modules/**', 'public/vendor/**', 'data/**', 'dist/**'] },
  { files: ['public/js/**/*.js'], languageOptions: { sourceType: 'script', globals: browserGlobals }, rules },
  { files: ['**/*.js'], ignores: ['public/**'], languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023, globals: nodeGlobals }, rules },
];
