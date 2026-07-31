# unity-chatops-builder

SlackまたはDiscordの指定チャンネルに投稿された要求から、macOS上のUnity EditorをCLI実行し、指定ブランチ・指定Build ProfileのAndroid APKを生成して元メッセージのスレッドへ返す、単一Runner向けの簡易CIです。

## 実装済みの範囲

- Slack Socket ModeとDiscord Gatewayを同時利用可能
- 通常メッセージから`branch`とUnity Build Profileのasset pathを受付
- 許可ワークスペース／Guild、チャンネル、ユーザー、Discordロールを制限
- 親メッセージの数字リアクション`0`〜`9`を、進行ステージに応じて1つずつ置換
- エラー時は数字を外して失敗リアクションを付与し、同じスレッドへ詳細を投稿
- SQLiteによる重複受付防止、FIFOキュー、イベント履歴、再起動復旧
- Git bare mirror、コミットSHA固定、ジョブ単位の独立worktree
- Git submoduleと任意のGit LFS取得
- `ProjectSettings/ProjectVersion.txt`に記録されたUnity Editorを厳密に使用
- Unity 6 Build Profileを`-activeBuildProfile`と`-build`でCLIビルド
- APKの存在、サイズ、ZIP整合性、基本構造、SHA-256を検証
- Slack／DiscordのスレッドへAPKを直接添付
- 成果物・ログの保存期間に基づく自動削除
- `launchd`向け常駐テンプレート

初期版は、固定リポジトリ1つ、Unity同時実行1、ネイティブ添付のみです。S3などの外部Artifact Storeは未実装ですが、ビルド処理と配送処理は分離されています。

## 必要環境

- macOS
- Node.js 24.15.0以上（`.nvmrc`は24.18.0）
- Git
- Unity Hub経由で対象プロジェクトと同じUnity Editorをインストール済み
- Unity Android Build Support、SDK、NDK、OpenJDKをインストール済み
- 対象GitHubリポジトリへのSSH読み取りアクセス
- Git LFS対象がある場合はGit LFS
- `/usr/bin/unzip`

Unityは、ビルド専用のmacOSユーザーで一度起動し、ライセンスと必要なモジュールが利用できる状態にしてください。

## セットアップ

```bash
git clone git@github.com:0suu/unity-chatops-builder.git
cd unity-chatops-builder

nvm use
npm install
cp config.example.json config.json
```

`config.json`を編集し、秘密情報はリポジトリ外のファイルまたは環境変数から読み込みます。ファイルを使う場合は、専用ユーザーだけが読める権限にします。

```bash
mkdir -p "$HOME/.config/unity-chatops-builder"
printf '%s' 'xoxb-...' > "$HOME/.config/unity-chatops-builder/slack-bot-token"
printf '%s' 'xapp-...' > "$HOME/.config/unity-chatops-builder/slack-app-token"
printf '%s' 'discord-token' > "$HOME/.config/unity-chatops-builder/discord-bot-token"
chmod 600 "$HOME/.config/unity-chatops-builder/"*-token
```

確認と起動:

```bash
npm run check
node src/index.js --config ./config.json
```

`config.json`は`.gitignore`対象です。

## ビルド要求

許可されたSlackまたはDiscordチャンネルへ、次の形式で新規メッセージを投稿します。スレッド内投稿、Bot投稿、編集イベントは受付対象外です。

```text
unity-build
branch: suu/feature/example
profile: Assets/BuildProfiles/PICO-Development.asset
```

条件:

- 1行目は完全に`unity-build`
- `branch`と`profile`はそれぞれ1回だけ
- 未知のキーは拒否
- Build Profileは`Assets/`配下の正規化された`.asset`パス
- `profile`は`unity.allowedBuildProfiles`の許可リストに含まれること
- `branch`は`repository.allowedBranchPatterns`に一致すること

Botは受付後にスレッドを用意し、ジョブID、ブランチ、Build Profile、受付時点のキュー位置を返信します。Git同期後には、実際にビルドするコミットSHAも返信します。

## ステータスリアクション

親メッセージには常にBot自身のステータスリアクションを1つだけ付けます。ステージ変更時には前のリアクションを削除してから次を付けます。リアクションAPI障害ではビルドを止めず、DBに未同期状態を残して再起動時に再試行します。

