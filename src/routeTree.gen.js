import { Route as rootRouteImport } from "./routes/__root";
import { Route as ViewOrgRouteImport } from "./routes/view-org";
import { Route as TodoRouteImport } from "./routes/todo";
import { Route as ThreatTriggersRouteImport } from "./routes/threat-triggers";
import { Route as SupportRouteImport } from "./routes/support";
import { Route as SubmitRouteImport } from "./routes/submit";
import { Route as StaffAuditRouteImport } from "./routes/staff-audit";
import { Route as PlayerLookupRouteImport } from "./routes/player-lookup";
import { Route as PlayerListRouteImport } from "./routes/player-list";
import { Route as PanelRouteImport } from "./routes/panel";
import { Route as MyReportsRouteImport } from "./routes/my-reports";
import { Route as ManageRouteImport } from "./routes/manage";
import { Route as DocsRouteImport } from "./routes/docs";
import { Route as ChatRouteImport } from "./routes/chat";
import { Route as BansMutesRouteImport } from "./routes/bans-mutes";
import { Route as IndexRouteImport } from "./routes/index";
import { Route as ManageToxicityRouteImport } from "./routes/manage.toxicity";
import { Route as ManageTicketsRouteImport } from "./routes/manage.tickets";
import { Route as ManageStaffRouteImport } from "./routes/manage.staff";
import { Route as ManagePredefinesRouteImport } from "./routes/manage.predefines";
import { Route as ManageBanConfigsRouteImport } from "./routes/manage.ban-configs";
const ViewOrgRoute = ViewOrgRouteImport.update({
  id: "/view-org",
  path: "/view-org",
  getParentRoute: () => rootRouteImport,
});
const TodoRoute = TodoRouteImport.update({
  id: "/todo",
  path: "/todo",
  getParentRoute: () => rootRouteImport,
});
const ThreatTriggersRoute = ThreatTriggersRouteImport.update({
  id: "/threat-triggers",
  path: "/threat-triggers",
  getParentRoute: () => rootRouteImport,
});
const SupportRoute = SupportRouteImport.update({
  id: "/support",
  path: "/support",
  getParentRoute: () => rootRouteImport,
});
const SubmitRoute = SubmitRouteImport.update({
  id: "/submit",
  path: "/submit",
  getParentRoute: () => rootRouteImport,
});
const StaffAuditRoute = StaffAuditRouteImport.update({
  id: "/staff-audit",
  path: "/staff-audit",
  getParentRoute: () => rootRouteImport,
});
const PlayerLookupRoute = PlayerLookupRouteImport.update({
  id: "/player-lookup",
  path: "/player-lookup",
  getParentRoute: () => rootRouteImport,
});
const PlayerListRoute = PlayerListRouteImport.update({
  id: "/player-list",
  path: "/player-list",
  getParentRoute: () => rootRouteImport,
});
const PanelRoute = PanelRouteImport.update({
  id: "/panel",
  path: "/panel",
  getParentRoute: () => rootRouteImport,
});
const MyReportsRoute = MyReportsRouteImport.update({
  id: "/my-reports",
  path: "/my-reports",
  getParentRoute: () => rootRouteImport,
});
const ManageRoute = ManageRouteImport.update({
  id: "/manage",
  path: "/manage",
  getParentRoute: () => rootRouteImport,
});
const DocsRoute = DocsRouteImport.update({
  id: "/docs",
  path: "/docs",
  getParentRoute: () => rootRouteImport,
});
const ChatRoute = ChatRouteImport.update({
  id: "/chat",
  path: "/chat",
  getParentRoute: () => rootRouteImport,
});
const BansMutesRoute = BansMutesRouteImport.update({
  id: "/bans-mutes",
  path: "/bans-mutes",
  getParentRoute: () => rootRouteImport,
});
const IndexRoute = IndexRouteImport.update({
  id: "/",
  path: "/",
  getParentRoute: () => rootRouteImport,
});
const ManageToxicityRoute = ManageToxicityRouteImport.update({
  id: "/toxicity",
  path: "/toxicity",
  getParentRoute: () => ManageRoute,
});
const ManageTicketsRoute = ManageTicketsRouteImport.update({
  id: "/tickets",
  path: "/tickets",
  getParentRoute: () => ManageRoute,
});
const ManageStaffRoute = ManageStaffRouteImport.update({
  id: "/staff",
  path: "/staff",
  getParentRoute: () => ManageRoute,
});
const ManagePredefinesRoute = ManagePredefinesRouteImport.update({
  id: "/predefines",
  path: "/predefines",
  getParentRoute: () => ManageRoute,
});
const ManageBanConfigsRoute = ManageBanConfigsRouteImport.update({
  id: "/ban-configs",
  path: "/ban-configs",
  getParentRoute: () => ManageRoute,
});
const ManageRouteChildren = {
  ManageBanConfigsRoute,
  ManagePredefinesRoute,
  ManageStaffRoute,
  ManageTicketsRoute,
  ManageToxicityRoute,
};
const ManageRouteWithChildren =
  ManageRoute._addFileChildren(ManageRouteChildren);
const rootRouteChildren = {
  IndexRoute,
  BansMutesRoute,
  ChatRoute,
  DocsRoute,
  ManageRoute: ManageRouteWithChildren,
  MyReportsRoute,
  PanelRoute,
  PlayerListRoute,
  PlayerLookupRoute,
  StaffAuditRoute,
  SubmitRoute,
  SupportRoute,
  ThreatTriggersRoute,
  TodoRoute,
  ViewOrgRoute,
};
const routeTree = rootRouteImport
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes();
export { routeTree };
