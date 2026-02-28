import Link from "next/link";
import faqData from "@/data/faq.json";
import { query } from "@/lib/db";
import { FaqAccordion } from "./faq-accordion";

export const dynamic = "force-dynamic";

async function getActionPrice(): Promise<number> {
  try {
    const res = await query(
      "SELECT value FROM operator_settings WHERE key = 'action_price_sats'"
    );
    const parsed = Number(res.rows[0]?.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
  } catch {
    return 3000;
  }
}

export default async function FaqPage() {
  const priceSats = await getActionPrice();
  const priceFormatted = priceSats.toLocaleString("en-US");

  const items = faqData.map((item) => ({
    ...item,
    answer: item.answer.replace(/\{\{PRICE\}\}/g, priceFormatted),
  }));

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="max-w-xl w-full">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-3 text-foreground">
            FAQ
          </h1>
          <p className="text-muted">
            The second rule: read the FAQ before asking.
          </p>
        </div>

        <FaqAccordion items={items} />

        <div className="text-center mt-10">
          <Link
            href="/dashboard"
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            &larr; Back
          </Link>
        </div>
      </div>
    </main>
  );
}
