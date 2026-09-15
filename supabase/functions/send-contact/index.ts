import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// Public "Contact Us" form (see the nav menu on the site) - relays the
// message to Kim & Estee as an SMS using the same KIM_PHONE/ESTEE_PHONE
// secrets receive-sms and send-confirmation already use, rather than
// standing up a separate email service this project otherwise has no need
// for. Deployed like every other client-invoked function (settings,
// lookup-client, submit-booking, send-confirmation) - no --no-verify-jwt,
// since the Supabase JS client supplies its own anon JWT automatically
// (only receive-sms and send-reminders, called by Twilio/pg_cron directly,
// need that flag).

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE')!;
const KIM_PHONE = Deno.env.get('KIM_PHONE')!;
const ESTEE_PHONE = Deno.env.get('ESTEE_PHONE')!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function sendSms(to: string, body: string): Promise<boolean> {
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
  if (!response.ok) console.error('send-contact: relay send failed', JSON.stringify(result));
  return response.ok;
}

// Exported (rather than only passed inline to serve()) so it can be unit
// tested directly with a constructed Request - no live server needed.
export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { name, email, phone, message } = await req.json();

    if (!name?.trim()) return json({ error: 'Name is required' }, 400);
    if (!message?.trim()) return json({ error: 'Message is required' }, 400);
    if (!email?.trim() && !phone?.trim()) {
      return json({ error: 'An email or phone number is required' }, 400);
    }

    const contactLine = [email?.trim(), phone?.trim()].filter(Boolean).join(' / ');
    const text = `Contact form from ${name.trim()} (${contactLine}): ${message.trim()}`;

    // Relayed to both - if one leg fails (bad number, Twilio hiccup) the
    // other still gets it rather than the whole submission silently
    // disappearing. Only actually fail the request if neither goes through.
    const [kimOk, esteeOk] = await Promise.all([sendSms(KIM_PHONE, text), sendSms(ESTEE_PHONE, text)]);
    if (!kimOk && !esteeOk) {
      return json({ error: 'Failed to send. Please try again or call/text us directly.' }, 502);
    }

    return json({ success: true });
  } catch (err) {
    console.error('send-contact error:', err);
    return json({ error: (err as Error).message }, 500);
  }
}

if (import.meta.main) {
  serve(handleRequest);
}
