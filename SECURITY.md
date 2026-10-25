# Security policy

Citadel gives access to terminals and credentials on the machine it runs on, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub: [Report a vulnerability](https://github.com/maksymhs/Citadel/security/advisories/new).

Include what you found, the version (`citadel status`), how to reproduce it and the impact you expect. You will get a first answer within a few days. Fixes ship in a new release and the advisory credits you unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. Update with `citadel update`.

## Scope and known limits

Citadel does not sandbox projects from each other, and a terminal is a shell with the rights of the service account. These limits are documented in [docs/security.md](docs/security.md) and are not vulnerabilities by themselves. Reports about weaknesses in authentication, session handling, the credential vault, the pairing flow, path validation or the installer are very welcome.
