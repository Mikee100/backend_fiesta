import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// 'meta' talks to Meta's Graph API directly (requires Advanced Access for real customers).
// '360dialog' routes through the BSP instead, sidestepping Meta's App Review gate.
const PROVIDER = process.env.WHATSAPP_PROVIDER || 'meta';

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v25.0';

const D360_API_KEY = process.env.D360_API_KEY;
const D360_API_BASE_URL = process.env.D360_API_BASE_URL || 'https://waba-sandbox.360dialog.io/v1';

export function normalizeWhatsappText(value: string): string {
  return value
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shouldRetryWhatsAppError(error: any): boolean {
  const status = error?.response?.status ?? error?.status;
  const message = String(error?.response?.data?.error?.message ?? error?.message ?? '');
  const code = error?.response?.data?.error?.code ?? error?.code;

  return Boolean(
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 2 ||
    code === 'ECONNRESET' ||
    message.toLowerCase().includes('temporarily unavailable') ||
    message.toLowerCase().includes('rate limit') ||
    message.toLowerCase().includes('timeout') ||
    message.toLowerCase().includes('connection')
  );
}

function getRequestConfig() {
  if (PROVIDER === '360dialog') {
    return {
      url: `${D360_API_BASE_URL}/messages`,
      headers: {
        'D360-API-KEY': D360_API_KEY,
        'Content-Type': 'application/json',
      },
    };
  }

  return {
    url: `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
}

export class WhatsAppService {
  /**
   * Sends a text message to a WhatsApp recipient
   */
  async sendMessage(to: string, text: string) {
    if (PROVIDER === '360dialog' && !D360_API_KEY) {
      console.error('D360_API_KEY missing in .env');
      return;
    }
    if (PROVIDER === 'meta' && (!ACCESS_TOKEN || !PHONE_NUMBER_ID)) {
      console.error('WhatsApp credentials missing in .env');
      return;
    }

    const { url, headers } = getRequestConfig();
    const bodyText = normalizeWhatsappText(text);

    if (!bodyText) {
      throw new Error('WhatsApp message body is empty after normalization');
    }

    let lastError: any = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await axios.post(
          url,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body: bodyText },
          },
          { headers }
        );

        console.log(`WhatsApp message sent to ${to}: ${response.data.messages[0].id}`);
        return response.data;
      } catch (error: any) {
        lastError = error;
        const isTransient = shouldRetryWhatsAppError(error);

        if (!isTransient || attempt === 3) {
          console.error('Error sending WhatsApp message:', error.response?.data || error.message);
          throw error;
        }

        const backoffMs = 250 * attempt * 2;
        console.warn(`Transient WhatsApp send failure on attempt ${attempt}; retrying in ${backoffMs}ms`, error.response?.data || error.message);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }

    throw lastError;
  }

  /**
   * Sends a document (e.g. an invoice PDF) as a real WhatsApp file attachment.
   * Supports both direct Meta Graph API and 360dialog.
   * Callers should catch and fall back to a text message (e.g. with a
   * download link) if this throws (for example, credentials or provider
   * capability issues).
   */
  async sendDocument(to: string, fileBuffer: Buffer, filename: string, caption?: string) {
    let mediaId: string;

    if (PROVIDER === '360dialog') {
      if (!D360_API_KEY) {
        throw new Error('D360_API_KEY missing in .env');
      }

      const mediaBaseUrl = process.env.D360_MEDIA_BASE_URL || 'https://waba-v2.360dialog.io';
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', new Blob([new Uint8Array(fileBuffer)], { type: 'application/pdf' }), filename);

      const uploadResponse = await axios.post(`${mediaBaseUrl}/media`, form, {
        headers: { 'D360-API-KEY': D360_API_KEY },
      });

      mediaId = uploadResponse.data.id;
    } else {
      if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error('WhatsApp credentials missing in .env');
      }

      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', new Blob([new Uint8Array(fileBuffer)], { type: 'application/pdf' }), filename);

      const uploadRes = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/media`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
          body: form,
        }
      );

      if (!uploadRes.ok) {
        const errorText = await uploadRes.text();
        throw new Error(`Meta media upload failed (${uploadRes.status}): ${errorText}`);
      }

      const uploadJson = await uploadRes.json() as { id?: string };
      if (!uploadJson.id) {
        throw new Error('Meta media upload succeeded but no media id was returned');
      }

      mediaId = uploadJson.id;
    }

    const { url, headers } = getRequestConfig();
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'document',
        document: { id: mediaId, filename, caption },
      },
      { headers }
    );

    console.log(`WhatsApp document sent to ${to}: ${response.data.messages[0].id}`);
    return response.data;
  }

  /**
   * Marks a message as read
   */
  async markAsRead(messageId: string) {
    const { url, headers } = getRequestConfig();

    try {
      await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        },
        { headers }
      );
    } catch (error: any) {
      console.error('Error marking message as read:', error.response?.data || error.message);
    }
  }
}

export const whatsappService = new WhatsAppService();
