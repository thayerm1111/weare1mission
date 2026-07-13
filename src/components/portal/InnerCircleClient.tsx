"use client";

import { useMemo, useState } from "react";
import {
  Search, BadgeCheck, ArrowLeft, UserPlus, Check, MessageSquare,
  Grid3x3, Clapperboard, FileText, Heart, MessageCircle, Play, Download,
} from "lucide-react";

/* ---------------- types + sample data (Phase 1) ---------------- */

type Creator = {
  id: string;
  name: string;
  handle: string;
  verified?: boolean;
  headline: string;
  bio: string[];
  followers: string;
  following: string;
  posts: number;
};

// Only creators with real access right now.
const CREATORS: Creator[] = [
  { id: "matt", name: "Matthew Thayer", handle: "matthewthayer", verified: true, headline: "1M Co-Founder · Pro Arena QB", bio: ["1 tap, 1 mission, unlimited potential", "1M Co-Founder", "Pro Arena QB", "Father, Husband"], followers: "963K", following: "2,754", posts: 542 },
  { id: "joey", name: "Joey", handle: "joey", verified: true, headline: "1M Co-Founder", bio: ["1M Co-Founder", "Building the movement"], followers: "—", following: "—", posts: 0 },
];

const img = (seed: string, s = 500) => `https://picsum.photos/seed/${seed}/${s}/${s}`;
const avatar = (id: string, s = 200) => `https://picsum.photos/seed/${id}-av/${s}/${s}`;

const REELS_VIEWS = ["12.4K", "8.1K", "31.9K", "4.7K", "19.2K", "6.6K"];
const FILES = [
  { name: "Gold Playbook 2026.pdf", size: "2.4 MB" },
  { name: "Risk Management Guide.pdf", size: "1.1 MB" },
  { name: "Session Recap — London.pdf", size: "3.8 MB" },
];

function statusesFor(id: string) {
  return [
    { text: "Locked in for the London open — watching 4120 on gold. Patience today. 🧠", time: "2h", likes: 214, comments: 18 },
    { text: "Reminder: your risk plan is the trade. Everything else is noise.", time: "1d", likes: 401, comments: 33 },
    { text: `New breakdown dropping in The Room tonight. Bring questions. (${id})`, time: "3d", likes: 156, comments: 27 },
  ];
}

/* ---------------- component ---------------- */

