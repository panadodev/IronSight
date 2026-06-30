import { SiteNav } from "@/components/site-nav";
import { createFileRoute } from "@tanstack/react-router";
const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — IronSight" },
      {
        name: "description",
        content:
          "IronSight privacy policy: what data we collect, how it's used, and how we protect it.",
      },
    ],
  }),
  component: PrivacyPage,
});

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-foreground border-b border-border pb-2">
        {title}
      </h2>
      <div className="space-y-2 text-sm text-muted-foreground leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function PrivacyPage() {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteNav />
      <main className="flex-1 px-6 py-10 max-w-3xl mx-auto w-full">
        <header className="mb-10">
          <p className="text-[10px] font-mono uppercase tracking-widest text-brand mb-2">
            Legal
          </p>
          <h1 className="text-3xl font-bold tracking-tight mb-3">
            Privacy Policy
          </h1>
          <p className="text-sm text-muted-foreground">
            Last updated: June 2026
          </p>
        </header>

        <div className="space-y-8">
          <Section title="Overview">
            <p>
              IronSight is a staff management and player support platform for
              game server communities. This policy explains what information we
              collect, why we collect it, and the controls we have in place to
              protect it.
            </p>
            <p>
              IronSight operates as a multi-tenant platform. Each community (an
              "organization") manages its own staff and player data
              independently. Data belonging to one organization is never shared
              with or visible to another.
            </p>
          </Section>

          <Section title="Information we collect">
            <p className="font-medium text-foreground text-[13px]">
              Account &amp; identity
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                Steam ID and public Steam profile information (display name) —
                used to identify players and staff members.
              </li>
              <li>
                Discord user ID and username — used for staff authentication and
                Discord server integration.
              </li>
              <li>
                Staff display name — how your name appears to players and
                colleagues in the panel.
              </li>
            </ul>

            <p className="font-medium text-foreground text-[13px] pt-2">
              Support &amp; moderation data
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                Ticket content — descriptions, evidence links, and messages
                submitted through the player portal or written by staff.
              </li>
              <li>
                Moderation records — bans, mutes, and their associated reasons,
                durations, and issuing staff member.
              </li>
              <li>
                Player sightings — records of when a Steam ID was observed on a
                server run by an organization using IronSight.
              </li>
              <li>
                Staff notes — internal notes attached to player profiles by
                authorized staff. These are never shown to players.
              </li>
            </ul>

            <p className="font-medium text-foreground text-[13px] pt-2">
              Discord data
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                Discord user ID and username — collected at login via OAuth and
                stored as part of your staff account indefinitely.
              </li>
              <li>
                Discord messages — organizations may configure IronSight to
                monitor designated channels in their Discord server. When this
                integration is active, messages sent in those channels
                (including message content, author ID, username, timestamp, and
                any attachments) are recorded and stored as moderation data.{" "}
                <span className="font-medium text-foreground">
                  Message content is automatically and permanently deleted after
                  30 days.
                </span>{" "}
                Only channels explicitly configured by an organization owner are
                monitored. Direct messages and channels outside the configured
                scope are never read or stored.
              </li>
              <li>
                Discord server membership — whether a user is a member of a
                linked Discord server may be checked to verify staff eligibility
                or access level within an organization.
              </li>
              <li>
                Discord moderation actions — timeouts, voice mutes, kicks, and
                bans issued through the panel are logged in the organization's
                audit trail alongside the responsible staff member and reason.
                These records are retained indefinitely as part of the
                moderation history.
              </li>
            </ul>
            <p>
              When you join a Discord server that has IronSight integration
              enabled, the IronSight bot will send you a direct message
              notifying you of this policy. By remaining in a server with the
              integration active, you acknowledge that messages sent in
              monitored channels may be recorded and used for moderation
              purposes by that server's staff team.
            </p>

            <p className="font-medium text-foreground text-[13px] pt-2">
              Network &amp; device intelligence
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                Player IP addresses — when a player connects to a server
                operated by an organization using IronSight (reported by the
                server), or is matched through a connected third-party data
                provider, their IP address is recorded as part of that player's
                history to support ban-evasion and alternate-account detection.
                IP addresses are stored{" "}
                <span className="font-medium text-foreground">
                  encrypted at rest
                </span>{" "}
                and indexed only by a one-way cryptographic hash. The raw
                address is never shown in the panel — staff with the appropriate
                permission see only a short, non-reversible token and the
                derived metadata below.
              </li>
              <li>
                IP-derived metadata — from each observed IP we derive and store
                approximate geolocation (country, region, city), the network
                operator (ISP / ASN / organization), and a VPN / proxy / hosting
                classification, obtained from a third-party IP-intelligence
                provider. This is used to assess ban-evasion risk and whether an
                IP ban is appropriate.
              </li>
              <li>
                Account associations — to identify shared or alternate accounts,
                we compute and store relationships between players based on
                shared IP addresses, Steam friends and groups, name aliases, and
                overlapping play sessions.
              </li>
            </ul>

            <p className="font-medium text-foreground text-[13px] pt-2">
              Technical &amp; session data
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                IP address — your IP is recorded at login and on certain API
                requests for rate limiting and abuse prevention, and is retained
                as part of your session record and in security audit logs (see
                Data retention).
              </li>
              <li>
                Session token — an encrypted cookie that identifies your active
                session. Expires on logout or after a fixed idle period.
              </li>
              <li>
                Audit log entries — staff actions (ticket assignments, status
                changes, bans, player lookups) are logged with a timestamp, the
                staff member's identity, and their IP address.
              </li>
            </ul>
          </Section>

          <Section title="How we use this information">
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                To operate the ticket system and allow players to submit and
                track support requests.
              </li>
              <li>
                To enforce server rules — issuing, tracking, and synchronizing
                bans and mutes across servers within an organization.
              </li>
              <li>
                To give staff the context they need to make fair moderation
                decisions (prior history, linked accounts, server activity).
              </li>
              <li>
                To authenticate users securely and prevent unauthorized access
                to the staff panel.
              </li>
              <li>
                To generate audit trails so organizations can review staff
                actions and maintain accountability.
              </li>
            </ul>
            <p>
              We do not sell, rent, or share personal data with third parties
              for advertising or commercial purposes.
            </p>
          </Section>

          <Section title="Data access controls">
            <p>
              Access to player and moderation data is strictly role-based. Every
              staff account belongs to an organization and is assigned a rank.
              Access is enforced server-side on every request — it cannot be
              bypassed by the client.
            </p>

            <p>
              Internal staff notes, restricted tickets, and certain moderation
              records are hidden from lower-ranked staff members. Visibility
              restrictions are enforced on the server — not just the UI.
            </p>
            <p>
              Platform-level access (sysadmin) is limited to a single designated
              account used solely for infrastructure maintenance. Sysadmin
              access is identified and logged.
            </p>
          </Section>

          <Section title="Data shared with third-party services">
            <p>
              To provide certain features, IronSight queries external services
              on behalf of organizations:
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                <span className="font-medium text-foreground">Steam</span> —
                Player display names, profile data, game playtime, VAC/game ban
                status, and (where the player has made them public) friends and
                group memberships are fetched from the Steam Web API using a
                player's Steam ID. Friends and groups are used for
                alternate-account analysis.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  BattleMetrics
                </span>{" "}
                — A player's Steam ID is sent to look up cross-server play
                history, name aliases, session activity, and prior ban records,
                using the organization's own API credentials.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  IP intelligence provider
                </span>{" "}
                — Observed IP addresses are sent to a third-party service
                (Proxycheck) to classify VPN / proxy / hosting use and to obtain
                geolocation and network-operator information.
              </li>
              <li>
                These integrations are configured per organization. API keys are
                stored encrypted and are never shared between organizations, and
                data returned by one organization's keys is not pooled into
                another's.
              </li>
              <li>
                <span className="font-medium text-foreground">Discord</span> —
                Used for staff authentication via OAuth and, where enabled by an
                organization, for message monitoring and server integration.
                When a Discord integration is active, IronSight reads messages
                from configured channels using a bot operating under Discord's
                API terms. Data received from Discord is processed and stored
                within IronSight's infrastructure; it is not re-shared with
                other third parties. IronSight does not send messages or take
                actions in Discord on behalf of users without explicit
                configuration by an organization owner.
              </li>
            </ul>
            <p>
              We do not transmit ticket content, staff notes, or ban records to
              any external service unless a specific integration is explicitly
              enabled and configured by an organization owner.
            </p>
          </Section>

          <Section title="Data retention">
            <p>Player data is stored permanently.</p>
            <p>
              Tickets, moderation records, ban history, and Discord moderation
              actions (timeouts, kicks, bans) are retained indefinitely while
              the organization's account is active, as they form a continuous
              audit trail necessary for fair moderation.
            </p>
            <p>
              Discord message content is retained for a maximum of{" "}
              <span className="font-medium text-foreground">30 days</span> and
              is then permanently and automatically deleted. This applies to all
              message content, author information, and attachments captured
              through the Discord channel monitoring integration.
            </p>
            <p>
              Discord account identifiers (user ID, username) linked to a staff
              account are retained for as long as the staff account exists
              within an organization.
            </p>
            <p>
              Player IP history and the metadata derived from it (geolocation,
              network operator, VPN/proxy classification, and account
              associations) are retained as part of the moderation record for as
              long as the organization's account is active, because ban-evasion
              and alternate-account detection depend on historical associations.
              Cached third-party intelligence is refreshed periodically.
            </p>
            <p>
              Session records — including the login IP — are cleared on logout
              and expire after a fixed period of inactivity. Security audit log
              entries, including the acting staff member's IP address, are
              retained indefinitely as part of the accountability trail.
            </p>
          </Section>

          <Section title="Evidence confidentiality">
            <p>
              Evidence collected during moderation investigations — including
              video clips, screenshots, chat logs, and other materials submitted
              by reporters or gathered by staff — is treated as confidential
              moderation data.
            </p>
            <p>
              We do not disclose evidence or any associated player information
              to external parties. This includes the subject of the
              investigation, third-party services, or other players. Evidence is
              accessible only to staff members with the appropriate rank within
              the organization that collected it.
            </p>
            <p>
              Players who are the subject of a moderation action do not have an
              automatic right to inspect the evidence held against them. Staff
              teams are not obligated to reveal the source, nature, or contents
              of evidence as part of a ban or appeal process. This policy exists
              to protect reporters from retaliation and to preserve the
              integrity of the moderation process.
            </p>
          </Section>

          <Section title="Security">
            <p>
              All communication between your browser and IronSight is encrypted
              in transit. Session tokens are stored in HttpOnly, Secure cookies
              and are not accessible to client-side scripts.
            </p>
            <p>
              Sensitive credentials (such as third-party API keys configured by
              organizations) are stored encrypted. Player IP addresses are also
              encrypted at rest and are only ever surfaced to authorized staff
              as short, non-reversible hashes — never as the raw address.
            </p>
            <p>
              Staff authentication requires both a Discord account and a Steam
              account to be linked. This two-factor identity requirement
              prevents a single compromised account from gaining panel access.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}

export { Route };
