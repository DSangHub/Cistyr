// A business can publish shifts without a posting fee. Selection is charged separately.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const client = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await client.auth.getUser();
    if (!user) return json({ error: "Please sign in first." }, 401);
    const { data: profile } = await admin.from("cistyr_profiles").select("role, business_name").eq("id", user.id).maybeSingle();
    if (profile?.role !== "business" || !profile.business_name) return json({ error: "Business profile required." }, 403);
    const b = await req.json();
    const rate = Number(b.pay_rate);
    if (!Number.isFinite(rate) || rate <= 0 || !b.category || !b.start_time || !b.end_time || !b.location || !Number.isFinite(Number(b.latitude)) || !Number.isFinite(Number(b.longitude)))
      return json({ error: "Complete the shift details and tag the location." }, 400);
    const { data: shift, error } = await admin.from("cistyr_shifts").insert({
      business_id: user.id, category: b.category, when_label: b.when_label,
      start_time: b.start_time, end_time: b.end_time, time_label: b.time_label,
      pay_rate: rate, location: b.location, notes: b.notes,
      latitude: Number(b.latitude), longitude: Number(b.longitude), status: "open", amount_cents: 0,
    }).select("id").single();
    if (error) throw error;
    return json({ free: true, shift_id: shift.id });
  } catch (e) { return json({ error: String((e as Error)?.message ?? e) }, 500); }
});
