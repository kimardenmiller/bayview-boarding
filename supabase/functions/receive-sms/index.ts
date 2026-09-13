import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { buildAutoReply, buildRelayWarning, validateTwilioSignature, escapeXml } from '../_shared/contact.ts';

// Inbound webhook for the Bayview Boarding Twilio number. Clients are told
// (via the auto-reply here, and a matching footer on every outbound message
// from send-confirmation) that replies to this number aren't monitored, and
// to group-text Kim & Estee directly instead. If someone replies anyway, we
// still relay it - clearly flagged as a direct reply - so nothing gets
// silently dropped.
//
// DEPLOY WITH: supabase functions deploy receive-sms --no-verify-jwt
// Twilio's webhook POST has no Supabase auth header (it sends its own
// X-Twilio-Signature instead, verified below) - without --no-verify-jwt,
// Supabase's own platform gate rejects the request with a 401 before this
// code ever runs. This bit us for real on 2026-09-13: the function looked
// fine and tests passed, but Twilio's real webhook calls failed with error
// 11200 (HTTP retrieval failure, wrapping a 401) until this flag was added.
// No test can catch a missing deploy flag - this comment is the actual
// guard. (Separately, error 30034 on outbound sends means A2P campaign
// approval is still pending - unrelated to this flag.)

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE')!;
const KIM_PHONE = Deno.env.get('KIM_PHONE')!;
const ESTEE_PHONE = Deno.env.get('ESTEE_PHONE')!;
// The exact public URL Twilio is configured to POST to - used for signature
// validation. Must match the webhook URL in the Twilio Console exactly
// (Supabase's edge may not preserve the original request URL internally).
const WEBHOOK_URL = Deno.env.get('RECEIVE_SMS_WEBHOOK_URL')!;

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

async function sendSms(to: string, body: string) {
  const toDigits = to.replace(/\D/g, '');
  const formattedTo = toDigits.startsWith('1') ? `+${toDigits}` : `+1${toDigits}`;
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: formattedTo, Body: body }),
    },
  );
  const result = await response.json();
  if (!response.ok) console.error('receive-sms: relay send failed', JSON.stringify(result));
  return result;
}

// Exported (rather than only passed inline to serve()) so it can be unit
// tested directly with a constructed Request - no live server needed.
export async function handleRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const rawBody = await req.text();
    const params = Object.fromEntries(new URLSearchParams(rawBody));

    const signature = req.headers.get('X-Twilio-Signature') || '';
    const valid = await validateTwilioSignature(TWILIO_AUTH_TOKEN, WEBHOOK_URL, params, signature);
    if (!valid) {
      console.error('receive-sms: rejected request with invalid Twilio signature');
      return new Response('Forbidden', { status: 403 });
    }

    const from = params['From'] || 'unknown number';
    const body = params['Body'] || '';

    // Relay to Kim & Estee so a direct reply is never silently dropped,
    // clearly flagged as not having come through the group text.
    const warning = buildRelayWarning(from, body);
    await Promise.all([sendSms(KIM_PHONE, warning), sendSms(ESTEE_PHONE, warning)]);

    // Auto-reply to the client with how to actually reach us.
    const replyText = buildAutoReply(KIM_PHONE, ESTEE_PHONE);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(replyText)}</Message></Response>`;

    return new Response(twiml, { headers: { 'Content-Type': 'text/xml' } });
  } catch (err) {
    console.error('receive-sms error:', err);
    // Still return valid (empty) TwiML so this doesn't surface as a webhook
    // failure in Twilio - a caught error here shouldn't alarm anyone further.
    return new Response(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }
}

// Only actually start listening when run directly (as Supabase does in
// deployment) - not when imported by a test file.
if (import.meta.main) {
  serve(handleRequest);
}
