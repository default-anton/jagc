---
kind: index
summary: Root map for markdown memory notes, schema, traversal order, and supported note kinds.
read_when: Read when AGENTS.md is not enough or before creating/editing memory notes. Read before introducing a new kind.
updated_at: 2026-02-21
tags: [memory, index, schema]
---

# Memory index

## Supported `kind` values

- `index` — navigation/mapping notes.
- `preference` — user or operator preferences.
- `fact` — durable factual context.
- `event` — important dated events.
- `history` — domain history split into curated notes.
- `health` — health/medical context.
- `project` — project-specific context.
- `contact` — people/org contact context.
- `constraint` — standing limits, policies, or non-negotiables.

Add new kinds when needed, but update this list in the same change.

## Frontmatter contract

- `kind` (required)
- `summary` (required, one sentence)
- `read_when` (required)
- `valid_from` (optional, ISO date/datetime, inclusive)
- `valid_to` (optional, ISO date/datetime, exclusive)
- `updated_at` (required, ISO date/datetime)
- `tags` (optional)

## Domains

- `people/index.md` — people, preferences, and contacts.
- `projects/index.md` — project-level durable context.
- `timeline/index.md` — major time-based events and milestones.
- `health/index.md` — health/medical context.
