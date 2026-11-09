# Email reports: how they send, and bounces and complaints (W2-10)

| Item | Value |
|---|---|
| Status | Built on branch `w2-email`. Design answers from the master are in the table below. Nothing has been created in AWS. |
| Cards | P6-03 (session-end report), P6-04 (weekly report), P6-05 (settings and unsubscribe), the sending side of P6-02 |
| PRD | C6 req 2 to 5, N1, N8, N12, D20, D26, PD7 |
| Code | `frontdoor/email/` (sending, look, wording, Owner alert), `frontdoor/reports/` (reports, loop, pages) |

## Words used here

- **Bounce**: the receiving mail server refuses the email, for example because the address does not exist.
- **Complaint**: the person marks the email as spam.
- **Suppression list**: a list SES keeps of addresses that bounced or complained. SES does not deliver to them.
- **Event destination**: a setting on a configuration set that sends SES events (bounces, complaints) somewhere else, for example to an SNS topic.
- **SNS**: Amazon's message service. A topic can post each message to a web address.
- **IAM user and policy**: an AWS login for a program, and the list of what it may do.

## How a report goes out

1. The front door logs active study time in `study_time` (PD1, P3-02).
2. Every 5 minutes, the report loop looks at each student who turned a report on.
3. **Session report:** a sitting is a run of study with no gap over 30 minutes, in any tutor session. Once the student has been idle 30 minutes, the loop claims that sitting once in `report_sends`, reads the student's record from their own tutor server, and sends the email. Sittings under 5 minutes, and time outside any tutor session, get no report. Only sittings that ended in the last 12 hours are sent, so a restart sends nothing old.
4. **Weekly report:** from Monday 08:00 school time, for 48 hours, the loop claims last week (Monday to Sunday) once per student who studied 5 minutes or more that week, and sends it.
5. If reading the record or sending fails, the claim is undone and the next pass tries again, 3 times at most while the front door runs.
6. Dates and weeks use the school's time zone, America/Los_Angeles (Salinas, KSNS).

Every email has the N8 label at the top and the bottom, a plain-text part, an unsubscribe link, and the `List-Unsubscribe` and `List-Unsubscribe-Post` headers. The unsubscribe link opens a page with one button. Opening the page changes nothing, because mail scanners open links. Mail apps' own Unsubscribe button (Gmail, Apple Mail) posts to the same address and turns the report off in one click (RFC 8058). Neither needs a login. The token in the link is the student's random `report_settings.unsubscribe_token` (64 hex characters), so no new secret is needed.

The settings page is `/account/reports`. One address for both reports, which can be the student's or their CFI's (C6 req 3, D20). The box starts with the student's login email from Clerk. Both reports start off.

## Design answers

| # | Question | Answer | By |
|---|---|---|---|
| 1 | One session report per chat, or per study sitting? | _pending_ (built: per sitting, migration `20261108001000_report_sends_sitting.sql`) | |
| 2 | Idle time that ends a session | _pending_ (built: 30 minutes) | |
| 3 | Weekly timing | _pending_ (built: Monday 08:00 school time, 48-hour window, skip empty weeks) | |
| 4 | Time zone | _pending_ (built: America/Los_Angeles) | |
| 5 | One address or two | _pending_ (built: one) | |
| 6 | Unsubscribe token and click | _pending_ (built: the database token; a page with a button, plus RFC 8058 one-click) | |
| 7 | Owner alert email vs D15 | _pending_ (built: sends only when `OWNER_ALERT_EMAIL` is set) | |
| 8 | Settings page and its link | _pending_ (built: `/account/reports`, served by the gateway) | |
| 9 | Railway variable names | _pending_ (built: as below) | |

## Bounces and complaints

The tutor shares flynorth's AWS account and Region. SES watches the bounce and complaint rates of the whole account. If they get too high, AWS can pause sending for the account, which would stop flynorth's email too. So bad addresses must stop getting mail quickly.

### Now (no code): the SES suppression list

Erick turns this on in the SES console. It is part of the steps below.

