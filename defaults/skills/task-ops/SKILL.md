---
name: task-ops
description: >
  Canonical jagc scheduled-task operations playbook. Use when the user asks
  for one-off or recurring scheduled work, asks to manage existing jagc tasks
  (create/list/get/update/delete/run/enable/disable), or when you want to
  suggest automating repeatable/future work as a task (get user approval
  first). Covers the exact `jagc task` command contract, JSON-first low-turn
  workflows, RRULE + one-off scheduling, deterministic relative-time -> UTC
  conversion, and verification policy.
---

# jagc task ops (no `--help` required)

Use `bash` + `jagc task` only. Never edit `jagc.sqlite*`.
Prefer `--json` for every command.

## Thread targeting

Bash tool calls include thread-scoped env:

- `JAGC_THREAD_KEY`: canonical current conversation thread key.
- `JAGC_TRANSPORT`: current transport/provider (for example `telegram`, `cli`).
- `JAGC_TELEGRAM_CHAT_ID`: Telegram chat id when current thread is Telegram.
- `JAGC_TELEGRAM_TOPIC_ID`: Telegram topic id for topic threads (unset in base/default chat thread).

Rules:

- In jagc runtime, `jagc task create` defaults to `$JAGC_THREAD_KEY` when set.
- Omit `--thread-key` to target the current conversation thread.
- Pass `--thread-key` only when the user explicitly wants a different thread.

## Command contract

- Create recurring (cron):
  - `jagc task create --title <text> --instructions <text> --cron <expr> --timezone <iana> [--thread-key <key>] [--json]`
- Create recurring (rrule):
  - `jagc task create --title <text> --instructions <text> --rrule <rule> --timezone <iana> [--thread-key <key>] [--json]`
- Create one-off:
  - `jagc task create --title <text> --instructions <text> --once-at <utc-iso> --timezone <iana> [--thread-key <key>] [--json]`
- List:
  - `jagc task list [--thread-key <key>] [--state all|enabled|disabled] [--json]` (default: `all`)
- Get:
  - `jagc task get <task_id> [--json]`
- Update:
  - `jagc task update <task_id> [--title <text>] [--instructions <text>] [--once-at <utc-iso>|--cron <expr>|--rrule <rule>] [--timezone <iana>] [--enable|--disable] [--json]`
- Delete:
  - `jagc task delete <task_id> [--json]`
- Run now:
  - `jagc task run <task_id> [--json]`
- Run and wait:
  - `jagc task run <task_id> --wait [--timeout <sec>] [--interval-ms <ms>] [--json]`
- Toggle:
  - `jagc task enable <task_id> [--json]`
  - `jagc task disable <task_id> [--json]`

## Recurrence patterns (RRULE)

Use `--rrule` for calendar patterns cron cannot express.

- First Monday of every month at 09:00:
```bash
RRULE='FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0'
jagc task create --title "Monthly planning" --instructions "Prepare monthly priorities" --rrule "$RRULE" --timezone "America/Los_Angeles" --json
```

- Every 2 weeks on Monday at 09:00:
```bash
RRULE='FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0'
jagc task create --title "Biweekly sync" --instructions "Prepare sync agenda" --rrule "$RRULE" --timezone "America/Los_Angeles" --json
```

Notes:
- Raw RRULE body (`FREQ=...`) is accepted; jagc injects stable `DTSTART` automatically.
- Keep `timezone` aligned with operator intent (local wall-clock schedule).

## Relative time (shell-only, deterministic)

Convert natural language to UTC ISO first, then pass `--once-at`.

- In 2 hours:
```bash
ONCE_AT=$(date -u -d '+2 hours' '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || date -u -v+2H '+%Y-%m-%dT%H:%M:%S.000Z')
```

- Tomorrow at 09:00 in user timezone:
```bash
TZ_NAME="America/Los_Angeles"
ONCE_AT=$(TZ="$TZ_NAME" date -u -d 'tomorrow 09:00' '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || TZ="$TZ_NAME" date -u -v+1d -v9H -v0M -v0S '+%Y-%m-%dT%H:%M:%S.000Z')
```

Then create:
```bash
jagc task create --title "..." --instructions "..." --once-at "$ONCE_AT" --timezone "$TZ_NAME" --json
```

## Verification policy

- Mutation response is primary confirmation.
- Follow-up only when needed:
  - `jagc task get <task_id> --json`
  - `jagc task list --state all --json`
- Execution diagnosis:
  - `jagc health --json`
  - `jagc run wait <run_id> --json` (if you already have `run_id`)
