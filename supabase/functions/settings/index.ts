import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Serves the business's configurable settings (day rate, multi-dog
// discount %, holiday upcharge %, vet clinic list) - see the migration
// for why these live in the database instead of hardcoded constants.
//
// Reads are public and unauthenticated (every visitor's browser needs
// this to build the booking form and estimate cost), same pattern as
// lookup-client. Writes require the admin password, checked here,
// server-side - same secret as admin-data.
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

interface SettingsRow {
  day_rate: number;
  multi_dog_discount: number;
  holiday_upcharge: number;
  vets: string[];
  packing_list: string[];
  sms_confirmation: string;
  sms_reminder: string;
  sms_billing: string;
  sms_pickup_reminder: string;
  sms_footer: string;
  primary_manager_phone?: string;
  secondary_manager_phone?: string;
}

// Public columns only - every visitor's browser fetches these to build
// the booking form/estimate and to complete their own submission's SMS
// sends. sms_footer is included here (it's just template text with
// {primaryManagerPhone}/{secondaryManagerPhone} placeholders in it, same
// as the other 4 templates) - the ADMIN_ONLY columns below are the part
// that must never reach a public read, since those are the actual phone
// numbers those placeholders get filled with.
const PUBLIC_COLUMNS =
  "day_rate, multi_dog_discount, holiday_upcharge, vets, packing_list, sms_confirmation, sms_reminder, sms_billing, sms_pickup_reminder, sms_footer";
const ADMIN_ONLY_COLUMNS = "primary_manager_phone, secondary_manager_phone";
const ADMIN_COLUMNS = `${PUBLIC_COLUMNS}, ${ADMIN_ONLY_COLUMNS}`;

function toClientShape(row: SettingsRow) {
  const shape: Record<string, unknown> = {
    dayRate: row.day_rate,
    multiDogDiscount: row.multi_dog_discount,
    holidayUpcharge: row.holiday_upcharge,
    vets: row.vets,
    packingList: row.packing_list,
    smsConfirmation: row.sms_confirmation,
    smsReminder: row.sms_reminder,
    smsBilling: row.sms_billing,
    smsPickupReminder: row.sms_pickup_reminder,
    smsFooter: row.sms_footer,
  };
  // Only present at all when the row was fetched with ADMIN_COLUMNS -
  // a public caller's response simply never has these keys, rather than
  // having them present-but-blank (which could look like "no phone set"
  // instead of "you're not allowed to see this").
  if (row.primary_manager_phone !== undefined) shape.primaryManagerPhone = row.primary_manager_phone;
  if (row.secondary_manager_phone !== undefined) shape.secondaryManagerPhone = row.secondary_manager_phone;
  return shape;
}

interface UpdatesInput {
  dayRate?: number;
  multiDogDiscount?: number;
  holidayUpcharge?: number;
  vets?: string[];
  packingList?: string[];
  smsConfirmation?: string;
  smsReminder?: string;
  smsBilling?: string;
  smsPickupReminder?: string;
  smsFooter?: string;
  primaryManagerPhone?: string;
  secondaryManagerPhone?: string;
}

// Shared by vets/packingList - both are "non-empty list of non-blank,
// non-duplicate strings", just with different field names in error text.
function validateStringList(list: unknown, fieldName: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(list) || list.length === 0) {
    errors.push(`${fieldName} must be a non-empty list`);
    return errors;
  }
  if (list.some((v) => typeof v !== "string" || !v.trim())) {
    errors.push(`${fieldName} must not contain blank entries`);
    return errors;
  }
  const seen = new Set<string>();
  for (const v of list as string[]) {
    const key = v.trim().toLowerCase();
    if (seen.has(key)) {
      errors.push(`${fieldName} contains a duplicate: "${v.trim()}"`);
      break;
    }
    seen.add(key);
  }
  return errors;
}

