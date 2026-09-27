# Security policy

## What this covers

This policy covers the Nitjsefnie/Overflow repository and the deployed instance it serves.
Security fixes land on `main` and reach the deployed instance through the [deployment procedure](deploy/README.md).

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Nitjsefnie/Overflow/security/advisories/new).
This is the only route for reporting a vulnerability. Do not open a public issue for a vulnerability, and do not disclose it publicly before a fix is available.

## Acceptable testing

Test only against a local instance you run yourself.
Never test against the live instance at <https://overflow.nitjsefni.eu>, or against other people's accounts or repositories.
The live instance holds sponsors' GitHub OAuth tokens and GitLab personal access tokens.

## What happens after a report

The maintainer, Nitjsefnie, reviews the report and decides the response and any notification.
The [operator runbook](deploy/incident-response.md) covers operational response.
There is no response-time guarantee and no bounty program.

## Out of scope here

Conduct problems go to the public tracker per [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
How work is claimed, priced and settled is [CONTRIBUTING.md](CONTRIBUTING.md)'s subject.
