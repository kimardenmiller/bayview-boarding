import { createClient } from "@supabase/supabase-js";

// Overridable at build time (see package.json's build:staging script) so the
// staging bundle talks to its own Supabase project instead of production's -
// test bookings/migrations/RLS changes can then never touch real client
// data. Both fallbacks below are production's own public
// anon/publishable values, safe to inline same as before (not secrets).
const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || "https://dmkfhcreqzmabeihqwgy.supabase.co";
const SUPABASE_KEY = process.env.REACT_APP_SUPABASE_KEY || "sb_publishable_mZUjMgNDgBfB8zjJ_6TTAA_6juMa5Zd";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
