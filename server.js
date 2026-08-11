import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GA4_SERVICE_ACCOUNT_EMAIL = process.env.GA4_SERVICE_ACCOUNT_EMAIL;
const GA4_SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');

// --- GA4 Data API helpers ---

function createServiceAccountJWT(serviceAccountEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${encodedHeader}.${encodedPayload}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  const signature = sign.sign(privateKey, 'base64url');

  return `${data}.${signature}`;
}

async function getGA4AccessToken() {
  if (!GA4_SERVICE_ACCOUNT_EMAIL || !GA4_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new Error('GA4 service account credentials not configured. Set GA4_SERVICE_ACCOUNT_EMAIL and GA4_SERVICE_ACCOUNT_PRIVATE_KEY in .env');
  }

  const jwt = createServiceAccountJWT(GA4_SERVICE_ACCOUNT_EMAIL, GA4_SERVICE_ACCOUNT_PRIVATE_KEY);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(`GA4 auth failed: ${result.error_description || result.error || 'Unknown error'}`);
  }
  return result.access_token;
}

// Realtime report endpoint
app.post('/api/ga4-realtime', async (req, res) => {
  try {
    const { propertyId } = req.body;
    if (!propertyId) {
      return res.status(400).json({ message: 'GA4 Property ID is required' });
    }

    const accessToken = await getGA4AccessToken();

    const response = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runRealtimeReport`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          metrics: [
            { name: 'activeUsers' },
            { name: 'screenPageViews' },
            { name: 'averageSessionDuration' },
          ],
          dimensions: [
            { name: 'unifiedScreenName' },
            { name: 'sessionMedium' },
            { name: 'country' },
          ],
          dimensionFilters: [],
          orderBys: [
            {
              metric: { metricName: 'activeUsers' },
              desc: true,
            },
          ],
          limit: 10,
        }),
      }
    );

    const result = await response.json();
    if (!response.ok) {
      console.error('GA4 Data API error:', JSON.stringify(result));
      throw new Error(result.error?.message || 'Failed to fetch GA4 realtime data');
    }

    res.json(result);
  } catch (error) {
    console.error('GA4 Realtime Error:', error.message);
    res.status(500).json({ message: error.message || 'Failed to fetch realtime analytics' });
  }
});

// Traffic source breakdown report endpoint (date range)
app.post('/api/ga4-traffic-sources', async (req, res) => {
  try {
    const { propertyId, startDate, endDate } = req.body;
    if (!propertyId) {
      return res.status(400).json({ message: 'GA4 Property ID is required' });
    }

    const accessToken = await getGA4AccessToken();

    const response = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dateRanges: [{ startDate: startDate || '30daysAgo', endDate: endDate || 'today' }],
          dimensions: [{ name: 'sessionMedium' }, { name: 'sessionSource' }],
          metrics: [{ name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 50,
        }),
      }
    );

    const result = await response.json();
    if (!response.ok) {
      console.error('GA4 Traffic Sources error:', JSON.stringify(result));
      throw new Error(result.error?.message || 'Failed to fetch GA4 traffic source data');
    }

    // Categorize sessions into organic, direct, social, referral
    const categories = { organic: 0, direct: 0, social: 0, referral: 0, other: 0 };
    const rawRows = [];

    if (result.rows) {
      for (const row of result.rows) {
        const medium = (row.dimensionValues?.[0]?.value || '').toLowerCase();
        const source = (row.dimensionValues?.[1]?.value || '').toLowerCase();
        const sessions = parseInt(row.metricValues?.[0]?.value || '0', 10);
        rawRows.push({ medium, source, sessions });

        if (medium === 'organic' || medium === 'seo') {
          categories.organic += sessions;
        } else if (medium === '(none)' || medium === 'direct') {
          categories.direct += sessions;
        } else if (medium === 'social' || ['facebook', 'instagram', 'twitter', 'linkedin', 'youtube', 'tiktok', 'pinterest', 'reddit'].includes(source)) {
          categories.social += sessions;
        } else if (medium === 'referral' || medium === 'email' || medium === 'cpc' || medium === 'paid') {
          categories.referral += sessions;
        } else {
          categories.other += sessions;
        }
      }
    }

    res.json({ categories, rawRows, totalSessions: result.totals?.[0]?.metricValues?.[0]?.value || 0 });
  } catch (error) {
    console.error('GA4 Traffic Sources Error:', error.message);
    res.status(500).json({ message: error.message || 'Failed to fetch traffic source data' });
  }
});

app.post('/api/generate-special', async (req, res) => {
  try {
    const { title, features } = req.body;
    if (!title || !features) {
      return res.status(400).json({ message: 'Title and features are required' });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an expert copywriter for a high-end optometry and eyewear clinic. Write a compelling, concise promotional description for a special offer based on the provided title and bullet points. Do not include the bullet points in your output, just write the persuasive paragraph(s). Do not include labels like 'Description:' or 'Content:'. Keep it professional but engaging."
          },
          {
            role: "user",
            content: `Title: ${title}\nFeatures/Details:\n${features.join("\n")}`
          }
        ]
      })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message || "Failed to generate content");
    }

    const generatedText = result.choices[0].message.content.trim();
    res.json({ description: generatedText });
  } catch (error) {
    console.error("AI Generation Error:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
});

app.post('/api/generate-blog', async (req, res) => {
  try {
    const { title, details } = req.body;
    if (!title || !details) {
      return res.status(400).json({ message: 'Title and details are required' });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are an expert blog writer for an optometry clinic. Write a full, engaging blog post based on the title and short details provided. Format your entire response strictly in HTML (using <p>, <h3>, <ul>, <li>, <strong>). Do NOT use Markdown (like # or **). Do not include the main <h1> title. Do not include labels like 'Heading:' or 'Content:'. Just output the raw HTML content."
          },
          {
            role: "user",
            content: `Title: ${title}\nDetails/Excerpt: ${details}`
          }
        ]
      })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message || "Failed to generate blog content");
    }

    const generatedText = result.choices[0].message.content.trim();
    res.json({ content: generatedText });
  } catch (error) {
    console.error("AI Generation Error:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
});

app.post('/api/generate-brand-description', async (req, res) => {
  try {
    const { brandName, websiteUrl } = req.body;
    if (!brandName || !websiteUrl) {
      return res.status(400).json({ message: 'Brand name and website URL are required' });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          {
            role: "system",
            content: "You are a copywriter for a premium eyewear boutique."
          },
          {
            role: "user",
            content: `Brand: ${brandName}\nWebsite: ${websiteUrl}\nWrite a compelling brand description under 300 characters.`
          }
        ]
      })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message || "Failed to generate description");
    }

    // Extracting text from Responses API format
    const generatedText = result.output_text?.trim() || "Generated description.";
    res.json({ description: generatedText });
  } catch (error) {
    console.error("AI Generation Error:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
});
// ============================================================
// CRM ↔ Supabase Bidirectional Sync
// ============================================================

import cron from 'node-cron';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Fetch all contacts from the CRM with pagination.
 */
async function fetchAllCRMContacts(crmConfig) {
  const { apiBase, apiKey, locationId, fieldIdReferralCode, fieldIdCreditBalance, fieldIdTotalReferrals } = crmConfig;
  let allContacts = [];
  let fetchUrl = `${apiBase}/contacts/?locationId=${locationId}&limit=100`;

  while (fetchUrl) {
    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
    });

    if (!response.ok) {
      throw new Error(`CRM API Error: ${response.status}`);
    }

    const result = await response.json();
    const contacts = result.contacts || [];
    allContacts = [...allContacts, ...contacts];

    if (result.meta && result.meta.nextPageUrl) {
      const nextUrl = result.meta.nextPageUrl;
      if (nextUrl.startsWith('http')) {
        fetchUrl = nextUrl;
      } else if (nextUrl.startsWith('/')) {
        fetchUrl = `${apiBase}${nextUrl}`;
      } else if (nextUrl.startsWith('?')) {
        const baseUrl = fetchUrl.split('?')[0];
        fetchUrl = `${baseUrl}${nextUrl}`;
      } else {
        fetchUrl = `${apiBase}/${nextUrl}`;
      }
    } else {
      fetchUrl = "";
    }
  }

  // Map to referral client format
  return allContacts.map((c) => {
    const customFields = c.customFields || [];
    const getField = (id) => {
      const field = customFields.find((f) => f.id === id);
      return field ? (field.value ?? field.fieldValue ?? '') : '';
    };

    let referralCode = getField(fieldIdReferralCode);
    if (typeof referralCode === 'string') referralCode = referralCode.trim();
    if (!referralCode || referralCode === "") referralCode = "N/A";

    const rawBalance = getField(fieldIdCreditBalance);
    const balanceNum = parseFloat(rawBalance || '0');
    const totalRef = getField(fieldIdTotalReferrals);

    return {
      id: c.id || Date.now().toString() + Math.random().toString(36),
      name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown',
      email: c.email || '',
      phone: c.phone || '',
      referralCode,
      rewardAmount: `$${balanceNum.toFixed(2)}`,
      status: balanceNum > 0 ? 'rewarded' : 'pending',
      referralDate: new Date(c.dateAdded || Date.now()).toISOString().split('T')[0],
      location: 'CRM Synced',
      notes: `Total Referrals: ${totalRef || '0'}`,
    };
  });
}

/**
 * Push referral code back to a CRM contact.
 */
async function pushReferralCodeToCRMContact(crmConfig, contactId, referralCode) {
  const { apiBase, apiKey, fieldIdReferralCode } = crmConfig;
  if (!fieldIdReferralCode) return;

  await fetch(`${apiBase}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28',
    },
    body: JSON.stringify({
      customFields: [{ id: fieldIdReferralCode, field_value: referralCode }],
    }),
  });
}

