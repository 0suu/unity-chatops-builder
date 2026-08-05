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

test('rejects a log-reported Android signing failure even when Unity exits zero', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-unity-signing-failure-'));
  try {
    const executable = path.join(directory, 'fake-unity.sh');
    await writeFile(executable, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-logFile" ]; then
    shift
    printf '%s\n' 'UnityException: Can not sign the application' 'Unable to sign the application; please provide passwords!' 'Build Finished, Result: Failure.' 'Exiting batchmode successfully now!' > "$1"
    break
  fi
  shift
done
exit 0
`);
    await chmod(executable, 0o755);
    const service = new UnityService({
      config: { unity: { editorsRoot: directory, buildTimeoutMinutes: 90 } },
      dataDir: path.join(directory, 'data'),
      logger,
    });

    await assert.rejects(
      () => service.build({
        job: {
          id: 'job-signing', repositoryAlias: 'repo', requestedBranch: 'develop', resolvedCommitSha: 'a'.repeat(40), buildProfilePath: 'Assets/BuildProfiles/PICO.asset',
        },
        workspacePath: path.join(directory, 'workspace'),
        projectPath: path.join(directory, 'workspace'),
        unityExecutable: executable,
      }),
      (error) => error.code === 'ANDROID_SIGNING_FAILED' && error.stage === 6 && error.category === 'UNITY_BUILD_ERROR',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('scans the complete Unity log for a failure before a long successful shutdown tail', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-unity-log-scan-'));
  try {
    const executable = path.join(directory, 'fake-unity.sh');
    await writeFile(executable, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-logFile" ]; then
    shift
    printf '%s\n' 'Build Finished, Result: Failure.' > "$1"
    i=0
    while [ "$i" -lt 1000 ]; do printf '%s\n' 'successful-looking shutdown noise' >> "$1"; i=$((i + 1)); done
    printf '%s\n' 'Exiting batchmode successfully now!' >> "$1"
    break
  fi
  shift
done
exit 0
`);
    await chmod(executable, 0o755);
    const service = new UnityService({ config: { unity: { buildTimeoutMinutes: 90 } }, dataDir: path.join(directory, 'data'), logger });
    await assert.rejects(
      () => service.build({ job: { id: 'job-log-scan', repositoryAlias: 'repo', requestedBranch: 'develop', resolvedCommitSha: 'b'.repeat(40), buildProfilePath: 'Assets/Profile.asset' }, workspacePath: directory, projectPath: directory, unityExecutable: executable }),
      (error) => error.code === 'UNITY_BUILD_FAILED' && !error.details.logTail.includes('Build Finished'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
