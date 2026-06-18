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
            Last updated: June 2025
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
              "organization") manages its own staff and player data independently.
              Data belonging to one organization is never shared with or visible
              to another.
            </p>
          </Section>

          <Section title="Information we collect">
            <p className="font-medium text-foreground text-[13px]">Account &amp; identity</p>
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

            <p className="font-medium text-foreground text-[13px] pt-2">Support &amp; moderation data</p>
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

            <p className="font-medium text-foreground text-[13px] pt-2">Technical &amp; session data</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                IP address — collected at login and on certain API requests for
                rate limiting and abuse prevention. Not stored long-term.
              </li>
              <li>
                Session token — an encrypted cookie that identifies your active
                session. Expires on logout or after a fixed idle period.
              </li>
              <li>
                Audit log entries — staff actions (ticket assignments, status
                changes, bans) are logged with a timestamp and staff identity.
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
              Access to player and moderation data is strictly role-based.
              Every staff account belongs to an organization and is assigned a
              rank. Access is enforced server-side on every request — it cannot
              be bypassed by the client.
            </p>
            <div className="rounded-md ring-1 ring-border bg-surface/40 p-4 space-y-2 text-[12px]">
              <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1.5 text-xs">
                <span className="font-semibold text-foreground">Support</span>
                <span>Can view and respond to general support tickets assigned to their team.</span>
                <span className="font-semibold text-foreground">Admin</span>
                <span>Can access player reports, player history, and issue bans within their organization.</span>
                <span className="font-semibold text-foreground">Senior Admin</span>
                <span>Can access ban appeals and restrict ticket visibility to senior staff.</span>
                <span className="font-semibold text-foreground">Management</span>
                <span>Full moderation access within the organization, including sensitive cases.</span>
                <span className="font-semibold text-foreground">Owner</span>
                <span>Full access to all data within their organization. Can manage staff roles and configurations.</span>
              </div>
            </div>
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
                Player display names and profile data are fetched from the Steam
                Web API using a player's Steam ID.
              </li>
              <li>
                <span className="font-medium text-foreground">Player data providers</span> —
                Organizations may enable integrations with third-party game
                server data services (configured per-organization) to enrich
                player lookups with game history and prior ban data. API keys
                are stored encrypted and are never shared between organizations.
              </li>
              <li>
                <span className="font-medium text-foreground">Discord</span> —
                Used for staff authentication via OAuth. We receive your Discord
                user ID and username. IronSight does not post to Discord on
                behalf of users without explicit configuration by an organization
                admin.
              </li>
            </ul>
            <p>
              We do not transmit ticket content, staff notes, or ban records to
              any external service unless a specific integration is explicitly
              enabled and configured by an organization owner.
            </p>
          </Section>

          <Section title="Data retention">
            <p>
              Player lookup data (fetched from external sources) is cached for
              up to 30 days to reduce redundant requests and improve performance.
              After 30 days, stale cache entries are automatically cleared and
              re-fetched on the next lookup.
            </p>
            <p>
              Tickets, moderation records, and ban history are retained
              indefinitely while the organization's account is active, as they
              form a continuous audit trail necessary for fair moderation.
            </p>
            <p>
              Session data is cleared on logout and automatically expires after
              a period of inactivity. IP addresses captured for rate limiting
              are not stored beyond the request cycle.
            </p>
            <p>
              If an organization is removed from the platform, all associated
              data is scheduled for deletion.
            </p>
          </Section>

          <Section title="Your rights as a player">
            <p>
              If you are a player who submitted a ticket or was subject to a
              moderation action on a server using IronSight, you may contact
              the server organization directly through their player portal to
              request information about data held about you, or to appeal a
              moderation decision.
            </p>
            <p>
              IronSight acts as a data processor on behalf of each organization.
              The organization (server community) is the data controller
              responsible for moderation decisions made using the platform.
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
              organizations) are stored encrypted at rest using AES-256-GCM.
            </p>
            <p>
              Staff authentication requires both a Discord account and a Steam
              account to be linked. This two-factor identity requirement prevents
              a single compromised account from gaining panel access.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              For questions about this policy or data held about you, contact
              the organization that operates the server you interacted with, or
              reach out to the IronSight platform team through the support
              channels listed on our website.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}

export { Route };
