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
      // Public submit.
      if (!message?.trim()) return json({ error: 'Message is required' }, 400);
      const cat = category && CATEGORIES.includes(category) ? category : 'idea';

      const { error } = await supabase.from('feedback').insert({
        name: name?.trim() || null,
        contact: contact?.trim() || null,
        category: cat,
        message: message.trim(),
      });
      if (error) throw error;
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
