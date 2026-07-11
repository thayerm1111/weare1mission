import Link from "next/link";
import { Instagram, Facebook, Youtube, Send, Music2 } from "lucide-react";
import { siteSettings } from "@/data/siteSettings";
import { footerNav } from "@/data/navigation";
import { socialLinks } from "@/data/socialLinks";
import { Logo } from "./Logo";

const iconMap = {
  instagram: Instagram,
  facebook: Facebook,
  youtube: Youtube,
  telegram: Send,
  tiktok: Music2,
} as const;

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-navy text-light" aria-labelledby="footer-heading">
      <h2 id="footer-heading" className="sr-only">Footer</h2>
      <div className="container-1m py-14 lg:py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          {/* Brand */}
          <div>
            <Logo light />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-light/70">
              {siteSettings.shortMission}
            </p>
            <div className="mt-5 flex items-center gap-2">
              {socialLinks.map((s) => {
                const Icon = iconMap[s.platform];
                return (
                  <a
                    key={s.platform}
                    href={s.href}
                    aria-label={s.label}
                    {...(s.href !== "#" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-primary focus-ring"
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </a>
                );
              })}
            </div>
          </div>

          <FooterCol title="Quick Links" items={footerNav.quickLinks} />
          <FooterCol title="Member Area" items={footerNav.trainingLinks} />
          <div>
            <FooterCol title="Community" items={footerNav.communityLinks} />
            <h3 className="mt-6 text-sm font-bold uppercase tracking-wider text-white">Legal</h3>
            <ul className="mt-3 space-y-2">
              {footerNav.legalLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-light/70 hover:text-white">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 border-t border-white/10 pt-6">
          <p className="text-xs leading-relaxed text-light/60">
            For educational purposes only. Trading involves risk, including the possible loss of
            capital. Past performance does not guarantee future results. Nothing on this site is
            individualized financial advice. Income and business results vary and are not
            guaranteed. See our{" "}
            <Link href="/legal" className="underline hover:text-white">disclosures</Link> for full details.
          </p>
          <div className="mt-4 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
            <p className="text-xs text-light/60">
              © {year} {siteSettings.brandName}. All rights reserved.
            </p>
            <div className="flex flex-wrap gap-4 text-xs text-light/60">
              <Link href="/legal#privacy-policy" className="hover:text-white">Privacy</Link>
              <Link href="/legal#terms-of-use" className="hover:text-white">Terms</Link>
              <Link href="/legal#trading-risk-disclosure" className="hover:text-white">Risk Disclosure</Link>
              <Link href="/legal#earnings-disclaimer" className="hover:text-white">Earnings Disclaimer</Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, items }: { title: string; items: { label: string; href: string }[] }) {
  return (
    <div>
      <h3 className="text-sm font-bold uppercase tracking-wider text-white">{title}</h3>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="text-sm text-light/70 hover:text-white">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