/**
 * Download current CMS data from Supabase storage.
 */
async function downloadCMSFromSupabase(supabaseConfig) {
  const { url, anonKey, bucket } = supabaseConfig;
  if (!url || !bucket) return null;

  try {
    const publicUrl = `${url}/storage/v1/object/public/${bucket}/cms_data.json?t=${Date.now()}`;
    const response = await fetch(publicUrl);
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {
    console.error('Supabase download failed:', e.message);
  }
  return null;
}

/**
 * Upload CMS data to Supabase storage.
 */
async function uploadCMSToSupabase(supabaseConfig, cmsData) {
  const { url, anonKey, bucket } = supabaseConfig;
  if (!url || !anonKey || !bucket) {
    console.warn('Supabase config incomplete — skipping upload');
    return;
  }

  const supabase = createSupabaseClient(url, anonKey);
  const blob = new Blob([JSON.stringify(cmsData)], { type: 'application/json' });
  const { error } = await supabase.storage
    .from(bucket)
    .upload('cms_data.json', blob, { upsert: true, cacheControl: '0' });

  if (error) {
    console.error('Supabase upload error:', error.message);
  }
}

/**
 * Deduplicate referral clients by phone, email, and referral code.
 * Merges duplicate groups into a single record, combining rewards and notes.
 */
function deduplicateClients(clients) {
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizePhone = (s) => {
    let digits = String(s || '').replace(/[^0-9]/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    return digits;
  };
  const normalizeName = (s) => {
    return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
  };
  const groups = [];
  const visited = new Set();

  for (let i = 0; i < clients.length; i++) {
    if (visited.has(clients[i].id)) continue;
    const group = [];
    const aName = normalizeName(clients[i].name);
    for (let j = 0; j < clients.length; j++) {
      if (visited.has(clients[j].id)) continue;
      const a = clients[i];
      const b = clients[j];
      const sameCode = a.referralCode && a.referralCode !== 'N/A' && a.referralCode === b.referralCode;
      const sameEmail = a.email && normalize(a.email) && normalize(a.email) === normalize(b.email);
      const samePhone = a.phone && normalizePhone(a.phone) && normalizePhone(a.phone) === normalizePhone(b.phone);
      const bName = normalizeName(b.name);
      const sameName = aName && aName !== 'unknown' && aName === bName;
      if (sameCode || sameEmail || samePhone || sameName) {
        group.push(b);
        visited.add(b.id);
      }
    }
    if (group.length > 1) groups.push(group);
  }

  if (groups.length === 0) {
    return { clients, duplicatesRemoved: 0, duplicateGroups: 0 };
  }

  const mergedIds = new Set();
  const mergedClients = [];

  groups.forEach((group) => {
    const sorted = [...group].sort((a, b) => {
      const aReward = parseFloat((a.rewardAmount || '$0').replace(/[^0-9.-]+/g, '')) || 0;
      const bReward = parseFloat((b.rewardAmount || '$0').replace(/[^0-9.-]+/g, '')) || 0;
      if (bReward !== aReward) return bReward - aReward;
      const aScore = (a.name ? 1 : 0) + (a.email ? 1 : 0) + (a.phone ? 1 : 0) + (a.notes ? 1 : 0);
      const bScore = (b.name ? 1 : 0) + (b.email ? 1 : 0) + (b.phone ? 1 : 0) + (b.notes ? 1 : 0);
      return bScore - aScore;
    });
    const primary = sorted[0];
    const totalReward = group.reduce((sum, c) => sum + (parseFloat((c.rewardAmount || '$0').replace(/[^0-9.-]+/g, '')) || 0), 0);
    const allNotes = group.map((c) => c.notes).filter(Boolean);
    const referralCode = primary.referralCode !== 'N/A' ? primary.referralCode : (group.find((c) => c.referralCode && c.referralCode !== 'N/A')?.referralCode || primary.referralCode);
    const email = primary.email || group.find((c) => c.email)?.email || '';
    const phone = primary.phone || group.find((c) => c.phone)?.phone || '';
    const name = primary.name !== 'Unknown' ? primary.name : (group.find((c) => c.name && c.name !== 'Unknown')?.name || primary.name);

    const merged = {
      ...primary,
      name,
      email,
      phone,
      referralCode,
      rewardAmount: `$${totalReward.toFixed(2)}`,
      status: totalReward > 0 ? 'rewarded' : primary.status,
      notes: allNotes.join('\n---\n'),
    };
    mergedClients.push(merged);
    group.forEach((c) => mergedIds.add(c.id));
  });

  const untouched = clients.filter((c) => !mergedIds.has(c.id));
  const finalClients = [...mergedClients, ...untouched];
  const duplicatesRemoved = clients.length - finalClients.length;

  return { clients: finalClients, duplicatesRemoved, duplicateGroups: groups.length };
}
server.js — Part 3 (lines 531–741)
/**
 * Perform a full bidirectional sync:
 * 1. Download CMS data from Supabase
 * 2. Fetch all contacts from CRM
 * 3. Merge: update existing clients, add new ones, generate missing referral codes
 * 4. Deduplicate merged clients (by phone, email, referral code)
 * 5. Push missing referral codes back to CRM
 * 6. Upload deduplicated CMS data back to Supabase
 */
async function performCRMSync(crmConfig, supabaseConfig) {
  console.log(`[${new Date().toISOString()}] Starting CRM ↔ Supabase sync...`);

  // Step 1: Download current CMS data from Supabase
  const cmsData = await downloadCMSFromSupabase(supabaseConfig);
  if (!cmsData) {
    throw new Error('Could not download CMS data from Supabase. Check bucket config.');
  }

  // Step 2: Fetch all contacts from CRM
  const crmClients = await fetchAllCRMContacts(crmConfig);
  console.log(`  Fetched ${crmClients.length} contacts from CRM`);

  // Step 3: Merge by ID, email, phone, or referral code
  const existingClients = [...(cmsData.referralClients || [])];
  const mergedClients = [...existingClients];
  const codesToPush = [];

  crmClients.forEach((nc) => {
    const idx = mergedClients.findIndex(
      (ec) =>
        ec.id === nc.id ||
        (ec.referralCode && ec.referralCode !== 'N/A' && nc.referralCode !== 'N/A' && ec.referralCode === nc.referralCode) ||
        (ec.email && nc.email && String(ec.email).toLowerCase() === String(nc.email).toLowerCase()) ||
        (ec.phone && nc.phone && ec.phone === nc.phone)
    );

    if (idx >= 0) {
      const existingCode = mergedClients[idx].referralCode;
      if (nc.referralCode === 'N/A' && existingCode && existingCode !== 'N/A') {
        nc.referralCode = existingCode;
        if (!nc.id.includes('-')) codesToPush.push({ id: nc.id, code: existingCode });
      } else if (nc.referralCode === 'N/A') {
        let newCode = '';
        do {
          newCode = 'FE-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        } while (mergedClients.some((c) => c.referralCode === newCode) || crmClients.some((c) => c.referralCode === newCode));
        nc.referralCode = newCode;
        if (!nc.id.includes('-')) codesToPush.push({ id: nc.id, code: newCode });
      }

      mergedClients[idx] = {
        ...mergedClients[idx],
        name: nc.name && nc.name !== 'Unknown' ? nc.name : mergedClients[idx].name,
        email: nc.email || mergedClients[idx].email,
        phone: nc.phone || mergedClients[idx].phone,
        referralCode: nc.referralCode !== 'N/A' ? nc.referralCode : mergedClients[idx].referralCode,
        rewardAmount: nc.rewardAmount,
        status: nc.status === 'rewarded' ? 'rewarded' : mergedClients[idx].status,
        location: mergedClients[idx].location !== 'Imported' && mergedClients[idx].location !== 'CRM Synced' ? mergedClients[idx].location : nc.location,
        referralDate: nc.referralDate || mergedClients[idx].referralDate,
        id: nc.id,
        notes: mergedClients[idx].notes && !mergedClients[idx].notes.includes(nc.notes || '')
          ? `${mergedClients[idx].notes}\n${nc.notes || ''}`.trim()
          : nc.notes || mergedClients[idx].notes,
      };
    } else {
      if (nc.referralCode === 'N/A') {
        let newCode = '';
        do {
          newCode = 'FE-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        } while (mergedClients.some((c) => c.referralCode === newCode) || crmClients.some((c) => c.referralCode === newCode));
        nc.referralCode = newCode;
        if (!nc.id.includes('-')) codesToPush.push({ id: nc.id, code: newCode });
      }
      mergedClients.push(nc);
    }
  });

  console.log(`  Merged to ${mergedClients.length} total clients (${codesToPush.length} codes to push back)`);

  // Step 4: Deduplicate merged clients before pushing to CRM / Supabase
  const { clients: dedupedClients, duplicatesRemoved, duplicateGroups } = deduplicateClients(mergedClients);
  if (duplicatesRemoved > 0) {
    console.log(`  Deduplicated: removed ${duplicatesRemoved} duplicates across ${duplicateGroups} groups (${mergedClients.length} → ${dedupedClients.length})`);
  }

  // Step 5: Push missing referral codes back to CRM
  for (const item of codesToPush) {
    await pushReferralCodeToCRMContact(crmConfig, item.id, item.code);
  }
  if (codesToPush.length > 0) {
    console.log(`  Pushed ${codesToPush.length} referral codes back to CRM`);
  }

  // Step 6: Upload deduplicated CMS data back to Supabase
  cmsData.referralClients = dedupedClients;
  cmsData.lastCRMSync = new Date().toISOString();
  await uploadCMSToSupabase(supabaseConfig, cmsData);

  console.log(`[${new Date().toISOString()}] Sync complete. ${dedupedClients.length} clients, ${codesToPush.length} codes pushed, ${duplicatesRemoved} duplicates removed.`);
  return { synced: crmClients.length, total: dedupedClients.length, codesPushed: codesToPush.length, duplicatesRemoved, duplicateGroups };
}

// ============================================================
// Referral SMS — send referral link via text message
// ============================================================

app.post('/api/send-referral-sms', async (req, res) => {
  try {
    const { contactId, locationId, message, apiKey } = req.body;

    if (!contactId || !locationId || !message || !apiKey) {
      return res.status(400).json({ message: 'contactId, locationId, message, and apiKey are required' });
    }

    const smsRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
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
      throw new Error(errData?.message || `SMS send failed (${smsRes.status})`);
    }

    const result = await smsRes.json();
    res.json({ success: true, messageId: result?.id || result?.messageId || null });
  } catch (error) {
    console.error('Referral SMS Error:', error.message);
    res.status(500).json({ message: error.message || 'Failed to send SMS' });
  }
});

// Manual sync endpoint (called by Admin "Sync Now" button)
app.post('/api/crm-sync', async (req, res) => {
  try {
    const { crmConfig, supabaseConfig } = req.body;

    if (!crmConfig || !crmConfig.apiBase || !crmConfig.apiKey || !crmConfig.locationId) {
      return res.status(400).json({ message: 'CRM config is incomplete. Set apiBase, apiKey, and locationId.' });
    }
    if (!supabaseConfig || !supabaseConfig.url || !supabaseConfig.bucket) {
      return res.status(400).json({ message: 'Supabase config is incomplete. Set url and bucket.' });
    }

    const result = await performCRMSync(crmConfig, supabaseConfig);
    res.json({ success: true, ...result, syncTime: new Date().toISOString() });
  } catch (error) {
    console.error('CRM Sync Error:', error.message);
    res.status(500).json({ message: error.message || 'Sync failed' });
  }
});

// ============================================================
// Daily Cron Job — runs at 3:00 AM server time
// ============================================================

const CRON_SCHEDULE = process.env.CRM_SYNC_CRON || '0 3 * * *'; // default: 3 AM daily

cron.schedule(CRON_SCHEDULE, async () => {
  console.log(`[${new Date().toISOString()}] Daily CRM sync cron triggered`);

  // The cron needs the CRM + Supabase config. These come from environment variables.
  const crmConfig = {
    apiBase: process.env.CRM_API_BASE,
    apiKey: process.env.CRM_API_KEY,
    locationId: process.env.CRM_LOCATION_ID,
    fieldIdReferralCode: process.env.CRM_FIELD_REFERRAL_CODE || '',
    fieldIdCreditBalance: process.env.CRM_FIELD_CREDIT_BALANCE || '',
    fieldIdTotalReferrals: process.env.CRM_FIELD_TOTAL_REFERRALS || '',
  };

  const supabaseConfig = {
    url: process.env.SUPABASE_URL || 'https://vacmllwtvpehraaosmza.supabase.co',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    bucket: process.env.SUPABASE_BUCKET || 'videos',
  };

  if (!crmConfig.apiBase || !crmConfig.apiKey || !crmConfig.locationId) {
    console.warn('Cron sync skipped: CRM env vars not set (CRM_API_BASE, CRM_API_KEY, CRM_LOCATION_ID)');
    return;
  }

  try {
    const result = await performCRMSync(crmConfig, supabaseConfig);
    console.log(`Cron sync result:`, result);
  } catch (error) {
    console.error('Cron sync failed:', error.message);
  }
});

console.log(`CRM sync cron scheduled: "${CRON_SCHEDULE}"`);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
Summary
That's the complete server.js in 3 parts. Paste all 3 parts into a single file called server.js on GitHub (Part 1 first, then Part 2, then Part 3 — no gaps between them).

Then on Render:

Build Command: npm install
Start Command: node server.js
Add the environment variables from the DEPLOYMENT.md table
Deploy — then paste the Render URL into Admin → CRM & Settings → Backend Server URL





how do i create pakage.json


Thought for 6s
You already have the content — I provided it in my last message. Here's exactly what to do:

Create package.json on GitHub
In your new GitHub repo, click "Add file" → "Create new file"
Name it exactly: package.json
Paste this content:
{
  "name": "forsight-backend",
  "version": "1.0.0",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.112.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "node-cron": "^4.6.0",
    "node-fetch": "^3.3.2"
  }
}
