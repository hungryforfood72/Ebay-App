import nodemailer from "nodemailer";

// Customer email from the Epic Steals Gmail (first use: the delivered-with-
// photo email). Gmail SMTP with an app password, both Vercel env vars that
// Cristian sets himself:
//   EPIC_STEALS_GMAIL_USER          the Gmail address it sends from
//   EPIC_STEALS_GMAIL_APP_PASSWORD  Google Account > Security > App passwords
// Replies go back to that inbox.

export function mailerConfigured(): boolean {
  return Boolean(process.env.EPIC_STEALS_GMAIL_USER && process.env.EPIC_STEALS_GMAIL_APP_PASSWORD);
}

let transport: nodemailer.Transporter | null = null;

export async function sendEmail(message: { to: string; subject: string; html: string; text: string }): Promise<void> {
  const user = process.env.EPIC_STEALS_GMAIL_USER;
  const pass = process.env.EPIC_STEALS_GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Email isn't set up: add EPIC_STEALS_GMAIL_USER and EPIC_STEALS_GMAIL_APP_PASSWORD in Vercel.");
  transport ??= nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await transport.sendMail({ from: `"Epic Steals" <${user}>`, ...message });
}
