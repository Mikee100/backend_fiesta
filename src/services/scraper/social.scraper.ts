import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const INSTAGRAM_PROFILE_URL = 'https://www.instagram.com/fiestahousematernity/';
const DEFAULT_MEDIA_LIMIT = 25;

type SocialChunk = { platform: string; url: string; content: string };

/**
 * Pulls real Instagram captions via Meta Graph API for RAG.
 * Never injects placeholder text — if credentials/API fail, returns [].
 * FAQ/knowledge rows already cover "where's your Instagram?" style questions.
 */
export class SocialScraperService {
  private getAccessToken(): string | undefined {
    dotenv.config();
    return (
      process.env.INSTAGRAM_PAGE_ACCESS_TOKEN ||
      process.env.FB_PAGE_ACCESS_TOKEN ||
      process.env.INSTAGRAM_ACCESS_TOKEN ||
      undefined
    );
  }

  private getIgUserId(): string {
    return (
      process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ||
      process.env.INSTAGRAM_IG_USER_ID ||
      process.env.INSTAGRAM_PAGE_ID ||
      'me'
    );
  }

  private getApiVersion(): string {
    return process.env.WHATSAPP_API_VERSION || process.env.META_API_VERSION || 'v20.0';
  }

  private mediaEndpoint(token: string): string {
    const version = this.getApiVersion();
    const fields = 'id,caption,media_type,permalink,timestamp,username';
    const limit = Number(process.env.INSTAGRAM_MEDIA_LIMIT || DEFAULT_MEDIA_LIMIT);

    // IG User tokens (IGAA…) use graph.instagram.com with /me/media
    if (token.startsWith('IGAA')) {
      return `https://graph.instagram.com/${version}/me/media?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(token)}`;
    }

    // Page / system-user tokens use Facebook Graph + IG business account id
    const igUserId = this.getIgUserId();
    return `https://graph.facebook.com/${version}/${igUserId}/media?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(token)}`;
  }

  /**
   * Fetches recent Instagram media captions. Empty array on any failure —
   * never returns synthetic placeholder content into the vector store.
   */
  async scrapeRecentPosts(): Promise<SocialChunk[]> {
    const token = this.getAccessToken();
    if (!token) {
      console.warn(
        '[social-scraper] No Instagram access token configured — skipping social ingestion (FAQ covers social handles).'
      );
      return [];
    }

    try {
      console.log('[social-scraper] Fetching recent Instagram media via Graph API...');
      const url = this.mediaEndpoint(token);
      const response = await axios.get(url, { timeout: 20000 });
      const media: any[] = Array.isArray(response.data?.data) ? response.data.data : [];

      const chunks: SocialChunk[] = [];
      let skippedNoCaption = 0;
      for (const item of media) {
        const caption = String(item.caption || '').trim();
        const permalink = String(item.permalink || INSTAGRAM_PROFILE_URL);
        const when = item.timestamp ? `Posted: ${item.timestamp}` : '';
        const type = item.media_type ? `Type: ${item.media_type}` : '';

        // Prefer caption-rich posts; still keep a short stub for captionless media
        // so RAG knows recent posting activity / permalinks exist.
        if (!caption) {
          skippedNoCaption += 1;
          chunks.push({
            platform: 'instagram',
            url: permalink,
            content: [
              'Instagram post from @fiestahousematernity',
              when,
              type,
              `Link: ${permalink}`,
              '',
              'Recent Instagram post (no caption text). See the link for the visual.',
            ]
              .filter(Boolean)
              .join('\n'),
          });
          continue;
        }

        const header = [
          'Instagram post from @fiestahousematernity',
          when,
          type,
          `Link: ${permalink}`,
        ]
          .filter(Boolean)
          .join('\n');

        chunks.push({
          platform: 'instagram',
          url: permalink,
          content: `${header}\n\n${caption}`,
        });
      }

      console.log(
        `[social-scraper] Ingesting ${chunks.length} Instagram post(s) ` +
          `(${media.length} media; ${skippedNoCaption} had no caption).`
      );
      return chunks;
    } catch (error: any) {
      const detail = error?.response?.data || error?.message || error;
      console.error('[social-scraper] Instagram Graph API failed — skipping social ingestion:', detail);
      return [];
    }
  }
}

export const socialScraper = new SocialScraperService();
