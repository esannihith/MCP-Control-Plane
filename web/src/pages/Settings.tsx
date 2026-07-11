import { useOutletContext } from "react-router-dom";
import type { Me } from "../api";
import { useConfirm, useToast } from "../components/feedback";
import { Button, Card, PageHeader } from "../components/ui";

export default function Settings() {
  const me = useOutletContext<Me>();
  const toast = useToast();
  const confirm = useConfirm();
  const endpoint = `${window.location.origin}/u/${me.user.slug}/mcp`;

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Settings" desc="Your workspace identity and endpoint." />

      <Card title="Workspace">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-3 text-sm">
          <dt className="text-stone-400">Signed in as</dt>
          <dd className="flex items-center gap-2 text-stone-800">
            {me.user.avatarUrl && <img src={me.user.avatarUrl} alt="" className="h-6 w-6 rounded-full" />}
            {me.user.name ?? me.user.email} <span className="text-stone-400">({me.user.email})</span>
          </dd>
          <dt className="text-stone-400">Workspace ID</dt>
          <dd>
            <code className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-800">{me.user.slug}</code>
          </dd>
          <dt className="text-stone-400">MCP endpoint</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-800">{endpoint}</code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(endpoint);
                toast("Endpoint copied", "success");
              }}
            >
              Copy
            </Button>
          </dd>
        </dl>
      </Card>

      <Card title="Danger zone">
        <p className="text-sm text-stone-500">
          Deleting the workspace removes all connectors, linked accounts, stored tokens, connections, and audit history.
        </p>
        <Button
          variant="danger"
          className="mt-4"
          onClick={() =>
            void confirm(
              "Delete workspace?",
              "Everything is permanently deleted and connected clients stop working immediately. This cannot be undone.",
              "Delete everything",
            ).then((ok) => ok && toast("Workspace deletion — wired in a later part (preview)"))
          }
        >
          Delete workspace
        </Button>
      </Card>
    </div>
  );
}
