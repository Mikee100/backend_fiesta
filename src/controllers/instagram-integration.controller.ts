import { Request, Response } from 'express';
import {
  buildAuthorizationUrl,
  buildFrontendResultUrl,
  completeOAuthCallback,
  createOAuthState,
  disconnectInstagram,
  getConfiguredAppId,
  getConfiguredRedirectUri,
  getConnectionStatus,
  isInstagramOAuthConfigured,
} from '../services/integrations/instagram-oauth.service';

export class InstagramIntegrationController {
  /**
   * GET /api/integrations/instagram
   * Returns connection status without exposing access tokens.
   */
  async getStatus(_req: Request, res: Response) {
    try {
      const status = await getConnectionStatus();
      return res.json(status);
    } catch (error: any) {
      console.error('[Instagram Integration] Failed to load status:', error?.message || error);
      return res.status(500).json({
        connected: false,
        configured: isInstagramOAuthConfigured(),
        error: 'Unable to load Instagram connection status. Please try again.',
      });
    }
  }

  /**
   * GET /api/integrations/instagram/connect
   * Starts Meta/Instagram OAuth. Returns an authorization URL for the frontend to redirect to.
   */
  async startConnect(req: Request, res: Response) {
    try {
      if (!isInstagramOAuthConfigured()) {
        return res.status(503).json({
          error:
            'Instagram OAuth is not configured. Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET on the server.',
        });
      }

      const authUser = res.locals.authUser as { id?: string } | undefined;
      if (!authUser?.id) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const state = createOAuthState(authUser.id);
      const authorizationUrl = buildAuthorizationUrl(state);
      const redirectUri = getConfiguredRedirectUri();
      const appId = getConfiguredAppId();

      // Helps debug Meta "Invalid redirect_uri" — must match Instagram Login OAuth URIs exactly.
      console.log('[Instagram OAuth] Starting connect', {
        appId,
        redirectUri,
      });

      return res.json({
        authorizationUrl,
        redirectUri,
        appId,
        metaHint:
          'Add this exact redirectUri under Meta → Instagram → API setup with Instagram Login → OAuth redirect URIs (not Facebook Login). Use the Instagram App ID, not the Facebook App ID.',
      });
    } catch (error: any) {
      console.error('[Instagram Integration] Failed to start connect:', error?.message || error);
      return res.status(500).json({
        error: 'Unable to start Instagram connection. Please try again.',
      });
    }
  }

  /**
   * GET /api/integrations/instagram/callback
   * Public Meta redirect target. Exchanges code, stores connection, redirects to frontend.
   */
  async handleCallback(req: Request, res: Response) {
    try {
      const redirectUrl = await completeOAuthCallback({
        code: typeof req.query.code === 'string' ? req.query.code : undefined,
        state: typeof req.query.state === 'string' ? req.query.state : undefined,
        error: typeof req.query.error === 'string' ? req.query.error : undefined,
        errorReason:
          typeof req.query.error_reason === 'string' ? req.query.error_reason : undefined,
        errorDescription:
          typeof req.query.error_description === 'string'
            ? req.query.error_description
            : undefined,
      });
      return res.redirect(redirectUrl);
    } catch (error: any) {
      console.error('[Instagram Integration] Callback handler failed:', error?.message || error);
      return res.redirect(
        buildFrontendResultUrl({
          instagram: 'error',
          message: 'Instagram connection failed unexpectedly. Please try again.',
        }),
      );
    }
  }

  /**
   * DELETE /api/integrations/instagram
   * Deactivates the stored Instagram connection.
   */
  async disconnect(_req: Request, res: Response) {
    try {
      await disconnectInstagram();
      return res.json({ connected: false, success: true });
    } catch (error: any) {
      console.error('[Instagram Integration] Disconnect failed:', error?.message || error);
      return res.status(500).json({
        error: 'Unable to disconnect Instagram. Please try again.',
      });
    }
  }
}

export const instagramIntegrationController = new InstagramIntegrationController();
