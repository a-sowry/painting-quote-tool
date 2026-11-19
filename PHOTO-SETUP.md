# Switching on photo measuring

1. Supabase dashboard > Edge Functions > Deploy a new function > name it `analyse-photo`,
   paste in `supabase/functions/analyse-photo/paste-into-dashboard.ts`, and turn **Verify JWT OFF**.
2. Edge Functions > Secrets: add `ANTHROPIC_API_KEY` (from console.anthropic.com) and `ACCESS_CODE`
   (any code you choose - this is what you give the painter).
3. Put the project URL in `config.js` (`SUPABASE_URL`).

`core.mjs` is the tested source; `paste-into-dashboard.ts` is a generated single-file copy of it.
