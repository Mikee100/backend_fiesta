export const SCHEMA_MAINTENANCE_REPLY = 'Our booking assistant is temporarily unavailable. Please contact the studio team to continue your request.';

/** The only Prisma P2022 we intentionally handle as a schema-lag event. */
const KNOWN_MISSING_COLUMN = 'booking_drafts.cancelProposedAt';

/**
 * Returns true only for the one specific missing-column error we handle
 * gracefully (cancelProposedAt). Any other P2022 — including a typo in a
 * new query — is treated as an unexpected bug so it bypasses the alert
 * limiter and reaches normal error escalation.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || (error as any).code !== 'P2022') return false;
  const column = (error as any)?.meta?.column;
  return typeof column === 'string' && column.includes('cancelProposedAt');
}

/** True when the error is any P2022, even one we don't recognise — use to detect unhandled schema errors. */
export function isAnyMissingColumnError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 'P2022');
}

export function safeSchemaDetails(error: unknown): { code: string; model: string | null; column: string | null } {
  const value = error as { code?: unknown; meta?: { modelName?: unknown; column?: unknown } } | null;
  const model = value?.meta?.modelName;
  const column = value?.meta?.column;
  return {
    code: isMissingColumnError(error) ? 'P2022' : 'DATABASE_STARTUP_FAILED',
    model: typeof model === 'string' && /^[A-Za-z_]\w*$/.test(model) ? model : null,
    column: typeof column === 'string' && /^(?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*$/.test(column) ? column : null,
  };
}

export class DatabaseSchemaOutOfDateError extends Error {
  readonly code = 'SCHEMA_OUT_OF_DATE';
  readonly details: ReturnType<typeof safeSchemaDetails>;

  constructor(error: unknown) {
    super('Database schema is out of date. Startup stopped before accepting messages or starting automation.');
    this.name = 'DatabaseSchemaOutOfDateError';
    this.details = safeSchemaDetails(error);
  }
}

type SchemaProbeClient = {
  bookingDraft: {
    findFirst(args: { select: { id: true; cancelProposedAt: true } }): PromiseLike<unknown>;
  };
};

export async function verifyBookingDraftSchema(client: SchemaProbeClient): Promise<void> {
  try {
    await client.bookingDraft.findFirst({ select: { id: true, cancelProposedAt: true } });
  } catch (error) {
    if (isMissingColumnError(error)) throw new DatabaseSchemaOutOfDateError(error);
    throw error;
  }
}

export function createSchemaAlertLimiter(cooldownMs = 10 * 60_000) {
  let lastAlert: number | null = null;
  return (): boolean => {
    const now = Date.now();
    if (lastAlert !== null && now - lastAlert < cooldownMs) return false;
    lastAlert = now;
    return true;
  };
}