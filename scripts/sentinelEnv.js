/**
 * Child environment construction for sentinel task executions.
 *
 * Task commands are untrusted user code. They must inherit the runtime
 * environment they legitimately need (PATH, HOME, language runtimes and the
 * provider API keys the operator injected for the agents), but they must NOT
 * inherit Citadel's own control-plane secrets, which this process holds to
 * talk to the panel. Spreading the supervisor environment would hand a task
 * command the credentials of the whole installation, so those exact names are
 * removed here.
 */

// Variables that exist only for Citadel's control plane: worker/peer/session
// credentials and the at-rest encryption key. A task command or CLI agent has
// no legitimate use for them, so they are stripped even when present in the
// supervisor environment. Matching is by exact name, so a user-supplied
// provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) is never touched.
const CITADEL_INTERNAL_SECRETS = Object.freeze([
  'CITADEL_TOKEN',
  'CITADEL_NODE_TOKEN',
  'CITADEL_NODE_TOKENS',
  'CITADEL_PEER_TOKEN',
  'CITADEL_SECRET_KEY',
  'SESSION_SECRET',
]);

function isInternalSecret(key) {
  return CITADEL_INTERNAL_SECRETS.includes(key);
}

/**
 * Build the environment for one task execution: the supervisor environment
 * minus the internal credentials, plus the recovery markers the execution and
 * a restarted sentinel rely on.
 */
function buildTaskEnv(task, execId, { baseEnv = process.env, node } = {}) {
  const env = {};
  for (const key of Object.keys(baseEnv)) {
    if (isInternalSecret(key)) continue;
    env[key] = baseEnv[key];
  }
  env.CITADEL_TASK_ID = task.id;
  env.CITADEL_TASK_NODE = node;
  env.CITADEL_TASK_PROJECT = task.projectPath || '';
  // Inherited by the whole subtree so a restarted sentinel can attribute
  // survivors even if it crashed before persisting the pid.
  env.CITADEL_EXEC_ID = execId;
  return env;
}

module.exports = { buildTaskEnv, CITADEL_INTERNAL_SECRETS, isInternalSecret };
