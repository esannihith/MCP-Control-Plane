import { useState } from "react";
import { useConfirm, useToast } from "../components/feedback";
import { Badge, Button, Card, EmptyState, PageHeader, PartTag, PreviewToggle, Table, Td } from "../components/ui";
import { accounts, myConnectors } from "../mock";

export default function Accounts() {
  const toast = useToast();
  const confirm = useConfirm();
  const [empty, setEmpty] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounts"
        desc="Vendor accounts linked to your connectors. Clients pick between them per connection — link once, use everywhere."
        action={<PreviewToggle empty={empty} onChange={setEmpty} />}
      />

      {empty ? (
        <EmptyState
          title="No linked accounts"
          desc="Link a vendor account from any OAuth connector. To link a second account of the same vendor, use the incognito flow — the copyable link works in any browser."
        />
      ) : (
        myConnectors.map((connector) => {
          const rows = accounts.filter((account) => account.connector === connector.name);
          return (
            <Card
              key={connector.name}
              title={connector.name}
              action={
                <div className="flex items-center gap-2">
                  <PartTag part={4} />
                  <Button variant="primary" onClick={() => toast("Link flow opens in a new tab — wired in Part 4 (preview)")}>
                    Link account
                  </Button>
                </div>
              }
            >
              {rows.length === 0 ? (
                <EmptyState title="No accounts" desc="This connector has no linked accounts yet — its tools stay hidden until one is linked." />
              ) : (
                <Table headers={["Label", "Verified identity", "Linked", ""]}>
                  {rows.map((account) => (
                    <tr key={account.label}>
                      <Td className="font-medium text-stone-800">{account.label}</Td>
                      <Td>
                        {account.identity ? (
                          <span className="inline-flex items-center gap-2">
                            {account.identity} <Badge tone="green">verified</Badge>
                          </span>
                        ) : (
                          <Badge tone="amber">unverified — label only</Badge>
                        )}
                      </Td>
                      <Td className="text-stone-400">{account.linked}</Td>
                      <Td className="text-right">
                        <Button
                          variant="danger"
                          onClick={() =>
                            void confirm(
                              `Unlink ${account.label}?`,
                              "Stored tokens are deleted; connections bound to this account will ask for a new one.",
                              "Unlink",
                            ).then((ok) => ok && toast("Unlink — wired in Part 4 (preview)"))
                          }
                        >
                          Unlink
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
