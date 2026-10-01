# Du Green Ops

Field app for Du Green Investments (Pty) Ltd — installation projects from site measurement to purchase orders.

**Who does what**

| Step | Who | Where in the app |
|---|---|---|
| Create project, trace or measure areas | QS | Projects → New, Areas / Map |
| Specify plants, lawn, hardscaping, piping per area | QS + Horticulturist | Specification (Claude can suggest) |
| Price from library or send RFQs | Procurement | Procurement → Items & pricing / RFQs |
| Upload supplier quotes (Claude reads them) | Procurement | RFQ → Add quote |
| Compare, tick preferred supplier, generate POs | Procurement | Comparison → Generate purchase orders |
| Mark-up per item, BOQ, export to Google Sheets | QS / Matt | Costing & BOQ |

**Tech**: static web app (no build step) hosted on GitHub Pages; Supabase for logins, data, files and the `claude` Edge Function; Leaflet with Esri World Imagery for the site map.

## Files
- `index.html`, `css/`, `js/` — the app (ES modules, no build)
- `supabase/schema.sql` — database, security rules, storage, starting team
- `supabase/functions/claude/index.ts` — server function that calls Claude (needs `ANTHROPIC_API_KEY` secret)
- `js/config.js` — server URL and public key (fill in after Supabase is created)

## Demo mode
Without a server the app runs in demo mode: data stays in that browser only, and Claude features are off.
