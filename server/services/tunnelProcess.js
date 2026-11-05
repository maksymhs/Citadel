/** Asynchronous tunnel helper: leave Fastify able to answer readiness probes. */
const { spawn } = require('node:child_process');
function runTunnelProcess(command, args, { env = process.env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-16000); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-16000); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve({ status: timedOut ? -1 : code, stdout, stderr: timedOut ? 'Tunnel helper timed out; inspect the running service.' : stderr }); });
  });
}
async function activateWithRecovery(activate, recover) {
  try { return await activate(); }
  catch (error) {
    try { await recover(); }
    catch { throw new Error(`${error.message} Temporary tunnel recovery also failed; use SSH to run sudo citadel tunnel --quick.`); }
    throw new Error(`${error.message} A new temporary tunnel was restored; the previous temporary URL has changed. Run sudo citadel qr --tunnel to get it.`);
  }
}
module.exports = { runTunnelProcess, activateWithRecovery };
