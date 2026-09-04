import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { runDropboxIntakeOnce } from "@/lib/dropbox/intake";

// Manual single-pass trigger for operational recovery/testing (also used by the
// `npm run dropbox:intake` CLI). Auth is handled by proxy.ts like every other /api/*
// route — no separate public webhook endpoint is exposed.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const summary = await runDropboxIntakeOnce(db);
  return res.json(summary);
}
