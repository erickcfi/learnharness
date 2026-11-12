# Amazon SES setup checklist for report email (C6 req 4 and 5, P6-02)

| Item | Value |
|---|---|
| Status | Done for staging and launch (2026-11-10 and 2026-11-11). See "What actually happened" below. The steps stay here so the setup can be checked or made again. |
| Card | P6-02 (SES identity and DNS records). Feeds P6-03 and P6-04 (the report emails) and the billing emails. |
| Sources | Amazon SES Developer Guide, read 2026-11-08 (list at the end); the Easy DKIM page read again 2026-11-11. The pages show no "last updated" date. |
| Who does it | Erick, in the AWS console and at the DNS host for `flynorthaero.com` (DreamHost). |

## What actually happened (2026-11-09 to 2026-11-11)

- **New AWS account.** flynorth has no SES (found 2026-11-09), so the tutor got its own AWS account.
- **Region `us-east-2` (US East, Ohio), not `us-west-2`.** The new account's AWS organization has a rule (a service control policy, SCP) that allows normal work only in `us-east-2` and denies SES in `us-west-2`. The rule was left alone. The app reads `SES_REGION`, so no code changed (master, 2026-11-10).
- **Identity** `ground.flynorthaero.com` with Easy DKIM, 2048-bit. Its default configuration set is `ground-tutor-reports`, which suppresses bounces and complaints.
- **DNS at DreamHost.** Claude in Chrome added the three DKIM CNAMEs and the SPF TXT for `bounce.ground.flynorthaero.com` (2026-11-10). All four resolve.
- **The bounce MX needed a different route.** DreamHost's DNS page cannot add an MX record to a subdomain: its form sends MX to the Custom MX page, which then covered only `flynorthaero.com` (Google Workspace). The route that worked: add `bounce.ground.flynorthaero.com` in the DreamHost panel as its own **DNS only** domain, then set that domain's custom MX on the **Custom MX** page: `10 feedback-smtp.us-east-2.amazonses.com`, exactly one MX. The SPF TXT stayed, and Google's MX for `flynorthaero.com` did not change (checked in public DNS, 2026-11-10). Sources: DreamHost knowledge base article 215035328, and Resend's DreamHost guide, which uses the same route for an SES feedback MX.
- **Custom MAIL FROM** `bounce.ground.flynorthaero.com`, behavior on MX failure: use the default MAIL FROM domain.
- **IAM user** `ground-tutor-ses-sender` with the inline send-only policy `send-tutor-email-only` (`docs/decisions/2026-11-08-email-reports.md`). Erick made its access key and put `SES_REGION=us-east-2`, `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY` into Railway staging himself (2026-11-10). Staging's next start logged `email: Amazon SES`.
- **Production access** (out of the sandbox) in `us-east-2`: granted 2026-11-11. (The decision log files it under 2026-11-10, Pacific time.) The request form had no box for the use case, so the prepared text in step 6 was kept for AWS's follow-up.
- **DMARC:** `flynorthaero.com` has `v=DMARC1; p=none;` (seen in public DNS, 2026-11-11). It covers `ground.flynorthaero.com`, which has no record of its own. Step 7 needs nothing more.
- **Not recorded yet:** step 5's test message with DKIM PASS (the C6 acceptance test).
- **At launch:** nothing in SES changes. Production uses the same identity and Region. See `docs/launch-runbook.md`, step A5.

## Settled values

