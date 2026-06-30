# Migration governance — rewrite-in-place vs. forward-only

Migrations live inlined and ordered in [`src/db/migrations.ts`](../src/db/migrations.ts)
(see [DECISIONS.md](./DECISIONS.md), D12). A migration's id is zero-padded
(`001_init`, `002_call_records`, …) so ids sort lexicographically.

The one rule:

> **A migration that has been applied to a prod/shared environment is frozen — it
> is immutable, and every change after it is a new, additive forward migration. A
> migration that has *not* yet reached prod is unreleased and may be rewritten in
> place** (drop & recreate dev DBs — they're disposable).

Rewriting an already-applied migration is silent corruption: the runner records
applied ids in the `cp_migrations` ledger and **never re-runs them**, so your edit
ships in the code but never executes against the database that already has the old
version.

## The high-water mark

The boundary between frozen and rewritable is the **high-water mark**: the highest
migration id that has reached prod.

**It is deliberately *not* stored in this repo** — not even as a gitignored file.
It is environment state, independent of code; materializing it here just invites a
stale copy that lies. Instead, determine it cheaply from the **last deployed git
release tag**, which we treat as a proxy for what's running in prod:

```sh
git describe --tags --abbrev=0                 # the latest release tag
git show <tag>:src/db/migrations.ts | grep 'id:'   # the migration ids that tag shipped
```

The high-water mark is the highest id in that list.

> ⚠️ **A tag is not a deployment.** The tag is only a *proxy*. Before you rewrite a
> migration in place, **confirm with whoever owns the deploy** that the tag is
> actually live (and that nothing was hot-deployed past it). If you can't confirm,
> treat the migration as frozen and write a forward migration instead — the
> conservative choice is always safe.

The authoritative source, if you need certainty, is the prod ledger itself:

```sql
select max(id) as high_water_mark from conversation_proxy.cp_migrations;
select id, applied_at from conversation_proxy.cp_migrations order by id;
```

(substitute the deployed `CP_SCHEMA`). Reaching it requires prod DB credentials —
which is exactly why the tag-based check above is the cheap default and dev
machines don't need prod access.

## Current state

**Released high-water mark: none.** `v0.1.0` is tagged but **not deployed to prod**,
so `001`–`003` are all unreleased and may be rewritten in place. This is why the
scope-as-conversation-id change (which retyped `conversations.id` from `uuid` to
`text` and dropped `scope_arr`) was a rewrite of `001`/`002` rather than a forward
migration — confirmed before the rewrite per the rule above.

Flip this section to a real mark (and the date) the first time `conversation-proxy`
is deployed to a prod/shared environment.
