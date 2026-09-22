import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// The admin password lives only as a Supabase secret (see `supabase secrets
// set ADMIN_PASSWORD=...`) — it is never shipped in the client JS bundle,
// unlike the old `ADMIN_PASSWORD` constant that used to live in App.js.
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// Since the Sept 14 dog-profiles reorg, `dogs` is the natural unit for the
// admin view (one profile, one stay history) rather than `stays` (one row
// per booking, possibly covering several dogs). This flattens the
// dogs -> stay_dogs -> stays double-embed PostgREST returns into a plain
// `stays` array per dog, sorted newest-first, and drops the join rows.
//
// Each stay_dogs row also carries its own frozen snapshot
// (name/breed/dob/spay_neuter/aggression/health) of what was declared and
// signed for that specific stay - separate from `dogs`, which is the
// dog's always-current profile. Each entry in the returned `stays` array
// is that snapshot merged with the stay's own fields (dates/cost/notes),
// so admin sees exactly what was on file at the time for any past stay,
// even if the dog's profile has since been updated by a later booking.
interface RawStayLink {
  name: string; breed: string; dob: string | null; spay_neuter: string | null;
  aggression_history: string | null; aggression_detail: string | null;
  health_concerns: string | null; health_detail: string | null;
  photo_paths: string[];
  stay: Record<string, unknown> | null;
}
interface RawDog {
  id: string; name: string; breed: string; dob: string | null;
  spay_neuter: string | null; aggression_history: string | null; aggression_detail: string | null;
  health_concerns: string | null; health_detail: string | null;
  owner: { name: string; phone: string; email: string } | null;
  stay_dogs: RawStayLink[];
}

function shapeDog(d: RawDog) {
  const { stay_dogs, ...currentProfile } = d;
  const stays = (stay_dogs || [])
    .filter((sd): sd is RawStayLink & { stay: Record<string, unknown> } => !!sd.stay)
    .map((sd) => ({
      name: sd.name, breed: sd.breed, dob: sd.dob, spay_neuter: sd.spay_neuter,
      aggression_history: sd.aggression_history, aggression_detail: sd.aggression_detail,
      health_concerns: sd.health_concerns, health_detail: sd.health_detail,
      photo_paths: sd.photo_paths || [],
      ...sd.stay,
    } as Record<string, unknown>))
    .sort((a, b) => String(b.check_in).localeCompare(String(a.check_in)));
  return { ...currentProfile, stays };
}

const DOGS_SELECT =
  "id, name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail, owner:owners(name, phone, email), stay_dogs(name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail, photo_paths, stay:stays(id, check_in, check_out, drop_time, pickup_time, notes, estimated_cost, number_of_dogs, submitted_at, waiver_snapshot, billed_at, paid_at, approval_status, approved_at, denied_at, denial_reason))";