| Setting | Value | Source |
|---|---|---|
| AWS account and Region | The tutor's own AWS account. Region code: `us-east-2` (US East, Ohio). The organization's SCP allows only this Region. | Master, 2026-11-09 and 2026-11-10 |
| Domain identity | `ground.flynorthaero.com`, with Easy DKIM (2048-bit, the default) | C6 req 4, N1 |
| From | `reports@ground.flynorthaero.com` (session reports) and `billing@ground.flynorthaero.com` (sign-up and renewal notices) | N1; billing emails, master 2026-11-08 |
| Reply-To | `info@flynorthaero.com` | PD7 |
| Custom MAIL FROM | `bounce.ground.flynorthaero.com` | C6 req 4 (the PRD's example name), plan approved 2026-11-08 |
| Configuration set | `ground-tutor-reports` | C6 req 5, plan approved 2026-11-08 |
| Behavior on MX failure | Use default MAIL FROM domain, so reports keep sending | Plan approved 2026-11-08 |

Rules from C6 req 5:

- No SES record goes on the name `ground.flynorthaero.com` itself. The website record stays as it is.
- `reports.flynorthaero.com` stays free for flynorth. Nothing here touches it.

## Words used here

- **DNS record**: one line in the domain's address book. It tells the internet where a name points.
- **CNAME**: a DNS record that says "this name is another name."
- **MX**: a DNS record that says which server takes mail for a name.
- **TXT**: a DNS record that holds a line of text, used here for email rules.
- **DKIM**: a digital signature on each email. It proves the mail came from our domain and was not changed.
- **SPF**: a TXT record that lists which servers may send mail for a name.
- **MAIL FROM** (also called Return-Path): the hidden address that bounces go back to. It is not the From address the student sees.
- **DMARC**: a TXT record that tells receiving mail servers what to do with mail that fails the DKIM and SPF checks.
- **Configuration set**: a named group of SES sending settings. Ours holds the tutor's bounce and complaint handling.
- **Sandbox**: the test mode every new SES Region starts in. It can only send to addresses you have verified.
- **SCP** (service control policy): a rule an AWS organization sets for its accounts, such as which Regions they may use.

## Step 0. Open the AWS account and pick the Region

1. Create an AWS account for the tutor at https://aws.amazon.com and sign in to the console. (flynorth has no SES, so there is no existing account to use.) Done 2026-11-10.
2. Open the SES console: https://console.aws.amazon.com/ses/
3. Pick the Region at the top right: `us-east-2` (US East, Ohio). The organization's SCP denies SES elsewhere, including `us-west-2`.
4. Every step below uses this Region. Records differ by Region, so do not switch Regions later.
5. A new account starts in the sandbox (**Account dashboard** shows "Your Amazon SES account is in the sandbox"), so step 6 is needed.

## Step 1. Create the configuration set

Do this first, so step 2 can make it the identity's default.

1. SES console > **Configuration sets** (under Configuration) > **Create set**.
2. **Configuration set name**: `ground-tutor-reports`. Names allow letters, numbers, hyphens and underscores, up to 64 characters.
3. Leave every other option at its default. (Reputation metrics are optional and add CloudWatch charges.)
4. Choose **Create set**.
5. Then, under **Suppression list settings**, suppress both **Bounces** and **Complaints** (`docs/decisions/2026-11-08-email-reports.md`).

## Step 2. Create the domain identity

1. SES console > **Verified identities** (under Configuration) > **Create identity**.
2. **Identity type**: Domain.
3. **Domain**: `ground.flynorthaero.com`
4. Check **Assign a default configuration set**. Pick `ground-tutor-reports`.
   - SES uses this set whenever the sending code names no other set.
5. Check **Use a custom MAIL FROM domain**.
   - **MAIL FROM domain**: `bounce.ground.flynorthaero.com` (if the box shows the parent domain already, type only `bounce`).
   - **Behavior on MX failure**: **Use default MAIL FROM domain**. If the bounce record ever breaks, SES sends from its own bounce domain instead of refusing the report.
   - **Publish DNS records to Route53**: leave it unchecked. The DNS for `flynorthaero.com` is at DreamHost.
6. Under **Verifying your domain**, open **Advanced DKIM settings**.
   - **Identity type**: Easy DKIM.
   - **DKIM signing key length**: RSA_2048_BIT (the default).
   - **Publish DNS records to Route53**: same rule as above.
   - **DKIM signatures**: Enabled must be checked.
7. Choose **Create identity**.
8. On the new identity's page, find the DNS records SES lists (the **Authentication** tab, **View DNS records**). You can also download them with **Download .csv record set**. Keep this page open for step 3.

## Step 3. Add five DNS records

Add these at DreamHost, the DNS host for `flynorthaero.com`. Copy each value from the SES console. Do not type the DKIM values by hand: the SES docs say the DKIM hosted zone "varies by AWS Region and can differ between identities."

| # | Type | Name (host) | Value | Priority | Job |
|---|---|---|---|---|---|
| 1 | CNAME | `<token1>._domainkey.ground.flynorthaero.com` | `<token1>.<SES's DKIM hosted zone>` (copy from SES) | | DKIM key 1 |
| 2 | CNAME | `<token2>._domainkey.ground.flynorthaero.com` | `<token2>.<SES's DKIM hosted zone>` (copy from SES) | | DKIM key 2 |
| 3 | CNAME | `<token3>._domainkey.ground.flynorthaero.com` | `<token3>.<SES's DKIM hosted zone>` (copy from SES) | | DKIM key 3 |
| 4 | MX | `bounce.ground.flynorthaero.com` | `feedback-smtp.us-east-2.amazonses.com` | 10 | Bounces come back to SES |
| 5 | TXT | `bounce.ground.flynorthaero.com` | `"v=spf1 include:amazonses.com ~all"` | | SPF for the bounce name |

Notes:

- `<token1>` to `<token3>` are the three tokens SES shows.
- Keep the underscore in `_domainkey`. It is part of the name.
- DreamHost adds `.flynorthaero.com` to the name for you, so enter only the part before it: `<token1>._domainkey.ground` and `bounce.ground`. A doubled name like `...ground.flynorthaero.com.flynorthaero.com` is the most common mistake.
- The SPF value usually needs the quote marks. Some DNS hosts add them for you.
- `bounce.ground.flynorthaero.com` must have exactly one MX record. If it has more, the MAIL FROM setup fails. Use this name for nothing else.
- Check: none of the five records is on the name `ground.flynorthaero.com` itself, and none touches `reports.flynorthaero.com`.

**The MX record at DreamHost (record 4).** DreamHost's DNS Settings page cannot add an MX record to a subdomain. Its form sends MX to the Custom MX page, which covers only domains in the panel. So:

1. In the DreamHost panel, add `bounce.ground.flynorthaero.com` as a domain of its own, hosting type **DNS only**.
2. Open the **Custom MX** page, pick `bounce.ground.flynorthaero.com`, and enter exactly one MX: `10 feedback-smtp.us-east-2.amazonses.com`.
3. Check that the SPF TXT (record 5) still answers for `bounce.ground.flynorthaero.com`, and that Google's MX records for `flynorthaero.com` did not change.
4. Never change the Custom MX settings of `flynorthaero.com` itself. They are Google Workspace mail.

## Step 4. Wait for verification

1. DNS changes can take up to 72 hours to reach SES.
2. On the identity page, look for:
   - **DKIM configuration**: Successful.
   - **Identity status**: Verified. (With Easy DKIM, the three CNAME records also verify the domain. There is no separate TXT record for that.)
   - **MAIL FROM** status: Success. Other states: Pending and TemporaryFailure (SES uses its own bounce domain meanwhile), and Failed (after 72 hours with no MX record found: fix the record, then set up the MAIL FROM domain again).
3. SES sends an email when the MAIL FROM setup succeeds.

## Step 5. Send a test message and check DKIM (C6 acceptance test)

Not recorded as done yet (2026-11-11).

1. While the Region is in the sandbox, SES can only send to verified addresses. Verify your own address first: **Verified identities** > **Create identity** > **Email address**, then click the link SES emails you. (Out of the sandbox, any address works.)
2. On the `ground.flynorthaero.com` identity page, use **Send test email**. From: `reports@ground.flynorthaero.com`. To: your own address (or SES's mailbox simulator, `success@simulator.amazonses.com`).
3. In Gmail, open the message, then **Show original**. Check:
   - DKIM: PASS, with domain `ground.flynorthaero.com`.
   - SPF: PASS, with `bounce.ground.flynorthaero.com`.
   - DMARC: PASS (the `flynorthaero.com` record applies, see step 7).
4. Save a screenshot of the "Show original" summary. It is the evidence for the C6 test "DKIM passes on a test message."

A real billing or report email from staging is just as good evidence as the console's test email.

## Step 6. Leave the sandbox

Done: production access was granted in `us-east-2` on 2026-11-11.

Sandbox limits, per the docs: mail only to verified addresses and domains (or the mailbox simulator), at most 200 messages in 24 hours, and at most 1 message per second. The sandbox is separate in each Region.

1. SES console > **Account dashboard**. In the sandbox box, choose **View Get set up page**, then **Request production access**.
2. Fill in the form:
   - **Mail type**: Transactional. (Reports go only to addresses a student turned on in setup. They are not promotions.)
   - **Website URL**: `https://ground.flynorthaero.com`
   - **Additional contacts**: up to 4 email addresses, separated by commas, for example `info@flynorthaero.com`.
   - **Preferred contact language**: English.
   - Check the **Acknowledgement** box. It says you send only to people who asked for the mail, and that you handle bounces and complaints.
3. Choose **Submit request**. The docs say AWS Support first answers within 96 hours. You cannot edit the request during review.
4. The form has no box for a description (confirmed 2026-11-10), but AWS often asks for one by email. A ready answer:

   > North Aero Ground Tutor is a paid study app for student pilots at ground.flynorthaero.com. We send only transactional email: a sign-up and plan-change confirmation, a notice 30 days before an annual plan renews (required by California's automatic renewal law), and, for students who turn them on in the app, a short report after each study session and a weekly summary. Mail comes from billing@ground.flynorthaero.com and reports@ground.flynorthaero.com. Report emails have an unsubscribe link. Volume is low: a few messages per student per week. Bounces and complaints go to the SES suppression list through our configuration set, so we stop mailing those addresses.

   Before you send this text, check that it still matches what the code does (the unsubscribe link and the bounce handling).

## Step 7. Check DMARC

The SES docs say mail passes DMARC when DKIM or SPF passes and matches the From domain. Our setup passes on DKIM: Easy DKIM signs as `ground.flynorthaero.com`, the same domain as the From address.

1. Look up the TXT record at `_dmarc.flynorthaero.com` (any online DNS lookup tool works). On 2026-11-11 it was `v=DMARC1; p=none;`.
2. Under the DMARC standard (RFC 7489, section 6.6.3, not the SES docs), a DMARC record on `flynorthaero.com` also covers subdomains such as `ground.flynorthaero.com` when they have no record of their own. Its `sp=` value applies to subdomains, or its `p=` value when there is no `sp=`.
3. A record exists, so nothing more is needed. The test in step 5 shows whether our mail passes.
4. Only if that record were ever removed: you may add one for the tutor only. The SES docs advise starting with `p=none` (watch only):

   | Type | Name | Value |
   |---|---|---|
   | TXT | `_dmarc.ground.flynorthaero.com` | `"v=DMARC1; p=none; rua=mailto:<address for DMARC reports>"` |

   This name is not `ground.flynorthaero.com` itself, so it keeps the C6 req 5 rule.

## Step 8. Hand back to the build

Done 2026-11-10: the Region is `us-east-2`, the identity is verified, and the IAM user, its key and the three Railway variables are set on staging.

The permission, the Railway variable names, the suppression list setting and the remaining steps are in `docs/decisions/2026-11-08-email-reports.md`, "SES steps left for Erick". Keys go into Railway environment variables only, never into the repo or chat.

For the sending code, the facts it needs:

- From `reports@ground.flynorthaero.com` or `billing@ground.flynorthaero.com`, Reply-To `info@flynorthaero.com`. A verified domain covers every address in it, so `reports@` and `billing@` need no separate verification. SES requires verification only for the From, Source, Sender and Return-Path addresses, so the Reply-To address needs none.
- The identity's default configuration set applies when the code names no set. To name it anyway, pass the configuration set in the API call or add the header `X-SES-CONFIGURATION-SET: ground-tutor-reports`.

## Sources (Amazon SES Developer Guide, read 2026-11-08 unless noted)

- Creating identities: https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html
- Easy DKIM: https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html
- Managing Easy DKIM (record format; read again 2026-11-11): https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy-managing.html
- Custom MAIL FROM domain: https://docs.aws.amazon.com/ses/latest/dg/mail-from.html
- Creating configuration sets: https://docs.aws.amazon.com/ses/latest/dg/creating-configuration-sets.html
- Using configuration sets: https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets.html
- Configuration sets in email: https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets-in-email.html
- Production access and the sandbox: https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
- DMARC: https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html
- DMARC standard, subdomain policy: RFC 7489, section 6.6.3, https://www.rfc-editor.org/rfc/rfc7489#section-6.6.3
- DreamHost, custom MX for a domain or subdomain in the panel: knowledge base article 215035328 (help.dreamhost.com), as found by the master on 2026-11-10

Not confirmed from the SES pages: the exact label of the console's **Send test email** button, and what the docs recommend for "Behavior on MX failure" (they recommend neither option).
