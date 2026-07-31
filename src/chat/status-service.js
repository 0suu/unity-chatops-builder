import { stageName } from '../core/stages.js';

export class StatusService {
  constructor({ store, adapters, logger }) {
    this.store = store;
    this.adapters = adapters;
    this.logger = logger;
  }

  async setStage(jobId, stage) {
    return this.#set(jobId, String(stage), stage);
  }

  async setFailure(jobId) {
    return this.#set(jobId, 'failure', null);
  }

  async reconcile() {
    for (const job of this.store.listReactionSyncJobs()) {
      try {
        const adapter = this.adapters.get(job.platform);
        await adapter.reconcileStatusReaction(messageReference(job), job.desiredStatus);
        this.store.setAppliedStatus(job.id, job.desiredStatus, numericStage(job.desiredStatus));
      } catch (error) {
        this.logger.warn('Failed to reconcile a status reaction.', {
          jobId: job.id,
          desiredStatus: job.desiredStatus,
          error,
        });
      }
    }
  }

  async #set(jobId, desiredStatus, stage) {
    this.store.setDesiredStatus(jobId, desiredStatus, stage);
    const job = this.store.getJob(jobId);
    if (!job) return false;

    try {
      const adapter = this.adapters.get(job.platform);
      await adapter.replaceStatusReaction(messageReference(job), job.appliedStatus, desiredStatus);
      this.store.setAppliedStatus(jobId, desiredStatus, stage);
      this.logger.debug('Status reaction updated.', {
        jobId,
        status: desiredStatus,
        stageName: stage === null ? 'FAILED' : stageName(stage),
      });
      return true;
    } catch (error) {
      this.logger.warn('Status reaction update failed; the job will continue.', {
        jobId,
        desiredStatus,
        error,
      });
      return false;
    }
  }
}

export function messageReference(job) {
  return {
    workspaceId: job.workspaceId,
    channelId: job.channelId,
    sourceMessageId: job.sourceMessageId,
  };
}

export function threadReference(job) {
  if (!job.threadId) return null;
  return {
    channelId: job.channelId,
    threadId: job.threadId,
  };
}

function numericStage(value) {
  return /^\d$/.test(value) ? Number(value) : null;
}
