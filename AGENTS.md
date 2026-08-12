<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Page chats

- Open a chat named for the app area (`Home`, `Pipeline`, …). Starters: `.cursor/agents/`. Roster: `.cursor/rules/agent-roster.mdc`.
- Prefer one active chat; delete or leave idle when the slice is done. Chat titles are area-only (no product brand prefix).

## Product backlog

Gates (always on): `.cursor/rules/backlog-gates.mdc`. Detail when working on that item:

- Alive UX + sell path: `.cursor/rules/alive-product-ux-backlog.mdc` — after UI color + deep scan
- Sales Pitch Deck: `.cursor/rules/pitch-deck-vision.mdc` — do not build until Joe asks
- Cash + insurance contracts: `.cursor/rules/legal-contracts-backlog.mdc` — verbiage unchanged
- Auth / login: `.cursor/rules/auth-login-backlog.mdc` — do not build until Joe asks
- Canvassing phone / skip-trace: `.cursor/rules/canvassing-phone-lookup-backlog.mdc` — do not build until Joe asks

## UI note

- No filler under-title copy: `.cursor/rules/no-filler-ui-copy.mdc`
