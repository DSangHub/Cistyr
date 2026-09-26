// CISTYR job seeker FAQ. The OpenAI key stays in Supabase Edge Function secrets.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const instructions = `You are the CISTYR job seeker help assistant. Be brief and factual. Answer in the user's language.
CISTYR is a same-day and next-day shift board, not an employer or staffing agency.
Workers create a profile, browse nearby available shifts, and tap "Apply to Rescue" to express interest. A business may review up to three applicants and choose one. Applying does not guarantee the shift.
There is no lengthy traditional job application, but the worker must create a profile and tap "Apply to Rescue" for a shift.
Businesses post available shifts; do not invent current openings, employers, hiring status, or pay. Direct people to the live shift board and its "Near me" and distance filters.
Automatic job notifications are not available yet. Never promise an alert.
Experience requirements depend on each posting; some shifts may require no prior experience. Do not promise eligibility or qualifications.
Workers and businesses coordinate shift pay directly. CISTYR charges businesses $6.25 to choose a worker; posting is free.
If asked about account, password, payments, legal, or medical problems beyond this FAQ, direct the user to the appropriate site support or professional rather than inventing an answer.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const client = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError || !user) return json({ error: "Sign in as a worker to ask a custom question." }, 401);
    const { data: profile } = await client.from("cistyr_profiles").select("role").eq("id", user.id).maybeSingle();
    if (profile?.role !== "worker") return json({ error: "Worker account required." }, 403);
    const body = await req.json();
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question || question.length > 500) return json({ error: "Enter a question under 500 characters." }, 400);
    const key = Deno.env.get("OPENAI_API_KEY");
    if (!key) return json({ error: "AI answers are not configured yet. Use the common questions above." }, 503);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const { data: allowed, error: quotaError } = await admin.rpc("cistyr_take_job_help_quota", { p_worker_id: user.id });
    if (quotaError) return json({ error: "AI answers are temporarily unavailable." }, 503);
    if (!allowed) return json({ error: "You've reached the hourly question limit. Please try again later." }, 429);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions,
        input: question,
        max_output_tokens: 260,
        store: false,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return json({ error: "AI answers are temporarily unavailable." }, 502);
    const result = await response.json();
    const answer = (result.output || []).filter((item: any) => item.type === "message")
      .flatMap((item: any) => item.content || [])
      .filter((part: any) => part.type === "output_text")
      .map((part: any) => part.text || "").join("\n").trim();
    if (!answer) return json({ error: "No answer was available. Try the common questions above." }, 502);
    return json({ answer });
  } catch {
    return json({ error: "AI answers are temporarily unavailable." }, 502);
  }
});