const DOG_PHOTOS_BUCKET = "dog-photos";
// A dog photo's Storage bucket is private (see the Sept 21, 2026
// migration) - a raw path alone isn't viewable, so every stay entry's
// photo_paths (plural since Sept 22, 2026 - a dog can have more than
// one) gets resolved to signed URLs (photoUrls) before the response
// goes out. 1 hour is plenty for one admin session; a fresh batch is
// generated on every fetchDogsAndTotals call (every login, and after
// every action), so there's no need to track/renew expiry.
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { password, action, stayId, checkIn, checkOut, dropTime, pickupTime, estimatedCost, denialReason } = body as {
      password?: string; action?: string; stayId?: string;
      checkIn?: string; checkOut?: string; dropTime?: string | null; pickupTime?: string | null;
      estimatedCost?: number; denialReason?: string | null;
    };

    if (password !== ADMIN_PASSWORD) {
      return json({ error: "Incorrect password" }, 401);
    }

    // Service role key bypasses RLS — safe here because we've already
    // verified the password above, server-side.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Shared by the plain read and the tail end of billStay - both return
    // the same {dogs, totalStays} shape, so a write can just hand back
    // the fresh state rather than the client patching its own copy.
    async function fetchDogsAndTotals() {
      const [dogsResult, staysResult] = await Promise.all([
        supabase.from("dogs").select(DOGS_SELECT),
        // Total signed agreements on file is a count of stays (bookings),
        // not of dogs - a 2-dog booking is still one signature.
        supabase.from("stays").select("id", { count: "exact", head: true }),
      ]);
      if (dogsResult.error) throw dogsResult.error;
      if (staysResult.error) throw staysResult.error;
      const dogs = (dogsResult.data as unknown as RawDog[]).map(shapeDog);

      // Batch-sign every distinct photo referenced anywhere in the
      // response in one call, rather than one round-trip per photo.
      const paths = new Set<string>();
      for (const dog of dogs) {
        for (const stay of dog.stays) {
          const stayPaths = (stay as Record<string, unknown>).photo_paths;
          if (Array.isArray(stayPaths)) for (const p of stayPaths) if (typeof p === "string" && p) paths.add(p);
        }
      }
      const urlByPath = new Map<string, string | null>();
      if (paths.size > 0) {
        const { data: signed, error: signErr } = await supabase.storage
          .from(DOG_PHOTOS_BUCKET)
          .createSignedUrls([...paths], SIGNED_URL_TTL_SECONDS);
        if (signErr) throw signErr;
        for (const s of signed ?? []) urlByPath.set(s.path ?? "", s.signedUrl);
      }
      // Always set photoUrls (defaulting []), on every stay, regardless
      // of whether any photo exists anywhere - never left undefined. A
      // path that failed to sign (shouldn't happen, but createSignedUrls
      // can return an error per-path) is dropped rather than surfaced as
      // a broken image.
      for (const dog of dogs) {
        for (const stay of dog.stays) {
          const s = stay as Record<string, unknown>;
          const stayPaths = Array.isArray(s.photo_paths) ? s.photo_paths as string[] : [];
          s.photoUrls = stayPaths.map((p) => urlByPath.get(p)).filter((u): u is string => !!u);
        }
      }

      return { dogs, totalStays: staysResult.count ?? 0 };
    }

    if (action === "billStay") {
      // "Review and edit, then send the bill" (Sept 17, 2026) - any of
      // the date/time/cost fields the admin corrected are saved here
      // alongside marking the stay billed; the actual SMS send is a
      // separate client-side call to send-confirmation (this function
      // doesn't talk to Twilio), same as the original per-dog billing flow.
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const patch: Record<string, unknown> = { billed_at: new Date().toISOString() };
      if (checkIn !== undefined) patch.check_in = checkIn;
      if (checkOut !== undefined) patch.check_out = checkOut;
      if (dropTime !== undefined) patch.drop_time = dropTime;
      if (pickupTime !== undefined) patch.pickup_time = pickupTime;
      if (estimatedCost !== undefined) patch.estimated_cost = estimatedCost;

      const { error: updateErr } = await supabase.from("stays").update(patch).eq("id", stayId);
      if (updateErr) throw updateErr;
    } else if (action === "approveStay") {
      // The client-side flow (App.js) sends the real confirmation text
      // FIRST, then calls this - same "action means it actually went
      // out" ordering as billStay (Sept 21, 2026).
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const { error: updateErr } = await supabase.from("stays")
        .update({ approval_status: "approved", approved_at: new Date().toISOString() })
        .eq("id", stayId);
      if (updateErr) throw updateErr;
    } else if (action === "denyStay") {
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const { error: updateErr } = await supabase.from("stays")
        .update({
          approval_status: "denied",
          denied_at: new Date().toISOString(),
          denial_reason: denialReason?.trim() || null,
        })
        .eq("id", stayId);
      if (updateErr) throw updateErr;
    } else if (action === "markPaid") {
      // Just a status flip (Sept 21, 2026) - unlike billStay/approveStay/
      // denyStay, there's no client-facing text this is confirming went
      // out first; admin is just recording that payment was received.
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const { error: updateErr } = await supabase.from("stays")
        .update({ paid_at: new Date().toISOString() })
        .eq("id", stayId);
      if (updateErr) throw updateErr;
    } else if (action) {
      return json({ error: `Unknown action: ${action}` }, 400);
    }

    return json(await fetchDogsAndTotals());
  } catch (err) {
    console.error("admin-data error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

// Only actually start listening when run directly (as Supabase does in
// deployment) - not when imported by a test file.
if (import.meta.main) {
  serve(handleRequest);
}
