// Customers commonly send several short WhatsApp messages back to back instead
// of one message. Without this, each one triggers its own independent AI call
// against a slightly-stale history, producing disjointed replies and burning
// extra AI-provider quota for what was really a single turn. This delays
// processing per-customer until they've paused for DEBOUNCE_MS, then lets the
// caller handle the whole burst as one turn.

const DEBOUNCE_MS = 6000;

const pendingTimers = new Map<string, NodeJS.Timeout>();

export function scheduleTurn(customerId: string, onFlush: () => void | Promise<void>): void {
  const existing = pendingTimers.get(customerId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingTimers.delete(customerId);
    Promise.resolve(onFlush()).catch(err => console.error(`Debounced turn failed for ${customerId}:`, err));
  }, DEBOUNCE_MS);

  pendingTimers.set(customerId, timer);
}
