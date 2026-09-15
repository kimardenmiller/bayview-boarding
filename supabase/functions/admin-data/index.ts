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
      ...sd.stay,
    } as Record<string, unknown>))
    .sort((a, b) => String(b.check_in).localeCompare(String(a.check_in)));
  return { ...currentProfile, stays };
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { password } = await req.json();

    if (password !== ADMIN_PASSWORD) {
      return json({ error: "Incorrect password" }, 401);
    }

    // Service role key bypasses RLS — safe here because we've already
    // verified the password above, server-side.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const [dogsResult, staysResult] = await Promise.all([
      supabase.from("dogs").select(
        "id, name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail, owner:owners(name, phone, email), stay_dogs(name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail, stay:stays(id, check_in, check_out, drop_time, pickup_time, notes, estimated_cost, number_of_dogs, submitted_at, waiver_snapshot))"
      ),
      // Total signed agreements on file is a count of stays (bookings),
      // not of dogs - a 2-dog booking is still one signature.
      supabase.from("stays").select("id", { count: "exact", head: true }),
    ]);

    if (dogsResult.error) throw dogsResult.error;
    if (staysResult.error) throw staysResult.error;

    const dogs = (dogsResult.data as unknown as RawDog[]).map(shapeDog);

    return json({ dogs, totalStays: staysResult.count ?? 0 });
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
