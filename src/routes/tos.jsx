import { SiteNav } from "@/components/site-nav";
import { createFileRoute } from "@tanstack/react-router";
const Route = createFileRoute("/tos")({
  head: () => ({
    meta: [
      { title: "Terms of Service — IronSight" },
      {
        name: "description",
        content:
          "IronSight terms of service: rules for using the platform as staff or as a player.",
      },
    ],
  }),
  component: TosPage,
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

function TosPage() {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteNav />
      <main className="flex-1 px-6 py-10 max-w-3xl mx-auto w-full">
        <header className="mb-10">
          <p className="text-[0.625rem] font-mono uppercase tracking-widest text-brand mb-2">
            Legal
          </p>
          <h1 className="text-3xl font-bold tracking-tight mb-3">
            Terms of Service
          </h1>
          <p className="text-sm text-muted-foreground">
            Last updated: June 2026
          </p>
        </header>

        <div className="space-y-8">
          <Section title="Acceptance of terms">
            <p>
              By accessing or using IronSight — whether as a staff member
              through the panel or as a player through the public portal — you
              agree to be bound by these Terms of Service. If you do not agree,
              do not use the platform.
            </p>
            <p>
              These terms apply to all users of IronSight, including
              organization owners, staff members, and players who submit support
              tickets.
            </p>
          </Section>

          <Section title="Description of the service">
            <p>
              IronSight provides game server communities with tools for staff
              management, player support ticketing, and moderation. The platform
              consists of a staff panel (restricted to authenticated staff
              members) and a public player portal (accessible to players for
              submitting and tracking support requests).
            </p>
            <p>
              IronSight is a platform provider. Each community ("organization")
              that uses IronSight operates its own staff team and makes its own
              moderation decisions independently. IronSight is not a party to
              any moderation action taken by an organization, and is not
              responsible for the decisions of individual organizations or their
              staff.
            </p>
            <p>
              To provide moderation and player-intelligence features, IronSight
              records player network information (including IP addresses) and
              integrates with third-party data providers (such as Steam,
              BattleMetrics, and an IP-intelligence service) on behalf of
              organizations. How this data is collected, used, and protected is
              described in our{" "}
              <a href="/privacy" className="text-brand hover:underline">
                Privacy Policy
              </a>
              .
            </p>
          </Section>

          <Section title="Staff accounts and responsibilities">
            <p>
              Access to the staff panel requires authentication via both a
              Discord account and a Steam account. You are responsible for
              maintaining the security of your linked accounts and must not
              share access with any other person.
            </p>
            <p>As a staff member, you agree to:</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                Use your access only for legitimate moderation and support
                purposes within your organization.
              </li>
              <li>
                Keep all information you access through the panel — including
                player notes, ticket content, evidence, and internal discussions
                — strictly confidential. You must not share this information
                outside of your staff team.
              </li>
              <li>
                Not access data belonging to organizations you are not a member
                of, or attempt to escalate your privileges beyond your assigned
                rank.
              </li>
              <li>
                Not use the platform to harass, target, or retaliate against
                players or other staff members.
              </li>
              <li>
                Act in good faith when issuing bans, writing notes, or handling
                tickets. Deliberate misuse of moderation tools is grounds for
                immediate removal.
              </li>
            </ul>
          </Section>

          <Section title="Player portal use">
            <p>
              Players may use the public portal to submit support tickets and
              track their status. By submitting a ticket, you agree to:
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                Provide accurate and truthful information. Submitting false
                reports or fabricated evidence is prohibited.
              </li>
              <li>
                Not submit tickets intended to harass, defame, or target other
                players without a genuine basis.
              </li>
              <li>
                Accept that moderation decisions are made by the organization
                operating the server, not by IronSight, and that IronSight
                cannot reverse or override those decisions.
              </li>
            </ul>
          </Section>

          <Section title="Prohibited conduct">
            <p>The following are prohibited for all users:</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                Attempting to gain unauthorized access to the staff panel or to
                data belonging to any organization.
              </li>
              <li>
                Probing, scanning, or testing the security of the platform
                without prior written authorization.
              </li>
              <li>
                Submitting automated requests or using scripts to interact with
                the platform in ways not intended by its design.
              </li>
              <li>
                Impersonating another user, staff member, or organization.
              </li>
              <li>
                Using the platform to store or transmit content that is
                unlawful, harmful, or violates the rights of others.
              </li>
            </ul>
          </Section>

          <Section title="Moderation decisions">
            <p>
              IronSight provides the tools; organizations make the decisions.
              Ban and moderation outcomes are at the sole discretion of each
              organization's staff team. IronSight does not adjudicate disputes
              between players and organizations, and has no obligation to
              intervene in or reverse any moderation action.
            </p>
            <p>
              If you believe a moderation action was unfair, your recourse is to
              contact the organization directly through their player portal or
              designated appeal process.
            </p>
          </Section>

          <Section title="Account suspension and termination">
            <p>
              IronSight reserves the right to suspend or terminate access to the
              platform for any user or organization that violates these terms,
              engages in prohibited conduct, or poses a risk to the security or
              integrity of the platform. This may occur without prior notice.
            </p>
            <p>
              Organization owners may remove staff members from their
              organization at any time, which revokes that member's access to
              the organization's data and panel features.
            </p>
          </Section>

          <Section title="Disclaimers and limitation of liability">
            <p>
              The platform is provided "as is" without warranties of any kind.
              IronSight does not guarantee uninterrupted availability, and is
              not liable for any loss of data, missed moderation actions, or
              harm resulting from platform downtime or errors.
            </p>
            <p>
              IronSight is not liable for the conduct of any organization or its
              staff members, or for any moderation decision made using the
              platform. Each organization is solely responsible for the actions
              of its staff team.
            </p>
            <p>
              To the maximum extent permitted by applicable law, IronSight's
              total liability for any claim arising out of these terms or use of
              the platform shall not exceed the amount paid by the relevant
              organization in the 30 days preceding the claim.
            </p>
          </Section>

          <Section title="Changes to these terms">
            <p>
              We may update these terms from time to time. Continued use of the
              platform after changes are posted constitutes acceptance of the
              revised terms. We will update the "last updated" date at the top
              of this page when changes are made.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions about these terms should be directed to the IronSight
              platform team through the support channels listed on our website.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}

export { Route };
