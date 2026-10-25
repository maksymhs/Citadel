# Contributing to Citadel

Thanks for your interest. Bug reports, ideas and pull requests are welcome.

## Before you start

- For a bug, open an [issue](https://github.com/maksymhs/Citadel/issues/new/choose) with the version and steps to reproduce.
- For a bigger change or a new feature, open an issue or a [discussion](https://github.com/maksymhs/Citadel/discussions) first so we agree on the approach.
- Security problems go through the [private channel](SECURITY.md), never a public issue.

## Development

```bash
git clone https://github.com/maksymhs/Citadel.git
cd Citadel
npm install
npm run dev        # http://127.0.0.1:3000, restarts on changes
npm test           # whole suite
npm run lint
```

Node.js 18 or later. Run the suite for the area you touched, then `npm test` and `npm run lint` before opening the pull request. Do not delete or weaken a test to make it pass.

[AGENTS.md](AGENTS.md) explains how the code is organised, where each feature lives and which docs to update. It is written for AI agents but works for humans too.

## Pull requests

- One logical change per pull request.
- Commit subjects follow Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, `refactor`, `perf`, `docs`, `test`, `chore`. Only `feat`, `fix`, `perf` and `refactor` appear in the changelog, so write them for users.
- Add or update tests, and update the docs listed in AGENTS.md when behaviour changes.
- Never commit secrets or anything from `data/`.

By contributing you agree that your work is released under the [MIT License](LICENSE).
