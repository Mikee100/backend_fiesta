import axios from 'axios';
import * as cheerio from 'cheerio';

const TARGET_URLS = [
  'https://fiestahouseattire.com/',
  'https://fiestahouseattire.com/new/'
];

export class WebsiteScraperService {
  /**
   * Scrapes text content from the target pages to be embedded.
   */
  async scrapeAll(): Promise<{ url: string; content: string }[]> {
    const results: { url: string; content: string }[] = [];

    for (const url of TARGET_URLS) {
      try {
        console.log(`Scraping website content from: ${url}`);
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        const html = response.data;
        const $ = cheerio.load(html);

        // Remove scripts, styles, and empty elements
        $('script, style, noscript, nav, footer, header').remove();

        const content = $('body')
          .text()
          .replace(/\s+/g, ' ') // Collapse whitespace
          .trim();

        results.push({ url, content });
      } catch (error: any) {
        console.error(`Failed to scrape ${url}:`, error.message);
      }
    }

    return results;
  }
}

export const websiteScraper = new WebsiteScraperService();
