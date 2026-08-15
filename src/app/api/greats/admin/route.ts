import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Learn From the Greats — Admin CMS. Manage the media resources (audio, PDFs,
 * workbooks, videos, official links) that appear in the library. Admins only.
 *
 *   GET  → { resources } (ALL rows, published or not)
 *   POST → one action, discriminated by { action }:
 *     create        { masterclassId, lessonId?, kind, title, description?, externalUrl?, storagePath?, sort?, published? }
 *     update        { id, ...fields }
 *     delete        { id }                         (also removes the storage object)
 *     publish       { id, published }
 *     reorder       { ids: string[] }              (sets sort by array order)
 *     signedUpload  { path, contentType? }         (returns a signed upload URL for the browser)
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function requireAdmin() {
  const supabase = createClient();
  if (!supabase) return { ok: false as const, res: json({ error: "not_configured" }, 500) };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, res: json({ error: "unauthorized" }, 401) };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return { ok: false as const, res: json({ error: "forbidden" }, 403) };
  const admin = createAdminClient();
  if (!admin) return { ok: false as const, res: json({ error: "no_admin_client" }, 500) };
  return { ok: true as const, admin, uid: user.id };
}

const FIELDS = ["masterclass_id", "lesson_id", "kind", "title", "description", "external_url", "storage_path", "sort", "published"];
const CAMEL: Record<string, string> = {
  masterclassId: "masterclass_id", lessonId: "lesson_id", kind: "kind", title: "title",
  description: "description", externalUrl: "external_url", storagePath: "storage_path",
  sort: "sort", published: "published",
};

export async function GET() {
  const g = await requireAdmin();
  if (!g.ok) return g.res;
  const { data, error } = await g.admin
    .from("greats_resources")
    .select("*")
    .order("masterclass_id", { ascending: true })
    .order("sort", { ascending: true });
  if (error) return json({ error: "load_failed", detail: error.message }, 500);
  return json({ ok: true, resources: data ?? [] }, 200);
}

export async function POST(req: NextRequest) {
  const g = await requireAdmin();
  if (!g.ok) return g.res;
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = String(b.action || "");
  const S = (v: unknown, n = 400) => String(v ?? "").slice(0, n);

  try {
    if (action === "create") {
      const row: Record<string, unknown> = {
        masterclass_id: S(b.masterclassId, 80) || null,
        lesson_id: S(b.lessonId, 80) || null,
        kind: ["audio", "pdf", "video", "workbook", "link"].includes(String(b.kind)) ? b.kind : "pdf",
        title: S(b.title, 200) || "Untitled",
        description: S(b.description, 1000) || null,
        external_url: S(b.externalUrl, 800) || null,
        storage_path: S(b.storagePath, 400) || null,
        sort: Math.max(0, Number(b.sort) || 0),
        published: b.published === true,
        created_by: g.uid,
      };
      const { data, error } = await g.admin.from("greats_resources").insert(row).select("id").single();
      if (error) return json({ error: "create_failed", detail: error.message }, 500);
      return json({ ok: true, id: data?.id }, 200);
    }

    if (action === "update") {
      const id = S(b.id, 60);
      if (!id) return json({ error: "missing_id" }, 400);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const [camel, snake] of Object.entries(CAMEL)) {
        if (camel in b) {
          if (snake === "sort") patch[snake] = Math.max(0, Number(b[camel]) || 0);
          else if (snake === "published") patch[snake] = b[camel] === true;
          else patch[snake] = S(b[camel], snake === "external_url" ? 800 : snake === "description" ? 1000 : 400) || null;
        }
      }
      const { error } = await g.admin.from("greats_resources").update(patch).eq("id", id);
      if (error) return json({ error: "update_failed", detail: error.message }, 500);
      return json({ ok: true }, 200);
    }

    if (action === "publish") {
      const id = S(b.id, 60);
      if (!id) return json({ error: "missing_id" }, 400);
      const { error } = await g.admin.from("greats_resources").update({ published: b.published === true, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) return json({ error: "publish_failed", detail: error.message }, 500);
      return json({ ok: true }, 200);
    }

    if (action === "delete") {
      const id = S(b.id, 60);
      if (!id) return json({ error: "missing_id" }, 400);
      const { data: row } = await g.admin.from("greats_resources").select("storage_path").eq("id", id).maybeSingle();
      if (row?.storage_path) { try { await g.admin.storage.from("greats").remove([row.storage_path]); } catch { /* ignore */ } }
      const { error } = await g.admin.from("greats_resources").delete().eq("id", id);
      if (error) return json({ error: "delete_failed", detail: error.message }, 500);
      return json({ ok: true }, 200);
    }

    if (action === "reorder") {
      const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map((x) => S(x, 60)).filter(Boolean) : [];
      for (let i = 0; i < ids.length; i++) {
        await g.admin.from("greats_resources").update({ sort: i, updated_at: new Date().toISOString() }).eq("id", ids[i]);
      }
      return json({ ok: true }, 200);
    }

    if (action === "signedUpload") {
      const path = S(b.path, 400).replace(/^\/+/, "");
      if (!path) return json({ error: "missing_path" }, 400);
      const { data, error } = await g.admin.storage.from("greats").createSignedUploadUrl(path, { upsert: true });
      if (error) return json({ error: "sign_failed", detail: error.message }, 500);
      return json({ ok: true, path, token: data?.token, signedUrl: data?.signedUrl }, 200);
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: "server_error", detail: String(e).slice(0, 200) }, 500);
  }
}
