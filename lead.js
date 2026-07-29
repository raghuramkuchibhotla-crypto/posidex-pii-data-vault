/**
 * Vercel Serverless Function — POST /api/lead
 *
 * Receives a submission from the PII Exposure Check page and creates a
 * Lead in Zoho CRM. All OAuth credentials stay here, server-side. The
 * browser never sees them.
 *
 * File must live at:  api/lead.js  (in the project root)
 *
 * Required environment variables
 * (Vercel → Project → Settings → Environment Variables):
 *   ZOHO_CLIENT_ID        from Zoho API Console, Self Client
 *   ZOHO_CLIENT_SECRET    from Zoho API Console, Self Client
 *   ZOHO_REFRESH_TOKEN    generated once, never expires
 *
 * Optional (defaults are for the India data centre):
 *   ZOHO_ACCOUNTS_HOST    default accounts.zoho.in
 *   ZOHO_API_DOMAIN       default www.zohoapis.in
 *   ALLOWED_ORIGIN        default *  — set to your real domain in production
 */

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_HOST || 'accounts.zoho.in';
const API      = process.env.ZOHO_API_DOMAIN    || 'www.zohoapis.in';
const ORIGIN   = process.env.ALLOWED_ORIGIN     || '*';

// Access tokens last an hour. Cache across warm invocations so we stay
// under Zoho's limit of 10 token requests per 10 minutes per refresh token.
let cachedToken = null;
let cachedUntil = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    'refresh_token'
  });

  const res  = await fetch(`https://${ACCOUNTS}/oauth/v2/token?${params}`, { method: 'POST' });
  const json = await res.json();

  if (!json.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(json));
  }

  cachedToken = json.access_token;
  cachedUntil = Date.now() + 55 * 60 * 1000;   // refresh 5 minutes early
  return cachedToken;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Vercel parses JSON bodies automatically, but be defensive.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Malformed request' }); }
  }
  body = body || {};

  const { email, name, org, score, verdict, answers, hp } = body;

  // Honeypot — bots fill hidden fields, humans never see them.
  if (hp) return res.status(200).json({ status: 'ok' });

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  const clean = (v, max = 200) => String(v || '').trim().slice(0, max);

  // Zoho requires Last_Name and Company on the Leads module.
  const lead = {
    Last_Name:   clean(name) || email.split('@')[0],
    Company:     clean(org)  || email.split('@')[1] || 'Unknown',
    Email:       clean(email),
    Lead_Source: 'PII Exposure Check',
    Lead_Status: 'Not Contacted',
    Description:
      `PII Exposure Check — submitted ${new Date().toISOString()}\n\n` +
      `Score:   ${clean(score, 20)}\n` +
      `Verdict: ${clean(verdict, 60)}\n\n` +
      `Answers:\n${clean(answers, 1500).split('  |  ').join('\n')}`
  };

  try {
    const token = await getAccessToken();

    const zoho = await fetch(`https://${API}/crm/v8/Leads`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: [lead], trigger: ['workflow'] })
    });

    const out = await zoho.json();
    const rec = out && out.data && out.data[0];

    if (rec && rec.code === 'SUCCESS') {
      return res.status(200).json({ status: 'ok', id: rec.details && rec.details.id });
    }

    // Log the detail for you; return something generic to the browser.
    console.error('Zoho rejected the lead:', JSON.stringify(out));
    return res.status(502).json({ error: 'Could not save right now' });

  } catch (err) {
    console.error('Lead function error:', err.message);
    return res.status(500).json({ error: 'Could not save right now' });
  }
}
