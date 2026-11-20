// Money from brand jobs: what's owed, how long it's been out, what came in.
import type { BrandJob } from "./types";

/** Unpaid this long reads as overdue. */
export const OVERDUE_DAYS = 30;

/** "€1,200", "$800", "1,200 THB". */
export function money(amount: number, currency: string | null | undefined): string {
  const c = currency || "EUR";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: c, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${c}`;
  }
}

/** Days since the invoice went out, or null when not sent / no date. */
export function invoiceAge(job: Pick<BrandJob, "invoiceStatus" | "invoiceSentDate">, now = new Date()): number | null {
  if (job.invoiceStatus !== "sent" || !job.invoiceSentDate) return null;
  // Calendar days, counted at noon so a daylight-saving change can't shave one off.
  const [y, m, d] = job.invoiceSentDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  const sent = new Date(y, m - 1, d, 12).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
  return Math.max(0, Math.round((today - sent) / 86_400_000));
}

/** Unpaid and paid-this-year totals, per currency. */
export function totals(jobs: BrandJob[], year = new Date().getFullYear()): { unpaid: [string, number][]; paidThisYear: [string, number][]; overdue: number } {
  const add = (m: Map<string, number>, j: BrandJob) => m.set(j.currency || "EUR", (m.get(j.currency || "EUR") ?? 0) + (j.amount ?? 0));
  const unpaid = new Map<string, number>();
  const paid = new Map<string, number>();
  let overdue = 0;
  for (const j of jobs) {
    if (j.invoiceStatus === "sent" && (invoiceAge(j) ?? 0) > OVERDUE_DAYS) overdue++;
    if (j.amount == null) continue;
    if (j.invoiceStatus === "sent") add(unpaid, j);
    if (j.invoiceStatus === "paid" && (j.paidDate ?? "").startsWith(String(year))) add(paid, j);
  }
  return { unpaid: [...unpaid], paidThisYear: [...paid], overdue };
}

/** One line for a sent invoice: "Biotherm: invoice 2026-014 · €1,200 · sent 34 days ago". */
export function invoiceLine(j: BrandJob): { text: string; overdue: boolean } {
  const age = invoiceAge(j);
  const bits = [`${j.client}: invoice${j.invoiceNo ? ` ${j.invoiceNo}` : ""} not paid yet`];
  if (j.amount != null) bits.push(money(j.amount, j.currency));
  if (age != null) bits.push(age === 0 ? "sent today" : `sent ${age} day${age === 1 ? "" : "s"} ago`);
  return { text: bits.join(" · "), overdue: (age ?? 0) > OVERDUE_DAYS };
}
