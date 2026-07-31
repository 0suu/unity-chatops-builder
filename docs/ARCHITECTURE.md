# Architecture

## 目的と境界

`unity-chatops-builder`は、Slack／Discordを入力・通知UIとして使い、1台のmacOS RunnerでUnity Android APKを直列ビルドする小規模ChatOps CIです。

初期版では、チャット受信、ジョブ管理、Git／Unity実行、成果物検証、配送を1つのNode.jsプロセスに置きます。ただし、プラットフォーム差分と成果物配送はinterface相当の境界へ分離し、将来のS3、複数Runner、Web管理画面を追加しやすくしています。

```text
Slack Socket Mode ─┐
                   ├─ ChatAdapter ─ BuildCoordinator ─ SQLite Queue
Discord Gateway ──┘                                  │
                                                     ▼
                                              BuildWorker (1)
                                                     │
                  Git bare mirror / per-job worktree ┤
                                                     │
                                               Unity CLI
                                                     │
                                              APK Verifier
                                                     │
                                          ArtifactPublisher
                                                     │
                                        Slack / Discord thread
```

## コンポーネント

### `Application`

- 設定とsecretを読み込んだ後の依存関係構築
- Runner lock取得
- SQLite起動
- Slack／Discord adapter起動
- 中断ジョブの復旧
- リアクション同期
- retentionとWorker開始
- シグナル受信時の順序立てた停止

Adapterの起動途中で失敗した場合も、そのAdapterを明示的にstopしてソケットを残しません。

### `BuildCoordinator`

- ChatAdapterから正規化された受信メッセージを受領
- `unity-build`形式の認識
- 元メッセージ単位の重複排除
- ステータス`0`
- スレッド作成
- branch、Build Profile、許可リストの検証
- SQLiteキュー投入とステータス`1`

不正要求もジョブ履歴へ残し、失敗リアクションとスレッド返信を行います。

### `StatusService`

DBをリアクション表示のsource of truthとします。

```text
desired_status = 表示したい状態
applied_status = API適用まで成功した状態
```

更新順序:

1. `desired_status`をDBへ保存
2. 前のBotリアクションを削除
3. 次のBotリアクションを追加
4. `applied_status`をDBへ保存

削除と追加はSlack／Discord上でatomicではありません。途中失敗では一時的にリアクションがない、または旧表示が残る可能性がありますが、ビルドは継続し、次回起動時に未同期状態を再試行します。

### `JobStore`

Node.js組み込み`node:sqlite`を使用します。

- WAL
- `synchronous=FULL`
- foreign key有効
- STRICT table
- `BEGIN IMMEDIATE`によるジョブclaim
- `(platform, channel_id, source_message_id)`一意制約
- append-onlyの`job_events`

主状態:

```text
VALIDATING → QUEUED → RUNNING → SUCCEEDED
                             └→ FAILED
```

結果は次を分離して保持します。

```text
build_result
artifact_result
delivery_result
job_result
```

これにより、「Unityビルドは成功したがDiscord容量制限で配送だけ失敗」を表現できます。

### `GitService`

```text
dataDir/repositories/<alias>.git
```

へbare mirrorを作成し、毎回`fetch --prune`します。指定branchを`refs/remotes/origin/<branch>^{commit}`として解決し、40〜64桁のcommit SHAを検証して固定します。

ジョブごとに次へdetached worktreeを作成します。

```text
dataDir/workspaces/<job-id>
```

その後、submoduleと必要に応じたGit LFSを取得します。別ジョブと`Library`を共有しないため、速度より再現性と分離を優先しています。

### `UnityService`

1. `ProjectSettings/ProjectVersion.txt`から`m_EditorVersion`取得
2. `<editorsRoot>/<version>/Unity.app/Contents/MacOS/Unity`の実行可否確認
3. Build Profileが通常ファイルかつ非symlinkで、worktree内に実在することを確認
4. 次の形式で起動

```text
Unity
  -batchmode
  -quit
  -projectPath <workspace>
  -activeBuildProfile <Assets/...asset>
  -build <artifact.apk>
  -logFile <unity.log>
```

Unity起動直前はステータス`5`、子プロセスspawn後は`6`です。

