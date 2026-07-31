import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/build/git-service.js';

const logger = { warn() {}, debug() {}, info() {}, error() {} };

test('resolves a remote branch to a commit and creates an isolated worktree', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-git-'));
  try {
    const source = path.join(directory, 'source');
    await mkdir(source);
    await git(['init', '-b', 'main'], source);
    await git(['config', 'user.email', 'test@example.com'], source);
    await git(['config', 'user.name', 'Test'], source);
    await writeFile(path.join(source, 'README.md'), 'main\n');
    await git(['add', 'README.md'], source);
    await git(['commit', '-m', 'initial'], source);
    await git(['checkout', '-b', 'suu/test'], source);
    await writeFile(path.join(source, 'branch.txt'), 'branch\n');
    await git(['add', 'branch.txt'], source);
    await git(['commit', '-m', 'branch'], source);

    const dataDir = path.join(directory, 'data');
    const service = new GitService({
      config: {
        repository: {
          alias: 'project',
          sshUrl: source,
          useGitLfs: 'never',
        },
        runner: { gitTimeoutSeconds: 60 },
      },
      dataDir,
      logger,
    });

    await service.validateBranchName('suu/test');
    const commit = await service.synchronizeAndResolve('suu/test');
    assert.match(commit, /^[0-9a-f]{40}$/);

    const workspace = await service.prepareWorkspace('job-1', commit);
    assert.equal(await readFile(path.join(workspace, 'branch.txt'), 'utf8'), 'branch\n');
    await service.cleanupWorkspace(workspace);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} failed: ${stderr}`)));
  });
}
