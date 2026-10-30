import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteCalendarEvent } from "../_shared/googleCalendar.ts";
import { sessionOwnerId, sha256Hex } from "../_shared/portalSession.ts";
export { sha256Hex };

// Client portal ("My Stays", Oct 29, 2026, on request - see FIXES.txt
// NEXT CHANGE LIST item 2). Public/unauthenticated like lookup-client -
// the client's own phone IS the identity, proven by a 6-digit code texted
// to it (no password: "forgot password" would need a texted code anyway).
// A successful code check returns a random session token, good for 6
// months, which the browser keeps in localStorage and sends back in the
// request body (not a cookie - this function lives on supabase.co, a
// different site from bayviewboarding.com, so a cookie would be
// third-party and blocked by Safari/Chrome).
//
// One function, "request shape decides the branch" (same style as
// settings/feedback), via body.action:
//   requestCode {phone}         -> texts a code
//   verifyCode  {phone, code}   -> {token, ownerName}
//   stays       {token}         -> {ownerName, stays}
//   logout      {token}         -> deletes the session
//   cancel      {token, stayId, expectedFee} -> cancels one of their stays
//               (phase 2, Oct 29, 2026 - see cancelStay below)
//   updateDog   {token, dog}        -> saves one of their dogs' profile
//   updateOwner {token, owner}      -> saves their email + vet
//               (phase 3, Oct 30, 2026 - both return the same payload as
//               `stays`, which also carries the owner's info and every
//               dog's full current profile, so the portal can prefill a
//               rebook/date change. A date change itself is submitted
//               through submit-booking - see replacesStayId there.)
//
// Every stays query is scoped to the session's own owner_id - RLS stays
// locked with zero policies on every table (service role key, server-
// side only), same as every other function here.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Same API-key-first fallback as send-contact/send-confirmation.
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_API_KEY_SID = Deno.env.get("TWILIO_API_KEY_SID");
const TWILIO_API_KEY_SECRET = Deno.env.get("TWILIO_API_KEY_SECRET");
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
const TWILIO_AUTH_USER = TWILIO_API_KEY_SID || TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_SECRET = TWILIO_API_KEY_SECRET || TWILIO_AUTH_TOKEN;
const TWILIO_FROM = Deno.env.get("TWILIO_PHONE")!;

export const CODE_TTL_MINUTES = 10;
export const MAX_CODES_PER_HOUR = 5;
export const MAX_ATTEMPTS_PER_CODE = 5;
export const SESSION_TTL_DAYS = 183; // ~6 months

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

// owners.phone is stored as bare 10 digits (confirmed against every live
// row Oct 29, 2026) - accept any typed formatting, plus a leading 1.
export function normalizePhone(phone: unknown): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? ten : null;
}

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sendSms(to: string, body: string): Promise<boolean> {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${TWILIO_AUTH_USER}:${TWILIO_AUTH_SECRET}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: `+1${to}`, Body: body }),
    },
  );
  if (!response.ok) console.error("portal: code send failed", await response.text());
  return response.ok;
}

// deno-lint-ignore no-explicit-any
type Supabase = any;

async function findOwnerId(supabase: Supabase, phone: string): Promise<string | null> {
  const { data, error } = await supabase.from("owners").select("id").eq("phone", phone).limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

async function requestCode(supabase: Supabase, phone: string | null): Promise<Response> {
  if (!phone) return json({ error: "Enter a 10-digit phone number." }, 400);

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recent, error: recentError } = await supabase
    .from("portal_login_codes").select("id").eq("phone", phone).gte("created_at", hourAgo);
  if (recentError) throw recentError;
  if ((recent?.length ?? 0) >= MAX_CODES_PER_HOUR) {
    return json({ error: "Too many codes requested. Please wait an hour and try again." }, 429);
  }

  // lookup-client already reveals whether a phone is on file (and much
  // more), so saying so here leaks nothing new - and a first-time visitor
  // needs to know to book first rather than wait for a code that never
  // comes.
  if (!(await findOwnerId(supabase, phone))) {
    return json({ error: "We don't have any stays under that number yet. Book a stay first, or try the number you booked with." }, 404);
  }

  const code = randomCode();
  const { error: insertError } = await supabase.from("portal_login_codes").insert({
    phone,
    code_hash: await sha256Hex(`${phone}:${code}`),
    expires_at: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString(),
  });
  if (insertError) throw insertError;

  const sent = await sendSms(phone, `Your Bayview Boarding login code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`);
  if (!sent) return json({ error: "We couldn't text your code. Please try again." }, 502);
  return json({ success: true });
}

