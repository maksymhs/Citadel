/**
 * Same-service-user Linux process signaling, guarded by boot/start identity and ancestry.
 */
const nodeService = require('./nodeService');

function refuse(message, statusCode) {
  throw Object.assign(new Error(message), { statusCode });
}

function terminateProcess({ pid, identity, signal } = {}) {
  const text = typeof pid === 'number' ? String(pid) : pid;
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text) ||
      !Number.isSafeInteger(Number(text)) || Number(text) > 2147483647) {
    refuse('A valid positive process ID is required.', 400);
  }
  const targetPid = Number(text);
  if (signal !== 'TERM' && signal !== 'KILL') {
    refuse('Choose TERM or KILL explicitly.', 400);
  }
  if (typeof identity !== 'string' || identity.length > 128 ||
      !/^linux:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9]\d*:\d+$/.test(identity)) {
    refuse('A process identity from the current process list is required.', 400);
  }
  if ([1, process.pid, process.ppid].includes(targetPid)) {
    refuse('This system or Citadel ancestor process is protected.', 403);
  }

  // No await between fresh inspection and native numeric-PID signaling. Never
  // invoke a shell, sudo, process groups, or automatic TERM-to-KILL escalation.
  try {
    let context;
    try {
      context = nodeService.getProcessControlContext();
    } catch (err) {
      if (err.code === 'ENOTSUP') throw err;
      refuse('The Citadel service ancestry could not be safely established.', 503);
    }
    if (!Number.isSafeInteger(context.uid) || context.uid < 0 || !(context.protectedPids instanceof Set)) {
      refuse('The Citadel service ownership could not be safely established.', 503);
    }
    if (context.protectedPids.has(targetPid)) {
      refuse('This system or Citadel ancestor process is protected.', 403);
    }
    const inspect = () => {
      const current = nodeService.readProcessIdentity(targetPid);
      if (current.identity !== identity) {
        refuse('The process changed or its PID was reused. Refresh the process list.', 409);
      }
      // Match real, effective, saved and filesystem UID: no setuid transitions
      // or other users' processes, even when Citadel itself runs as root.
      if (current.uids?.length !== 4 || !current.uids.every(uid => uid === context.uid)) {
        refuse('Only processes owned entirely by the Citadel service user can be signaled.', 403);
      }
    };
    inspect();
    inspect();
    // Node exposes no pidfd signal API: this narrows, but cannot atomically
    // eliminate, kernel-side PID reuse after the final identity read.
    if (process.kill(targetPid, signal === 'TERM' ? 'SIGTERM' : 'SIGKILL') !== true) {
      refuse('The process signal could not be verified as sent.', 503);
    }
    // Delivery is not proof of exit: TERM may be handled or ignored.
    return { success: true, pid: targetPid, signal, signalSent: true };
  } catch (err) {
    if (err.statusCode) throw err;
    if (['ENOENT', 'ESRCH'].includes(err.code)) refuse('The process no longer exists. Refresh the process list.', 404);
    if (err.code === 'ESTALE') refuse('The process changed or its PID was reused. Refresh the process list.', 409);
    if (['EACCES', 'EPERM'].includes(err.code)) refuse('Permission to inspect or signal this process was denied.', 403);
    if (err.code === 'ENOTSUP') refuse('Safe process signaling is supported only on Linux.', 501);
    // Process names/arguments and raw OS errors can contain secrets.
    refuse('The process could not be safely inspected or signaled.', 503);
  }
}

module.exports = { terminateProcess };
