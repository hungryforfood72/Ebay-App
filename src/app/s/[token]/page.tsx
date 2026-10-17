import type { Metadata } from "next";
import { SupplierReportView } from "./SupplierReportView";

// The consignment supplier's read-only report. Public by link (proxy.ts),
// no app chrome, and its own neutral title so nothing about the app or
// Sticker Peak shows in his browser tab or link preview.
export const metadata: Metadata = {
  title: "Consignment report",
  description: "Live sales and payments on your consigned stock.",
  robots: { index: false, follow: false },
};

export default async function SupplierReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SupplierReportView token={token} />;
}
