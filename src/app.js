import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { FileLock } from './core/file-lock.js';
import { resolveSecret } from './core/secrets.js';
import { JobStore } from './db/job-store.js';
import { AdapterRegistry } from './chat/adapter-registry.js';
import { SlackAdapter } from './chat/slack-adapter.js';
import { DiscordAdapter } from './chat/discord-adapter.js';
import { StatusService } from './chat/status-service.js';
import { BuildCoordinator } from './chat/coordinator.js';
import { GitService } from './build/git-service.js';
import { UnityService } from './build/unity-service.js';
import { ArtifactVerifier } from './build/artifact-verifier.js';
import { ArtifactPublisher } from './build/artifact-publisher.js';
import { BuildWorker } from './build/worker.js';
import { RetentionService } from './maintenance/retention-service.js';

export class Application {
  constructor({ config, logger, redactor }) {
    this.config = config;
    this.logger = logger;
    this.redactor = redactor;
    this.lock = new FileLock(path.join(config.dataDir, 'locks', 'runner.lock'));
    this.store = null;
    this.adapters = null;
    this.worker = null;
    this.retention = null;
    this.startedAdapters = [];
    this.started = false;
  }

  async start() {
    await mkdir(this.config.dataDir, { recursive: true });
    await this.lock.acquire();

    try {
      this.store = new JobStore(path.join(this.config.dataDir, 'jobs.sqlite3'), { logger: this.logger });
      const adapters = [];

      if (this.config.slack.enabled) {
        const [botToken, appToken] = await Promise.all([
          resolveSecret(this.config.slack.botToken, {
            redactor: this.redactor,
            logger: this.logger,
            label: 'Slack bot token',
          }),
          resolveSecret(this.config.slack.appToken, {
            redactor: this.redactor,
            logger: this.logger,
            label: 'Slack app token',
          }),
        ]);
        adapters.push(new SlackAdapter({
          config: this.config.slack,
          botToken,
          appToken,
          logger: this.logger,
        }));
      }

      if (this.config.discord.enabled) {
        const token = await resolveSecret(this.config.discord.token, {
          redactor: this.redactor,
          logger: this.logger,
          label: 'Discord bot token',
        });
        adapters.push(new DiscordAdapter({
          config: this.config.discord,
          token,
          logger: this.logger,
        }));
      }

      this.adapters = new AdapterRegistry(adapters);
      const statusService = new StatusService({
        store: this.store,
        adapters: this.adapters,
        logger: this.logger,
      });
      const gitService = new GitService({
        config: this.config,
        dataDir: this.config.dataDir,
        logger: this.logger,
      });
      const unityService = new UnityService({
        config: this.config,
        dataDir: this.config.dataDir,
        logger: this.logger,
      });
      const artifactVerifier = new ArtifactVerifier({
        maxBytes: this.config.artifacts.maxBytes,
        logger: this.logger,
      });
      const artifactPublisher = new ArtifactPublisher({ adapters: this.adapters });

      this.worker = new BuildWorker({
        config: this.config,
        store: this.store,
        adapters: this.adapters,
        statusService,
        gitService,
        unityService,
        artifactVerifier,
        artifactPublisher,
        logger: this.logger,
        redactor: this.redactor,
      });

      const coordinator = new BuildCoordinator({
        config: this.config,
        store: this.store,
        adapters: this.adapters,
        statusService,
        gitService,
        logger: this.logger,
        onQueued: () => this.worker.wake(),
      });
      coordinator.registerHandlers();

      for (const adapter of this.adapters.values()) {
        try {
          await adapter.start();
          this.startedAdapters.push(adapter);
        } catch (error) {
          try {
            await adapter.stop();
          } catch (stopError) {
            this.logger.warn('Failed to clean up a partially started chat adapter.', {
              platform: adapter.platform,
              error: stopError,
            });
          }
          throw error;
        }
      }

      const recovery = this.store.recoverInterruptedJobs(this.config.runner.interruptedJobRetries);
      if (recovery.length > 0) this.logger.warn('Recovered interrupted jobs.', { recovery });
      await statusService.reconcile();

      this.retention = new RetentionService({
        config: this.config,
        dataDir: this.config.dataDir,
        store: this.store,
        logger: this.logger,
      });
      await this.retention.start();

      this.worker.start();
      this.worker.wake();
      this.started = true;
      this.logger.info('unity-chatops-builder started.', {
        dataDir: this.config.dataDir,
        platforms: this.adapters.values().map((adapter) => adapter.platform),
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    this.retention?.stop();

    for (const adapter of [...this.startedAdapters].reverse()) {
      try {
        await adapter.stop();
      } catch (error) {
        this.logger.warn('Failed to stop a chat adapter.', { platform: adapter.platform, error });
      }
    }
    this.startedAdapters = [];

    if (this.worker) {
      try {
        await this.worker.stop();
      } catch (error) {
        this.logger.warn('Failed to stop the build worker cleanly.', { error });
      }
    }

    try {
      this.store?.close();
    } catch (error) {
      this.logger.warn('Failed to close SQLite.', { error });
    }
    this.store = null;

    await this.lock.release();
    if (this.started) this.logger.info('unity-chatops-builder stopped.');
    this.started = false;
  }
}
