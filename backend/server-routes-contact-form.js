/**
 * Contact form submission handler.
 *
 * When a visitor submits the /contact form, this route:
 *   1. Finds (or creates) a CRM contact for the SUBMITTER using their
 *      name, email and phone — so the message shows up in the CRM as a
 *      real contact record.
 *   2. Adds the subject + message as a note on that contact's timeline.
 *   3. Finds (or creates) a CRM contact for graham@forsighteyewear.com and
 *      sends an email notification containing the submitter's details and
 *      message.
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

/** Split a full name into first / last name parts. */
const splitName = (full) => {
  const parts = String(full || "").trim().split(/\s+/);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
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

async function createContact(apiKey, locationId, payload) {
  const res = await fetch(`${CRM_API_BASE}/contacts/`, {
