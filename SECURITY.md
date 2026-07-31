# Security Policy

## Trust model

チャット要求からRepositoryを選択できますが、未信頼コードを安全に実行するsandboxではありません。指定branchのUnity Editor script、Package、build hookはRunner user権限で実行され得ます。要求者と対象Repositoryの両方を信頼境界内に置いてください。

## Dynamic Repository selection

Repository入力は次の順序で処理します。

1. `owner/repository`または対応するGitHub URLとして解析
2. `repositoryAccess.allowedHosts`と一致するhostだけを許可
3. URL内credential、query、fragment、非SSH/HTTPS schemeを拒否
4. 認証情報を含まないSSH URLへ正規化
5. Coordinator userのSSH資格情報でclone/fetch
6. refをimmutable Commit SHAへ固定
7. `.git`を含まないSource SnapshotをWorkerへ渡す

「SSH accountがアクセスできるRepository」はビルド可能ですが、「任意hostへSSH接続できる」という意味にはしません。任意host入力は内部network探索やcredential送信につながるため、host allowlistを必須とします。

## Coordinator / Worker boundary

CoordinatorだけがRepository読み取りcredential、SSH Agent、Git credential helper、GitHub Token、LFS Authorization Header、Git/LFS network accessを利用します。Worker processへこれらを継承させず、Workspaceへ`.git`やGit configを含めません。

## Git LFS

- pointerのversion、OID SHA-256、sizeをstrictに検証
- 一時fileのsize/hash検証後だけatomic renameでcacheへ公開
- hash/size mismatch objectをWorkspaceへ渡さない
- `.lfsconfig`は既定拒否
- endpoint、object URL、redirect URLをHTTPS、host allowlist、private address rejectionへ通す
- URL内credentialを拒否
- cross-origin redirectでAuthorization等を転送しない
- Snapshot公開完了までProtection LeaseでGCから保護

## Recommended deployment

- Coordinator／Worker専用macOS user
- ビルド用途に限定したread-only SSH credential
- 許可channel、user、roleのallowlist
- 必要なGit hostだけの`repositoryAccess.allowedHosts`
- 未信頼Forkや第三者Repositoryを実行しない
- Runner userに管理者権限を与えない
- OSまたはnetwork側でもoutbound connectionを制限する

公開Issueへtoken、private URL、SSH情報を投稿しないでください。
