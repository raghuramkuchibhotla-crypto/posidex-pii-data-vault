/**
 * Vercel Serverless Function — POST /api/lead
 *
 * 1. Writes the lead to Supabase using the SERVICE ROLE key
 *    (server-side only — the browser can never insert here).
 * 2. Emails the person their results.
 * 3. Records a lead_submit event so the funnel stays complete.
 *
 * File location:  api/lead.js
 *
 * Environment variables (Vercel → Settings → Environment Variables):
 *   SUPABASE_URL              https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY service_role key — NEVER expose client-side
 *   RESEND_API_KEY            optional; without it the email step is skipped
 *   FROM_EMAIL                e.g. "Raghuram Srivatsa <raghuram@posidex.com>"
 *   REPLY_TO                  optional, defaults to your address
 *   ALLOWED_ORIGIN            your page origin; defaults to *
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.FROM_EMAIL || 'Posidex <onboarding@resend.dev>';
const REPLY_TO     = process.env.REPLY_TO   || 'raghuram.kuchibhotla@posidex.com';
const ORIGIN       = process.env.ALLOWED_ORIGIN || '*';

// Optional: push a copy of every lead into the Posidex CRM.
// The CRM exposes a form-encoded endpoint at /api/capture with a shared key.
// Structured campaign data (score, verdict, per-question answers) is packed
// into the `message` field until the CRM endpoint accepts them natively.
const CRM_CAPTURE_URL = process.env.CRM_CAPTURE_URL;   // e.g. https://posidex-crm.vercel.app/api/capture
const CRM_CAPTURE_KEY = process.env.CRM_CAPTURE_KEY;   // e.g. pf_c0c080c6...

const CAMPAIGNS = {
  'pii-exposure-check':    'PII Exposure Check',
  'secure-mdm-match-test': 'Secure MDM Match Test'
};

/* ── Supabase REST helpers ─────────────────────────────── */

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`${table} insert failed: ${res.status} ${await res.text()}`);
  const [created] = await res.json();
  return created;
}

async function sbPatch(table, id, patch) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(patch)
  });
}

/* ── the results email ─────────────────────────────────── */

