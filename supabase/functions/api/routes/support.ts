import { Hono } from "hono";
import { optionalSubject, requireAdmin } from "../lib/auth.ts";
import { db } from "../lib/db.ts";
import { HttpError } from "../lib/http.ts";
import { escapeHtml, sendMail } from "../lib/mail.ts";
import { validate } from "../lib/validate.ts";

/**
 * Port of backend/src/support. Public submit (a signed-out visitor must reach a
 * human too; a valid token only attaches the sender), admin list + status.
 * The table is service-role only: every row carries contact details.
 */
export const support = new Hono();

interface SupportInput {
  name: string; email: string; phone?: string; subject: string; message: string; page_url?: string;
}

const supportInbox = () =>
  Deno.env.get("SUPPORT_INBOX_EMAIL")?.trim() || Deno.env.get("MAIL_REPLY_TO")?.trim() || null;

support.post("/support/messages", async (c) => {
  const input = validate<SupportInput>(await c.req.json().catch(() => ({})), {
    name: { type: "string", min: 2, max: 120 },
    email: { type: "string", email: true, max: 200 },
    phone: { type: "string", max: 40, optional: true },
    subject: { type: "string", min: 3, max: 160 },
    message: { type: "string", min: 10, max: 4000 },
    page_url: { type: "string", max: 500, optional: true },
  });
  const row = {
    user_id: await optionalSubject(c),
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone?.trim() || null,
    subject: input.subject.trim(),
    message: input.message.trim(),
    page_url: input.page_url?.trim() || null,
    status: "new",
  };
  const { data: saved, error } = await db().from("support_messages").insert(row).select("id").single();
  if (error) {
    console.error("Could not store support message", error);
    throw new HttpError(503, "Could not send your message. Please try again.");
  }

  // Best-effort: the message is stored; a mail outage must not become a resend.
  const inbox = supportInbox();
  if (inbox) {
    try {
      await sendMail({
        to: inbox,
        subject: `Support · ${row.subject}`,
        text: [
          `From: ${row.name} <${row.email}>`,
          row.phone ? `Phone: ${row.phone}` : null,
          row.page_url ? `Page: ${row.page_url}` : null,
          row.user_id ? `User id: ${row.user_id}` : "Not signed in",
          "",
          row.message,
        ].filter(Boolean).join("\n"),
        html: [
          `<p><strong>${escapeHtml(row.name)}</strong> &lt;${escapeHtml(row.email)}&gt;</p>`,
          row.phone ? `<p>Phone: ${escapeHtml(row.phone)}</p>` : "",
          row.page_url ? `<p>Page: ${escapeHtml(row.page_url)}</p>` : "",
          `<p>${row.user_id ? `User id: ${escapeHtml(row.user_id)}` : "Not signed in"}</p>`,
          `<hr /><p style="white-space:pre-wrap">${escapeHtml(row.message)}</p>`,
        ].join(""),
      });
    } catch (err) {
      console.warn(`Support message ${saved?.id} stored but email failed: ${String(err)}`);
    }
  } else {
    console.warn(`Support message ${saved?.id} stored but no inbox configured — set SUPPORT_INBOX_EMAIL.`);
  }
  return c.json({ ok: true, id: saved?.id ?? null }, 201);
});

support.get("/admin/support/messages", async (c) => {
  await requireAdmin(c, "users.read");
  const status = c.req.query("status");
  let q = db().from("support_messages").select("*").order("created_at", { ascending: false }).limit(200);
  if (status && status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new HttpError(503, "Could not load support messages.");
  return c.json(data ?? []);
});

support.patch("/admin/support/messages/:id", async (c) => {
  const admin = await requireAdmin(c, "users.read");
  const body = validate<{ handled?: boolean }>(await c.req.json().catch(() => ({})), {
    handled: { type: "boolean", optional: true },
  });
  const handled = body.handled !== false;
  const { data, error } = await db()
    .from("support_messages")
    .update({
      status: handled ? "handled" : "new",
      handled_at: handled ? new Date().toISOString() : null,
      handled_by: handled ? admin.id : null,
    })
    .eq("id", c.req.param("id"))
    .select();
  if (error) throw new HttpError(503, "Could not update the message.");
  return c.json(data?.[0] ?? { ok: true });
});
