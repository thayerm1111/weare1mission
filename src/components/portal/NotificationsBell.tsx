"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell, X, Heart, MessageCircle, Radio, LineChart, Sparkles, CheckCheck,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Notif = {
  id: string;
  type: "like" | "comment" | "call" | "trade" | "system";
  title: string | null;
  body: string | null;
  link: string | null;
  read: boolean;
  created_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_username: string | null;
  actor_avatar: string | null;
};

type Filter = "all" | "inner" | "calls" | "trades";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "inner", label: "Inner Circle" },
  { id: "calls", label: "Calls" },
  { id: "trades", label: "Trades" },
];

const GRADS = [
  "from-[#B8862F] to-[#7a5417]", "from-[#3a6ea5] to-[#1f3f66]",
  "from-[#7a4fb5] to-[#452a6b]", "from-[#0f8a6d] to-[#0a5a47]", "from-[#c0574b] to-[#7d332a]",
];
function gradFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADS[h % GRADS.length];
}
function initials(name: string | null) {
  const p = (name || "1M").trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "1M";
}
function timeAgo(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const dd = Math.floor(h / 24);
  return dd < 7 ? `${dd}d` : `${Math.floor(dd / 7)}w`;
}

const TYPE_ICON = { call: Radio, trade: LineChart, system: Sparkles } as const;
const TYPE_TINT: Record<string, string> = {
  like: "bg-[#fdeceb] text-[#b5382f]",
  comment: "bg-ice text-navy",
  call: "bg-[#e6f0ff] text-[#3a6ea5]",
  trade: "bg-[#e1f5ee] text-[#0f6e56]",
  system: "bg-[#faeeda] text-gold-deep",
};

export function NotificationsBell() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const refreshCount = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.rpc("notif_unread_count");
    if (typeof data === "number") setUnread(data);
  }, [supabase]);

  const loadList = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data } = await supabase.rpc("get_notifications");
    setItems((data as Notif[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refreshCount();
    const t = setInterval(refreshCount, 30000);
    return () => clearInterval(t);
  }, [refreshCount]);

  useEffect(() => {
    if (open) { loadList(); document.body.style.overflow = "hidden"; }
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open, loadList]);

  const markAll = async () => {
    if (!supabase) return;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    await supabase.rpc("mark_all_notifs_read");
  };

  const openItem = async (n: Notif) => {
    if (supabase && !n.read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      await supabase.rpc("mark_notif_read", { target: n.id });
    }
    setOpen(false);
    if (n.link) router.push(n.link);
  };

  const shown = items.filter((n) =>
    filter === "all" ? true :
    filter === "inner" ? (n.type === "like" || n.type === "comment") :
    filter === "calls" ? n.type === "call" :
    n.type === "trade"
  );

  const line = (n: Notif) => {
    const who = n.actor_name ?? n.actor_username ?? "Someone";
    if (n.type === "like") return `${who} liked your post`;
    if (n.type === "comment") return `${who} commented on your post`;
    return n.title ?? "Notification";
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Notifications"
        className="relative grid h-10 w-10 place-items-center rounded-full border border-[#E4DCCB] bg-offwhite text-navy transition hover:bg-ice"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid h-5 min-w-[20px] place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-cream">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* Slide-in panel */}
      <div className={`fixed inset-0 z-[70] ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
        <div
          className={`absolute inset-0 bg-black/30 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}
          onClick={() => setOpen(false)}
        />
        <aside
          className={`absolute right-0 top-0 flex h-full w-[400px] max-w-[92vw] flex-col border-l border-[#E4DCCB] bg-cream shadow-2xl transition-transform duration-300 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
          role="dialog"
          aria-label="Notifications"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#E4DCCB] px-5 py-4">
            <h2 className="text-lg font-extrabold tracking-tight text-navy">Notifications</h2>
            <div className="flex items-center gap-1">
              <button
                onClick={markAll}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold text-charcoal/70 hover:bg-ice"
              >
                <CheckCheck className="h-4 w-4" /> Mark all read
              </button>
              <button onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-full text-medium hover:bg-ice" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Filters */}
          <div className="flex gap-1.5 overflow-x-auto border-b border-[#E4DCCB] px-4 py-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`flex-shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  filter === f.id ? "bg-primary text-cream" : "bg-offwhite text-charcoal/60 hover:bg-ice"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <p className="px-5 py-10 text-center text-sm text-medium">Loading…</p>
            ) : shown.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <Bell className="mx-auto h-8 w-8 text-[#C9BE9F]" />
                <p className="mt-3 text-sm font-semibold text-navy">You&apos;re all caught up</p>
                <p className="mt-1 text-xs text-medium">
                  {filter === "calls" ? "Calls you're subscribed to will appear here."
                    : filter === "trades" ? "Trades you're watching will appear here."
                    : filter === "inner" ? "Likes and comments on your posts land here."
                    : "New activity will show up here."}
                </p>
              </div>
            ) : (
              <ul>
                {shown.map((n) => {
                  const Icon = TYPE_ICON[n.type as keyof typeof TYPE_ICON];
                  const showAvatar = (n.type === "like" || n.type === "comment") && n.actor_id;
                  return (
                    <li key={n.id}>
                      <button
                        onClick={() => openItem(n)}
                        className={`flex w-full gap-3 border-b border-[#EFE7D6] px-5 py-3.5 text-left transition-colors hover:bg-offwhite/70 ${n.read ? "" : "bg-[#FBF4E6]"}`}
                      >
                        {/* icon / avatar */}
                        <div className="relative flex-shrink-0">
                          {showAvatar ? (
                            n.actor_avatar ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={n.actor_avatar} alt="" className="h-10 w-10 rounded-full object-cover" />
                            ) : (
                              <span className={`grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br text-sm font-extrabold text-cream ${gradFor(n.actor_id ?? "x")}`}>
                                {initials(n.actor_name)}
                              </span>
                            )
                          ) : (
                            <span className={`grid h-10 w-10 place-items-center rounded-full ${TYPE_TINT[n.type]}`}>
                              {Icon ? <Icon className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
                            </span>
                          )}
                          {showAvatar && (
                            <span className={`absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full ring-2 ring-cream ${TYPE_TINT[n.type]}`}>
                              {n.type === "like" ? <Heart className="h-3 w-3" /> : <MessageCircle className="h-3 w-3" />}
                            </span>
                          )}
                        </div>
                        {/* text */}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm leading-snug text-navy">
                            <span className="font-bold">{line(n)}</span>
                          </p>
                          {n.body && <p className="mt-0.5 truncate text-xs text-charcoal/70">{n.type === "comment" ? `“${n.body}”` : n.body}</p>}
                          <p className="mt-1 text-[11px] font-medium text-medium">{timeAgo(n.created_at)}</p>
                        </div>
                        {!n.read && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-primary" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
