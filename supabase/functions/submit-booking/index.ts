import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Handles the booking form submission. Replaces the old client-side
// `supabase.from('stays').insert([record])` call, which worked when a
// booking was one self-contained row. Since the Sept 14 dog-profiles
// reorg, a submission needs find-or-create logic (an owner by phone, each
// dog by owner+name) so returning clients update their existing profile
// instead of accumulating duplicates - that needs a SELECT, which anon
// was never granted (see the Sept 12 RLS lockdown), so it happens here
// with the service role key instead.
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

// Server-side backstop for "no booking a stay in the past" - the booking
// form already validates this client-side, but that's only a UI
// convenience; this is the actual boundary since submit-booking is now
// the sole write path (anon has no direct table access at all).
//
// The server has no timezone of its own that matters here, so this uses
// the client's own timezone (sent as clientTimezone) to compute "today"
// the same way the client did, rather than defaulting to UTC - a plain
// UTC "today" would itself have exactly the bug this guards against on
// the client (see todayISO in src/App.js): in the evening Pacific time,
// UTC has already rolled to tomorrow, so a same-day booking made after
// ~5pm PDT would be wrongly rejected as "in the past".
function todayISO(clientTimezone?: string | null): string {
  if (clientTimezone) {
    try {
      // en-CA formats as YYYY-MM-DD, conveniently matching our ISO dates.
      return new Intl.DateTimeFormat("en-CA", { timeZone: clientTimezone }).format(new Date());
    } catch (_err) {
      // Unknown/invalid IANA timezone string - fall through to UTC.
    }
  }
  return new Date().toISOString().slice(0, 10);
}

interface DogInput {
  name?: string;
  breed?: string;
  dob?: string | null;
  spayNeuter?: string | null;
  aggressionHistory?: string | null;
  aggressionDetail?: string | null;
  healthConcerns?: string | null;
  healthDetail?: string | null;
}

interface BookingInput {
  owner?: { name?: string; phone?: string; email?: string; vetName?: string | null };
  dogs?: DogInput[];
  checkIn?: string;
  checkOut?: string;
  dropTime?: string | null;
  pickupTime?: string | null;
  notes?: string | null;
  estimatedCost?: number | null;
  signature?: string;
  clientTimezone?: string | null;
  // Exact WAIVER_SECTIONS content as shown/signed at submission time - see
  // the Sept 16, 2026 migration for why this is captured verbatim rather
  // than just trusting the current src/waiver.js at read time.
  waiverSnapshot?: unknown;
}

