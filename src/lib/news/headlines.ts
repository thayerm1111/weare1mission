/**
 * Breaking market headlines (server-only, keyless).
 *
 * Pulls a forex/gold/macro RSS feed and parses it with a tiny dependency-free reader
 * (no XML lib). Cached 5 min. Feeds the dashboard's live ticker + "Breaking" list.
 */

export type Headline = { title: string; url: string; source: string; at: string; ts: number };

const FEEDS: { url: string; source: string }[] = [
  { url: "https://investinglive.com/feed", source: "InvestingLive" },
];

const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; items: Headline[] } | null = null;

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#8217;/g, "’").replace(/&#8216;/g, "‘")
    .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? decode(m[1]) : "";
}

export async function fetchHeadlines(): Promise<Headline[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.items;

  const all: Headline[] = [];
  for (const f of FEEDS) {
    try {
      const r = await fetch(f.url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; OneMissionDesk/1.0)",
          accept: "application/rss+xml, application/xml, text/xml, */*",
        },
        cache: "no-store",
        redirect: "follow",
      });
      if (!r.ok) continue;
      const xml = await r.text();
      const blocks = xml.split(/<item[\s>]/i).slice(1);
      for (const raw of blocks.slice(0, 30)) {
        const title = tag(raw, "title");
        const link = tag(raw, "link");
        const pub = tag(raw, "pubDate");
        const ts = Date.parse(pub) || 0;
        if (title && ts) all.push({ title, url: link, source: f.source, at: pub, ts });
      }
    } catch { /* skip a bad feed */ }
  }

  all.sort((a, b) => b.ts - a.ts);
  const items = all.slice(0, 25);
  if (items.length) cache = { at: now, items };
  return items.length ? items : cache ? cache.items : [];
}
