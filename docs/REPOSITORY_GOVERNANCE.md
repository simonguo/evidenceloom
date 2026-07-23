# GitHub repository governance

Apply this checklist to `simonguo/evidenceloom` only after the local release gates, signing prerequisites, and formal trademark review are complete. Create the repository as private, push only the one-commit snapshot produced by `scripts/create_public_snapshot.sh`, and never mirror the private repository.

## Repository features and security

- Enable Issues, dependency graph, Dependabot alerts and security updates, secret scanning, push protection, and private vulnerability reporting.
- Disable Wiki and Discussions for the beta launch.
- Set Actions' default workflow token permission to read-only and disallow Actions from approving pull requests.
- Keep the repository private until every security check available to the account passes. CodeQL runs for public repositories, or for private repositories where GitHub Advanced Security is enabled and the repository variable `ENABLE_PRIVATE_CODEQL=true` is set. Without that private-repository entitlement, make the repository public only after every other release gate passes, immediately enable code scanning, and require a successful CodeQL run before creating a tag or Release. Re-run secret scanning after changing visibility to public.
- Do not copy private Actions logs, branches, tags, releases, environments, deploy keys, webhooks, or repository secrets.

## `main` protection

Configure a branch ruleset for `main` with:

- pull requests required;
- at least one approving review;
- Code Owner review required for owned paths;
- all conversations resolved;
- required status checks from CI, Security, and CodeQL;
- branch required to be current before merge;
- linear history required;
- force pushes and branch deletion blocked;
- repository administrators allowed to bypass only for documented emergencies.

Use squash or rebase merges and automatically delete merged head branches. External commits must contain a `Signed-off-by` trailer as required by the DCO; the `DCO sign-off` CI job enforces this for every pull-request commit.

## Release controls

- Create protected environments for macOS and Windows signing secrets.
- Limit release workflow write access to `contents`, `id-token`, and `attestations` as declared in the workflow.
- Require the release tag to point to the protected `main` branch.
- Do not publish a platform artifact when its signing certificate, timestamp, notarization, or verification step is unavailable. Unsigned test installers may be retained as clearly labeled GitHub Actions artifacts, but must not be attached to a GitHub Release.

Record the final ruleset export and repository security-settings screenshots in the private release record, not in the public repository.
