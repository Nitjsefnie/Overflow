import { readFile } from "node:fs/promises";
import MarkdownIt from "markdown-it";
import { expect, it } from "vitest";

const canonicalInstall = "npm_config_package_import_method=copy pnpm install --frozen-lockfile";
const otherPnpmShapes = [
  /^pnpm (?:--version|db:migrate|build|test|lint|typecheck)$/,
  /^NEXT_DIST_DIR="\$release" pnpm build$/,
  /^pnpm release:switch \/srv\/overflow "\$(?:release|previous_release)" --expect-current (?:absent|"\$expected_serving")$/,
  /^pnpm release:prune \/srv\/overflow --keep [1-9][0-9]*$/,
  // The package-manager version is the deploy script's business
  // (fleet-rules, "Merging and CI"): an exact pnpm release, nothing else.
  /^corepack prepare pnpm@\d+\.\d+\.\d+ --activate$/,
];

// This is a closed vocabulary, not a shell interpreter. Every logical shell
// line must match a reviewed shape, including lines with no literal pnpm.
// Keep substitutions, redirections and control flow literal here: allowing an
// arbitrary argument could conceal a new command substitution or shell body.
const otherShellLines = new Set([
  "cp -a /etc/systemd/system/overflow.service /root/overflow.service.pre-hardening",
  "groupadd --system overflow",
  "useradd --system --gid overflow --home-dir /srv/overflow   --shell /usr/sbin/nologin --no-create-home overflow",
  "cd /tmp",
  "curl -fsSLO https://nodejs.org/dist/v24.17.0/node-v24.17.0-linux-x64.tar.xz",
  "curl -fsSLO https://nodejs.org/dist/v24.17.0/SHASUMS256.txt",
  "grep node-v24.17.0-linux-x64.tar.xz SHASUMS256.txt | sha256sum --check",
  "mkdir -p /usr/local/lib/nodejs",
  "tar -xJf node-v24.17.0-linux-x64.tar.xz -C /usr/local/lib/nodejs",
  "mv /usr/local/lib/nodejs/node-v24.17.0-linux-x64 /usr/local/lib/nodejs/node-v24.17.0",
  "ln -sfn /usr/local/lib/nodejs/node-v24.17.0/bin/node /usr/local/bin/node",
  "/usr/local/bin/node --version",
  "ln -sfn /usr/local/lib/nodejs/node-v24.17.0/bin/corepack /usr/local/sbin/corepack",
  "corepack enable --install-directory /usr/local/sbin",
  "install -d -o root -g root -m 0700 /etc/overflow",
  "[ -e /etc/overflow/overflow.env ]   || install -o root -g root -m 0600 /dev/null /etc/overflow/overflow.env",
  "chown root:root /etc/overflow/overflow.env",
  "chmod 0600 /etc/overflow/overflow.env",
  "set -e",
  "git clone https://github.com/Nitjsefnie/Overflow.git /srv/overflow",
  "cd /srv/overflow",
  "set -a; . /etc/overflow/overflow.env; set +a",
  "release=\".next-release-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=7 HEAD)\"",
  "mkdir \"$release\"",
  "node scripts/release.ts prepare /srv/overflow \"$release\"",
  "chown -R root:overflow /srv/overflow",
  "chmod -R u=rwX,g=rX,o= /srv/overflow",
  "mkdir -p \"$release/cache\"",
  "chown -R overflow:overflow \"$release/cache\"",
  "chmod -R u=rwX,g=rX,o= \"$release/cache\"",
  "test -d /srv/overflow/.next",
  "test ! -L /srv/overflow/.next",
  "node scripts/release.ts check /srv/overflow \"${release:?}\"",
  "rm -rf -- /srv/overflow/.next",
  "systemctl restart overflow.service",
  "systemctl show overflow.service -p MainPID --value > /run/overflow-preswitch-mainpid",
  "install -o root -g root -m 0644   /srv/overflow/deploy/overflow.service /etc/systemd/system/overflow.service",
  "systemd-analyze verify /etc/systemd/system/overflow.service",
  "systemctl daemon-reload",
  "systemctl enable overflow.service",
  "systemctl is-active overflow.service",
  // Sections 7, 9 and 10 verify through the readiness endpoint (issue 439);
  // section 8's old-unit rollback test keeps the landing-page URL on purpose.
  // Sections 7 and 10 also run the sign-in smoke beside readiness (issue 649).
  "curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1   --retry-connrefused -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/api/readiness",
  "curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1   --retry-connrefused -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/api/auth/providers",
  "curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1   --retry-connrefused -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/",
  "printf 'MainPID before the switch: %s\\nMainPID now:               %s\\n'   \"$(cat /run/overflow-preswitch-mainpid)\"   \"$(systemctl show overflow.service -p MainPID --value)\"",
  "systemctl show overflow.service   -p MainPID -p User -p Group -p NoNewPrivileges -p ProtectSystem",
  "ps -o user=,pid=,args= -p \"$(systemctl show overflow.service -p MainPID --value)\"",
  "journalctl -u overflow.service -n 100 --no-pager",
  "missing=0",
  "for path in /root/overflow.service.pre-hardening /root/overflow             /root/.nvm/versions/node/v24.17.0/bin/pnpm; do",
  "if [ -e \"$path\" ]; then",
  "echo \"present: $path\"",
  "else",
  "echo \"MISSING: $path\" >&2",
  "missing=1",
  "fi",
  "done",
  "[ \"$missing\" = 0 ]   || echo \"No rollback is available. Fix the hardened unit forward instead.\" >&2",
  "systemctl stop overflow.service",
  "cp -a /root/overflow.service.pre-hardening /etc/systemd/system/overflow.service",
  "systemctl start overflow.service",
  "printf 'MainPID before the rollback: %s\\nMainPID now:                 %s\\n'   \"$(cat /run/overflow-preswitch-mainpid)\"   \"$(systemctl show overflow.service -p MainPID --value)\"",
  "systemctl status overflow.service --no-pager",
  "previous_release='.next-release-REPLACE-WITH-RECORDED-ID'",
  "test -f \"$previous_release/BUILD_ID\"",
  "test -d \"$previous_release/cache\"",
  "chown -R overflow:overflow \"$previous_release/cache\"",
  "chmod -R u=rwX,g=rX,o= \"$previous_release/cache\"",
  "git fetch origin main",
  "exec 9>/run/overflow-deploy.lock",
  "flock -w 900 9 || { echo \"Could not acquire the deploy lock on /run/overflow-deploy.lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running.\" >&2; exit 1; }",
  "expected_serving=$(readlink -f /srv/overflow/.next || printf absent)",
  "previous_release=$(readlink -f /srv/overflow/.next)",
  "serving_cache=\"$previous_release/cache\"",
  "test -d \"$serving_cache\"",
  "find /srv/overflow -path \"$serving_cache\" -prune -o   -exec chown -h root:overflow {} +",
  "find /srv/overflow -path \"$serving_cache\" -prune -o   ! -type l -exec chmod u=rwX,g=rX,o= {} +",
  "printf 'Previous build: %s\\nNew build: %s\\n' \"$previous_release\" \"$release\"",
  "install -d -m 0700 /var/log/overflow",
  "upgrade_log=\"/var/log/overflow/webhook-upgrade-$release.jsonl\"",
  "upgrade_status=0",
  'pnpm --silent webhooks:upgrade > "$upgrade_log" 2>&1 || upgrade_status=$?',
  "cat \"$upgrade_log\"",
  "printf 'Webhook upgrade log: %s\\nWebhook upgrade exit status: %s\\n' \"$upgrade_log\" \"$upgrade_status\"",
  "test \"$upgrade_status\" -eq 0 || exit \"$upgrade_status\"",
  "rm -rf -- node_modules",
  "set -o pipefail",
  "LC_ALL=C find /srv/overflow -regextype posix-extended -mindepth 1 -maxdepth 1   -type d -regex '.*/\\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}'   -printf '%f\\n' | LC_ALL=C sort -r",
  // Section 11's key rotation: the pre-rotation dump, the guarded key-file and
  // environment-file edits (run in subshells so a refusal keeps the operator's
  // shell), the re-encryption runs with their captured statuses, and the
  // credential repairs run through the service's own DATABASE_URL.
  "bash scripts/db-backup.sh",
  "(",
  "test ! -e /etc/overflow/token-encryption-key.new || { echo \"Refusing: token-encryption-key.new already exists.\" >&2; exit 1; }",
  "install -o root -g root -m 0600 /dev/null /etc/overflow/token-encryption-key.new",
  "node -e \"process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))\" > /etc/overflow/token-encryption-key.new",
  "wc -c < /etc/overflow/token-encryption-key.new",
  ")",
  "grep -Eqx '[A-Za-z0-9_-]{43}' /etc/overflow/token-encryption-key.new || { echo \"Refusing: token-encryption-key.new does not hold a 43-character key.\" >&2; exit 1; }",
  "test -z \"$(tail -c 1 /etc/overflow/overflow.env)\" || { echo \"Refusing: overflow.env does not end with a newline.\" >&2; exit 1; }",
  "test \"$(grep -c 'TOKEN_ENCRYPTION_KEY_PREVIOUS' /etc/overflow/overflow.env)\" = 0 || { echo \"Refusing: overflow.env already names TOKEN_ENCRYPTION_KEY_PREVIOUS.\" >&2; exit 1; }",
  "test \"$(grep -c 'TOKEN_ENCRYPTION_KEY' /etc/overflow/overflow.env)\" = 1 || { echo \"Refusing: overflow.env must name TOKEN_ENCRYPTION_KEY on exactly one line.\" >&2; exit 1; }",
  "grep -Eqx 'TOKEN_ENCRYPTION_KEY=[A-Za-z0-9_-]{43}' /etc/overflow/overflow.env || { echo \"Refusing: the TOKEN_ENCRYPTION_KEY value is not bare.\" >&2; exit 1; }",
  "test ! -e /etc/overflow/token-encryption-key.old || { echo \"Refusing: token-encryption-key.old already exists.\" >&2; exit 1; }",
  "install -o root -g root -m 0600 /dev/null /etc/overflow/token-encryption-key.old",
  "sed -n 's/^TOKEN_ENCRYPTION_KEY=//p' /etc/overflow/overflow.env > /etc/overflow/token-encryption-key.old",
  "sed -i 's/^TOKEN_ENCRYPTION_KEY=/TOKEN_ENCRYPTION_KEY_PREVIOUS=/' /etc/overflow/overflow.env",
  "{ printf 'TOKEN_ENCRYPTION_KEY='; cat /etc/overflow/token-encryption-key.new; printf '\\n'; } >> /etc/overflow/overflow.env",
  "test \"$(sed -n 's/^TOKEN_ENCRYPTION_KEY=//p' /etc/overflow/overflow.env)\" = \"$(cat /etc/overflow/token-encryption-key.new)\" || { echo \"The edited file does not read back as the saved keys; roll back as below.\" >&2; exit 1; }",
  "test \"$(sed -n 's/^TOKEN_ENCRYPTION_KEY_PREVIOUS=//p' /etc/overflow/overflow.env)\" = \"$(cat /etc/overflow/token-encryption-key.old)\" || { echo \"The edited file does not read back as the saved keys; roll back as below.\" >&2; exit 1; }",
  "rm /etc/overflow/token-encryption-key.new",
  "check_status=0",
  "pnpm --silent credentials:reencrypt --check || check_status=$?",
  "printf 'Check exit status: %s\\n' \"$check_status\"",
  "reencrypt_status=0",
  "pnpm --silent credentials:reencrypt || reencrypt_status=$?",
  "printf 'Re-encryption exit status: %s\\nCheck exit status: %s\\n' \"$reencrypt_status\" \"$check_status\"",
  "row_id='REPLACE-WITH-REPORTED-ID'",
  "psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -c \"update users set encrypted_oauth_token = null where id = '$row_id'\"",
  "psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -c \"update user_forge_identities set encrypted_token = null where id = '$row_id'\"",
  "psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -c \"update registered_repositories set webhook_credential_id = null, encrypted_webhook_secret = null, webhook_configured_at = null where id = '$row_id' and unregistered_at is null\"",
  "sed -i '/^TOKEN_ENCRYPTION_KEY_PREVIOUS=/d' /etc/overflow/overflow.env",
  "test \"$(grep -c 'TOKEN_ENCRYPTION_KEY' /etc/overflow/overflow.env)\" = 2 && test \"$(grep -c '^TOKEN_ENCRYPTION_KEY=' /etc/overflow/overflow.env)\" = 1 || { echo \"Refusing: overflow.env does not hold exactly the two key lines step 3 wrote.\" >&2; exit 1; }",
  "test \"$(sed -n 's/^TOKEN_ENCRYPTION_KEY_PREVIOUS=//p' /etc/overflow/overflow.env)\" = \"$(cat /etc/overflow/token-encryption-key.old)\" || { echo \"Refusing: the previous key does not match token-encryption-key.old.\" >&2; exit 1; }",
  "sed -i -e '/^TOKEN_ENCRYPTION_KEY=/d' -e 's/^TOKEN_ENCRYPTION_KEY_PREVIOUS=/TOKEN_ENCRYPTION_KEY=/' /etc/overflow/overflow.env",
  "test \"$(grep -c 'TOKEN_ENCRYPTION_KEY' /etc/overflow/overflow.env)\" = 1 || { echo \"Refusing: overflow.env does not name the key exactly once; token-encryption-key.old is kept.\" >&2; exit 1; }",
  "test \"$(sed -n 's/^TOKEN_ENCRYPTION_KEY=//p' /etc/overflow/overflow.env)\" = \"$(cat /etc/overflow/token-encryption-key.old)\" || { echo \"Refusing: the key does not match token-encryption-key.old, which is kept.\" >&2; exit 1; }",
  "rm /etc/overflow/token-encryption-key.old",
  "test \"$(grep -c 'TOKEN_ENCRYPTION_KEY' /etc/overflow/overflow.env)\" = 2 && test \"$(grep -c '^TOKEN_ENCRYPTION_KEY=' /etc/overflow/overflow.env)\" = 1 && test \"$(grep -c '^TOKEN_ENCRYPTION_KEY_PREVIOUS=' /etc/overflow/overflow.env)\" = 1 || { echo \"Refusing: overflow.env does not hold exactly one current and one previous key line.\" >&2; exit 1; }",
  "sed -i -e 's/^TOKEN_ENCRYPTION_KEY_PREVIOUS=/TOKEN_ENCRYPTION_KEY=/' -e t -e 's/^TOKEN_ENCRYPTION_KEY=/TOKEN_ENCRYPTION_KEY_PREVIOUS=/' /etc/overflow/overflow.env",
  "psql \"$DATABASE_URL\" -tAc \"select count(*) from registered_repositories where unregistered_at is not null and webhook_credential_id is not null\"",
  "psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -c \"update registered_repositories set webhook_credential_id = null, encrypted_webhook_secret = null, webhook_configured_at = null where unregistered_at is not null and webhook_credential_id is not null\"",
  // Section 12's failure alerts: the mail-daemon and recipient-file
  // prerequisite checks, the recipient file's creation in the shape section 4
  // uses for overflow.env, the three-unit install, the OnFailure= readback,
  // the throwaway-instance test message with its journal and exim readback,
  // and the rollback's template removal.
  "systemctl is-active exim4",
  "test -s /etc/overflow/alert-recipient && echo \"recipient file present\"",
  "[ -e /etc/overflow/alert-recipient ] || install -o root -g root -m 0600 /dev/null /etc/overflow/alert-recipient",
  "printf '%s\\n' '<address>' > /etc/overflow/alert-recipient",
  "chown root:root /etc/overflow/alert-recipient",
  "chmod 0600 /etc/overflow/alert-recipient",
  "install -o root -g root -m 0644 /srv/overflow/deploy/overflow-alert@.service /etc/systemd/system/",
  "install -o root -g root -m 0644 /srv/overflow/deploy/overflow.service /etc/systemd/system/",
  "install -o root -g root -m 0644 /srv/overflow/deploy/overflow-backup.service /etc/systemd/system/",
  "systemctl show overflow.service overflow-backup.service -p OnFailure",
  "systemctl start overflow-alert@test.service",
  "zcat -f /var/log/exim4/mainlog* | grep -F \"$(cat /etc/overflow/alert-recipient)\" | grep -oE 'T=[a-z_]+' | sort | uniq -c",
  "zcat -f /var/log/exim4/mainlog* | grep 'T=address_file' | grep -cF \"$(cat /etc/overflow/alert-recipient)\"",
  "ls -l /var/mail/mail",
  "grep -c '^From ' /var/mail/mail",
  "zcat -f /var/log/exim4/mainlog* | grep -c 'T=address_file'",
  "journalctl -u overflow-alert@test.service --no-pager -n 20",
  "tail -n 20 /var/log/exim4/mainlog",
  "rm /etc/systemd/system/overflow-alert@.service",
  // Section 12's canary subsection: the second prerequisite check, the
  // webhook file's creation in the same shape as the recipient file's, the
  // two-unit install with the timer's enable, the healthy run and its
  // readbacks, the closed-port probe that must produce the out-of-band
  // report, and the rollback's removal of both files.
  "test -s /etc/overflow/canary-recipient && echo \"recipient file present\"",
  "test -s /etc/overflow/canary-discord-webhook && echo \"webhook file present\"",
  // The canary reads the exim mainlog as a member of adm and refuses every run
  // without it, so the check is a prerequisite beside the two host files rather
  // than a comment: the directive is in the unit's pinned set, and a host whose
  // installed unit predates it says nothing about the relay and explains
  // nothing. The match is exact because --value prints an empty line with exit
  // 0 when the directive is unset, and because -w would pass a drifted copy
  // that had picked up a second group.
  "systemctl show overflow-alert@test.service -p SupplementaryGroups --value | grep -qx adm && echo \"the alert unit reads the exim log as a member of adm\" || echo \"the alert unit is NOT in group adm - every alert will wait out its budget, report that it did not leave this host, and record no throttle state\"",
  "systemctl show overflow-canary.service -p SupplementaryGroups --value | grep -qx adm && echo \"canary reads the exim log as a member of adm\" || echo \"the canary is NOT in group adm - every run will refuse with the log named as unreadable\"",
  "install -o root -g root -m 0600 /dev/null /etc/overflow/canary-recipient",
  "printf '%s\\n' '<address>' > /etc/overflow/canary-recipient",
  "chown root:root /etc/overflow/canary-recipient",
  "chmod 0600 /etc/overflow/canary-recipient",
  "install -o root -g root -m 0600 /dev/null /etc/overflow/canary-discord-webhook",
  "printf '%s\\n' '<webhook-url>' > /etc/overflow/canary-discord-webhook",
  "chown root:root /etc/overflow/canary-discord-webhook",
  "chmod 0600 /etc/overflow/canary-discord-webhook",
  "install -o root -g root -m 0644 /srv/overflow/deploy/overflow-canary.service /etc/systemd/system/",
  "install -o root -g root -m 0644 /srv/overflow/deploy/overflow-canary.timer /etc/systemd/system/",
  "systemctl enable --now overflow-canary.timer",
  "systemctl list-timers overflow-canary.timer --no-pager",
  "systemctl start overflow-canary.service",
  "journalctl -u overflow-canary.service --no-pager -n 20",
  "tail -n 5 /var/log/exim4/mainlog",
  "test ! -e /run/overflow-canary/dead && echo \"no outage recorded\"",
  "cp /srv/overflow/scripts/overflow-canary.sh /tmp/canary-probe.sh",
  "chmod +x /tmp/canary-probe.sh",
  "OVERFLOW_CANARY_SMTP_URL=smtp://127.0.0.1:1 OVERFLOW_CANARY_STATE_DIR=/tmp/canary-probe-state /bin/sh /tmp/canary-probe.sh",
  "rm /tmp/canary-probe.sh",
  "rm -rf /tmp/canary-probe-state",
  "systemctl show overflow-canary.service -p ExecStart -p Environment",
  "systemctl disable --now overflow-canary.timer",
  "rm /etc/systemd/system/overflow-canary.timer",
  "rm /etc/systemd/system/overflow-canary.service",
  // The sandbox egress proof: a busy-port precondition that stops the step
  // rather than announcing itself, a drop-in redirecting both paths so the
  // host's own webhook file is never read, a recording listener on loopback,
  // an explicit wait for it to bind before the unit posts, and the removal of
  // every artefact afterwards.
  "ss -ltn | grep 18099 && echo \"port 18099 is BUSY - stop, pick another port and re-run this step\" || echo \"port 18099 is free\"",
  "ls -l --time-style=full-iso /var/log/exim4/mainlog /var/log/exim4/mainlog.1",
  // The only step in the procedure that establishes the configured webhook is
  // live. The URL is read from the host file into a variable and never echoed;
  // --fail is what keeps a 404 or a revoked token from reading as success.
  "webhook=$(cat /etc/overflow/canary-discord-webhook)",
  "printf '%s' '{\"content\":\"[overflow-canary] section 12 verification post - the failure-alert canary is being installed and this webhook is live.\"}' | curl -sS --fail --max-time 15 --connect-timeout 5 -H 'Content-Type: application/json' --data-binary @- \"$webhook\" -o /dev/null -w 'webhook answered %{http_code}\\n'",
  "install -d -o root -g root -m 0755 /etc/systemd/system/overflow-canary.service.d",
  "printf '%s\\n' 'http://127.0.0.1:18099/probe' > /etc/overflow/canary-sandbox-probe-webhook",
  "rm -f /etc/overflow/canary-sandbox-probe-received",
  "printf '%s\\n' '[Service]' 'Environment=OVERFLOW_CANARY_SMTP_URL=smtp://127.0.0.1:1' 'Environment=OVERFLOW_CANARY_WEBHOOK_FILE=/etc/overflow/canary-sandbox-probe-webhook' > /etc/systemd/system/overflow-canary.service.d/sandbox-probe.conf",
  "python3 -c \"import http.server as h;H=type('H',(h.BaseHTTPRequestHandler,),{'do_POST':lambda s:(open('/etc/overflow/canary-sandbox-probe-received','ab').write(s.rfile.read(int(s.headers['Content-Length']))),s.send_response(200),s.end_headers()),'log_message':lambda *a:None});h.HTTPServer(('127.0.0.1',18099),H).serve_forever()\" &",
  "for _ in $(seq 1 15) ; do sleep 1 ; ss -ltn | grep -q 18099 && break ; done",
  "ss -ltn | grep -q 18099 || { echo \"the listener did not bind 127.0.0.1:18099 after 15 attempts (about 16s) - stop and read the python error above\" ; false ; }",
  "grep -q failure-alert /etc/overflow/canary-sandbox-probe-received && echo \"sandbox reached the out-of-band channel\" || echo \"the listener received no report - see the journal above\"",
  "rm /etc/systemd/system/overflow-canary.service.d/sandbox-probe.conf",
  "rmdir /etc/systemd/system/overflow-canary.service.d",
  "rm /etc/overflow/canary-sandbox-probe-webhook",
  "rm -f /etc/overflow/canary-sandbox-probe-received",
  "systemctl show overflow-canary.service -p Environment",
  // BOTH state files: a canary that was refusing leaves canary-fault behind, and
  // a run that finds it refuses again and posts nothing, so clearing only the
  // dead marker would re-create the silence inside the procedure meant to end
  // it.
  "rm -f /run/overflow-canary/dead /run/overflow-canary/canary-fault",
  // Section 12's bounce-watcher subsection: the two alias-presence prerequisite
  // checks, the idempotent alias appends and `newaliases`, the two-unit
  // install with the timer's enable, the routing readbacks for both sender
  // addresses and for the alert recipient, the offset-initializing first run
  // and the synthetic DSN's sendmail one-shot with its mainlog readback, and
  // the rollback's removal of timer, units, aliases and state.
  "grep -q '^overflow-canary:' /etc/aliases && echo \"overflow-canary alias already present\" || echo \"overflow-canary alias absent\"",
  "grep -q '^overflow-alert:' /etc/aliases && echo \"overflow-alert alias already present\" || echo \"overflow-alert alias absent\"",
  "grep -q '^overflow-canary:' /etc/aliases || printf '%s\\n' 'overflow-canary: root' >> /etc/aliases",
  "grep -q '^overflow-alert:' /etc/aliases || printf '%s\\n' 'overflow-alert: root' >> /etc/aliases",
  "newaliases",
  "install -o root -g root -m 0644 /srv/overflow/deploy/overflow-bounce.service /etc/systemd/system/",
  "install -o root -g root -m 0644 /srv/overflow/deploy/overflow-bounce.timer /etc/systemd/system/",
  "systemctl enable --now overflow-bounce.timer",
  "systemctl list-timers overflow-bounce.timer --no-pager",
  "exim4 -bt overflow-canary@\"$(hostname -f)\"",
  "exim4 -bt overflow-alert@\"$(hostname -f)\"",
  "exim4 -bt \"$(cat /etc/overflow/alert-recipient)\"",
  "systemctl start overflow-bounce.service",
  "journalctl -u overflow-bounce.service --no-pager -n 20",
  "printf '%s\\n' 'Subject: [overflow] synthetic delivery-failure notification (verification)' '' 'This message was created automatically by mail delivery software.' '' 'A delivery-failure notification arrived for overflow-canary@ - verification marker' | sendmail root",
  "systemctl disable --now overflow-bounce.timer",
  "rm /etc/systemd/system/overflow-bounce.timer",
  "rm /etc/systemd/system/overflow-bounce.service",
  "sed -i -e '/^overflow-canary:/d' -e '/^overflow-alert:/d' /etc/aliases",
  "rm -rf /var/lib/overflow-bounce",
  // Section 14's Ledger App private-key rotation (issue 1032): the fingerprint
  // computation GitHub's documentation prescribes (three spellings, one per
  // key file the procedure fingerprints), the guarded key-file moves, the
  // restart is section 7's already above, and the relay and reconciliation
  // verifications under the new key.
  "test \"$(id -u)\" = 0 || { echo \"Refusing: run as root.\" >&2; exit 1; }",
  "test ! -e /etc/overflow/github-app/private-key.pem.rotation-backup || { echo \"Refusing: private-key.pem.rotation-backup already exists; finish or roll back the interrupted rotation first.\" >&2; exit 1; }",
  "printf 'old key fingerprint: '",
  "openssl rsa -in /etc/overflow/github-app/private-key.pem -pubout -outform DER | openssl sha256 -binary | openssl base64",
  "cp -p /etc/overflow/github-app/private-key.pem /etc/overflow/github-app/private-key.pem.rotation-backup",
  "test \"$(openssl rsa -in /etc/overflow/github-app/private-key.pem.rotation-backup -pubout -outform DER | openssl sha256 -binary | openssl base64)\" = \"$(openssl rsa -in /etc/overflow/github-app/private-key.pem -pubout -outform DER | openssl sha256 -binary | openssl base64)\" || { echo \"Refusing: the rollback copy does not match the live key.\" >&2; exit 1; }",
  "scp /local/path/to/the-downloaded.pem root@DEPLOY-HOST:/etc/overflow/github-app/private-key.new.pem",
  "test -s /etc/overflow/github-app/private-key.new.pem || { echo \"Refusing: private-key.new.pem is missing or empty; run the transfer above first.\" >&2; exit 1; }",
  "chown root:root /etc/overflow/github-app/private-key.new.pem",
  "chmod 0600 /etc/overflow/github-app/private-key.new.pem",
  "openssl rsa -in /etc/overflow/github-app/private-key.new.pem -check -noout || { echo \"Refusing: private-key.new.pem is not a readable RSA private key.\" >&2; exit 1; }",
  "printf 'new key fingerprint: '",
  "openssl rsa -in /etc/overflow/github-app/private-key.new.pem -pubout -outform DER | openssl sha256 -binary | openssl base64",
  "test -e /etc/overflow/github-app/private-key.pem.rotation-backup || { echo \"Refusing: private-key.pem.rotation-backup is missing; run step 1 first.\" >&2; exit 1; }",
  "test -s /etc/overflow/github-app/private-key.new.pem || { echo \"Refusing: private-key.new.pem is missing; run step 2 first.\" >&2; exit 1; }",
  "old_fp=$(openssl rsa -in /etc/overflow/github-app/private-key.pem -pubout -outform DER | openssl sha256 -binary | openssl base64)",
  "new_fp=$(openssl rsa -in /etc/overflow/github-app/private-key.new.pem -pubout -outform DER | openssl sha256 -binary | openssl base64)",
  "test \"$new_fp\" != \"$old_fp\" || { echo \"Refusing: private-key.new.pem holds the same key as the live file.\" >&2; exit 1; }",
  "cat /etc/overflow/github-app/private-key.new.pem > /etc/overflow/github-app/private-key.pem",
  "test \"$(openssl rsa -in /etc/overflow/github-app/private-key.pem -pubout -outform DER | openssl sha256 -binary | openssl base64)\" = \"$new_fp\" || { echo \"The replaced file does not read back as the staged key; restore from the rollback copy as Rolling back describes.\" >&2; exit 1; }",
  "gh secret set LEDGER_APP_KEY --repo Nitjsefnie/Overflow --env overflow-ledger < /etc/overflow/github-app/private-key.new.pem",
  "gh secret list --repo Nitjsefnie/Overflow --env overflow-ledger",
  "gh workflow run ledger-relay.yml --repo Nitjsefnie/Overflow",
  "run_id=$(gh run list --repo Nitjsefnie/Overflow --workflow ledger-relay.yml --limit 1 --json databaseId --jq '.[0].databaseId')",
  "printf 'relay probe run: %s\\n' \"$run_id\"",
  "gh run watch \"$run_id\" --repo Nitjsefnie/Overflow --exit-status",
  "gh api 'repos/Nitjsefnie/Overflow/commits/MERGE-COMMIT-SHA/check-runs?filter=all&per_page=100' --paginate --jq '.check_runs[] | select(.app.id == 5118623) | {name: .name, status: .status, conclusion: .conclusion}'",
  "pnpm reconcile --repository Nitjsefnie/Overflow",
  "psql \"$DATABASE_URL\" -tAc \"select status, completed_at is not null from reconciliation_runs where id = 'REPLACE-WITH-THE-RUNID'\"",
  "rm /etc/overflow/github-app/private-key.new.pem /etc/overflow/github-app/private-key.pem.rotation-backup",
  "test -e /etc/overflow/github-app/private-key.pem.rotation-backup || { echo \"Refusing: private-key.pem.rotation-backup is missing; there is nothing to restore from.\" >&2; exit 1; }",
  "cat /etc/overflow/github-app/private-key.pem.rotation-backup > /etc/overflow/github-app/private-key.pem",
  "test \"$(openssl rsa -in /etc/overflow/github-app/private-key.pem -pubout -outform DER | openssl sha256 -binary | openssl base64)\" = \"$(openssl rsa -in /etc/overflow/github-app/private-key.pem.rotation-backup -pubout -outform DER | openssl sha256 -binary | openssl base64)\" || { echo \"The restored file does not read back as the rollback copy.\" >&2; exit 1; }",
].map((line) => tokenizeLines(line)[0].join(" ")));

