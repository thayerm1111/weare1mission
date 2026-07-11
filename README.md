# 1 Mission — Community Hub

**One Mission. One Community. One Movement.**

A premium team onboarding, education, events, resources, and community website for the
**1 Mission** community (weare1mission.com). Built as a real platform — not a landing page —
where members can learn about 1 Mission, complete onboarding, access affiliate training, view
the weekly schedule, join community calls, find resources, meet leadership, and track their
progress.

---

## Table of contents

1. [Project overview](#project-overview)
2. [Technology used](#technology-used)
3. [Install & run locally](#install--run-locally)
4. [Project structure](#project-structure)
5. [How to edit content (the important part)](#how-to-edit-content)
   - [Navigation](#edit-navigation)
   - [Onboarding steps](#edit-onboarding)
   - [Training modules](#edit-training)
   - [Weekly schedule](#edit-schedule)
   - [Events](#edit-events)
   - [Leaders](#edit-leaders)
   - [Resources / testimonials / contacts](#edit-other-data)
   - [Images](#replace-images)
   - [Video embeds](#video-embeds)
   - [Colors / brand](#change-colors)
   - [Logo](#update-logo)
   - [Social links](#social-links)
6. [Deploy to GitHub](#deploy-to-github)
7. [Deploy on Vercel](#deploy-on-vercel)
8. [Connect weare1mission.com from GoDaddy](#connect-domain-godaddy)
9. [Adding Supabase later](#adding-supabase-later)
10. [Before-launch checklist](#before-launch-checklist)

---

## Project overview

Version 1 is a fully static, fast, mobile-first site. Member onboarding and training progress
are tracked **locally in the browser** (localStorage) — no login or database required to launch.
The code is organized so a database (Supabase) can be added later without a rewrite.

**Pages:** Home, Start Here (onboarding), Affiliate Training, Weekly Schedule, Events, Resources,
Leadership, Shop (coming soon), Contact, Legal & Disclosures, plus a custom 404.

---

## Technology used

- **Next.js 14** (App Router) + **React 18**
- **TypeScript** (strict)
- **Tailwind CSS** (warm/editorial brand system in `tailwind.config.ts`)
- **lucide-react** icons
- **Supabase** (`@supabase/ssr`) — auth (magic link) + Postgres + row-level security for the member area
- **localStorage** for onboarding/training progress tracking
- Vercel- and GitHub-ready

---

## Install & run locally

**Prerequisites:** [Node.js](https://nodejs.org) 18.18+ (Node 20+ recommended) and npm.

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server
npm run dev
# open http://localhost:3000

# 3. Create a production build (optional — Vercel does this for you)
npm run build
npm run start
```

> **Note on fonts:** the site loads the Inter font via a stylesheet `<link>` in
> `src/app/layout.tsx` so it builds even on machines without internet. If you build offline you may
> see a harmless “Failed to download the stylesheet … Skipped optimizing this font” warning — the
> font still loads normally in the browser and on Vercel.

---

## Project structure

```
weare1mission/
├─ public/
│  ├─ images/              ← put real photos/logos here (see images/README.md)
│  └─ favicon.ico          ← replace the placeholder favicon
├─ src/
│  ├─ app/                 ← one folder per page (App Router)
│  │  ├─ layout.tsx        ← global shell, <head>, fonts, header/footer
│  │  ├─ page.tsx          ← Home
│  │  ├─ start-here/       ← onboarding (client progress logic)
│  │  ├─ training/         ← affiliate training (client progress logic)
│  │  ├─ schedule/ events/ resources/ leadership/ shop/ contact/ legal/
│  │  ├─ sitemap.ts robots.ts not-found.tsx
│  ├─ components/          ← reusable UI (Header, Footer, cards, forms, states…)
│  │  └─ home/             ← homepage sections
│  ├─ data/                ← ★ EDIT YOUR CONTENT HERE ★
│  └─ lib/                 ← helpers (progress hook, timezone, metadata)
├─ tailwind.config.ts      ← brand colors & design tokens
└─ README.md
```

**You will spend almost all your time in `src/data/`.** Those files are plain, heavily-commented
TypeScript — change the values and the site updates. You do not need to touch the components.

---

## How to edit content

All frequently-updated content lives in **`src/data/`**. Each file has comments explaining what to
change. After editing, save — the dev server hot-reloads instantly.

<a name="edit-navigation"></a>
### Navigation — `src/data/navigation.ts`
Edit the `mainNav` array to add/remove/rename top-menu links, `primaryCta` for the “Join 1 Mission”
button, and `footerNav` for the grouped footer links.

<a name="edit-onboarding"></a>
### Onboarding steps — `src/data/onboarding.ts`
Edit `onboardingSteps`. Each step has a `phase`, `title`, `description`, and optional `videoUrl`,
`imageUrl`, `externalLink`, and `checklist`. Add or reorder steps freely. **Keep each step’s `id`
stable once members start** — changing an id resets that step’s saved progress. Phase names live in
`onboardingPhases`.

<a name="edit-training"></a>
### Training modules — `src/data/training.ts`
Edit `trainingModules`. Each module has a `category`, `title`, `description`, `estimatedTime`,
optional `videoUrl`, a written `lesson` (separate paragraphs with a blank line), `actionSteps`, and
optional `resources`. Categories are in `trainingCategories`. Keep `id`s stable once live.

<a name="edit-schedule"></a>
### Weekly schedule — `src/data/schedule.ts`
1. Set `sourceTimeZone` to your team’s base IANA timezone (e.g. `"America/New_York"`).
2. Edit `scheduleEvents`. Store each `time` in 24-hour `"HH:MM"` **in that source timezone** — the
   site automatically converts it to each visitor’s local time.
   Set `accessLevel` (`Public`/`Members Only`), `category`, and any `zoomLink`/`telegramLink`/
   `registrationLink`. Set `isPlaceholder: false` to remove the “editable placeholder” tag.

<a name="edit-events"></a>
### Events — `src/data/events.ts`
Edit `events`. Use an ISO `startDate` (e.g. `"2026-10-17T09:00"`) so the countdown works, plus a
friendly `displayDate`. Set `type` (Online / Local / Leadership Retreat / Convention) and `status`
(Registration Open / Coming Soon / Sold Out / Completed). `featured: true` shows it at the top.
Past-event photos go in `pastEventGallery`.

<a name="edit-leaders"></a>
### Leaders — `src/data/leadership.ts`
Edit `leaders`. Fill in real `name`, `position`, `location`, `bio`, `expertise`, social links, and
an optional `videoUrl`. **Do not invent ranks or accomplishments.** Add a photo path (see images)
and set `featured: true` to highlight. Leadership values are in `leadershipValues`.

<a name="edit-other-data"></a>
### Resources, testimonials, contacts
- **`src/data/resources.ts`** — the searchable library. Each item has a `category`, `type`, and a
  `download` and/or `externalLink`. Flags: `featured`, `membersOnly`, `recentlyAdded`.
- **`src/data/testimonials.ts`** — ⚠️ all placeholders. Replace with real, permission-granted
  quotes before launch. No income claims.
- **`src/data/contactInformation.ts`** — mentor/support/events/tech contact cards. Replace the
  placeholder emails, phones, and Telegram handles.
- **`src/data/siteSettings.ts`** — brand name, tagline, domain/URL, mission blurb, OG image,
  support email, and the logo.

<a name="replace-images"></a>
### Replace images
Until you add real files, every image shows a branded placeholder box automatically. To add real
images, drop files in **`public/images/`** and reference them from the relevant data file
(e.g. `image: "/images/leaders/leader-1.jpg"`). See `public/images/README.md` for the suggested
file list (logo, OG image, leaders, events, onboarding).

<a name="video-embeds"></a>
### Add video embeds
Anywhere a data file has a `videoUrl`, paste an **embed URL** (not the watch URL). Example for
YouTube: `https://www.youtube.com/embed/VIDEO_ID`. Leaving it empty shows a “video placeholder”.

<a name="change-colors"></a>
### Change colors / brand
All brand colors are defined once in **`tailwind.config.ts`** under `theme.extend.colors`
(navy, primary, medium, light, ice, offwhite, charcoal) and the gradients under `backgroundImage`.
Change them there and the whole site updates.

<a name="update-logo"></a>
### Update the logo
The header/footer show a text logo (`1 MISSION`) by default. To use a real transparent PNG:
1. Put your file at `public/images/logo.png`.
2. In `src/data/siteSettings.ts`, set `logoImage: "/images/logo.png"`.
The `Logo` component switches to the image automatically.

<a name="social-links"></a>
### Update social links
Edit **`src/data/socialLinks.ts`** — replace the `"#"` placeholders with your real Instagram,
Facebook, Telegram, YouTube, and TikTok URLs, and set `announcementChannel.href` to your Telegram
announcement channel. Any link left as `""` is hidden.

---

## Deploy to GitHub

```bash
# from the project folder
git init
git add .
git commit -m "Initial commit: 1 Mission website"
git branch -M main

# create an empty repo on github.com first (no README), then:
git remote add origin https://github.com/YOUR_USERNAME/weare1mission.git
git push -u origin main
```

`node_modules` and `.next` are already git-ignored.

---

## Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
2. **Add New → Project**, then **Import** your `weare1mission` repo.
3. Vercel auto-detects Next.js. Leave the defaults:
   - Framework Preset: **Next.js**
   - Build Command: `next build` (default)
   - Output: (managed by Vercel)
4. Click **Deploy**. You’ll get a live `*.vercel.app` URL in ~1 minute.
5. Every future `git push` to `main` auto-deploys.

**Environment variables:** the public site needs none. To enable the member area, add
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel → Settings → Environment
Variables, then redeploy (see “Member area & backend”).

---

## Connect weare1mission.com from GoDaddy

In **Vercel → your project → Settings → Domains**, add `weare1mission.com` (and `www.weare1mission.com`).
Vercel will show the exact records to add. Then in **GoDaddy → your domain → DNS**:

**Option A — point DNS at Vercel (keep domain at GoDaddy):**
- **A record** — Host `@` → Value `76.76.21.21`
- **CNAME** — Host `www` → Value `cname.vercel-dns.com`
- Remove any conflicting parking/forwarding records for `@` and `www`.

**Option B — use Vercel nameservers (Vercel manages DNS):**
- In GoDaddy → Nameservers → **Change** → Enter the two `ns#.vercel-dns.com` servers Vercel gives you.

DNS can take from a few minutes up to 48 hours to propagate. Vercel issues the HTTPS certificate
automatically once it detects the records. Follow the values Vercel shows you — they take
precedence over the examples above if different.

---

## Adding Supabase later

Onboarding/training progress still uses the browser (`src/lib/useProgress.ts`). The **member area
is already built on Supabase** — see the next section to turn it on.

---

## Member area & backend (Supabase)

The site has a full, gated **member portal** at `/portal` with magic-link sign-in and content that
unlocks by membership tier:

- **`/login`** — passwordless magic-link sign-in (enter email → click the link we email you).
- **`/portal`** — member dashboard (latest updates + upcoming sessions + quick links).
- **`/portal/trading`** — trading education library (tier-gated, education-only).
- **`/portal/live`** — live sessions (tier-gated, with join links).
- **`/portal/updates`** — team updates / announcements.
- **`/portal/account`** — profile, membership tier, sign out.

**Access model:** anyone can sign up; what they see is gated by **tier** (`starter` → `core` →
`elite`) and **role** (`member` / `admin`). Admins see everything. Tiers/roles are defined in
`src/lib/access.ts` and enforced both in the app and by Postgres **row-level security**.

**The public site works without any of this.** Until you add the two env vars, the member pages
show a friendly “almost ready” notice and the build still passes.

### One-time Supabase setup

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste all of **`supabase/schema.sql`** → **Run**. This creates the
   `profiles`, `team_updates`, `live_sessions`, and `trading_content` tables, the auto-profile
   trigger, RLS policies, and seed placeholder content.
3. **Project Settings → API** → copy the **Project URL** and the **anon public** key.
4. Add them as environment variables (locally in `.env.local`, and in Vercel → Settings → Env Vars):
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-public-key
   ```
5. **Authentication → URL Configuration**: set **Site URL** to your domain
   (e.g. `https://weare1mission.com`) and add `https://weare1mission.com/auth/callback` (and your
   Vercel preview URL) to **Redirect URLs**. Email magic links are enabled by default.
6. Redeploy. The member area goes live automatically.

### Managing members & content

- **Change someone’s tier/role:** Supabase → **Table editor → profiles** → edit their `tier`
  (`starter`/`core`/`elite`) or `role` (`member`/`admin`).
- **Post content:** add rows in **`team_updates`**, **`live_sessions`**, or **`trading_content`**.
  Set each item’s `required_tier` to control who sees it; set `published` to show/hide.
- **Make yourself admin:** sign in once (creates your profile), then set your `role` to `admin`.

### Where to extend later

- Content is currently managed from the Supabase dashboard. To build an in-app **admin editor**,
  add admin-only `insert`/`update` RLS policies and a protected `/portal/admin` page.
- File uploads (PDFs, videos) → Supabase **Storage** buckets.
- The auth guard lives in `src/middleware.ts` + `src/lib/supabase/middleware.ts`.

---

## Before-launch checklist

- [ ] Replace all **placeholder testimonials** (`data/testimonials.ts`) with real, approved quotes.
- [ ] Replace **leadership** names, photos, and bios (`data/leadership.ts`) — no invented ranks.
- [ ] Fill in real **contact details** (`data/contactInformation.ts`).
- [ ] Set real **social + Telegram links** (`data/socialLinks.ts`).
- [ ] Update the **schedule** to real times and links; set `sourceTimeZone`.
- [ ] Add real **events**, images, and registration links.
- [ ] Add real **resource** files/links; replace `"#"` placeholders.
- [ ] Add the real **logo** and **OG share image**; replace the **favicon**.
- [ ] ⚠️ **Have a qualified attorney review `src/app/legal/page.tsx`.** The legal text is a
      placeholder template, not legal advice.
- [ ] Confirm no income guarantees, fake stats, or guaranteed results anywhere.
- [ ] **Member area:** create the Supabase project, run `supabase/schema.sql`, set the two env
      vars, and configure Auth redirect URLs (see “Member area & backend”).
- [ ] Replace the **seed placeholder** member content (`team_updates`, `live_sessions`,
      `trading_content`) with real content.
- [ ] Make your own account an **admin** and set members’ tiers.

---

*Built for the 1 Mission community. Educational purposes only — trading involves risk, results
vary, and nothing here is individualized financial advice.*
