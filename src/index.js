#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Application } from './app.js';
import { SecretRedactor } from './core/redact.js';
import { createLogger } from './core/logger.js';

const configPath = readArgument('--config') ?? process.env.UNITY_CHATOPS_CONFIG ?? './config.json';
const redactor = new SecretRedactor();
const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', redactor });
let app;
let stopping = false;

try {
  const config = await loadConfig(configPath);
  app = new Application({ config, logger, redactor });
  await app.start();
} catch (error) {
  logger.error('Failed to start unity-chatops-builder.', { error });
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception.', { error });
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection.', { error });
  void shutdown('unhandledRejection', 1);
});

async function shutdown(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  logger.info('Stopping unity-chatops-builder.', { reason });
  try {
    await app?.stop();
  } finally {
    process.exitCode = exitCode;
  }
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}
