"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, BadgeCheck, ArrowLeft, UserPlus, Check, MessageSquare,
  Grid3x3, Clapperboard, FileText, Heart, MessageCircle, Play, Download,
  Plus, X, ImagePlus, Loader2, Trash2, Sparkles,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";

/* ---------------- types ---------------- */

type Me = {
  id: string;
  name: string | null;
  username: string | null;
  avatar: string | null;
  isCreator: boolean;
};

type Creator = {
  id: string;
  full_name: string | null;
  username: string | null;
  headline: string | null;
  bio: string | null;
  avatar_url: string | null;
  is_following: boolean;
  post_count: number;
  follower_count: number;
};

type Post = {
  id: string;
  kind: string;
  body: string | null;
  media_url: string | null;
  media_urls: string[] | null;
  poster_url: string | null;
  title: string | null;
  created_at: string;
  like_count: number;
  viewer_liked: boolean;
};

/* ---------------- helpers ---------------- */

const GRADS = [
  "from-[#B8862F] to-[#7a5417]",
  "from-[#3a6ea5] to-[#1f3f66]",
  "from-[#7a4fb5] to-[#452a6b]",
  "from-[#0f8a6d] to-[#0a5a47]",
  "from-[#c0574b] to-[#7d332a]",
];
function gradFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADS[h % GRADS.length];
}
function initials(name: string | null, handle: string | null) {
  const src = (name || handle || "1M").trim();
  const parts = src.split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "1M";
}
function timeAgo(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const dd = Math.floor(h / 24);
  if (dd < 7) return `${dd}d`;
  return `${Math.floor(dd / 7)}w`;
}
function fmt(n: number) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function Avatar({
  url, name, handle, className = "h-14 w-14 text-lg",
}: { url: string | null; name: string | null; handle: string | null; className?: string }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={name ?? ""} className={`rounded-full object-cover ${className}`} />;
  }
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-extrabold text-cream ${gradFor(handle ?? name ?? "x")} ${className}`}
    >
      {initials(name, handle)}
    </span>
  );
}

/* ---------------- root ---------------- */

export function InnerCircleClient({ me }: { me: Me }) {
  const supabase = useMemo(() => createClient(), []);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Creator | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  const loadCreators = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data } = await supabase.rpc("get_creators");
    setCreators((data as Creator[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { loadCreators(); }, [loadCreators]);

  const toggleFollow = async (c: Creator) => {
    if (!supabase) return;
    const optimistic = !c.is_following;
    const patch = (x: Creator) =>
      x.id === c.id
        ? { ...x, is_following: optimistic, follower_count: x.follower_count + (optimistic ? 1 : -1) }
        : x;
    setCreators((prev) => prev.map(patch));
    setSelected((prev) => (prev && prev.id === c.id ? patch(prev) : prev));
    const { data, error } = await supabase.rpc("toggle_follow", { target: c.id });
    if (error) { setCreators((prev) => prev.map(patch)); return; } // revert on error
    const confirmed = Boolean(data);
    const fix = (x: Creator) => (x.id === c.id ? { ...x, is_following: confirmed } : x);
    setCreators((prev) => prev.map(fix));
    setSelected((prev) => (prev && prev.id === c.id ? fix(prev) : prev));
  };

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return creators;
    return creators.filter((c) =>
      (c.full_name ?? "").toLowerCase().includes(q) ||
      (c.username ?? "").toLowerCase().includes(q) ||
      (c.headline ?? "").toLowerCase().includes(q)
    );
  }, [query, creators]);

  if (!supabase) return <PortalNotConfigured />;

  if (selected) {
    return (
      <>
        <Profile
          me={me}
          creator={selected}
          onFollow={() => toggleFollow(selected)}
          onBack={() => setSelected(null)}
          onChanged={loadCreators}
        />
        {composerOpen && (
          <Composer me={me} supabase={supabase} onClose={() => setComposerOpen(false)} onPosted={loadCreators} />
        )}
      </>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Community</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-navy">The Inner Circle</h1>
          <p className="mt-2 text-charcoal/70">Search creators, follow them, and see everything they share.</p>
        </div>
        {me.isCreator && (
          <button
            onClick={() => setComposerOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-cream shadow-card transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Create post
          </button>
        )}
      </header>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-medium" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search creators…"
          className="w-full rounded-xl border border-[#E4DCCB] bg-cream py-3 pl-11 pr-4 text-sm text-navy placeholder:text-medium focus:border-primary focus:outline-none"
        />
      </div>

      {/* Directory */}
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[104px] animate-pulse rounded-2xl border border-[#E4DCCB] bg-offwhite/60" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((c) => (
            <div key={c.id} className="flex flex-col rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
              <button onClick={() => setSelected(c)} className="flex items-center gap-3 text-left">
                <Avatar url={c.avatar_url} name={c.full_name} handle={c.username} />
                <div className="min-w-0">
                  <p className="flex items-center gap-1 font-bold text-navy">
                    <span className="truncate">{c.full_name ?? c.username ?? "Creator"}</span>
                    <BadgeCheck className="h-4 w-4 flex-shrink-0 text-gold-deep" />
                  </p>
                  {c.username && <p className="truncate text-xs text-medium">@{c.username}</p>}
                  {c.headline && <p className="truncate text-xs text-charcoal/60">{c.headline}</p>}
                </div>
              </button>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-medium">
                  <span className="font-semibold text-navy">{fmt(c.follower_count)}</span> followers
                </span>
                <FollowButton following={c.is_following} onClick={() => toggleFollow(c)} small />
              </div>
            </div>
          ))}
          {list.length === 0 && (
            <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-6 text-sm text-charcoal/60 sm:col-span-2 xl:col-span-3">
              {query ? `No creators match “${query}”.` : "No creators yet."}
            </p>
          )}
        </div>
      )}

      {composerOpen && (
        <Composer me={me} supabase={supabase} onClose={() => setComposerOpen(false)} onPosted={loadCreators} />
      )}
    </div>
  );
}

function FollowButton({ following, onClick, small }: { following: boolean; onClick: () => void; small?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg font-bold transition-colors ${
        small ? "px-3.5 py-1.5 text-xs" : "px-4 py-2 text-sm"
      } ${following ? "border border-[#E4DCCB] text-charcoal/70 hover:bg-ice" : "bg-primary text-cream hover:opacity-90"}`}
    >
      {following
        ? <><Check className={small ? "h-3.5 w-3.5" : "h-4 w-4"} /> Following</>
        : <><UserPlus className={small ? "h-3.5 w-3.5" : "h-4 w-4"} /> Follow</>}
    </button>
  );
}

