# Dynamic Repository Selection

## Input

```text
unity-build
repository: organization/project
branch: feature/example
project: projects/client
profile: Assets/BuildProfiles/PICO-Development.asset
```

`repository`は要求ごとに必須です。`repo`も同義です。
`project`はRepository内のUnityプロジェクトルートへの相対pathで、省略時は`.`です。`profile`はそのUnityプロジェクトを基準にした`Assets/...` pathです。

## Resolution

```text
Chat input
  ↓ normalize
RepositoryReference
  id: github.com/organization/project
  sshUrl: git@github.com:organization/project.git
  ↓
RepositorySourceResolver
  ↓ Coordinator accountによるSSH clone/fetch
Commit SHA
  ↓ LFS materialization
Read-only Source Snapshot
  ↓
Worker
```

Repositoryごとに異なるbare mirrorを使います。

```text
dataDir/repositories/<repository-name>-<repository-id-sha256-prefix>.git
```

owner違いや同名Repositoryでmirrorが衝突しません。各jobはキュー投入前にCommit SHAとSource Snapshot IDへ固定されます。

## Access decision

専用Repository登録表は使用しません。次の両方を満たすRepositoryを利用できます。

1. Repository hostが`repositoryAccess.allowedHosts`に含まれる
2. CoordinatorのmacOS userがSSH clone/fetchできる

アクセス不能時はSource解決を失敗させ、Workerへjobを渡しません。

## Policy

初期版ではGit host allowlist、branch pattern、任意のBuild Profile allowlist、Git LFS制限、submodule禁止、Artifact上限、timeoutを全Repository共通で適用します。Repository別overrideはこの変更には含めませんが、将来Coordinator側へ追加してもWorker契約は変わりません。
