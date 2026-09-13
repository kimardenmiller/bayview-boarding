import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { appendContactNote } from "../_shared/contact.ts";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_FROM = Deno.env.get("TWILIO_PHONE")!;
const KIM_PHONE = Deno.env.get("KIM_PHONE")!;
const ESTEE_PHONE = Deno.env.get("ESTEE_PHONE")!;

const PACKING_LIST = [
  "Food",
  "Leash & doggy bags",
  "Bed & favorite blanket",
  "Favorite treats",
  "Favorite toys",
  "Favorite food bowl (we provide a water bowl)",
  "Written special instructions including vet name, address & phone",
].join(", ");

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        },
      });
    }

    const text = await req.text();
    if (!text) return new Response(JSON.stringify({ error: "Empty body" }), { status: 400 });

    const { type, owner_name, owner_phone, dog_name, check_in, check_out, drop_time, pickup_time, estimated_cost, final_cost } = JSON.parse(text);

    const firstName = owner_name?.split(" ")[0] || "there";
    const dropDate = check_in ? new Date(check_in + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
    const pickDate = check_out ? new Date(check_out + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
    const dropTimeStr = drop_time ? drop_time.slice(0, 5) : "";
    const pickTimeStr = pickup_time ? pickup_time.slice(0, 5) : "";

    let message = "";

    if (type === "reminder") {
      message = `Hi ${firstName}! Just a reminder that ${dog_name}'s stay at Bayview Boarding starts tomorrow at ${dropTimeStr}. Please bring: ${PACKING_LIST}. See you then! Reply STOP to opt out. — Kim & Estee`;
    } else if (type === "billing") {
      message = `Hi ${firstName}! ${dog_name} is ready for pickup. Your total for this stay is $${final_cost}. Thanks for choosing Bayview Boarding! Reply STOP to opt out. — Kim & Estee`;
    } else {
      // Default: confirmation
      message = `Hi ${firstName}! ${dog_name}'s stay at Bayview Boarding is confirmed. Drop-off: ${dropDate} at ${dropTimeStr}. Pick-up: ${pickDate} at ${pickTimeStr}. Estimated cost: $${estimated_cost}. — Kim & Estee`;
    }

    // Every outbound message ends with how to actually reach us, since
    // replies to this number aren't monitored (see receive-sms).
    message = appendContactNote(message, KIM_PHONE, ESTEE_PHONE);

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
      return new Response(JSON.stringify({ error: result }), {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify({ success: true, sid: result.sid }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
});
