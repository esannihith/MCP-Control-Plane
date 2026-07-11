import { NavLink, Outlet } from "react-router-dom";
import { logout, type Me } from "../api";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/store", label: "Store" },
  { to: "/connections", label: "Connections" },
  { to: "/accounts", label: "Accounts" },
  { to: "/permissions", label: "Permissions" },
  { to: "/audit", label: "Audit" },
  { to: "/settings", label: "Settings" },
];

export default function Layout({ me }: { me: Me }) {
  return (
    <div className="flex min-h-screen bg-stone-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-4 py-4 text-sm font-semibold text-stone-900">MCP Control Plane</div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cx(
                  "block rounded-md px-3 py-2 text-sm",
                  isActive ? "bg-stone-100 font-medium text-stone-900" : "text-stone-500 hover:bg-stone-50 hover:text-stone-800",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-stone-100 p-3 text-[11px] leading-relaxed text-stone-400">
          Skeleton preview — pages are wired one part at a time.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-stone-200 bg-white px-6 py-3">
          {me.user.avatarUrl && <img src={me.user.avatarUrl} alt="" className="h-7 w-7 rounded-full" />}
          <span className="text-sm text-stone-600">{me.user.name ?? me.user.email}</span>
          <button
            onClick={() => void logout(me.csrf).then(() => window.location.reload())}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50"
          >
            Sign out
          </button>
        </header>
        <main className="flex-1 p-8">
          <Outlet context={me} />
        </main>
      </div>
    </div>
  );
}