// The manual fallback's expanded source-attestation gates are explicitly
// allowlisted here so this remains a closed shell vocabulary.
for (const line of [
  "full_sha=$ ( git rev-parse --verify 'FETCH_HEAD^{commit}' )",
  "ancestry_status=0",
  "git merge-base --is-ancestor HEAD \"${full_sha}\" || ancestry_status=$?",
  "if [ \"${ancestry_status}\" -eq 1 ] ; then",
  "printf 'HEAD in /srv/overflow is not an ancestor of the fetched main (%s), so it cannot fast-forward there; refusing to deploy. HEAD, the index and the working tree are untouched; only the fetched refs moved. Inspect git log %s..HEAD in the tree before re-running.\\n' \"${full_sha}\" \"${full_sha}\" > & 2",
  "exit 1",
  "elif [ \"${ancestry_status}\" -ne 0 ] ; then",
  "printf 'Could not determine whether HEAD in /srv/overflow is an ancestor of the fetched main (%s): git merge-base exited %s; refusing to deploy. HEAD, the index and the working tree are untouched; only the fetched refs moved. Investigate the repository state in the tree before re-running.\\n' \"${full_sha}\" \"${ancestry_status}\" > & 2",
  "exit 1",
  "tree_status=$ ( git status --porcelain=v1 -uall ) || {",
  "printf 'Could not read the working-tree state in /srv/overflow; refusing to build a release whose source identity cannot be attested. Investigate git status in the tree before re-running.\\n' > & 2",
  "exit 1",
  "}",
  "if [ -n \"${tree_status}\" ] ; then",
  "printf '%s\\n' \"${tree_status}\"",
  "printf 'The working tree in /srv/overflow deviates from HEAD; fast-forwarding it to %s would not make it that commit. A release is named for the commit it was built from; refusing to build one from a tree that is not that commit. Resolve every deviation above (git status), then re-run the deploy.\\n' \"${full_sha}\" > & 2",
  "exit 1",
  "allowlist_re='^(\\.next/?|\\.claude/|\\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}/|\\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}\\.tsconfig\\.json|\\.next-release-notes/|next-env\\.d\\.ts|node_modules/)$'",
  "ignored_listing=$ ( mktemp )",
  "ignored_status=0",
  "git ls-files -z --others --ignored --exclude-standard --directory --no-empty-directory > \"${ignored_listing}\" || ignored_status=$?",
  "mapfile -d '' -t ignored_entries < \"${ignored_listing}\"",
  "rm -f \"${ignored_listing}\"",
  "if [ \"${ignored_status}\" -ne 0 ] ; then",
  "printf 'Could not list the ignored untracked files in /srv/overflow (git ls-files exited %s); refusing to build a release whose source identity cannot be attested. HEAD, the index and the working tree are untouched; only the fetched refs moved. Investigate git ls-files in the tree before re-running.\\n' \"${ignored_status}\" > & 2",
  "exit 1",
  "stray_ignored= ( )",
  "for entry in \"${ignored_entries[@]}\" ; do",
  "[[ \"${entry}\" =~ ${allowlist_re} ]] || stray_ignored+= ( \"${entry}\" )",
  "if [ \"${#stray_ignored[@]}\" -gt 0 ] ; then",
  "printf '  %q\\n' \"${stray_ignored[@]}\" > & 2",
  "printf 'The tree in /srv/overflow holds the ignored untracked files above, outside the operational allowlist (.next, .claude/, release directories and their .tsconfig.json sidecars, .next-release-notes/, next-env.d.ts and node_modules/, each at the tree root). These are ignored untracked files that git status does not show, and the build would compile them into a release named for %s, a commit that does not contain them; refusing to deploy. HEAD, the index and the working tree are untouched; only the fetched refs moved. Remove them, then re-run the deploy.\\n' \"${full_sha}\" > & 2",
  "exit 1",
  "remote_url=$ ( git config --get remote.origin.url )",
  "repo=",
  "case \"${remote_url}\" in",
  "git@github.com:* ) repo=\"${remote_url#git@github.com:}\" ; ;",
  "https://github.com/* ) repo=\"${remote_url#https://github.com/}\" ; ;",
  "esac",
  "repo=\"${repo%.git}\"",
  "repo_valid=0",
  "[[ \"${repo}\" =~ ^[^/]+/[^/]+$ ]] || repo_valid=$?",
  "if [ \"${repo_valid}\" -ne 0 ] ; then",
  "printf 'Could not parse an OWNER/REPO GitHub slug from remote.origin.url (%s); refusing to deploy.\\n' \"${remote_url}\" > & 2",
  "exit 1",
  "required_status=0",
  "required=$ ( gh api \"repos/${repo}/branches/main/protection\" --jq '([.required_status_checks.contexts[]?] + [.required_status_checks.checks[]?.context]) | unique | .[]' ) || required_status=$?",
  "if [ \"${required_status}\" -ne 0 ] || [ -z \"${required}\" ] ; then",
  "printf 'could not determine required checks for main; refusing to deploy\\n' > & 2",
  "exit 1",
  "check_runs_status=0",
  "check_runs=$ ( gh api \"repos/${repo}/commits/${full_sha}/check-runs?filter=all&per_page=100\" --paginate --jq '.check_runs[] | [.id, .name, .status, .conclusion] | @tsv' ) || check_runs_status=$?",
  "if [ \"${check_runs_status}\" -ne 0 ] ; then",
  "printf 'Could not read check runs for %s on %s; refusing to deploy.\\n' \"${repo}\" \"${full_sha}\" > & 2",
  "exit 1",
  "pending= ( )",
  "while IFS= read -r check ; do",
  "[ -n \"${check}\" ] || continue",
  "newest_id=0",
  "newest_status=",
  "newest_conclusion=",
  "while IFS=$'\\t' read -r id name status conclusion ; do",
  "[ \"${name}\" = \"${check}\" ] || continue",
  "[[ \"${id}\" =~ ^[0-9]+$ ]] || continue",
  "if [ \"${id}\" -gt \"${newest_id}\" ] ; then",
  "newest_id=$id",
  "newest_status=$status",
  "newest_conclusion=$conclusion",
  "done <<< \"${check_runs}\"",
  "if [ \"${newest_id}\" -eq 0 ] ; then",
  "pending+= ( \"${check} (absent)\" )",
  "elif [ \"${newest_status}\" != completed ] ; then",
  "pending+= ( \"${check} (${newest_status})\" )",
  "elif [ \"${newest_conclusion}\" != success ] ; then",
  "pending+= ( \"${check} (${newest_conclusion})\" )",
  "done <<< \"${required}\"",
  "if [ \"${#pending[@]}\" -gt 0 ] ; then",
  "printf '  %s\\n' \"${pending[@]}\" > & 2",
  "printf 'Required checks are absent, pending or unsuccessful on %s; refusing to deploy. Re-run the gates part of this block once CI completes.\\n' \"${full_sha}\" > & 2",
  "exit 1",
  "git merge --ff-only \"$full_sha\"",
  "serving_release=$ ( readlink -f /srv/overflow/.next || printf absent )",
  "if [ \"${serving_release}\" != absent ] && [ -f \"${serving_release}/REVISION\" ] ; then",
  "if [ \"$(cat \"${serving_release}/REVISION\")\" = \"${full_sha}\" ] ; then",
  "printf 'Already serving %s (%s); the tree fast-forwarded to the serving commit, so install, migrate and build are skipped and the existing release stays.\\n' \"${serving_release}\" \"${full_sha}\"",
  "exit 0",
  "npm_config_package_import_method=copy pnpm install --frozen-lockfile",
  "printf '%s\\n' \"$full_sha\" > \"$release/REVISION\"",
  "printf 'Source revision: %s\\n' \"$full_sha\"",
  `base=$ ( gh api 'repos/Nitjsefnie/Overflow/actions/workflows/ratchet-guard.yml/runs?branch=main&status=success&per_page=50' --jq '[.workflow_runs[] | select(.event == "push" or .event == "workflow_dispatch")][0].head_sha' )`,
  'gh workflow run ci.yml --ref main -f base="$base"',
  "gh workflow run actionlint.yml --ref main",
  'gh workflow run ratchet-guard.yml --ref main -f base="$base"',
  // Section 13's client-address verification steps (issue 1044): the secret
  // generation, the root-only include file carrying the proxy secret (the
  // vhost itself stays world-readable), the nginx validation, and the
  // journal check.
  "openssl rand -hex 32",
  "install -o root -g root -m 0600 /dev/null /etc/nginx/overflow-privileged-proxy.conf",
  "nginx -t && systemctl reload nginx",
  'journalctl -u overflow.service --no-pager -e | grep "Privileged action"',
]) otherShellLines.add(line);