async function verifyCode(supabase: Supabase, phone: string | null, code: unknown): Promise<Response> {
  const cleanCode = String(code ?? "").replace(/\D/g, "");
  if (!phone || cleanCode.length !== 6) return json({ error: "Enter the 6-digit code we texted you." }, 400);

  const { data: rows, error } = await supabase
    .from("portal_login_codes").select("id, code_hash, attempts")
    .eq("phone", phone).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1);
  if (error) throw error;
  const latest = rows?.[0];
  if (!latest) return json({ error: "That code has expired. Request a new one." }, 401);
  if (latest.attempts >= MAX_ATTEMPTS_PER_CODE) {
    return json({ error: "Too many wrong tries. Request a new code." }, 429);
  }

  if ((await sha256Hex(`${phone}:${cleanCode}`)) !== latest.code_hash) {
    await supabase.from("portal_login_codes").update({ attempts: latest.attempts + 1 }).eq("id", latest.id);
    return json({ error: "That code isn't right. Check the text and try again." }, 401);
  }

  // Single use - clear every outstanding code for this phone.
  await supabase.from("portal_login_codes").delete().eq("phone", phone);

  const ownerId = await findOwnerId(supabase, phone);
  if (!ownerId) return json({ error: "We don't have any stays under that number yet." }, 404);

  const token = randomToken();
  const { error: sessionError } = await supabase.from("portal_sessions").insert({
    token_hash: await sha256Hex(token),
    owner_id: ownerId,
    expires_at: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (sessionError) throw sessionError;
  return json({ token });
}

const STAYS_SELECT =
  "id, check_in, check_out, drop_time, pickup_time, estimated_cost, number_of_dogs, approval_status, denial_reason, billed_at, paid_at, submitted_at, waiver_snapshot, notes, replaces_stay_id, cancelled_at, cancellation_fee, cancellation_fee_waived_at, stay_dogs(name, dog_id)";

const DOGS_SELECT =
  "id, name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail, photo_paths";

// Dog photos live in a private bucket (see admin-data) - signed for an hour
// so the portal can show a dog's current photos while editing its profile
// or prefilling a rebook. Best-effort: a failed signing just shows none.
const DOG_PHOTOS_BUCKET = "dog-photos";
const SIGNED_URL_TTL_SECONDS = 60 * 60;
// dog-photos always names an upload "<uuid>.<ext>" - anything else isn't
// one of ours.
const PHOTO_PATH = /^[A-Za-z0-9-]+\.[A-Za-z0-9]+$/;
const MAX_PHOTOS_PER_DOG = 30;

// Admin-editable in settings.cancellation_policy (see the settings
// function for the tier rules); this is only the fallback if that read
// fails, matching the migration's own column default.
export interface CancellationPolicy {
  lateHours: number;
  lastMinuteHours: number;
  earlyFeePercent: number;
  lateFeePercent: number;
  lastMinuteFeePercent: number;
}
export const DEFAULT_CANCELLATION_POLICY: CancellationPolicy = {
  lateHours: 72, lastMinuteHours: 24, earlyFeePercent: 0, lateFeePercent: 50, lastMinuteFeePercent: 75,
};

// Exactly at a cutoff counts as inside it ("within 72 hours" includes 72).
// The fee is a % of the stay's estimate, to the cent.
export function cancellationFeeFor(policy: CancellationPolicy, hoursLeft: number, estimatedCost: number | null) {
  const percent = hoursLeft > policy.lateHours ? policy.earlyFeePercent
    : hoursLeft > policy.lastMinuteHours ? policy.lateFeePercent
    : policy.lastMinuteFeePercent;
  return { percent, fee: Math.round((Number(estimatedCost) || 0) * percent) / 100 };
}

async function loadPolicyAndTemplate(supabase: Supabase): Promise<{ policy: CancellationPolicy; template: string | null }> {
  const { data, error } = await supabase.from("settings").select("cancellation_policy, sms_cancelled").eq("id", true).limit(1);
  if (error) console.error("portal: couldn't read cancellation policy, using the default", error);
  return {
    policy: data?.[0]?.cancellation_policy ?? DEFAULT_CANCELLATION_POLICY,
    template: data?.[0]?.sms_cancelled ?? null,
  };
}

// Hours left before each stay's drop-off moment, computed in Postgres in
// Pacific time (stay_hours_until_dropoff - DST-safe, same moment the
// reminder cron uses).
async function hoursUntilDropoff(supabase: Supabase, stayIds: string[]): Promise<Map<string, number>> {
  if (stayIds.length === 0) return new Map();
  const { data, error } = await supabase.rpc("stay_hours_until_dropoff", { stay_ids: stayIds });
  if (error) throw error;
  return new Map((data || []).map((r: { id: string; hours: number }) => [r.id, Number(r.hours)]));
}

// What cancelling right now would cost: a pending request is always free;
// an approved one by the policy; nothing is cancellable from here once
// drop-off has passed (contact us instead).
function cancellationQuote(stay: { approval_status: string; estimated_cost: number | null }, hoursLeft: number | undefined, policy: CancellationPolicy) {
  const cancellable = (stay.approval_status === "pending" || stay.approval_status === "approved") &&
    hoursLeft !== undefined && hoursLeft > 0;
  if (!cancellable) return { canCancel: false };
  if (stay.approval_status === "pending") return { canCancel: true, cancelFee: 0, cancelFeePercent: 0 };
  const { percent, fee } = cancellationFeeFor(policy, hoursLeft!, stay.estimated_cost);
  return { canCancel: true, cancelFee: fee, cancelFeePercent: percent };
}

async function listStays(supabase: Supabase, token: unknown): Promise<Response> {
  const ownerId = await sessionOwnerId(supabase, token);
  if (!ownerId) return json({ error: "Your login has expired. Please log in again.", expired: true }, 401);

  return json(await portalPayload(supabase, ownerId));
}

// Everything My Stays shows: the owner, their dogs' current profiles, and
// every stay with its cancel/change options. Shared by `stays` and the
// profile edits, which hand back the refreshed state.
async function portalPayload(supabase: Supabase, ownerId: string) {
  const [{ data: owners, error: ownerError }, { data: stays, error: staysError }, { data: dogs, error: dogsError }] = await Promise.all([
    supabase.from("owners").select("name, phone, email, vet_name").eq("id", ownerId).limit(1),
    supabase.from("stays").select(STAYS_SELECT).eq("owner_id", ownerId).order("check_in", { ascending: false }),
    supabase.from("dogs").select(DOGS_SELECT).eq("owner_id", ownerId).order("name"),
  ]);
  if (ownerError) throw ownerError;
  if (staysError) throw staysError;
  if (dogsError) throw dogsError;

  const { policy } = await loadPolicyAndTemplate(supabase);
  // deno-lint-ignore no-explicit-any
  const open = (stays || []).filter((s: any) => s.approval_status === "pending" || s.approval_status === "approved");
  // deno-lint-ignore no-explicit-any
  const hours = await hoursUntilDropoff(supabase, open.map((s: any) => s.id));
  // A stay with a date change already waiting on us can't be changed again
  // until that one's decided (withdraw it first).
  const pendingChangeFor = new Set(
    // deno-lint-ignore no-explicit-any
    (stays || []).filter((s: any) => s.approval_status === "pending" && s.replaces_stay_id).map((s: any) => s.replaces_stay_id),
  );
  const owner = owners?.[0];

  return {
    ownerName: owner?.name ?? "",
    owner: owner ? { name: owner.name, phone: owner.phone, email: owner.email ?? "", vetName: owner.vet_name ?? "" } : null,
    dogs: await shapeDogs(supabase, dogs || []),
    cancellationPolicy: policy,
    // deno-lint-ignore no-explicit-any
    stays: (stays || []).map(({ stay_dogs, ...s }: any) => {
      const quote = cancellationQuote(s, hours.get(s.id), policy);
      return {
        ...s,
        dogNames: (stay_dogs || []).map((d: { name: string }) => d.name),
        dogIds: (stay_dogs || []).map((d: { dog_id: string }) => d.dog_id).filter(Boolean),
        ...quote,
        // Same window as cancelling (open, before drop-off) - a date
        // change is a new request, so no fee is ever involved. A pending
        // change can't itself be changed (approving that would retire only
        // the change, not the original) - withdraw it and start again.
        canChangeDates: quote.canCancel && !pendingChangeFor.has(s.id) &&
          !(s.approval_status === "pending" && s.replaces_stay_id),
      };
    }),
  };
}

// The booking form's own dog shape (camelCase), so the portal can drop a
// profile straight into a rebook/date change. A logged-in client sees
// their own aggression/health answers - unlike lookup-client, whose phone-
// only lookup proves nothing about who's asking.
// deno-lint-ignore no-explicit-any
async function shapeDogs(supabase: Supabase, dogs: any[]) {
  const paths = [...new Set(dogs.flatMap((d) => (Array.isArray(d.photo_paths) ? d.photo_paths : [])))] as string[];
  const urlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data: signed, error } = await supabase.storage.from(DOG_PHOTOS_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
    if (error) console.error("portal: couldn't sign dog photos", error);
    for (const s of signed ?? []) if (s.signedUrl) urlByPath.set(s.path ?? "", s.signedUrl);
  }
  return dogs.map((d) => ({
    id: d.id,
    name: d.name,
    breed: d.breed ?? "",
    dob: d.dob ?? "",
    spayNeuter: d.spay_neuter ?? "",
    aggressionHistory: d.aggression_history ?? "",
    aggressionDetail: d.aggression_detail ?? "",
    healthConcerns: d.health_concerns ?? "",
    healthDetail: d.health_detail ?? "",
    photos: (Array.isArray(d.photo_paths) ? d.photo_paths : []).map((path: string) => ({ path, url: urlByPath.get(path) ?? null })),
  }));
}

