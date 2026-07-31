export class CiError extends Error {
  constructor({ code, category, message, stage = null, details = null, cause = undefined }) {
    super(message, { cause });
    this.name = 'CiError';
    this.code = code;
    this.category = category;
    this.stage = stage;
    this.details = details;
  }
}

export function asCiError(error, fallback) {
  if (error instanceof CiError) return error;

  const message = error instanceof Error ? error.message : String(error);
  return new CiError({
    ...fallback,
    message: fallback.message ?? message,
    details: {
      ...(fallback.details ?? {}),
      originalMessage: message,
    },
    cause: error instanceof Error ? error : undefined,
  });
}
