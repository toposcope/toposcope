# Upstream reports (drafts)

These are drafts of two focused reports for hashicorp/raft, from the rqlite proof (`RESULTS-rqlite.md`, section 5). Nothing here has been filed yet. Each one states the reproduction and the expected behaviour, and offers a change; neither claims a defect.

- [`raft-1-snapshot-stream-no-deadline.md`](raft-1-snapshot-stream-no-deadline.md): a follower's snapshot install can block its main loop indefinitely when the leader is lost mid-transfer.
- [`raft-2-candidate-install-snapshot.md`](raft-2-candidate-install-snapshot.md): `installSnapshot` leaves a same-term candidate a candidate while recording the sender as leader.

Both proposed changes, with tests, are in [`../patches/raft-snapshot-idle-timeout.patch`](../patches/raft-snapshot-idle-timeout.patch). For a PR it would be split in two, one per report.

The rqlite `?transaction` documentation note (section 1) is not drafted here.
