import { Buffer } from 'node:buffer';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { parseTrustedRemote } from './lfs-endpoint-policy.js';

export class LfsAuthProvider {
  constructor({ runProcess, endpointPolicy, environment = coordinatorCredentialEnvironment(), logger } = {}) {
    this.runProcess = runProcess;
    this.endpointPolicy = endpointPolicy;
    this.environment = environment;
    this.logger = logger;
  }

  async resolve({ remoteUrl, endpointUrl }) {
    const remote = parseTrustedRemote(remoteUrl);
    if (remote.kind === 'ssh') return this.#resolveSsh(remote);
    if (remote.kind === 'https') return this.#resolveHttps(remote, endpointUrl);
    return { endpointUrl, headers: {} };
  }

  async #resolveSsh(remote) {
    if (!this.runProcess) throw authError('SSH LFS認証を行うprocess runnerがありません。');
    const target = `${remote.user || 'git'}@${remote.host}`;
    const args = ['-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no'];
    if (remote.port) args.push('-p', String(remote.port));
    args.push(target, `git-lfs-authenticate ${remote.repositoryPath} download`);
    const result = await this.runProcess('ssh', args, { timeoutMs: 60_000, maxCaptureBytes: 256 * 1024, env: this.environment, logger: this.logger });
    if (result.code !== 0 || result.timedOut || result.aborted) {
      throw authError('SSHによるGit LFS認証に失敗しました。', { exitCode: result.code, signal: result.signal, timedOut: result.timedOut, stderr: result.stderr.trim().slice(-8000) });
    }
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw authError('Git LFS認証応答がJSONではありません。'); }
    if (!response || typeof response.href !== 'string') throw authError('Git LFS認証応答にhrefがありません。');
    const authenticatedEndpoint = await this.endpointPolicy.assertAllowedUrl(response.href, { purpose: 'authenticated LFS endpoint', allowQuery: false });
    return { endpointUrl: authenticatedEndpoint, headers: validateHeaders(response.header ?? {}), expiresAt: response.expires_at ?? null };
  }

  async #resolveHttps(remote, endpointUrl) {
    if (!this.runProcess) return { endpointUrl, headers: {} };
    const input = `protocol=https\nhost=${remote.host}${remote.port ? `:${remote.port}` : ''}\npath=${remote.repositoryPath}\n\n`;
    const result = await this.runProcess('git', ['credential', 'fill'], { input, timeoutMs: 30_000, maxCaptureBytes: 64 * 1024, env: this.environment, logger: this.logger });
    if (result.code !== 0) return { endpointUrl, headers: {} };
    const credential = parseCredential(result.stdout);
    if (!credential.username && !credential.password) return { endpointUrl, headers: {} };
    if (!credential.username || !credential.password) throw authError('Git credential helperが不完全なcredentialを返しました。');
    return { endpointUrl, headers: { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}` } };
  }
}


export function coordinatorCredentialEnvironment(base = process.env) {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK'];
  const env = {};
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  return env;
}

export function coordinatorSourceEnvironment(base = process.env) {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK'];
  const env = {};
  for (const key of allowed) if (base[key] !== undefined) env[key] = base[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

function parseCredential(output) {
  const result = {};
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}
function validateHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw authError('LFS Authorization Headerが不正です。');
  const headers = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw authError('LFS Authorization Headerに不正な値があります。');
    headers[name] = value;
  }
  return headers;
}
function authError(message, details = null) { return new CiError({ code: 'LFS_AUTHENTICATION_FAILED', category: 'SOURCE_ERROR', message, stage: STAGES.RESOLVING_SOURCE, details }); }
