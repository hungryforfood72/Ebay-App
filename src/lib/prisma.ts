import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Supabase's pooler allows 200 client connections in all, counting idle
// ones. On 2026-11-02 the Review page (one price check per card, 38 cards)
// plus everything else running hit it ("EMAXCONN max client connections
// reached"): every Vercel instance held up to 10, and idle ones stayed open
// while Vercel kept the instance paused. So idle ones close after 5s, and
// attachDatabasePool closes them before Vercel pauses the instance. (Still
// up to 10 while busy: fewer would make the sort/gather transactions wait.)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 5_000 });
if (process.env.VERCEL) attachDatabasePool(pool);

const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