GitとUnityはshellを経由せず、commandとargument arrayを`spawn`へ渡します。子プロセスは別process groupとし、timeoutまたはRunner停止時に`SIGTERM`、猶予後`SIGKILL`をprocess groupへ送ります。

### `ArtifactVerifier`

Unity終了コード`0`だけでは成功にしません。

- 通常ファイル、非symlink
- 0 bytes超
- global上限以下
- `.apk`拡張子
- `unzip -tqq`成功
- `AndroidManifest.xml`存在
- `classes.dex`、`lib/`、`assets/`のいずれかが存在
- SHA-256計算

検証成功後のみ`artifact_result=SUCCEEDED`になります。

### `ArtifactPublisher`

初期版は要求元ChatAdapterのnative uploadだけを実装します。

```text
artifact.size <= adapter.nativeUploadLimit
  └─ threadへ直接添付

artifact.size > adapter.nativeUploadLimit
  └─ DELIVERY_ERROR、Mac上に保持
```

将来の外部保存は、ここへ`S3ArtifactStore`と`ExternalLinkDelivery`相当を追加します。Git、Unity、APK検証側は変更しない想定です。

### `RetentionService`

ジョブ結果と保存期間に応じて、ジョブID単位のartifact directoryとlog directoryを削除します。DBへartifact pathが記録される前に失敗して残ったpartial APKも、ジョブディレクトリ単位で回収します。

## ステージ遷移

```text
0 VALIDATING
  └─ thread作成・入力検証
1 QUEUED
  └─ FIFO待機
2 SYNCING_REPOSITORY
  └─ clone/fetch・commit SHA固定
3 PREPARING_WORKSPACE
  └─ worktree・submodule・LFS
4 PREPARING_PROJECT
  └─ Unity version・Build Profile検証
5 LOADING_UNITY
  └─ Unity process起動要求
6 BUILDING
  └─ Unity process spawn済み
7 VERIFYING_ARTIFACT
  └─ APK構造・hash
8 UPLOADING
  └─ Chat platformへ配送
9 SUCCEEDED
  └─ 利用者がthreadから取得可能
```

エラーでは現在の数字リアクションを失敗リアクションへ置換し、失敗stage、code、commit SHA、redact済みログ末尾をthreadへ投稿します。

## 再起動と冪等性

### 二重受付

同じ元メッセージIDの再送はDB一意制約で無視します。メッセージ編集からジョブを再作成しません。

### 実行中断

起動時に`status=RUNNING`のジョブを検出します。

- `delivery_result=SUCCEEDED`: 成功確定
- retry上限内: `QUEUED`へ戻す
- 上限超過: `RUNNER_INTERRUPTED`で失敗

Unityのprocess stateは復元せず、Git同期から再実行します。

### 配送後のDB障害

外部APIへの投稿とSQLite更新を完全な分散transactionにはできません。極端なタイミングでプロセスが落ちると、APK投稿済みでもDBに配送成功が残らない可能性があります。初期版は、通常の停止ではWorker完了を待ち、配送成功を即時DBへ保存することで窓を小さくしています。厳密なexactly-once配送は将来の配送idempotency設計対象です。

## セキュリティモデル

### 信頼境界

Chatの許可ユーザーが指定したbranchに含まれる以下は、Runner上で実行され得ます。

- Unity Editor script
- package initialization code
- native plugin tooling
- build pre/post process

そのため、Chat認可は単なるビルド権限ではなく、Runner上のcode execution権限に近いものです。

### 実装上の防御

- 固定repository URL
- branch regex allowlist
- `git check-ref-format --branch`
- Build Profile path normalization
- Build Profile allowlist
- checkout後のnon-symlink・realpath containment確認
- shell不使用
- Chat tokenを子プロセスenvへ渡さない
- log redaction
- per-job worktree
- 1 process lock
- 専用channel／user／role allowlist

### 運用上必要な防御

- 専用macOSユーザー
- 読み取り専用Deploy Key
- Runnerに不要なcredentialを置かない
- signing secretをGitへ置かない
- Runnerユーザーへ管理者権限を付けない
- OS、Node、Unity、Git、Bot SDKの更新
- ディスク使用量とログの監視

さらに分離する場合は、Chat tokenを持つCoordinatorと、Unity／Gitだけを持つRunnerを別OSユーザー・別processへ分け、制限されたUnix socketまたはjob DBで接続します。