| 数字 | 内部状態 | 意味 |
|---:|---|---|
| 0 | `VALIDATING` | 要求検証中 |
| 1 | `QUEUED` | キュー待機中 |
| 2 | `SYNCING_REPOSITORY` | Git同期・コミットSHA確定中 |
| 3 | `PREPARING_WORKSPACE` | worktree・submodule・LFS準備中 |
| 4 | `PREPARING_PROJECT` | Unityバージョン・Build Profile確認中 |
| 5 | `LOADING_UNITY` | Unity起動開始 |
| 6 | `BUILDING` | Unityビルド中 |
| 7 | `VERIFYING_ARTIFACT` | APK検証・SHA-256計算中 |
| 8 | `UPLOADING` | スレッドへアップロード中 |
| 9 | `SUCCEEDED` | APKの投稿まで完了 |

失敗時は数字を削除し、Slackでは`failureEmojiName`、Discordでは`failureEmoji`を付けます。

数字リアクションは通常利用と衝突しない専用カスタム絵文字を用意してください。Slackでは名前、Discordではカスタム絵文字IDを設定します。同じ絵文字を複数ステージへ割り当てる設定は拒否されます。

## Slack設定

`manifests/slack-app-manifest.yaml`をSlack AppのManifestとして使用できます。

必要な設定:

1. Socket Modeを有効化
2. `connections:write`を持つApp-Level Tokenを発行
3. Bot Tokenを発行してワークスペースへインストール
4. Event Subscriptionsで`message.channels`を有効化
5. private channelでも使う場合は`message.groups`を有効化
6. Botを対象チャンネルへ招待
7. `unity_ci_0`〜`unity_ci_9`など10個のカスタム絵文字を作成

Bot Token Scopes:

- `channels:history`
- `groups:history`
- `chat:write`
- `files:write`
- `reactions:write`

起動時に`auth.test`を行い、Bot Tokenのworkspaceと`slack.workspaceId`が一致しなければ停止します。

### Slack成果物サイズ

初期設定では、全体上限とSlack直接添付上限をともに`1,000,000,000` bytesにしています。実際のワークスペースまたはAPI側の上限がこれより小さい場合、アップロードは`DELIVERY_ERROR`になります。ビルド済みAPKはMac側に保持され、保存期間内であれば再利用できます。

Slackへのファイル投稿は`filesUploadV2`を使用し、親メッセージの`thread_ts`へ投稿します。

## Discord設定

Discord Developer PortalでBotを作成し、次を設定します。

- Privileged Gateway Intentsの`Message Content Intent`を有効化
- Botを対象Guildへ追加
- 対象チャンネルに以下の権限を付与
  - View Channel
  - Read Message History
  - Send Messages
  - Create Public Threads
  - Send Messages in Threads
  - Add Reactions
  - Attach Files
- `unity_ci_0`〜`unity_ci_9`など10個のカスタム絵文字を作成
- 絵文字IDを`discord.statusEmojiIds`へ設定

許可条件は、`allowedUserIds`との一致、または`allowedRoleIds`のいずれかを所持していることです。両方空の設定は拒否されます。

Discordでは親メッセージからpublic threadを作成します。すでにスレッドがある場合は既存スレッドを使い、投稿時にアーカイブ済みなら解除を試みます。

`discord.nativeUploadLimitBytes`の初期値は保守的に10 MiBです。実際に許可された値へ変更できますが、API側が拒否した場合は配送失敗として扱います。外部Artifact Storeが未実装の初期版では、直接添付上限を超えたAPKはDiscordへ配送されません。

## 主な設定

```json
{
  "dataDir": "/Users/unity-ci/Library/Application Support/unity-chatops-builder",
  "repository": {
    "alias": "my-unity-project",
    "sshUrl": "git@github.com:example/my-unity-project.git",
    "allowedBranchPatterns": ["^(suu|feature|fix|release)/.+$"],
    "useGitLfs": "auto"
  },
  "unity": {
    "editorsRoot": "/Applications/Unity/Hub/Editor",
    "buildTimeoutMinutes": 90,
    "allowedBuildProfiles": [
      "Assets/BuildProfiles/PICO-Development.asset"
    ]
  },
  "artifacts": {
    "maxBytes": 1000000000,
    "successfulRetentionDays": 3,
    "failedRetentionDays": 1,
    "logsRetentionDays": 14
  }
}
```

### `repository.useGitLfs`

