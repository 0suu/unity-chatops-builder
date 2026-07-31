import { safeSlug } from '../core/paths.js';

export class DiscordAdapter {
  platform = 'discord';

  constructor({ config, token, logger }) {
    this.config = config;
    this.token = token;
    this.logger = logger;
    this.allowedChannels = new Set(config.allowedChannelIds);
    this.allowedUsers = new Set(config.allowedUserIds);
    this.allowedRoles = new Set(config.allowedRoleIds);
    this.incomingHandler = null;
    this.client = null;
    this.discord = null;
  }

  setIncomingHandler(handler) {
    this.incomingHandler = handler;
  }

  async start() {
    this.discord = await import('discord.js');
    const { Client, Events, GatewayIntentBits } = this.discord;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        if (!this.incomingHandler || message.author.bot || !message.guild) return;
        if (message.guild.id !== this.config.guildId) return;
        if (message.channel.isThread?.()) return;
        if (!this.allowedChannels.has(message.channelId)) return;
        if (!this.#isAllowedMember(message)) return;

        await this.incomingHandler({
          platform: this.platform,
          workspaceId: message.guild.id,
          channelId: message.channelId,
          sourceMessageId: message.id,
          requesterId: message.author.id,
          requesterName: message.author.tag ?? message.author.username,
          text: message.content,
        });
      } catch (error) {
        this.logger.error('Discord message handler failed.', { error });
      }
    });

    const ready = new Promise((resolve) => this.client.once(Events.ClientReady, resolve));
    await this.client.login(this.token);
    await ready;
    const guild = await this.client.guilds.fetch(this.config.guildId);
    this.logger.info('Discord adapter connected.', {
      guildId: guild.id,
      guildName: guild.name,
      user: this.client.user?.tag,
    });
  }

  async stop() {
    this.client?.destroy();
  }

  async createThread(messageReference, { jobId, branch }) {
    const sourceMessage = await this.#fetchSourceMessage(messageReference);
    if (sourceMessage.hasThread) {
      const existing = sourceMessage.thread ?? await this.client.channels.fetch(sourceMessage.id);
      if (existing) return { channelId: messageReference.channelId, threadId: existing.id };
    }

    const name = `unity-build-${safeSlug(branch ?? jobId, 60)}-${jobId.slice(0, 8)}`.slice(0, 100);
    const thread = await sourceMessage.startThread({
      name,
      autoArchiveDuration: this.config.threadAutoArchiveMinutes,
      reason: `Unity build ${jobId}`,
    });
    return { channelId: messageReference.channelId, threadId: thread.id };
  }

  async postThreadMessage(threadReference, text) {
    const thread = await this.#fetchThread(threadReference.threadId);
    await thread.send({ content: text, allowedMentions: { parse: [] } });
  }

  async replaceStatusReaction(messageReference, previousStatus, nextStatus) {
    const message = await this.#fetchSourceMessage(messageReference);
    if (previousStatus && previousStatus !== nextStatus) {
      await this.#removeOwnReaction(message, this.#emojiForStatus(previousStatus));
    }
    await message.react(await this.#resolveReactionEmoji(message, this.#emojiForStatus(nextStatus)));
  }

  async reconcileStatusReaction(messageReference, nextStatus) {
    const message = await this.#fetchSourceMessage(messageReference);
    const identifiers = new Set([
      ...Object.values(this.config.statusEmojiIds),
      this.config.failureEmoji,
    ]);
    for (const identifier of identifiers) {
      await this.#removeOwnReaction(message, identifier);
    }
    await message.react(await this.#resolveReactionEmoji(message, this.#emojiForStatus(nextStatus)));
  }

  async uploadArtifact(threadReference, artifact, text) {
    const thread = await this.#fetchThread(threadReference.threadId);
    const message = await thread.send({
      content: text,
      files: [{ attachment: artifact.path, name: artifact.name }],
      allowedMentions: { parse: [] },
    });
    return { platform: this.platform, messageId: message.id, attachmentCount: message.attachments.size };
  }

  getNativeUploadLimitBytes() {
    return this.config.nativeUploadLimitBytes;
  }

  #isAllowedMember(message) {
    if (this.allowedUsers.has(message.author.id)) return true;
    const roles = message.member?.roles?.cache;
    return roles ? roles.some((role) => this.allowedRoles.has(role.id)) : false;
  }

  #emojiForStatus(status) {
    return status === 'failure'
      ? this.config.failureEmoji
      : this.config.statusEmojiIds[String(status)];
  }

  async #resolveReactionEmoji(message, identifier) {
    if (!/^\d{15,22}$/.test(identifier)) return identifier;
    const cached = message.guild?.emojis?.cache?.get(identifier);
    if (cached) return cached;

    try {
      const fetched = await message.guild?.emojis?.fetch(identifier);
      if (fetched) return fetched;
    } catch (error) {
      throw new Error(`Discord emoji ${identifier} could not be resolved.`, { cause: error });
    }
    throw new Error(`Discord emoji ${identifier} could not be resolved.`);
  }

  async #fetchSourceMessage(messageReference) {
    const channel = await this.client.channels.fetch(messageReference.channelId);
    if (!channel?.isTextBased?.() || !channel.messages) {
      throw new Error(`Discord channel ${messageReference.channelId} is not message-capable.`);
    }
    return channel.messages.fetch(messageReference.sourceMessageId);
  }

  async #fetchThread(threadId) {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isThread?.()) throw new Error(`Discord thread ${threadId} was not found.`);
    if (channel.archived && channel.setArchived) await channel.setArchived(false, 'Unity build result');
    return channel;
  }

  async #removeOwnReaction(message, identifier) {
    const reaction = message.reactions.cache.find((candidate) => {
      return candidate.emoji.id === identifier || candidate.emoji.name === identifier;
    });
    if (!reaction || !this.client.user) return;
    try {
      await reaction.users.remove(this.client.user.id);
    } catch (error) {
      if (error?.code !== 10014) throw error;
    }
  }
}