/* ---------------- profile ---------------- */

const TABS = [
  { id: "posts", label: "Posts", icon: Grid3x3 },
  { id: "status", label: "Status", icon: MessageSquare },
  { id: "reels", label: "Reels", icon: Clapperboard },
  { id: "files", label: "Files", icon: FileText },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Profile({
  me, creator, onFollow, onBack, onChanged,
}: {
  me: Me; creator: Creator; onFollow: () => void; onBack: () => void; onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [tab, setTab] = useState<TabId>("posts");
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const isMe = me.id === creator.id;

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data } = await supabase.rpc("get_creator_posts", { target: creator.id });
    setPosts((data as Post[]) ?? []);
    setLoading(false);
  }, [supabase, creator.id]);

  useEffect(() => { load(); }, [load]);

  const like = async (p: Post) => {
    if (!supabase) return;
    const optimistic = !p.viewer_liked;
    setPosts((prev) => prev.map((x) =>
      x.id === p.id ? { ...x, viewer_liked: optimistic, like_count: x.like_count + (optimistic ? 1 : -1) } : x));
    await supabase.rpc("toggle_like", { target: p.id });
  };
  const remove = async (p: Post) => {
    if (!supabase) return;
    setPosts((prev) => prev.filter((x) => x.id !== p.id));
    await supabase.rpc("delete_inner_post", { target: p.id });
    onChanged();
  };

  const photos = posts.filter((p) => p.kind === "photo");
  const statuses = posts.filter((p) => p.kind === "status");
  const reels = posts.filter((p) => p.kind === "reel" || p.kind === "video");
  const files = posts.filter((p) => p.kind === "pdf");

  const name = creator.full_name ?? creator.username ?? "Creator";
  const bioLines = (creator.bio ?? "").split("\n").filter(Boolean);

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-semibold text-charcoal/70 hover:text-navy">
        <ArrowLeft className="h-4 w-4" /> Back to creators
      </button>

      {/* Header */}
      <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar url={creator.avatar_url} name={name} handle={creator.username} className="h-20 w-20 text-2xl sm:h-24 sm:w-24" />
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="flex items-center gap-1.5 text-xl font-extrabold tracking-tight text-navy">
                {name}
                <BadgeCheck className="h-5 w-5 text-gold-deep" />
              </h1>
              {creator.username && <span className="text-sm text-medium">@{creator.username}</span>}
            </div>
            <div className="mt-2 flex gap-5 text-sm">
              <span><span className="font-bold text-navy">{creator.post_count}</span> <span className="text-medium">posts</span></span>
              <span><span className="font-bold text-navy">{fmt(creator.follower_count)}</span> <span className="text-medium">followers</span></span>
            </div>
          </div>
          <div className="flex gap-2">
            {!isMe && <FollowButton following={creator.is_following} onClick={onFollow} />}
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-[#E4DCCB] px-4 py-2 text-sm font-bold text-navy hover:bg-ice">
              <MessageSquare className="h-4 w-4" /> Message
            </button>
          </div>
        </div>
        {creator.headline && <p className="mt-3 text-sm font-semibold text-charcoal/85">{creator.headline}</p>}
        {bioLines.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {bioLines.map((b, i) => <p key={i} className="text-sm text-charcoal/80">{b}</p>)}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-xl border border-[#E4DCCB] bg-offwhite/60 p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold transition-colors ${
                active ? "bg-primary text-cream" : "text-charcoal/60 hover:bg-ice"
              }`}
            >
              <Icon className="h-4 w-4" /> <span className="hidden sm:inline">{t.label}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="grid place-items-center rounded-2xl border border-[#E4DCCB] bg-offwhite/40 py-16">
          <Loader2 className="h-6 w-6 animate-spin text-medium" />
        </div>
      ) : (
        <>
          {tab === "posts" && <PhotoGrid photos={photos} />}
          {tab === "status" && <StatusFeed statuses={statuses} creator={creator} onLike={like} canDelete={isMe} onDelete={remove} />}
          {tab === "reels" && <ReelGrid reels={reels} />}
          {tab === "files" && <FileList files={files} />}
        </>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-[#E4DCCB] bg-offwhite/40 p-8 text-center text-sm text-charcoal/55">
      {children}
    </p>
  );
}

function PhotoGrid({ photos }: { photos: Post[] }) {
  if (photos.length === 0) return <Empty>No photos yet.</Empty>;
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:gap-2.5">
      {photos.map((p) => {
        const src = p.media_urls?.[0] ?? p.media_url ?? "";
        return (
          <div key={p.id} className="group relative aspect-square overflow-hidden rounded-lg bg-ice">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {src && <img src={src} alt={p.body ?? ""} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />}
            <div className="absolute inset-0 flex items-center justify-center gap-4 bg-black/40 text-sm font-bold text-white opacity-0 transition group-hover:opacity-100">
              <span className="inline-flex items-center gap-1"><Heart className="h-4 w-4 fill-white" /> {p.like_count}</span>
              {(p.media_urls?.length ?? 0) > 1 && (
                <span className="inline-flex items-center gap-1"><Grid3x3 className="h-4 w-4" /> {p.media_urls?.length}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusFeed({
  statuses, creator, onLike, canDelete, onDelete,
}: {
  statuses: Post[]; creator: Creator; onLike: (p: Post) => void; canDelete: boolean; onDelete: (p: Post) => void;
}) {
  if (statuses.length === 0) return <Empty>No status updates yet.</Empty>;
  const name = creator.full_name ?? creator.username ?? "Creator";
  return (
    <div className="space-y-3">
      {statuses.map((s) => (
        <article key={s.id} className="rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
          <div className="flex items-center gap-2.5">
            <Avatar url={creator.avatar_url} name={name} handle={creator.username} className="h-9 w-9 text-xs" />
            <div className="flex-1">
              <p className="text-sm font-bold text-navy">{name}</p>
              <p className="text-xs text-medium">{timeAgo(s.created_at)} ago</p>
            </div>
            {canDelete && (
              <button onClick={() => onDelete(s)} className="text-medium hover:text-red-500" aria-label="Delete post">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          {s.body && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-charcoal/85">{s.body}</p>}
          {(s.media_urls?.[0] ?? s.media_url) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.media_urls?.[0] ?? s.media_url ?? ""} alt="" className="mt-3 max-h-96 w-full rounded-xl object-cover" />
          )}
          <div className="mt-3 flex gap-5 border-t border-[#E4DCCB] pt-3 text-sm text-medium">
            <button onClick={() => onLike(s)} className={`inline-flex items-center gap-1.5 transition-colors ${s.viewer_liked ? "text-red-500" : "hover:text-navy"}`}>
              <Heart className={`h-4 w-4 ${s.viewer_liked ? "fill-red-500" : ""}`} /> {s.like_count}
            </button>
            <span className="inline-flex items-center gap-1.5"><MessageCircle className="h-4 w-4" /> Comment</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function ReelGrid({ reels }: { reels: Post[] }) {
  const [active, setActive] = useState<Post | null>(null);
  if (reels.length === 0) return <Empty>No reels yet.</Empty>;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {reels.map((r) => (
          <button
            key={r.id}
            onClick={() => setActive(r)}
            className={`group relative aspect-[9/16] overflow-hidden rounded-xl bg-gradient-to-br ${gradFor(r.id)}`}
          >
            {r.poster_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.poster_url} alt="" className="h-full w-full object-cover" />
            )}
            <div className="absolute inset-0 flex items-center justify-center bg-black/20">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/25 backdrop-blur transition group-hover:scale-110">
                <Play className="ml-0.5 h-5 w-5 fill-white text-white" />
              </span>
            </div>
            {r.body && (
              <span className="absolute inset-x-2 bottom-2 line-clamp-2 text-left text-xs font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
                {r.body}
              </span>
            )}
          </button>
        ))}
      </div>
      {active && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4" onClick={() => setActive(null)}>
          <div className="relative w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setActive(null)} className="absolute -top-10 right-0 text-white/80 hover:text-white">
              <X className="h-6 w-6" />
            </button>
            {active.media_url && (
              <video src={active.media_url} controls autoPlay playsInline className="w-full rounded-2xl bg-black" />
            )}
            {active.body && <p className="mt-3 text-sm text-white/90">{active.body}</p>}
          </div>
        </div>
      )}
    </>
  );
}

function FileList({ files }: { files: Post[] }) {
  if (files.length === 0) return <Empty>No files yet.</Empty>;
  return (
    <div className="space-y-2">
      {files.map((f) => (
        <div key={f.id} className="flex items-center gap-3 rounded-xl border border-[#E4DCCB] bg-cream p-3.5 shadow-card">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ice text-primary">
            <FileText className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-navy">{f.title ?? f.body ?? "Document.pdf"}</p>
            <p className="text-xs text-medium">PDF · {timeAgo(f.created_at)} ago</p>
          </div>
          {f.media_url && (
            <a
              href={f.media_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#E4DCCB] px-3.5 py-1.5 text-xs font-bold text-navy hover:bg-ice"
            >
              <Download className="h-3.5 w-3.5" /> Open
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------- composer ---------------- */

type SB = NonNullable<ReturnType<typeof createClient>>;
const KINDS = [
  { id: "photo", label: "Photo", icon: ImagePlus },
  { id: "status", label: "Status", icon: MessageSquare },
  { id: "reel", label: "Reel", icon: Clapperboard },
  { id: "pdf", label: "File", icon: FileText },
] as const;
type Kind = (typeof KINDS)[number]["id"];

function Composer({
  me, supabase, onClose, onPosted,
}: { me: Me; supabase: SB; onClose: () => void; onPosted: () => void }) {
  const [kind, setKind] = useState<Kind>("photo");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [poster, setPoster] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const posterRef = useRef<HTMLInputElement>(null);

  const accept =
    kind === "photo" ? "image/*" : kind === "reel" ? "video/*" : kind === "pdf" ? "application/pdf" : "";

  const upload = async (file: File): Promise<string> => {
    const safe = file.name.replace(/[^\w.\-]+/g, "_");
    const path = `${me.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
    const { error: upErr } = await supabase.storage.from("inner-circle").upload(path, file);
    if (upErr) throw upErr;
    return supabase.storage.from("inner-circle").getPublicUrl(path).data.publicUrl;
  };

  const submit = async () => {
    setError(null);
    if (kind === "status" && !body.trim()) return setError("Write something first.");
    if (kind !== "status" && files.length === 0) return setError("Add a file to upload.");
    setBusy(true);
    try {
      let media_url: string | null = null;
      let media_urls: string[] = [];
      let poster_url: string | null = null;
      let title: string | null = null;

      if (kind === "photo") {
        media_urls = await Promise.all(files.map(upload));
      } else if (kind === "reel") {
        media_url = await upload(files[0]);
        if (poster) poster_url = await upload(poster);
      } else if (kind === "pdf") {
        media_url = await upload(files[0]);
        title = files[0].name;
      }

      const { error: rpcErr } = await supabase.rpc("create_inner_post", {
        p_kind: kind,
        p_body: body.trim() || null,
        p_media_url: media_url,
        p_media_urls: media_urls,
        p_poster_url: poster_url,
        p_title: title,
      });
      if (rpcErr) throw rpcErr;
      onPosted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold text-navy">
            <Sparkles className="h-5 w-5 text-gold-deep" /> New post
          </h2>
          <button onClick={onClose} className="text-medium hover:text-navy"><X className="h-5 w-5" /></button>
        </div>

        {/* Kind picker */}
        <div className="mt-4 grid grid-cols-4 gap-1 rounded-xl border border-[#E4DCCB] bg-offwhite/60 p-1">
          {KINDS.map((k) => {
            const Icon = k.icon;
            const active = kind === k.id;
            return (
              <button
                key={k.id}
                onClick={() => { setKind(k.id); setFiles([]); setPoster(null); setError(null); }}
                className={`flex flex-col items-center gap-1 rounded-lg py-2 text-xs font-bold transition-colors ${
                  active ? "bg-primary text-cream" : "text-charcoal/60 hover:bg-ice"
                }`}
              >
                <Icon className="h-4 w-4" /> {k.label}
              </button>
            );
          })}
        </div>

        {/* Caption / text */}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={kind === "status" ? "Share an update with the circle…" : "Add a caption (optional)…"}
          rows={kind === "status" ? 4 : 2}
          className="mt-4 w-full resize-none rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-3 text-sm text-navy placeholder:text-medium focus:border-primary focus:outline-none"
        />

        {/* Media picker */}
        {kind !== "status" && (
          <div className="mt-3">
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              multiple={kind === "photo"}
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#C9BE9F] bg-offwhite/40 py-6 text-sm font-semibold text-charcoal/70 hover:bg-ice"
            >
              <ImagePlus className="h-5 w-5" />
              {files.length > 0
                ? `${files.length} file${files.length > 1 ? "s" : ""} selected`
                : kind === "photo" ? "Choose photos" : kind === "reel" ? "Choose a video" : "Choose a PDF"}
            </button>

            {kind === "reel" && (
              <>
                <input
                  ref={posterRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => setPoster(e.target.files?.[0] ?? null)}
                />
                <button
                  onClick={() => posterRef.current?.click()}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-[#E4DCCB] py-2.5 text-xs font-semibold text-charcoal/70 hover:bg-ice"
                >
                  <ImagePlus className="h-4 w-4" /> {poster ? "Cover selected" : "Add cover image (optional)"}
                </button>
              </>
            )}
          </div>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-[#E4DCCB] px-4 py-2.5 text-sm font-bold text-navy hover:bg-ice">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-cream transition hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Posting…</> : <>Publish</>}
          </button>
        </div>
      </div>
    </div>
  );
}
