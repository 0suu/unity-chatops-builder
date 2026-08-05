import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideOrEqual } from '../core/paths.js';

const KEYSTORE_PASSWORD_ENV = 'UNITY_CHATOPS_ANDROID_KEYSTORE_PASSWORD';
const KEYALIAS_PASSWORD_ENV = 'UNITY_CHATOPS_ANDROID_KEYALIAS_PASSWORD';

const ASSEMBLY_DEFINITION = `${JSON.stringify({
  name: 'UnityChatOpsBuilder.AndroidSigning.Editor',
  rootNamespace: 'UnityChatOpsBuilder.Generated',
  includePlatforms: ['Editor'],
  autoReferenced: true,
})}\n`;

const PREPROCESSOR_SOURCE = `using System;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace UnityChatOpsBuilder.Generated
{
    internal sealed class AndroidSigningPreprocessor : IPreprocessBuildWithReport
    {
        private const string KeystorePasswordEnvironmentVariable = "${KEYSTORE_PASSWORD_ENV}";
        private const string KeyaliasPasswordEnvironmentVariable = "${KEYALIAS_PASSWORD_ENV}";

        public int callbackOrder => int.MinValue;

        public void OnPreprocessBuild(BuildReport report)
        {
            if (report.summary.platform != BuildTarget.Android)
            {
                throw new BuildFailedException("Android signing credentials were configured for a non-Android build.");
            }
            if (!PlayerSettings.Android.useCustomKeystore || string.IsNullOrEmpty(PlayerSettings.Android.keystoreName) || string.IsNullOrEmpty(PlayerSettings.Android.keyaliasName))
            {
                throw new BuildFailedException("Android custom keystore and key alias must be configured in Player Settings or the active Build Profile.");
            }

            var keystorePassword = ReadAndClear(KeystorePasswordEnvironmentVariable);
            var keyaliasPassword = ReadAndClear(KeyaliasPasswordEnvironmentVariable);
            PlayerSettings.Android.keystorePass = keystorePassword;
            PlayerSettings.Android.keyaliasPass = keyaliasPassword;
        }

        private static string ReadAndClear(string name)
        {
            var value = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, null);
            if (string.IsNullOrEmpty(value))
            {
                throw new BuildFailedException("Android signing credentials are missing from the build environment.");
            }
            return value;
        }
    }
}
`;

export class AndroidSigningService {
  constructor({ rules = [] } = {}) {
    this.rules = rules;
  }

  async prepare({ job, projectPath }) {
    const rule = this.rules.find((candidate) => matches(candidate, job));
    if (!rule) return { injected: false, environment: {} };

    const projectRealPath = await realpath(projectPath);
    const assetsPath = path.join(projectPath, 'Assets');
    const assetsStat = await lstat(assetsPath);
    if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) throw new Error('Unity project Assets path must be a regular non-symlink directory.');
    const assetsRealPath = await realpath(assetsPath);
    if (!isPathInsideOrEqual(projectRealPath, assetsRealPath)) throw new Error('Unity project Assets path escapes the project.');

    const generatedRoot = await mkdtemp(path.join(assetsRealPath, 'UnityChatOpsBuilder-'));
    await Promise.all([
      writeFile(path.join(generatedRoot, 'UnityChatOpsBuilder.AndroidSigning.Editor.asmdef'), ASSEMBLY_DEFINITION, { mode: 0o600 }),
      writeFile(path.join(generatedRoot, 'AndroidSigningPreprocessor.cs'), PREPROCESSOR_SOURCE, { mode: 0o600 }),
    ]);

    return {
      injected: true,
      environment: {
        [KEYSTORE_PASSWORD_ENV]: rule.keystorePassword,
        [KEYALIAS_PASSWORD_ENV]: rule.keyaliasPassword,
      },
      cleanup: () => rm(generatedRoot, { recursive: true, force: true }),
    };
  }
}

function matches(rule, job) {
  return rule.repository === job.repositoryAlias
    && rule.project === job.projectPath
    && rule.branches.includes(job.requestedBranch)
    && rule.buildProfiles.includes(job.buildProfilePath);
}