function mentionsPnpm(text: string) {
  return text.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "").includes("pnpm");
}

function tokenizeLines(source: string): string[][] {
  const lines: string[][] = [[]];
  const lexer = /[ \t]+|(?:[^\s;&|()"'\\]+|"(?:[^"\\\r\n]|\\(?:\r?\n|[^\r\n]))*"|'[^'\r\n]*'|\\(?:\r?\n|[^\r\n]))+|&&|\|\||[;&|()]/y;
  let offset = 0;
  while (offset < source.length) {
    // Comments are recognized at word boundaries, before processing any
    // backslash in them. Their newline always ends the logical command.
    if (source[offset] === "#") {
      const newline = source.indexOf("\n", offset);
      offset = newline < 0 ? source.length : newline;
      continue;
    }
    const newline = /^\r?\n/.exec(source.slice(offset));
    if (newline) {
      lines.push([]);
      offset += newline[0].length;
      continue;
    }
    // A continuation before a word must not turn the next line's comment
    // into a word. Continuations within a word are consumed by the lexer.
    const continuation = /^\\\r?\n/.exec(source.slice(offset));
    if (continuation) {
      offset += continuation[0].length;
      continue;
    }
    lexer.lastIndex = offset;
    const match = lexer.exec(source);
    if (!match) throw new Error(`Unsupported shell token: ${source.slice(offset)}`);
    offset = lexer.lastIndex;
    if (!/^[ \t]+$/.test(match[0])) lines[lines.length - 1].push(match[0].replace(/\\\r?\n/g, ""));
  }
  return lines;
}

function validateBlock(info: string, body: string): number {
  if (!/^(?:bash|sh|shell)(?:\s|$)/.test(info)) {
    throw new Error(`Unsupported code fence: ${info || "(no language)"}`);
  }
  let installs = 0;
  for (const tokens of tokenizeLines(body)) {
    if (!tokens.length) continue;
    const line = tokens.join(" ");
    const source = line;
    const approvedArrayAppend = /(?:stray_ignored|pending)\+= \( ".+" \)$/.test(line);
    if (line.includes("<<") && !otherShellLines.has(line)) {
      throw new Error(`Unsupported shell syntax: Heredoc introducer: ${source}`);
    }
    if (line.includes("`")) throw new Error(`Unsupported shell syntax: Backtick substitution: ${source}`);
    let commandPosition = true;
    for (const token of tokens) {
      if (/^(?:[;&|()]|&&|\|\|)$/.test(token)) commandPosition = true;
      else if (commandPosition && token === "!") {
        throw new Error(`Unsupported pnpm shape (command negation): ${source}`);
      } else if (commandPosition && /^["'$\\]/.test(token) && !approvedArrayAppend) {
        throw new Error(`Unsupported shell syntax: Non-literal command word: ${token} in ${source}`);
      } else if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) commandPosition = false;
    }
    if (line === canonicalInstall) installs++;
    else if (!otherShellLines.has(line) && !otherPnpmShapes.some((shape) => shape.test(line))
      && !/^install -d \/[A-Za-z0-9_./-]+$/.test(line)) {
      throw new Error(`Unsupported ${mentionsPnpm(line) ? "pnpm" : "shell"} shape in ${info}: ${source}`);
    }
  }
  return installs;
}

// A real CommonMark tokenizer discovers code regions, so indented code, fenced
// code and code nested in lists or blockquotes are recognized exactly as a
// CommonMark renderer sees them, and installs can no longer hide behind
// structures the hand-rolled line parser did not model (issue 252). Everything
// else — paragraphs, headings, lists, blockquotes, inline code, raw HTML — is
// prose and never reaches the shell grammar.
const md = new MarkdownIt("commonmark");

function codeRegions(markdown: string): { info: string; lines: string[] }[] {
  const regions: { info: string; lines: string[] }[] = [];
  for (const token of md.parse(markdown, {})) {
    if (token.type === "fence" || token.type === "code_block") {
      // validateBlock's shell test only reads the info prefix, so a shell
      // name followed by arbitrary info would smuggle the install command
      // past the grammar. The old parser rejected that at the boundary and
      // the structural front end keeps the rejection.
      if (token.type === "fence" && mentionsPnpm(token.info)) {
        throw new Error(`Unsupported fence info: ${token.info.trim()}`);
      }
      const [start, end] = token.map ?? [0, 0];
      const content = token.content.replace(/\n$/, "");
      const contentLines = content === "" ? 0 : content.split("\n").length;
      // markdown-it ends an unclosed fence silently at the end of its
      // container or document. A closed fence's source range is exactly the
      // opening line, every content line and the closing line, so the range
      // spans contentLines + 2 lines; an unclosed fence has no closing line
      // and spans contentLines + 1. The counts never coincide, and empty
      // content is zero lines, not one empty line.
      if (token.type === "fence" && contentLines !== end - start - 2) {
        throw new Error(`Unsupported unclosed code fence: ${token.info.trim()}`);
      }
      regions.push({
        info: token.type === "fence" ? token.info.trim() : "shell (indented code)",
        lines: content === "" ? [] : content.split("\n"),
      });
    } else if (token.type === "html_block") {
      // An HTML comment that never closes within its HTML block runs until
      // the end of the container and can swallow a following code fence
      // without the tokenizer noticing (issue 252, payload three).
      if (token.content.includes("<!--") && !token.content.includes("-->")) {
        throw new Error("Unsupported unclosed HTML comment");
      }
      // CommonMark: an HTML block swallows everything up to its terminator,
      // so a code fence inside one never becomes a fence token and the closed
      // grammar never sees it (issue 400). A fence-looking line in any HTML
      // block — comments included — is structure, not prose, and is rejected
      // by name instead of being silently skipped.
      if (/`{3,}|~{3,}/.test(token.content)) {
        throw new Error(`Unsupported code fence inside an HTML block: ${token.content.split("\n")[0].trim()}`);
      }
      // A closed HTML comment may mention pnpm as prose, so only non-comment
      // blocks are held to the mention rule; the first line tells them apart.
      const firstLine = token.content.split("\n")[0].trimStart();
      if (!firstLine.startsWith("<!--") && mentionsPnpm(token.content)) {
        throw new Error(`Unsupported pnpm mention inside an HTML block: ${token.content.split("\n")[0].trim()}`);
      }
    }
  }
  return regions;
}

function validateDocument(markdown: string): number {
  return codeRegions(markdown).reduce((installs, region) => installs + validateBlock(region.info, region.lines.join("\n")), 0);
}

function validateDeploymentGuide(markdown: string): void {
  // Initial install, routine deploy, and the one-time dependency migration.
  const expectedInstalls = 3;
  const installs = validateDocument(markdown);
  if (installs !== expectedInstalls) {
    throw new Error(`Unsupported deployment install count: expected ${expectedInstalls} canonical copy-prefixed installs in code regions, found ${installs}`);
  }
}

it("requires the closed shell grammar and copy imports throughout the deployment guide", async () => {
  validateDeploymentGuide(await readFile("deploy/README.md", "utf8"));
});

it("requires the deploy serialization lines in their blocks, in order", async () => {
  const markdown = await readFile("deploy/README.md", "utf8");
  const blocks = codeRegions(markdown)
    .filter((region) => /^(?:bash|sh|shell)(?:\s|$)/.test(region.info))
    .map((region) => tokenizeLines(region.lines.join("\n"))
      .filter((tokens) => tokens.length)
      .map((tokens) => tokens.join(" ")));
  const exec = tokenizeLines("exec 9>/run/overflow-deploy.lock")[0].join(" ");
  const flock = tokenizeLines(
    'flock -w 900 9 || { echo "Could not acquire the deploy lock on /run/overflow-deploy.lock; refusing to deploy. '
    + "Consult the deploy procedure's serialization notes before re-running.\" >&2; exit 1; }",
  )[0].join(" ");
  const anchor = tokenizeLines("expected_serving=$(readlink -f /srv/overflow/.next || printf absent)")[0].join(" ");
  const deploy = blocks.find((lines) => lines.includes("git fetch origin main"));
  const rollback = blocks.find((lines) => lines.includes("previous_release='.next-release-REPLACE-WITH-RECORDED-ID'"));
  const prune = blocks.find((lines) => lines.some((line) => line.startsWith("pnpm release:prune")));
  expect(deploy, "section 10 deploy block").toBeDefined();
  expect(rollback, "section 9 rollback block").toBeDefined();
  expect(prune, "prune fence").toBeDefined();
  for (const [name, block, switchLine] of [
    ["deploy", deploy!, 'pnpm release:switch /srv/overflow "$release" --expect-current "$expected_serving"'],
    ["rollback", rollback!, 'pnpm release:switch /srv/overflow "$previous_release" --expect-current "$expected_serving"'],
  ] as const) {
    const [execAt, flockAt, anchorAt, switchAt] = [exec, flock, anchor, switchLine].map((line) => block.indexOf(line));
    expect(execAt, `${name} block must hold fd 9 open on the deploy lock`).toBeGreaterThanOrEqual(0);
    expect(flockAt, `${name} block must acquire the lock after opening fd 9`).toBeGreaterThan(execAt);
    expect(anchorAt, `${name} block must record expected_serving under the lock`).toBeGreaterThan(flockAt);
    expect(switchAt, `${name} block must switch only after the anchor exists`).toBeGreaterThan(anchorAt);
  }
  expect(prune!, "prune fence must re-lock fd 9 before pruning").toContain(flock);
  expect(prune!, "prune fence must not re-open fd 9, which releases the held lock").not.toContain(exec);
  const lines = blocks.flat();
  expect(lines.filter((line) => line === exec), "exactly the deploy and rollback blocks open fd 9").toHaveLength(2);
  expect(lines.filter((line) => line === flock), "deploy, rollback and prune fences lock fd 9").toHaveLength(3);
  expect(lines.filter((line) => line === anchor), "exactly the deploy and rollback blocks anchor expected_serving").toHaveLength(2);
});

it.each(["initial install", "routine deploy", "one-time migration"].flatMap((name, index) =>
  [false, true].map((removePrefix) => ({ name, index, removePrefix }))))(
  "rejects an unfenced $name (remove copy prefix: $removePrefix)", ({ index, removePrefix }) => {
    const blocks = [0, 1, 2].map((blockIndex) => {
      if (blockIndex !== index) return `\`\`\`bash\n${canonicalInstall}\n\`\`\``;
      return removePrefix ? "pnpm install --frozen-lockfile" : canonicalInstall;
    });
    expect(() => validateDeploymentGuide(blocks.join("\n\n")))
      .toThrow("Unsupported deployment install count: expected 3 canonical copy-prefixed installs in code regions, found 2");
  },
);

it.each([0, 4])("rejects a deployment guide with %i canonical installs", (count) => {
  const markdown = Array.from({ length: count }, () => `\`\`\`bash\n${canonicalInstall}\n\`\`\``).join("\n\n");
  expect(() => validateDeploymentGuide(markdown))
    .toThrow(`Unsupported deployment install count: expected 3 canonical copy-prefixed installs in code regions, found ${count}`);
});

it.each([
  ["<!-- comment -->\n    pnpm install --frozen-lockfile", "Unsupported pnpm shape"],
  ["[ref]: /url\n    pnpm install --frozen-lockfile", "Unsupported pnpm shape"],
  ["<!-- comment -->\n    $'p\\x6epm' install --frozen-lockfile", "Non-literal command word"],
])("validates indented code after a Markdown paragraph boundary: %s", (markdown, error) => {
  expect(() => validateDocument(markdown)).toThrow(error);
});

it.each(["<!-- comment -->", "[ref]: /url"])("accepts canonical indented code after %s", (boundary) => {
  expect(validateDocument(`${boundary}\n    ${canonicalInstall}`)).toBe(1);
});

it("ends a multiline HTML comment before recognizing indented code", () => {
  const comment = "<!--\nThe pnpm command below is only comment text.\n    pnpm install --frozen-lockfile\n-->";
  expect(validateDocument(`${comment}\n    ${canonicalInstall}`)).toBe(1);
  expect(() => validateDocument(`${comment}\n    pnpm install --frozen-lockfile`)).toThrow("Unsupported pnpm shape");
});

it("keeps inline comments and reference-like paragraph text in prose", () => {
  expect(validateDocument("The pnpm commands <!-- inline comment -->\n    copy package files into private inodes.")).toBe(0);
  expect(validateDocument("The pnpm commands\n[ref]: /url\n    copy package files into private inodes.")).toBe(0);
});

it.each([
  ["<!-- unclosed comment", "Unsupported unclosed HTML comment"],
  // CommonMark: the blockquote's unclosed HTML block swallows the fence line,
  // so the comment rule names it instead of a container error.
  ["> <!--\n```bash\npnpm install --frozen-lockfile\n```", "Unsupported unclosed HTML comment"],
  // CommonMark: markdown-it consumes `[ref]:\n/url` as a definition, so the
  // indented install is a genuine code region and the unprefixed shape is
  // rejected by the shell grammar.
  ["[ref]:\n/url\n    pnpm install --frozen-lockfile", "Unsupported pnpm shape"],
])("names unsupported Markdown boundary syntax: %s", (markdown, error) => {
  expect(() => validateDocument(markdown)).toThrow(error);
});

// Issue 252's payloads: an install hidden behind a Markdown structure the
// guard used to misparse. Each is appended, as its own block, to a document
// that would otherwise hold exactly the three canonical installs — and to the
// real README's text, which the guard reads without modifying it.
it.each([
  ["a processing-instruction boundary", "<?probe?>\n    pnpm install --frozen-lockfile\n", "Unsupported pnpm shape"],
  ["a multiline reference-definition title", '[ref]: /url\n  "title"\n    pnpm install --frozen-lockfile\n', "Unsupported pnpm shape"],
  ["an unclosed HTML comment opened in a list container", "- <!--\n```bash\npnpm install --frozen-lockfile\n```\n", "Unsupported unclosed HTML comment"],
])("rejects an install hidden behind $0", async (_name, payload, error) => {
  const synthetic = [0, 1, 2].map(() => `\`\`\`bash\n${canonicalInstall}\n\`\`\``).join("\n\n") + "\n";
  expect(() => validateDocument(synthetic + payload)).toThrow(error);
  const readme = await readFile("deploy/README.md", "utf8");
  expect(() => validateDocument(`${readme}\n${payload}`)).toThrow(error);
});

// Issue 400's payloads: CommonMark swallows everything up to an HTML block's
// terminator, so a code fence inside one never becomes a fence token and the
// closed grammar never sees it. Each payload is appended, as its own block, to
// a document that would otherwise hold exactly the three canonical installs —
// and to the real README's text, which the guard reads without modifying it.
it.each([
  ["a <div> HTML block swallowing a non-canonical fenced install", "<div>\n```text\npnpm install\n```\n</div>", "Unsupported code fence inside an HTML block"],
  ["a <script> HTML block swallowing a canonical fenced install", "<script>\n```bash\n" + canonicalInstall + "\n```\n</script>", "Unsupported code fence inside an HTML block"],
  ["an unclosed <script> swallowing a canonical fenced install", "<script>\n```bash\n" + canonicalInstall + "\n```\n", "Unsupported code fence inside an HTML block"],
  ["a <script> HTML block swallowing a ~~~-fenced install", "<script>\n~~~bash\n" + canonicalInstall + "\n~~~\n</script>", "Unsupported code fence inside an HTML block"],
  ["pnpm prose inside a <div> HTML block", "<div>\ndiscusses pnpm and its store\n</div>", "Unsupported pnpm mention inside an HTML block"],
])("rejects an install hidden behind $0", async (_name, payload, error) => {
  const synthetic = [0, 1, 2].map(() => `\`\`\`bash\n${canonicalInstall}\n\`\`\``).join("\n\n") + "\n";
  expect(() => validateDocument(synthetic + payload)).toThrow(error);
  const readme = await readFile("deploy/README.md", "utf8");
  expect(() => validateDocument(`${readme}\n${payload}`)).toThrow(error);
});

// The HTML-block checks must not disturb the closed-comment rule: a CLOSED
// comment may mention pnpm as prose, and the indented code after it is still
// judged by the grammar. Mirror of the pinned multiline-comment test.
it("keeps a closed HTML comment's pnpm prose and the code after it in prose", () => {
  const comment = "<!--\nThe pnpm command below is only comment text.\n    pnpm install --frozen-lockfile\n-->";
  expect(validateDocument(`${comment}\n    ${canonicalInstall}`)).toBe(1);
});

it.each(["bash", "sh", 'bash title="Install"', "shell"])("accepts canonical installs in %s fences", (info) => {
  expect(validateDocument(`\`\`\`${info}\n${canonicalInstall} # install packages\n\`\`\``)).toBe(1);
});

it("joins continuations before validating the canonical install", () => {
  const continued = canonicalInstall.replace("pnpm install", "pnpm \\\ninstall");
  expect(validateDocument(`\`\`\`bash\n${continued}\n\`\`\``)).toBe(1);
});

it("does not continue a command through a backslash inside a comment", () => {
  expect(() => validateDocument("```bash\npnpm --version # comment \\\npnpm install --frozen-lockfile\n```"))
    .toThrow("Unsupported pnpm shape");
});

it("rejects a constructed command in an indented code block", () => {
  expect(() => validateDocument("    $'p\\x6epm' install --frozen-lockfile"))
    .toThrow("Non-literal command word");
});

it("leaves ordinary prose mentioning pnpm alone", () => {
  expect(validateDocument("The documented pnpm commands copy package files into private inodes."))
    .toBe(0);
});

it.each([
  "pnpm --version # comment \\\n" + canonicalInstall,
  "# comment \\\n" + canonicalInstall,
  "pnpm --version \\\n# comment \\\n" + canonicalInstall,
])("preserves the next command after a comment: %s", (body) => {
  expect(validateDocument(`\`\`\`bash\n${body}\n\`\`\``)).toBe(1);
});

it.each(["    ", "\t", " \t", ">     ", "> >     "])("validates indented code with prefix %j", (prefix) => {
  expect(validateDocument(`${prefix}${canonicalInstall}`)).toBe(1);
  expect(() => validateDocument(`${prefix}pnpm install --frozen-lockfile`)).toThrow("Unsupported pnpm shape");
});

it("ends an indented code block before the next prose paragraph", () => {
  expect(validateDocument(`    ${canonicalInstall}\n\nThe pnpm install above uses copy.\n\n\`\`\`sh\n${canonicalInstall}\n\`\`\``)).toBe(2);
});

it.each([
  "Use `pnpm install --frozen-lockfile` with the documented prefix.",
  "pnpm install --frozen-lockfile",
  "The pnpm commands use ```bash fences and ~~~ fences.",
  "The documented pnpm commands\n    copy package files into private inodes.",
  "> The documented pnpm commands copy package files into private inodes.",
  "- The documented pnpm commands copy package files into private inodes.",
])("does not validate prose as code: %s", (prose) => {
  expect(validateDocument(prose)).toBe(0);
});

it.each([
  "pnpm install --frozen-lockfile",
  canonicalInstall.replace("=copy", "=hardlink"),
  "pnpm  install --frozen-lockfile",
  "pnpm \\\n install --frozen-lockfile",
  "pn\\\npm install --frozen-lockfile",
  `! ${canonicalInstall}`,
  `:; ! ${canonicalInstall}`,
  `:; \\\n ! ${canonicalInstall}`,
  'pnpm() { command pnpm --package-import-method=hardlink "$@"; }',
  "pnpm --package-import-method=hardlink install --frozen-lockfile",
  `${canonicalInstall} > /tmp/unsafe-install-log`,
  "npm_config_package_import_method='copy' pnpm install --frozen-lockfile",
])("rejects unsupported pnpm syntax: %s", (line) => {
  expect(() => validateDocument(`\`\`\`bash\n${line}\n\`\`\``)).toThrow("Unsupported pnpm shape");
});

it.each(["text", "python", ""])("rejects pnpm in an unrecognized %s fence", (info) => {
  expect(() => validateDocument(`\`\`\`${info}\n${canonicalInstall}\n\`\`\``)).toThrow("Unsupported code fence");
});

it("accepts pnpm version checks alongside Unix install without inventing a dependency install", () => {
  expect(validateDocument("```sh\npnpm --version\ninstall -d /tmp/example\n```\n")).toBe(0);
});

it("rejects unreviewed redirections without executing them", () => {
  expect(() => validateDocument(`~~~bash title="Install"\nprintf touched > /must-not-be-written\n${canonicalInstall}\n~~~`)).toThrow("Unsupported shell shape");
});

it("rejects an unclosed pnpm fence", () => {
  expect(() => validateDocument(`\`\`\`bash\n${canonicalInstall}`)).toThrow("Unsupported unclosed code fence");
});

it.each([
  [String.raw`$'p\x6epm' install --frozen-lockfile`, "Non-literal command word"],
  ['manager=pn; manager=${manager}pm; "$manager" install', "Non-literal command word"],
  ['"${manager}" install', "Non-literal command word"],
  ['`echo manager` install', "Backtick substitution"],
  [`: <<'INSTALL'\n${canonicalInstall}\nINSTALL`, "Heredoc introducer"],
  ["unrecognized-command anything", "Unsupported shell shape"],
])("rejects shell constructs even without literal pnpm: %s", (body, error) => {
  expect(() => validateDocument(`\`\`\`bash\n${body}\n\`\`\``)).toThrow(error);
});

it("discovers unsafe installs in blockquoted fences", () => {
  expect(() => validateDocument("> ```bash\n> pnpm install --frozen-lockfile\n> ```")).toThrow("Unsupported pnpm shape");
});

it("accepts canonical installs in nested blockquoted parameterized fences", () => {
  expect(validateDocument(`> > ~~~sh title="Install"\n> > ${canonicalInstall}\n> > ~~~`)).toBe(1);
});

it("rejects unsafe installs in code outside fences", () => {
  expect(() => validateDocument("    pnpm install --frozen-lockfile")).toThrow("Unsupported pnpm shape");
});

it("recognizes a new container after an indented code block ends", () => {
  expect(() => validateDocument("    pnpm --version\n>     $'p\\x6epm' install --frozen-lockfile"))
    .toThrow("Non-literal command word");
});

it.each(["***", "* * *", "___"])("recognizes indented code after a thematic break: %s", (boundary) => {
  expect(() => validateDocument(`Prose\n${boundary}\n    $'p\\x6epm' install --frozen-lockfile`))
    .toThrow("Non-literal command word");
});

it("uses list content indentation when distinguishing prose from code", () => {
  expect(validateDocument("- The documented pnpm commands\n\n    copy package files into private inodes."))
    .toBe(0);
  // CommonMark: the 6-space indented line is a real code region inside the
  // list item, so the closed grammar rejects the constructed command itself.
  expect(() => validateDocument("- The documented commands\n\n      $'p\\x6epm' install --frozen-lockfile"))
    .toThrow("Non-literal command word");
});

it("recognizes indented code on a list item's first line", () => {
  // CommonMark: a real indented code region, judged by the closed grammar.
  expect(() => validateDocument("-     $'p\\x6epm' install --frozen-lockfile"))
    .toThrow("Non-literal command word");
});

it("counts tabs at Markdown column stops inside containers", () => {
  expect(validateDocument(`>\t\t${canonicalInstall}`)).toBe(1);
  expect(validateDocument("> \tThe documented pnpm commands copy package files into private inodes.")).toBe(0);
});

it.each(["- ", "1. ", "> - ", "- > ", "> 1. > - "])("rejects a container-nested fence whose closer sits at column 0: %j", (prefix) => {
  // CommonMark: the col-0 closer never closes a container-nested fence, so
  // the fence is unclosed and the guard names that instead of a container.
  expect(() => validateDocument(`${prefix}\`\`\`sh\n$'p\\x6epm' install --frozen-lockfile\n\`\`\``))
    .toThrow("Unsupported unclosed code fence");
});

it.each(["text", "python", ""])("rejects constructed commands in unsupported %s fences", (info) => {
  expect(() => validateDocument(`\`\`\`${info}\n$'p\\x6epm' install --frozen-lockfile\n\`\`\``))
    .toThrow("Unsupported code fence");
});

it("rejects an unprefixed install in a list-nested fence", () => {
  // CommonMark: a properly closed list-nested fence is a real code region,
  // so the unprefixed install is rejected by the closed grammar itself.
  expect(() => validateDocument("- ```bash\n  pnpm install --frozen-lockfile\n  ```")).toThrow("Unsupported pnpm shape");
});

it("does not strip shell redirections as blockquote containers", () => {
  expect(() => validateDocument(`> \`\`\`bash\n> > ${canonicalInstall}\n> \`\`\``)).toThrow("Unsupported pnpm shape");
});

it("rejects a fence whose closing line leaves its blockquote container", () => {
  // CommonMark: fences have no lazy continuation, so the dropped `>` closes
  // the blockquote around an unclosed fence; the guard names the unclosed
  // fence instead of a container mismatch.
  expect(() => validateDocument(`> \`\`\`bash\n${canonicalInstall}\n> \`\`\``)).toThrow("Unsupported unclosed code fence");
});

it("rejects a shell-prefixed fence info carrying the install command", () => {
  // The info prefix satisfies validateBlock's shell test, so the pnpm-bearing
  // junk must be rejected in the structural front end, where the old parser
  // threw before the grammar ran.
  expect(() => validateDocument("```bash pnpm install --frozen-lockfile\n" + canonicalInstall + "\n```"))
    .toThrow("Unsupported fence info");
});

it("rejects a command substitution hidden in a familiar command's arguments", () => {
  expect(() => validateDocument('```bash\nmkdir "$(unrecognized-command)"\n```')).toThrow("Unsupported shell shape");
});

it("rejects a function override even when a later install is canonical", () => {
  expect(() => validateDocument(`\`\`\`bash\npnpm() { command pnpm --package-import-method=hardlink "$@"; }\n${canonicalInstall}\n\`\`\``)).toThrow("Unsupported pnpm shape");
});

it.each(["PATH=/tmp/wrapper-bin ", "CI=true ", "\v"])("rejects an unreviewed install prefix: %s", (prefix) => {
  expect(() => validateDocument(`\`\`\`bash\n${prefix}${canonicalInstall}\n\`\`\``)).toThrow(/Unsupported (?:pnpm shape|shell token)/);
});