- On the configuration set `ground-tutor-reports`, under **Suppression list settings**, override the account-level settings and suppress both **Bounces** and **Complaints**. (Or confirm the account-level suppression list already covers both.)
- SES then stops delivering to an address after a hard bounce or a complaint. Our code needs no change: SES drops the message itself.
- What it does not do: the student is not told. The report stays on in the settings, and nothing arrives.

### Follow-up (not built): turn the report off and tell the student

1. Add an event destination on `ground-tutor-reports` for Bounce (permanent only) and Complaint, to a new SNS topic.
2. Subscribe a new front door address (for example `/account/ses-events`) to the topic over HTTPS.
3. That endpoint checks each SNS message's signature (SNS signs every message; the code must fetch and check SNS's signing certificate), confirms the subscription once, and then turns off both reports for the bounced or complaining address.
4. The settings page shows a note: "Reports to this address could not be delivered. Check the address and turn them on again."

It is not built here because it needs a new outside setup (the SNS topic), a public endpoint with signature checks, and a new database column for the note. About a day of work. It should land before many students turn reports on.

## Permission for the sending key (IAM)

The key in Railway should be able to send only, only from `reports@ground.flynorthaero.com`, only through this identity and configuration set. A policy for a new IAM user (for example `ground-tutor-ses-sender`), with `<region>` and `<account-id>` filled in:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendTutorReportsOnly",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": [
        "arn:aws:ses:<region>:<account-id>:identity/ground.flynorthaero.com",
        "arn:aws:ses:<region>:<account-id>:configuration-set/ground-tutor-reports"
      ],
      "Condition": {
        "StringEquals": { "ses:FromAddress": "reports@ground.flynorthaero.com" }
      }
    }
  ]
}
```

Not checked against the AWS docs in this session. While the Region is in the sandbox, SES may also check permission on the verified test recipient. If a test send answers `AccessDenied`, add that address's identity ARN to `Resource` for the test, then remove it.

## Railway variables (new)

| Name | What it is for | Secret | Required |
|---|---|---|---|
| `SES_REGION` | The AWS Region of flynorth's SES, for example `us-west-2` (SES checklist, step 0) | No | To send email |
| `SES_ACCESS_KEY_ID` | The IAM user's access key ID | Yes | To send email |
| `SES_SECRET_ACCESS_KEY` | The IAM user's secret access key | Yes | To send email |
| `OWNER_ALERT_EMAIL` | Where Owner alert emails go (cost alert, autopause). Unset: no alert email (D15) | No | No |
| `FRONTDOOR_PUBLIC_URL` | The site address in email links. Default `https://ground.flynorthaero.com`. Staging sets its own address | No | Staging only |

With none of the three SES variables set, email is off: the front door starts, logs "email: off", and report settings still save. With only some of them set, the front door refuses to start and names what is missing. Outside production nothing is ever sent. Tenant servers never get these variables (they get only an allowlist).

## SES steps left for Erick

1. Run `docs/decisions/2026-11-08-ses-checklist.md`, steps 0 to 7 (Region, configuration set, identity, five DNS records, verification, test message, sandbox, DMARC).
2. On the configuration set `ground-tutor-reports`, turn on the suppression list for bounces and complaints (above).
3. In IAM, create the user `ground-tutor-ses-sender` with only the policy above, and create one access key for it.
4. In Railway, set `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, and optionally `OWNER_ALERT_EMAIL`. On staging, also set `FRONTDOOR_PUBLIC_URL` to the staging address.
5. Redeploy, and look for the log line `email: Amazon SES`.
6. C6 acceptance test: on staging, open `/account/reports`, turn on the session report to your own address, study 5 minutes or more, stop, and wait about 35 minutes. The report should arrive. In Gmail, "Show original" should show DKIM PASS, and Gmail should show its own Unsubscribe link.
7. Before the sandbox request (checklist step 6), check that its sample text still matches: reports are off until the student turns them on, every email has an unsubscribe link, and bounces and complaints go to the suppression list.
