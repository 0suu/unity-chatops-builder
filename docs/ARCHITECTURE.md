# Architecture

## Components

```text
Trigger Adapters (Slack / Discord)
        │ BuildRequest
        ▼
Chat Coordinator
        ├─ Request validation / authorization
        ├─ RepositorySourceResolver
        │    ├─ Git mirror / trusted fetch
        │    ├─ LFS Endpoint Policy
        │    ├─ LFS Auth Provider
        │    ├─ Git LFS Batch Client
        │    ├─ LFS Object Cache
        │    └─ Source Snapshot Store
        └─ SQLite Queue
                 │ sourceSnapshotId
                 ▼
Build Worker
        ├─ Snapshot materialization
        ├─ Unity environment validation
        ├─ Unity CLI build
        ├─ Artifact validation
        └─ Artifact delivery
```

## Source resolution transaction

1. Requestを検証する。
2. trusted remoteのbranchをCommit SHAへ固定する。
3. LFS smudgeを無効にしてSource Stagingへcheckoutする。
4. gitlinkがないことを確認する。初期版はsubmoduleを拒否する。
5. tracked fileに対して`git check-attr filter`を実行する。
6. `filter=lfs`対象をstrict pointerとして解析する。
7. LFS Endpoint Policyを適用する。
8. LFS Batch APIからdownload actionを取得する。
9. OID cacheへdownloadし、size/SHA-256を検証する。
10. pointer pathへ実fileをmaterializeする。
11. materialize済みtree digestとManifestを作る。
12. Snapshotをread-onlyでatomic publishする。
13. Snapshot IDをjobへ永続化してからqueueへ入れる。

Commit SHAだけではSource解決完了を表さない。LFS object取得、検証、materialize、Snapshot公開が完了するまでWorker queueへ入れない。

## Worker invariants

- Workerは`sourceSnapshotId`なしのjobを実行しない。
- WorkerはGit/LFS network accessを行わない。
- Workspaceに`.git`を含めない。
- SnapshotとWorkspaceのtree digestを一致させる。
- Coordinatorが記録したUnity versionとWorkspace内versionを照合する。
- Unity build成功、Artifact検証成功、配送成功を別々に記録する。

## Durability

- SQLite: WAL + `synchronous=FULL`
- LFS object: temp → verify → fsync → chmod → atomic rename → directory fsync
- Source Snapshot: temp tree → digest verify → read-only → fsync → atomic rename
- duplicate Chat event: `(platform, channel, source_message_id)` unique
- interrupted job: published Snapshotがある場合だけqueueへ戻す

## Garbage collection

Artifact/log cleanup後にSnapshot GC、LFS Object GCの順で実行する。Snapshot GC完了後に残っているManifestからOID reference setを作る。Queue/Running/Artifact保持中Snapshotと作成中leaseは削除対象外である。
