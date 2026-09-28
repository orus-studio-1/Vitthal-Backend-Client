import axios from 'axios';

export interface ExpoPushPayload {
  to: string;
  sound?: 'default' | string;
  title: string;
  body: string;
  data?: Record<string, any>;
  badge?: number;
  priority?: 'default' | 'normal' | 'high';
}

/**
 * Sends a direct Expo Push Notification to a mobile device token.
 */
export const sendExpoPushNotification = async (payload: ExpoPushPayload): Promise<boolean> => {
  if (!payload.to || !payload.to.startsWith('ExponentPushToken[')) {
    console.log('[PushNotification] Invalid or non-expo push token:', payload.to);
    return false;
  }

  try {
    const response = await axios.post('https://exp.host/--/api/v2/push/send', {
      to: payload.to,
      sound: payload.sound || 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      badge: payload.badge || 1,
      priority: payload.priority || 'high',
    }, {
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    console.log('[PushNotification] Push notification dispatched successfully:', response.status);
    return response.status === 200;
  } catch (error: any) {
    console.error('[PushNotification] Error dispatching Expo push alert:', error.response?.data || error.message);
    return false;
  }
};


export async function sendWhatsAppNotification(data: {
  name: string; email: string; phone?: string; subject: string; message: string;
}) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const adminNumber = process.env.WHATSAPP_ADMIN_NUMBER; 
  await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: adminNumber,
      type: "text",
      text: {
        body: `New contact query\nFrom: ${data.name} (${data.email})\nPhone: ${data.phone || "N/A"}\nSubject: ${data.subject}\nMessage: ${data.message}`,
      },
    }),
  });
}