function buildEmail({ name, campaignLabel, score, verdict, answers }) {
  const rows = String(answers || '')
    .split('  |  ')
    .filter(Boolean)
    .map(a => `<tr><td style="padding:9px 0;border-bottom:1px solid #EFF1F5;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#3B4054;">${a}</td></tr>`)
    .join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#E7E9EF;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E7E9EF;">
<tr><td align="center" style="padding:30px 12px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#fff;border-radius:14px;overflow:hidden;">

  <tr><td bgcolor="#07080C" style="background:#07080C;padding:24px 34px;">
    <span style="font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:4.5px;color:#fff;">POSIDEX</span>
  </td></tr>
  <tr><td style="font-size:0;line-height:0;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="#EE6C1A" height="3" style="height:3px;font-size:0;line-height:0;">&nbsp;</td>
      <td bgcolor="#A62DC9" height="3" style="height:3px;font-size:0;line-height:0;">&nbsp;</td>
      <td bgcolor="#2B9FD4" height="3" style="height:3px;font-size:0;line-height:0;">&nbsp;</td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:32px 34px 0;">
    <p style="margin:0 0 18px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:27px;color:#0F1119;">Dear ${name || 'there'},</p>
    <p style="margin:0 0 22px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:27px;color:#3B4054;">
      Here is your result from the ${campaignLabel}, as promised.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4F5F9" style="background:#F4F5F9;border-radius:12px;">
      <tr><td style="padding:22px;">
        <p style="margin:0 0 6px;font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;color:#8A90A3;text-transform:uppercase;">Your result</p>
        <p style="margin:0 0 4px;font-family:Helvetica,Arial,sans-serif;font-size:30px;font-weight:700;letter-spacing:-1px;color:#0F1119;">${score || '&mdash;'}</p>
        <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:17px;font-weight:700;color:#A62DC9;">${verdict || ''}</p>
      </td></tr>
    </table>

    ${rows ? `<p style="margin:26px 0 10px;font-family:Helvetica,Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:2px;color:#8A90A3;text-transform:uppercase;">What you told us</p><table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>` : ''}

    <p style="margin:26px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:27px;color:#3B4054;">
      Most institutions answer two of the five with confidence. The gap is almost always the same one:
      data protected at rest and in transit, unprotected during processing. DPDP Rule 6 names virtual
      tokens mapped to personal data as a prescribed safeguard, and it is the only listed option that
      survives being queried.
    </p>

    <p style="margin:22px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:27px;color:#3B4054;">
      If it would help, I am happy to spend twenty minutes on where this sits in your estate.
    </p>

    <table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
      <tr><td bgcolor="#EE6C1A" style="background:#EE6C1A;border-radius:8px;">
        <a href="https://calendar.app.google/be2s3wZzyogTWagAA" style="display:inline-block;padding:14px 26px;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#fff;text-decoration:none;border-radius:8px;">Book a 20-minute call</a>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:30px 34px 34px;">
    <p style="margin:0 0 3px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#0F1119;">Raghuram Srivatsa</p>
    <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#6B7186;">
      Pre-Sales Consultant, Posidex Technologies<br>
      +91 91002 21712 &middot; <a href="https://www.posidex.com" style="color:#2B9FD4;text-decoration:none;">posidex.com</a>
    </p>
  </td></tr>

</table></td></tr></table></body></html>`;
}

/* ── forward to Posidex CRM ────────────────────────────── */

function packCampaignBlock(lead, campaignLabel) {
  // Human-readable structured block that a person reading the CRM can scan,
  // and that a future importer can parse deterministically.
  const lines = [
    '━━━ Contact ━━━',
    `Name:     ${lead.full_name    || '—'}`,
    `Email:    ${lead.email        || '—'}`,
    `Company:  ${lead.organisation || '—'}`,
    '',
    '━━━ Campaign submission ━━━',
    `Campaign: ${campaignLabel} [${lead.campaign}]`,
    `Score:    ${lead.score   || '—'}`,
    `Verdict:  ${lead.verdict || '—'}`,
    `Page:     ${lead.page_url   || '—'}`,
    `Session:  ${lead.session_id || '—'}`,
    `Ref ID:   ${lead.id}`,
    '',
    '━━━ Answers ━━━'
  ];
  const answers = String(lead.answers || '')
    .split('  |  ')
    .filter(Boolean);
  for (const a of answers) lines.push(a);
  return lines.join('\n');
}

async function forwardToCRM(lead, campaignLabel) {
  if (!CRM_CAPTURE_URL || !CRM_CAPTURE_KEY) return { forwarded: false };

  const body = new URLSearchParams({
    key:     CRM_CAPTURE_KEY,
    name:    lead.full_name    || '',
    email:   lead.email,
    company: lead.organisation || '',
    phone:   '',                                    // not collected on the landing page
    message: packCampaignBlock(lead, campaignLabel),
    website: ''                                     // honeypot — must be empty
  });

  try {
    const res = await fetch(CRM_CAPTURE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString()
    });
    if (!res.ok) console.error('CRM forward failed:', res.status, (await res.text()).slice(0, 200));
    return { forwarded: res.ok };
  } catch (err) {
    console.error('CRM forward error:', err.message);
    return { forwarded: false };
  }
}

async function sendResults(to, subject, html) {
  if (!RESEND_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], reply_to: REPLY_TO, subject, html })
  });
  if (!res.ok) { console.error('Resend failed:', await res.text()); return false; }
  return true;
}

/* ── handler ───────────────────────────────────────────── */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Malformed request' }); }
  }
  body = body || {};

  const { email, name, org, score, verdict, answers, campaign, sessionId, pageUrl, hp } = body;

  if (hp) return res.status(200).json({ status: 'ok' });   // honeypot

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  const clean = (v, max = 200) => String(v || '').trim().slice(0, max);
  const key   = clean(campaign, 60) || 'pii-exposure-check';
  const label = CAMPAIGNS[key] || key;

  // Build a lead-shaped object either from Supabase (if configured) or in-memory
  let lead;
  const supabaseConfigured = SUPABASE_URL && SERVICE_KEY;

  try {
    const draft = {
      email:        clean(email),
      full_name:    clean(name) || null,
      organisation: clean(org)  || null,
      campaign:     key,
      session_id:   /^[0-9a-f-]{36}$/i.test(sessionId || '') ? sessionId : null,
      page_url:     clean(pageUrl, 300) || null,
      score:        clean(score, 20)     || null,
      verdict:      clean(verdict, 60)   || null,
      answers:      clean(answers, 2000) || null
    };

    if (supabaseConfigured) {
      lead = await sbInsert('campaign_leads', draft);
    } else {
      // Supabase not set — synthesise an id so downstream steps still work
      const { randomUUID } = await import('node:crypto');
      lead = { id: randomUUID(), created_at: new Date().toISOString(), ...draft };
      console.log('Supabase not configured; skipping insert.');
    }

    // keep the funnel complete even if the browser beacon was blocked
    if (supabaseConfigured && lead.session_id) {
      sbInsert('campaign_events', {
        session_id: lead.session_id, campaign: key, event: 'lead_submit'
      }).catch(() => {});
    }

    const sent = await sendResults(
      clean(email),
      `Your result — ${label}`,
      buildEmail({
        name: clean(name), campaignLabel: label,
        score: clean(score, 20), verdict: clean(verdict, 60), answers
      })
    );

    if (sent && supabaseConfigured) {
      sbPatch('campaign_leads', lead.id, { results_sent_at: new Date().toISOString() })
        .catch(() => {});
    }

    // fire-and-forget forward to Posidex CRM
    const crm = await forwardToCRM(lead, label);

    return res.status(200).json({ status: 'ok', emailed: sent, forwarded: crm.forwarded });

  } catch (err) {
    console.error('Lead function error:', err.message);
    return res.status(500).json({ error: 'Could not save right now' });
  }
}
