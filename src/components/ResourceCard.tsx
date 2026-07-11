import { FileText, Video, LinkIcon, LayoutTemplate, ListChecks, Smartphone, MessageSquareText, ImageIcon, Download, ArrowUpRight, Lock, Star } from "lucide-react";
import type { ResourceItem } from "@/data/resources";

const typeIcon = {
  Document: FileText,
  Video: Video,
  Link: LinkIcon,
  Template: LayoutTemplate,
  Tracker: ListChecks,
  App: Smartphone,
  Script: MessageSquareText,
  Image: ImageIcon,
} as const;

export function ResourceCard({ r }: { r: ResourceItem }) {
  const Icon = typeIcon[r.type];
  const href = r.download || r.externalLink || "#";
  const isDownload = Boolean(r.download);
  return (
    <article className="group relative flex h-full flex-col rounded-2xl border border-ice bg-white p-5 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-cardhover">
      <div className="flex items-start justify-between">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-ice text-primary" aria-hidden="true">
          <Icon className="h-5 w-5" />
        </span>
        <div className="flex gap-1.5">
          {r.featured && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
              <Star className="h-3 w-3" aria-hidden="true" /> Featured
            </span>
          )}
          {r.membersOnly && (
            <span className="inline-flex items-center gap-1 rounded-full bg-navy/10 px-2 py-0.5 text-[11px] font-semibold text-navy">
              <Lock className="h-3 w-3" aria-hidden="true" /> Members
            </span>
          )}
        </div>
      </div>
      <h3 className="mt-4 text-base font-bold text-navy">{r.title}</h3>
      <p className="mt-1 flex-1 text-sm leading-relaxed text-charcoal/70">{r.description}</p>
      <div className="mt-4 flex items-center justify-between border-t border-ice pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-charcoal/50">{r.type}</span>
        <a
          href={href}
          {...(r.externalLink && !r.download ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-medium"
        >
          {isDownload ? (<><Download className="h-4 w-4" aria-hidden="true" /> Download</>) : (<>Open <ArrowUpRight className="h-4 w-4" aria-hidden="true" /></>)}
        </a>
      </div>
    </article>
  );
}
