// CISTYR — first business shift free, subsequent shifts $6.25 via Stripe Checkout
// Auth handled in-code (verify_jwt=false so CORS preflight works); requires a signed-in business.
import Stripe from "npm:stripe@16.2.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const PRICE_CENTS = 625;

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Please sign in first." }, 401);

    const { data: profile } = await admin
      .from("cistyr_profiles").select("role, business_name").eq("id", user.id).maybeSingle();
    if (!profile || profile.role !== "business") {
      return json({ error: "Only business accounts can post shifts." }, 403);
    }

    const b = await req.json();
    const payRate = Number(b.pay_rate) || 0;
    const { data: freeShiftId, error: freeError } = await admin.rpc("cistyr_create_first_free_shift", {
      p_business_id: user.id, p_category: b.category, p_when_label: b.when_label,
      p_start_time: b.start_time, p_end_time: b.end_time, p_time_label: b.time_label,
      p_pay_rate: payRate, p_location: b.location, p_notes: b.notes,
      p_latitude: num(b.latitude), p_longitude: num(b.longitude),
    });
    if (freeError) throw freeError;
    if (freeShiftId) return json({ free: true, shift_id: freeShiftId });
    if (!Deno.env.get("STRIPE_SECRET_KEY")) {
      return json({ error: "Stripe not configured — set the STRIPE_SECRET_KEY secret in Supabase." }, 500);
    }
    const { data: shift, error: sErr } = await admin.from("cistyr_shifts").insert({
      business_id: user.id,
      category: b.category, when_label: b.when_label, start_time: b.start_time, end_time: b.end_time,
      time_label: b.time_label, pay_rate: payRate, location: b.location, notes: b.notes,
      latitude: num(b.latitude), longitude: num(b.longitude),
      status: "awaiting_payment", amount_cents: PRICE_CENTS,
    }).select("id").single();
    if (sErr) throw sErr;

    const origin = req.headers.get("origin") || Deno.env.get("PUBLIC_SITE_URL") || "https://cistyr.vercel.app";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: `${origin}/?cistyr_paid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?cistyr_canceled=1`,
      customer_email: user.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: PRICE_CENTS,
          product_data: { name: `CISTYR job posting — ${b.category ?? "shift"}` },
        },
      }],
      metadata: { shift_id: shift.id, business_id: user.id },
    });
    await admin.from("cistyr_shifts").update({ stripe_session_id: session.id }).eq("id", shift.id);
    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
