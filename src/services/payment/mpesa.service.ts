import axios from 'axios';
import dayjs from 'dayjs';
import dotenv from 'dotenv';

dotenv.config();

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL;
const ENVIRONMENT = process.env.MPESA_ENVIRONMENT || 'sandbox';

const BASE_URL = ENVIRONMENT === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

export class MpesaService {
  private cachedToken: string | null = null;
  private tokenExpiryTime: number = 0;

  private httpClient = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });

  /**
   * Generates or retrieves cached OAuth Access Token
   */
  private async getAccessToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.cachedToken && now < this.tokenExpiryTime) {
      return this.cachedToken;
    }

    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');

    try {
      const response = await this.httpClient.get('/oauth/v1/generate?grant_type=client_credentials', {
        headers: {
          Authorization: `Basic ${auth}`
        }
      });

      const token = response.data.access_token;
      const expiresInSec = parseInt(response.data.expires_in, 10) || 3599;
      // Cache with 5 minute safety buffer
      this.cachedToken = token;
      this.tokenExpiryTime = now + (expiresInSec - 300) * 1000;

      return token;
    } catch (error: any) {
      const errorMsg = error.response?.data?.errorMessage || error.response?.data || error.message;
      console.error('M-Pesa Auth Error:', errorMsg);
      throw new Error('Failed to authenticate with M-Pesa');
    }
  }

  /**
   * Generates Password for STK Push
   */
  private generatePassword(timestamp: string): string {
    const data = `${SHORTCODE}${PASSKEY}${timestamp}`;
    return Buffer.from(data).toString('base64');
  }

  /**
   * Initiates STK Push (Lipa na M-Pesa Online)
   */
  async initiateStkPush(phoneNumber: string, amount: number, bookingId: string, retryCount = 0): Promise<any> {
    if (!CONSUMER_KEY || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY || !CALLBACK_URL) {
      throw new Error('M-Pesa credentials missing in environment variables');
    }

    const accessToken = await this.getAccessToken(retryCount > 0);
    const timestamp = dayjs().format('YYYYMMDDHHmmss');
    const password = this.generatePassword(timestamp);

    // Format phone number to 254XXXXXXXXX
    let formattedPhone = phoneNumber.replace(/\+/g, '').replace(/^0/, '254');
    if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
      formattedPhone = `254${formattedPhone}`;
    }

    // Safaricom Daraja field restrictions:
    // AccountReference: Max 12 alphanumeric characters
    const cleanDraftId = bookingId.replace(/[^a-zA-Z0-9]/g, '');
    const accountRef = (cleanDraftId ? cleanDraftId.slice(-10) : 'FiestaApp').slice(0, 12);

    // TransactionDesc: Max 13 alphanumeric characters
    const transactionDesc = 'BookingDeposit'.slice(0, 13);

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.max(1, Math.round(amount)),
      PartyA: formattedPhone,
      PartyB: SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: CALLBACK_URL,
      AccountReference: accountRef,
      TransactionDesc: transactionDesc
    };

    try {
      const response = await this.httpClient.post('/mpesa/stkpush/v1/processrequest', payload, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });

      console.log('M-Pesa STK Push Initiated:', response.data);
      return response.data;
    } catch (error: any) {
      const rawData = error.response?.data;
      const isIncapsulaBlock = typeof rawData === 'string' && (rawData.includes('Incapsula') || rawData.includes('incident_id'));

      if (isIncapsulaBlock) {
        const incidentMatch = rawData.match(/incident_id=([0-9\-]+)/);
        const incidentId = incidentMatch ? incidentMatch[1] : 'unknown';
        console.error(`M-Pesa STK Push blocked by Imperva Incapsula WAF (Incident ID: ${incidentId})`);
      } else {
        console.error('M-Pesa STK Push Error:', rawData || error.message);
      }

      // Retry once if token was invalid or if temporary WAF glitch occurred
      if (retryCount === 0 && (error.response?.status === 401 || error.response?.status === 403)) {
        console.log('Retrying M-Pesa STK Push with fresh token...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.initiateStkPush(phoneNumber, amount, bookingId, retryCount + 1);
      }

      throw error;
    }
  }
}

export const mpesaService = new MpesaService();

