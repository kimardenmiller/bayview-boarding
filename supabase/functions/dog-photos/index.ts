import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Lets an owner upload a photo of their dog during booking (Sept 21,
// 2026, on request) - see the migration for the full rationale, and
// admin-data/index.ts for how admin actually views these (a signed URL,
// since the "dog-photos" bucket is private).
//
// Public/unauthenticated, same trust boundary as submit-booking and
// feedback's own public write paths - any visitor filling out the
// booking form needs to use this before they've submitted anything, so
// there's no password to check. Anon has no direct Storage access to
// this bucket at all; only this function (service role key) can write
// to it. One action: upload. The returned `path` is what the client
// then includes as `photoPath` on that dog in the submit-booking
// payload - this function itself never touches the dogs/stay_dogs
// tables.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const BUCKET = 'dog-photos';

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

// Extension only, never the client's original filename - same reasoning
// as about-photos/index.ts's identical helper.
function extensionFor(file: File): string {
  // Only trusts an extension from a filename that actually HAS a dot -
  // a no-dot filename (e.g. "photo") would otherwise pass the character
  // check below by pure coincidence and get treated as its own
  // extension (found via a real test failure, Sept 21, 2026).
  const fromName = file.name?.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  if (file.type === 'image/png') return 'png';
  if (file.type === 'image/webp') return 'webp';
  if (file.type === 'image/gif') return 'gif';
  return 'jpg';
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return json({ error: 'Expected multipart/form-data' }, 400);
    }

    const form = await req.formData();
    const file = form.get('file');

    if (!(file instanceof File) || file.size === 0) {
      return json({ error: 'A photo file is required' }, 400);
    }
    if (!file.type.startsWith('image/')) {
      return json({ error: 'File must be an image' }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const path = `${crypto.randomUUID()}.${extensionFor(file)}`;
    const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (uploadErr) throw uploadErr;

    return json({ path });
  } catch (err) {
    console.error('dog-photos error:', err);
    return json({ error: (err as Error).message }, 500);
  }
}

if (import.meta.main) {
  serve(handleRequest);
}
