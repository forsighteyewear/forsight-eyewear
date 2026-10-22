/**
 * Referral SMS & Email proxy routes.
 *
 * These routes send SMS/email through the CRM conversations API. They
 * prefer the server-side CRM_API_KEY environment variable (which is always
 * valid) and fall back to the client-supplied apiKey. This fixes
 * "Invalid Private Integration token" errors that occur when the
 * client-side key has expired or been rotated.
 */
import fetch from 'node-fetch';

const SERVICES_BASE = 'https://services.leadconnectorhq.com';

/** Resolve the best available API key: server env first, then client-supplied. */
function resolveApiKey(clientKey) {
  const envKey = process.env.CRM_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  if (clientKey && String(clientKey).trim()) return String(clientKey).trim();
  return '';
}

export function registerReferralMessagingRoutes(app) {
  // ---- Send referral SMS ----
  app.post('/api/send-referral-sms', async (req, res) => {
    try {
      const { contactId, locationId, message, apiKey } = req.body;

      if (!contactId || !locationId || !message) {
        return res.status(400).json({
          message: 'contactId, locationId, and message are required',
        });
      }

      const effectiveKey = resolveApiKey(apiKey);
      if (!effectiveKey) {
        return res.status(400).json({
          message:
            'No valid CRM API key. Set CRM_API_KEY in the backend environment.',
        });
      }

      const smsRes = await fetch(`${SERVICES_BASE}/conversations/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${effectiveKey}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
        body: JSON.stringify({
          type: 'SMS',
          locationId,
          contactId,
          message,
        }),
      });

      if (!smsRes.ok) {
        const errData = await smsRes.json().catch(() => null);
        throw new Error(
          errData?.message || `SMS send failed (${smsRes.status})`,
        );
      }

      const result = await smsRes.json();
      res.json({
        success: true,
        messageId: result?.id || result?.messageId || null,
      });
    } catch (error) {
      console.error('Referral SMS Error:', error.message);
      res.status(500).json({ message: error.message || 'Failed to send SMS' });
    }
  });

  // ---- Send referral Email ----
  app.post('/api/send-referral-email', async (req, res) => {
    try {
      const { contactId, locationId, subject, message, apiKey } = req.body;

      if (!contactId || !locationId || !message) {
        return res.status(400).json({
          message: 'contactId, locationId, and message are required',
        });
      }

      const effectiveKey = resolveApiKey(apiKey);
      if (!effectiveKey) {
        return res.status(400).json({
          message:
            'No valid CRM API key. Set CRM_API_KEY in the backend environment.',
        });
      }

      const emailRes = await fetch(`${SERVICES_BASE}/conversations/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${effectiveKey}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
        body: JSON.stringify({
          type: 'Email',
          locationId,
          contactId,
          subject: subject || '',
          html: message,
          message,
        }),
      });

      if (!emailRes.ok) {
        const errData = await emailRes.json().catch(() => null);
        throw new Error(
          errData?.message || `Email send failed (${emailRes.status})`,
        );
      }

      const result = await emailRes.json();
      res.json({
        success: true,
        messageId: result?.id || result?.messageId || null,
      });
    } catch (error) {
      console.error('Referral Email Error:', error.message);
      res.status(500).json({ message: error.message || 'Failed to send email' });
    }
  });
}
