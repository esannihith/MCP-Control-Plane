import { useState } from "react";
import { useConfirm, useToast } from "../components/feedback";
import { Badge, Button, Card, EmptyState, PageHeader, PartTag, PreviewToggle, Table, Td } from "../components/ui";
import { connections } from "../mock";

const POLICY_LABEL: Record<string, { label: string; tone: "green" | "amber" | "stone" }> = {
  full: { label: "full access", tone: "stone" },
  read_only: { label: "read-only", tone: "green" },
  reads_plus_granted: { label: "reads + granted writes", tone: "amber" },
};

export default function Connections() {
  const toast = useToast();
  const confirm = useConfirm();
  const [empty, setEmpty] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        desc="Every MCP client connected to your plane — web clients via OAuth, IDEs via API key. Each has its own bindings, permissions, and audit trail."
        action={<PreviewToggle empty={empty} onChange={setEmpty} />}
      />

      <Card
        title="Clients"
        action={
          <div className="flex items-center gap-2">
            <PartTag part={5} />
            <Button variant="primary" onClick={() => setNewKey("cpk_PrEvIeWoNlY_nOtARealKey_1234567890abcdef")}>
              Create API key
            </Button>
          </div>
        }
      >
        {empty ? (
          <EmptyState
            title="No clients connected"
            desc="Point claude.ai or ChatGPT at your endpoint and approve the consent screen — or create an API key for IDE clients."
          />
        ) : (
          <Table headers={["Name", "Type", "Permissions", "Tool surface", "Last used", ""]}>
            {connections.map((connection) => (
              <tr key={connection.name}>
                <Td>
                  <div className="font-medium text-stone-800">{connection.name}</div>
                  <span className="text-xs text-stone-400">via {connection.client} · created {connection.created}</span>
                </Td>
                <Td>
                  <Badge tone={connection.kind === "oauth" ? "blue" : "stone"}>{connection.kind}</Badge>
                </Td>
                <Td>
                  <Badge tone={POLICY_LABEL[connection.policy].tone}>{POLICY_LABEL[connection.policy].label}</Badge>
                </Td>
                <Td>
                  <Badge tone={connection.toolMode === "meta" ? "green" : "stone"}>
                    {connection.toolMode === "meta" ? "meta-tools" : "full list"}
                  </Badge>{" "}
                  <PartTag part={6} />
                </Td>
                <Td className="text-stone-400">{connection.lastUsed}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button onClick={() => toast("Rename — wired in Part 5 (preview)")}>Rename</Button>
                    <Button
                      variant="danger"
                      onClick={() =>
                        void confirm(
                          `Revoke ${connection.name}?`,
                          "The client loses access immediately. Its bindings and audit history are kept.",
                          "Revoke",
                        ).then((ok) => ok && toast("Revoke — wired in Part 5 (preview)"))
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {newKey && (
        <Card title="API key created — shown once">
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 font-mono text-sm break-all">{newKey}</p>
          <p className="mt-2 text-xs text-stone-500">
            Client header: <code>Authorization: Bearer {"<key>"}</code>. Store it now — it cannot be shown again.
          </p>
          <Button className="mt-3" onClick={() => setNewKey(null)}>
            Done
          </Button>
        </Card>
      )}
    </div>
  );
}
