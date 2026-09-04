import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { createRun } from "@/lib/runs";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb();

  if (req.method === "GET") {
    const runs = db
      .prepare(
        `SELECT r.*,
                w.name as workflow_name,
                l.name as list_name,
                a.name as account_name,
                COUNT(DISTINCT rp.id) as total_profiles,
                COUNT(DISTINCT CASE WHEN NOT EXISTS (
                  SELECT 1 FROM run_profile_tracks rt2
                  WHERE rt2.run_profile_id = rp.id AND rt2.state NOT IN ('completed', 'failed', 'skipped')
                ) AND EXISTS (
                  SELECT 1 FROM run_profile_tracks rt3
                  WHERE rt3.run_profile_id = rp.id AND rt3.state = 'completed'
                ) THEN rp.id END) as completed_profiles
         FROM runs r
         LEFT JOIN workflows w ON w.id = r.workflow_id
         LEFT JOIN lists l ON l.id = r.list_id
         LEFT JOIN accounts a ON a.id = r.account_id
         LEFT JOIN run_profiles rp ON rp.run_id = r.id
         GROUP BY r.id
         ORDER BY r.created_at DESC`
      )
      .all();
    return res.json(runs);
  }

  if (req.method === "POST") {
    const { workflow_id, list_id, account_id, email_account_id, email_account_ids, target_ids } = req.body;
    if (!workflow_id || !list_id || !account_id)
      return res.status(400).json({ error: "workflow_id, list_id, account_id required" });

    const result = createRun(db, {
      workflowId: workflow_id,
      listId: list_id,
      accountId: account_id,
      emailAccountId: email_account_id,
      emailAccountIds: email_account_ids,
      targetIds: target_ids,
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error, message: result.message });
    }

    return res.status(201).json({ id: result.runId });
  }

  res.status(405).end();
}
