"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Users2, Play, FileText, Headphones, Plus, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Kind = "status" | "video" | "audio" | "pdf";

interface Post {
  id: string;
  kind: Kind;
  body: string | null;
  media_url: string | null;
  created_at: string;
  author_id: string;
  author_name: string | null;
  author_username: string | null;
  author_headline: string | null;
  author_avatar: string | null;
}
interface Creator {
  id: string;
  full_name: string | null;
  username: string | null;
  headline: string | null;
  bio: string | null;
  avatar_url: string | null;
  is_following: boolean;
  post_count: number;
}
interface Me { id: string; name: string | null; isCreator: boolean; }

function initials(name: string | null, fallback = "1M") {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || fallback;
}
function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function InnerCircleClient({ me }: { me: Me }) {
  const [tab, setTab] = useState<"following" | "everyone">("everyone");
  const [posts, setPosts] = useState<Post[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) { setLoading(false); return; }
    setLoading(true);
    const [{ data: feed }, { data: cr }] = await Promise.all([
      supabase.rpc("get_inner_feed", { only_following: tab === "following" }),
      supabase.rpc("get_creators"),
    ]);
    setPosts((feed as Post[]) ?? []);
    setCreators((cr as Creator[]) ?? []);
    setLoading(false);
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  async function toggleFollow(id: string) {
    const supabase = createClient();
    if (!supabase) return;
    setCreators((cs) => cs.map((c) => c.id === id ? { ...c, is_following: !c.is_following } : c));
    await supabase.rpc("toggle_follow", { target: id });
    if (tab === "following") load();
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="eyebrow text-gold">Members Only</p>
        <h1 className="mt-2 flex items-center gap-2 font-serif text-4xl font-black tracking-tight text-navy">
          <Users2 className="h-8 w-8 text-gold" aria-hidden="true" /> The Inner Circle
        </h1>
        <p className="mt-2 max-w-2xl text-charcoal/70">
          Follow the educators and leaders you learn from. Get their videos, recordings, resources, and updates in one feed.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        {/* Feed */}
        <div className="min-w-0 space-y-5">
          {me.isCreator && <Composer onPosted={load} />}

          <div className="flex gap-2">
            {(["everyone", "following"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`rounded-full px-4 py-2 text-sm font-semibold capitalize transition-colors ${
                  tab === t ? "bg-primary text-cream" : "border border-[#E4DCCB] text-charcoal/70 hover:bg-ice"
                }`}>
                {t === "everyone" ? "Everyone" : "Following"}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 rounded-2xl border border-[#E4DCCB] bg-cream p-6 text-sm text-charcoal/60">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the feed…
            </div>
          ) : posts.length === 0 ? (
            <div className="rounded-2xl border border-[#E4DCCB] bg-offwhite/50 p-8 text-center text-sm text-charcoal/60">
              {tab === "following"
                ? "You're not following anyone yet. Follow a few creators on the right to fill your feed."
                : "No posts yet. Once creators start posting, they'll show up here."}
            </div>
          ) : (
            posts.map((p) => <PostCard key={p.id} post={p} />)
          )}
        </div>

        {/* Creators sidebar */}
        <aside className="space-y-3 lg:sticky lg:top-24 lg:self-start">
          <h2 className="text-xs font-bold uppercase tracking-label text-medium">Creators to follow</h2>
          {creators.length === 0 ? (
            <p className="rounded-2xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/60">
              No creators yet. An admin can grant creator access from the Approvals page.
            </p>
          ) : creators.map((c) => (
            <div key={c.id} className="rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
              <div className="flex items-center gap-3">
                <Avatar name={c.full_name} src={c.avatar_url} />
                <div className="min-w-0">
                  <p className="truncate font-semibold text-navy">{c.full_name || c.username || "Creator"}</p>
                  <p className="truncate text-xs text-medium">{c.headline || `${c.post_count} posts`}</p>
                </div>
              </div>
              <button onClick={() => toggleFollow(c.id)}
                className={`mt-3 w-full rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider transition-colors ${
                  c.is_following ? "border border-[#E4DCCB] text-charcoal/70 hover:bg-ice" : "bg-gradient-primary text-cream hover:-translate-y-0.5"
                }`}>
                {c.is_following ? "Following" : "Follow"}
              </button>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

function Avatar({ name, src }: { name: string | null; src: string | null }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" className="h-11 w-11 flex-shrink-0 rounded-full object-cover" />;
  }
  return (
    <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-gradient-gold font-serif text-sm font-bold text-navy">
      {initials(name)}
    </span>
  );
}

function PostCard({ post }: { post: Post }) {
  return (
    <article className="rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
      <div className="flex items-center gap-3">
        <Avatar name={post.author_name} src={post.author_avatar} />
        <div className="min-w-0">
          <p className="font-semibold text-navy">{post.author_name || post.author_username || "Creator"}</p>
          <p className="text-xs text-medium">{post.author_headline ? `${post.author_headline} · ` : ""}{timeAgo(post.created_at)}</p>
        </div>
      </div>
      {post.body && <p className="mt-4 whitespace-pre-wrap text-[15px] leading-relaxed text-charcoal/85">{post.body}</p>}
      {post.media_url && <Media kind={post.kind} url={post.media_url} />}
    </article>
  );
}

function Media({ kind, url }: { kind: Kind; url: string }) {
  if (kind === "audio") {
    return (
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-[#E4DCCB] bg-offwhite/60 p-3">
        <Headphones className="h-5 w-5 flex-shrink-0 text-gold" />
        <audio controls src={url} className="w-full" />
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <a href={url} target="_blank" rel="noreferrer"
        className="mt-4 flex items-center gap-3 rounded-xl border border-[#E4DCCB] bg-offwhite/60 p-4 hover:border-gold">
        <FileText className="h-5 w-5 flex-shrink-0 text-gold" />
        <span className="text-sm font-semibold text-navy">Open PDF resource</span>
      </a>
    );
  }
  // video (default)
  return (
    <a href={url} target="_blank" rel="noreferrer"
      className="group mt-4 flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-[#233] bg-gradient-navy">
      <span className="grid h-14 w-14 place-items-center rounded-full bg-red-600 text-white shadow-lg transition-transform group-hover:scale-105">
        <Play className="h-6 w-6 fill-current" />
      </span>
    </a>
  );
}

/* Creator-only composer */
function Composer({ onPosted }: { onPosted: () => void }) {
  const [kind, setKind] = useState<Kind>("status");
  const [body, setBody] = useState("");
  const [media, setMedia] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() && !media.trim()) return;
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true); setErr("");
    const { error } = await supabase.rpc("create_inner_post", {
      p_kind: kind, p_body: body.trim() || null, p_media_url: media.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setBody(""); setMedia(""); setKind("status");
    onPosted();
  }

  const kinds: { k: Kind; label: string }[] = [
    { k: "status", label: "Status" }, { k: "video", label: "Video" },
    { k: "audio", label: "Recording" }, { k: "pdf", label: "PDF" },
  ];

  return (
    <form onSubmit={submit} className="rounded-2xl border border-gold/40 bg-cream p-5 shadow-card">
      <p className="text-xs font-bold uppercase tracking-label text-gold">Post to your followers</p>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
        placeholder="Share an update, a lesson, or a win…"
        className="mt-3 w-full resize-none rounded-xl border border-[#E4DCCB] bg-offwhite/40 p-3 text-sm outline-none focus:border-gold" />
      <div className="mt-3 flex flex-wrap gap-2">
        {kinds.map(({ k, label }) => (
          <button type="button" key={k} onClick={() => setKind(k)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              kind === k ? "bg-gradient-primary text-cream" : "border border-[#E4DCCB] text-charcoal/70 hover:bg-ice"
            }`}>{label}</button>
        ))}
      </div>
      {kind !== "status" && (
        <input value={media} onChange={(e) => setMedia(e.target.value)}
          placeholder={kind === "video" ? "Video link (YouTube, Vimeo, …)" : kind === "audio" ? "Audio/recording link (.mp3)" : "PDF link"}
          className="mt-3 w-full rounded-xl border border-[#E4DCCB] bg-offwhite/40 px-3 py-2.5 text-sm outline-none focus:border-gold" />
      )}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      <div className="mt-3 flex justify-end">
        <button type="submit" disabled={busy}
          className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-6 py-2.5 text-sm font-bold uppercase tracking-wider text-cream disabled:opacity-60">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Post
        </button>
      </div>
      <p className="mt-2 text-[11px] text-charcoal/50">
        Tip: paste a link for now. Direct file uploads (video/audio/PDF) are coming next.
      </p>
    </form>
  );
}
