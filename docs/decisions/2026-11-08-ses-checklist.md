# Amazon SES setup checklist for report email (C6 req 4 and 5, P6-02)

| Item | Value |
|---|---|
| Status | Ready for Erick. Nothing has been created in AWS. |
| Card | P6-02 (SES identity and DNS records). Feeds P6-03 and P6-04 (the report emails). |
| Sources | Amazon SES Developer Guide, read 2026-11-08 (list at the end). The pages show no "last updated" date. |
| Who does it | Erick, in the AWS console and at the DNS host for `flynorthaero.com`. |

## Settled values

| Setting | Value | Source |
|---|---|---|
| AWS account and Region | The same account and Region as flynorth's SES. Region code: `________` (fill in at step 0) | Erick, 2026-11-08 |
| Domain identity | `ground.flynorthaero.com`, with Easy DKIM (2048-bit, the default) | C6 req 4, N1 |
| From | `reports@ground.flynorthaero.com` | N1 |
| Reply-To | `info@flynorthaero.com` | PD7 |
| Custom MAIL FROM | `bounce.ground.flynorthaero.com` | C6 req 4 (the PRD's example name), plan approved 2026-11-08 |
| Configuration set | `ground-tutor-reports`, separate from flynorth's | C6 req 5, plan approved 2026-11-08 |
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
- **Configuration set**: a named group of SES sending settings. Ours keeps the tutor's mail apart from flynorth's.
- **Sandbox**: the test mode every new SES Region starts in. It can only send to addresses you have verified.

## Step 0. Find flynorth's Region and sandbox status

1. Sign in to the AWS console with the account that runs flynorth's SES.
2. Open the SES console: https://console.aws.amazon.com/ses/
3. Look at the Region name at the top right. Switch Regions until **Identities** (under Configuration) lists flynorth's identity.
4. Write the Region code in the table above (for example `us-west-2`). Every step below uses this Region. Records differ by Region, so do not switch Regions later.
5. Open **Account dashboard**. If you see the box "Your Amazon SES account is in the sandbox," this Region still needs step 6. If you do not see it, this Region already has production access. Skip step 6.

## Step 1. Create the configuration set

Do this first, so step 2 can make it the identity's default.

1. SES console > **Configuration sets** (under Configuration) > **Create set**.
2. **Configuration set name**: `ground-tutor-reports`. Names allow letters, numbers, hyphens and underscores, up to 64 characters.
3. Leave every other option at its default. (Reputation metrics are optional and add CloudWatch charges.)
4. Choose **Create set**.

## Step 2. Create the domain identity

1. SES console > **Identities** (under Configuration) > **Create identity**.
2. **Identity type**: Domain.
3. **Domain**: `ground.flynorthaero.com`
4. Check **Assign a default configuration set**. Pick `ground-tutor-reports`.
   - SES uses this set whenever the sending code names no other set.
5. Check **Use a custom MAIL FROM domain**.
   - **MAIL FROM domain**: `bounce.ground.flynorthaero.com` (if the box shows the parent domain already, type only `bounce`).
   - **Behavior on MX failure**: **Use default MAIL FROM domain**. If the bounce record ever breaks, SES sends from its own bounce domain instead of refusing the report.
   - **Publish DNS records to Route53**: leave it unchecked, unless the DNS for `flynorthaero.com` is hosted in Route 53 in this same AWS account.
6. Under **Verifying your domain**, open **Advanced DKIM settings**.
   - **Identity type**: Easy DKIM.
   - **DKIM signing key length**: RSA_2048_BIT (the default).
   - **Publish DNS records to Route53**: same rule as above.
   - **DKIM signatures**: Enabled must be checked.
7. Choose **Create identity**.
8. On the new identity's page, find the DNS records SES lists (the **Publish DNS records** table). You can also download them as a CSV file. Keep this page open for step 3.

## Step 3. Add five DNS records

Add these at the DNS host for `flynorthaero.com`. Copy each value from the SES console. Do not type the DKIM values by hand: the docs say the DKIM target "varies by AWS Region and identity."

| # | Type | Name (host) | Value | Priority | Job |
|---|---|---|---|---|---|
| 1 | CNAME | `<token1>._domainkey.ground.flynorthaero.com` | `<token1>.dkim.<region>.amazonses.com` (copy from SES) | | DKIM key 1 |
| 2 | CNAME | `<token2>._domainkey.ground.flynorthaero.com` | `<token2>.dkim.<region>.amazonses.com` (copy from SES) | | DKIM key 2 |
| 3 | CNAME | `<token3>._domainkey.ground.flynorthaero.com` | `<token3>.dkim.<region>.amazonses.com` (copy from SES) | | DKIM key 3 |
| 4 | MX | `bounce.ground.flynorthaero.com` | `feedback-smtp.<region>.amazonses.com` | 10 | Bounces come back to SES |
| 5 | TXT | `bounce.ground.flynorthaero.com` | `"v=spf1 include:amazonses.com ~all"` | | SPF for the bounce name |

Notes:

- `<region>` is the Region code from step 0. `<token1>` to `<token3>` are the three tokens SES shows.
- Keep the underscore in `_domainkey`. It is part of the name.
- Many DNS hosts add `.flynorthaero.com` to the name for you. If yours does, enter only the part before it: `<token1>._domainkey.ground` and `bounce.ground`. A doubled name like `...ground.flynorthaero.com.flynorthaero.com` is the most common mistake.
- The SPF value usually needs the quote marks. Some DNS hosts add them for you.
- `bounce.ground.flynorthaero.com` must have exactly one MX record. If it has more, the MAIL FROM setup fails. Use this name for nothing else.
- Check: none of the five records is on the name `ground.flynorthaero.com` itself, and none touches `reports.flynorthaero.com`.

## Step 4. Wait for verification

1. DNS changes can take up to 72 hours to reach SES.
2. On the identity page, look for:
   - **DKIM configuration**: Successful.
   - **Identity status**: Verified. (With Easy DKIM, the three CNAME records also verify the domain. There is no separate TXT record for that.)
   - **MAIL FROM** status: Success. Other states: Pending and TemporaryFailure (SES uses its own bounce domain meanwhile), and Failed (after 72 hours with no MX record found: fix the record, then set up the MAIL FROM domain again).
3. SES sends an email when the MAIL FROM setup succeeds.

## Step 5. Send a test message and check DKIM (C6 acceptance test)

1. While the Region is in the sandbox, SES can only send to verified addresses. Verify your own address first: **Identities** > **Create identity** > **Email address**, then click the link SES emails you.
2. On the `ground.flynorthaero.com` identity page, use **Send test email**. From: `reports@ground.flynorthaero.com`. To: your verified address (or SES's mailbox simulator, `success@simulator.amazonses.com`).
3. In Gmail, open the message, then **Show original**. Check:
   - DKIM: PASS, with domain `ground.flynorthaero.com`.
   - SPF: PASS, with `bounce.ground.flynorthaero.com`.
   - DMARC: PASS (if a DMARC record applies, see step 7).
4. Save a screenshot of the "Show original" summary. It is the evidence for the C6 test "DKIM passes on a test message."

## Step 6. Leave the sandbox (only if step 0 showed the sandbox box)

Sandbox limits, per the docs: mail only to verified addresses and domains (or the mailbox simulator), at most 200 messages in 24 hours, and at most 1 message per second. The sandbox is separate in each Region.

1. SES console > **Account dashboard**. In the sandbox box, choose **View Get set up page**, then **Request production access**.
2. Fill in the form:
   - **Mail type**: Transactional. (Reports go only to addresses a student turned on in setup. They are not promotions.)
   - **Website URL**: `https://ground.flynorthaero.com`
   - **Additional contacts**: up to 4 email addresses, separated by commas, for example `info@flynorthaero.com`.
   - **Preferred contact language**: English.
   - Check the **Acknowledgement** box. It says you send only to people who asked for the mail, and that you handle bounces and complaints.
3. Choose **Submit request**. The docs say AWS Support first answers within 96 hours. You cannot edit the request during review.
4. The docs' form has no box for a description, but AWS often asks one by email. A ready answer:

   > North Aero Ground Tutor is a paid study app for student pilots at ground.flynorthaero.com. We send two kinds of transactional email from reports@ground.flynorthaero.com: a short report after each study session, and a weekly summary. A student turns each kind on or off in the app and chooses the address. Every email has an unsubscribe link. Volume is low: a few messages per student per week. Bounces and complaints are handled through the SES suppression list and our configuration set, and an address that bounces or complains stops getting reports.

   Before you send this text, check that it still matches what P6-03 to P6-05 build (the unsubscribe link and the bounce handling).

## Step 7. Check DMARC (recommended)

The SES docs say mail passes DMARC when DKIM or SPF passes and matches the From domain. Our setup passes on DKIM: Easy DKIM signs as `ground.flynorthaero.com`, the same domain as the From address.

1. Look up the TXT record at `_dmarc.flynorthaero.com` (any online DNS lookup tool works).
2. Under the DMARC standard (RFC 7489, section 6.6.3, not the SES docs), a DMARC record on `flynorthaero.com` also covers subdomains such as `ground.flynorthaero.com` when they have no record of their own. Its `sp=` value applies to subdomains, or its `p=` value when there is no `sp=`.
3. If a record exists, nothing more is needed. The test in step 5 shows whether our mail passes.
4. If no record exists, you may add one for the tutor only. This is your choice, not settled yet. The SES docs advise starting with `p=none` (watch only):

   | Type | Name | Value |
   |---|---|---|
   | TXT | `_dmarc.ground.flynorthaero.com` | `"v=DMARC1; p=none; rua=mailto:<address for DMARC reports>"` |

   This name is not `ground.flynorthaero.com` itself, so it keeps the C6 req 5 rule.

## Step 8. Hand back to the build

Tell the build session (P6-03):

- The Region code.
- That the identity shows Verified, DKIM Successful, and MAIL FROM Success.
- Whether the Region is out of the sandbox.

Do not create AWS access keys yet. P6-03 will list the exact permission the sending code needs (send only, from this identity only). Keys then go into Railway environment variables only, never into the repo or chat.

Update (W2-10, 2026-11-08): the permission, the Railway variable names, the suppression list setting and the remaining steps are in `docs/decisions/2026-11-08-email-reports.md`, "SES steps left for Erick".

For P6-03, the facts the sending code needs:

- From `reports@ground.flynorthaero.com`, Reply-To `info@flynorthaero.com`. A verified domain covers every address in it, so `reports@` needs no separate verification. SES requires verification only for the From, Source, Sender and Return-Path addresses, so the Reply-To address needs none.
- The identity's default configuration set applies when the code names no set. To name it anyway, pass the configuration set in the API call or add the header `X-SES-CONFIGURATION-SET: ground-tutor-reports`.

## Sources (Amazon SES Developer Guide, read 2026-11-08)

- Creating identities: https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html
- Easy DKIM: https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html
- Managing Easy DKIM (record format): https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy-managing.html
- Custom MAIL FROM domain: https://docs.aws.amazon.com/ses/latest/dg/mail-from.html
- Creating configuration sets: https://docs.aws.amazon.com/ses/latest/dg/creating-configuration-sets.html
- Using configuration sets: https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets.html
- Configuration sets in email: https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets-in-email.html
- Production access and the sandbox: https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
- DMARC: https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html
- DMARC standard, subdomain policy: RFC 7489, section 6.6.3, https://www.rfc-editor.org/rfc/rfc7489#section-6.6.3

Not confirmed from the SES pages: the exact label of the console's **Send test email** button, and what the docs recommend for "Behavior on MX failure" (they recommend neither option).
