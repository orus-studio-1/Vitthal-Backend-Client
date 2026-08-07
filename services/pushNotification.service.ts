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
