/**
 * Contact Lens Trial — Automated Follow-up & Expiry Messages.
 *
 * A daily cron checks every active contact-lens trial stored in the CMS data
 * (Supabase) and sends the "Follow Up" message 7 days after the appointment
 * date and the "Trial Expiry" message 28 days after the appointment date.
 *
 * Manual triggering is available via POST /api/contact-lens-trials/process.
 */

import cron from 'node-cron';
import fetch from 'node-fetch';

const TRIAL_FOLLOWUP_DELAY_DAYS = 7;
const TRIAL_EXPIRY_DELAY_DAYS = 28;

const DEFAULT_TRIAL_TEMPLATES = {
  before:
    "FORSIGHT EYEWEAR – CONTACT LENS APPOINTMENT\n\nHello {firstName},\n\nThis is a reminder of your upcoming contact lens fitting and training appointment.\n\nDate: {appointmentDate}\nTime: {appointmentTime}\nWith: one of our contact lens fitters\nLocation: {storeName}\n\nIMPORTANT – PLEASE READ BEFORE YOUR APPOINTMENT\n\nYOUR FINGERNAILS MUST BE SHORT AND TRIMMED BEFORE YOUR APPOINTMENT.\n\nIF YOUR NAILS ARE TOO LONG, WE WILL NOT BE ABLE TO COMPLETE YOUR CONTACT LENS TRAINING, AND YOUR APPOINTMENT WILL NEED TO BE RESCHEDULED.\n\nPlease also note:\n\n• Arrive on time for your scheduled appointment.\n• Allow 15–60 minutes for your contact lens training.\n• You will learn how to safely insert and remove your contact lenses.\n• If you are unable to complete the training during your appointment, an additional appointment may be required.\n\nACKNOWLEDGEMENT REQUIRED\n\nPlease reply YES to this message to confirm that you have received and read these important instructions.\n\nWe look forward to seeing you!\n\nForsight Eyewear",
  after:
    "FORSIGHT EYEWEAR – CONTACT LENS CARE & INSTRUCTIONS\n\nHello {firstName},\n\nThank you for visiting Forsight Eyewear today for your contact lens fitting and training appointment!\n\nWe hope you're enjoying your new contact lenses.\n\nIMPORTANT – CARING FOR YOUR CONTACT LENSES\n\nYour eye health and comfort are our priorities. Please remember the instructions provided during your appointment.\n\n1. INSERTING & REMOVING YOUR LENSES\n\nAlways wash and thoroughly dry your hands before handling your lenses.\n\nFollow the insertion and removal techniques demonstrated during your appointment.\n\nNever force a lens into or out of your eye.\n\nIf you're having difficulty, contact our clinic for assistance.\n\n2. WEARING YOUR TRIAL LENSES\n\nFollow the wearing schedule provided by your eye-care professional.\n\nNever sleep in your contact lenses unless specifically instructed by your eye-care professional.\n\nNever use tap water or saliva to clean or store contact lenses.\n\nFollow the specific replacement and care instructions for your prescribed lens type.\n\n3. COMFORT & VISION\n\nAs you become accustomed to your new lenses, please pay attention to:\n\nOverall comfort\n\nClarity of vision\n\nDryness or irritation\n\nAny difficulties inserting or removing your lenses\n\nIMPORTANT: If you experience eye pain, significant redness, unusual light sensitivity or changes in vision, remove your lenses immediately and seek prompt professional eye care.\n\n4. YOUR TRIAL PERIOD\n\nYour contact lens trial allows you to evaluate comfort and vision before purchasing your lenses.\n\nPLEASE NOTE: You have 45 days from your fitting appointment to place your contact lens order. After this period, another fitting assessment will be required.\n\n5. WE'LL CHECK IN WITH YOU\n\nWe'll send you a short follow-up message in approximately 7 days to see how you're doing.\n\nIf you experience any difficulties before then, please contact us at {storePhone}.\n\nPLEASE REPLY YES to acknowledge that you have received these instructions.\n\nThank you for choosing Forsight Eyewear!\n\nWe're here to help you see clearly and comfortably. — {storeName}",
  followup:
    "Hi {firstName}, it's the Forsight Eyewear team at {storeName}.\n\nHow are your trial contact lenses feeling?\n\nIf everything is going well and you're ready to order your contact lens supply, we'd love to help you get started.\n\nReply YES if you'd like to move forward, and our team will contact you as soon as possible to discuss your options.",
  expiry:
    "Forsight Eyewear — Hi {firstName}, your contact lens trial period has come to an end and it's time to return or replace your trial lenses.\n\nPlease drop by {storeName} so we can check your eyes, review how the lenses worked for you, and discuss your next steps — whether that's ordering your own supply or trying a different option.\n\nCall us at {storePhone} to arrange a visit. — {storeName}",
};

