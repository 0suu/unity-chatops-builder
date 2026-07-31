import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NugetForUnityService } from '../src/build/nuget-for-unity-service.js';

const logger = { warn() {}, debug() {}, info() {}, error() {} };
const config = {
  unity: {
    nugetForUnity: {
      enabled: true,
      restoreTimeoutSeconds: 600,
      cliRestoreTimeoutSeconds: 300,
    },
  },
};

test('does nothing when the Unity project does not use NuGetForUnity packages', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-none-'));
  try {
    const project = await createProject(directory, { withNuget: false });
    let calls = 0;
    const service = new NugetForUnityService({ config, logger, processRunner: async () => { calls += 1; } });
    assert.deepEqual(await service.restore({ projectPath: project }), { restored: false, reason: 'not-configured' });
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does nothing when NuGet restore is disabled even if the project is configured', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-disabled-'));
  try {
    const project = await createProject(directory);
    let calls = 0;
    const disabledConfig = { unity: { nugetForUnity: { ...config.unity.nugetForUnity, enabled: false } } };
    const service = new NugetForUnityService({ config: disabledConfig, logger, processRunner: async () => { calls += 1; } });
    assert.deepEqual(await service.restore({ projectPath: project }), { restored: false, reason: 'disabled' });
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('restores the pinned CLI once and restores packages before Unity build can start', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-'));
  try {
    const project = await createProject(directory);
    const calls = [];
    const processRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      return successfulResult(command, args);
    };
    const service = new NugetForUnityService({ config, logger, processRunner });
    assert.deepEqual(await service.restore({ projectPath: project }), { restored: true });
    assert.deepEqual(await service.restore({ projectPath: project }), { restored: true });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args.slice(0, 3), ['tool', 'restore', '--tool-manifest']);
    assert.equal(calls[0].args.includes('--configfile'), true);
    assert.deepEqual(calls[1].args, ['tool', 'run', 'nugetforunity', '--allow-roll-forward', '--', 'restore', project]);
    assert.deepEqual(calls[2].args, ['tool', 'run', 'nugetforunity', '--allow-roll-forward', '--', 'restore', project]);
    assert.equal(calls[1].options.timeoutMs, 600_000);
    assert.equal(calls[1].options.env.NUGET_CREDENTIALPROVIDERS_PATH, '');
    assert.equal(calls[1].options.env.NuGetCachePath, path.join(project, 'Library', 'NuGetForUnityCache'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not accept an allowed configuration hidden in an XML comment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-comment-'));
  try {
    const allowed = allowedNugetConfig();
    const malicious = `<!-- ${allowed.replace('<?xml version="1.0" encoding="utf-8"?>', '')} -->\n${allowed.replace('https://api.nuget.org/v3/index.json', 'http://127.0.0.1/feed')}`;
    const project = await createProject(directory, { nugetConfig: malicious });
    const service = new NugetForUnityService({ config, logger, processRunner: async () => successfulResult() });
    await assert.rejects(
      () => service.restore({ projectPath: project }),
      (error) => ['NUGET_CONFIGURATION_NOT_ALLOWED', 'NUGET_CONFIGURATION_INVALID'].includes(error.code),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a non-aggregate active package source', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-active-source-'));
  try {
    const project = await createProject(directory, {
      nugetConfig: allowedNugetConfig().replace('value="(Aggregate source)"', 'value="https://packages.example.com/v3/index.json"'),
    });
    const service = new NugetForUnityService({ config, logger, processRunner: async () => successfulResult() });
    await assert.rejects(
      () => service.restore({ projectPath: project }),
      (error) => error.code === 'NUGET_CONFIGURATION_NOT_ALLOWED',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects custom package sources before starting the CLI', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-policy-'));
  try {
    const project = await createProject(directory, {
      nugetConfig: allowedNugetConfig().replace('https://api.nuget.org/v3/index.json', 'https://packages.example.com/v3/index.json'),
    });
    let calls = 0;
    const service = new NugetForUnityService({ config, logger, processRunner: async () => { calls += 1; } });
    await assert.rejects(
      () => service.restore({ projectPath: project }),
      (error) => error.code === 'NUGET_CONFIGURATION_NOT_ALLOWED' && error.category === 'DEPENDENCY_ERROR',
    );
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a symlinked NuGet configuration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-symlink-'));
  try {
    const project = await createProject(directory, { withNuget: false });
    const outside = path.join(directory, 'outside.config');
    await writeFile(outside, allowedNugetConfig());
    await symlink(outside, path.join(project, 'Assets', 'NuGet.config'));
    await writeFile(path.join(project, 'Assets', 'packages.config'), '<packages />');
    const service = new NugetForUnityService({ config, logger, processRunner: async () => successfulResult() });
    await assert.rejects(
      () => service.restore({ projectPath: project }),
      (error) => error.code === 'NUGET_CONFIGURATION_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a symlinked shared NuGet cache path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-cache-symlink-'));
  try {
    const project = await createProject(directory);
    const outside = path.join(directory, 'shared-cache');
    await mkdir(outside);
    await symlink(outside, path.join(project, 'Library'));
    const service = new NugetForUnityService({ config, logger, processRunner: async () => successfulResult() });
    await assert.rejects(
      () => service.restore({ projectPath: project }),
      (error) => error.code === 'NUGET_CACHE_PATH_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a project with only one NuGetForUnity configuration file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-partial-'));
  try {
    const project = await createProject(directory, { withNuget: false });
    await writeFile(path.join(project, 'Assets', 'packages.config'), '<packages />');
    const service = new NugetForUnityService({ config, logger, processRunner: async () => successfulResult() });
    await assert.rejects(
      () => service.restore({ projectPath: project }),
      (error) => error.code === 'NUGET_CONFIGURATION_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('maps a package restore failure to a dependency error with captured output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-failure-'));
  try {
    const project = await createProject(directory);
    let call = 0;
    const service = new NugetForUnityService({
      config,
      logger,
      processRunner: async (command, args) => {
        call += 1;
        return call === 1
          ? successfulResult(command, args)
          : { ...successfulResult(command, args), code: 1, stderr: 'package download failed' };
      },
    });
    await assert.rejects(
      () => service.restore({ projectPath: project }),
      (error) => error.code === 'NUGET_RESTORE_FAILED'
        && error.category === 'DEPENDENCY_ERROR'
        && error.details.stderr === 'package download failed',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('maps package restore timeout and abort to stable errors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-restore-interrupt-'));
  try {
    const project = await createProject(directory);
    for (const expected of [
      { result: { timedOut: true }, code: 'NUGET_RESTORE_TIMEOUT', category: 'DEPENDENCY_ERROR' },
      { result: { aborted: true }, code: 'NUGET_RESTORE_ABORTED', category: 'RUNNER_ERROR' },
    ]) {
      let call = 0;
      const service = new NugetForUnityService({
        config,
        logger,
        processRunner: async (command, args) => {
          call += 1;
          return call === 1 ? successfulResult(command, args) : { ...successfulResult(command, args), ...expected.result };
        },
      });
      await assert.rejects(
        () => service.restore({ projectPath: project }),
        (error) => error.code === expected.code && error.category === expected.category,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('retries CLI bootstrap after a failed or timed out attempt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nuget-cli-retry-'));
  try {
    const project = await createProject(directory);
    for (const firstFailure of [
      { code: 1 },
      { timedOut: true },
    ]) {
      let call = 0;
      const service = new NugetForUnityService({
        config,
        logger,
        processRunner: async (command, args) => {
          call += 1;
          if (call === 1) return { ...successfulResult(command, args), ...firstFailure };
          return successfulResult(command, args);
        },
      });
      await assert.rejects(
        () => service.restore({ projectPath: project }),
        (error) => firstFailure.timedOut
          ? error.code === 'NUGETFORUNITY_CLI_RESTORE_TIMEOUT'
          : error.code === 'NUGETFORUNITY_CLI_UNAVAILABLE',
      );
      assert.deepEqual(await service.restore({ projectPath: project }), { restored: true });
      assert.equal(call, 3);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createProject(root, { withNuget = true, nugetConfig = allowedNugetConfig() } = {}) {
  const project = path.join(root, 'Nested Unity Project');
  await mkdir(path.join(project, 'Assets'), { recursive: true });
  await mkdir(path.join(project, 'Packages'), { recursive: true });
  await writeFile(path.join(project, 'Packages', 'manifest.json'), JSON.stringify({
    dependencies: { 'com.github-glitchenzo.nugetforunity': '4.5.0' },
  }));
  if (withNuget) {
    await writeFile(path.join(project, 'Assets', 'NuGet.config'), nugetConfig);
    await writeFile(path.join(project, 'Assets', 'packages.config'), '<packages><package id="NativeCompressions" version="0.6.1" /></packages>');
  }
  return project;
}

function allowedNugetConfig() {
  return `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" enableCredentialProvider="false" />
  </packageSources>
  <disabledPackageSources />
  <activePackageSource>
    <add key="All" value="(Aggregate source)" />
  </activePackageSource>
  <config>
    <add key="packageInstallLocation" value="CustomWithinAssets" />
    <add key="repositoryPath" value="./Packages" />
    <add key="PackagesConfigDirectoryPath" value="." />
    <add key="slimRestore" value="true" />
    <add key="PreferNetStandardOverNetFramework" value="true" />
  </config>
</configuration>
`;
}

function successfulResult(command = 'dotnet', args = []) {
  return { command, args, code: 0, signal: null, timedOut: false, aborted: false, stdout: '', stderr: '' };
}
