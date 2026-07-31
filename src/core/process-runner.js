import { spawn } from 'node:child_process';

const SENSITIVE_ENV_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)(?:$|_)/i;
const SENSITIVE_PREFIX_PATTERN = /^(?:SLACK|DISCORD|AWS|GITHUB|GITLAB|AZURE|GOOGLE)_/i;

export function sanitizedEnvironment(base = process.env, extra = {}) {
  const result = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERN.test(key) || SENSITIVE_PREFIX_PATTERN.test(key)) continue;
    result[key] = value;
  }
  return { ...result, ...extra };
}

export function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = sanitizedEnvironment(),
    timeoutMs = 0,
    maxCaptureBytes = 1024 * 1024,
    onSpawn,
    signal,
    logger,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let timeoutHandle;
    let forceKillHandle;

    const append = (existing, chunk) => {
      const combined = Buffer.concat([existing, chunk]);
      return combined.length <= maxCaptureBytes
        ? combined
        : combined.subarray(combined.length - maxCaptureBytes);
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, Buffer.from(chunk));
    });

    const killTree = (signalName) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signalName);
        else process.kill(-child.pid, signalName);
      } catch (error) {
        if (error?.code !== 'ESRCH') logger?.warn('Failed to stop child process.', { command, signalName, error });
      }
    };

    const requestStop = () => {
      killTree('SIGTERM');
      forceKillHandle = setTimeout(() => killTree('SIGKILL'), 10_000);
      forceKillHandle.unref?.();
    };

    const abortHandler = () => requestStop();
    if (signal) {
      if (signal.aborted) requestStop();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        requestStop();
      }, timeoutMs);
      timeoutHandle.unref?.();
    }

    child.once('spawn', () => onSpawn?.(child));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        command,
        args,
        code,
        signal: closeSignal,
        timedOut,
        aborted: Boolean(signal?.aborted),
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    });

    function cleanup() {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      signal?.removeEventListener('abort', abortHandler);
    }
  });
}
