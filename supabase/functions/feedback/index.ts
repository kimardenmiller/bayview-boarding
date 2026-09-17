import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// "Submit Idea" feature - see the migration for the full rationale
// (persisted + triage-able instead of a one-off text message). One
// function serving 3 shapes of request, same "request shape decides the
// branch" pattern as settings/index.ts:
//   - no password -> public submit (any visitor, no login)
//   - password, no id -> admin: list every submission + the open count
//   - password + id -> admin: update one submission's status
const ADMIN_PASSWORD = Deno.env.get('ADMIN_PASSWORD')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE')!;
const KIM_PHONE = Deno.env.get('KIM_PHONE')!;
const ESTEE_PHONE = Deno.env.get('ESTEE_PHONE')!;

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

// Same relay pattern as send-contact - one Twilio send, best-effort. A
// new submission is already saved by the time this runs, so a failed
// text here only means Kim/Estee find out from the admin badge instead
// of immediately, not that the idea/bug itself was lost.
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
  if (!response.ok) console.error('feedback: notify send failed', JSON.stringify(result));
  return response.ok;
}

const CATEGORIES = ['bug', 'idea', 'other'];
const STATUSES = ['open', 'considered', 'done'];

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { password, id, status, name, contact, category, message } = body as {
      password?: string; id?: string; status?: string;
      name?: string; contact?: string; category?: string; message?: string;
    };

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (!password) {
      // Public submit. Name is required (Sept 16, 2026 - the form dropped
      // its Type/category picker in favor of one open message box the
      // submitter can list as many things in as they like; requiring a
      // name instead gives admin something to identify/follow up on when
      // reviewing a long, unsorted list). category is no longer sent by
      // the client at all - still accepted/validated here for backward
      // compatibility, defaulting to 'idea', but carries no real signal.
      if (!name?.trim()) return json({ error: 'Name is required' }, 400);
      if (!message?.trim()) return json({ error: 'Message is required' }, 400);
      const cat = category && CATEGORIES.includes(category) ? category : 'idea';

      const { error } = await supabase.from('feedback').insert({
        name: name.trim(),
        contact: contact?.trim() || null,
        category: cat,
        message: message.trim(),
      });
      if (error) throw error;

      // Text Kim & Estee the moment a new idea/bug comes in (Sept 19,
      // 2026, on request - previously deliberately NOT wired to any
      // notification, relying solely on the admin panel's open-count
      // badge). Awaited, not fire-and-forget - an Edge Function's runtime
      // isn't guaranteed to keep running once a response is returned, so
      // a background send here could just never go out (same lesson as
      // send-confirmation's owner-copy notice). The submission already
      // succeeded above either way, so a failed text is only logged,
      // never turned into an error response - the admin badge remains
      // the fallback way to notice it.
      const notifyText = `New "Submit Idea" from ${name.trim()}: "${message.trim()}"`;
      await Promise.all([
        sendSms(KIM_PHONE, notifyText).catch((err) => console.error('feedback: notify Kim failed', err)),
        sendSms(ESTEE_PHONE, notifyText).catch((err) => console.error('feedback: notify Estee failed', err)),
      ]);

      return json({ success: true });
    }

    // Everything below requires the admin password.
    if (password !== ADMIN_PASSWORD) {
      return json({ error: 'Incorrect password' }, 401);
    }

    if (id) {
      // Admin: update one submission's status.
      if (!status || !STATUSES.includes(status)) {
        return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
      }
      const { data, error } = await supabase
        .from('feedback')
        .update({ status })
        .eq('id', id)
        .select('id, name, contact, category, message, status, created_at');
      if (error) throw error;
      if (!data || data.length === 0) return json({ error: 'Not found' }, 404);
      return json({ feedback: data[0] });
    }

    // Admin: list everything, newest first.
    const { data, error } = await supabase
      .from('feedback')
      .select('id, name, contact, category, message, status, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const openCount = (data ?? []).filter((f) => f.status === 'open').length;
    return json({ feedback: data ?? [], openCount });
  } catch (err) {
    console.error('feedback error:', err);
    return json({ error: (err as Error).message }, 500);
  }
}

if (import.meta.main) {
  serve(handleRequest);
}
