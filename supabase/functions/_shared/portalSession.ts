// Client portal session helpers, shared by portal (which issues and checks
// sessions) and submit-booking (which checks one for a date-change request
// - Oct 30, 2026). Moved here from portal then, unchanged.

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The owner a session token belongs to, or null if it's missing, unknown
// or expired. Only the token's hash is ever stored. `touch` stamps
// last_used_at, so admin can see which sessions are actually in use.
// deno-lint-ignore no-explicit-any
export async function sessionOwnerId(supabase: any, token: unknown, { touch = true } = {}): Promise<string | null> {
  if (typeof token !== "string" || !token) return null;
  const tokenHash = await sha256Hex(token);
  const { data, error } = await supabase
    .from("portal_sessions").select("owner_id")
    .eq("token_hash", tokenHash).gt("expires_at", new Date().toISOString()).limit(1);
  if (error) throw error;
  const ownerId = data?.[0]?.owner_id ?? null;
  if (ownerId && touch) {
    await supabase.from("portal_sessions").update({ last_used_at: new Date().toISOString() }).eq("token_hash", tokenHash);
  }
  return ownerId;
}
