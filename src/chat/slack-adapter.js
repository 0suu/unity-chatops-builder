export class SlackAdapter {
  platform = 'slack';

  constructor({ config, botToken, appToken, logger }) {
    this.config = config;
    this.botToken = botToken;
    this.appToken = appToken;
    this.logger = logger;
    this.allowedChannels = new Set(config.allowedChannelIds);
    this.allowedUsers = new Set(config.allowedUserIds);
    this.incomingHandler = null;
    this.app = null;
  }

  setIncomingHandler(handler) {
    this.incomingHandler = handler;
  }

  async start() {
    const slack = await import('@slack/bolt');
    const App = slack.App ?? slack.default?.App;
    if (!App) throw new Error('Unable to load @slack/bolt App.');

    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    this.app.event('message', async ({ event }) => {
      try {
        if (!this.incomingHandler) return;
        if (!event || event.type !== 'message') return;
        if (event.subtype || event.bot_id || event.thread_ts) return;
        if (typeof event.text !== 'string' || typeof event.user !== 'string') return;
        if (!this.allowedChannels.has(event.channel) || !this.allowedUsers.has(event.user)) return;

        await this.incomingHandler({
          platform: this.platform,
          workspaceId: this.config.workspaceId,
          channelId: event.channel,
          sourceMessageId: event.ts,
          requesterId: event.user,
          requesterName: event.user,
          text: event.text,
        });
      } catch (error) {
        this.logger.error('Slack message handler failed.', { error });
      }
    });

    await this.app.start();
    const identity = await this.app.client.auth.test();
    if (identity.team_id !== this.config.workspaceId) {
      throw new Error(
        `Slack token belongs to workspace ${identity.team_id ?? 'unknown'}, not ${this.config.workspaceId}.`,
      );
    }
    this.logger.info('Slack adapter connected.', {
      workspaceId: this.config.workspaceId,
      botUserId: identity.user_id,
    });
  }

  async stop() {
    await this.app?.stop();
  }

  async createThread(messageReference) {
    return {
      channelId: messageReference.channelId,
      threadId: messageReference.sourceMessageId,
    };
  }

  async postThreadMessage(threadReference, text) {
    await this.app.client.chat.postMessage({
      channel: threadReference.channelId,
      thread_ts: threadReference.threadId,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  async replaceStatusReaction(messageReference, previousStatus, nextStatus) {
    if (previousStatus && previousStatus !== nextStatus) {
      await this.#removeReaction(messageReference, this.#emojiForStatus(previousStatus));
    }
    await this.#addReaction(messageReference, this.#emojiForStatus(nextStatus));
  }

  async reconcileStatusReaction(messageReference, nextStatus) {
    const emojiNames = new Set([
      ...Object.values(this.config.statusEmojiNames),
      this.config.failureEmojiName,
    ]);
    for (const emojiName of emojiNames) {
      await this.#removeReaction(messageReference, emojiName);
    }
    await this.#addReaction(messageReference, this.#emojiForStatus(nextStatus));
  }

  async uploadArtifact(threadReference, artifact, text) {
    const result = await this.app.client.filesUploadV2({
      channel_id: threadReference.channelId,
      thread_ts: threadReference.threadId,
      file: artifact.path,
      filename: artifact.name,
      title: artifact.name,
      initial_comment: text,
    });

    return {
      platform: this.platform,
      fileIds: Array.isArray(result.files) ? result.files.map((file) => file.id).filter(Boolean) : [],
    };
  }

  getNativeUploadLimitBytes() {
    return this.config.nativeUploadLimitBytes;
  }

  #emojiForStatus(status) {
    return status === 'failure'
      ? this.config.failureEmojiName
      : this.config.statusEmojiNames[String(status)];
  }

  async #addReaction(messageReference, emojiName) {
    try {
      await this.app.client.reactions.add({
        channel: messageReference.channelId,
        timestamp: messageReference.sourceMessageId,
        name: emojiName,
      });
    } catch (error) {
      if (slackErrorCode(error) !== 'already_reacted') throw error;
    }
  }

  async #removeReaction(messageReference, emojiName) {
    if (!emojiName) return;
    try {
      await this.app.client.reactions.remove({
        channel: messageReference.channelId,
        timestamp: messageReference.sourceMessageId,
        name: emojiName,
      });
    } catch (error) {
      if (slackErrorCode(error) !== 'no_reaction') throw error;
    }
  }
}

function slackErrorCode(error) {
  return error?.data?.error ?? error?.code;
}
