import axios from 'axios';

async function testWhatsAppWebhook() {
  const url = 'http://localhost:4000/api/whatsapp/webhook';
  
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '12345',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '123456789',
                phone_number_id: '12345'
              },
              messages: [
                {
                  from: '254721840961',
                  id: 'wamid.HBgLMjU0NzI0MTM1NzY0FQIAERgSQzhGOUY4NjU0MEZERDkzNDI4AA==',
                  timestamp: '1713770000',
                  text: {
                    body: 'Hello, what services do you offer?'
                  },
                  type: 'text'
                }
              ]
            },
            field: 'messages'
          }
        ]
      }
    ]
  };

  try {
    const response = await axios.post(url, payload);
    console.log('Response Status:', response.status);
    console.log('Response Data:', response.data);
  } catch (error: any) {
    console.error('Test Failed:', error.response?.data || error.message);
  }
}

testWhatsAppWebhook();
