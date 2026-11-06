# Upstream reports (drafts, not filed)

Two reports for hashicorp/raft, from the rqlite proof (`../RESULTS-rqlite.md`, section 5).

hashicorp/raft has no issue template. Its CONTRIBUTING.md asks a bug report to:
1. check existing issues;
2. reproduce on the latest version;
3. include a minimal, self-contained reproduction.

Each draft meets these:
- **Self-contained reproduction:** a single Go test file that runs inside the raft repository with no other changes. It needs neither rqlite nor Docker.
- **Latest version:** each test fails on `main` at a5b4692, which is v1.8.0 plus CI and copyright changes.
- **Existing issues:** each draft cites the related issues and PRs found by searching.

| Draft | Test | On `main` | With the fix |
| --- | --- | --- | --- |
| [`raft-1-snapshot-stream-no-deadline.md`](raft-1-snapshot-stream-no-deadline.md) | [`repro_stalled_snapshot_test.go`](repro_stalled_snapshot_test.go) | fails: no answer in 30 s | passes on open PR #703's branch (about 2 s); also passes with our patch (5 s) |
| [`raft-2-candidate-install-snapshot.md`](raft-2-candidate-install-snapshot.md) | [`repro_candidate_install_test.go`](repro_candidate_install_test.go) | fails 10 of 10 | passes 10 of 10 with only the one-line change; also fails on #703's branch |

**Report 1 does not propose our idle-deadline patch.** Open PR #703 already adds per-read deadlines on the network transport, and a maintainer asked in #700 for exactly this case. Report 1 therefore gives #703 a reproduction and a review note about the deferred drain, instead of offering a competing change.

**Report 2 proposes the one-line change** and offers a PR. If a PR follows, the contributing guide's AI usage section applies. The person opening it must review and understand every change, and must write the commit message and PR description themselves. The PR template also has an LLM-usage checkbox.

Each draft's first line is an HTML comment holding the issue title. Paste the title into GitHub's title field, and the rest as the body.
