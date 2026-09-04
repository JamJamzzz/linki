# Dropbox intake example fixture

`LinkiInbox/ixl-swe-ng-31102/` is a complete, valid batch folder — copy its three files
into your real Dropbox intake root (default `/LinkiInbox`) under a folder with any name to
try the feature end-to-end:

```
LinkiInbox/
  ixl-swe-ng-31102/
    campaign.json   — edit workflow_id / linkedin_account_id to real ids from your Linki instance
    contacts.csv     — 3 example rows: LinkedIn-only, email-only, and mixed
    _READY            — empty marker file; upload this LAST (see docs/dropbox-intake.md)
```

Before uploading, replace the placeholder ids in `campaign.json` with a real `workflow_id`
(and `linkedin_account_id` if `auto_launch` stays `true`) from your Linki instance — Linki
never guesses these. Set `auto_launch` to `false` if you just want to see the list created
without launching a run.

See [`docs/dropbox-intake.md`](../../docs/dropbox-intake.md) for the full setup guide.