- `auto`: `.gitattributes`に`filter=lfs`があれば`git lfs pull`
- `always`: 必ずGit LFSを実行
- `never`: Git LFSを明示的に無効化

### Secret reference

1つのsecretにつき、`env`または`file`を必ず片方だけ指定します。

```json
{ "env": "SLACK_BOT_TOKEN" }
```

```json
{ "file": "/Users/unity-ci/.config/unity-chatops-builder/slack-bot-token" }
```

環境変数から読み込んだsecretは、取得直後にこのプロセスの`process.env`から削除します。GitとUnityの子プロセスには、token、secret、password、主要クラウド認証名に一致する環境変数を引き継ぎません。

## データ配置

`dataDir`以下に生成します。

```text
jobs.sqlite3                 SQLiteジョブDB
repositories/<alias>.git    bare mirror
workspaces/<job-id>/         実行中ジョブのworktree
artifacts/<job-id>/          APK
logs/<job-id>/unity.log      Unityログ
locks/runner.lock            多重起動防止
```

SQLiteはWAL、`synchronous=FULL`で運用します。同一プラットフォーム・チャンネル・元メッセージIDには一意制約があり、イベント再送から二重ビルドを防ぎます。

Runner停止時に`RUNNING`だったジョブは、次回起動時に設定回数までキューへ戻します。Unityプロセスの途中再開は行わず、コミットの再解決とworktree作成からやり直します。

## launchdで常駐

`launchd/com.0suu.unity-chatops-builder.plist.example`を環境に合わせて編集します。特にNode、リポジトリ、設定ファイル、ログ出力先の絶対パスを変更してください。

```bash
mkdir -p "$HOME/Library/Logs/unity-chatops-builder"
cp launchd/com.0suu.unity-chatops-builder.plist.example \
  "$HOME/Library/LaunchAgents/com.0suu.unity-chatops-builder.plist"

launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.0suu.unity-chatops-builder.plist"
launchctl kickstart -k "gui/$(id -u)/com.0suu.unity-chatops-builder"
```

停止と解除:

```bash
launchctl bootout "gui/$(id -u)/com.0suu.unity-chatops-builder"
```

テンプレートは`caffeinate -i`経由で起動し、プロセス稼働中のアイドルスリープを抑止します。ノートMacの蓋を閉じた状態など、OS側で強制されるスリープ条件は別途調整が必要です。

launchdからSSHする場合、対話的なパスフレーズ入力はできません。対象リポジトリだけを読み取れるGitHub Deploy Keyと`~/.ssh/config`の利用を推奨します。

## セキュリティ上の重要事項

指定ブランチに含まれるUnity Editorコードやpackageは、ビルドMac上で実行され得ます。つまり、許可したユーザーが指定できるブランチは、そのMac上でコードを実行できるものとして扱う必要があります。

最低限、次を守ってください。

- 専用macOSユーザーで実行
- SSHキーは対象リポジトリの読み取り専用Deploy Key
- 個人データや不要な社内credentialをRunnerへ置かない
- 許可チャンネル・ユーザー・ロールを限定
- ブランチprefixを正規表現で限定
- Build Profileを許可リストで限定
- Bot tokenとUnity/Git実行環境を可能な限り分離
- Android署名情報をGitへコミットしない

詳細は`docs/ARCHITECTURE.md`を参照してください。

## テスト

```bash
npm run check
```

構文検査に加え、Node標準test runnerで以下を検証します。

- 要求パーサーと入力制約
- Build Profile path検証
- 設定検証
- SQLite重複排除と再起動復旧
- ローカルGit remoteを使ったSHA解決・worktree作成
- Unityバージョン・Build Profile確認
- APK形状のZIP検証とSHA-256
- 受付からキュー登録まで
- Workerのビルド・検証・配送・ステージ`9`までの統合フロー

Slack、Discord、Unity Editorの実サービスを使うend-to-end testは、tokenと実Unityプロジェクトが必要なため自動テストには含めていません。GitHub ActionsではNode.js 24をセットアップし、同じ`npm run check`を実行します。

## 初期版の制限

- 固定GitHubリポジトリ1つ
- Unity同時ビルド1
- Slack／Discordへの直接添付のみ
- S3、R2、署名URLなどの外部Artifact Storeなし
- Web管理画面、キャンセル、優先度、再配送コマンドなし
- Unity Library共有キャッシュなし
- GitHub Commit Status／Check Run連携なし
