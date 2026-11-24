# Notes for Claude

## Git commits
- Commit as the repository owner: `KaustubhzOP <2024.kaustubh.patil@ves.ac.in>`
  (set with `git config user.name` / `git config user.email` before committing if it isn't already).
- Do **not** add `Co-Authored-By: Claude …` or `Claude-Session: …` trailers to commit messages,
  and don't add "Generated with Claude Code" lines to pull request descriptions.
- Changes reach the live site (Vercel, production branch `main`) through pull requests that the owner merges.

## Project
- Vite + TypeScript app; `npm test` (Vitest), `npm run typecheck`, `npm run build`.
- Backend: Supabase project `fztahzkhsapptxszjfne`; schema and security in `supabase/migrations`, DB tests in `supabase/tests`.