/** Capitalize the first word of a name (first name only). */
function capitalizeFirst(name) {
  if (!name) return '';
  const first = String(name).trim().split(/\s+/)[0];
  return first ? first[0].toUpperCase() + first.slice(1).toLowerCase() : '';
}

/** Build a trial-stage message body from the template + contact + store details. */
function buildTrialMessage(template, firstName, store, appointment) {
  const formatDate = (iso) => {
    if (!iso) return 'your appointment date';
    try {
      return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  };
  return (template || '')
    .replace(/\{firstName\}/g, firstName || 'there')
    .replace(/\{storeName\}/g, store?.name || 'Forsight Eyewear')
    .replace(/\{storePhone\}/g, store?.phone || '905-667-1825')
    .replace(/\{appointmentDate\}/g, formatDate(appointment?.date || ''))
    .replace(/\{appointmentTime\}/g, appointment?.time || '')
    .replace(/\{staffMember\}/g, appointment?.staffMember || 'our team');
}

/** Days elapsed since a date string (midnight-to-midnight). */
function daysSince(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return 0;
  const ms =
    now.setHours(0, 0, 0, 0) - new Date(dateStr).setHours(0, 0, 0, 0);
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/** Send an SMS to a CRM contact by contactId. */
async function sendCRMSms(crmConfig, contactId, message) {
  const smsRes = await fetch(
    'https://services.leadconnectorhq.com/conversations/messages',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${crmConfig.apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
      },
      body: JSON.stringify({
        type: 'SMS',
        locationId: crmConfig.locationId,
        contactId,
        message,
      }),
    },
  );
  if (!smsRes.ok) {
    const errData = await smsRes.json().catch(() => null);
    throw new Error(errData?.message || `SMS send failed (${smsRes.status})`);
  }
  return await smsRes.json();
}

/** Look up a CRM contactId by phone number. */
async function findContactIdByPhone(crmConfig, phone) {
  const normalizePhone = (p) => {
    let digits = String(p || '').replace(/[^0-9]/g, '');
    if (digits.length === 10 && !digits.startsWith('1')) digits = '1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    if (digits.length === 10) return '+1' + digits;
    return String(p || '').trim();
  };
  const params = new URLSearchParams({
    locationId: crmConfig.locationId,
    limit: '10',
    query: normalizePhone(phone),
  });
  const res = await fetch(
    `https://backend.leadconnectorhq.com/contacts/?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${crmConfig.apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
      },
    },
  );
  if (!res.ok) return '';
  const data = await res.json();
  const contacts = data?.contacts ?? [];
  return contacts.length > 0 ? contacts[0].id : '';
}

/**
 * Process all active contact-lens trials stored in CMS data and send the
 * automated follow-up (7 days) and expiry (28 days) messages when due.
 */
export async function processContactLensTrials(
  crmConfig,
  supabaseConfig,
  downloadCMSFromSupabase,
  uploadCMSToSupabase,
) {
  const cmsData = await downloadCMSFromSupabase(supabaseConfig);
  if (!cmsData || !Array.isArray(cmsData.contactLensTrials)) {
    return { checked: 0, sent: 0, failed: 0, details: [] };
  }

  const templates = {
    ...DEFAULT_TRIAL_TEMPLATES,
    ...(cmsData.contactLensTrialTemplates || {}),
  };
  const stores = (cmsData.hours || []).map((h) => ({
    id: h.id,
    name: h.name,
    address: h.address,
    phone: h.phone,
  }));
  const trials = cmsData.contactLensTrials;
  let sent = 0;
  let failed = 0;
  const details = [];

  for (const t of trials) {
    if (!t.active || !t.appointmentDate) continue;
    const elapsed = daysSince(t.appointmentDate);

    // Determine which stages are due
    const stagesDue = [];
    if (
      elapsed >= TRIAL_FOLLOWUP_DELAY_DAYS &&
      !(t.sentStages || []).includes('followup')
    ) {
      stagesDue.push('followup');
    }
    if (
      elapsed >= TRIAL_EXPIRY_DELAY_DAYS &&
      !(t.sentStages || []).includes('expiry')
    ) {
      stagesDue.push('expiry');
    }
    if (stagesDue.length === 0) continue;

    const firstName = capitalizeFirst(t.clientName || '') || 'there';
    const store = stores.find((s) => s.id === t.storeId) || stores[0];
    const appointment = {
      date: t.appointmentDate,
      time: t.appointmentTime,
      staffMember: t.staffMember,
    };

    for (const stage of stagesDue) {
      const messageBody = buildTrialMessage(
        templates[stage],
        firstName,
        store,
        appointment,
      );
      try {
        let contactId = t.contactId || '';
        if (!contactId && t.phone) {
          contactId = await findContactIdByPhone(crmConfig, t.phone);
        }
        if (!contactId) {
          failed++;
          details.push({
            client: t.clientName,
            stage,
            error: 'Contact not found in CRM',
          });
          continue;
        }
        await sendCRMSms(crmConfig, contactId, messageBody);
        t.sentStages = Array.from(new Set([...(t.sentStages || []), stage]));
        t.contactId = contactId;
        sent++;
        details.push({ client: t.clientName, stage, status: 'sent' });
      } catch (err) {
        failed++;
        details.push({ client: t.clientName, stage, error: err.message });
      }
    }
  }

  // Persist updated trials back to Supabase
  cmsData.contactLensTrials = trials;
  await uploadCMSToSupabase(supabaseConfig, cmsData);

  return { checked: trials.length, sent, failed, details };
}

/**
 * Register the contact-lens-trial routes + daily cron on the Express app.
 *
 * @param {import('express').Express} app
 * @param {() => Promise<any>} downloadCMSFromSupabase
 * @param {(cfg: any, data: any) => Promise<void>} uploadCMSToSupabase
 */
export function registerContactLensTrialRoute(
  app,
  downloadCMSFromSupabase,
  uploadCMSToSupabase,
) {
  // CRM Invoice endpoint — uses the text2pay endpoint to create an invoice
  // with the amount & item description pre-loaded AND text the real checkout
  // payment link to the contact in a single call. Returns the invoiceUrl so
  // the client can fall back to a direct SMS with the real checkout link.
  app.post('/api/create-crm-invoice', async (req, res) => {
    try {
      const { contactId, name, amount, note, currency, crmConfig } = req.body;
      if (!contactId || !amount) {
        return res
          .status(400)
          .json({ message: 'contactId and amount are required' });
      }

      const apiKey =
        crmConfig?.apiKey ||
        process.env.CRM_API_KEY ||
        'pit-d8fac32c-2f53-4547-95d3-00591506571a';
      const locationId =
        crmConfig?.locationId ||
        process.env.CRM_LOCATION_ID ||
        'ReWlxWSh0TQg1jBuQmf1';
      const todayStr = new Date().toISOString().split('T')[0];
      const cur = currency || 'CAD';

      // 1. Fetch contact details to populate required contactDetails object
      let contactDetails = { id: contactId, name: 'Valued Customer' };
      try {
        const contactRes = await fetch(
          `https://backend.leadconnectorhq.com/contacts/${contactId}?locationId=${locationId}`,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Version: '2021-07-28',
            },
          },
        );
        if (contactRes.ok) {
          const contactData = await contactRes.json();
          const c = contactData?.contact || contactData;
          contactDetails = {
            id: c.id,
            name:
              c.name ||
              `${c.firstName || ''} ${c.lastName || ''}`.trim() ||
              'Valued Customer',
            phoneNo: c.phone || '',
            email: c.email || '',
          };
        }
      } catch {
        /* use fallback */
      }

      // 2. Build the invoice payload — amount + description pre-loaded
      const invoicePayload = {
        altId: locationId,
        altType: 'location',
        name: name || 'Contact Lens Order',
        title: 'INVOICE',
        currency: cur,
        issueDate: todayStr,
        dueDate: todayStr,
        liveMode: true,
        contactDetails,
        items: [
          {
            name: note || 'Contact Lens Purchase',
            description: note || 'Contact Lens Purchase',
            amount: Number(amount),
            qty: 1,
            currency: cur,
            type: 'one_time',
          },
        ],
        discount: { value: 0, type: 'percentage' },
        sentTo: {
          email: contactDetails.email ? [contactDetails.email] : [],
          phoneNo: contactDetails.phoneNo ? [contactDetails.phoneNo] : [],
        },
      };

      // 3. Use text2pay — creates the invoice AND texts the payment link
      //    (with the amount + item pre-loaded) to the contact in one call.
      const text2payRes = await fetch(
        'https://services.leadconnectorhq.com/invoices/text2pay',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Version: 'v3',
          },
          body: JSON.stringify(invoicePayload),
        },
      );

      if (!text2payRes.ok) {
        const errText = await text2payRes.text();
        console.error('[Create CRM Invoice] text2pay error:', errText);

        // Fallback to two-step create + send if text2pay is unavailable
        try {
          const createRes = await fetch(
            'https://services.leadconnectorhq.com/invoices/',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Version: 'v3',
              },
              body: JSON.stringify(invoicePayload),
            },
          );
          if (createRes.ok) {
            const createdData = await createRes.json();
            const invoiceId =
              createdData?._id || createdData?.invoice?._id || createdData?.id;
            if (invoiceId) {
              // Send via SMS + Email
              await fetch(
                `https://services.leadconnectorhq.com/invoices/${invoiceId}/send`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    Version: 'v3',
                  },
                  body: JSON.stringify({
                    altId: locationId,
                    altType: 'location',
                    action: 'sms_and_email',
                    liveMode: true,
                  }),
                },
              ).catch(() => null);
              return res.json({
                success: true,
                invoiceId,
                invoiceUrl: createdData?.invoiceUrl || '',
                amount: Number(amount),
                currency: cur,
                sent: true,
              });
            }
          }
        } catch (fallbackErr) {
          console.error(
            '[Create CRM Invoice] fallback create error:',
            fallbackErr?.message,
          );
        }

        return res
          .status(text2payRes.status)
          .json({ message: 'Failed to create CRM invoice', details: errText });
      }

      const createdData = await text2payRes.json();
      const invoice =
        createdData?.invoice || createdData?.data?.invoice || createdData;
      const invoiceId =
        invoice?._id || createdData?._id || createdData?.id;
      const invoiceUrl =
        createdData?.invoiceUrl ||
        invoice?.invoiceUrl ||
        createdData?.url ||
        invoice?.url ||
        '';

      if (!invoiceId) {
        return res.status(500).json({
          message: 'Invoice created but no invoiceId returned',
          raw: createdData,
        });
      }

      res.json({
        success: true,
        invoiceId,
        invoiceUrl,
        amount: Number(amount),
        currency: cur,
        sent: true,
        raw: createdData,
      });
    } catch (error) {
      console.error('[Create CRM Invoice] error:', error);
      res
        .status(500)
        .json({ message: error?.message || 'Server error creating invoice' });
    }
  });
  // Manual endpoint to trigger trial processing on demand
  app.post('/api/contact-lens-trials/process', async (req, res) => {
    try {
      const { crmConfig, supabaseConfig } = req.body;
      if (!crmConfig?.apiKey || !crmConfig?.locationId) {
        return res
          .status(400)
          .json({ message: 'crmConfig (apiKey, locationId) required' });
      }
      if (!supabaseConfig?.url || !supabaseConfig?.bucket) {
        return res
          .status(400)
          .json({ message: 'supabaseConfig (url, bucket) required' });
      }
      const result = await processContactLensTrials(
        crmConfig,
        supabaseConfig,
        downloadCMSFromSupabase,
        uploadCMSToSupabase,
      );
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('Contact lens trial processing error:', error.message);
      res
        .status(500)
        .json({ message: error.message || 'Failed to process trials' });
    }
  });

  // Daily cron for contact lens trial automation — runs at 11:00 AM server time
  const TRIAL_CRON = process.env.TRIAL_CRON || '0 11 * * *';
  cron.schedule(TRIAL_CRON, async () => {
    console.log(
      `[${new Date().toISOString()}] Contact lens trial automation cron triggered`,
    );
    const crmConfig = {
      apiKey: process.env.CRM_API_KEY,
      locationId: process.env.CRM_LOCATION_ID,
    };
    const supabaseConfig = {
      url:
        process.env.SUPABASE_URL ||
        'https://vacmllwtvpehraaosmza.supabase.co',
      anonKey: process.env.SUPABASE_ANON_KEY || '',
      bucket: process.env.SUPABASE_BUCKET || 'videos',
    };
    if (!crmConfig.apiKey || !crmConfig.locationId) {
      console.warn('Trial cron skipped: CRM env vars not set');
      return;
    }
    try {
      const result = await processContactLensTrials(
        crmConfig,
        supabaseConfig,
        downloadCMSFromSupabase,
        uploadCMSToSupabase,
      );
      console.log(
        `Contact lens trials: ${result.sent} sent, ${result.failed} failed, ${result.checked} checked`,
      );
    } catch (error) {
      console.error('Contact lens trial cron failed:', error.message);
    }
  });
  console.log(`Contact lens trial cron scheduled: "${TRIAL_CRON}"`);
}
