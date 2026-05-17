# Contributing to miramira

Thanks for considering a contribution! miramira is an open-source
authorization service licensed under Apache 2.0.

## Ground rules

- **Open an issue first** for anything non-trivial — a new endpoint, a
  schema change, a breaking refactor. Small fixes and doc tweaks can go
  straight to a PR.
- **One concern per PR.** A schema change and a refactor are two PRs.
- **Tests are required** for new behavior. Integration tests live in
  `test/integration/` and need a real Postgres + OpenFGA via the
  bundled `docker-compose.yml`.

## Development setup

Prerequisites: Node.js 20+ and Docker.

```bash
git clone <your-fork>
cd miramira
docker compose up -d --wait
npm install
cp .env.example .env
npm run db:migrate
npm run openfga:bootstrap        # paste resulting IDs into .env
npm run db:seed
```

Then run the API and worker in two terminals:

```bash
npm run dev
npm run worker
```

## Before you push

The CI workflow runs all of these — running them locally first is faster
than waiting for CI to fail.

```bash
npm run lint
npm run typecheck
npm run format:check
npm test
npm run build
```

`npm run lint:fix` and `npm run format` auto-fix most issues.

## Architecture rules

Enforced by code review:

- **Routes do no business logic.** Parse input, call a service, shape the
  response. Validation is via Zod schemas in the route's `schema:` block.
- **Services own all business logic.** Only services orchestrate
  repositories and the OpenFGA client.
- **Repositories do no business logic.** Only Drizzle queries.
- **No OpenFGA calls inside a DB transaction.** Use the outbox.
- **Workers only call services**, never repositories or OpenFGA directly.

See [`CLAUDE.md`](CLAUDE.md) for the full domain model.

## Commit messages

Imperative mood, present tense:

- ✅ "Add cursor pagination to list endpoints"
- ✅ "Fix audit-log race in role-binding revoke"
- ❌ "Added pagination"
- ❌ "fixing bug"

The subject line is the headline; details belong in the body. PR titles
follow the same rule.

## Reporting security issues

Please do not open public issues for security vulnerabilities. Email the
maintainer instead. We will acknowledge receipt within 72 hours.

## Code of conduct

Be kind, assume good faith, focus on the code. Disagreements about
technical direction are welcome; personal attacks are not.

## License

By contributing, you agree that your contributions will be licensed under
the Apache License 2.0, the same license that covers the project.
