import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { runProcess, sanitizedEnvironment } from '../core/process-runner.js';

export class ArtifactVerifier {
  constructor({ maxBytes, logger }) {
    this.maxBytes = maxBytes;
    this.logger = logger;
  }

  async verify(candidate) {
    let fileStat;
    try {
      fileStat = await lstat(candidate.path);
    } catch (error) {
      throw this.#error('ARTIFACT_NOT_FOUND', 'Unityの終了後にAPKファイルが見つかりませんでした。', { path: candidate.path }, error);
    }

    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw this.#error('ARTIFACT_NOT_REGULAR_FILE', '成果物が通常ファイルではありません。', { path: candidate.path });
    }
    if (fileStat.size <= 0) {
      throw this.#error('ARTIFACT_EMPTY', '生成されたAPKが空です。', { path: candidate.path });
    }
    if (fileStat.size > this.maxBytes) {
      throw this.#error('ARTIFACT_TOO_LARGE', '生成されたAPKが設定された1ファイル上限を超えています。', {
        size: fileStat.size,
        maxBytes: this.maxBytes,
      });
    }
    if (path.extname(candidate.path).toLowerCase() !== '.apk') {
      throw this.#error('ARTIFACT_EXTENSION_INVALID', '成果物の拡張子が.apkではありません。', { path: candidate.path });
    }

    const test = await runProcess('/usr/bin/unzip', ['-tqq', candidate.path], {
      timeoutMs: 120_000,
      env: sanitizedEnvironment(),
      logger: this.logger,
    });
    if (test.code !== 0) {
      throw this.#error('ARTIFACT_ZIP_INVALID', 'APKのZIP整合性検証に失敗しました。', {
        exitCode: test.code,
        stderr: test.stderr.trim().slice(-20_000),
      });
    }

    const listing = await runProcess('/usr/bin/unzip', ['-Z1', candidate.path], {
      timeoutMs: 120_000,
      env: sanitizedEnvironment(),
      logger: this.logger,
      maxCaptureBytes: 8 * 1024 * 1024,
    });
    if (listing.code !== 0) {
      throw this.#error('ARTIFACT_LIST_FAILED', 'APK内のファイル一覧を取得できませんでした。', {
        exitCode: listing.code,
        stderr: listing.stderr.trim().slice(-20_000),
      });
    }

    const entries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
    if (!entries.has('AndroidManifest.xml')) {
      throw this.#error('ARTIFACT_MANIFEST_MISSING', 'APK内にAndroidManifest.xmlがありません。');
    }
    if (![...entries].some((entry) => entry === 'classes.dex' || entry.startsWith('lib/') || entry.startsWith('assets/'))) {
      throw this.#error('ARTIFACT_CONTENT_INVALID', 'APKとして必要な実行内容を確認できませんでした。');
    }

    const sha256 = await hashFile(candidate.path);
    return {
      path: candidate.path,
      name: candidate.name ?? path.basename(candidate.path),
      size: fileStat.size,
      sha256,
      logPath: candidate.logPath,
    };
  }

  #error(code, message, details = null, cause = undefined) {
    return new CiError({
      code,
      category: 'ARTIFACT_ERROR',
      message,
      stage: STAGES.VERIFYING_ARTIFACT,
      details,
      cause,
    });
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
