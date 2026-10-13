import crypto from 'crypto';
import axios from 'axios';
import prisma from '../../config/prisma';

const OAUTH_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
].join(',');

const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH_BASE = 'https://graph.instagram.com';

export type InstagramConnectionPublic = {
  connected: true;
  username: string;
  instagramAccountId: string;
  accountType: string | null;
  connectedAt: string;
};

export type InstagramConnectionStatus =
  | { connected: false; configured: boolean; message?: string }
  | (InstagramConnectionPublic & { configured: boolean });

type OAuthStatePayload = {
  userId: string;
  nonce: string;
  issuedAt: number;
};

function getAppId(): string | undefined {
  return process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID;
}

function getAppSecret(): string | undefined {
  return process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
}

function getRedirectUri(): string {
  // Must match Meta → Instagram → API setup with Instagram Login → OAuth redirect URIs
  // character-for-character (scheme, host, path; no trailing slash).
  const configured = (process.env.INSTAGRAM_REDIRECT_URI || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const base = (process.env.BASE_URL || 'http://localhost:4000').trim().replace(/\/$/, '');
  return `${base}/api/integrations/instagram/callback`;
}

/** Exposed for connect diagnostics — not a secret. */
export function getConfiguredRedirectUri(): string {
  return getRedirectUri();
}

export function getConfiguredAppId(): string | undefined {
  return getAppId();
}

function getFrontendRedirectBase(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:5000').replace(/\/$/, '');
}

function getStateSigningSecret(): string {
  return (
    process.env.AUTH_JWT_SECRET ||
    process.env.INSTAGRAM_APP_SECRET ||
    process.env.JWT_SECRET ||
    'instagram-oauth-dev-secret'
  );
}

function getGraphApiVersion(): string {
  return (
    process.env.INSTAGRAM_GRAPH_API_VERSION ||
    process.env.WHATSAPP_API_VERSION ||
    process.env.META_API_VERSION ||
    'v21.0'
  );
}

export function isInstagramOAuthConfigured(): boolean {
  return Boolean(getAppId() && getAppSecret());
}

export function createOAuthState(userId: string): string {
  const payload: OAuthStatePayload = {
    userId,
    nonce: crypto.randomBytes(16).toString('hex'),
    issuedAt: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getStateSigningSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

export function verifyOAuthState(state: string): OAuthStatePayload | null {
  const [body, signature] = state.split('.');
  if (!body || !signature) return null;

  const expected = crypto
    .createHmac('sha256', getStateSigningSecret())
    .update(body)
    .digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
    if (!payload?.userId || !payload?.issuedAt) return null;
    // State valid for 15 minutes
    if (Date.now() - payload.issuedAt > 15 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildAuthorizationUrl(state: string): string {
  const appId = getAppId();
  if (!appId) {
    throw new Error('INSTAGRAM_APP_ID is not configured');
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: OAUTH_SCOPES,
    state,
  });

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function buildFrontendResultUrl(params: Record<string, string>): string {
  const url = new URL(`${getFrontendRedirectBase()}/settings/integrations/instagram`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function mapMetaErrorToUserMessage(error: unknown): string {
  const data = (error as { response?: { data?: any } })?.response?.data;
  const code = data?.error?.code ?? data?.error_type;
  const message = String(data?.error?.message || data?.error_message || '').toLowerCase();

  if (message.includes('redirect_uri') || message.includes('redirect uri')) {
    return 'Instagram redirect URI is misconfigured. Check INSTAGRAM_REDIRECT_URI in Meta and in the server environment.';
  }
  if (message.includes('expired') || message.includes('authorization code')) {
    return 'The Instagram authorization code expired or is invalid. Please try connecting again.';
  }
  if (message.includes('invalid') && message.includes('secret')) {
    return 'Instagram app credentials are invalid. Check INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET.';
  }
  if (code === 190) {
    return 'Instagram authorization failed. Please reconnect your account.';
  }
  return 'Could not complete Instagram authorization. Please try again.';
}

async function exchangeCodeForShortLivedToken(code: string): Promise<{
  accessToken: string;
  userId?: string;
}> {
  const appId = getAppId();
  const appSecret = getAppSecret();
  if (!appId || !appSecret) {
    throw new Error('Instagram OAuth is not configured');
  }

  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: getRedirectUri(),
    code,
  });

  const response = await axios.post(TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });

  const data = response.data;
  // Meta may return either a flat object or { data: [{ access_token, user_id }] }
  const tokenEntry = Array.isArray(data?.data) ? data.data[0] : data;
  const accessToken = tokenEntry?.access_token as string | undefined;
  if (!accessToken) {
    throw new Error('Instagram token exchange returned no access token');
  }

  return {
    accessToken,
    userId: tokenEntry?.user_id ? String(tokenEntry.user_id) : undefined,
  };
}

async function exchangeForLongLivedToken(shortLivedToken: string): Promise<{
  accessToken: string;
  expiresIn?: number;
}> {
  try {
    const appSecret = getAppSecret();
    if (!appSecret) {
      return { accessToken: shortLivedToken };
    }

    const response = await axios.get(`${GRAPH_BASE}/access_token`, {
      params: {
        grant_type: 'ig_exchange_token',
        client_secret: appSecret,
        access_token: shortLivedToken,
      },
      timeout: 20000,
    });

    const accessToken = response.data?.access_token as string | undefined;
    if (!accessToken) {
      return { accessToken: shortLivedToken };
    }

    return {
      accessToken,
      expiresIn: typeof response.data?.expires_in === 'number' ? response.data.expires_in : undefined,
    };
  } catch (error) {
    console.error('[Instagram OAuth] Long-lived token exchange failed; using short-lived token');
    return { accessToken: shortLivedToken };
  }
}

async function fetchInstagramProfile(accessToken: string): Promise<{
  id: string;
  username: string;
  accountType: string | null;
}> {
  const response = await axios.get(`${GRAPH_BASE}/${getGraphApiVersion()}/me`, {
    params: {
      fields: 'user_id,username,account_type,name',
      access_token: accessToken,
    },
    timeout: 20000,
  });

  const data = response.data || {};
  // Instagram Login returns user_id as the IG professional account id; id may also be present.
  const id = String(data.user_id || data.id || '');
  const username = String(data.username || '').trim();

  if (!id || !username) {
    throw new Error('MISSING_PROFESSIONAL_ACCOUNT');
  }

  return {
    id,
    username,
    accountType: data.account_type ? String(data.account_type) : null,
  };
}

export async function getActiveConnection() {
  return prisma.instagramConnection.findFirst({
    where: { isActive: true },
    orderBy: { connectedAt: 'desc' },
  });
}

export async function getConnectionStatus(): Promise<InstagramConnectionStatus> {
  const configured = isInstagramOAuthConfigured();
  const connection = await getActiveConnection();

  if (!connection) {
    return {
      connected: false,
      configured,
      message: configured
        ? undefined
        : 'Instagram OAuth is not configured yet. Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET.',
    };
  }

  return {
    connected: true,
    configured,
    username: connection.username,
    instagramAccountId: connection.instagramAccountId,
    accountType: connection.accountType,
    connectedAt: connection.connectedAt.toISOString(),
  };
}

export async function completeOAuthCallback(params: {
  code?: string;
  state?: string;
  error?: string;
  errorReason?: string;
  errorDescription?: string;
}): Promise<string> {
  if (params.error) {
    const cancelled =
      params.error === 'access_denied' ||
      params.errorReason === 'user_denied' ||
      /cancel|denied/i.test(params.errorDescription || '');
    return buildFrontendResultUrl({
      instagram: cancelled ? 'cancelled' : 'error',
      message: cancelled
        ? 'Instagram authorization was cancelled.'
        : 'Instagram authorization failed. Please try again.',
    });
  }

  if (!params.code || !params.state) {
    return buildFrontendResultUrl({
      instagram: 'error',
      message: 'Missing authorization response from Instagram.',
    });
  }

  const statePayload = verifyOAuthState(params.state);
  if (!statePayload) {
    return buildFrontendResultUrl({
      instagram: 'error',
      message: 'Instagram connection session expired. Please try connecting again.',
    });
  }

  if (!isInstagramOAuthConfigured()) {
    return buildFrontendResultUrl({
      instagram: 'error',
      message: 'Instagram OAuth is not configured on the server.',
    });
  }

  try {
    const shortLived = await exchangeCodeForShortLivedToken(params.code);
    const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
    const profile = await fetchInstagramProfile(longLived.accessToken);

    const tokenExpiresAt =
      typeof longLived.expiresIn === 'number'
        ? new Date(Date.now() + longLived.expiresIn * 1000)
        : null;

    // Single-tenant: deactivate any previous connection, then upsert by Instagram account id.
    await prisma.$transaction(async (tx) => {
      await tx.instagramConnection.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      });

      await tx.instagramConnection.upsert({
        where: { instagramAccountId: profile.id },
        create: {
          instagramAccountId: profile.id,
          username: profile.username,
          accountType: profile.accountType,
          accessToken: longLived.accessToken,
          tokenExpiresAt,
          connectedByUserId: statePayload.userId,
          isActive: true,
          connectedAt: new Date(),
        },
        update: {
          username: profile.username,
          accountType: profile.accountType,
          accessToken: longLived.accessToken,
          tokenExpiresAt,
          connectedByUserId: statePayload.userId,
          isActive: true,
          connectedAt: new Date(),
        },
      });
    });

    return buildFrontendResultUrl({
      instagram: 'connected',
      username: profile.username,
    });
  } catch (error: any) {
    if (error?.message === 'MISSING_PROFESSIONAL_ACCOUNT') {
      return buildFrontendResultUrl({
        instagram: 'error',
        message:
          'No Instagram professional account was found. Convert to a Business or Creator account and try again.',
      });
    }

    console.error('[Instagram OAuth] Callback failed:', error?.response?.status || error?.message || error);
    return buildFrontendResultUrl({
      instagram: 'error',
      message: mapMetaErrorToUserMessage(error),
    });
  }
}

export async function disconnectInstagram(): Promise<void> {
  await prisma.instagramConnection.updateMany({
    where: { isActive: true },
    data: { isActive: false },
  });
}

/**
 * Returns the active Instagram access token for messaging, if any.
 * Prefer OAuth-stored token; do not log the value.
 */
export async function getStoredAccessToken(): Promise<string | null> {
  const connection = await getActiveConnection();
  return connection?.accessToken || null;
}

export async function getStoredInstagramAccountId(): Promise<string | null> {
  const connection = await getActiveConnection();
  return connection?.instagramAccountId || null;
}
