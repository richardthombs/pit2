# Avery Walsh — Release Engineer

## Notes
- Remote `origin` is configured: https://github.com/richardthombs/pit2.git
- Repo is public, owned by account `richardthombs`
- Pushing to origin is permitted and expected for release tasks
- **Commits can land mid-task:** on at least one occasion (`dc89399`), the working tree showed modifications on `git status` but was clean by the time `git add` ran — another process had committed in the interim. Always check `git log` if staging produces unexpected results.
- **My memory file is always modified on `beads-integration`:** switching branches will fail unless the file is stashed first (`git stash` / `git stash pop`).

## Branch notes
- `beads-integration`: merged into `main` on 2026-05-02; branch retained and **still the active development branch** — task briefs may say "on main" loosely, but changes land on `beads-integration`. Commit and push there unless explicitly told otherwise.
- `main` is the **default branch on GitHub** as of 2026-05-02 (set via `gh repo edit richardthombs/pit2 --default-branch main`).
