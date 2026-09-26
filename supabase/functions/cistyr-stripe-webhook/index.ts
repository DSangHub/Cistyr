import Stripe from "npm:stripe@16.2.0";
import { createClient } from "npm:@supabase/supabase-js@2";
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2024-06-20", httpClient: Stripe.createFetchHttpClient() });
const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

async function confirmSession(id: string) {
  const session = await stripe.checkout.sessions.retrieve(id);
  if (session.payment_status !== "paid" || session.mode !== "payment" || session.currency !== "usd" || session.amount_total !== 625) return;
  const shiftId = session.metadata?.shift_id, businessId = session.metadata?.business_id;
  if (!shiftId || !businessId) return;
  if (session.metadata?.purpose === "worker_selection") {
    const workerId = session.metadata.worker_id;
    if (!workerId) return;
    const { data: ok, error } = await admin.rpc("cistyr_finish_worker_selection", {
      p_shift_id: shiftId, p_business_id: businessId, p_worker_id: workerId, p_session_id: session.id,
    });
    if (error) throw error;
    if (!ok) throw new Error("Paid selection could not be finalized");
    return;
  }
  // Historical paid posting sessions remain valid after the pricing change.
  const { error } = await admin.from("cistyr_shifts")
    .update({ status: "open", paid_at: new Date().toISOString() })
    .eq("id", shiftId).eq("business_id", businessId).eq("stripe_session_id", session.id).eq("status", "awaiting_payment");
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (secret) event = await stripe.webhooks.constructEventAsync(raw, req.headers.get("stripe-signature") ?? "", secret);
    else event = JSON.parse(raw); // A paid Checkout Session is independently re-fetched and checked above.
  } catch { return new Response("Bad signature", { status: 400 }); }
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const id = (event.data.object as Stripe.Checkout.Session).id;
      if (id) await confirmSession(id);
    }
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) { return new Response(String((e as Error)?.message ?? e), { status: 500 }); }
});
