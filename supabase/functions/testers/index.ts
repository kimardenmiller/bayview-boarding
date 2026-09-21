import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Tester broadcast feature - see the migration for the full rationale.
// Entirely admin-password-gated (no public branch at all, unlike
// settings/feedback) since a tester's phone number is contact info, not
// something any visitor should read or add to. One function, 4 actions:
//   list   - every tester
//   add    - { name, phone, email? }
//   remove - { id }
//   notify - { message } -> texts every ACTIVE tester their own personal
//            "Hi {their first name}, " followed by the composed message
//            verbatim (Sept 17, 2026 - no fixed footer appended anymore;
//            the client's own suggested default message already includes
//            the site link and "Submit Idea" instructions, and the admin
//            can freely edit or remove them before sending).
const ADMIN_PASSWORD = Deno.env.get('ADMIN_PASSWORD')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Sept 21, 2026: prefers a restricted API key (SID + Secret) over the
// raw Auth Token, falling back to Account SID + Auth Token if no API key
// is set (staging) - see send-confirmation/index.ts.
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_API_KEY_SID = Deno.env.get('TWILIO_API_KEY_SID');
const TWILIO_API_KEY_SECRET = Deno.env.get('TWILIO_API_KEY_SECRET');
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
const TWILIO_AUTH_USER = TWILIO_API_KEY_SID || TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_SECRET = TWILIO_API_KEY_SECRET || TWILIO_AUTH_TOKEN;
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Exported so it can be checked directly in tests without needing a real
// Twilio send. First name only, matching how send-confirmation greets
// booking clients (owner_name.split(" ")[0]).
export function buildTesterMessage(testerName: string, message: string): string {
  const firstName = testerName.trim().split(' ')[0] || 'there';
  return `Hi ${firstName}, ${message}`;
}

async function sendSms(to: string, body: string): Promise<boolean> {
  const toDigits = to.replace(/\D/g, '');
  const formattedTo = toDigits.startsWith('1') ? `+${toDigits}` : `+1${toDigits}`;
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${TWILIO_AUTH_USER}:${TWILIO_AUTH_SECRET}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: formattedTo, Body: body }),
    },
  );
  const result = await response.json();
  if (!response.ok) console.error('testers: send failed', JSON.stringify(result));
  return response.ok;
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { password, action, id, name, phone, email, message } = body as {
      password?: string; action?: string; id?: string;
      name?: string; phone?: string; email?: string; message?: string;
    };

    if (password !== ADMIN_PASSWORD) {
      return json({ error: 'Incorrect password' }, 401);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === 'add') {
      if (!name?.trim()) return json({ error: 'Name is required' }, 400);
      if (!phone?.trim()) return json({ error: 'Phone is required' }, 400);
      const { error } = await supabase.from('testers').insert({
        name: name.trim(), phone: phone.trim(), email: email?.trim() || null,
      });
      if (error) throw error;
    } else if (action === 'remove') {
      if (!id) return json({ error: 'id is required' }, 400);
      const { error } = await supabase.from('testers').delete().eq('id', id);
      if (error) throw error;
    } else if (action === 'notify') {
      if (!message?.trim()) return json({ error: 'Message is required' }, 400);
      const { data: activeTesters, error: fetchErr } = await supabase
        .from('testers').select('id, name, phone').eq('active', true);
      if (fetchErr) throw fetchErr;

      let sent = 0, failed = 0;
      for (const t of activeTesters ?? []) {
        const ok = await sendSms(t.phone, buildTesterMessage(t.name, message.trim()));
        if (ok) sent++; else failed++;
      }
      return json({ sent, failed, total: (activeTesters ?? []).length });
    } else if (action && action !== 'list') {
      return json({ error: `Unknown action: ${action}` }, 400);
    }

    // list (default/fall-through) and the tail end of add/remove both
    // return the current full list, so the admin UI always reflects
    // exactly what's in the database rather than an optimistic guess.
    const { data, error } = await supabase
      .from('testers').select('id, name, phone, email, active, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return json({ testers: data ?? [] });
  } catch (err) {
    console.error('testers error:', err);
    return json({ error: (err as Error).message }, 500);
  }
}

if (import.meta.main) {
  serve(handleRequest);
}
