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

    try {
      const response = await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'text',
          text: { body: text },
        },
        { headers }
      );

      console.log(`WhatsApp message sent to ${to}: ${response.data.messages[0].id}`);
      return response.data;
    } catch (error: any) {
      console.error('Error sending WhatsApp message:', error.response?.data || error.message);
      throw error;
    }
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
