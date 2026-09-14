import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  example?: {
    body_text?: string[][];
  };
  buttons?: Array<{
    type: string;
    text: string;
    url?: string;
    phone_number?: string;
  }>;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  category: string;
  language: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'DISABLED' | 'PAUSED' | 'IN_APPEAL';
  components: TemplateComponent[];
  quality_score?: { score: string };
  rejected_reason?: string;
  created_time?: string;
  updated_time?: string;
}

export interface CreateTemplatePayload {
  name: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  language: string;
  parameter_format?: 'POSITIONAL' | 'NAMED';
  components: TemplateComponent[];
}

export interface MetaApiError {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export class WhatsAppTemplatesService {
  /**
   * Verify that the access token is valid and return basic account info.
   */
  async getAccountInfo(): Promise<{
    wabaId: string;
    phoneNumberId: string;
    name?: string;
    currency?: string;
    timezone?: string;
  }> {
    if (!ACCESS_TOKEN || !WABA_ID) {
      throw new Error('WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID is not configured');
    }

    const response = await axios.get(`${GRAPH_BASE}/${WABA_ID}`, {
      params: { fields: 'name,currency,timezone_id,message_template_namespace' },
      headers: authHeaders(),
    });

    return {
      wabaId: WABA_ID!,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      name: response.data.name,
      currency: response.data.currency,
      timezone: response.data.timezone_id,
    };
  }

  /**
   * Retrieve all message templates for the connected WABA.
   */
  async getTemplates(): Promise<WhatsAppTemplate[]> {
    if (!ACCESS_TOKEN || !WABA_ID) {
      throw new Error('WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID is not configured');
    }

    const response = await axios.get(`${GRAPH_BASE}/${WABA_ID}/message_templates`, {
      params: {
        fields: 'id,name,category,language,status,components,quality_score,rejected_reason,created_time',
        limit: 100,
      },
      headers: authHeaders(),
    });

    return response.data.data as WhatsAppTemplate[];
  }

  /**
   * Create a new message template via Meta Graph API.
   */
  async createTemplate(payload: CreateTemplatePayload): Promise<{
    id: string;
    status: string;
    category: string;
  }> {
    if (!ACCESS_TOKEN || !WABA_ID) {
      throw new Error('WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID is not configured');
    }

    console.log('[WA_TEMPLATES] Meta create request:', JSON.stringify({
      method: 'POST',
      endpoint: `${GRAPH_BASE}/${WABA_ID}/message_templates`,
      apiVersion: API_VERSION,
      payload,
    }, null, 2));

    const response = await axios.post(
      `${GRAPH_BASE}/${WABA_ID}/message_templates`,
      payload,
      { headers: authHeaders() }
    );

    return response.data;
  }
}

export const whatsappTemplatesService = new WhatsAppTemplatesService();
