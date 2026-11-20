// A fresh Google Drive access token for the web app, from the refresh token
// kept in google_tokens. Only Andy's own signed-in session gets one: the row
// is read with his JWT, so row security decides. No AI, no other keys.
//
// Secrets (Edge Functions › Secrets): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// the same web client Supabase's Google sign-in uses.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: user } = await db.auth.getUser();
  const email = user.user?.email?.toLowerCase();
  if (!email) return json({ error: "signed out" }, 401);
  const { data: row } = await db.from("google_tokens").select("refresh_token").eq("email", email).maybeSingle();
  if (!row) return json({ error: "no Drive login yet" }, 404);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const out = await res.json();
  if (!res.ok) return json({ error: out.error_description ?? out.error ?? "Google said no" }, 502);
  return json({ access_token: out.access_token, expires_in: out.expires_in });
});
