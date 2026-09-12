import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_FROM = Deno.env.get("TWILIO_PHONE")!;

serve(async (req) => {
  try {
    const { owner_name, owner_phone, dog_name, check_in, check_out, drop_time, pickup_time, estimated_cost } = await req.json();

    const firstName = owner_name?.split(" ")[0] || "there";
    const dropDate = new Date(check_in + "T" + drop_time).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const pickDate = new Date(check_out + "T" + pickup_time).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

    const message = `Hi ${firstName}! ${dog_name}'s stay at Bayview Boarding is confirmed. Drop-off: ${dropDate} at ${drop_time}. Pick-up: ${pickDate} at ${pickup_time}. Estimated cost: $${estimated_cost}. Questions? Reply to this text. — Kim & Estee`;

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

    if (!response.ok) {
      console.error("Twilio error:", result);
      return new Response(JSON.stringify({ error: result }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true, sid: result.sid }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
