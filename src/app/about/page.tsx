import { BUSINESS, CONTACT_EMAIL, PRODUCT } from "@/lib/publicInfo";
import {
  ArrowRight,
  BadgeDollarSign,
  Boxes,
  CircleCheck,
  ClipboardCheck,
  FileSpreadsheet,
  Handshake,
  Lock,
  Mail,
  Printer,
  RefreshCw,
  Scale,
  ScanBarcode,
  ShieldCheck,
  Sparkles,
  Store,
  Truck,
  Warehouse,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

// The app's public landing page (Cristian, 2026-10-19): Restock OS presented
// like a real software product, since it may become one. Signed-out
// visitors to / see this (proxy.ts rewrites it); signed-in staff get the
// dashboard.
//
// Keep it TRUE: it's in private use by Summit Trade Group LLC, not offered
// to other sellers (eBay API License; that would need eBay's review). So no
// sign-up, pricing, customer logos, testimonials or usage numbers. The UI
// mockups are drawn here with sample data, never real orders or buyers.

export const metadata: Metadata = {
  title: `${PRODUCT} · From pallet to sold, fast`,
  description: `${PRODUCT} is the operating system for liquidation resellers: check loads, list items fast with Rapid List, track every unit, and ship without mistakes.`,
};

export default function AboutPage() {
  return (
    <div className="w-full bg-white text-zinc-900">
      <Nav />
      <Hero />
      <Workflow />
      <RapidList />
      <FeatureGrid />
      <Floor />
      <Security />
      <ContactBand />
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm shadow-blue-900/30">
        <RefreshCw className="size-4" strokeWidth={2.5} color="white" aria-hidden />
      </span>
      <span className={`text-lg font-semibold tracking-tight ${dark ? "text-white" : "text-zinc-900"}`}>{PRODUCT}</span>
    </span>
  );
}

function Nav() {
  return (
    <header className="absolute inset-x-0 top-0 z-10">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo dark />
        <nav className="flex items-center gap-6 text-sm text-zinc-300">
          <a href="#how-it-works" className="hidden hover:text-white md:inline">
            How it works
          </a>
          <a href="#features" className="hidden hover:text-white md:inline">
            Features
          </a>
          <a href="#security" className="hidden hover:text-white md:inline">
            Security
          </a>
          <Link
            href="/login"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 font-medium text-white ring-1 ring-white/15 hover:bg-white/15"
          >
            <Lock className="size-4" aria-hidden />
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section className="relative overflow-hidden bg-zinc-950 pb-16 pt-28 text-white sm:pb-24 sm:pt-36">
      {/* Grid + glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.15]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgb(255 255 255 / 0.12) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / 0.12) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage: "radial-gradient(ellipse at 50% 0%, black 30%, transparent 75%)",
        }}
      />
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[900px] -translate-x-1/2 rounded-full bg-blue-600/30 blur-3xl" />

      <div className="relative mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-xs font-medium text-zinc-300 ring-1 ring-white/10">
            <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
            In daily use at {BUSINESS}
          </p>
          <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-6xl">
            From pallet to sold,{" "}
            <span className="bg-gradient-to-r from-blue-400 to-indigo-300 bg-clip-text text-transparent">fast.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-zinc-400">
            {PRODUCT} is the operating system for liquidation resellers. Check a load before you buy it, list items fast
            with Rapid List, track every unit down to the bin, and pick, pack and ship without mistakes.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(PRODUCT)}`}
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white shadow-lg shadow-blue-600/30 hover:bg-blue-500"
            >
              Get in touch
              <ArrowRight className="size-4" aria-hidden />
            </a>
            <a
              href="#how-it-works"
              className="inline-flex h-11 items-center rounded-lg px-5 text-sm font-semibold text-zinc-200 ring-1 ring-white/15 hover:bg-white/5"
            >
              See how it works
            </a>
          </div>
        </div>

        <div className="relative mx-auto mt-14 max-w-5xl sm:mt-20">
          <DashboardMockup />
        </div>
      </div>
    </section>
  );
}

// A drawn product screen (sample data). Looks like the app, isn't a
// screenshot of it.
function DashboardMockup() {
  return (
    <div className="rounded-2xl bg-white/5 p-2 ring-1 ring-white/10" role="img" aria-label={`${PRODUCT} dashboard, sample data`}>
      <div className="overflow-hidden rounded-xl bg-white text-zinc-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-zinc-300" />
          <span className="size-2.5 rounded-full bg-zinc-300" />
          <span className="size-2.5 rounded-full bg-zinc-300" />
          <span className="ml-3 hidden rounded-md bg-white px-3 py-0.5 text-[11px] text-zinc-400 ring-1 ring-zinc-200 sm:inline">
            {PRODUCT} · Dashboard
          </span>
        </div>
        <div className="grid sm:grid-cols-[180px_1fr]">
          <aside className="hidden border-r border-zinc-200 bg-zinc-50/60 p-3 sm:block">
            {["Dashboard", "Analyzer", "Rapid List", "Review", "Inventory", "Pick orders", "Reports"].map((label, i) => (
              <p
                key={label}
                className={`mb-0.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${i === 0 ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200" : "text-zinc-500"}`}
              >
                {label}
              </p>
            ))}
          </aside>

          <div className="p-4 sm:p-5">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold">This week</p>
              <p className="text-[11px] text-zinc-400">Sample data</p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Listed", "184", "+32"],
                ["Sold", "126", "+18"],
                ["Profit", "$2,418", "+12%"],
                ["To ship", "9", "today"],
              ].map(([k, v, d]) => (
                <div key={k} className="rounded-lg border border-zinc-200 p-2.5">
                  <p className="text-[11px] text-zinc-500">{k}</p>
                  <p className="mt-0.5 text-lg font-semibold tabular-nums">{v}</p>
                  <p className="text-[10px] font-medium text-emerald-600">{d}</p>
                </div>
              ))}
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
              <div className="rounded-lg border border-zinc-200 p-3">
                <p className="text-xs font-medium text-zinc-500">Sales by day</p>
                <div className="mt-3 flex h-24 items-end gap-1.5">
                  {[38, 52, 44, 70, 58, 86, 74, 62, 90, 78, 96, 84].map((h, i) => (
                    <span key={i} className="flex-1 rounded-t bg-gradient-to-t from-blue-600 to-indigo-400" style={{ height: `${h}%` }} />
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-200 p-3">
                <p className="text-xs font-medium text-zinc-500">Loads</p>
                {[
                  ["Health & beauty pallet", "92% listed", "bg-emerald-500"],
                  ["Home goods truckload", "61% listed", "bg-blue-500"],
                  ["Toys mixed lot", "Analyzing", "bg-amber-500"],
                ].map(([name, status, dot]) => (
                  <div key={name} className="mt-2 flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
                      <span className="truncate">{name}</span>
                    </span>
                    <span className="shrink-0 text-zinc-500">{status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: FileSpreadsheet,
    title: "Analyze",
    body: "Upload a load's manifest before you bid. See what will sell, what won't, and what the load is really worth.",
  },
  {
    icon: ScanBarcode,
    title: "List",
    body: "Scan, weigh, snap photos. Rapid List drafts the listing and tells you the best pack size to sell it in.",
  },
  {
    icon: Warehouse,
    title: "Store",
    body: "Every unit gets a label and a bin. Know exactly what you have, where it is, and when it expires.",
  },
  {
    icon: Truck,
    title: "Ship",
    body: "Scan-verified picking, packing slips and label printing. The right item in the right box, every time.",
  },
];

function Workflow() {
  return (
    <section id="how-it-works" className="scroll-mt-8 py-20 sm:py-28">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <SectionIntro
          eyebrow="How it works"
          title="One workflow, from the dock to the doorstep"
          body={`Liquidation inventory is messy: mixed boxes, bad counts, hundreds of different products. ${PRODUCT} gives every unit a clear path.`}
        />
        <ol className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="relative rounded-2xl border border-zinc-200 bg-white p-6">
              <div className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-xl bg-blue-50 text-blue-600">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="text-sm font-semibold text-zinc-300 tabular-nums">0{i + 1}</span>
              </div>
              <h3 className="mt-5 font-semibold tracking-tight">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rapid List spotlight
// ---------------------------------------------------------------------------

function RapidList() {
  return (
    <section className="overflow-hidden bg-zinc-50 py-20 sm:py-28">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2">
        <div>
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600">
            <Zap className="size-4" aria-hidden />
            Rapid List
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Scan it. Weigh it. It&apos;s listed.</h2>
          <p className="mt-4 text-lg leading-relaxed text-zinc-600">
            The listing station does the slow parts for you, so your team spends its time moving product, not typing.
          </p>
          <ul className="mt-8 space-y-4">
            {[
              ["Worth listing?", "A quick check on demand and resale value says sell it, bundle it, or set it aside."],
              ["Best pack size", "Singles or 3-packs? It weighs shipping costs against how fast each size sells."],
              ["Drafted for you", "Titles, descriptions, categories and item details written from your photos."],
              ["Weight from the scale", "A USB scale fills in the shipping weight, and the item label prints itself."],
            ].map(([t, b]) => (
              <li key={t} className="flex gap-3">
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-blue-600" aria-hidden />
                <p className="text-sm leading-relaxed text-zinc-600">
                  <span className="block font-semibold text-zinc-900">{t}</span>
                  {b}
                </p>
              </li>
            ))}
          </ul>
        </div>
        <ScanCardMockup />
      </div>
    </section>
  );
}

function ScanCardMockup() {
  return (
    <div className="relative mx-auto w-full max-w-md" role="img" aria-label="Rapid List scan card, sample item">
      <div aria-hidden className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-blue-200/60 to-indigo-200/40 blur-2xl" />
      <div className="relative rounded-2xl border border-zinc-200 bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-500">Rapid List · Station 1</p>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200">
            <Scale className="size-3" aria-hidden />
            7.4 oz steady
          </span>
        </div>
        <div className="mt-4 flex gap-3">
          <div className="grid size-16 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-zinc-100 to-zinc-200">
            <Boxes className="size-7 text-zinc-400" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="font-semibold leading-snug">Sample Daily Moisture Lotion, Unscented, 8 oz</p>
            <p className="mt-0.5 font-mono text-xs text-zinc-400">Sample item</p>
          </div>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-50 p-3 ring-1 ring-emerald-200">
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-emerald-900">OK to sell</p>
            <p className="text-xs text-emerald-800/80">Steady demand · about $9 each</p>
          </div>
        </div>
        <div className="mt-3 rounded-xl bg-blue-50 p-3 ring-1 ring-blue-200">
          <p className="text-sm font-semibold text-blue-950">Sell as 3-packs</p>
          <p className="mt-0.5 text-xs leading-relaxed text-blue-900/80">
            Everyday item: a 3-pack gives buyers a deal and ships for the same label. 7 on hand: 2 listings of 3-packs, 1 to set
            aside.
          </p>
        </div>
        <div className="mt-4 flex gap-2">
          <span className="inline-flex h-9 flex-1 items-center justify-center rounded-lg bg-blue-600 text-sm font-semibold text-white">
            Fill in 2 × 3-pack
          </span>
          <span className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-600 ring-1 ring-zinc-200">
            <Printer className="size-4" aria-hidden />
            Label
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: FileSpreadsheet,
    title: "Load Analyzer",
    body: "Reads supplier manifests line by line and flags slow sellers and duds before you spend a dollar.",
  },
  {
    icon: Warehouse,
    title: "Bins & shelves",
    body: "Barcoded labels for every unit, bin and shelf. Move, merge and count stock by scanning.",
  },
  {
    icon: ClipboardCheck,
    title: "Scan-verified picking",
    body: "Pickers scan each item against its order. Wrong item? The handheld says so before it's packed.",
  },
  {
    icon: Printer,
    title: "One-scan shipping labels",
    body: "Buy labels in bulk, upload the PDF, then scan a box's slip and its label prints.",
  },
  {
    icon: Store,
    title: "Multichannel",
    body: "Sell on eBay, your own Shopify store and Whatnot, with stock counts kept in step.",
  },
  {
    icon: Handshake,
    title: "Offers & promotions",
    body: "Answer buyer offers, send offers to watchers and run markdowns from one place.",
  },
  {
    icon: BadgeDollarSign,
    title: "True profit per load",
    body: "Every sale is matched to what you paid, after fees, labels and refunds. Know which loads paid off.",
  },
  {
    icon: Sparkles,
    title: "Gets smarter as you sell",
    body: "Your own sales teach it which products and pack sizes move, so its calls keep improving.",
  },
];

function FeatureGrid() {
  return (
    <section id="features" className="scroll-mt-8 py-20 sm:py-28">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <SectionIntro
          eyebrow="Features"
          title="Everything a resale operation runs on"
          body="One system instead of spreadsheets, sticky notes and five browser tabs."
        />
        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-200 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-white p-6">
              <Icon className="size-5 text-blue-600" aria-hidden />
              <h3 className="mt-4 font-semibold tracking-tight">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const GEAR: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Scale, title: "USB shipping scales", body: "Weight goes straight into the listing." },
  { icon: Printer, title: "Thermal label printers", body: "Item labels, bin labels and 4x6 slips print by themselves." },
  { icon: ScanBarcode, title: "Barcode scanners", body: "Handhelds and phone cameras for picking and counts." },
];

function Floor() {
  return (
    <section className="bg-zinc-950 py-20 text-white sm:py-24">
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <p className="text-sm font-semibold text-blue-400">Built for the warehouse floor</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Works with the gear you already have</h2>
          <p className="mt-4 text-lg leading-relaxed text-zinc-400">
            Stations run in the browser on any PC. Phones and handheld scanners do the walking.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {GEAR.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-2xl bg-white/5 p-5 ring-1 ring-white/10">
              <Icon className="size-5 text-blue-400" aria-hidden />
              <p className="mt-4 text-sm font-semibold">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-zinc-400">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Security() {
  return (
    <section id="security" className="scroll-mt-8 py-20 sm:py-28">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="grid gap-10 rounded-3xl border border-zinc-200 bg-gradient-to-br from-white to-zinc-50 p-6 sm:p-12 lg:grid-cols-[1fr_1.3fr]">
          <div>
            <span className="grid size-11 place-items-center rounded-xl bg-blue-50 text-blue-600">
              <ShieldCheck className="size-5" aria-hidden />
            </span>
            <h2 className="mt-5 text-2xl font-bold tracking-tight sm:text-3xl">Buyer data, handled with care</h2>
            <p className="mt-3 leading-relaxed text-zinc-600">
              {PRODUCT} only touches what it needs to ship an order, and lets go of it as soon as it can.
            </p>
            <Link href="/privacy" className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-500">
              Read the privacy policy
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2">
            {[
              ["Your own data only", "It manages your own listings, orders and sales."],
              ["Short-lived addresses", "Buyer addresses are deleted shortly after the label prints."],
              ["Account deletion", "Acts on eBay's account deletion notices automatically."],
              ["Never sold or shared", "No ads, no data brokers."],
              ["Personal sign-ins", "Every team member has their own account."],
              ["Owner-only money", "Costs, profit and settings stay with the owner."],
            ].map(([t, b]) => (
              <li key={t} className="flex gap-3">
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
                <p className="text-sm leading-relaxed text-zinc-600">
                  <span className="block font-semibold text-zinc-900">{t}</span>
                  {b}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ContactBand() {
  return (
    <section className="px-4 pb-20 sm:px-6 sm:pb-28">
      <div className="relative mx-auto w-full max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-blue-600 to-indigo-700 px-6 py-14 text-center text-white sm:px-12">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full bg-white/10 blur-2xl" />
        <h2 className="relative text-3xl font-bold tracking-tight sm:text-4xl">Run a resale operation?</h2>
        <p className="relative mx-auto mt-3 max-w-xl text-blue-100">
          {PRODUCT} is in private use at {BUSINESS} and isn&apos;t open to other sellers yet. We&apos;d still love to hear
          how you work.
        </p>
        <a
          href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(PRODUCT)}`}
          className="relative mt-8 inline-flex h-11 max-w-full items-center gap-2 rounded-lg bg-white px-5 text-sm font-semibold text-blue-700 shadow-lg hover:bg-blue-50"
        >
          <Mail className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{CONTACT_EMAIL}</span>
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-zinc-200">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-xs">by {BUSINESS}</span>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/privacy" className="hover:text-zinc-900">
            Privacy
          </Link>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-zinc-900">
            Contact
          </a>
          <Link href="/login" className="hover:text-zinc-900">
            Sign in
          </Link>
          <span>
            © {new Date().getFullYear()} {BUSINESS}
          </span>
        </nav>
      </div>
    </footer>
  );
}

function SectionIntro({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold text-blue-600">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>
      <p className="mt-4 text-lg leading-relaxed text-zinc-600">{body}</p>
    </div>
  );
}
