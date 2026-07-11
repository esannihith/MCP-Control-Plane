import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { fetchMe, type Me } from "./api";
import { FeedbackProvider } from "./components/feedback";
import Layout from "./components/Layout";
import Accounts from "./pages/Accounts";
import Audit from "./pages/Audit";
import Connections from "./pages/Connections";
import Login from "./pages/Login";
import Overview from "./pages/Overview";
import Permissions from "./pages/Permissions";
import Settings from "./pages/Settings";
import Store from "./pages/Store";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    void fetchMe().then(setMe);
  }, []);

  if (me === undefined) {
    return <div className="grid min-h-screen place-items-center text-stone-400">Loading…</div>;
  }
  if (!me) return <Login />;

  return (
    <FeedbackProvider>
      <BrowserRouter basename="/app">
        <Routes>
          <Route element={<Layout me={me} />}>
            <Route index element={<Overview />} />
            <Route path="store" element={<Store />} />
            <Route path="connections" element={<Connections />} />
            <Route path="accounts" element={<Accounts />} />
            <Route path="permissions" element={<Permissions />} />
            <Route path="audit" element={<Audit />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Overview />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </FeedbackProvider>
  );
}
