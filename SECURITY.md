# Security

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Advisories → Report a vulnerability** on
[this repository](https://github.com/philoking/Sumline/security/advisories/new). That keeps the
report private until there is something to upgrade to.

Please don't open a public issue or pull request for a security problem.

This is a hobby project maintained by one person, so an honest expectation: you should hear back
within about a week. If something is being actively exploited and you have had no reply, opening a
public issue that says only *that* you have reported something privately is fair.

There is no bounty. Credit in the advisory and in the release notes if you want it.

## What is in scope

The engine, the server, the web app, and the images and compose files in this repository. In
particular: anything that gets at a sheet without the password on an instance that has one,
anything that reaches outside `DATA_DIR` or the static root, and anything that turns a line typed
into a sheet into code running on the server.

Note that `POST /api/evaluate` evaluates user input in the server process by design. That is the
endpoint's purpose, not a finding — but a line that escapes the evaluator and reaches the host is
very much a finding.

## What is already known, and is not a vulnerability

These are documented decisions, not oversights. Reporting them is welcome only if you have found
that one of them is *worse* than described.

- **No authentication by default.** An instance with no `SUMLINE_PASSWORD` lets anyone who can
  reach the port read and edit every sheet in every space. That is the default and stays the
  default, for a trusted LAN.
- **No TLS, and the session cookie is not marked `Secure`.** A self-hosted instance is commonly
  reached over plain HTTP, and marking it would make signing in impossible there. On plain HTTP
  the password and the cookie both cross the network in the clear. Put it behind a reverse proxy
  that terminates TLS if that matters to you.
- **One shared password, not accounts.** Spaces say which sheets you are looking at, not whether
  you may. Anyone who signs in reaches every space.
- **`/api/health` is reachable without the password.** The deploy's health gate polls it. It
  discloses that the app is up and which date its exchange rates carry.
- **Sign-in throttling is per address and in memory.** It stops the password form being
  enumerated. It is forgotten on restart and says nothing about many addresses trying once each.
- **Sessions cannot be revoked individually.** There is no server-side session list, because
  revoking one browser would need identities and there are none. Changing the password invalidates
  every outstanding session at once.

[The password, if you want one](README.md#the-password-if-you-want-one) in the README covers the
same ground in more detail.

## Supported versions

The tip of `main` is the only supported version. Fixes go there and to the image built from it;
there are no maintenance branches.
