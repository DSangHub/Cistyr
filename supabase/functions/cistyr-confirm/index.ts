import Stripe from "npm:stripe@16.2.0";
import { createClient } from "npm:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient() });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const client = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await client.auth.getUser();
    if (!user) return json({ error: "Please sign in first." }, 401);
    const { session_id } = await req.json();
    if (!session_id) return json({ error: "session_id required" }, 400);
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.metadata?.business_id !== user.id) return json({ error: "Not your checkout session." }, 403);
    if (session.payment_status !== "paid" || session.mode !== "payment" || session.currency !== "usd" || session.amount_total !== 625)
      return json({ ok: false, payment_status: session.payment_status });
    const shiftId = session.metadata.shift_id;
    if (session.metadata.purpose === "worker_selection") {
      const { data: ok, error } = await admin.rpc("cistyr_finish_worker_selection", {
        p_shift_id: shiftId, p_business_id: user.id, p_worker_id: session.metadata.worker_id, p_session_id: session.id,
      });
      if (error) throw error;
      return json({ ok: !!ok, shift_id: shiftId, selected: !!ok });
    }
    // Honor checkouts created before posting became free.
    const { data: updated, error } = await admin.from("cistyr_shifts")
      .update({ status: "open", paid_at: new Date().toISOString() })
      .eq("id", shiftId).eq("business_id", user.id).eq("stripe_session_id", session.id)
      .eq("status", "awaiting_payment").select("id").maybeSingle();
    if (error) throw error;
    return json({ ok: !!updated, shift_id: shiftId, published: !!updated });
  } catch (e) { return json({ error: String((e as Error)?.message ?? e) }, 500); }
});
