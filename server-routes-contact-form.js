/**
 * Contact form submission handler.
 *
 * When a visitor submits the /contact form, this route:
 *   1. Finds (or creates) a CRM contact for graham@forsighteyewear.com
 *   2. Sends an email notification to that contact via the CRM conversations
 *      email API, containing the submitter's name, email, phone, subject
 *      and message.
 *
 * The CRM API key & location ID are read from the server env vars
 * (CRM_API_KEY / CRM_LOCATION_ID) so the key never reaches the browser.
 */

const CRM_API_BASE = "https://backend.leadconnectorhq.com";
const CRM_SERVICES_BASE = "https://services.leadconnectorhq.com";
const NOTIFY_EMAIL = "graham@forsighteyewear.com";

/** HTML-escape user-supplied text before injecting into the email body. */
const esc = (s) => {
  const str = String(s == null ? "" : s);
  let out = "";
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code === 38) out += String.fromCharCode(38) + "amp;";
    else if (code === 60) out += String.fromCharCode(38) + "lt;";
    else if (code === 62) out += String.fromCharCode(38) + "gt;";
    else if (code === 34) out += String.fromCharCode(38) + "quot;";
    else out += ch;
  }
  return out;
};

async function findContactByEmail(apiKey, locationId, email) {
  const res = await fetch(
    `${CRM_API_BASE}/contacts/?locationId=${locationId}&limit=20&query=${encodeURIComponent(email)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
    },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const contacts = data.contacts || [];
  return (
    contacts.find(
      (c) => (c.email || "").toLowerCase() === email.toLowerCase(),
    ) || null
  );
}

async function createContact(apiKey, locationId, email) {
  const res = await fetch(`${CRM_API_BASE}/contacts/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({
      locationId,
      email,
      firstName: "Graham",
      lastName: "Forsight",
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.contact || data;
}

async function sendEmail(apiKey, locationId, contactId, subject, html) {
  const res = await fetch(`${CRM_SERVICES_BASE}/conversations/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({
      type: "Email",
      locationId,
      contactId,
      subject,
      html,
      message: html,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.message || `Email send failed (${res.status})`);
  }
  return res.json();
}

export function registerContactFormRoute(app) {
  app.post("/api/contact-form-submit", async (req, res) => {
    try {
      const { name, email, phone, subject, message } = req.body;

      if (!message) {
        return res.status(400).json({ message: "Message is required" });
      }

      const apiKey = process.env.CRM_API_KEY;
      const locationId = process.env.CRM_LOCATION_ID;

      if (!apiKey || !locationId) {
        return res.status(500).json({
          message:
            "CRM API key / location ID not configured on the server (CRM_API_KEY, CRM_LOCATION_ID).",
        });
      }

      // 1. Find or create the notification contact (graham@forsighteyewear.com)
      let contact = await findContactByEmail(apiKey, locationId, NOTIFY_EMAIL);
      if (!contact) {
        contact = await createContact(apiKey, locationId, NOTIFY_EMAIL);
      }
      const contactId = contact?.id;
      if (!contactId) {
        throw new Error("Could not resolve notification contact");
      }

      // 2. Build & send the notification email
      const emailSubject = `New Contact Form Submission${subject ? ` — ${subject}` : ""}`;
      const emailHtml = [
        "<h2>New Contact Form Submission</h2>",
        `<p><strong>Name:</strong> ${esc(name) || "N/A"}</p>`,
        `<p><strong>Email:</strong> ${esc(email) || "N/A"}</p>`,
        `<p><strong>Phone:</strong> ${esc(phone) || "N/A"}</p>`,
        `<p><strong>Subject:</strong> ${esc(subject) || "N/A"}</p>`,
        "<hr />",
        "<p><strong>Message:</strong></p>",
        `<p>${esc(message).replace(/\n/g, "<br />")}</p>`,
        "<hr />",
        `<p style="color:#888;font-size:12px;">Submitted from the Forsight Eyewear contact page on ${new Date().toLocaleString("en-CA")}</p>`,
      ].join("\n");

      await sendEmail(apiKey, locationId, contactId, emailSubject, emailHtml);

      res.json({ success: true });
    } catch (error) {
      console.error("Contact Form Error:", error.message);
      res.status(500).json({
        message: error.message || "Failed to send contact form",
      });
    }
  });
}
