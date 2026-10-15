import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async () => {
  const { data: pendingEvents, error } = await supabase
    .from("integration_events")
    .select("id, reservation_id, provider, event_type, retries, payload")
    .in("status", ["pendiente", "error"])
    .lt("retries", 5)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  for (const event of pendingEvents ?? []) {
    const fn = event.provider === "google_calendar" ? "google-calendar-sync" : "whatsapp-notifier";

    const { error: invokeError } = await supabase.functions.invoke(fn, {
      body: {
        eventId: event.id,
        reservationId: event.reservation_id,
        eventType: event.event_type,
        payload: event.payload,
      },
    });

    if (invokeError) {
      await supabase
        .from("integration_events")
        .update({ status: "error", retries: event.retries + 1, updated_at: new Date().toISOString() })
        .eq("id", event.id);
    }
  }

  return new Response(JSON.stringify({ processed: pendingEvents?.length ?? 0 }), {
    headers: { "Content-Type": "application/json" },
  });
});
