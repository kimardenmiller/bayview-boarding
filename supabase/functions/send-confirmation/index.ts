import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { appendContactNote } from "../_shared/contact.ts";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_FROM = Deno.env.get("TWILIO_PHONE")!;
const KIM_PHONE = Deno.env.get("KIM_PHONE")!;
const ESTEE_PHONE = Deno.env.get("ESTEE_PHONE")!;

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
      message_template, packing_list,
    } = JSON.parse(text);

    const firstName = owner_name?.split(" ")[0] || "there";
    const dropDate = check_in ? new Date(check_in + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
    const pickDate = check_out ? new Date(check_out + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
    const dropTimeStr = drop_time ? drop_time.slice(0, 5) : "";
    const pickTimeStr = pickup_time ? pickup_time.slice(0, 5) : "";
    const packingListStr = Array.isArray(packing_list) ? packing_list.join(", ") : (packing_list || DEFAULT_PACKING_LIST);

    let message = "";

    if (message_template) {
      // The admin-editable template (settings.sms_confirmation/reminder/
      // billing) already bakes in the "replies aren't monitored" footer via
      // {kimPhone}/{esteePhone}, so appendContactNote is NOT also called
      // here - that would duplicate it.
      message = fillTemplate(message_template, {
        firstName, dogName: dog_name || "", dogVerb: dogVerb(dog_name), dropDate, dropTime: dropTimeStr,
        pickDate, pickTime: pickTimeStr, pickupDate: pickDate, pickupTime: pickTimeStr,
        estimatedCost: formatDollars(estimated_cost),
        finalCost: formatDollars(final_cost),
        packingList: packingListStr, kimPhone: KIM_PHONE, esteePhone: ESTEE_PHONE,
      });
    } else if (type === "reminder") {
      message = `Hi ${firstName}! Just a reminder that ${dog_name}'s stay at Bayview Boarding starts tomorrow at ${dropTimeStr}. Please bring: ${packingListStr}. See you then! — Kim & Estee\n\nReply STOP to opt out.`;
      message = appendContactNote(message, KIM_PHONE, ESTEE_PHONE);
    } else if (type === "billing") {
      message = `Hi ${firstName}! ${dog_name} ${dogVerb(dog_name)} ready for pickup. Your total for this stay is $${formatDollars(final_cost)}. Thanks for choosing Bayview Boarding! — Kim & Estee\n\nReply STOP to opt out.`;
      message = appendContactNote(message, KIM_PHONE, ESTEE_PHONE);
    } else if (type === "pickup") {
      message = `It's been wonderful having ${dog_name}! We have you down for pick up at ${pickDate} ${pickTimeStr}. Please let us know in our shared group text thread if anything has changed. Otherwise, we'll see you tomorrow at ${pickTimeStr}.`;
    } else {
      // Default: confirmation
      message = `Hi ${firstName}! ${dog_name}'s stay at Bayview Boarding is confirmed. Drop-off: ${dropDate} at ${dropTimeStr}. Pick-up: ${pickDate} at ${pickTimeStr}. Estimated cost: $${formatDollars(estimated_cost)}. — Kim & Estee`;
      message = appendContactNote(message, KIM_PHONE, ESTEE_PHONE);
    }

    const toNumber = owner_phone.replace(/\D/g, "");
    const formattedTo = toNumber.startsWith("1") ? `+${toNumber}` : `+1${toNumber}`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: TWILIO_FROM,
          To: formattedTo,
          Body: message,
        }),
      }
    );

    const result = await response.json();
    console.log("Twilio response:", JSON.stringify(result));

    if (!response.ok) {
      return json({ error: result }, 500);
    }

    return json({ success: true, sid: result.sid });
  } catch (err) {
    console.error("Function error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

if (import.meta.main) {
  serve(handleRequest);
}
