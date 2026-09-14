import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Public, unauthenticated endpoint used by the booking form's "Look up"
// button (Step 1) and Step 2's on-mount check to autofill a returning
// client's info by phone number.
//
// Before the Sept 12 RLS lockdown, the client queried `stays` directly
// with `.select('*')`, which meant anyone could type in ANY phone number
// and pull back that client's full record: email, notes, signature,
// aggression/health details included. This function returns only the
// fields the form actually autofills - and since the Sept 14 dog-profiles
// reorg, that includes every dog on file for the owner (not just
// whichever dog was on their most recent stay), plus the vet, which is
// now asked once per booking rather than once per dog. Aggression/health
// fields are deliberately NOT returned - those are re-confirmed fresh
// every stay rather than carried forward silently.
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

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { phone } = await req.json();
    const cleanPhone = (phone || "").trim();
    if (!cleanPhone) {
      return json({ found: false });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from("owners")
      .select("name, email, vet_name, dogs(name, breed, dob, spay_neuter)")
      .eq("phone", cleanPhone)
      .limit(1);

    if (error) throw error;

    if (!data || data.length === 0) {
      return json({ found: false });
    }

    const owner = data[0] as unknown as {
      name: string; email: string; vet_name: string | null;
      dogs: { name: string; breed: string; dob: string | null; spay_neuter: string | null }[];
    };

    return json({
      found: true,
      client: {
        owner_name: owner.name,
        owner_email: owner.email,
        vet_name: owner.vet_name,
        dogs: (owner.dogs || []).map((d) => ({
          dog_name: d.name,
          dog_breed: d.breed,
          dog_dob: d.dob,
          spay_neuter: d.spay_neuter,
        })),
      },
    });
  } catch (err) {
    console.error("lookup-client error:", err);
    return json({ error: (err as Error).message }, 500);
  }
}

// Only actually start listening when run directly (as Supabase does in
// deployment) - not when imported by a test file.
if (import.meta.main) {
  serve(handleRequest);
}
