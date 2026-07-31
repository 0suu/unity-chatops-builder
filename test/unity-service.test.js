import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnityService } from '../src/build/unity-service.js';

const logger = { warn() {}, debug() {}, info() {}, error() {} };

test('resolves the exact Unity version and Build Profile', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-unity-'));
  try {
    const workspace = path.join(directory, 'workspace');
    const editorsRoot = path.join(directory, 'editors');
    const version = '6000.0.59f2';
    const executable = path.join(editorsRoot, version, 'Unity.app', 'Contents', 'MacOS', 'Unity');
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await mkdir(path.join(workspace, 'ProjectSettings'), { recursive: true });
    await mkdir(path.join(workspace, 'Assets', 'BuildProfiles'), { recursive: true });
    await writeFile(path.join(workspace, 'ProjectSettings', 'ProjectVersion.txt'), `m_EditorVersion: ${version}\n`);
    await writeFile(path.join(workspace, 'Assets', 'BuildProfiles', 'PICO.asset'), 'profile');

    const service = new UnityService({
      config: { unity: { editorsRoot, buildTimeoutMinutes: 90 } },
      dataDir: path.join(directory, 'data'),
      logger,
    });
    const result = await service.inspectProject(workspace, 'Assets/BuildProfiles/PICO.asset', '.');
    assert.equal(result.unityVersion, version);
    assert.equal(result.unityExecutable, executable);
    assert.equal(result.projectPath, workspace);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a symlinked Build Profile', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-unity-'));
  try {
    const workspace = path.join(directory, 'workspace');
    const editorsRoot = path.join(directory, 'editors');
    const version = '6000.0.59f2';
    const executable = path.join(editorsRoot, version, 'Unity.app', 'Contents', 'MacOS', 'Unity');
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await mkdir(path.join(workspace, 'ProjectSettings'), { recursive: true });
    await mkdir(path.join(workspace, 'Assets', 'BuildProfiles'), { recursive: true });
    await writeFile(path.join(workspace, 'ProjectSettings', 'ProjectVersion.txt'), `m_EditorVersion: ${version}\n`);
    await writeFile(path.join(directory, 'outside.asset'), 'profile');
    await symlink(path.join(directory, 'outside.asset'), path.join(workspace, 'Assets', 'BuildProfiles', 'PICO.asset'));

    const service = new UnityService({
      config: { unity: { editorsRoot, buildTimeoutMinutes: 90 } },
      dataDir: path.join(directory, 'data'),
      logger,
    });
    await assert.rejects(
      () => service.inspectProject(workspace, 'Assets/BuildProfiles/PICO.asset', '.'),
      (error) => error.code === 'BUILD_PROFILE_NOT_FOUND',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolves a Unity project in a repository subdirectory and accepts spaces in the profile path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-unity-nested-'));
  try {
    const workspace = path.join(directory, 'workspace');
    const project = path.join(workspace, 'STYLY-NetSync-Unity');
    const editorsRoot = path.join(directory, 'editors');
    const version = '6000.0.59f2';
    const executable = path.join(editorsRoot, version, 'Unity.app', 'Contents', 'MacOS', 'Unity');
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await mkdir(path.join(project, 'ProjectSettings'), { recursive: true });
    await mkdir(path.join(project, 'Assets', 'Settings', 'Build Profiles'), { recursive: true });
    await writeFile(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), `m_EditorVersion: ${version}\n`);
    await writeFile(path.join(project, 'Assets', 'Settings', 'Build Profiles', 'SyncObjectTest_User.asset'), 'profile');

    const service = new UnityService({ config: { unity: { editorsRoot, buildTimeoutMinutes: 90 } }, dataDir: path.join(directory, 'data'), logger });
    const result = await service.inspectProject(workspace, 'Assets/Settings/Build Profiles/SyncObjectTest_User.asset', 'STYLY-NetSync-Unity');
    assert.equal(result.unityVersion, version);
    assert.equal(result.unityExecutable, executable);
    assert.equal(result.projectPath, project);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('passes the resolved Unity project path to the Unity CLI', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-unity-build-'));
  try {
    const argsFile = path.join(directory, 'unity-args.txt');
    const executable = path.join(directory, 'fake-unity.sh');
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 0\n`);
    await chmod(executable, 0o755);
    const service = new UnityService({
      config: { unity: { editorsRoot: directory, buildTimeoutMinutes: 90 } },
      dataDir: path.join(directory, 'data'),
      logger,
    });
    await service.build({
      job: {
        id: 'job-1', repositoryAlias: 'repo', requestedBranch: 'develop', resolvedCommitSha: 'a'.repeat(40), buildProfilePath: 'Assets/Settings/Build Profiles/SyncObjectTest_User.asset',
      },
      workspacePath: path.join(directory, 'workspace'),
      projectPath: path.join(directory, 'workspace', 'STYLY-NetSync-Unity'),
      unityExecutable: executable,
    });
    const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
    assert.deepEqual(args.slice(0, 6), ['-batchmode', '-quit', '-projectPath', path.join(directory, 'workspace', 'STYLY-NetSync-Unity'), '-activeBuildProfile', 'Assets/Settings/Build Profiles/SyncObjectTest_User.asset']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
