# Example jobs

All data here is synthetic. Use this directory as the task root; pass the named file and the short task to `malyn submit` or the MCP `malyn` tool.

| File | Task |
| --- | --- |
| `ticket.txt` | Read the ticket. Save `kb-draft.md` with symptoms, confirmed cause, resolution and an explicit unverified follow-up. Cite source lines. Do not invent commands or mark the ticket closed. |
| `service.log` | Group repeated errors, identify the first observed failure, and save `triage.md` with supporting line numbers and what the evidence cannot establish. Do not diagnose the whole host. |
| `retry.mjs` | Review retry.mjs. Save a proposed patch and a short validation checklist. Do not apply changes or claim tests ran. |

```powershell
malyn submit --root C:\src\malyn\examples --file service.log --task "Read service.log. Save triage.md with the repeated errors, first observed failure and source line numbers."
malyn check JOB_ID
```

For Codex, ask a normal file-oriented question after installing the routing skill. It recommends delegation when useful; the supervising model still decides whether a particular job fits. No MCP server can force every client to delegate automatically.
