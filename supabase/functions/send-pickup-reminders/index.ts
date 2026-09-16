import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sends the "we'll see you tomorrow for pickup" text, the day before
// check_out - the pickup-side counterpart to send-reminders (which does
// the same thing for drop-off, the day before check_in). Same fixed-
// daily-batch reasoning: simpler than timing to each stay's own exact
// pickup time, and avoids texting someone at 2am.
//
// Not client-invoked - only the cron job should ever call this, so it's
// deployed with --no-verify-jwt and checks its own shared secret
// (CRON_SECRET, same one send-reminders uses - see that migration for
// how it's set up without ever being committed).
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Same fixed-business-timezone reasoning as send-reminders - there's no
// "visitor" here, just a scheduled job.
function tomorrowInBusinessTimezone(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(tomorrow);
}

interface DueStay {
  id: string;
  check_out: string;
  pickup_time: string | null;
  owners: { name: string; phone: string } | null;
  stay_dogs: { name: string }[];
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok");
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const tomorrow = tomorrowInBusinessTimezone();

    // The pickup-reminder wording is admin-editable (settings table) -
    // fetched once per run, passed through to send-confirmation (which
    // has no DB access of its own). Falls back to send-confirmation's
    // own hardcoded default if this read fails, rather than blocking
    // reminders entirely over a settings hiccup.
    const { data: settingsRow } = await supabase
      .from("settings")
      .select("sms_pickup_reminder")
      .eq("id", true)
      .maybeSingle();

    const { data: dueStays, error: queryErr } = await supabase
      .from("stays")
      .select("id, check_out, pickup_time, owners(name, phone), stay_dogs(name)")
      .eq("check_out", tomorrow)
      .is("pickup_reminder_sent_at", null);
    if (queryErr) throw queryErr;

    let sent = 0;
    let failed = 0;

    for (const stay of (dueStays ?? []) as unknown as DueStay[]) {
      const owner = stay.owners;
      const dogNames = (stay.stay_dogs ?? []).map((d) => d.name).join(" & ");
      if (!owner || !dogNames) {
        failed++;
        continue;
      }

      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-confirmation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          type: "pickup",
          owner_name: owner.name,
          owner_phone: owner.phone,
          dog_name: dogNames,
          check_out: stay.check_out,
          pickup_time: stay.pickup_time,
          message_template: settingsRow?.sms_pickup_reminder,
        }),
      });

      if (!res.ok) {
        failed++;
        continue;
      }

      const { error: updateErr } = await supabase
        .from("stays")
        .update({ pickup_reminder_sent_at: new Date().toISOString() })
        .eq("id", stay.id);
      if (updateErr) {
        // The text went out but we couldn't record it - log loudly so
        // this doesn't silently resend forever, but don't count it as a
        // failed *send*.
        console.error(`send-pickup-reminders: sent but failed to mark pickup_reminder_sent_at for stay ${stay.id}:`, updateErr);
      }
      sent++;
    }

    return json({ date: tomorrow, found: (dueStays ?? []).length, sent, failed });
  } catch (err) {
    console.error("send-pickup-reminders error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

// Only actually start listening when run directly (as Supabase does in
// deployment) - not when imported by a test file.
if (import.meta.main) {
  serve(handleRequest);
}
