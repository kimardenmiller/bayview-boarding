import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Public, unauthenticated endpoint used by the booking form's "Look up"
// button to autofill a returning client's info by phone number.
//
// Previously the client queried `stays` directly with `.select('*')`,
// which — combined with the old "Allow all" RLS policy — meant anyone
// could type in ANY phone number and pull back that client's full record:
// email, notes, signature, aggression/health details included. This
// function returns only the fields the form actually autofills.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SAFE_FIELDS =
  "owner_name, owner_email, dog_name, dog_breed, dog_dob, vet_name, spay_neuter";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { phone } = await req.json();
    const cleanPhone = (phone || "").trim();
    if (!cleanPhone) {
      return new Response(JSON.stringify({ found: false }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
      .from("stays")
      .select(SAFE_FIELDS)
      .eq("owner_phone", cleanPhone)
      .order("submitted_at", { ascending: false })
      .limit(1);

    if (error) throw error;

    if (!data || data.length === 0) {
      return new Response(JSON.stringify({ found: false }), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    return new Response(JSON.stringify({ found: true, client: data[0] }), {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error("lookup-client error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
