# unity-chatops-builder

SlackまたはDiscordの指定チャンネルに投稿された要求から、macOS上のUnity EditorをCLI実行し、指定ブランチ・指定Build ProfileのAndroid APKを生成して元メッセージのスレッドへ返す、単一Runner向けの簡易CIです。

## 初期版の構成

```text
Slack / Discord
      │
      ▼
Chat Coordinator
      │
      ├─ RepositorySourceResolver
      │    ├─ trusted Git remoteからCommitをfetch
      │    ├─ Git LFS pointerを検出
      │    ├─ trusted LFS endpointからobjectを取得・検証
      │    ├─ LFS object cacheへatomic publish
      │    └─ materialize済みread-only Source Snapshotを公開
      │
      ├─ SQLite Job Queue
      │
      ▼
Build Worker
      ├─ Source Snapshotから.gitなしWorkspaceを作成
      ├─ Unity CLI build
      ├─ APK検証
      └─ Slack / Discord threadへ配送
```

重要な境界は、Git/LFS認証と外部通信をCoordinator側だけに置き、Workerには検証済みSnapshotだけを渡すことです。Workerは`git lfs pull`、Git credential helper、SSH Agent、LFS Authorization Headerを利用しません。

## 実装済み

- Slack Socket Mode / Discord Gateway
- 通常メッセージからbranchとUnity Build Profile pathを受付
- workspace / Guild、channel、user、Discord role allowlist
- 元メッセージの数字リアクション`0`〜`9`をステージごとに置換
- SQLite FIFO queue、重複排除、event履歴、heartbeat、再起動復旧
- trusted remoteからCommit SHAを固定
- Coordinator所有のGit LFS Batch API client
- strict LFS pointer parse、SHA-256 / size検証
- Endpoint / redirect host policy、`.lfsconfig`既定拒否、SSRF防止
- OID単位lockを持つcontent-addressed LFS object cache
- Snapshot公開完了までのGC protection lease
- LFS実体を含むread-only Source Snapshotとcanonical Manifest
- `.git`を含まないWorker Workspace
- Unity versionとBuild Profileの検証
- APKの存在、サイズ、ZIP構造、SHA-256検証
- Slack / Discord threadへのnative upload
- Artifact、log、Snapshot、LFS objectのGC
- `launchd`テンプレート

初期版は固定リポジトリ1つ、Unity同時実行1、native uploadのみです。S3/R2などの外部Artifact Storeは後付けできる境界になっています。

## 必要環境

- macOS
- Node.js 24.15.0以上（`.nvmrc`は24.18.0）
- Git
- Unity Hub経由で対象Unity Editorをインストール済み
- Unity Android Build Support、SDK、NDK、OpenJDK
- 対象Repositoryへの読み取り専用SSH access
- `/usr/bin/unzip`

`git-lfs`CLIは必須ではありません。LFS Batch APIとobject検証はアプリケーション自身が行います。

## セットアップ

```bash
git clone git@github.com:0suu/unity-chatops-builder.git
cd unity-chatops-builder
nvm use
npm install
cp config.example.json config.json
npm run check
node src/index.js --config ./config.json
```

Chat tokenはRepository外のfileまたはenvironment variableで参照します。

```bash
mkdir -p "$HOME/.config/unity-chatops-builder"
printf '%s' 'xoxb-...' > "$HOME/.config/unity-chatops-builder/slack-bot-token"
printf '%s' 'xapp-...' > "$HOME/.config/unity-chatops-builder/slack-app-token"
printf '%s' 'discord-token' > "$HOME/.config/unity-chatops-builder/discord-bot-token"
chmod 600 "$HOME/.config/unity-chatops-builder/"*-token
```

## ビルド要求

```text
unity-build
branch: suu/feature/example
profile: Assets/BuildProfiles/PICO-Development.asset
```

- 1行目は完全に`unity-build`
- `branch`と`profile`は各1回
- 未知のkeyは禁止
- Build Profileは`Assets/`配下の正規化された`.asset`
- branchとprofileはRepository Policyのallowlistに一致する必要がある

