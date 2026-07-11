import { useEffect, useState } from "react";
import { fetchMe, logout, type Me } from "./api";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    void fetchMe().then(setMe);
  }, []);

  if (me === undefined) {
    return <div className="grid min-h-screen place-items-center text-stone-400">Loading…</div>;
  }
  return me ? <Shell me={me} /> : <Login />;
}

function Login() {
  return (
    <div className="grid min-h-screen place-items-center bg-stone-50">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-stone-900">MCP Control Plane</h1>
        <p className="mt-2 text-sm text-stone-500">
          One endpoint for every MCP client. Your vendors, accounts, and permissions — managed in one place.
        </p>
        <a
          href="/auth/google"
          className="mt-6 flex items-center justify-center gap-3 rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-50"
        >
          <GoogleMark />
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

const NAV = [
  { label: "Overview", part: null },
  { label: "Store", part: 3 },
  { label: "Connections", part: 5 },
  { label: "Accounts", part: 4 },
  { label: "Permissions", part: 7 },
  { label: "Audit", part: 8 },
  { label: "Settings", part: null },
];

function Shell({ me }: { me: Me }) {
  return (
    <div className="flex min-h-screen bg-stone-50">
      <aside className="flex w-56 flex-col border-r border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-4 py-4 text-sm font-semibold text-stone-900">
          MCP Control Plane
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => (
            <div
              key={item.label}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                item.label === "Overview" ? "bg-stone-100 font-medium text-stone-900" : "text-stone-400"
              }`}
            >
              {item.label}
              {item.part && (
                <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-400">Part {item.part}</span>
              )}
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
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
          <h1 className="text-lg font-semibold text-stone-900">Welcome, {me.user.name ?? me.user.email}</h1>
          <p className="mt-2 max-w-xl text-sm text-stone-500">
            The SaaS foundation is live: you are signed in with Google and this workspace is yours alone. The full
            dashboard skeleton arrives in Part 2; each section then gets wired one part at a time.
          </p>
          <p className="mt-4 text-xs text-stone-400">
            Your MCP endpoint (Part 5): <code className="rounded bg-stone-100 px-1.5 py-0.5">/u/{me.user.slug}/mcp</code>
          </p>
        </main>
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.7 1.22 9.19 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
