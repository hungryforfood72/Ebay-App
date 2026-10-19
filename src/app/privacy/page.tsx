import type { Metadata } from "next";

// The public privacy policy eBay's API License requires (sec. 8.2). Open
// signed-out (proxy.ts, exact path), no app chrome. Keep it true to what the
// app actually does: if data handling changes (new buyer data kept, a new
// service provider), update this page and EFFECTIVE in the same change.

const BUSINESS = "Summit Trade Group LLC";
const CONTACT = "summittradegroupllc@gmail.com";
const EFFECTIVE = "October 19, 2026";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${BUSINESS}'s internal selling tool handles data.`,
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 text-[15px] leading-relaxed text-foreground">
      <h1 className="text-2xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {BUSINESS} · Effective {EFFECTIVE}
      </p>

      <Section title="What this app is">
        <p>
          This is a private, internal tool that {BUSINESS} uses to run its own online stores, including its eBay seller
          account. Only our own staff can sign in. It isn&apos;t offered to the public or to other sellers. We use it to
          list our inventory, track our own sales, answer offers, and pick, pack and ship our orders.
        </p>
      </Section>

      <Section title="Information we use">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Our own listings and sales:</strong> titles, prices, quantities, order numbers, sale amounts, fees
            and refunds for items we sell.
          </li>
          <li>
            <strong>Buyer shipping details:</strong> the name and address on an order, which we need to ship it. These
            appear on our packing slips and shipping labels.
          </li>
          <li>
            <strong>Offers:</strong> offers buyers send on our listings, so we can accept, counter or decline them.
          </li>
          <li>
            <strong>Our own web store:</strong> for local delivery orders, the delivery name, address, phone and a photo
            of the drop-off; for shoppers who turn on deal alerts, a browser notification address (no name or email).
          </li>
        </ul>
        <p className="mt-2">
          We don&apos;t collect payment card details. eBay and our store platform handle payments.
        </p>
      </Section>

      <Section title="How we use it">
        <p>
          Only to sell and ship our own items: fulfilling orders, keeping our inventory and accounting accurate, and
          handling returns. We don&apos;t sell or rent anyone&apos;s information, we don&apos;t use it for advertising,
          and we don&apos;t share it with anyone except the service providers below, who run the app for us.
        </p>
      </Section>

      <Section title="How long we keep it">
        <ul className="list-disc space-y-1 pl-5">
          <li>Buyer addresses on packing slips are removed from our records as soon as the slip prints.</li>
          <li>
            Shipping label images (which show the buyer&apos;s address) are deleted 3 days after they print, or 10 days
            after upload if they never print. Their records are deleted after 30 days.
          </li>
          <li>Local delivery details are kept with the order so we can complete and confirm the delivery.</li>
          <li>Order numbers and sale amounts are kept for our business and tax records.</li>
        </ul>
      </Section>

      <Section title="eBay account deletion">
        <p>
          We receive eBay&apos;s marketplace account deletion notices. When eBay tells us a user has closed their account,
          we delete any information we hold about that user.
        </p>
      </Section>

      <Section title="Service providers">
        <p>
          The app runs on Vercel (hosting) and Supabase (database). It uses Anthropic&apos;s AI to help write listing
          text from product information; buyer information isn&apos;t sent to it.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Every staff member signs in with their own account and password, and all connections are encrypted. Access to
          financial and account settings is limited to the owner.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about this policy or your information: <a className="font-medium text-primary underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          We&apos;ll update this page if anything changes.
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}
