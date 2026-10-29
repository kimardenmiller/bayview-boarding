import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

async function sessionOwnerId(supabase: Supabase, token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !token) return null;
  const tokenHash = await sha256Hex(token);
  const { data, error } = await supabase
    .from("portal_sessions").select("owner_id")
    .eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).limit(1);
  if (error) throw error;
  const ownerId = data?.[0]?.owner_id ?? null;
  if (ownerId) {
    await supabase.from("portal_sessions").update({ last_used_at: new Date().toISOString() }).eq("token_hash", tokenHash);
  }
  return ownerId;
}

const STAYS_SELECT =
  "id, check_in, check_out, drop_time, pickup_time, estimated_cost, number_of_dogs, approval_status, denial_reason, billed_at, paid_at, submitted_at, waiver_snapshot, stay_dogs(name)";

async function listStays(supabase: Supabase, token: unknown): Promise<Response> {
  const ownerId = await sessionOwnerId(supabase, token);
  if (!ownerId) return json({ error: "Your login has expired. Please log in again.", expired: true }, 401);

  const [{ data: owners, error: ownerError }, { data: stays, error: staysError }] = await Promise.all([
    supabase.from("owners").select("name").eq("id", ownerId).limit(1),
    supabase.from("stays").select(STAYS_SELECT).eq("owner_id", ownerId).order("check_in", { ascending: false }),
  ]);
  if (ownerError) throw ownerError;
  if (staysError) throw staysError;

  return json({
    ownerName: owners?.[0]?.name ?? "",
    stays: (stays || []).map(({ stay_dogs, ...s }: { stay_dogs?: { name: string }[] }) => ({
      ...s,
      dogNames: (stay_dogs || []).map((d) => d.name),
    })),
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { action, phone, code, token } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === "requestCode") return await requestCode(supabase, normalizePhone(phone));
    if (action === "verifyCode") return await verifyCode(supabase, normalizePhone(phone), code);
    if (action === "stays") return await listStays(supabase, token);
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
