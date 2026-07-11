import { useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, PageHeader, PartTag, PreviewToggle, Table, Td } from "../components/ui";
import { auditRows, connections } from "../mock";

const OUTCOME_TONE = { ok: "green", error: "red", denied: "amber", account_required: "blue" } as const;

export default function Audit() {
  const [empty, setEmpty] = useState(false);
  const [connection, setConnection] = useState("all");
  const [outcome, setOutcome] = useState("all");

  const rows = useMemo(
    () =>
      auditRows.filter(
        (row) => (connection === "all" || row.connection === connection) && (outcome === "all" || row.outcome === outcome),
      ),
    [connection, outcome],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit"
        desc="One row per tool call — connection, tool, target account, outcome, latency. Metadata only; arguments and results are never stored."
        action={<PreviewToggle empty={empty} onChange={setEmpty} />}
      />

      <Card
        title="Tool calls"
        action={
          <div className="flex items-center gap-2">
            <PartTag part={8} />
            <select value={connection} onChange={(e) => setConnection(e.target.value)} className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm">
              <option value="all">All connections</option>
              {connections.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm">
              <option value="all">All outcomes</option>
              {Object.keys(OUTCOME_TONE).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
        }
      >
        {empty || rows.length === 0 ? (
          <EmptyState title="No matching calls" desc="Calls appear here the moment any client uses a tool through your plane." />
        ) : (
          <>
            <Table headers={["When", "Connection", "Tool", "Target", "Outcome", "Latency"]}>
              {rows.map((row, index) => (
                <tr key={index}>
                  <Td className="text-stone-400">{row.ts}</Td>
                  <Td>{row.connection}</Td>
                  <Td>
                    <code className="text-xs">{row.tool}</code>
                  </Td>
                  <Td>{row.target}</Td>
                  <Td>
                    <Badge tone={OUTCOME_TONE[row.outcome]}>{row.outcome}</Badge>
                  </Td>
                  <Td className="text-stone-400">{row.ms}ms</Td>
                </tr>
              ))}
            </Table>
            <div className="mt-4 flex items-center justify-between text-sm text-stone-400">
              <span>
                Showing {rows.length} of {auditRows.length}
              </span>
              <div className="flex gap-2">
                <Button disabled>Newer</Button>
                <Button disabled>Older</Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
