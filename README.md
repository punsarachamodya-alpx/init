# Colombo Release Tracker - Claude Code starter

Starter files for building the Colombo clearance and trucking orchestration tool with Claude Code.

## Contents
| Path | What it does |
|---|---|
| `CLAUDE.md` | Project rules, commands, glossary, status chain. Claude reads it every session. |
| `.claude/agents/domain-reviewer.md` | Read-only subagent that checks changes against the real import chain. |
| `.claude/settings.json` | Registers the two hooks below. |
| `.claude/hooks/protect-files.sh` | Blocks edits to `.env*`, `.git`, lockfile, existing migrations, `labels.json`, `fixtures/real/`. |
| `.claude/hooks/verify-before-stop.sh` | Stops Claude from finishing while `typecheck` or `test` fail. Guarded against loops. |
| `fixtures/synthetic/` | Three made-up documents (DO, delivery advice, CusDec summary) with valid fake container numbers. |
| `fixtures/labels.json` | Ground truth for scoring extraction. |
| `data/baseline.csv` | Header for the manual timing baseline (one synthetic example row to delete). |
| `scripts/check-iso6346.mjs` | Container number check-digit validator. |
| `prompts.md` | The four ordered build prompts. |

## Setup
1. Copy the folder into a new git repo: `git init` then commit.
2. Install `jq` (the hooks need it) and make the hooks executable: `chmod +x .claude/hooks/*.sh`
3. Open the folder in Claude Code and run `/hooks` to confirm both hooks are listed.
4. Start with Prompt 1 in `prompts.md`.

## Notes
- All fixtures are synthetic. The container prefix `ZZZU` is not a registered owner code. Never commit real driver, company, container or document data.
- The `pnpm` commands in `CLAUDE.md` are placeholders until Prompt 1 fixes the stack.
- The stop hook only runs scripts that exist in `package.json`, so it stays quiet before scaffolding.
- Before using real documents in testing, check the Sri Lanka PDPA obligations (core provisions operative 1 January 2027).