function validate(body: BookingInput): string[] {
  const errors: string[] = [];
  if (!body.owner?.name?.trim()) errors.push("owner.name");
  if (!body.owner?.phone?.trim()) errors.push("owner.phone");
  if (!body.owner?.email?.trim()) errors.push("owner.email");
  if (!Array.isArray(body.dogs) || body.dogs.length === 0) {
    errors.push("dogs");
  } else {
    body.dogs.forEach((d, i) => {
      if (!d?.name?.trim()) errors.push(`dogs[${i}].name`);
      if (!d?.breed?.trim()) errors.push(`dogs[${i}].breed`);
    });
  }
  if (!body.checkIn) errors.push("checkIn");
  if (!body.checkOut) errors.push("checkOut");
  if (body.checkIn && body.checkIn < todayISO(body.clientTimezone)) errors.push("checkIn (cannot be in the past)");
  if (body.checkIn && body.checkOut && body.checkOut < body.checkIn) errors.push("checkOut (must be on or after checkIn)");
  // A same-day stay has drop-off and pick-up on the same calendar date, so
  // pick-up must actually be later in the day - see the matching check in
  // StepDates (src/App.js) for why a multi-day stay has no such constraint.
  if (
    body.checkIn && body.checkOut && body.checkIn === body.checkOut &&
    body.dropTime && body.pickupTime && body.pickupTime <= body.dropTime
  ) {
    errors.push("pickupTime (must be after dropTime for a same-day stay)");
  }
  if (!body.signature?.trim()) errors.push("signature");
  if (!Array.isArray(body.waiverSnapshot) || body.waiverSnapshot.length === 0) errors.push("waiverSnapshot");
  return errors;
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body: BookingInput = await req.json();
    const errors = validate(body);
    if (errors.length > 0) {
      return json({ error: `Invalid booking: ${errors.join(", ")}` }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const phone = body.owner!.phone!.trim();
    const ownerFields = {
      phone,
      name: body.owner!.name!.trim(),
      email: body.owner!.email!.trim().toLowerCase(),
      vet_name: body.owner!.vetName?.trim() || null,
    };

    // Find-or-create the owner by phone.
    const { data: existingOwners, error: ownerLookupErr } = await supabase
      .from("owners").select("id").eq("phone", phone).limit(1);
    if (ownerLookupErr) throw ownerLookupErr;

    let ownerId: string;
    if (existingOwners && existingOwners.length > 0) {
      ownerId = existingOwners[0].id;
      const { error: updErr } = await supabase.from("owners").update(ownerFields).eq("id", ownerId);
      if (updErr) throw updErr;
    } else {
      const { data: insertedOwners, error: insErr } = await supabase.from("owners").insert(ownerFields).select("id");
      if (insErr) throw insErr;
      ownerId = insertedOwners[0].id;
    }

    // Find-or-create each dog by (owner, case-insensitive name) - a
    // returning dog updates its existing profile rather than duplicating.
    const { data: existingDogs, error: dogsLookupErr } = await supabase
      .from("dogs").select("id, name").eq("owner_id", ownerId);
    if (dogsLookupErr) throw dogsLookupErr;

    const dogIds: string[] = [];
    const dogNames: string[] = [];
    for (const d of body.dogs!) {
      const name = d.name!.trim();
      dogNames.push(name);
      const match = (existingDogs || []).find((ed: { id: string; name: string }) => ed.name.toLowerCase() === name.toLowerCase());
      const dogFields = {
        owner_id: ownerId,
        name,
        breed: d.breed!.trim(),
        dob: d.dob || null,
        spay_neuter: d.spayNeuter || null,
        aggression_history: d.aggressionHistory || null,
        aggression_detail: d.aggressionDetail || null,
        health_concerns: d.healthConcerns || null,
        health_detail: d.healthDetail || null,
      };
      if (match) {
        const { error: updErr } = await supabase.from("dogs").update(dogFields).eq("id", match.id);
        if (updErr) throw updErr;
        dogIds.push(match.id);
      } else {
        const { data: insertedDogs, error: insErr } = await supabase.from("dogs").insert(dogFields).select("id");
        if (insErr) throw insErr;
        dogIds.push(insertedDogs[0].id);
      }
    }

    // The stay itself - starts 'pending' (Sept 21, 2026): every new
    // submission is a request now, not an instant booking, until admin
    // approves or denies it from the new admin Requests section.
    const { data: insertedStays, error: stayErr } = await supabase.from("stays").insert({
      owner_id: ownerId,
      check_in: body.checkIn,
      check_out: body.checkOut,
      drop_time: body.dropTime || null,
      pickup_time: body.pickupTime || null,
      notes: body.notes || null,
      estimated_cost: body.estimatedCost ?? null,
      number_of_dogs: body.dogs!.length,
      signature: body.signature!.trim(),
      client_timezone: body.clientTimezone || null,
      waiver_snapshot: body.waiverSnapshot,
      approval_status: "pending",
    }).select("id, check_in, check_out, drop_time, pickup_time, estimated_cost, submitted_at, approval_status");
    if (stayErr) throw stayErr;
    const stay = insertedStays[0];

    // Link every dog on this booking to the stay, each carrying its own
    // frozen snapshot of what was declared/signed for THIS booking - see
    // the schema comment on stay_dogs. Deliberately separate from the
    // `dogs` upsert above, which keeps the dog's always-current profile.
    const { error: linkErr } = await supabase.from("stay_dogs").insert(
      body.dogs!.map((d, i) => ({
        stay_id: stay.id,
        dog_id: dogIds[i],
        name: d.name!.trim(),
        breed: d.breed!.trim(),
        dob: d.dob || null,
        spay_neuter: d.spayNeuter || null,
        aggression_history: d.aggressionHistory || null,
        aggression_detail: d.aggressionDetail || null,
        health_concerns: d.healthConcerns || null,
        health_detail: d.healthDetail || null,
      }))
    );
    if (linkErr) throw linkErr;

    return json({
      stay: {
        ...stay,
        owner_name: ownerFields.name,
        owner_phone: phone,
        dog_names: dogNames,
      },
    });
  } catch (err) {
    console.error("submit-booking error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

// Only actually start listening when run directly (as Supabase does in
// deployment) - not when imported by a test file.
if (import.meta.main) {
  serve(handleRequest);
}
