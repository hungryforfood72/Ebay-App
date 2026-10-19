import { BUSINESS, CONTACT_EMAIL } from "@/lib/publicInfo";
import { Boxes, Lock, Mail, PackageCheck, ScanBarcode, ShieldCheck, Tags } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

// The app's public landing page (Cristian, 2026-10-19): what it is and who
// runs it, for eBay's developer program and anyone who finds the URL.
// Signed-out visitors to / see this (proxy.ts rewrites it); signed-in staff
// get the dashboard. Keep it true to what the app does, like /privacy.

export const metadata: Metadata = {
  title: `${BUSINESS} · Seller tools`,
  description: `The private tool ${BUSINESS} uses to list, sell and ship its own inventory.`,
};

const FEATURES = [
  {
    icon: ScanBarcode,
    title: "List our inventory",
    body: "Our team scans, weighs and photographs each item, then reviews and publishes the listing to our own eBay store.",
  },
  {
    icon: Tags,
    title: "Manage our listings and offers",
    body: "Keep stock counts, prices and promotions current, and answer the offers buyers send on our listings.",
  },
  {
    icon: PackageCheck,
    title: "Pick, pack and ship",
    body: "Every order is picked by scanning, so the right item goes in the right box, then packed and shipped on time.",
  },
  {
    icon: Boxes,
    title: "Keep our books straight",
    body: "Sales, fees, refunds and shipping costs are tracked against what we paid for our stock.",
  },
] as const;

export default function AboutPage() {
  return (
    <div className="w-full bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 py-5">
        <p className="font-semibold tracking-tight">{BUSINESS}</p>
        <Link
          href="/login"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium shadow-sm hover:bg-muted"
        >
          <Lock className="size-4" aria-hidden />
          Staff sign in
        </Link>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4">
        <section className="py-12 sm:py-20">
          <p className="text-sm font-medium text-primary">Seller tools</p>
          <h1 className="mt-2 max-w-2xl text-3xl font-bold tracking-tight sm:text-5xl">
            How we list, sell and ship our own inventory.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            {BUSINESS} buys liquidation and overstock goods and resells them online, including on eBay. This is the private
            tool our small team uses to run that work, from the shelf to the shipping label.
          </p>
          <p className="mt-6 inline-flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
            <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
            For our own stores only. It isn&apos;t offered to other sellers or the public.
          </p>
        </section>

        <section className="grid gap-4 pb-12 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
              <Icon className="size-6 text-primary" aria-hidden />
              <h2 className="mt-3 font-semibold tracking-tight">{title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>

        <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight">How we handle data</h2>
          <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-muted-foreground sm:grid-cols-2">
            <li>We only manage our own listings, orders and sales.</li>
            <li>Buyer details are used only to ship that buyer&apos;s order.</li>
            <li>Buyer addresses are deleted shortly after the shipping label prints.</li>
            <li>We act on eBay&apos;s account deletion notices.</li>
            <li>We never sell or share anyone&apos;s information.</li>
            <li>Every team member signs in with their own account.</li>
          </ul>
          <Link href="/privacy" className="mt-4 inline-block text-sm font-medium text-primary underline">
            Read our privacy policy
          </Link>
        </section>

        <section className="py-12">
          <h2 className="text-lg font-semibold tracking-tight">Contact</h2>
          <p className="mt-1 text-sm text-muted-foreground">Questions about this app or your information:</p>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary underline"
          >
            <Mail className="size-4" aria-hidden />
            {CONTACT_EMAIL}
          </a>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground">
          <p>
            © {new Date().getFullYear()} {BUSINESS}
          </p>
          <nav className="flex gap-4">
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link href="/login" className="hover:text-foreground">
              Staff sign in
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