const YES_NO = ["yes", "no"];
const SPAY_NEUTER = ["yes", "no", "under1"];

// A client editing one of their own dogs' profile (phase 3). Updates
// `dogs` only - every past stay keeps its own stay_dogs snapshot of what
// was declared for it. Name isn't editable here: dogs are matched by name
// when booking, so a rename belongs on the booking form. Same required
// answers as the booking form's dog page.
async function updateDog(supabase: Supabase, token: unknown, dog: unknown): Promise<Response> {
  const ownerId = await sessionOwnerId(supabase, token);
  if (!ownerId) return json({ error: "Your login has expired. Please log in again.", expired: true }, 401);
  // deno-lint-ignore no-explicit-any
  const d = (dog && typeof dog === "object" ? dog : {}) as any;
  if (typeof d.id !== "string" || !d.id) return json({ error: "dog.id is required" }, 400);

  const breed = String(d.breed ?? "").trim();
  const photoPaths = d.photoPaths ?? [];
  if (!breed) return json({ error: "Breed is required." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.dob ?? ""))) return json({ error: "Date of birth is required." }, 400);
  if (!SPAY_NEUTER.includes(d.spayNeuter)) return json({ error: "Please answer spayed/neutered." }, 400);
  if (!YES_NO.includes(d.aggressionHistory) || !YES_NO.includes(d.healthConcerns)) {
    return json({ error: "Please answer the aggression and health questions." }, 400);
  }
  if (!Array.isArray(photoPaths) || photoPaths.length > MAX_PHOTOS_PER_DOG ||
      !photoPaths.every((p) => typeof p === "string" && PHOTO_PATH.test(p))) {
    return json({ error: "Those photos couldn't be saved. Please try uploading them again." }, 400);
  }

  const { data: updated, error } = await supabase.from("dogs").update({
    breed,
    dob: d.dob,
    spay_neuter: d.spayNeuter,
    aggression_history: d.aggressionHistory,
    aggression_detail: d.aggressionHistory === "yes" ? (String(d.aggressionDetail ?? "").trim() || null) : null,
    health_concerns: d.healthConcerns,
    health_detail: d.healthConcerns === "yes" ? (String(d.healthDetail ?? "").trim() || null) : null,
    photo_paths: photoPaths,
  }).eq("id", d.id).eq("owner_id", ownerId).select("id");
  if (error) throw error;
  // Someone else's dog looks exactly like a missing one.
  if (!updated?.length) return json({ error: "Dog not found." }, 404);
  return json(await portalPayload(supabase, ownerId));
}

