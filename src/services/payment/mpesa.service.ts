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
  /**
   * Generates OAuth Access Token
   */
  private async getAccessToken(): Promise<string> {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
    
    try {
      const response = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: {
          Authorization: `Basic ${auth}`
        }
      });
      return response.data.access_token;
    } catch (error: any) {
      console.error('M-Pesa Auth Error:', error.response?.data || error.message);
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
  async initiateStkPush(phoneNumber: string, amount: number, bookingId: string) {
    if (!CONSUMER_KEY || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY || !CALLBACK_URL) {
      throw new Error('M-Pesa credentials missing in environment variables');
    }

    const accessToken = await this.getAccessToken();
    const timestamp = dayjs().format('YYYYMMDDHHmmss');
    const password = this.generatePassword(timestamp);

    // Format phone number to 254XXXXXXXXX
    let formattedPhone = phoneNumber.replace(/\+/g, '').replace(/^0/, '254');
    if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
      formattedPhone = `254${formattedPhone}`;
    }

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: CALLBACK_URL,
      AccountReference: `Fiesta-${bookingId.substring(0, 8)}`,
      TransactionDesc: `Deposit for Booking ${bookingId}`
    };

    try {
      const response = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, payload, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      
      console.log('M-Pesa STK Push Initiated:', response.data);
      return response.data;
    } catch (error: any) {
      console.error('M-Pesa STK Push Error:', error.response?.data || error.message);
      throw error;
    }
  }
}

export const mpesaService = new MpesaService();
