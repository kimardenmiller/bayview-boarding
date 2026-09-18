import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildOwnerCopyNotice } from "../_shared/contact.ts";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_FROM = Deno.env.get("TWILIO_PHONE")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Fallback only - used if a caller doesn't pass packing_list (e.g. an old
// client bundle before this was wired through, or a direct/manual call).
// The real, admin-editable value lives in the `settings` table now (Sept
// 16, 2026) - callers (App.js, send-reminders) fetch it themselves and
// pass it through, since this function has no DB access of its own.
const DEFAULT_PACKING_LIST = [
  "Food",
  "Leash & doggy bags",
  "Bed & favorite blanket",
  "Favorite treats",
  "Favorite toys",
  "Favorite food bowl (we provide a water bowl)",
  "Written special instructions including vet name, address, and phone",
].join(", ");

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

// Replaces {placeholders} in a template with the matching value from vars -
// left as-is (unfilled) if a key isn't provided, rather than silently
// producing "undefined" in an actual outbound text.
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
}

// Whole dollars only, comma-separated - "1795.5" -> "1,796" (rounds up
// at exactly .50, same as a plain Math.round for a positive amount).
// Sept 18, 2026: a bare `${amount}` was originally going out in real
// texts as "$1795.5"; cents were then added ("$1,795.50") before this
// same-day follow-up dropped them again in favor of whole dollars
// everywhere. Non-numeric input (including "") passes through unchanged
// rather than becoming "NaN" in a real message.
export function formatDollars(amount: unknown): string {
  if (amount === null || amount === undefined || amount === "") return "";
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  return Math.round(n).toLocaleString("en-US");
}

// "Don" -> "is", "Don & Bob" -> "are" - the billing text names every dog on
// a shared stay joined with " & " (see App.js's sendBill), so the verb has
// to agree with however many names actually made it in.
export function dogVerb(dogName: string | undefined): string {
  return dogName && dogName.includes(" & ") ? "are" : "is";
}

// Shared by the client send and the Kim/Estee copy sends below - a plain
// number of digits in, Twilio's E.164 format out.
function toE164(rawNumber: string): string {
  const digits = rawNumber.replace(/\D/g, "");
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
}

async function sendTwilioSms(to: string, body: string): Promise<{ ok: boolean; result: unknown }> {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body }),
    }
  );
  return { ok: response.ok, result: await response.json() };
}

// Fires the Kim/Estee copy of a just-sent client text - best-effort, on
// request (Sept 18, 2026): they should see exactly what every client text
// said without being on the thread themselves. Never allowed to affect the
// client send's own success/failure - a failed copy is only logged.
async function notifyOwnersOfClientText(ownerName: string, ownerPhone: string, message: string, phones: string[]): Promise<void> {
  const notice = buildOwnerCopyNotice(ownerName || "a client", ownerPhone || "", message);
  for (const phone of phones) {
    if (!phone) continue; // not yet set in Admin - nothing to send to
    try {
      const { ok, result } = await sendTwilioSms(toE164(phone), notice);
      if (!ok) console.error("Owner copy notice failed:", JSON.stringify(result));
    } catch (err) {
      console.error("Owner copy notice failed:", (err as Error).message);
    }
  }
}

// The footer (sms_footer) and the actual phone numbers it fills
// {primaryManagerPhone}/{secondaryManagerPhone} with both live in
// `settings` now (Sept 18, 2026) - this function has its own DB access
// for exactly this, service-role, same as every other Edge Function that
// needs data a public/anon read can't be trusted with (the phone numbers
// specifically; the footer template text itself is also public-readable,
// same as the other 4 templates, but fetching it alongside the numbers
// here means every caller gets the current footer automatically rather
// than needing to fetch and pass it through themselves).
async function fetchFooterAndPhones(): Promise<{ footer: string; primaryPhone: string; secondaryPhone: string }> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from("settings")
    .select("sms_footer, primary_manager_phone, secondary_manager_phone")
    .eq("id", true)
    .limit(1);
  if (error) throw error;
  const row = data?.[0] as { sms_footer: string; primary_manager_phone: string; secondary_manager_phone: string } | undefined;
  return {
    footer: row?.sms_footer || "",
    primaryPhone: row?.primary_manager_phone || "",
    secondaryPhone: row?.secondary_manager_phone || "",
  };
}

