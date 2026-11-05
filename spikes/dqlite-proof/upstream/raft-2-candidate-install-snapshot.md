**Title:** installSnapshot leaves a same-term candidate a candidate while recording the sender as leader

**Version:** hashicorp/raft v1.8.0, via rqlite v10.6.6, with pre-vote enabled (the default).

**What happens**

`appendEntries` steps down to follower when it sees the current term from a leader, as well as a newer one:

```go
if a.Term > r.getCurrentTerm() || (r.getState() != Follower && !r.candidateFromLeadershipTransfer.Load()) {
```

`installSnapshot` steps down only for a newer term (`req.Term > r.getCurrentTerm()`), but records the sender as leader either way. A candidate that receives a snapshot at its own term therefore stays a candidate with a leader recorded.

**How it showed up**

With pre-vote, a member that was partitioned keeps its term while it is a candidate, so the leader's InstallSnapshot arrives at that same term. In our reproduction, the leader was then lost and the install failed (we used an idle-deadline change; see the companion report). The member was then left a candidate that still recorded the lost leader:
- it rejected every other member's pre-vote: "rejecting pre-vote request since we have a leader";
- nothing cleared that leader: `setState` clears it only on a state transition, and the member stayed a candidate, restarting its election in the same state;
- the other member rejected its pre-votes because its log was behind ("our last index is greater").

No election succeeded for the 300 s the test waited (1 of 5 trials). Logs from that trial:

```
n1 [ERROR] failed to copy snapshot: error="read tcp ...: i/o timeout"
n1 [WARN]  Election timeout reached, restarting election        (repeats)
n1 [WARN]  rejecting pre-vote request since we have a leader: from=n2 leader=n3 leader-id=n3
n2 [WARN]  rejecting pre-vote request since our last index is greater: candidate=n1 last-index=262051 last-candidate-index=247049
```

**Expected:** InstallSnapshot from the leader of the current term makes a candidate a follower, as AppendEntries does.

**Proposed change:** use the same condition in `installSnapshot` as in `appendEntries`. A unit test drives `installSnapshot` on a candidate at the request's term, and checks that it becomes a follower with the sender recorded; the test fails without the change. With it, 10 of 10 kill trials recovered (6.2–9.0 s).
