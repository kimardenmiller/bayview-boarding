import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sends the "your stay starts tomorrow" reminder text (FIXES.txt item 1).
// Triggered once a day by a pg_cron job (see the migration) rather than
// exactly 24 hours before each stay's own drop-off time - a fixed daily
// batch at a normal business hour is simpler and avoids texting someone
// at 2am just because that happens to be their drop-off time.
//
// Not client-invoked - only the cron job should ever call this, so it's
// deployed with --no-verify-jwt (like receive-sms, since Twilio/cron
// callers don't carry a Supabase-issued JWT) and instead checks its own
// shared secret (CRON_SECRET, matched against the x-cron-secret header
// pg_net sends - see the migration for how that's wired up without ever
// committing the actual secret value to git).
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The business operates in one fixed timezone (San Rafael, CA), unlike
// the booking form's own todayISO (src/App.js) which has to account for
// whichever timezone the visitor is actually in - there's no "visitor"
// here, just a scheduled job, so Pacific time is hardcoded rather than
// derived from a request.
function tomorrowInBusinessTimezone(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(tomorrow);
}

interface DueStay {
  id: string;
  check_in: string;
  drop_time: string | null;
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

    const { data: dueStays, error: queryErr } = await supabase
      .from("stays")
      .select("id, check_in, drop_time, owners(name, phone), stay_dogs(name)")
      .eq("check_in", tomorrow)
      .is("reminder_sent_at", null);
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
          type: "reminder",
          owner_name: owner.name,
          owner_phone: owner.phone,
          dog_name: dogNames,
          drop_time: stay.drop_time,
        }),
      });

      if (!res.ok) {
        failed++;
        continue;
      }

      const { error: updateErr } = await supabase
        .from("stays")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", stay.id);
      if (updateErr) {
        // The text went out but we couldn't record it - log loudly so
        // this doesn't silently resend forever, but don't count it as a
        // failed *send*.
        console.error(`send-reminders: sent but failed to mark reminder_sent_at for stay ${stay.id}:`, updateErr);
      }
      sent++;
    }

    return json({ date: tomorrow, found: (dueStays ?? []).length, sent, failed });
  } catch (err) {
    console.error("send-reminders error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

// Only actually start listening when run directly (as Supabase does in
// deployment) - not when imported by a test file.
if (import.meta.main) {
  serve(handleRequest);
}
