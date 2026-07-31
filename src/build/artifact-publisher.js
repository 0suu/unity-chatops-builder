import { CiError } from '../core/errors.js';
import { STAGES } from '../core/stages.js';
import { threadReference } from '../chat/status-service.js';

export class ArtifactPublisher {
  constructor({ adapters }) {
    this.adapters = adapters;
  }

  async publish(job, artifact, text) {
    const adapter = this.adapters.get(job.platform);
    const limit = adapter.getNativeUploadLimitBytes();
    if (artifact.size > limit) {
      throw new CiError({
        code: 'ARTIFACT_TOO_LARGE_FOR_PLATFORM',
        category: 'DELIVERY_ERROR',
        message: 'APKは正常に生成されましたが、要求元プラットフォームの直接添付上限を超えています。',
        stage: STAGES.UPLOADING,
        details: {
          artifactSize: artifact.size,
          nativeUploadLimitBytes: limit,
          artifactPath: artifact.path,
        },
      });
    }

    const thread = threadReference(job);
    if (!thread) {
      throw new CiError({
        code: 'THREAD_REFERENCE_MISSING',
        category: 'DELIVERY_ERROR',
        message: '成果物を返信するスレッド情報がありません。',
        stage: STAGES.UPLOADING,
      });
    }

    try {
      return await adapter.uploadArtifact(thread, artifact, text);
    } catch (error) {
      throw new CiError({
        code: 'ARTIFACT_UPLOAD_FAILED',
        category: 'DELIVERY_ERROR',
        message: 'APKのスレッドへのアップロードに失敗しました。',
        stage: STAGES.UPLOADING,
        details: {
          platform: job.platform,
          artifactPath: artifact.path,
          originalMessage: error instanceof Error ? error.message : String(error),
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}
