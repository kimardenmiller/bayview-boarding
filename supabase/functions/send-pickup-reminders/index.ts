import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sends the "we'll see you tomorrow for pickup" text, exactly 24 hours
// before each stay's own actual pickup moment (check_out + pickup_time,
// Sept 26, 2026, on request - "send the pickup reminder exactly when
// the stay is 24 hours away") - the pickup-side counterpart to
// send-reminders (drop-off). Originally ran once a day at a fixed cron
// time and matched on calendar date alone ("check_out is tomorrow"),
// which sent anywhere from ~21 to 33+ hours early depending on
// pickup_time; "due" is now a real 24-hour window computed by Postgres
// (due_pickup_reminder_stay_ids - see that migration for why this can't
// be done reliably in plain JS against a named timezone), checked by
// the cron job every 15 minutes instead of once a day.
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

    // due_pickup_reminder_stay_ids (migration) does the actual "is this
    // stay's real pickup moment within 24 hours" comparison in Postgres,
    // in the business's own Pacific timezone - not something plain JS
    // date math can do correctly against a named timezone (DST).
    const { data: dueIds, error: dueErr } = await supabase.rpc("due_pickup_reminder_stay_ids");
    if (dueErr) throw dueErr;
    const ids = (dueIds ?? []) as string[];

    const { data: dueStays, error: queryErr } = ids.length === 0
      ? { data: [] as DueStay[], error: null }
      : await supabase
        .from("stays")
        .select("id, check_out, pickup_time, owners(name, phone), stay_dogs(name)")
        .in("id", ids);
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

    return json({ found: (dueStays ?? []).length, sent, failed });
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