export function InnerCircleClient(_props: { me?: { id: string; name: string | null; isCreator: boolean } }) {
  const [selected, setSelected] = useState<Creator | null>(null);
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState<Set<string>>(new Set<string>());

  const toggleFollow = (id: string) =>
    setFollowing((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CREATORS;
    return CREATORS.filter(
      (c) => c.name.toLowerCase().includes(q) || c.handle.toLowerCase().includes(q) || c.headline.toLowerCase().includes(q)
    );
  }, [query]);

  if (selected) {
    return (
      <Profile
        creator={selected}
        isFollowing={following.has(selected.id)}
        onFollow={() => toggleFollow(selected.id)}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="eyebrow">Community</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-navy">The Inner Circle</h1>
        <p className="mt-2 text-charcoal/70">Search creators, follow them, and see everything they share.</p>
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
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((c) => {
          const isF = following.has(c.id);
          return (
            <div key={c.id} className="flex flex-col rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
              <button onClick={() => setSelected(c)} className="flex items-center gap-3 text-left">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={avatar(c.id)} alt={c.name} className="h-14 w-14 rounded-full object-cover" />
                <div className="min-w-0">
                  <p className="flex items-center gap-1 font-bold text-navy">
                    <span className="truncate">{c.name}</span>
                    {c.verified && <BadgeCheck className="h-4 w-4 flex-shrink-0 text-gold-deep" />}
                  </p>
                  <p className="truncate text-xs text-medium">@{c.handle}</p>
                  <p className="truncate text-xs text-charcoal/60">{c.headline}</p>
                </div>
              </button>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-medium">
                  <span className="font-semibold text-navy">{c.followers}</span> followers
                </span>
                <button
                  onClick={() => toggleFollow(c.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-colors ${
                    isF ? "border border-[#E4DCCB] text-charcoal/70 hover:bg-ice" : "bg-primary text-cream hover:opacity-90"
                  }`}
                >
                  {isF ? <><Check className="h-3.5 w-3.5" /> Following</> : <><UserPlus className="h-3.5 w-3.5" /> Follow</>}
                </button>
              </div>
            </div>
          );
        })}
        {list.length === 0 && (
          <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-6 text-sm text-charcoal/60 sm:col-span-2 xl:col-span-3">
            No creators match “{query}”.
          </p>
        )}
      </div>
    </div>
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
  creator, isFollowing, onFollow, onBack,
}: {
  creator: Creator; isFollowing: boolean; onFollow: () => void; onBack: () => void;
}) {
  const [tab, setTab] = useState<TabId>("posts");

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-semibold text-charcoal/70 hover:text-navy">
        <ArrowLeft className="h-4 w-4" /> Back to creators
      </button>

      {/* Header */}
      <div className="rounded-2xl border border-[#E4DCCB] bg-cream p-5 shadow-card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={avatar(creator.id, 240)} alt={creator.name} className="h-20 w-20 rounded-full object-cover sm:h-24 sm:w-24" />
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="flex items-center gap-1.5 text-xl font-extrabold tracking-tight text-navy">
                {creator.name}
                {creator.verified && <BadgeCheck className="h-5 w-5 text-gold-deep" />}
              </h1>
              <span className="text-sm text-medium">@{creator.handle}</span>
            </div>
            <div className="mt-2 flex gap-5 text-sm">
              <span><span className="font-bold text-navy">{creator.posts}</span> <span className="text-medium">posts</span></span>
              <span><span className="font-bold text-navy">{creator.followers}</span> <span className="text-medium">followers</span></span>
              <span><span className="font-bold text-navy">{creator.following}</span> <span className="text-medium">following</span></span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onFollow}
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold transition-colors ${
                isFollowing ? "border border-[#E4DCCB] text-charcoal/70 hover:bg-ice" : "bg-primary text-cream hover:opacity-90"
              }`}
            >
              {isFollowing ? <><Check className="h-4 w-4" /> Following</> : <><UserPlus className="h-4 w-4" /> Follow</>}
            </button>
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-[#E4DCCB] px-4 py-2 text-sm font-bold text-navy hover:bg-ice">
              <MessageSquare className="h-4 w-4" /> Message
            </button>
          </div>
        </div>
        <div className="mt-3 space-y-0.5">
          {creator.bio.map((b, i) => (
            <p key={i} className="text-sm text-charcoal/80">• {b}</p>
          ))}
        </div>
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

      {tab === "posts" && <Posts id={creator.id} />}
      {tab === "status" && <StatusFeed creator={creator} />}
      {tab === "reels" && <Reels id={creator.id} />}
      {tab === "files" && <Files />}
    </div>
  );
}

function Posts({ id }: { id: string }) {
  const seeds = Array.from({ length: 9 }, (_, i) => `${id}-p-${i}`);
  return (
    <div className="grid grid-cols-3 gap-1.5 sm:gap-2.5">
      {seeds.map((s, i) => (
        <button key={s} className="group relative aspect-square overflow-hidden rounded-lg bg-ice">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img(s, 400)} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
          <div className="absolute inset-0 flex items-center justify-center gap-4 bg-black/40 text-sm font-bold text-white opacity-0 transition group-hover:opacity-100">
            <span className="inline-flex items-center gap-1"><Heart className="h-4 w-4 fill-white" /> {120 + i * 37}</span>
            <span className="inline-flex items-center gap-1"><MessageCircle className="h-4 w-4 fill-white" /> {6 + i * 3}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function StatusFeed({ creator }: { creator: Creator }) {
  return (
    <div className="space-y-3">
      {statusesFor(creator.id).map((s, i) => (
        <article key={i} className="rounded-2xl border border-[#E4DCCB] bg-cream p-4 shadow-card">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={avatar(creator.id)} alt="" className="h-9 w-9 rounded-full object-cover" />
            <div>
              <p className="text-sm font-bold text-navy">{creator.name}</p>
              <p className="text-xs text-medium">{s.time} ago</p>
            </div>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-charcoal/85">{s.text}</p>
          <div className="mt-3 flex gap-5 border-t border-[#E4DCCB] pt-3 text-sm text-medium">
            <span className="inline-flex items-center gap-1.5"><Heart className="h-4 w-4" /> {s.likes}</span>
            <span className="inline-flex items-center gap-1.5"><MessageCircle className="h-4 w-4" /> {s.comments}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function Reels({ id }: { id: string }) {
  const seeds = Array.from({ length: 6 }, (_, i) => `${id}-r-${i}`);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {seeds.map((s, i) => (
        <button key={s} className="group relative aspect-[9/16] overflow-hidden rounded-xl bg-ice">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`https://picsum.photos/seed/${s}/300/520`} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/25 backdrop-blur transition group-hover:scale-110">
              <Play className="ml-0.5 h-5 w-5 fill-white text-white" />
            </span>
          </div>
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 text-xs font-semibold text-white [text-shadow:0_1px_2px_rgba(0,0,0,.6)]">
            <Play className="h-3 w-3 fill-white" /> {REELS_VIEWS[i]}
          </span>
        </button>
      ))}
    </div>
  );
}

function Files() {
  return (
    <div className="space-y-2">
      {FILES.map((f, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-[#E4DCCB] bg-cream p-3.5 shadow-card">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ice text-primary">
            <FileText className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-navy">{f.name}</p>
            <p className="text-xs text-medium">PDF · {f.size}</p>
          </div>
          <button className="inline-flex items-center gap-1.5 rounded-lg border border-[#E4DCCB] px-3.5 py-1.5 text-xs font-bold text-navy hover:bg-ice">
            <Download className="h-3.5 w-3.5" /> Open
          </button>
        </div>
      ))}
    </div>
  );
}
