import { Router } from 'express';
import { instagramIntegrationController } from '../controllers/instagram-integration.controller';

const router = Router();

// Status of the connected Instagram professional account (no tokens)
router.get('/', instagramIntegrationController.getStatus.bind(instagramIntegrationController));

// Start Meta OAuth (authenticated via requireApiAuthentication)
router.get(
  '/connect',
  instagramIntegrationController.startConnect.bind(instagramIntegrationController),
);

// Meta OAuth callback (must be public — Meta redirects the browser here)
router.get(
  '/callback',
  instagramIntegrationController.handleCallback.bind(instagramIntegrationController),
);

// Disconnect / deactivate stored connection
router.delete(
  '/',
  instagramIntegrationController.disconnect.bind(instagramIntegrationController),
);

export default router;
