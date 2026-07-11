import { useState } from "react";
import { useToast } from "../components/feedback";
import { Badge, Card, PageHeader, PartTag, cx } from "../components/ui";
import { connections, permissionTools } from "../mock";

const POLICIES = [
  { id: "full", label: "Full access", desc: "Every tool, reads and writes." },
  { id: "read_only", label: "Read-only", desc: "Mutation tools are hidden and blocked." },
  { id: "reads_plus_granted", label: "Reads + granted writes", desc: "Reads allowed; each write tool needs an explicit grant. Default for new clients." },
] as const;

export default function Permissions() {
  const toast = useToast();
  const [selected, setSelected] = useState(connections[0].name);
  const [policy, setPolicy] = useState<string>("reads_plus_granted");
  const preview = () => toast("Permission changes — wired in Part 7 (preview only)");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Permissions"
        desc="What each client connection may call. Read tools are allowed by default; mutation tools need an explicit grant."
      />

      <Card title="Connection">
        <div className="flex flex-wrap gap-2">
          {connections.map((connection) => (
            <button
              key={connection.name}
              onClick={() => setSelected(connection.name)}
              className={cx(
                "rounded-lg border px-3 py-1.5 text-sm",
                selected === connection.name
                  ? "border-stone-800 bg-stone-800 text-white"
                  : "border-stone-300 text-stone-600 hover:bg-stone-50",
              )}
            >
              {connection.name}
            </button>
          ))}
        </div>
      </Card>

      <Card title={`Policy for ${selected}`} action={<PartTag part={7} />}>
        <div className="grid gap-3 md:grid-cols-3">
          {POLICIES.map((option) => (
            <button
              key={option.id}
              onClick={() => {
                setPolicy(option.id);
                preview();
              }}
              className={cx(
                "rounded-xl border p-4 text-left",
                policy === option.id ? "border-emerald-600 ring-1 ring-emerald-600" : "border-stone-200 hover:border-stone-300",
              )}
            >
              <div className="text-sm font-semibold text-stone-800">{option.label}</div>
              <div className="mt-1 text-xs text-stone-500">{option.desc}</div>
            </button>
          ))}
        </div>
      </Card>

      {policy === "reads_plus_granted" && (
        <div className="space-y-4">
          {Object.entries(permissionTools).map(([vendor, tools]) => (
            <Card key={vendor} title={`${vendor} — write grants`}>
              <ul className="divide-y divide-stone-100">
                {tools.map((tool) => (
                  <li key={tool.name} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-2">
                      <code className="text-sm">{tool.name}</code>
                      <Badge tone={tool.write ? "amber" : "green"}>{tool.write ? "write" : "read"}</Badge>
                    </div>
                    {tool.write ? (
                      <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-600">
                        <input type="checkbox" defaultChecked={tool.granted} onChange={preview} className="h-4 w-4 accent-emerald-700" />
                        granted
                      </label>
                    ) : (
                      <span className="text-xs text-stone-400">always allowed</span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
