# Avery Walsh — Release Engineer

## Notes
- Remote `origin` is configured: https://github.com/richardthombs/pit2.git
- Repo is public, owned by account `richardthombs`
- Pushing to origin is permitted and expected for release tasks
- **Commits can land mid-task:** on at least one occasion (`dc89399`), the working tree showed modifications on `git status` but was clean by the time `git add` ran — another process had committed in the interim. Always check `git log` if staging produces unexpected results.

## Branch notes
- `beads-integration`: active workstream branch; Integration A implemented; Integration B full design doc committed (`design-beads-integration-b.md`); Integrations C–D remain as earlier design docs in `.pi/docs/`
- Last commit on branch: `b26b8e1` — fix(broker): remove duplicate newSession() block; update agent memory files
- Roster as of 2026-05-02: Finley Park fired, Blaine Mwangi fired; Sage Okonkwo onboarded (typescript-engineer); Alex Rivera removed, Kendall Mbeki onboarded (software-architect); Emery Vidal onboarded (software-architect); Blake O'Brien onboarded (qa-engineer)
- Casey Kim removed 2026-05-01; replaced by Remy Osei
