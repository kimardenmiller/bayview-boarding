import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// The admin password lives only as a Supabase secret (see `supabase secrets
// set ADMIN_PASSWORD=...`) — it is never shipped in the client JS bundle,
// unlike the old `ADMIN_PASSWORD` constant that used to live in App.js.
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Each confirmed booking gets its own Google Calendar event (Sept 25,
// 2026, on request) - deliberately NOT `!`-asserted like the vars above,
// since staging has none of these set (same pattern as its missing
// Twilio credentials - see CLAUDE.md) and should just no-op rather than
// crash this function's module load entirely. A personal Gmail account,
// not Workspace, so this uses a one-time-authorized OAuth refresh token
// (see FIXES.txt for how it was generated) rather than a service account.
const GOOGLE_CALENDAR_CLIENT_ID = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID");
const GOOGLE_CALENDAR_CLIENT_SECRET = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET");
const GOOGLE_CALENDAR_REFRESH_TOKEN = Deno.env.get("GOOGLE_CALENDAR_REFRESH_TOKEN");
const GOOGLE_CALENDAR_ID = Deno.env.get("GOOGLE_CALENDAR_ID");

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

// Since the Sept 14 dog-profiles reorg, `dogs` is the natural unit for the
// admin view (one profile, one stay history) rather than `stays` (one row
// per booking, possibly covering several dogs). This flattens the
// dogs -> stay_dogs -> stays double-embed PostgREST returns into a plain
// `stays` array per dog, sorted newest-first, and drops the join rows.
//
// Each stay_dogs row also carries its own frozen snapshot
// (name/breed/dob/spay_neuter/aggression/health) of what was declared and
// signed for that specific stay - separate from `dogs`, which is the
// dog's always-current profile. Each entry in the returned `stays` array
// is that snapshot merged with the stay's own fields (dates/cost/notes),
// so admin sees exactly what was on file at the time for any past stay,
// even if the dog's profile has since been updated by a later booking.
interface RawStayLink {
  name: string; breed: string; dob: string | null; spay_neuter: string | null;
  aggression_history: string | null; aggression_detail: string | null;
  health_concerns: string | null; health_detail: string | null;
  photo_paths: string[];
  stay: Record<string, unknown> | null;
}
interface RawDog {
  id: string; name: string; breed: string; dob: string | null;
  spay_neuter: string | null; aggression_history: string | null; aggression_detail: string | null;
  health_concerns: string | null; health_detail: string | null;
  owner: { name: string; phone: string; email: string } | null;
  stay_dogs: RawStayLink[];
}

function shapeDog(d: RawDog) {
  const { stay_dogs, ...currentProfile } = d;
  const stays = (stay_dogs || [])
    .filter((sd): sd is RawStayLink & { stay: Record<string, unknown> } => !!sd.stay)
    .map((sd) => ({
      name: sd.name, breed: sd.breed, dob: sd.dob, spay_neuter: sd.spay_neuter,
      aggression_history: sd.aggression_history, aggression_detail: sd.aggression_detail,
      health_concerns: sd.health_concerns, health_detail: sd.health_detail,
      photo_paths: sd.photo_paths || [],
      ...sd.stay,
    } as Record<string, unknown>))
    .sort((a, b) => String(b.check_in).localeCompare(String(a.check_in)));
  return { ...currentProfile, stays };
}

const DOGS_SELECT =
  "id, name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail, owner:owners(name, phone, email), stay_dogs(name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail, photo_paths, stay:stays(id, check_in, check_out, drop_time, pickup_time, notes, estimated_cost, number_of_dogs, submitted_at, waiver_snapshot, billed_at, paid_at, approval_status, approved_at, denied_at, denial_reason))";

const DOG_PHOTOS_BUCKET = "dog-photos";
// A dog photo's Storage bucket is private (see the Sept 21, 2026
// migration) - a raw path alone isn't viewable, so every stay entry's
// photo_paths (plural since Sept 22, 2026 - a dog can have more than
// one) gets resolved to signed URLs (photoUrls) before the response
// goes out. 1 hour is plenty for one admin session; a fresh batch is
// generated on every fetchDogsAndTotals call (every login, and after
// every action), so there's no need to track/renew expiry.
const SIGNED_URL_TTL_SECONDS = 60 * 60;

// Best-effort throughout, same reasoning as notifyOwnersOfClientText
// (send-confirmation): a calendar hiccup should never block approving a
// stay or saving a date/time correction. Exchanges the long-lived
// refresh token for a fresh (1-hour) access token on every call rather
// than caching one across requests - this function's own instance
// doesn't live long enough for that to matter, and it keeps the logic
// simple (no cache invalidation to get wrong).
async function googleAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CALENDAR_CLIENT_ID ?? "",
      client_secret: GOOGLE_CALENDAR_CLIENT_SECRET ?? "",
      refresh_token: GOOGLE_CALENDAR_REFRESH_TOKEN ?? "",
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

interface CalendarEventDetails {
  dogNames: string[];
  ownerName: string;
  ownerPhone: string;
  checkIn: string;
  checkOut: string;
  dropTime: string | null;
  pickupTime: string | null;
}

// check_out's calendar day is exclusive on an all-day (date-only) Google
// event - a stay spanning check_in through check_out inclusive (the dog
// is there for part of check_out too, until pickup) needs end.date one
// day past check_out, or the last day wouldn't show as occupied at all.
function addDaysToDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMinutesToTime(time: string, minutes: number): string {
  const [h, m, s] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${String(s ?? 0).padStart(2, "0")}`;
}

// Three separate events per stay (Sept 25, 2026, on request - "add the
// event as an all-day event + add a 30m event for pickup and drop"): an
// all-day block for the whole boarding duration (easier to scan at a
// glance than a single timed event spanning the whole stay), plus a
// 30-minute event each for the actual drop-off/pickup moments, using
// the real times from the booking. Falls back to 9am for either time if
// somehow missing (shouldn't happen - both are required by the booking
// form).
// Google Calendar's PATCH is a merge, not a replace, at the field level
// INSIDE start/end too (confirmed live, Sept 26, 2026 - every existing
// stay's all-day PATCH failed with "Invalid start time" once this
// shipped): sending `start: {date: ...}` over an event whose start
// still has dateTime/timeZone from its old timed form leaves those
// stale fields in place instead of clearing them, and an event with
// BOTH date and dateTime set is invalid. Every body below explicitly
// nulls out the field(s) that type does NOT use, so a PATCH actually
// clears the other representation instead of merging into an invalid
// mixed state. Harmless on a plain create (a null field there is just
// absent). Every body also pins status: "confirmed" (Sept 26, 2026,
// confirmed live - deleting an event through the Google Calendar UI
// doesn't purge it right away, it just sets status: "cancelled" while
// leaving the event fully gettable/patchable for a while; a PATCH that
// never mentions status leaves it cancelled - invisible on the
// calendar - even though the request itself succeeds with a 200 and no
// error at all, so this was silently no-op'ing on exactly the stay
// someone had just deleted) - explicitly un-cancels it back to a normal
// visible event on every sync, not just on first create.
function allDayEventBody(d: CalendarEventDetails) {
  return {
    summary: `${d.dogNames.join(" & ")} — Bayview Boarding`,
    description: `Owner: ${d.ownerName} (${d.ownerPhone})`,
    status: "confirmed",
    start: { date: d.checkIn, dateTime: null, timeZone: null },
    end: { date: addDaysToDate(d.checkOut, 1), dateTime: null, timeZone: null },
  };
}

function dropoffEventBody(d: CalendarEventDetails) {
  const drop = (d.dropTime || "09:00:00").slice(0, 8);
  return {
    summary: `${d.dogNames.join(" & ")} — Drop-off`,
    description: `Owner: ${d.ownerName} (${d.ownerPhone})`,
    status: "confirmed",
    start: { dateTime: `${d.checkIn}T${drop}`, timeZone: "America/Los_Angeles", date: null },
    end: { dateTime: `${d.checkIn}T${addMinutesToTime(drop, 30)}`, timeZone: "America/Los_Angeles", date: null },
  };
}

function pickupEventBody(d: CalendarEventDetails) {
  const pickup = (d.pickupTime || "09:00:00").slice(0, 8);
  return {
    summary: `${d.dogNames.join(" & ")} — Pickup`,
    description: `Owner: ${d.ownerName} (${d.ownerPhone})`,
    status: "confirmed",
    start: { dateTime: `${d.checkOut}T${pickup}`, timeZone: "America/Los_Angeles", date: null },
    end: { dateTime: `${d.checkOut}T${addMinutesToTime(pickup, 30)}`, timeZone: "America/Los_Angeles", date: null },
  };
}

// Returns the new event's id, or null if creation failed for any reason
// (including simply not being configured, e.g. on staging) - callers
// store this on the stay only when it's non-null.
async function createCalendarEvent(body: Record<string, unknown>): Promise<string | null> {
  try {
    const accessToken = await googleAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID ?? "")}/events`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Google Calendar event creation failed: ${JSON.stringify(data)}`);
    return data.id as string;
  } catch (err) {
    console.error("createCalendarEvent error:", err);
    return null;
  }
}

// "updated" on success. "not-found" specifically means Google returned
// 404/410 for this event id - i.e. it was deleted directly in Google
// Calendar (not through this app), and syncStayCalendarEvent's caller
// should treat it as if it never existed and create a fresh one, rather
// than leaving the stay stuck pointing at a dead id forever. "failed"
// covers everything else (network error, bad credentials, Google down)
// - deliberately NOT treated as "recreate", since a transient failure
// on the PATCH doesn't mean the original event is actually gone, and
// blindly recreating on every kind of failure risks a duplicate event
// sitting next to the still-very-much-real original.
async function updateCalendarEvent(eventId: string, body: Record<string, unknown>): Promise<"updated" | "not-found" | "failed"> {
  try {
    const accessToken = await googleAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID ?? "")}/events/${encodeURIComponent(eventId)}`,
      {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (res.status === 404 || res.status === 410) return "not-found";
    const data = await res.json();
    if (!res.ok) throw new Error(`Google Calendar event update failed: ${JSON.stringify(data)}`);
    return "updated";
  } catch (err) {
    console.error("updateCalendarEvent error:", err);
    return "failed";
  }
}

// Same fixed-business-timezone reasoning as send-reminders/send-pickup-
// reminders - there's no "visitor" here, just an admin action, and a
// plain Date.toISOString() would drift to UTC's own date near midnight.
function todayInBusinessTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

// Row shape for syncStayCalendarEvent's own lookup below - Supabase-js
// can't infer this from the select string alone, same reasoning as
// RawDog/RawStayLink above.
interface StayCalendarRow {
  calendar_allday_event_id: string | null;
  calendar_dropoff_event_id: string | null;
  calendar_pickup_event_id: string | null;
  check_in: string;
  check_out: string;
  drop_time: string | null;
  pickup_time: string | null;
  stay_dogs: Array<{ name: string; dogs: { owner: { name: string; phone: string } | null } | null }>;
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { password, action, stayId, checkIn, checkOut, dropTime, pickupTime, estimatedCost, denialReason } = body as {
      password?: string; action?: string; stayId?: string;
      checkIn?: string; checkOut?: string; dropTime?: string | null; pickupTime?: string | null;
      estimatedCost?: number; denialReason?: string | null;
    };

    if (password !== ADMIN_PASSWORD) {
      return json({ error: "Incorrect password" }, 401);
    }

    // Service role key bypasses RLS — safe here because we've already
    // verified the password above, server-side.
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Shared by the plain read and the tail end of billStay - both return
    // the same {dogs, totalStays} shape, so a write can just hand back
    // the fresh state rather than the client patching its own copy.
    async function fetchDogsAndTotals() {
      const [dogsResult, staysResult] = await Promise.all([
        supabase.from("dogs").select(DOGS_SELECT),
        // Total signed agreements on file is a count of stays (bookings),
        // not of dogs - a 2-dog booking is still one signature.
        supabase.from("stays").select("id", { count: "exact", head: true }),
      ]);
      if (dogsResult.error) throw dogsResult.error;
      if (staysResult.error) throw staysResult.error;
      const dogs = (dogsResult.data as unknown as RawDog[]).map(shapeDog);

      // Batch-sign every distinct photo referenced anywhere in the
      // response in one call, rather than one round-trip per photo.
      const paths = new Set<string>();
      for (const dog of dogs) {
        for (const stay of dog.stays) {
          const stayPaths = (stay as Record<string, unknown>).photo_paths;
          if (Array.isArray(stayPaths)) for (const p of stayPaths) if (typeof p === "string" && p) paths.add(p);
        }
      }
      const urlByPath = new Map<string, string | null>();
      if (paths.size > 0) {
        const { data: signed, error: signErr } = await supabase.storage
          .from(DOG_PHOTOS_BUCKET)
          .createSignedUrls([...paths], SIGNED_URL_TTL_SECONDS);
        if (signErr) throw signErr;
        for (const s of signed ?? []) urlByPath.set(s.path ?? "", s.signedUrl);
      }
      // Always set photoUrls (defaulting []), on every stay, regardless
      // of whether any photo exists anywhere - never left undefined. A
      // path that failed to sign (shouldn't happen, but createSignedUrls
      // can return an error per-path) is dropped rather than surfaced as
      // a broken image.
      for (const dog of dogs) {
        for (const stay of dog.stays) {
          const s = stay as Record<string, unknown>;
          const stayPaths = Array.isArray(s.photo_paths) ? s.photo_paths as string[] : [];
          s.photoUrls = stayPaths.map((p) => urlByPath.get(p)).filter((u): u is string => !!u);
        }
      }

      return { dogs, totalStays: staysResult.count ?? 0 };
    }

    // Shared by approveStay (creates the event, the "confirmed booking"
    // moment) and billStay/editStay (updates it in place if dates/times
    // were corrected afterward) - looks up whatever calendar_event_id/
    // dog names/owner info/current dates-times are on file for the stay
    // right now, rather than trusting whatever the client happened to
    // send, since a correction might only be touching one field. Nested
    // here (not top-level) so it closes over `supabase`, same as
    // fetchDogsAndTotals above - passing the client as a parameter hits
    // a real TypeScript generic-mismatch wall (its inferred type doesn't
    // structurally match its own declared return type once re-imported
    // as a standalone annotation).
    // Returns whether anything was actually created/recreated (never
    // true for a plain update-in-place) - callers that sync a whole
    // batch (backfillCalendarEvents) use this to report how many stays
    // genuinely needed fixing, rather than just how many were checked.
    async function syncStayCalendarEvent(stayId: string, opts: { createIfMissing: boolean }): Promise<boolean> {
      const { data, error } = await supabase
        .from("stays")
        .select("calendar_allday_event_id, calendar_dropoff_event_id, calendar_pickup_event_id, check_in, check_out, drop_time, pickup_time, stay_dogs(name, dogs(owner:owners(name, phone)))")
        .eq("id", stayId)
        .single();
      if (error || !data) {
        console.error("syncStayCalendarEvent: couldn't load stay", error);
        return false;
      }
      const stay = data as unknown as StayCalendarRow;
      const dogNames = stay.stay_dogs.map((sd) => sd.name);
      const owner = stay.stay_dogs[0]?.dogs?.owner;
      if (dogNames.length === 0 || !owner) return false; // shouldn't happen - defensive only

      const details: CalendarEventDetails = {
        dogNames,
        ownerName: owner.name,
        ownerPhone: owner.phone,
        checkIn: stay.check_in,
        checkOut: stay.check_out,
        dropTime: stay.drop_time,
        pickupTime: stay.pickup_time,
      };

      // Three independent events per stay - each is synced on its own
      // (an old stay that only ever got the all-day event, from before
      // drop-off/pickup existed, gets just those two created here
      // rather than needing its own separate migration path).
      const events: Array<{ existingId: string | null; body: Record<string, unknown>; column: string }> = [
        { existingId: stay.calendar_allday_event_id, body: allDayEventBody(details), column: "calendar_allday_event_id" },
        { existingId: stay.calendar_dropoff_event_id, body: dropoffEventBody(details), column: "calendar_dropoff_event_id" },
        { existingId: stay.calendar_pickup_event_id, body: pickupEventBody(details), column: "calendar_pickup_event_id" },
      ];
      const patch: Record<string, string> = {};
      for (const ev of events) {
        if (ev.existingId) {
          const result = await updateCalendarEvent(ev.existingId, ev.body);
          if (result === "not-found") {
            // The id on file no longer resolves to a real event -
            // someone deleted it directly in Google Calendar. Recreate
            // it fresh (regardless of opts.createIfMissing - the event
            // really is missing now, whatever mode this sync run is in)
            // rather than leaving the stay stuck pointing at a dead id
            // forever with no way to self-heal.
            const eventId = await createCalendarEvent(ev.body);
            if (eventId) patch[ev.column] = eventId;
          }
        } else if (opts.createIfMissing) {
          const eventId = await createCalendarEvent(ev.body);
          if (eventId) patch[ev.column] = eventId;
        }
      }
      if (Object.keys(patch).length > 0) {
        const { error: patchErr } = await supabase.from("stays").update(patch).eq("id", stayId);
        if (patchErr) console.error("syncStayCalendarEvent: failed to save calendar event ids", patchErr);
        return true;
      }
      return false;
    }

    if (action === "billStay") {
      // "Review and edit, then send the bill" (Sept 17, 2026) - any of
      // the date/time/cost fields the admin corrected are saved here
      // alongside marking the stay billed; the actual SMS send is a
      // separate client-side call to send-confirmation (this function
      // doesn't talk to Twilio), same as the original per-dog billing flow.
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const patch: Record<string, unknown> = { billed_at: new Date().toISOString() };
      if (checkIn !== undefined) patch.check_in = checkIn;
      if (checkOut !== undefined) patch.check_out = checkOut;
      if (dropTime !== undefined) patch.drop_time = dropTime;
      if (pickupTime !== undefined) patch.pickup_time = pickupTime;
      if (estimatedCost !== undefined) patch.estimated_cost = estimatedCost;

      const { error: updateErr } = await supabase.from("stays").update(patch).eq("id", stayId);
      if (updateErr) throw updateErr;
      // Keep an already-created calendar event in sync with a corrected
      // date/time (Sept 25, 2026) - a cost-only correction doesn't touch
      // the calendar at all, and a stay with no event yet (createIfMissing:
      // false) is simply left alone here, same as it always was.
      if (checkIn !== undefined || checkOut !== undefined || dropTime !== undefined || pickupTime !== undefined) {
        await syncStayCalendarEvent(stayId, { createIfMissing: false });
      }
    } else if (action === "editStay") {
      // Lets admin correct a request's dates/times/estimated cost before
      // deciding to approve or deny it (Sept 24, 2026, on request -
      // "allow editing of the stay while it is still in the request
      // stage"). Deliberately never touches billed_at or approval_status
      // - unlike billStay above, this is a plain field correction, not a
      // decision or a bill; the stay stays exactly as pending/approved/
      // whatever it already was afterward.
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const patch: Record<string, unknown> = {};
      if (checkIn !== undefined) patch.check_in = checkIn;
      if (checkOut !== undefined) patch.check_out = checkOut;
      if (dropTime !== undefined) patch.drop_time = dropTime;
      if (pickupTime !== undefined) patch.pickup_time = pickupTime;
      if (estimatedCost !== undefined) patch.estimated_cost = estimatedCost;

      const { error: updateErr } = await supabase.from("stays").update(patch).eq("id", stayId);
      if (updateErr) throw updateErr;
      if (checkIn !== undefined || checkOut !== undefined || dropTime !== undefined || pickupTime !== undefined) {
        await syncStayCalendarEvent(stayId, { createIfMissing: false });
      }
    } else if (action === "approveStay") {
      // The client-side flow (App.js) sends the real confirmation text
      // FIRST, then calls this - same "action means it actually went
      // out" ordering as billStay (Sept 21, 2026).
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const { error: updateErr } = await supabase.from("stays")
        .update({ approval_status: "approved", approved_at: new Date().toISOString() })
        .eq("id", stayId);
      if (updateErr) throw updateErr;
      // "Each confirmed booking goes onto my calendar" (Sept 25, 2026, on
      // request) - this IS the confirmed-booking moment, so always
      // create an event here, best-effort (see syncStayCalendarEvent).
      await syncStayCalendarEvent(stayId, { createIfMissing: true });
    } else if (action === "denyStay") {
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const { error: updateErr } = await supabase.from("stays")
        .update({
          approval_status: "denied",
          denied_at: new Date().toISOString(),
          denial_reason: denialReason?.trim() || null,
        })
        .eq("id", stayId);
      if (updateErr) throw updateErr;
    } else if (action === "backfillCalendarEvents") {
      // Resyncs every approved, not-yet-over stay's calendar events
      // (Sept 25-26, 2026, on request - "can we update the calendar
      // with existing stays?", then "does not seem to be working" once
      // an already-synced-but-wrong-format stay turned out to be
      // invisible to this action). Deliberately NOT scoped to "missing
      // an event id" any more - a stay can have all 3 ids on file and
      // still need fixing (its all-day event was created before the
      // Sept 25 all-day/drop-off/pickup split and is still the old
      // single timed event; or someone deleted an event directly in
      // Google Calendar without clearing the id here) - syncStayCalendarEvent
      // itself decides what actually needs creating vs just updating vs
      // recreating a deleted one (see its own "not-found" handling
      // above), so this just needs to call it for every candidate stay.
      // Scoped to check_out >= today only, on request - a calendar entry
      // for a stay that's already over isn't useful. Safe to click more
      // than once/routinely: every call here is either a no-op PATCH
      // (nothing actually changed) or fixes something real.
      const { data: dueStays, error: dueErr } = await supabase
        .from("stays")
        .select("id")
        .eq("approval_status", "approved")
        .gte("check_out", todayInBusinessTimezone());
      if (dueErr) throw dueErr;
      let backfilledCount = 0;
      for (const s of (dueStays ?? []) as { id: string }[]) {
        if (await syncStayCalendarEvent(s.id, { createIfMissing: true })) backfilledCount++;
      }
      return json({ ...(await fetchDogsAndTotals()), backfilledCount });
    } else if (action === "markPaid") {
      // Just a status flip (Sept 21, 2026) - unlike billStay/approveStay/
      // denyStay, there's no client-facing text this is confirming went
      // out first; admin is just recording that payment was received.
      if (!stayId) return json({ error: "stayId is required" }, 400);
      const { error: updateErr } = await supabase.from("stays")
        .update({ paid_at: new Date().toISOString() })
        .eq("id", stayId);
      if (updateErr) throw updateErr;
    } else if (action) {
      return json({ error: `Unknown action: ${action}` }, 400);
    }

    return json(await fetchDogsAndTotals());
  } catch (err) {
    console.error("admin-data error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

// Only actually start listening when run directly (as Supabase does in
// deployment) - not when imported by a test file.
if (import.meta.main) {
  serve(handleRequest);
}
