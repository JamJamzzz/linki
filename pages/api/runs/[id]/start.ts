import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { startRun } from "@/lib/runs";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;

  const result = startRun(db, id);
  if (!result.ok) {
    const status = result.error === "Run not found" ? 404 : 400;
    return res.status(status).json({ error: result.error });
  }

  return res.json({ ok: true });
}
