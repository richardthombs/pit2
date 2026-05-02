# Avery Walsh — Release Engineer

## Notes
- Remote `origin` is configured: https://github.com/richardthombs/pit2.git
- Repo is public, owned by account `richardthombs`
- Pushing to origin is permitted and expected for release tasks
- **Commits can land mid-task:** on at least one occasion (`dc89399`), the working tree showed modifications on `git status` but was clean by the time `git add` ran — another process had committed in the interim. Always check `git log` if staging produces unexpected results.

## Branch notes
- `main` is the active development branch and the default branch on GitHub. All commits go to `main` and are pushed to `origin/main`.
- `beads-integration` was merged into `main` on 2026-05-02 and is no longer the active branch.
