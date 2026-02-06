# Tooling notes

## `mise install`: Postgres ICU failure on macOS

If `mise install` fails while building `postgres` with errors like:
- `uconv: command not found`
- `Package 'icu-uc' not found`
- `Package 'icu-i18n' not found`

use Homebrew ICU in the install environment:

```bash
PATH="/opt/homebrew/opt/icu4c@78/bin:$PATH" \
PKG_CONFIG_PATH="/opt/homebrew/opt/icu4c@78/lib/pkgconfig:${PKG_CONFIG_PATH:-}" \
mise install
```

Then verify tool resolution in this repo:

```bash
mise install
mise current
```

Expected active tools include:
- `node 20.20.0`
- `pnpm 10.28.2`
- `postgres 18.1`
