import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { Me } from "../api";
import { useToast } from "../components/feedback";
import { Badge, Button, Card, EmptyState, PageHeader, PreviewToggle, Table, Td } from "../components/ui";
import { auditRows, connections, myConnectors } from "../mock";

export default function Overview() {
  const me = useOutletContext<Me>();
  const toast = useToast();
  const [empty, setEmpty] = useState(false);
  const endpoint = `${window.location.origin}/u/${me.user.slug}/mcp`;

  if (empty) {
    return (
      <div>
        <PageHeader title="Overview" action={<PreviewToggle empty={empty} onChange={setEmpty} />} />
        <EmptyState
          title="Welcome to your control plane"
          desc="Add a connector from the Store, link a vendor account, then point any MCP client at your endpoint. Three steps, one URL forever."
          action={<Button variant="primary">Browse the Store</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        desc="What your control plane is serving right now."
        action={<PreviewToggle empty={empty} onChange={setEmpty} />}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "Connectors", value: myConnectors.length },
          { label: "Linked accounts", value: 3 },
          { label: "Client connections", value: connections.length },
          { label: "Tool calls today", value: 128 },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-stone-200 bg-white p-4">
            <div className="text-2xl font-semibold text-stone-900">{stat.value}</div>
            <div className="mt-1 text-xs font-medium uppercase tracking-wide text-stone-400">{stat.label}</div>
          </div>
        ))}
      </div>

      <Card title="Your MCP endpoint">
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-800">{endpoint}</code>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(endpoint);
              toast("Endpoint copied", "success");
            }}
          >
            Copy
          </Button>
        </div>
        <p className="mt-3 text-xs text-stone-400">
          Web clients (claude.ai, ChatGPT) connect via OAuth automatically; IDE clients use an API key from
          Connections.
        </p>
      </Card>

      <Card title="Recent activity">
        <Table headers={["When", "Connection", "Tool", "Target", "Outcome"]}>
          {auditRows.slice(0, 4).map((row) => (
            <tr key={`${row.ts}-${row.tool}`}>
              <Td className="text-stone-400">{row.ts}</Td>
              <Td>{row.connection}</Td>
              <Td>
                <code className="text-xs">{row.tool}</code>
              </Td>
              <Td>{row.target}</Td>
              <Td>
                <Badge tone={row.outcome === "ok" ? "green" : row.outcome === "denied" ? "amber" : "red"}>{row.outcome}</Badge>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
