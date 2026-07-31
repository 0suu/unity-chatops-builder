# Git LFS Source Resolution

## 結論

Git LFSは初期版の標準Source解決処理であり、Workerが`git lfs pull`するオプション機能ではない。`RepositorySourceResolver`が、認証・Endpoint検証・object取得・hash/size検証・materialize・Source Snapshot公開までを完了させる。

## 責務境界

```text
Chat Coordinator
  └─ RepositorySourceResolver
       ├─ trusted remoteからCommitをfetch
       ├─ Source Stagingへcheckout（LFS smudge無効）
       ├─ .gitattributes / git check-attrでLFS pathを検出
       ├─ strict LFS pointer parse
       ├─ trusted LFS Batch APIへアクセス
       ├─ content-addressed object cacheへ検証済みobjectを公開
       ├─ pointerを実ファイルへmaterialize
       └─ read-only Source Snapshotを公開

Build Worker
  └─ SourceSnapshotStore.materializeWorkspace
       ├─ snapshot tree digestを検証
       ├─ .gitを含まないWorkspaceを作成
       └─ Unityを実行
```

WorkerにはGitHub Token、credential helper、SSH Agent、LFS Authorization Header、LFS一時credentialを渡さない。Workerはremote URL、LFS Endpoint、OID cacheの存在を知る必要がない。

## Pointer検証

受理する形式は次の3要素を必須とする。

```text
version https://git-lfs.github.com/spec/v1
oid sha256:<64 lowercase hex>
size <non-negative safe integer>
```

pointerは1 KiB以下、BOMなしUTF-8、NULなしとする。同一OIDに異なるsizeが指定された場合も失敗する。

## Endpoint Policy

既定値:

```json
{
  "allowRepositoryLfsconfig": false,
  "allowedEndpointHosts": ["github.com", "githubusercontent.com"]
}
```

次を拒否する。

- HTTP
- URL内credential
- 443以外のport
- allowlist外host
- localhost、`.local`、`.internal`
- loopback、link-local、private、reserved address
- DNS解決後に上記addressへ到達するhost
- redirect後のpolicy不一致

`.lfsconfig`を許可する場合もRepository Policyで明示し、同じURL検証を適用する。

## LFS Batch API

アプリケーションが`application/vnd.git-lfs+json`のBatch APIを直接利用する。localの`git-lfs`コマンドは必須ではない。

SSH remoteではCoordinatorが次に相当する認証を実行する。

```text
ssh -o BatchMode=yes -o ClearAllForwardings=yes <host> \
  "git-lfs-authenticate <repository-path> download"
```

HTTPS remoteではCoordinatorだけが`git credential fill`を利用できる。取得したAuthorizationはWorker環境、Snapshot、Manifest、ログへ保存しない。cross-origin redirectではAuthorization等を削除し、redirect先を再検証する。

## Object Cache

```text
lfs-objects/
├── sha256/
│   └── ab/
│       └── abcdef...
├── tmp/
├── locks/
└── protections/
```

公開手順:

1. OID lock取得
2. 一時ファイルへstream download
3. size検証
4. SHA-256検証
5. file `fsync`
6. read-only化
7. atomic rename
8. directory `fsync`

同じOIDの並行要求はlock内でcacheを再検証するため、正式objectのdownloadは1回に収束する。破損cache hitは利用せず隔離する。

Source Snapshot作成中はProtection Leaseを保持する。download完了直後にleaseを解放せず、materializeとSnapshotのatomic publishが完了してから解放する。

## Source Snapshot Manifest

```ts
interface SourceSnapshotManifest {
  snapshotId: string;
  repositoryId: string;
  commitSha: string;
  filesDigest: string;
  lfs: {
    enabled: boolean;
    objectCount: number;
    totalSizeBytes: number;
    objects: {
      path: string;
      oidSha256: string;
      sizeBytes: number;
    }[];
  };
  createdAt: string;
}
```

`filesDigest`はmaterialize済みtreeのpath/type/executable mode/size/content hashから計算する。`snapshotId`は自己参照と生成時刻依存を避けるため、`snapshotId`と`createdAt`を除いたcanonical Manifest identityから計算する。

Snapshotはread-onlyで公開し、`.git`、credential、Git configを含めない。Worker Workspace作成後にもtree digestを再検証する。

## GC

既定値:

```json
{
  "maxTotalGb": 300,
  "retentionDays": 60
}
```

GCは次を保護する。

- Snapshot作成中のProtection Lease
- OID lock取得中のobject
- Queueまたは実行中ジョブが参照するSnapshotのobject
- 保持中Artifactの再現に必要なSnapshotのobject
- retention内の全Snapshotが参照するobject

削除候補は未参照かつ最終利用時刻が古いobjectから選び、容量超過時も古い順に削除する。

## エラーコード

- `LFS_POINTER_INVALID`
- `LFS_OBJECT_NOT_FOUND`
- `LFS_OBJECT_HASH_MISMATCH`
- `LFS_OBJECT_SIZE_MISMATCH`
- `LFS_OBJECT_TOO_LARGE`
- `LFS_TOTAL_SIZE_LIMIT_EXCEEDED`
- `LFS_ENDPOINT_NOT_ALLOWED`
- `LFS_AUTHENTICATION_FAILED`
