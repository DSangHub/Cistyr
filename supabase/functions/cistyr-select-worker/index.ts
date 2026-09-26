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
    if (!user) return json({ error: "Sign in as a business first." }, 401);
    const { shift_id, worker_id, action } = await req.json();
    if (!shift_id || (!worker_id && action !== "release")) return json({ error: "Choose a worker for this shift." }, 400);
    if (!Deno.env.get("STRIPE_SECRET_KEY")) return json({ error: "Stripe is not configured." }, 503);
    if (action === "release") {
      const { data: pending } = await admin.from("cistyr_shift_selections").select("stripe_session_id,status")
        .eq("shift_id", shift_id).eq("business_id", user.id).maybeSingle();
      if (!pending || pending.status !== "pending") return json({ released: false });
      if (pending.stripe_session_id) {
        const prior = await stripe.checkout.sessions.retrieve(pending.stripe_session_id);
        if (prior.payment_status === "paid") return json({ error: "Payment was received; refresh the shift." }, 409);
        if (prior.status === "open") await stripe.checkout.sessions.expire(prior.id);
      }
      const { error } = await admin.from("cistyr_shift_selections").delete()
        .eq("shift_id", shift_id).eq("business_id", user.id).eq("status", "pending");
      if (error) throw error;
      return json({ released: true });
    }
    const { error: reserveError } = await admin.rpc("cistyr_reserve_worker", { p_shift_id: shift_id, p_business_id: user.id, p_worker_id: worker_id });
    if (reserveError) return json({ error: reserveError.message }, 409);
    const { data: selection, error: readError } = await admin.from("cistyr_shift_selections")
      .select("stripe_session_id").eq("shift_id", shift_id).eq("business_id", user.id).eq("worker_id", worker_id).single();
    if (readError) throw readError;
    if (selection.stripe_session_id) {
      const prior = await stripe.checkout.sessions.retrieve(selection.stripe_session_id);
      if (prior.payment_status === "paid") return json({ error: "Payment already received. Refresh your shifts." }, 409);
      if (prior.status === "open" && prior.url) return json({ url: prior.url });
      return json({ error: "The previous checkout expired. Contact support to release this selection." }, 409);
    }
    const site = Deno.env.get("PUBLIC_SITE_URL") || "https://cistyr.com";
    const session = await stripe.checkout.sessions.create({
      mode: "payment", customer_email: user.email || undefined,
      client_reference_id: user.id,
      success_url: site + "/?cistyr_selection_paid={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/?cistyr_selection_canceled=" + encodeURIComponent(shift_id),
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 625, product_data: { name: "CISTYR worker selection" } } }],
      metadata: { purpose: "worker_selection", shift_id, worker_id, business_id: user.id },
    });
    const { data: saved, error: saveError } = await admin.from("cistyr_shift_selections").update({ stripe_session_id: session.id })
      .eq("shift_id", shift_id).eq("business_id", user.id).eq("worker_id", worker_id).is("stripe_session_id", null).select("shift_id").maybeSingle();
    if (saveError || !saved) { await stripe.checkout.sessions.expire(session.id); throw saveError || new Error("Checkout already started. Please retry."); }
    return json({ url: session.url });
  } catch (e) { return json({ error: String((e as Error)?.message ?? e) }, 500); }
});
