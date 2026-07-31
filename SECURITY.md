# Security

## Threat model

A Unity build can execute Editor scripts and package code from the selected Git branch. Anyone authorized to submit a branch should therefore be treated as having code-execution capability inside the Runner account.

## Required deployment controls

- Run under a dedicated, non-administrator macOS account.
- Use a read-only GitHub Deploy Key restricted to the target repository.
- Keep Slack and Discord tokens in owner-readable files outside the repository.
- Restrict accepted channels, users, roles, branch patterns, and Build Profiles.
- Do not store unrelated credentials or personal data in the Runner account.
- Do not commit Android keystores or passwords.
- Keep macOS, Node.js, Git, Unity, Slack Bolt, and discord.js patched.

The process removes configured environment-backed chat secrets after loading and filters token-, secret-, password-, and major cloud-provider-prefixed variables from Git and Unity child environments. This is defense in depth, not a sandbox: branch code can still access files and services available to the Runner user.

## Reporting

Do not open a public issue containing tokens, private repository data, build logs with credentials, or a working exploit. Contact the repository owner privately first.
