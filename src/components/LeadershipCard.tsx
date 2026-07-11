import { Instagram, Facebook, Send, MapPin } from "lucide-react";
import Link from "next/link";
import type { Leader } from "@/data/leadership";
import { PlaceholderImage } from "./PlaceholderImage";

export function LeadershipCard({ leader }: { leader: Leader }) {
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-2xl border border-ice bg-white shadow-card transition-shadow hover:shadow-cardhover">
      <PlaceholderImage label={`${leader.name} photo`} aspect="portrait" rounded="rounded-none" />
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-lg font-bold text-navy">{leader.name}</h3>
        <p className="text-sm font-semibold text-primary">{leader.position}</p>
        <p className="mt-1 flex items-center gap-1 text-xs text-charcoal/60">
          <MapPin className="h-3 w-3" aria-hidden="true" /> {leader.location}
          {leader.rank ? ` · ${leader.rank}` : ""}
        </p>
        <p className="mt-3 flex-1 text-sm leading-relaxed text-charcoal/70">{leader.bio}</p>

        {leader.expertise.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Areas of expertise">
            {leader.expertise.map((e) => (
              <li key={e} className="rounded-full bg-ice px-2.5 py-0.5 text-[11px] font-medium text-navy">
                {e}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-center gap-2 border-t border-ice pt-4">
          {leader.instagram && <Social href={leader.instagram} label={`${leader.name} on Instagram`}><Instagram className="h-4 w-4" /></Social>}
          {leader.facebook && <Social href={leader.facebook} label={`${leader.name} on Facebook`}><Facebook className="h-4 w-4" /></Social>}
          {leader.telegram && <Social href={leader.telegram} label={`${leader.name} on Telegram`}><Send className="h-4 w-4" /></Social>}
          <Link
            href="/contact"
            className="ml-auto text-sm font-semibold text-primary hover:text-medium"
          >
            View profile
          </Link>
        </div>
      </div>
    </article>
  );
}

function Social({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      aria-label={label}
      {...(href !== "#" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="grid h-8 w-8 place-items-center rounded-full bg-ice text-navy transition-colors hover:bg-primary hover:text-white focus-ring"
    >
      {children}
    </a>
  );
}