// Email + vet only - the phone is the login itself, and the name is what
// each signed agreement has to match.
async function updateOwner(supabase: Supabase, token: unknown, owner: unknown): Promise<Response> {
  const ownerId = await sessionOwnerId(supabase, token);
  if (!ownerId) return json({ error: "Your login has expired. Please log in again.", expired: true }, 401);
  // deno-lint-ignore no-explicit-any
  const o = (owner && typeof owner === "object" ? owner : {}) as any;
  const email = String(o.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400);
  const vetName = String(o.vetName ?? "").trim();

  const { error } = await supabase.from("owners")
    .update({ email, vet_name: vetName && vetName !== "Select a Vet" ? vetName : null })
    .eq("id", ownerId);
  if (error) throw error;
  return json(await portalPayload(supabase, ownerId));
}

// A client cancelling their own stay (phase 2, Oct 29, 2026). The fee is
// always recomputed here, never taken from the client - expectedFee (what
// the portal showed them) only guards against a cutoff passing between
// showing it and confirming: if it no longer matches, nothing changes and
// the new fee comes back for them to re-confirm.
//
// Unlike admin's approve/deny/bill, this persists FIRST and texts after,
// best-effort: the client did this themselves and sees the result on
// screen, so a Twilio hiccup shouldn't make the cancellation itself fail.
// send-confirmation copies Kim & Estee on the text as usual.
async function cancelStay(supabase: Supabase, token: unknown, stayId: unknown, expectedFee: unknown): Promise<Response> {
  const ownerId = await sessionOwnerId(supabase, token);
  if (!ownerId) return json({ error: "Your login has expired. Please log in again.", expired: true }, 401);
  if (typeof stayId !== "string" || !stayId) return json({ error: "stayId is required" }, 400);

  const { data: rows, error } = await supabase
    .from("stays")
    .select("id, approval_status, estimated_cost, check_in, check_out, calendar_allday_event_id, calendar_dropoff_event_id, calendar_pickup_event_id, owners(name, phone), stay_dogs(name)")
    .eq("id", stayId).eq("owner_id", ownerId).limit(1);
  if (error) throw error;
  const stay = rows?.[0];
  // Someone else's stay looks exactly like a missing one.
  if (!stay) return json({ error: "Stay not found." }, 404);

  const { policy, template } = await loadPolicyAndTemplate(supabase);
  const hours = await hoursUntilDropoff(supabase, [stay.id]);
  const quote = cancellationQuote(stay, hours.get(stay.id), policy);
  if (!quote.canCancel) {
    return json({ error: "This stay can't be cancelled online any more. Please text us instead." }, 400);
  }
  if (expectedFee !== undefined && Math.abs(Number(expectedFee) - quote.cancelFee!) > 0.005) {
    return json({
      error: "The cancellation fee has changed since you opened this page. Please review it and confirm again.",
      cancelFee: quote.cancelFee, cancelFeePercent: quote.cancelFeePercent,
    }, 409);
  }

  // Conditional on the status we just checked, so a simultaneous admin
  // approve/deny (or a double tap) can't be overwritten.
  const { data: updated, error: updateErr } = await supabase
    .from("stays")
    .update({ approval_status: "cancelled", cancelled_at: new Date().toISOString(), cancellation_fee: quote.cancelFee })
    .eq("id", stay.id).eq("approval_status", stay.approval_status)
    .select("id");
  if (updateErr) throw updateErr;
  if (!updated?.length) return json({ error: "This stay just changed. Please refresh and try again." }, 409);

  // Off the calendar - only the ids actually deleted get cleared, so a
  // failed delete still leaves a trail to the stale event.
  const cleared: Record<string, null> = {};
  for (const column of ["calendar_allday_event_id", "calendar_dropoff_event_id", "calendar_pickup_event_id"]) {
    if (stay[column] && await deleteCalendarEvent(stay[column])) cleared[column] = null;
  }
  if (Object.keys(cleared).length > 0) {
    const { error: clearErr } = await supabase.from("stays").update(cleared).eq("id", stay.id);
    if (clearErr) console.error("portal: deleted calendar events but couldn't clear their ids", clearErr);
  }

  let textSent = false;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      body: JSON.stringify({
        type: "cancelled",
        owner_name: stay.owners?.name, owner_phone: stay.owners?.phone,
        dog_name: (stay.stay_dogs || []).map((d: { name: string }) => d.name).join(" & "),
        check_in: stay.check_in, check_out: stay.check_out,
        cancellation_fee: quote.cancelFee,
        message_template: template,
      }),
    });
    textSent = res.ok;
    if (!res.ok) console.error("portal: cancellation text failed", await res.text());
  } catch (err) {
    console.error("portal: cancellation text failed", err);
  }

  return json({ success: true, cancelFee: quote.cancelFee, textSent });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { action, phone, code, token, stayId, expectedFee, dog, owner } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === "requestCode") return await requestCode(supabase, normalizePhone(phone));
    if (action === "verifyCode") return await verifyCode(supabase, normalizePhone(phone), code);
    if (action === "stays") return await listStays(supabase, token);
    if (action === "cancel") return await cancelStay(supabase, token, stayId, expectedFee);
    if (action === "updateDog") return await updateDog(supabase, token, dog);
    if (action === "updateOwner") return await updateOwner(supabase, token, owner);
    if (action === "logout") {
      if (typeof token === "string" && token) {
        await supabase.from("portal_sessions").delete().eq("token_hash", await sha256Hex(token));
      }
      return json({ success: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("portal error:", err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

if (import.meta.main) {
  serve(handleRequest);
}
