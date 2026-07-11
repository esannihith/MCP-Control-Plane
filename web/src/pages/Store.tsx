import { useState } from "react";
import { useConfirm, useToast } from "../components/feedback";
import { Badge, Button, Card, EmptyState, PageHeader, PartTag, PreviewToggle, Table, Td } from "../components/ui";
import { catalog, myConnectors } from "../mock";

export default function Store() {
  const toast = useToast();
  const confirm = useConfirm();
  const [empty, setEmpty] = useState(false);
  const preview = (what: string) => toast(`${what} — wiring lands in Part 3 (preview only)`);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Store"
        desc="Curated MCP connectors with vetted URLs, tool inventories, and permission profiles — or add any server by URL."
        action={<PreviewToggle empty={empty} onChange={setEmpty} />}
      />

      <Card title="My connectors" action={<PartTag part={3} />}>
        {empty || myConnectors.length === 0 ? (
          <EmptyState title="No connectors yet" desc="Add one from the catalog below — tools appear in your clients within seconds." />
        ) : (
          <Table headers={["Connector", "State", "Tools", "Accounts", ""]}>
            {myConnectors.map((connector) => (
              <tr key={connector.name}>
                <Td>
                  <div className="font-medium text-stone-800">{connector.name}</div>
                  <code className="text-xs text-stone-400">{connector.url}</code>
                </Td>
                <Td>
                  <Badge tone={connector.status === "connected" ? "green" : "red"}>{connector.status}</Badge>
                </Td>
                <Td>{connector.toolCount}</Td>
                <Td>{connector.accounts.join(", ")}</Td>
                <Td className="text-right">
                  <Button
                    variant="danger"
                    onClick={() =>
                      void confirm(
                        `Remove ${connector.name}?`,
                        "Linked accounts, bindings, and stored tokens for this connector are deleted. Clients lose its tools immediately.",
                        "Remove",
                      ).then((ok) => ok && preview(`Removed ${connector.name}`))
                    }
                  >
                    Remove
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-stone-800">Catalog</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {catalog.map((entry) => (
            <div key={entry.slug} className="flex flex-col rounded-xl border border-stone-200 bg-white p-5">
              <div className="flex items-start justify-between">
                <h3 className="font-semibold text-stone-900">{entry.name}</h3>
                <Badge tone={entry.auth === "oauth" ? "blue" : "stone"}>{entry.auth}</Badge>
              </div>
              <p className="mt-2 flex-1 text-sm text-stone-500">{entry.description}</p>
              <div className="mt-3 text-xs text-stone-400">
                {entry.tools.total} tools · {entry.tools.read} read · {entry.tools.write} write
              </div>
              <Button variant="primary" className="mt-4 self-start" onClick={() => preview(`Added ${entry.name}`)}>
                Add connector
              </Button>
            </div>
          ))}
        </div>
      </div>

      <Card title="Add by URL" action={<PartTag part={3} />}>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            preview("Added custom connector");
          }}
        >
          <input className="w-40 rounded-lg border border-stone-300 px-3 py-1.5 text-sm" placeholder="name" required />
          <input
            className="w-80 max-w-full rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
            placeholder="https://vendor.example.com/mcp"
            required
          />
          <select className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm">
            <option>oauth</option>
            <option>none</option>
            <option>bearer</option>
          </select>
          <Button variant="primary" type="submit">
            Add
          </Button>
        </form>
      </Card>
    </div>
  );
}
