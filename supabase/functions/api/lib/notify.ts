import { db } from "./db.ts";

/** Port of AccountNotificationsService.create — an in-app notification row. Best-effort. */
export async function notifyUser(input: {
  recipientUserId: string; category: string; type: string; title: string; body: string;
  relatedEntityType?: string | null; relatedEntityId?: string | null; actionUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const { error } = await db().from("user_notifications").insert({
    recipient_user_id: input.recipientUserId,
    category: input.category,
    type: input.type,
    title: input.title,
    body: input.body,
    related_entity_type: input.relatedEntityType ?? null,
    related_entity_id: input.relatedEntityId ?? null,
    action_url: input.actionUrl ?? null,
    metadata: input.metadata ?? null,
  });
  if (error) console.warn(`[notifications] not persisted for ${input.recipientUserId}: ${error.message}`);
}
