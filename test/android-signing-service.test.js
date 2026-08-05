import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AndroidSigningService } from '../src/build/android-signing-service.js';

const matchingJob = {
  repositoryAlias: 'github.com/PsychicVRLab/TheMoonCruiseTeNQ',
  projectPath: 'TheMoonCruise-Unity',
  requestedBranch: 'develop',
  buildProfilePath: 'Assets/Settings/Build Profiles/UserClient(Pico4UE) develop.asset',
};

const rule = {
  repository: matchingJob.repositoryAlias,
  project: matchingJob.projectPath,
  branches: [matchingJob.requestedBranch],
  buildProfiles: [matchingJob.buildProfilePath],
  keystorePassword: 'store-secret',
  keyaliasPassword: 'alias-secret',
};

test('injects an Editor-only preprocessor and passes secrets only through the child environment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatops-android-signing-'));
  try {
    const projectPath = path.join(directory, 'project');
    await mkdir(path.join(projectPath, 'Assets'), { recursive: true });
    const prepared = await new AndroidSigningService({ rules: [rule] }).prepare({ job: matchingJob, projectPath });
    assert.equal(prepared.injected, true);
    assert.deepEqual(Object.values(prepared.environment).sort(), ['alias-secret', 'store-secret']);
    const [folderName] = await readdir(path.join(projectPath, 'Assets'));
    const source = await readFile(path.join(projectPath, 'Assets', folderName, 'AndroidSigningPreprocessor.cs'), 'utf8');
    const asmdef = JSON.parse(await readFile(path.join(projectPath, 'Assets', folderName, 'UnityChatOpsBuilder.AndroidSigning.Editor.asmdef'), 'utf8'));
    assert.match(source, /IPreprocessBuildWithReport/);
    assert.match(source, /Environment\.SetEnvironmentVariable\(name, null\)/);
    assert.doesNotMatch(source, /store-secret|alias-secret/);
    assert.deepEqual(asmdef.includePlatforms, ['Editor']);
    await prepared.cleanup();
    await assert.rejects(() => access(path.join(projectPath, 'Assets', folderName)), (error) => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not inject or expose credentials outside the exact repository, project, branch, and profile scope', async () => {
  const service = new AndroidSigningService({ rules: [rule] });
  for (const changedField of ['repositoryAlias', 'projectPath', 'requestedBranch', 'buildProfilePath']) {
    const job = { ...matchingJob, [changedField]: 'different' };
    assert.deepEqual(await service.prepare({ job, projectPath: '/unused' }), { injected: false, environment: {} });
  }
});
