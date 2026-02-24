import Link from "next/link";
import faqData from "@/data/faq.json";
import { FaqAccordion } from "./faq-accordion";

export default function FaqPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-16">
      <div className="max-w-lg w-full">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-3 text-foreground">
            FAQ
          </h1>
          <p className="text-muted">
            The second rule: read the FAQ before asking.
          </p>
        </div>

        <FaqAccordion items={faqData} />

        <div className="text-center mt-10">
          <Link
            href="/"
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            &larr; Back
          </Link>
        </div>
      </div>
    </main>
  );
}
