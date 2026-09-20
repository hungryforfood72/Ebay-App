// Creates a user account directly in the DB — needed at least once to
// bootstrap the very first owner account (there's no one logged in yet to
// create it through the app's own Settings > Users page). Also usable
// afterward for any account creation from the command line if that's ever
// easier than the UI.
//
//   npx tsx scripts/create-user.ts <username> <password> <owner|employee>
//
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

async function main() {
  const [username, password, role] = process.argv.slice(2);
  if (!username || !password || (role !== "owner" && role !== "employee")) {
    console.error("Usage: npx tsx scripts/create-user.ts <username> <password> <owner|employee>");
    process.exit(1);
  }

  const { PrismaClient } = await import("../src/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { hashPassword } = await import("../src/lib/auth");

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.error(`A user named "${username}" already exists.`);
    process.exit(1);
  }

  const { hash, salt } = await hashPassword(password);
  const user = await prisma.user.create({
    data: { username, passwordHash: hash, passwordSalt: salt, role },
  });
  console.log(`Created ${role} account "${user.username}" (id ${user.id}).`);

  await prisma.$disconnect();
}

main();
