import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">eBay Listing Tool</h1>
      <p className="text-sm text-gray-500">
        Scan on the shop floor, review and export from anywhere.
      </p>
      <div className="flex w-full flex-col gap-3">
        <Link
          href="/scan"
          className="rounded-lg bg-black px-4 py-3 text-white"
        >
          Scan items
        </Link>
        <Link
          href="/review"
          className="rounded-lg border px-4 py-3"
        >
          Review queue
        </Link>
      </div>
    </main>
  );
}
