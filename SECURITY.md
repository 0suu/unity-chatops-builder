# Security Policy

## Trust model

許可されたbranchのUnity Editor codeはRunner user権限で実行され得る。対象Repositoryと要求者は信頼境界内である必要がある。

## Coordinator / Worker boundary

Coordinator配下の`RepositorySourceResolver`だけが次を利用できる。

- Repository読み取りcredential
- SSH Agent
- Git credential helper
- GitHub Token
- Git LFS Authorization Header
- LFS用一時credential
- LFS network access

Workerへ渡す入力は、検証済みread-only Source SnapshotのIDとBuild Requestだけである。Worker processにはGit/LFS credentialを継承させず、Workspaceに`.git`、`.lfsconfig`由来credential、Git configを含めない。

## Git LFS

- LFS pointerのversion、OID SHA-256、sizeをstrictに検証する。
- objectは一時fileへdownloadし、size/hash検証後だけatomic renameでcacheへ公開する。
- hash/size mismatch objectをWorkspaceへ渡さない。
- `.lfsconfig`は既定で拒否する。
- LFS endpoint、object URL、redirect URLはHTTPS、host allowlist、private address rejectionを通す。
- URL内credentialを拒否する。
- cross-origin redirectではAuthorization、Cookie、Proxy-Authorizationを転送しない。
- Snapshot公開完了まではProtection LeaseでobjectをGCから保護する。

## Recommended deployment

- 専用macOS user
- read-only GitHub Deploy Key
- allowlisted channel/user/role/branch/profile
- unnecessary personal/corporate credentialをRunnerへ置かない
- Runner userに管理者権限を与えない
- Artifactとlogのretentionを設定する
- OS update、Node.js、Unity versionを管理する

Security issueには、影響範囲、再現条件、対象commit、logのsecret除去済み抜粋を含めること。公開Issueへtokenやprivate URLを投稿しないこと。