// Only the fields actually present in `updates` are validated/applied -
// an admin editing just the vet list shouldn't have to resend the rate.
function validateUpdates(updates: UpdatesInput): string[] {
  const errors: string[] = [];

  if (updates.dayRate !== undefined) {
    if (typeof updates.dayRate !== "number" || !Number.isFinite(updates.dayRate) || updates.dayRate <= 0) {
      errors.push("dayRate must be a positive number");
    }
  }
  if (updates.multiDogDiscount !== undefined) {
    if (
      typeof updates.multiDogDiscount !== "number" || !Number.isFinite(updates.multiDogDiscount) ||
      updates.multiDogDiscount < 0 || updates.multiDogDiscount >= 1
    ) {
      errors.push("multiDogDiscount must be a number between 0 and 1 (e.g. 0.10 for 10%)");
    }
  }
  if (updates.holidayUpcharge !== undefined) {
    if (
      typeof updates.holidayUpcharge !== "number" || !Number.isFinite(updates.holidayUpcharge) ||
      updates.holidayUpcharge < 0
    ) {
      errors.push("holidayUpcharge must be a non-negative number (e.g. 0.30 for 30%)");
    }
  }
  if (updates.vets !== undefined) {
    errors.push(...validateStringList(updates.vets, "vets"));
  }
  if (updates.packingList !== undefined) {
    errors.push(...validateStringList(updates.packingList, "packingList"));
  }
  if (updates.smsConfirmation !== undefined && !updates.smsConfirmation?.trim()) {
    errors.push("smsConfirmation must not be blank");
  }
  if (updates.smsReminder !== undefined && !updates.smsReminder?.trim()) {
    errors.push("smsReminder must not be blank");
  }
  if (updates.smsBilling !== undefined && !updates.smsBilling?.trim()) {
    errors.push("smsBilling must not be blank");
  }
  if (updates.smsPickupReminder !== undefined && !updates.smsPickupReminder?.trim()) {
    errors.push("smsPickupReminder must not be blank");
  }
  if (updates.smsFooter !== undefined && !updates.smsFooter?.trim()) {
    errors.push("smsFooter must not be blank");
  }
  // Deliberately no non-blank check on the manager phone numbers - both
  // start blank right after the migration that added them, until admin
  // fills them in for the first time, and clearing one temporarily
  // (e.g. mid-edit) shouldn't be treated as an error the way a blank SMS
  // template would be.

  return errors;
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { password, updates } = body as { password?: string; updates?: UpdatesInput };

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (updates) {
      // A write. Password required, regardless of what's being changed.
      if (password !== ADMIN_PASSWORD) {
        return json({ error: "Incorrect password" }, 401);
      }
      const errors = validateUpdates(updates);
      if (errors.length > 0) {
        return json({ error: `Invalid settings: ${errors.join(", ")}` }, 400);
      }

      const patch: Record<string, unknown> = {};
      if (updates.dayRate !== undefined) patch.day_rate = updates.dayRate;
      if (updates.multiDogDiscount !== undefined) patch.multi_dog_discount = updates.multiDogDiscount;
      if (updates.holidayUpcharge !== undefined) patch.holiday_upcharge = updates.holidayUpcharge;
      if (updates.vets !== undefined) patch.vets = updates.vets.map((v) => v.trim());
      if (updates.packingList !== undefined) patch.packing_list = updates.packingList.map((v) => v.trim());
      if (updates.smsConfirmation !== undefined) patch.sms_confirmation = updates.smsConfirmation.trim();
      if (updates.smsReminder !== undefined) patch.sms_reminder = updates.smsReminder.trim();
      if (updates.smsBilling !== undefined) patch.sms_billing = updates.smsBilling.trim();
      if (updates.smsPickupReminder !== undefined) patch.sms_pickup_reminder = updates.smsPickupReminder.trim();
      if (updates.smsFooter !== undefined) patch.sms_footer = updates.smsFooter.trim();
      if (updates.primaryManagerPhone !== undefined) patch.primary_manager_phone = updates.primaryManagerPhone.trim();
      if (updates.secondaryManagerPhone !== undefined) patch.secondary_manager_phone = updates.secondaryManagerPhone.trim();
      patch.updated_at = new Date().toISOString();

      // A write always comes from an authenticated admin - hand back the
      // full admin shape (phone numbers included) so the UI that just
      // saved a change can also re-sync from the same response, same as
      // every other field here.
      const { data, error } = await supabase
        .from("settings")
        .update(patch)
        .eq("id", true)
        .select(ADMIN_COLUMNS);
      if (error) throw error;

      return json(toClientShape(data[0] as SettingsRow));
    }

    if (password) {
      // Admin-authenticated read (Sept 18, 2026) - lets the admin UI
      // populate the manager-phone fields for editing without ever
      // putting those numbers in the public response. Distinct from the
      // write path above: no `updates` here, just a password.
      if (password !== ADMIN_PASSWORD) {
        return json({ error: "Incorrect password" }, 401);
      }
      const { data, error } = await supabase
        .from("settings")
        .select(ADMIN_COLUMNS)
        .eq("id", true)
        .limit(1);
      if (error) throw error;
      if (!data || data.length === 0) {
        return json({ error: "Settings not found" }, 500);
      }
      return json(toClientShape(data[0] as SettingsRow));
    }

    // A plain read - public, no password needed. Never selects
    // primary_manager_phone/secondary_manager_phone - see PUBLIC_COLUMNS.
    const { data, error } = await supabase
      .from("settings")
      .select(PUBLIC_COLUMNS)
      .eq("id", true)
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      return json({ error: "Settings not found" }, 500);
    }

    return json(toClientShape(data[0] as SettingsRow));
  } catch (err) {
    console.error("settings error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

// Only actually start listening when run directly (as Supabase does in
// deployment) - not when imported by a test file.
if (import.meta.main) {
  serve(handleRequest);
}