// Exported (rather than only passed inline to serve()) so it can be unit
// tested directly with a constructed Request - no live server needed.
export async function handleRequest(req: Request): Promise<Response> {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const text = await req.text();
    if (!text) return json({ error: "Empty body" }, 400);

    const {
      type, owner_name, owner_phone, dog_name, check_in, check_out,
      drop_time, pickup_time, estimated_cost, final_cost,
      message_template, packing_list, billing_breakdown,
    } = JSON.parse(text);

    const firstName = owner_name?.split(" ")[0] || "there";
    const dropDate = check_in ? new Date(check_in + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
    const pickDate = check_out ? new Date(check_out + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
    const dropTimeStr = drop_time ? drop_time.slice(0, 5) : "";
    const pickTimeStr = pickup_time ? pickup_time.slice(0, 5) : "";
    // One bullet per line (Sept 19, 2026, on request - was a single
    // comma-separated run-on sentence) - a leading "• " on the first item
    // too, so it reads as a list from the very first line, not just the
    // ones after a line break.
    const packingListStr = "• " + (Array.isArray(packing_list) ? packing_list : (packing_list ? packing_list.split(", ") : DEFAULT_PACKING_LIST.split(", "))).join("\n• ");

    const { footer, primaryPhone, secondaryPhone } = await fetchFooterAndPhones();
    const templateVars = {
      firstName, dogName: dog_name || "", dogVerb: dogVerb(dog_name), dropDate, dropTime: dropTimeStr,
      pickDate, pickTime: pickTimeStr, pickupDate: pickDate, pickupTime: pickTimeStr,
      estimatedCost: formatDollars(estimated_cost),
      finalCost: formatDollars(final_cost),
      billingBreakdown: billing_breakdown || "",
      packingList: packingListStr,
      primaryManagerPhone: primaryPhone, secondaryManagerPhone: secondaryPhone,
    };

    let message = "";

    if (message_template) {
      message = fillTemplate(message_template, templateVars);
    } else if (type === "reminder") {
      message = `Hi ${firstName}! Just a reminder that ${dog_name}'s stay at Bayview Boarding starts tomorrow at ${dropTimeStr}. Here's what to bring:\n${packingListStr}\nSee you then! — Kim & Estee`;
    } else if (type === "billing") {
      // "Thank you for visiting" (Sept 19, 2026, on request) - dropped
      // the "ready for pickup" framing entirely, since this text goes out
      // whenever admin bills a stay, not only right at pickup time (e.g.
      // a corrected resend days later would have read oddly). The full
      // line-item math (billing_breakdown, built client-side from the
      // same admin-reviewed dates/rate - see App.js's sendBill) comes
      // before the total, not just the total alone.
      const breakdownBlock = billing_breakdown ? `\n${billing_breakdown}\n` : "";
      message = `Hi ${firstName}! Thank you for visiting Bayview Boarding with ${dog_name}. Here's your billing detail:${breakdownBlock}\nTotal: $${formatDollars(final_cost)}\n\nThanks for choosing Bayview Boarding! — Kim & Estee`;
    } else if (type === "pickup") {
      message = `It's been wonderful having ${dog_name}! We have you down for pick up at ${pickDate} ${pickTimeStr}. Please let us know in our shared group text thread if anything has changed. Otherwise, we'll see you tomorrow at ${pickTimeStr}. — Kim & Estee`;
    } else {
      // Default: confirmation
      message = `Hi ${firstName}! ${dog_name}'s stay at Bayview Boarding is confirmed. Drop-off: ${dropDate} at ${dropTimeStr}. Pick-up: ${pickDate} at ${pickTimeStr}. Estimated cost: $${formatDollars(estimated_cost)}. — Kim & Estee`;
    }

    // The shared "Text Message Footer" (Sept 18, 2026) - one admin-edited
    // block ("Reply STOP to opt out...") appended here, once, to every
    // outbound message regardless of type or whether a custom
    // message_template was used, rather than living inside each of the 4
    // templates individually (where 4 independent copies inevitably drift
    // and, worse, would now duplicate this same text if left in place).
    if (footer) message = `${message}\n\n${fillTemplate(footer, templateVars)}`;

    const { ok, result } = await sendTwilioSms(toE164(owner_phone), message);
    console.log("Twilio response:", JSON.stringify(result));

    if (!ok) {
      return json({ error: result }, 500);
    }

    // Awaited, not fire-and-forget: an Edge Function's runtime isn't
    // guaranteed to keep running once a response is returned, so a
    // background send here could just never go out. A failed copy still
    // can't fail the client send itself (already succeeded above) -
    // notifyOwnersOfClientText only logs its own errors.
    await notifyOwnersOfClientText(owner_name, owner_phone, message, [primaryPhone, secondaryPhone]);

    return json({ success: true, sid: (result as { sid?: string }).sid });
  } catch (err) {
    console.error("Function error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

if (import.meta.main) {
  serve(handleRequest);
}
