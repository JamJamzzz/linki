import type { Page } from "playwright";

/**
 * Visits a LinkedIn profile page. This registers as a profile view on LinkedIn.
 * Navigates and waits, then reports whether the page shows a 1st-degree badge —
 * lets the runner backfill degree=1 for contacts that were already connected
 * before Linki ever sent them a connection request (e.g. manually added leads).
 */
export async function visitProfile(page: Page, linkedinUrl: string): Promise<{ isFirstDegree: boolean }> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000 + Math.random() * 2000);
  const pageText = await page.locator(".pv-top-card, .scaffold-layout__main").first().innerText().catch(() => "");
  return { isFirstDegree: /\b1st\b/.test(pageText) };
}