## ステータスリアクション

| 数字 | 状態 | 意味 |
|---:|---|---|
| 0 | `AUTHORIZING` | 要求・権限を検証中 |
| 1 | `RESOLVING_SOURCE` | Commit、LFS、Source Snapshotを解決中 |
| 2 | `WAITING_FOR_WORKER` | queue待機中 |
| 3 | `MATERIALIZING_WORKSPACE` | SnapshotからWorkspaceを作成中 |
| 4 | `ENSURING_UNITY` | Unity versionとBuild Profileを検証中 |
| 5 | `RESTORING_CACHE` | Unity build cache準備中 |
| 6 | `BUILDING` | Unity build中 |
| 7 | `PUBLISHING_ARTIFACT` | APK検証・upload中 |
| 8 | `CLEANING_UP` | Workspace等をcleanup中 |
| 9 | `SUCCEEDED` | Artifact配送まで完了 |

失敗時は数字を外してfailure emojiを付け、同じthreadへerror code、失敗stage、log末尾を投稿します。

## Git LFS Policy

```json
{
  "repository": {
    "sourceDependencies": {
      "gitLfs": {
        "enabled": true,
        "mode": "materialize_in_source_snapshot",
        "maxObjectBytes": 10737418240,
        "maxTotalBytesPerJob": 53687091200,
        "allowRepositoryLfsconfig": false,
        "allowedEndpointHosts": [
          "github.com",
          "githubusercontent.com"
        ]
      },
      "submodules": {
        "enabled": false
      }
    }
  },
  "storage": {
    "lfsObjects": {
      "maxTotalGb": 300,
      "retentionDays": 60
    }
  }
}
```

Repository PolicyではcamelCaseと仕様書のsnake_caseを受理します。旧`repository.useGitLfs`は削除され、設定されている場合は起動時errorになります。

詳細は[`docs/GIT_LFS.md`](docs/GIT_LFS.md)を参照してください。

## Source Snapshot

```text
dataDir/
├── repositories/<alias>.git/
├── source-staging/
├── source-snapshots/sha256/<prefix>/<snapshot-id>/
│   ├── manifest.json
│   └── source/
├── lfs-objects/
│   ├── sha256/<prefix>/<oid>
│   ├── tmp/
│   ├── locks/
│   └── protections/
├── workspaces/<job-id>/
├── artifacts/<job-id>/
├── logs/<job-id>/
└── jobs.sqlite3
```

ManifestはCommit SHAだけでなく、materialize済みfile tree digestとLFS object一覧を含みます。Snapshot IDはcanonical Manifest identityから算出します。Snapshotに`.git`やcredentialは含まれません。

## Slack / Discord

SlackはSocket Modeを利用し、`channels:history`、`groups:history`、`chat:write`、`files:write`、`reactions:write`を必要とします。`manifests/slack-app-manifest.yaml`を利用できます。

DiscordはMessage Content Intentと、thread作成、thread投稿、reaction、file attachment権限を必要とします。Discordの直接添付上限を超えたAPKは配送失敗として扱い、build成功とは分離して記録します。

## Security

指定branchのUnity Editor codeやpackageはRunner上で実行され得ます。

- 専用macOS userで実行
- 対象Repositoryだけを読めるDeploy Key
- Chat tokenをUnity processへ継承しない
- CoordinatorとWorkerのcredential boundaryを維持
- arbitrary Repository URLをChat入力させない
- `.lfsconfig`を既定拒否
- LFS URLとredirectを毎回policy検証
- hash mismatch objectをcacheやWorkspaceへ公開しない
- SnapshotとWorkspaceへ`.git`を含めない

詳細は[`SECURITY.md`](SECURITY.md)を参照してください。

## Validation

```bash
npm run check
```

syntax checkとNode.js標準test runnerを実行します。LFS pointer、Endpoint policy、Batch API、OID lock、cache validation、GC lease、Snapshot digest、Coordinator/Worker boundaryをtest対象に含みます。
