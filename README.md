# unity-chatops-builder

SlackまたはDiscordから、macOS上のUnity EditorへAPKビルドを依頼する単一Runner向けChatOps CIです。

要求ごとにGitHub Repository、branch、Unity Build Profileを指定できます。Repositoryの事前登録は不要で、Coordinatorを実行するmacOSユーザーのSSH資格情報で読み取れるRepositoryをビルドできます。

## ビルド要求

```text
unity-build
repository: 0suu/my-unity-project
branch: main
project: UnityProject
profile: Assets/BuildProfiles/PICO-Development.asset
```

`repo:`は`repository:`の短縮形です。Repositoryには`owner/repository`、`github.com/owner/repository`、GitHubのSSH URL、HTTPS URLを指定できます。入力は認証情報を含まない`git@host:owner/repository.git`へ正規化されます。

`project:`はRepository内のUnityプロジェクトルートへの相対pathです。省略時はRepository直下（`.`）を使用します。Profileは選択したUnityプロジェクトを基準にした`Assets/...` pathで指定します。空白を含むpathも使用できます。

Repositoryへのアクセス可否はCoordinatorが実際にSSH clone/fetchして判定します。アクセスできなければ`REPOSITORY_ACCESS_FAILED`または`GIT_FETCH_FAILED`としてスレッドへ返信し、Workerへは渡しません。

## Repository Access設定

```json
{
  "repositoryAccess": {
    "defaultHost": "github.com",
    "allowedHosts": ["github.com"],
    "allowedBranchPatterns": [".+"]
  }
}
```

- `defaultHost`: `owner/repository`形式で補完するhost
- `allowedHosts`: チャット入力から選択可能なGit host
- `allowedBranchPatterns`: 全Repository共通のbranch正規表現

任意hostのSSH URLは許可しません。内部hostへの接続や意図しないcredential送信を防ぐため、host allowlistを維持します。GitHub Enterpriseを利用する場合は、そのhostを明示的に追加してください。

## Build Profile

`profile`は`Assets/`配下の正規化済み`.asset` pathである必要があります。`unity.allowedBuildProfiles`が空なら、Snapshot内に実在する安全なpathを利用できます。列挙した場合はそのpathだけを許可します。

## SourceとGit LFS

```text
Slack / Discord
      ↓
Coordinator
  Repository入力を正規化
  SSH fetchでCommit SHAを固定
  LFS objectを取得・hash/size検証
  read-only Source Snapshotを公開
      ↓
SQLite Queue
      ↓
Worker
  .gitなしWorkspace
  Unity CLI build
  APK検証・スレッド配送
```

Git、Git LFS、SSH Agent、credential helperはCoordinatorだけが利用します。Workerには検証済みSource Snapshotだけを渡します。

Git LFS設定はrootの`sourceDependencies`へ置きます。

```json
{
  "sourceDependencies": {
    "gitLfs": {
      "enabled": true,
      "mode": "materialize_in_source_snapshot",
      "maxObjectBytes": 10737418240,
      "maxTotalBytesPerJob": 53687091200,
      "allowRepositoryLfsconfig": false,
      "allowedEndpointHosts": ["github.com", "githubusercontent.com"]
    },
    "submodules": { "enabled": false }
  }
}
```

詳細は[`docs/GIT_LFS.md`](docs/GIT_LFS.md)と[`docs/DYNAMIC_REPOSITORIES.md`](docs/DYNAMIC_REPOSITORIES.md)を参照してください。

## ステータス

| 数字 | 状態 | 意味 |
|---:|---|---|
| 0 | `AUTHORIZING` | 要求・Repository入力を検証中 |
| 1 | `RESOLVING_SOURCE` | SSH fetch、LFS、Snapshot解決中 |
| 2 | `WAITING_FOR_WORKER` | Queue待機中 |
| 3 | `MATERIALIZING_WORKSPACE` | Workspace作成中 |
| 4 | `ENSURING_UNITY` | UnityとProfile検証中 |
| 5 | `RESTORING_CACHE` | Cache準備中 |
| 6 | `BUILDING` | Unity build中 |
| 7 | `PUBLISHING_ARTIFACT` | APK検証・配送中 |
| 8 | `CLEANING_UP` | Cleanup中 |
| 9 | `SUCCEEDED` | 成果物配送完了 |

## 設定移行

固定Repository方式の旧設定は起動時に拒否します。

```diff
- "repository": {
-   "alias": "project",
-   "sshUrl": "git@github.com:organization/project.git"
- }
+ "repositoryAccess": {
+   "defaultHost": "github.com",
+   "allowedHosts": ["github.com"]
+ }
```

`repository.sourceDependencies`はrootの`sourceDependencies`へ移動してください。

## Security

指定branchのUnity codeはRunner user権限で実行され得ます。SSHで読めるすべてのRepositoryが安全になるわけではありません。要求可能なuser/channelを制限し、専用macOS userとビルド用途のread-only SSH資格情報を使用してください。未信頼Forkや第三者Repositoryをbare-metal Runnerで実行しないでください。

詳細は[`SECURITY.md`](SECURITY.md)を参照してください。

## Validation

```bash
npm run check
```
