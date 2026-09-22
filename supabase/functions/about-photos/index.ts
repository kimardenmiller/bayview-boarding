import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Manages the actual image files behind settings.about_photos (Sept 21,
// 2026 - see that migration) - the one thing a plain JSON settings
// column can't hold. Entirely admin-password-gated, same shape as
// testers (no public branch at all - uploading/deleting a real file
// needs the service role key regardless). Two actions:
//   upload - multipart/form-data: password, file, alt? -> stores the
//            file in the "about-photos" Storage bucket under a fresh
//            random name (never trusts the client's original filename
//            as a storage path) and appends {path, alt} to
//            settings.about_photos
//   delete - JSON: { password, action: 'delete', path } -> removes the
//            file from Storage AND drops that entry from
//            settings.about_photos, in the same call, so the two never
//            drift out of sync waiting on a separate "Save" step
// Reordering and alt-text edits for EXISTING photos don't need this
// function at all - they're just settings.about_photos array edits,
// saved through the existing settings Edge Function (same pattern as
// the packing list).
const ADMIN_PASSWORD = Deno.env.get('ADMIN_PASSWORD')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const BUCKET = 'about-photos';

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

interface AboutPhoto {
  path: string;
  alt: string;
}

// Extension only, never the client's original filename - the stored
// path is always a fresh random name (see handleRequest) so nothing
// about what a client uploaded ever reaches the filesystem/URL as-is.
function extensionFor(file: File): string {
  // Only trusts an extension from a filename that actually HAS a dot -
  // a no-dot filename (e.g. "photo") would otherwise pass the character
  // check below by pure coincidence and get treated as its own
  // extension (found via a real test failure in dog-photos, its
  // sibling function, Sept 21, 2026).
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
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    async function fetchAboutPhotos(): Promise<AboutPhoto[]> {
      const { data, error } = await supabase.from('settings').select('about_photos').eq('id', true).limit(1);
      if (error) throw error;
      return (data?.[0]?.about_photos as AboutPhoto[] | undefined) ?? [];
    }

    async function saveAboutPhotos(photos: AboutPhoto[]): Promise<void> {
      const { error } = await supabase.from('settings')
        .update({ about_photos: photos, updated_at: new Date().toISOString() })
        .eq('id', true);
      if (error) throw error;
    }

    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      // upload
      const form = await req.formData();
      const password = form.get('password');
      const file = form.get('file');
      const alt = String(form.get('alt') ?? '').trim();

      if (password !== ADMIN_PASSWORD) {
        return json({ error: 'Incorrect password' }, 401);
      }
      if (!(file instanceof File) || file.size === 0) {
        return json({ error: 'A photo file is required' }, 400);
      }
      if (!file.type.startsWith('image/')) {
        return json({ error: 'File must be an image' }, 400);
      }

      const path = `${crypto.randomUUID()}.${extensionFor(file)}`;
      const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (uploadErr) throw uploadErr;

      const photos = await fetchAboutPhotos();
      const next = [...photos, { path, alt }];
      await saveAboutPhotos(next);
      return json({ aboutPhotos: next });
    }

    // delete (JSON)
    const body = await req.json().catch(() => ({}));
    const { password, action, path } = body as { password?: string; action?: string; path?: string };

    if (password !== ADMIN_PASSWORD) {
      return json({ error: 'Incorrect password' }, 401);
    }
    if (action !== 'delete') {
      return json({ error: `Unknown action: ${action}` }, 400);
    }
    if (!path) {
      return json({ error: 'path is required' }, 400);
    }

    const { error: removeErr } = await supabase.storage.from(BUCKET).remove([path]);
    if (removeErr) throw removeErr;

    const photos = await fetchAboutPhotos();
    const next = photos.filter((p) => p.path !== path);
    await saveAboutPhotos(next);
    return json({ aboutPhotos: next });
  } catch (err) {
    console.error('about-photos error:', err);
    return json({ error: (err as Error).message }, 500);
  }
}

if (import.meta.main) {
  serve(handleRequest);
}
