import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Verifies Meta's X-Hub-Signature-256 header, computed over the raw request
 * body using the given app secret. Shared by any channel that goes through
 * Meta's Graph API directly (Instagram messaging, or WhatsApp in 'meta' mode).
 */
export function verifyMetaSignature(appSecretEnvVar: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const appSecret = process.env[appSecretEnvVar];
    const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody: Buffer | undefined = (req as any).rawBody;

    if (!appSecret || !signatureHeader || !rawBody) {
      console.error(`Webhook rejected: missing signature, ${appSecretEnvVar}, or raw body`);
      return res.sendStatus(401);
    }

    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const received = Buffer.from(signatureHeader);
    const expected = Buffer.from(expectedSignature);

    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      console.error('Webhook rejected: signature mismatch');
      return res.sendStatus(401);
    }

    next();
  };
}

/**
 * Rejects incoming webhook POSTs that don't prove they came from the
 * configured WhatsApp provider. Without this, the webhook URL is a public,
 * unauthenticated endpoint - anyone who finds it can POST a fake message
 * pretending to be any customer.
 */
export function verifyWhatsAppWebhook(req: Request, res: Response, next: NextFunction) {
  const provider = process.env.WHATSAPP_PROVIDER || 'meta';

  if (provider === '360dialog') {
    const expected = process.env.WEBHOOK_SHARED_SECRET;
    const received = req.headers['x-webhook-secret'];

    if (!expected || received !== expected) {
      console.error('Webhook rejected: missing or invalid shared-secret header');
      return res.sendStatus(401);
    }
    return next();
  }

  // Direct Meta integration: verify X-Hub-Signature-256 over the raw request body
  return verifyMetaSignature('WHATSAPP_APP_SECRET')(req, res, next);
}

/**
 * Instagram messaging always goes through Meta's Graph API directly (no BSP
 * equivalent to 360dialog), so it only ever needs the Meta signature check.
 */
export const verifyInstagramWebhook = verifyMetaSignature('INSTAGRAM_APP_SECRET');
