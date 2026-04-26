import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

export class InstagramService {
  private getAccessToken(): string | undefined {
    // Refresh env vars in case they changed
    dotenv.config();
    // IG Graph API requires the Facebook Page Access Token linked to the IG account (starts with EAA...)
    // If the token starts with IGAA, it is an Instagram User Token which is invalid for messaging.
    return process.env.INSTAGRAM_PAGE_ACCESS_TOKEN || 
           process.env.FB_PAGE_ACCESS_TOKEN || 
           process.env.INSTAGRAM_ACCESS_TOKEN;
  }

  private getApiVersion(): string {
    return process.env.WHATSAPP_API_VERSION || 'v20.0';
  }

  private getIgUserId(): string {
    return process.env.INSTAGRAM_IG_USER_ID || process.env.INSTAGRAM_PAGE_ID || 'me';
  }

  private buildApiUrl(endpoint: string, token: string): string {
    // If the token starts with IGAA, it's the new Instagram-only API
    if (token.startsWith('IGAA')) {
      return `https://graph.instagram.com/${this.getApiVersion()}/me/${endpoint}?access_token=${token}`;
    }
    // Otherwise, it's the classic Facebook Graph API
    return `https://graph.facebook.com/${this.getApiVersion()}/${this.getIgUserId()}/${endpoint}?access_token=${token}`;
  }

  /**
   * Helper to send a single payload
   */
  private async sendSingleMessage(recipientId: string, text: string, token: string) {
    const url = this.buildApiUrl('messages', token);
    try {
      const response = await axios.post(
        url,
        {
          recipient: { id: recipientId },
          message: { text: text }
        },
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
      console.log(`Instagram message sent to ${recipientId}: ${response.data.message_id}`);
      return response.data;
    } catch (error: any) {
      console.error('Error sending Instagram message:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Sends a text message to an Instagram recipient via Facebook/Instagram Graph API
   */
  async sendMessage(recipientId: string, text: string) {
    const token = this.getAccessToken();
    if (!token) {
      console.error('Instagram Access Token missing in .env');
      return;
    }

    const MAX_LENGTH = 950; // IG limit is 1000, keep a safety margin

    if (text.length <= MAX_LENGTH) {
      return this.sendSingleMessage(recipientId, text, token);
    }

    // Chunking logic for long messages
    let remaining = text;
    while (remaining.length > 0) {
      let chunk = remaining.substring(0, MAX_LENGTH);
      
      if (remaining.length > MAX_LENGTH) {
        // Try to break at a newline or space so we don't cut words in half
        const lastNewline = chunk.lastIndexOf('\n');
        const lastSpace = chunk.lastIndexOf(' ');
        const breakPoint = Math.max(lastNewline, lastSpace);
        
        if (breakPoint > 0) {
          chunk = chunk.substring(0, breakPoint);
        }
      }

      await this.sendSingleMessage(recipientId, chunk.trim(), token);
      remaining = remaining.substring(chunk.length).trim();
    }
  }

  /**
   * Marks a message as read (Optional/if supported for IG)
   */
  async markAsRead(recipientId: string) {
    const token = this.getAccessToken();
    if (!token) return;

    const url = this.buildApiUrl('messages', token);

    try {
      await axios.post(
        url,
        {
          recipient: {
            id: recipientId
          },
          sender_action: "mark_seen"
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (error: any) {
      console.error('Error marking IG message as read:', error.response?.data || error.message);
    }
  }
}

export const instagramService = new InstagramService();
