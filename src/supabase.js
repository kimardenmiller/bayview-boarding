import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://dmkfhcreqzmabeihqwgy.supabase.co";
const SUPABASE_KEY = "sb_publishable_mZUjMgNDgBfB8zjJ_6TTAA_6juMa5Zd";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
