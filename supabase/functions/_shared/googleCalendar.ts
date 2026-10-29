// Google Calendar helpers shared by admin-data (creates/updates each
// approved stay's 3 events) and portal (deletes them when a client
// cancels - Oct 29, 2026). Moved here from admin-data then, unchanged.
//
// Env vars are read at call time and deliberately not `!`-asserted -
// an environment without Google credentials should just no-op (every
// caller is best-effort), never crash a function's module load.

// Exchanges the long-lived refresh token for a fresh (1-hour) access
// token on every call rather than caching one across requests - a
// function instance doesn't live long enough for that to matter, and it
// keeps the logic simple (no cache invalidation to get wrong).
export async function googleAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET") ?? "",
      refresh_token: Deno.env.get("GOOGLE_CALENDAR_REFRESH_TOKEN") ?? "",
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token as string;
}

// Best-effort: true once the event is gone (already-deleted counts -
// 404/410), false on any other failure, never throws.
export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  try {
    const accessToken = await googleAccessToken();
    const calendarId = Deno.env.get("GOOGLE_CALENDAR_ID") ?? "";
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE", headers: { "Authorization": `Bearer ${accessToken}` } },
    );
    if (res.ok || res.status === 404 || res.status === 410) return true;
    console.error("deleteCalendarEvent failed:", res.status, await res.text());
    return false;
  } catch (err) {
    console.error("deleteCalendarEvent error:", err);
    return false;
  }
}
